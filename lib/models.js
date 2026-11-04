// Which model did which kind of work, what it cost at API prices, and where a cheaper model would likely do.
import { createReadStream, existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';

// USD per million tokens (Anthropic API list prices, 2026-10). cw = cache write (5-minute), cr = cache read.
// First matching prefix wins, so specific ids come before families.
export const PRICES = [
  ['claude-fable-5-1', { in: 10, out: 50, cr: 0.25 }],
  ['claude-mythos', { in: 10, out: 50, cr: 0.25 }],
  ['claude-fable', { in: 10, out: 50 }],
  ['claude-opus-5-5', { in: 4, out: 20, cr: 0.2 }],
  ['claude-opus', { in: 5, out: 25 }],
  ['claude-sonnet-5', { in: 2, out: 10, cr: 0.2 }],
  ['claude-sonnet', { in: 3, out: 15 }],
  ['claude-haiku-5-5', { in: 0.1, out: 0.5, cr: 0.01 }],
  ['claude-haiku', { in: 1, out: 5 }],
];
const PRICES_AS_OF = '2026-10';
const TIERS = ['haiku', 'sonnet', 'opus', 'fable'];
// The model Claude Code's `model:` aliases point at today, for "what if" prices.
const ALIAS_MODEL = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', fable: 'claude-fable-5-1' };

export function price(model) {
  const hit = PRICES.find(([p]) => String(model).startsWith(p));
  if (!hit) return null;
  const p = hit[1];
  return { in: p.in, out: p.out, cw: p.cw ?? p.in * 1.25, cr: p.cr ?? p.in * 0.1 };
}

export function tier(model) {
  const m = String(model);
  if (/mythos|fable/.test(m)) return 'fable';
  return TIERS.find((t) => m.includes(t)) || null;
}

export function cost(u, model) {
  const p = price(model);
  if (!p) return 0;
  return (u.input * p.in + u.cacheWrite * p.cw + u.cacheRead * p.cr + u.output * p.out) / 1e6;
}

const SEARCH = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'ToolSearch', 'NotebookRead']);
const EDIT = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL = new Set(['Bash', 'PowerShell']);

// What kind of work a transcript did, from its tool calls.
export function workKind(tools) {
  const n = Object.values(tools).reduce((a, b) => a + b, 0);
  if (!n) return 'chat';
  const count = (set) => Object.entries(tools).reduce((a, [k, v]) => a + (set.has(k) ? v : 0), 0);
  const edits = count(EDIT);
  if (edits >= 5 || edits / n >= 0.1) return 'coding';
  if (count(SEARCH) / n >= 0.6) return 'search';
  if (count(SHELL) / n >= 0.5) return 'scripts';
  return 'mixed';
}

// The cheapest tier we would suggest for this kind of work (only ever a suggestion: quality is not measured).
const SUGGEST = {
  search: { subagent: 'haiku', main: 'sonnet' },
  scripts: { subagent: 'sonnet', main: 'sonnet' },
  mixed: { subagent: 'sonnet', main: null },
  chat: { subagent: 'sonnet', main: null },
  coding: { subagent: null, main: null },
};

export function suggestFor(kind, isSub, model) {
  const want = SUGGEST[kind]?.[isSub ? 'subagent' : 'main'];
  const now = tier(model);
  if (!want || !now || TIERS.indexOf(want) >= TIERS.indexOf(now)) {
    // Fable for everyday work: Opus is the next step down whatever the kind.
    return now === 'fable' && kind !== 'coding' ? 'opus' : null;
  }
  return want;
}

async function scanFile(file) {
  const seen = new Set();
  const byModel = {};
  const tools = {};
  let firstPrompt = '';
  let entrypoint = '';
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.entrypoint && !entrypoint) entrypoint = o.entrypoint;
    if (!firstPrompt && o.type === 'user' && typeof o.message?.content === 'string') firstPrompt = o.message.content.slice(0, 2000);
    if (o.type !== 'assistant' || !o.message?.usage) continue;
    for (const c of o.message.content || []) if (c?.type === 'tool_use') tools[c.name] = (tools[c.name] || 0) + 1;
    const key = `${o.message.id}:${o.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const m = o.message.model;
    if (!m || m.startsWith('<')) continue;
    const u = o.message.usage;
    const b = (byModel[m] = byModel[m] || { requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0 });
    b.requests++;
    b.input += u.input_tokens || 0;
    b.cacheWrite += u.cache_creation_input_tokens || 0;
    b.cacheRead += u.cache_read_input_tokens || 0;
    b.output += u.output_tokens || 0;
  }
  return { byModel, tools, firstPrompt, entrypoint };
}

function readMeta(file) {
  try {
    return JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
  } catch {
    return {};
  }
}

// Custom agents defined in the project (.claude/agents/*.md) and their `model:` line.
export function customAgents(cwd) {
  const dir = join(cwd, '.claude', 'agents');
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const text = readFileSync(join(dir, f), 'utf8').replace(/^﻿/, '');
    const front = text.startsWith('---') ? text.split('---')[1] || '' : '';
    const name = (front.match(/^name:\s*(.+)$/m) || [])[1]?.trim() || basename(f, '.md');
    const model = (front.match(/^model:\s*(.+)$/m) || [])[1]?.trim() || null;
    out[name] = { file: `.claude/agents/${f}`, model };
  }
  return out;
}

// One row per transcript (main sessions and their subagents).
export async function modelUsage(sessions, cwd) {
  const agents = customAgents(cwd);
  const rows = [];
  for (const s of sessions) {
    const subDir = join(s.file.replace(/\.jsonl$/, ''), 'subagents');
    const files = [{ file: s.file, sub: false }];
    if (existsSync(subDir))
      for (const f of readdirSync(subDir).filter((x) => x.endsWith('.jsonl'))) files.push({ file: join(subDir, f), sub: true });
    for (const { file, sub } of files) {
      const r = await scanFile(file);
      const meta = sub ? readMeta(file) : {};
      // A general-purpose subagent told to "read .claude/agents/x.md and follow it" runs on the parent's model,
      // not the model that agent file asks for.
      let wrapped = null;
      if (sub && meta.agentType && !agents[meta.agentType]) {
        const m = r.firstPrompt.match(/\.claude[\\/]agents[\\/]([\w.-]+)\.md/);
        const def = m && Object.entries(agents).find(([, a]) => a.file.endsWith(`/${m[1]}.md`));
        if (def) wrapped = { name: def[0], model: def[1].model };
      }
      const kind = workKind(r.tools);
      for (const [model, u] of Object.entries(r.byModel)) {
        rows.push({
          session: s.id,
          file,
          sub,
          where: sub ? 'subagent' : r.entrypoint === 'sdk-cli' ? 'script (claude -p)' : 'session',
          agentType: meta.agentType || null,
          description: meta.description || '',
          wrapped,
          kind,
          model,
          ...u,
          cost: cost(u, model),
          suggest: wrapped?.model && TIERS.indexOf(wrapped.model) < TIERS.indexOf(tier(model)) ? wrapped.model : suggestFor(kind, sub, model),
        });
      }
    }
  }
  for (const r of rows) r.saving = r.suggest ? Math.max(0, r.cost - cost(r, ALIAS_MODEL[r.suggest])) : 0;
  return rows;
}

export function summarize(rows) {
  const group = (keyFn, list = rows) => {
    const m = new Map();
    for (const r of list) {
      const k = keyFn(r);
      const g = m.get(k) || { key: k, requests: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, saving: 0, transcripts: 0 };
      for (const f of ['requests', 'input', 'cacheWrite', 'cacheRead', 'output', 'cost', 'saving']) g[f] += r[f];
      g.transcripts++;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.cost - a.cost);
  };
  const total = rows.reduce((a, r) => a + r.cost, 0);
  const saving = rows.reduce((a, r) => a + r.saving, 0);
  const byModelWhere = group((r) => `${r.model}\t${r.where}`);
  // Rows the wrapped-agent fix covers are left out here, so no saving is counted twice.
  const byKind = group(
    (r) => `${r.where === 'subagent' ? 'subagent' : 'session'}\t${r.kind}\t${tier(r.model)}\t${r.suggest || ''}`,
    rows.filter((r) => !r.wrapped?.model),
  );
  // Subagents that wrapped a custom agent with its own model: the cheapest fix there is.
  const wrapped = group((r) => (r.wrapped ? `${r.wrapped.name}\t${r.wrapped.model || ''}\t${r.model}` : '')).filter((g) => g.key);
  return { total, saving, byModelWhere, byKind, wrapped, pricesAsOf: PRICES_AS_OF };
}

export { ALIAS_MODEL, TIERS };
