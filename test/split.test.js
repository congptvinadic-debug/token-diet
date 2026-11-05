import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planSplit, sections, slug, writeSplit } from '../lib/split.js';
import { auditContext } from '../lib/context.js';

const DOC = [
  '# Workflow\n\nRead this first.\n\n',
  '## Rules\n\nNever deploy without asking.\n\n',
  '## Old session 2026-10-30\n\n' + 'Long log line about what happened.\n'.repeat(800) + '\n```md\n## not a heading (inside a fence)\n```\n\n',
  '### Sub part\n\nStays with its parent.\n\n',
  '## Đường ra tiền gần nhất\n\nMore notes.\n\n',
  '## Current state\n\nWhat to do next.\n',
].join('');

function tmpProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-diet-split-'));
  fs.mkdirSync(path.join(dir, 'docs'));
  fs.writeFileSync(path.join(dir, 'docs', 'WORKFLOW.md'), DOC);
  return dir;
}

test('sections split on "## " only, keep sub-headings with their parent, ignore fenced headings', () => {
  const s = sections(DOC);
  assert.deepEqual(s.map((x) => x.heading), [null, 'Rules', 'Old session 2026-10-30', 'Đường ra tiền gần nhất', 'Current state']);
  assert.ok(s[2].text.includes('### Sub part'));
  assert.equal(s.map((x) => x.text).join(''), DOC);
});

test('slug strips accents and punctuation', () => {
  assert.equal(slug('Đường ra tiền gần nhất'), 'duong-ra-tien-gan-nhat');
  assert.equal(slug('Old session (2026-10-30)!'), 'old-session-2026-10-30');
});

test('planSplit keeps chosen sections, moves the rest byte for byte, and maps them', () => {
  const dir = tmpProject();
  const file = path.join(dir, 'docs', 'WORKFLOW.md');
  const plan = planSplit(file, { keep: ['^rules$'], keepLast: true });
  assert.equal(plan.files.length, 2);
  assert.ok(plan.index.startsWith('# Workflow'));
  assert.ok(plan.index.includes('## Rules') && plan.index.includes('## Current state'));
  assert.ok(!plan.index.includes('Long log line'));
  assert.ok(plan.index.includes('workflow/01-old-session-2026-10-30.md'));
  assert.ok(plan.after < plan.before / 5);
  writeSplit(plan);
  const moved = plan.files.map((f) => fs.readFileSync(f.path, 'utf8')).join('');
  assert.equal(moved, sections(DOC).slice(2, 4).map((s) => s.text).join(''));
  fs.writeFileSync(file, DOC); // same split again: the section files exist, so nothing is overwritten
  assert.throws(() => writeSplit(planSplit(file, { keep: ['^rules$'], keepLast: true })), /nothing written/i);
  assert.equal(fs.readFileSync(file, 'utf8'), DOC);
});

test('auditContext flags a big file an instruction file says to read first', () => {
  const dir = tmpProject();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# A\n\nRead `docs/WORKFLOW.md` first.\nSee notes.md for more.\n');
  const ctx = auditContext(dir);
  assert.equal(ctx.pointed.length, 1);
  assert.equal(ctx.pointed[0].rel, 'docs/WORKFLOW.md');
  assert.equal(ctx.pointed[0].readFirst, true);
  assert.ok(ctx.pointed[0].tokens >= 5000);
});
