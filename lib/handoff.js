// Handoff: keep a long session's context on disk instead of in the next session's context.
//
// When a session is cleared or compacted, a script (no model call, no tokens) reads the transcript and writes a
// handoff file: your messages, the plan, files changed, commits, commands, and the agent's last reply. After /clear
// the new session gets a short version (~1-2k tokens) plus the file path, and reads more only when it needs it.
// Node builtins only, like hook.js.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HANDOFF_DIR = path.join(os.homedir(), '.claude', 'token-diet', 'handoff');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const PLAN_TOOLS = /update_plan$|^TodoWrite$/;

export function projectDir(cwd) {
  return path.join(HANDOFF_DIR, String(cwd || 'unknown').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(-80) || 'root');
}

// API keys and tokens people paste into chat must not be copied into a file or into the next session.
const SECRET = new RegExp(
  [
    String.raw`\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}`,
    String.raw`\b(?:hf|ghp|gho|ghu|ghs|ghr|glpat|xox[abpr]|npm)_[A-Za-z0-9_-]{16,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{30,}`,
    String.raw`\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
    String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`,
    String.raw`((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)["']?[^\s"']{8,}`,
  ].join('|'),
  'gi',
);
export function redact(s) {
  return String(s || '').replace(SECRET, (m, keep) => (keep ? `${keep}[redacted]` : '[redacted]'));
}

const one = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// Text a person typed, without the reminders and command wrappers Claude Code adds around it.
function userText(o) {
  if (o.isMeta || o.isCompactSummary || o.toolUseResult) return '';
  const c = o.message && o.message.content;
  let t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
  if (!t || /^\s*<(local-command-stdout|local-command-caveat|task-notification|bash-stdout)/.test(t)) return '';
  const cmd = t.match(/<command-name>([^<]*)<\/command-name>[\s\S]*?(?:<command-args>([\s\S]*?)<\/command-args>)?/);
  if (cmd) return `${cmd[1].trim()} ${(cmd[2] || '').trim()}`.trim();
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, '').trim();
  return t;
}

function toolResultText(o) {
  const c = o.message && o.message.content;
  if (!Array.isArray(c)) return '';
  return c
    .filter((b) => b && b.type === 'tool_result')
    .map((b) => (typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => x.text || '').join('\n') : ''))
    .join('\n');
}

// Everything the handoff needs, from one pass over the transcript.
export function readTranscript(file) {
  const out = { user: [], files: new Map(), commits: [], commands: [], plan: null, lastReply: '', compactSummary: '', started: '', ended: '', cwd: '' };
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.timestamp) { if (!out.started) out.started = o.timestamp; out.ended = o.timestamp; }
    if (o.cwd) out.cwd = o.cwd;
    if (o.type === 'user') {
      if (o.isCompactSummary) {
        const c = o.message && o.message.content;
        out.compactSummary = redact(typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text || '').join('\n') : '');
        continue;
      }
      const t = redact(userText(o));
      if (t) out.user.push({ at: o.timestamp || '', text: t });
      const r = toolResultText(o);
      for (const m of r.matchAll(/^\[([\w./-]+)(?: \(root-commit\))? ([0-9a-f]{7,40})\] (.+)$/gm)) out.commits.push(`${m[2].slice(0, 7)} ${one(m[3], 100)}`);
      continue;
    }
    if (o.type !== 'assistant') continue;
    const blocks = (o.message && o.message.content) || [];
    const texts = blocks.filter((b) => b && b.type === 'text' && b.text && b.text.trim()).map((b) => b.text.trim());
    if (texts.length) out.lastReply = redact(texts.join('\n\n'));
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use') continue;
      const inp = b.input || {};
      if (EDIT_TOOLS.has(b.name) && (inp.file_path || inp.notebook_path)) {
        const f = String(inp.file_path || inp.notebook_path);
        out.files.set(f, (out.files.get(f) || 0) + 1);
      } else if (SHELL_TOOLS.has(b.name) && inp.command) {
        out.commands.push(one(redact(String(inp.command).split('\n')[0]), 140));
      } else if (PLAN_TOOLS.test(b.name)) {
        const items = inp.items || inp.todos;
        if (Array.isArray(items) && items.length) out.plan = items.map((x) => ({ text: x.content || x.subject || '', status: x.status || '' }));
      }
    }
  }
  return out;
}

const relTo = (f, cwd) => {
  const r = cwd ? path.relative(cwd, f) : f;
  return (r && !r.startsWith('..') && !path.isAbsolute(r) ? r : f).replace(/\\/g, '/');
};
const MARK = { completed: '[x]', in_progress: '[>]', pending: '[ ]' };

// The short version a new session starts with; `budget` is in characters (~4 per token).
export function shortHandoff(t, { note = '', budget = 6000, file = '' } = {}) {
  const cwd = t.cwd;
  const parts = [];
  if (note) parts.push(`Note from the user: ${one(note, 600)}`);
  if (t.plan) parts.push(`Plan when it ended:\n${t.plan.map((p) => `  ${MARK[p.status] || '[ ]'} ${one(p.text, 120)}`).join('\n')}`);
  const files = [...t.files.entries()].sort((a, b) => b[1] - a[1]);
  if (files.length) parts.push(`Files changed (${files.length}): ${files.slice(0, 15).map(([f]) => relTo(f, cwd)).join(', ')}${files.length > 15 ? ', …' : ''}`);
  const commits = [...new Set(t.commits)];
  if (commits.length) parts.push(`Commits (${commits.length}, last ${Math.min(8, commits.length)}):\n${commits.slice(-8).map((c) => `  ${c}`).join('\n')}`);
  if (t.lastReply) parts.push(`Agent's last reply:\n${one(t.lastReply, 1200)}`);
  // The user's messages, newest first, as many as fit.
  let used = parts.join('\n\n').length;
  const msgs = [];
  for (let i = t.user.length - 1; i >= 0; i--) {
    const m = `  - ${one(t.user[i].text, 240)}`;
    if (used + m.length > budget - 400) break;
    msgs.unshift(m);
    used += m.length + 1;
  }
  if (msgs.length) parts.push(`Your last ${msgs.length} of ${t.user.length} messages in that session:\n${msgs.join('\n')}`);
  if (file) parts.push(`Full handoff (all messages, commands, the earlier compact summary): ${file.replace(/\\/g, '/')}. Read or grep it only for details you need.`);
  return parts.join('\n\n');
}

export function fullHandoff(t, { note = '', reason = '', transcript = '' } = {}) {
  const cwd = t.cwd;
  const files = [...t.files.entries()].sort((a, b) => b[1] - a[1]);
  const lines = [
    `# Session handoff`,
    '',
    `- Project: ${cwd}`,
    `- Session: ${t.started} → ${t.ended} (${reason || 'ended'})`,
    `- Transcript: ${String(transcript).replace(/\\/g, '/')}`,
  ];
  if (note) lines.push('', '## Note from the user', '', note);
  if (t.plan) lines.push('', '## Plan', '', ...t.plan.map((p) => `- ${MARK[p.status] || '[ ]'} ${p.text}`));
  if (t.lastReply) lines.push('', `## Agent's last reply`, '', t.lastReply);
  if (files.length) lines.push('', '## Files changed', '', ...files.map(([f, n]) => `- ${relTo(f, cwd)} (${n}x)`));
  const commits = [...new Set(t.commits)];
  if (commits.length) lines.push('', '## Commits', '', ...commits.map((c) => `- ${c}`));
  lines.push('', `## Your messages (${t.user.length})`, '', ...t.user.map((m) => `- ${m.at.slice(0, 16).replace('T', ' ')} ${one(m.text, 2000)}`));
  if (t.commands.length) lines.push('', `## Commands (${t.commands.length}, last 60)`, '', ...t.commands.slice(-60).map((c) => `- \`${c.replace(/`/g, "'")}\``));
  if (t.compactSummary) lines.push('', '## Earlier compact summary', '', t.compactSummary);
  return lines.join('\n') + '\n';
}

// SessionEnd (reason "clear") and PreCompact: write the handoff. Returns the file written, or null.
export function writeHandoff(input) {
  const transcript = input.transcript_path || '';
  if (!transcript || !fs.existsSync(transcript)) return null;
  const t = readTranscript(transcript);
  if (!t.user.length && !t.files.size) return null; // nothing worth keeping
  t.cwd = input.cwd || t.cwd || '';
  const note = redact(input.custom_instructions || '').trim();
  const dir = projectDir(input.cwd || t.cwd);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const file = path.join(dir, `${stamp}-${String(input.session_id || 'x').slice(0, 8)}.md`);
  const reason = input.hook_event_name === 'PreCompact' ? `compact (${input.trigger || 'manual'})` : input.reason || 'ended';
  fs.writeFileSync(file, fullHandoff(t, { note, reason, transcript }));
  const short = shortHandoff(t, { note, file });
  fs.writeFileSync(path.join(dir, 'latest.json'), JSON.stringify({ file, at: Date.now(), session: input.session_id || '', reason, short }));
  prune(dir);
  return file;
}

// SessionStart: after /clear, hand the new session the short version; on a fresh start, only the path.
export function loadHandoff(input, cfg = {}) {
  const src = input.source || 'startup';
  if (src !== 'clear' && src !== 'startup') return null;
  let latest;
  try { latest = JSON.parse(fs.readFileSync(path.join(projectDir(input.cwd), 'latest.json'), 'utf8')); } catch { return null; }
  if (!latest || !latest.file || !fs.existsSync(latest.file)) return null;
  const age = Date.now() - (latest.at || 0);
  let ctx;
  if (src === 'clear' && age < 30 * 60 * 1000) {
    ctx = `token-diet handoff from the session the user just cleared. Use it only if the user's next message continues that work.\n\n${latest.short}`;
  } else if (age < (cfg.handoffHours ?? 12) * 3600 * 1000) {
    ctx = `token-diet: the previous session in this project left a handoff (${Math.round(age / 60000)} min ago): ` +
      `${latest.file.replace(/\\/g, '/')}. Read it only if the user continues earlier work.`;
  } else return null;
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } };
}

function prune(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - 30))) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
}
