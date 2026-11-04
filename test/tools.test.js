import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { assistant, fakeHome, requestShape, writeTranscript } from './helpers.js';

const home = fakeHome();
const { toolUsage, scanTools } = await import('../lib/tools.js');
const dir = path.join(home, 'projects', 'p');

const LOADED = [['Bash', 800], ['Read', 400], ['Workflow', 5000], ['mcp__browser__navigate', 2000], ['mcp__browser__read', 2000], ['mcp__mine__q', 1200]];
const sessions = [1, 2, 3, 4].map((i) => ({
  file: writeTranscript(dir, `s${i}`, [
    requestShape(LOADED),
    assistant({ tools: [['Bash', { command: 'ls' }], ['Read', { file_path: '/a' }]] }),
    ...(i === 1 ? [assistant({ tools: [['mcp__browser__navigate', { url: 'https://x.y' }]] })] : []),
    ...(i === 2 ? [assistant({ tools: [['mcp__late__tool', {}]] })] : []), // loaded later via tool search
  ]),
}));

test('scanTools reads the first request tools and the calls', async () => {
  const r = await scanTools(sessions[0].file);
  assert.equal(r.loaded.length, LOADED.length);
  assert.equal(r.calls.get('mcp__browser__navigate'), 1);
});

test('toolUsage finds tools loaded everywhere but never or rarely called', async () => {
  const u = await toolUsage(sessions, [{ name: 'mine' }]);
  assert.equal(u.conversations, 4);
  const srv = Object.fromEntries(u.servers.map((s) => [s.name, s]));
  assert.equal(srv.browser.tools, 2);
  assert.equal(srv.browser.loadedIn, 4);
  assert.equal(srv.browser.usedIn, 1);
  assert.equal(srv.mine.calls, 0);
  assert.equal(srv.mine.source, 'config');
  assert.equal(srv.browser.source, 'app or plugin');
  assert.equal(srv.late, undefined, 'a tool loaded later is not part of the fixed cost');
  const wf = u.builtins.find((b) => b.name === 'Workflow');
  assert.equal(wf.calls, 0);
  assert.ok(wf.tokens > 1000);
  assert.equal(u.builtins[0].calls, 0, 'unused first');
  assert.equal(u.builtins.find((b) => b.name === 'Bash').usedIn, 4);
});
