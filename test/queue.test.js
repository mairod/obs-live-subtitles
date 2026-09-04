import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCaptionQueue } from '../lib/queue.js';

test('captions emit in push order even when translations finish out of order', async () => {
  const emitted = [];
  const delays = { a: 50, b: 5 };
  const q = makeCaptionQueue(
    (fr) => new Promise((res) => setTimeout(() => res(fr.toUpperCase()), delays[fr])),
    (en) => emitted.push(en),
  );
  q.push('a');
  await q.push('b');
  assert.deepEqual(emitted, ['A', 'B']);
});

test('a failed translation is skipped without blocking later segments', async () => {
  const emitted = [];
  const q = makeCaptionQueue(
    (fr) => (fr === 'bad' ? Promise.reject(new Error('boom')) : Promise.resolve(fr + '!')),
    (en) => emitted.push(en),
  );
  q.push('ok1');
  q.push('bad');
  await q.push('ok2');
  assert.deepEqual(emitted, ['ok1!', 'ok2!']);
});

test('translate receives up to 3 most recent prior translations as context', async () => {
  const contexts = [];
  const q = makeCaptionQueue(
    (fr, ctx) => {
      contexts.push([...ctx]);
      return Promise.resolve(fr);
    },
    () => {},
  );
  for (const s of ['one', 'two', 'three', 'four', 'five']) await q.push(s);
  assert.deepEqual(contexts[0], []);
  assert.deepEqual(contexts[1], ['one']);
  assert.deepEqual(contexts[4], ['two', 'three', 'four']);
});
