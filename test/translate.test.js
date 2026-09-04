import test from 'node:test';
import assert from 'node:assert/strict';
import { pickProvider } from '../lib/translate.js';

test('explicit TRANSLATOR wins over available keys', () => {
  assert.equal(
    pickProvider({ TRANSLATOR: 'anthropic', OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }),
    'anthropic',
  );
});

test('openai key alone selects openai', () => {
  assert.equal(pickProvider({ OPENAI_API_KEY: 'x' }), 'openai');
});

test('anthropic key alone selects anthropic', () => {
  assert.equal(pickProvider({ ANTHROPIC_API_KEY: 'y' }), 'anthropic');
});

test('openai preferred when both keys present and no TRANSLATOR', () => {
  assert.equal(pickProvider({ OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' }), 'openai');
});

test('throws when no key is configured', () => {
  assert.throws(() => pickProvider({}), /OPENAI_API_KEY or ANTHROPIC_API_KEY/);
});
