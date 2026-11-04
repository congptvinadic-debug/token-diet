#!/usr/bin/env node
// token-diet hooks for Claude Code. Self-contained (node builtins only): `token-diet install` copies this file to
// ~/.claude/token-diet/hook.mjs and points the hooks at it, so it keeps working without the npm package.
//
//   node hook.js prompt   UserPromptSubmit: when the context passes `compactAt`, tell the user to run /compact
//                         (once per `every` tokens of growth, so it does not nag on every message).
//   node hook.js clip     PostToolUse on Bash/PowerShell: an output longer than `clipChars` is saved to a file and
//                         replaced by its first and last lines plus the file path, so the agent can read the rest
//                         only if it needs it. Add `# full` at the end of a command to keep its whole output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOME_DIR = path.join(os.homedir(), '.claude', 'token-diet');
export const DEFAULTS = { compactAt: 150000, every: 50000, clipChars: 16000, headLines: 60, tailLines: 60 };

export function loadConfig() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'config.json'), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

// Context size of the latest request = input + cache writes + cache reads, read from the end of the transcript.
export function lastContext(transcript) {
  let fd;
  try {
    fd = fs.openSync(transcript, 'r');
    const size = fs.fstatSync(fd).size;
    for (let span = 512 * 1024; ; span *= 4) {
      const start = Math.max(0, size - span);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= (start ? 1 : 0); i--) {
        const l = lines[i];
        if (!l.includes('"usage"')) continue;
        let o;
        try { o = JSON.parse(l); } catch { continue; }
        if (o.type === 'system' && o.subtype === 'compact_boundary') return 0;
        const u = o.type === 'assistant' && o.message && o.message.usage;
        if (u) return (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      }
      if (!start) return 0;
    }
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function statePath(sessionId) {
  return path.join(os.tmpdir(), 'token-diet-state', `${String(sessionId).replace(/[^\w-]/g, '')}.json`);
}

export function promptHook(input, cfg = loadConfig()) {
  const ctx = lastContext(input.transcript_path || '');
  const file = statePath(input.session_id || 'x');
  let warned = 0;
  try { warned = JSON.parse(fs.readFileSync(file, 'utf8')).warned || 0; } catch {}
  if (ctx < warned) writeState(file, (warned = 0)); // compacted or cleared since the last warning
  if (ctx < cfg.compactAt || (warned && ctx < warned + cfg.every)) return null;
  writeState(file, ctx);
  const msg = `token-diet: context is ${k(ctx)} tokens and every message re-sends all of it. ` +
    'Run /compact with a one-line note of what you are doing (or /clear if the next task is unrelated).';
  return {
    systemMessage: msg,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `${msg} Mention this to the user in one short line at the end of your reply.`,
    },
  };
}

function writeState(file, warned) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ warned }));
  } catch {}
}

export function clipText(text, cfg) {
  const lines = text.split('\n');
  const cut = (s) => (s.length > 400 ? `${s.slice(0, 400)} …[${s.length - 400} chars]` : s);
  let head = lines.slice(0, cfg.headLines).map(cut);
  let tail = lines.length > cfg.headLines ? lines.slice(Math.max(cfg.headLines, lines.length - cfg.tailLines)).map(cut) : [];
  const kept = head.length + tail.length;
  return { head: head.join('\n'), tail: tail.join('\n'), cutLines: lines.length - kept, total: lines.length };
}

export function clipHook(input, cfg = loadConfig()) {
  const res = input.tool_response;
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!res || typeof res !== 'object' || typeof res.stdout !== 'string' || res.isImage) return null;
  if (/#\s*full\s*$/.test(cmd.trim()) || res.stdout.length <= cfg.clipChars) return null;
  const dir = path.join(HOME_DIR, 'out');
  const file = path.join(dir, `${String(input.tool_use_id || Date.now()).replace(/[^\w-]/g, '')}.txt`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, res.stdout);
    pruneOld(dir);
  } catch {
    return null; // never hide output that could not be saved
  }
  const c = clipText(res.stdout, cfg);
  const note = `[token-diet: ${c.cutLines} of ${c.total} lines (~${k(Math.round(res.stdout.length / 4))} tokens in all) cut. ` +
    `Full output: ${file.replace(/\\/g, '/')}. Grep or read only the part you need; add "# full" at the end of the command to get it all.]`;
  const stdout = c.cutLines > 0 ? `${c.head}\n${note}\n${c.tail}` : `${c.head}\n${note}`;
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...res, stdout } } };
}

function pruneOld(dir) {
  const week = Date.now() - 7 * 86400 * 1000;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try { if (fs.statSync(p).mtimeMs < week) fs.unlinkSync(p); } catch {}
  }
}

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A hook must never break the session: any failure means "no output".
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    const out = process.argv[2] === 'clip' ? clipHook(input) : promptHook(input);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {}
  process.exit(0);
}
