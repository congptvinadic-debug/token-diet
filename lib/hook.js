#!/usr/bin/env node
// token-diet hooks for Claude Code. Self-contained (node builtins only): `token-diet install` copies this file to
// ~/.claude/token-diet/ and points the hooks at it, so it keeps working without the npm package.
//
//   node hook.js prompt   UserPromptSubmit: when the context passes `compactAt`, tell the user to run /compact
//                         (once per `every` tokens of growth, so it does not nag on every message).
//   node hook.js stop     Stop: the same note at the end of the agent's turn, so it shows before the next message.
//   node hook.js end      SessionEnd / PreCompact: write a handoff file from the transcript (see handoff.js).
//   node hook.js start    SessionStart: after /clear, give the new session the short handoff and its path.
//   node hook.js clip     PostToolUse on Bash/PowerShell and MCP tools: an output longer than `clipChars` is saved to a file and
//                         replaced by its first and last lines plus the file path, so the agent can read the rest
//                         only if it needs it. Add `# full` at the end of a command to keep its whole output.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadHandoff, writeHandoff } from './handoff.js';

export const HOME_DIR = path.join(os.homedir(), '.claude', 'token-diet');
export const DEFAULTS = { compactAt: 150000, every: 50000, clipChars: 16000, headLines: 60, tailLines: 60, mcpClipChars: 24000, mcpKeep: [], handoff: true, handoffHours: 12 };

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

// Warn once when the context passes `compactAt`, then again every `every` tokens of growth. `key` keeps a separate
// count per hook, so the end-of-turn note and the next-message note do not silence each other.
export function contextWarning(input, cfg, key) {
  const ctx = lastContext(input.transcript_path || '');
  const file = statePath(input.session_id || 'x');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  let warned = state[key] || 0;
  if (ctx < warned) warned = 0; // compacted or cleared since the last warning
  if (ctx < cfg.compactAt || (warned && ctx < warned + cfg.every)) {
    if (warned !== (state[key] || 0)) writeState(file, { ...state, [key]: warned });
    return null;
  }
  writeState(file, { ...state, [key]: ctx });
  return `token-diet: context is ${k(ctx)} tokens and every message re-sends all of it. ` +
    'Run /compact with a one-line note of what you are doing, or /clear: a handoff file keeps the session for the next one.';
}

export function promptHook(input, cfg = loadConfig()) {
  const msg = contextWarning(input, cfg, 'prompt');
  if (!msg) return null;
  return {
    systemMessage: msg,
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: `${msg} Mention this to the user in one short line at the end of your reply.`,
    },
  };
}

// Stop: the note shows right when the agent finishes, while the user decides what to send next.
export function stopHook(input, cfg = loadConfig()) {
  if (input.stop_hook_active) return null;
  const msg = contextWarning(input, cfg, 'stop');
  return msg ? { systemMessage: msg } : null;
}

function writeState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state));
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

// Head and tail of a long text by characters, cut at a line break when one is near. Page text and JSON from MCP tools
// often come as a few very long lines, where a cut by lines would keep too much or too little.
export function clipByChars(text, limit) {
  const headN = Math.round(limit * 0.6), tailN = Math.round(limit * 0.25);
  let head = text.slice(0, headN);
  const nl = head.lastIndexOf('\n');
  if (nl > headN * 0.8) head = head.slice(0, nl);
  let tail = text.slice(-tailN);
  const nl2 = tail.indexOf('\n');
  if (nl2 >= 0 && nl2 < tailN * 0.2) tail = tail.slice(nl2 + 1);
  return { head, tail, cutChars: text.length - head.length - tail.length };
}

// Saves the full output; returns its path with forward slashes. Throws if it cannot be saved.
function saveFull(text, id) {
  const dir = path.join(HOME_DIR, 'out');
  const file = path.join(dir, `${String(id || Date.now()).replace(/[^\w-]/g, '')}.txt`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
  pruneOld(dir);
  return file.replace(/\\/g, '/');
}

// MCP tools answer with a string, a list of content blocks, or {content: [blocks], ...}. Only text blocks are clipped;
// images and other blocks pass through. Errors are never touched: the agent needs the whole message.
export function clipMcpHook(input, cfg = loadConfig()) {
  const name = String(input.tool_name || '');
  const res = input.tool_response;
  if (!name.startsWith('mcp__') || res == null) return null;
  if ((cfg.mcpKeep || []).some((x) => name.includes(x))) return null;
  if (typeof res === 'object' && !Array.isArray(res) && (res.isError || res.is_error)) return null;
  const blocks = typeof res === 'string' ? null : Array.isArray(res) ? res : Array.isArray(res.content) ? res.content : undefined;
  if (blocks === undefined) return null;
  const isText = (b) => b && b.type === 'text' && typeof b.text === 'string';
  const text = blocks ? blocks.filter(isText).map((b) => b.text).join('\n') : res;
  if (text.length <= cfg.mcpClipChars) return null;
  let file;
  try {
    file = saveFull(text, input.tool_use_id);
  } catch {
    return null; // never hide output that could not be saved
  }
  const c = clipByChars(text, cfg.mcpClipChars);
  const note = `\n[token-diet: ${k(c.cutChars)} of ${k(text.length)} characters (~${k(Math.round(text.length / 4))} tokens in all) cut from the middle. ` +
    `Full output: ${file}. Grep it, or Read it with offset/limit, for the part you need.]\n`;
  const clipped = `${c.head}${note}${c.tail}`;
  if (!blocks) return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: clipped } };
  // The clipped text takes the place of the first text block; other blocks keep their order.
  const first = blocks.findIndex(isText);
  const merged = blocks.flatMap((b, i) => (i === first ? [{ ...b, text: clipped }] : isText(b) ? [] : [b]));
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: Array.isArray(res) ? merged : { ...res, content: merged } } };
}

export function clipHook(input, cfg = loadConfig()) {
  if (String(input.tool_name || '').startsWith('mcp__')) return clipMcpHook(input, cfg);
  const res = input.tool_response;
  const cmd = String((input.tool_input && input.tool_input.command) || '');
  if (!res || typeof res !== 'object' || typeof res.stdout !== 'string' || res.isImage) return null;
  if (/#\s*full\s*$/.test(cmd.trim()) || res.stdout.length <= cfg.clipChars) return null;
  let file;
  try {
    file = saveFull(res.stdout, input.tool_use_id);
  } catch {
    return null; // never hide output that could not be saved
  }
  const c = clipText(res.stdout, cfg);
  const note = `[token-diet: ${c.cutLines} of ${c.total} lines (~${k(Math.round(res.stdout.length / 4))} tokens in all) cut. ` +
    `Full output: ${file}. Grep or read only the part you need; add "# full" at the end of the command to get it all.]`;
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

function pluginEnabled() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8').replace(/^﻿/, ''));
    return Object.entries(s.enabledPlugins || {}).some(([id, on]) => on && id.startsWith('token-diet@'));
  } catch {
    return false;
  }
}

// Installed both ways (plugin and `token-diet install`), the same event reaches two copies of this
// script with the same stdin. An "inline" or --plugin-dir plugin is not listed in enabledPlugins, so
// the first copy to claim the event runs and the other exits. The same stdin more than 10 s later
// (a second "go on", another Stop) is a new event.
function firstRun(mode, raw) {
  const dir = path.join(os.tmpdir(), 'token-diet-state', 'once');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, crypto.createHash('sha1').update(`${mode}\0${raw}`).digest('hex'));
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return true;
      if (Date.now() - fs.statSync(file).mtimeMs < 10000) return false;
      const now = new Date();
      fs.utimesSync(file, now, now);
    }
  } catch {
    return true;
  }
  if (Math.random() < 0.05) {
    const old = Date.now() - 864e5;
    for (const f of fs.readdirSync(dir)) {
      try { if (fs.statSync(path.join(dir, f)).mtimeMs < old) fs.unlinkSync(path.join(dir, f)); } catch {}
    }
  }
  return true;
}

async function readStdin() {
  let s = '';
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // A hook must never break the session: any failure means "no output".
  try {
    // Installed both ways (plugin and `token-diet install`)? Only the plugin's hooks run.
    if (!process.env.CLAUDE_PLUGIN_ROOT && pluginEnabled()) process.exit(0);
    const raw = await readStdin();
    const mode = process.argv[2];
    if (!firstRun(mode, raw)) process.exit(0);
    const input = JSON.parse(raw || '{}');
    const cfg = loadConfig();
    let out = null;
    if (mode === 'clip') out = clipHook(input, cfg);
    else if (mode === 'stop') out = stopHook(input, cfg);
    else if (mode === 'end') { if (cfg.handoff) writeHandoff(input); }
    else if (mode === 'start') out = cfg.handoff ? loadHandoff(input, cfg) : null;
    else out = promptHook(input, cfg);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch {}
  process.exit(0);
}
