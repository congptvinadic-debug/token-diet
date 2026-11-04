// Static audit: the instruction files that coding agents load into every session, and the MCP servers configured for a project.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { claudeDir, estTokens, projectSlug } from './util.js';

// Files read at session start, by agent. Paths are relative to each directory from the project up to the filesystem root.
const PER_DIR = [
  ['CLAUDE.md', 'Claude Code'],
  ['CLAUDE.local.md', 'Claude Code'],
  ['.claude/CLAUDE.md', 'Claude Code'],
  ['AGENTS.md', 'Codex / several agents'],
  ['GEMINI.md', 'Gemini CLI'],
];
const PROJECT_ONLY = [
  ['.cursorrules', 'Cursor (legacy)'],
  ['.windsurfrules', 'Windsurf'],
  ['.github/copilot-instructions.md', 'GitHub Copilot'],
];

function readText(p) {
  try {
    return statSync(p).isFile() ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

function fileEntry(path, agent, note) {
  const text = readText(path);
  if (text == null) return null;
  return { path, agent, note, chars: text.length, lines: text.split('\n').length, tokens: estTokens(text.length), text };
}

// CLAUDE.md can pull other files in with "@path/to/file" lines.
function imports(entry) {
  const out = [];
  for (const m of entry.text.matchAll(/(?:^|\s)@((?:~\/|\.{1,2}\/|\/)?[\w.\-/]+\.\w+)/gm)) {
    const raw = m[1].startsWith('~/') ? join(homedir(), m[1].slice(2)) : resolve(dirname(entry.path), m[1]);
    const e = fileEntry(raw, entry.agent, `imported by ${entry.path}`);
    if (e) out.push(e);
  }
  return out;
}

export function auditContext(cwd) {
  const files = [];
  const seen = new Set();
  const add = (e) => {
    if (e && !seen.has(e.path)) {
      seen.add(e.path);
      files.push(e);
      if (/\.md$/i.test(e.path)) for (const i of imports(e)) add(i);
    }
  };

  add(fileEntry(join(claudeDir(), 'CLAUDE.md'), 'Claude Code', 'user-wide, every project'));
  let dir = resolve(cwd);
  for (;;) {
    for (const [rel, agent] of PER_DIR) add(fileEntry(join(dir, rel), agent, dir === resolve(cwd) ? 'project' : 'parent directory'));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const [rel, agent] of PROJECT_ONLY) add(fileEntry(join(cwd, rel), agent, 'project'));
  for (const sub of ['.cursor/rules', '.claude/rules']) {
    const d = join(cwd, sub);
    if (existsSync(d)) for (const f of readdirSync(d)) if (/\.mdc?$/.test(f)) add(fileEntry(join(d, f), sub.startsWith('.cursor') ? 'Cursor' : 'Claude Code', 'project rules'));
  }
  add(fileEntry(join(claudeDir(), 'projects', projectSlug(resolve(cwd)), 'memory', 'MEMORY.md'), 'Claude Code', 'auto-memory index'));

  // Lines repeated across files (or inside one) are paid for twice on every request.
  const counts = new Map();
  for (const f of files)
    for (const line of f.text.split('\n')) {
      const t = line.trim();
      if (t.length >= 40) counts.set(t, (counts.get(t) || 0) + 1);
    }
  let dupChars = 0;
  const dupExamples = [];
  for (const [line, n] of counts)
    if (n > 1) {
      dupChars += line.length * (n - 1);
      if (dupExamples.length < 3) dupExamples.push(line.slice(0, 90));
    }

  return {
    files: files.map(({ text, ...rest }) => rest),
    totalTokens: files.reduce((s, f) => s + f.tokens, 0),
    duplicateTokens: estTokens(dupChars),
    dupExamples,
    mcp: mcpServers(resolve(cwd)),
  };
}

function mcpServers(cwd) {
  const out = [];
  const take = (obj, where) => {
    for (const name of Object.keys(obj || {})) out.push({ name, where });
  };
  try {
    take(JSON.parse(readText(join(cwd, '.mcp.json')) || '{}').mcpServers, '.mcp.json');
  } catch {}
  try {
    const cfg = JSON.parse(readText(join(homedir(), '.claude.json')) || '{}');
    take(cfg.mcpServers, '~/.claude.json (all projects)');
    const proj = cfg.projects?.[cwd] || cfg.projects?.[cwd.replace(/\\/g, '/')];
    take(proj?.mcpServers, '~/.claude.json (this project)');
  } catch {}
  return out;
}
