// Split a big Markdown file that agents read whole (a workflow log, a handbook) into a short index plus one file per section.
// The index keeps the text before the first "## " heading, the sections you choose to keep, and a map of the moved files,
// so an agent reads ~1 page and opens a section only when the task needs it. Moved sections are copied byte for byte.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { estTokens } from './util.js';

/** Sections at `level` (default 2: "## "), each with its sub-headings; headings inside ``` fences are ignored. */
export function sections(text, level = 2) {
  const lines = text.split(/(?<=\n)/);
  const mark = '#'.repeat(level) + ' ';
  const out = [{ heading: null, text: '' }];
  let fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && line.startsWith(mark)) out.push({ heading: line.slice(mark.length).trim(), text: '' });
    out[out.length - 1].text += line;
  }
  return out;
}

export function slug(s, max = 48) {
  const a = s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (a.slice(0, max).replace(/-+$/, '') || 'section');
}

/**
 * Plan the split. keep: regexes (strings) matched against headings; matching sections stay in the index.
 * keepLast: also keep the last section (often "current state"). Returns { index, files: [{ path, heading, text }], ... }.
 */
export function planSplit(file, { keep = [], keepLast = false, dir = null, level = 2 } = {}) {
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  const secs = sections(text, level);
  const outDir = dir || join(dirname(file), basename(file, extname(file)).toLowerCase());
  const res = keep.map((k) => new RegExp(k, 'i'));
  const kept = [secs[0].text];
  const files = [];
  const body = secs.slice(1);
  body.forEach((s, i) => {
    const stay = res.some((r) => r.test(s.heading)) || (keepLast && i === body.length - 1);
    if (stay) kept.push(s.text);
    else files.push({ path: join(outDir, `${String(files.length + 1).padStart(2, '0')}-${slug(s.heading)}.md`), heading: s.heading, text: s.text });
  });
  const rel = (p) => relative(dirname(file), p).replace(/\\/g, '/');
  const map = [
    `\n${'#'.repeat(level)} Map of moved sections\n\n`,
    `This file is a short index. The sections below were moved word for word to their own files: find the one you need with\n`,
    `grep (\`grep -n "<word>" ${rel(outDir)}/*.md\`) and read only that part. Add new detail to the matching file, not here.\n\n`,
    `| File | Section | ~Tokens |\n|---|---|---|\n`,
    ...files.map((f) => `| [${rel(f.path)}](${rel(f.path)}) | ${f.heading.replace(/\|/g, '\\|')} | ${estTokens(f.text.length)} |\n`),
  ].join('');
  const head = kept.join('');
  const index = head.replace(/\n*$/, '\n') + map;
  const movedChars = files.reduce((n, f) => n + f.text.length, 0);
  if (movedChars + kept.reduce((n, t) => n + t.length, 0) !== text.length) throw new Error('split lost text; nothing written');
  return { file, outDir, index, files, before: estTokens(text.length), after: estTokens(index.length), sections: body.length };
}

/** Write the plan: section files first, then the index over the original. Refuses to overwrite existing section files. */
export function writeSplit(plan) {
  for (const f of plan.files) if (existsSync(f.path)) throw new Error(`${f.path} already exists; nothing written`);
  mkdirSync(plan.outDir, { recursive: true });
  for (const f of plan.files) writeFileSync(f.path, f.text);
  writeFileSync(plan.file, plan.index);
}
