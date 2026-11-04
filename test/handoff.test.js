import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assistant, fakeHome, toolResult, user, writeTranscript } from './helpers.js';

const home = fakeHome();
const { fullHandoff, loadHandoff, readTranscript, redact, shortHandoff, summaryKeep, writeHandoff } = await import('../lib/handoff.js');

const SUMMARY = `This session is being continued from a previous conversation.
Summary:
1. Primary Request and Intent:
   - build the thing
3. Files and Code Sections:
   - ${'long code detail '.repeat(400)}
7. Pending Tasks:
   - publish the repo after the owner says yes
8. Current Work:
   - finished the clip hook
9. Optional Next Step:
   - answer the question`;

function transcript() {
  const edit = assistant({ text: 'editing', tools: [['Edit', { file_path: '/work/app/src/a.js' }], ['Bash', { command: 'git commit -m "x"' }]] });
  return writeTranscript(path.join(home, 'projects', 'p'), 'sess1234', [
    { type: 'user', isCompactSummary: true, timestamp: '2026-11-04T09:00:00Z', message: { role: 'user', content: SUMMARY } },
    user('make the hook, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz'),
    assistant({ tools: [['mcp__ccd_turn__update_plan', { items: [{ content: 'Write hook', status: 'completed' }, { content: 'Test it', status: 'in_progress' }] }]] }),
    edit,
    toolResult(edit.message.content[2].id, '[master abc1234] add clip hook\n 1 file changed'),
    ...Array.from({ length: 60 }, (_, i) => user(`message ${i}`)),
    assistant({ text: 'All done, tests pass.' }),
  ]);
}

test('redact hides keys and passwords', () => {
  assert.equal(redact('key sk-ant-api03-abcdefghijklmnopqrstuvwxyz ok'), 'key [redacted] ok');
  assert.equal(redact('password: hunter2hunter2'), 'password: [redacted]');
});

test('readTranscript collects messages, plan, files, commits and the compact summary', () => {
  const t = readTranscript(transcript());
  assert.equal(t.user.length, 61);
  assert.match(t.user[0].text, /\[redacted\]/);
  assert.deepEqual(t.plan.map((p) => p.status), ['completed', 'in_progress']);
  assert.deepEqual([...t.files.keys()], ['/work/app/src/a.js']);
  assert.deepEqual(t.commits, ['abc1234 add clip hook']);
  assert.equal(t.lastReply, 'All done, tests pass.');
  assert.match(t.compactSummary, /Pending Tasks/);
});

test('summaryKeep keeps only what is still open', () => {
  const s = summaryKeep(SUMMARY);
  assert.match(s, /### Pending Tasks[\s\S]*publish the repo/);
  assert.match(s, /### Current Work[\s\S]*clip hook/);
  assert.doesNotMatch(s, /long code detail|Primary Request|Next Step/);
  assert.ok(summaryKeep('no sections here, just text '.repeat(200)).length <= 1500);
});

test('full handoff stays small and points to the transcript', () => {
  const file = transcript();
  const f = fullHandoff(readTranscript(file), { reason: 'clear', transcript: file });
  assert.ok(f.length < 6000, `handoff is ${f.length} chars`);
  assert.match(f, /## Still open before the last \/compact/);
  assert.match(f, /last 40 of 61/);
  assert.doesNotMatch(f, /git commit -m|long code detail|sk-ant-api03/);
  assert.ok(f.includes(file.replace(/\\/g, '/')));
});

test('short handoff fits its budget', () => {
  const s = shortHandoff(readTranscript(transcript()), { budget: 3000, file: '/x/h.md' });
  assert.ok(s.length <= 3000);
  assert.match(s, /Plan when it ended/);
  assert.match(s, /\/x\/h\.md/);
});

test('written on /clear, loaded once by the next session', () => {
  const tp = transcript();
  const written = writeHandoff({ session_id: 'sess1234', transcript_path: tp, cwd: '/work/app', reason: 'clear' });
  assert.ok(written && fs.existsSync(written));
  const out = loadHandoff({ session_id: 'next5678', cwd: '/work/app', source: 'clear' }, { handoffHours: 12 });
  assert.match(JSON.stringify(out), /Write hook/);
});
