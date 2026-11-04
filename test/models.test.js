import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeHome } from './helpers.js';

fakeHome();
const { cost, suggestFor, tier, workKind } = await import('../lib/models.js');

test('tier and price by model id', () => {
  assert.equal(tier('claude-haiku-5-5'), 'haiku');
  assert.equal(tier('claude-opus-5-5'), 'opus');
  assert.equal(tier('claude-fable-5-1'), 'fable');
  const u = { input: 1e6, output: 0, cacheWrite: 0, cacheRead: 0 };
  assert.ok(cost(u, 'claude-opus-5-5') > cost(u, 'claude-sonnet-5-5'));
  assert.ok(cost(u, 'claude-sonnet-5-5') > cost(u, 'claude-haiku-5-5'));
  assert.equal(cost(u, 'claude-opus-5-5'), 4);
  assert.equal(cost(u, 'some-other-model'), 0);
});

test('workKind from tool calls', () => {
  assert.equal(workKind({}), 'chat');
  assert.equal(workKind({ Edit: 6, Read: 10 }), 'coding');
  assert.equal(workKind({ Read: 8, Grep: 4, Bash: 1 }), 'search');
  assert.equal(workKind({ Bash: 8, Read: 2 }), 'scripts');
});

test('suggests a cheaper model only where it fits', () => {
  assert.equal(suggestFor('search', true, 'claude-opus-5-5'), 'haiku');
  assert.equal(suggestFor('coding', false, 'claude-opus-5-5'), null);
  assert.equal(suggestFor('search', true, 'claude-haiku-5-5'), null);
  assert.equal(suggestFor('mixed', false, 'claude-fable-5-1'), 'opus');
});
