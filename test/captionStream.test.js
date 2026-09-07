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

test('concurrent commits emit in spoken order', async (t) => {
  t.mock.method(console, 'error', () => {}); // silence any errors
  const stream = fakeStream(); // trackable provisional lane
  const emits = [];
  const translateOrder = []; // tracks call order
  let resolveFirst, resolveSecond;
  // Both translates block until we release them — lets us observe the
  // intermediate state between the two commit bodies settling.
  const translate = (fr) => {
    translateOrder.push(fr);
    if (fr === 'un') return new Promise((res) => { resolveFirst = res; });
    return new Promise((res) => { resolveSecond = res; });
  };
  const cs = makeCaptionStream({
    translateStream: stream,
    translate,
    emit: (m) => emits.push(m),
  });

  // Fire both without awaiting — simulates fire-and-forget WS handler
  const p1 = cs.onCommit('un');
  const p2 = cs.onCommit('deux');

  // At this point only 'un' translate has been called (chain serializes)
  assert.deepEqual(translateOrder, ['un'], 'second translate not started yet');
  assert.equal(emits.length, 0, 'nothing emitted while first is pending');

  // A partial arriving while BOTH commits are still queued must not start a
  // stream — the lane must stay shut until the entire commit queue drains.
  // If the queuedCommits===0 guard were unconditional, finalizing would drop
  // to false after the first commit and the partial would fire mid-queue.
  cs.onPartial('trois');
  assert.equal(stream.calls.length, 0, 'provisional lane stays shut while commits are queued');

  // Resolve the first; body1 settles and the chain schedules body2.
  // body2 blocks at its own translate — so queuedCommits is still 1 when we check.
  // The provisional lane must remain shut (finalizing still true).
  resolveFirst('one');
  await tick(); // microtasks: body1 finally runs, body2 starts, body2 blocks at translate
  assert.equal(stream.calls.length, 0, 'provisional lane stays shut until the whole commit queue drains');
  assert.deepEqual(translateOrder, ['un', 'deux'], 'second translate has started');

  // Now release the second — the whole queue drains and the lane opens.
  resolveSecond('two');
  await tick(); // body2 finally: queuedCommits→0, finalizing=false, pump() fires partial
  await Promise.all([p1, p2]);

  // Lane must reopen after queue drains (held partial should have fired)
  assert.equal(stream.calls.length, 1, 'provisional lane reopens after all commits finish');

  // Emits must arrive in spoken order: one, then two
  const finals = emits.filter((e) => e.final);
  assert.equal(finals.length, 2);
  assert.deepEqual(finals[0], { text: 'one', final: true });
  assert.deepEqual(finals[1], { text: 'two', final: true });
});

test('empty commit resets the block without emitting', async () => {
  const stream = fakeStream();
  const emits = [];
  let translateCalls = 0;
  const cs = makeCaptionStream({
    translateStream: stream,
    translate: async (fr) => { translateCalls++; return fr + '_en'; },
    emit: (m) => emits.push(m),
  });

  // Establish a lastGood via a completed provisional
  cs.onPartial('bonjour');
  stream.calls[0].resolve('hello');
  await tick();

  // Empty commit: no final emit, but block resets (lastGood cleared)
  await cs.onCommit('   ');
  const finalsBefore = emits.filter((e) => e.final).length;
  assert.equal(finalsBefore, 0, 'no final emit from empty commit');

  // Now commit with the same French that was lastGood — if lastGood survived,
  // translateCalls would stay 0. It should not: the empty commit cleared it.
  await cs.onCommit('bonjour');
  assert.equal(translateCalls, 1, 'lastGood was cleared; translate called afresh');
  assert.deepEqual(emits.at(-1), { text: 'bonjour_en', final: true });
});

test('a hung provisional stream does not wedge the lane', async () => {
  const stream = fakeStream();
  const emits = [];
  const cs = makeCaptionStream({
    translateStream: stream,
    translate: async () => 'committed',
    emit: (m) => emits.push(m),
  });

  // Start a partial whose stream never settles (ignores abort too)
  cs.onPartial('un');
  assert.equal(stream.calls.length, 1);

  // Commit — this should give up lane ownership even though the stream hangs
  await cs.onCommit('un deux');

  // The hung stream is still running but lane ownership was released.
  // A new partial must be able to start a second translateStream call.
  cs.onPartial('trois');
  await tick();

  assert.equal(stream.calls.length, 2, 'second translateStream call started despite hung first');
  stream.calls[1].onToken('three');
  assert.deepEqual(emits.at(-1), { text: 'three', final: false });
});

test('a settling zombie stream does not steal the live stream\'s lane', async () => {
  const stream = fakeStream();
  const emits = [];
  const cs = makeCaptionStream({
    translateStream: stream, translate: async () => 'LOCKED', emit: (m) => emits.push(m),
  });

  cs.onPartial('un');              // zombie-to-be, gen 0; ignores its abort signal
  await cs.onCommit('un deux');    // gen -> 1, lane ownership released
  cs.onPartial('trois');           // live stream starts at gen 1
  await tick();
  assert.equal(stream.calls.length, 2);

  cs.onPartial('trois quatre');    // pendingFr set, so a stray pump() would start a stream
  stream.calls[0].resolve('zombie done');
  await tick();

  assert.equal(stream.calls.length, 2, 'zombie must not clear the live stream\'s inFlight');
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
  assert.deepEqual(stream.calls[0].context, ['sentence one'], 'committed English passed as context to next provisional');
});
