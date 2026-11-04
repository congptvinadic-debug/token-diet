import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistant, fakeHome, user, writeTranscript } from './helpers.js';

const home = fakeHome();
const { DEFAULTS, clipHook, clipMcpHook, clipText, clipByChars, lastContext, promptHook, stopHook } = await import('../lib/hook.js');
const cfg = { ...DEFAULTS };
const HOOK = fileURLToPath(new URL('../lib/hook.js', import.meta.url));
const big = (lines, width = 100) => Array.from({ length: lines }, (_, i) => `${String(i).padStart(5, '0')} ${'a'.repeat(width)}`).join('\n');
const bash = (stdout, command = 'ls', id = 'tu_bash') => ({
  tool_name: 'Bash',
  tool_use_id: id,
  tool_input: { command },
  tool_response: { stdout, stderr: '', interrupted: false, isImage: false },
});

test('clipText keeps head and tail lines and caps long lines', () => {
  const c = clipText(big(500, 600), cfg);
  assert.equal(c.total, 500);
  assert.equal(c.cutLines, 500 - cfg.headLines - cfg.tailLines);
  assert.match(c.head, /^00000 /);
  assert.match(c.tail, /00499 /);
  assert.match(c.head, /…\[\d+ chars\]/);
});

test('Bash: a long output is clipped, saved in full, same shape', () => {
  const out = clipHook(bash(big(1000)), cfg);
  const r = out.hookSpecificOutput.updatedToolOutput;
  assert.deepEqual(Object.keys(r).sort(), ['interrupted', 'isImage', 'stderr', 'stdout']);
  assert.ok(r.stdout.length < 20000);
  const file = r.stdout.match(/Full output: (\S+?\.txt)/)[1];
  assert.equal(fs.readFileSync(file, 'utf8'), big(1000));
  assert.ok(file.startsWith(home.replace(/\\/g, '/')));
});

test('Bash: short output, "# full" and images pass through', () => {
  assert.equal(clipHook(bash('short'), cfg), null);
  assert.equal(clipHook(bash(big(1000), 'cat log.txt # full'), cfg), null);
  const img = bash(big(1000));
  img.tool_response.isImage = true;
  assert.equal(clipHook(img, cfg), null);
});

test('clipByChars cuts the middle near line breaks', () => {
  const text = big(1000);
  const c = clipByChars(text, 24000);
  assert.ok(c.head.length <= 14400 && c.head.length > 11000);
  assert.ok(c.tail.length <= 6000);
  assert.equal(c.head.length + c.tail.length + c.cutChars, text.length);
  assert.ok(c.head.endsWith('a') && /^\d{5} /.test(c.tail));
});

const mcp = (tool_response, name = 'mcp__browser__get_page_text') => ({ tool_name: name, tool_use_id: 'tu_mcp', tool_input: {}, tool_response });

test('MCP: string output is clipped to a string', () => {
  const r = clipHook(mcp(big(1000)), cfg).hookSpecificOutput.updatedToolOutput;
  assert.equal(typeof r, 'string');
  assert.ok(r.length < 26000);
  assert.match(r, /cut from the middle\. Full output: /);
});

test('MCP: content blocks keep their order and images', () => {
  const img = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
  const r = clipHook(mcp([img, { type: 'text', text: big(600) }, { type: 'text', text: big(600) }]), cfg).hookSpecificOutput.updatedToolOutput;
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], img);
  assert.equal(r[1].type, 'text');
  assert.match(r[1].text, /token-diet: /);
});

test('MCP: {content: [...]} objects keep their other fields', () => {
  const r = clipMcpHook(mcp({ content: [{ type: 'text', text: big(1000) }], structuredContent: { a: 1 } }), cfg).hookSpecificOutput.updatedToolOutput;
  assert.deepEqual(r.structuredContent, { a: 1 });
  assert.equal(r.content.length, 1);
});

test('MCP: errors, short output, kept tools and unknown shapes pass through', () => {
  assert.equal(clipHook(mcp({ isError: true, content: [{ type: 'text', text: big(1000) }] }), cfg), null);
  assert.equal(clipHook(mcp([{ type: 'text', text: 'short' }]), cfg), null);
  assert.equal(clipHook(mcp(big(1000)), { ...cfg, mcpKeep: ['get_page_text'] }), null);
  assert.equal(clipHook(mcp({ rows: [1, 2, 3] }), cfg), null);
});

const RUN = Date.now().toString(36);
function sessionAt(ctx, name) {
  const id = `${name}-${RUN}`;
  const dir = path.join(home, 'transcripts');
  const usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: ctx - 100 };
  return { session_id: id, transcript_path: writeTranscript(dir, id, [user('hi'), assistant({ text: 'ok', usage })]) };
}

test('lastContext reads the last request size', () => {
  assert.equal(lastContext(sessionAt(160000, 's-ctx').transcript_path), 160000);
});

test('compact reminder: once past compactAt, again after +every', () => {
  const s = sessionAt(160000, 's-remind');
  const first = promptHook(s, cfg);
  assert.match(first.systemMessage, /160k/);
  assert.match(first.hookSpecificOutput.additionalContext, /Mention this to the user/);
  assert.equal(promptHook(s, cfg), null);
  const later = sessionAt(215000, 's-remind');
  assert.ok(promptHook(later, cfg));
  assert.equal(promptHook(sessionAt(90000, 's-small'), cfg), null);
});

test('Stop hook does not loop', () => {
  const s = sessionAt(170000, 's-stop');
  assert.equal(stopHook({ ...s, stop_hook_active: true }, cfg), null);
  assert.ok(stopHook(s, cfg));
});

test('two copies of the hook on the same event: only the first answers', () => {
  const input = JSON.stringify(bash(big(1000), 'ls', `tu_dup_${Date.now()}`));
  const run = () => spawnSync(process.execPath, [HOOK, 'clip'], { input, env: process.env, encoding: 'utf8' }).stdout;
  assert.match(run(), /updatedToolOutput/);
  assert.equal(run(), '');
});

test('a hook never fails the session on bad input', () => {
  const r = spawnSync(process.execPath, [HOOK, 'prompt'], { input: 'not json', env: process.env, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});
