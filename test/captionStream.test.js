import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCaptionStream } from '../lib/captionStream.js';

// Lets each test drive a translation's tokens and completion by hand.
function fakeStream() {
  const calls = [];
  const fn = (fr, context, onToken, signal) => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    calls.push({ fr, context, onToken, signal, resolve, reject });
    return promise;
  };
  fn.calls = calls;
  return fn;
}

// Flush the promise chain inside pump() (then → finally → next translateStream).
const tick = () => new Promise((r) => setImmediate(r));

test('streamed tokens emit accumulated text as provisional', () => {
  const stream = fakeStream();
  const emits = [];
  const cs = makeCaptionStream({
    translateStream: stream,
    translate: async () => 'unused',
    emit: (m) => emits.push(m),
  });

  cs.onPartial('je ne');
  assert.equal(stream.calls.length, 1);
  assert.equal(stream.calls[0].fr, 'je ne');

  stream.calls[0].onToken('I have');
  stream.calls[0].onToken('I have not');

  assert.deepEqual(emits, [
    { text: 'I have', final: false },
    { text: 'I have not', final: false },
  ]);
});

test('partials coalesce instead of aborting the stream in flight', async () => {
  const stream = fakeStream();
  const cs = makeCaptionStream({
    translateStream: stream,
    translate: async () => 'unused',
    emit: () => {},
  });

  cs.onPartial('un');
  cs.onPartial('un deux');
  cs.onPartial('un deux trois');

  assert.equal(stream.calls.length, 1, 'only one translation in flight');
  assert.equal(stream.calls[0].signal.aborted, false, 'in-flight stream not aborted');

  stream.calls[0].resolve('one');
  await tick();

  assert.equal(stream.calls.length, 2, 'exactly one follow-up translation');
  assert.equal(stream.calls[1].fr, 'un deux trois', 'newest partial, intermediates skipped');
});

test('a commit aborts the in-flight stream and drops its late tokens', async () => {
  const stream = fakeStream();
  const emits = [];
  const cs = makeCaptionStream({
    translateStream: stream,
    translate: async () => 'FINAL',
    emit: (m) => emits.push(m),
  });

  cs.onPartial('bonjour tout');
  const dead = stream.calls[0];
  dead.onToken('hello every');

  await cs.onCommit('bonjour tout le monde');

  assert.equal(dead.signal.aborted, true, 'commit aborts the provisional stream');

  // A stream that ignores its signal must still not reach the screen.
  dead.onToken('IGNORED');
  dead.resolve('IGNORED');
  await tick();

  assert.deepEqual(emits, [
    { text: 'hello every', final: false },
    { text: 'FINAL', final: true },
  ]);
});

test('commit matching the last translated partial locks without re-translating', async () => {
  const stream = fakeStream();
  const emits = [];
  let translateCalls = 0;
  const cs = makeCaptionStream({
    translateStream: stream,
    translate: async () => { translateCalls++; return 'should not be used'; },
    emit: (m) => emits.push(m),
  });

  cs.onPartial('bonjour');
  stream.calls[0].resolve('hello');
  await tick();

  await cs.onCommit('bonjour');

  assert.equal(translateCalls, 0, 'no authoritative call needed');
  assert.deepEqual(emits.at(-1), { text: 'hello', final: true });
});

test('commit differing from the last partial runs the authoritative translation', async () => {
  const stream = fakeStream();
  const emits = [];
  const seen = [];
  const cs = makeCaptionStream({
    translateStream: stream,
    translate: async (fr) => { seen.push(fr); return 'hello everyone'; },
    emit: (m) => emits.push(m),
  });

  cs.onPartial('bonjour');
  stream.calls[0].resolve('hello');
  await tick();

  await cs.onCommit('bonjour a tous');

  assert.deepEqual(seen, ['bonjour a tous']);
  assert.deepEqual(emits.at(-1), { text: 'hello everyone', final: true });
});

test('after a commit the next block starts fresh', async () => {
  const stream = fakeStream();
  let translateCalls = 0;
  const cs = makeCaptionStream({
    translateStream: stream,
    translate: async () => { translateCalls++; return 'yes'; },
    emit: () => {},
  });

  cs.onPartial('oui');
  stream.calls[0].resolve('yes');
  await tick();

  await cs.onCommit('oui');
  assert.equal(translateCalls, 0, 'first commit reuses the provisional result');

  // Same French again: the block was reset, so there is nothing to reuse.
  await cs.onCommit('oui');
  assert.equal(translateCalls, 1, 'second commit must translate afresh');
});

test('a failed provisional translation does not wedge the lane', async (t) => {
  t.mock.method(console, 'error', () => {}); // keep test output pristine
  const stream = fakeStream();
  const emits = [];
  const cs = makeCaptionStream({
    translateStream: stream,
    translate: async () => 'unused',
    emit: (m) => emits.push(m),
  });

  cs.onPartial('un');
  stream.calls[0].reject(new Error('boom'));
  await tick();

  cs.onPartial('deux');
  assert.equal(stream.calls.length, 2, 'lane still accepts work after a failure');

  stream.calls[1].onToken('two');
  assert.deepEqual(emits.at(-1), { text: 'two', final: false });
});

test('a partial arriving during finalization is emitted after the final', async () => {
  const stream = fakeStream();
  const emits = [];
  let releaseFinal;
  const cs = makeCaptionStream({
    translateStream: stream,
    translate: () => new Promise((res) => { releaseFinal = res; }),
    emit: (m) => emits.push(m),
  });

  const commit = cs.onCommit('phrase une'); // no provisional to reuse → real call
  cs.onPartial('phrase deux');              // next segment starts mid-finalization

  assert.equal(stream.calls.length, 0, 'provisional lane held while finalizing');

  releaseFinal('sentence one');
  await commit;
  await tick();

  assert.equal(emits.length, 1);
  assert.deepEqual(emits[0], { text: 'sentence one', final: true });
  assert.equal(stream.calls.length, 1, 'held partial runs after the final');
  assert.equal(stream.calls[0].fr, 'phrase deux');
});
