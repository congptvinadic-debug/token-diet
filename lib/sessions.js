// Session analysis: reads Claude Code's local transcripts (~/.claude/projects/<project>/*.jsonl, plus subagent transcripts)
// and finds where the tokens went. Token counts per request are real (from the API usage the transcript records); the size of a
// single tool result is estimated from its characters.
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { claudeDir, estTokens, projectSlug } from './util.js';

export function projectDir(cwd) {
  return join(claudeDir(), 'projects', projectSlug(cwd));
}

/** Every project folder under ~/.claude/projects with sessions in the window, and its real path (read from the transcripts). */
export async function listProjects(days) {
  const root = join(claudeDir(), 'projects');
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    const dir = join(root, name);
    const sessions = listSessions(dir, days);
    if (!sessions.length) continue;
    let cwd = null;
    const rl = createInterface({ input: createReadStream(sessions[0].file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      const m = line.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) {
        cwd = JSON.parse(`"${m[1]}"`);
        break;
      }
    }
    rl.close();
    out.push({ name, dir, cwd, sessions });
  }
  return out;
}

export function listSessions(dir, days) {
  if (!existsSync(dir)) return [];
  const since = Date.now() - days * 86400000;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ id: basename(f, '.jsonl'), file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
    .filter((s) => s.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime);
}

function resultChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let n = 0;
  for (const c of content) {
    if (c?.type === 'text') n += c.text?.length || 0;
    else if (c?.type === 'image') n += 6000; // images cost roughly 1-2k tokens each; counted as ~1.5k
  }
  return n;
}

function describe(name, input = {}) {
  if (input.command) return String(input.command).replace(/\s+/g, ' ').slice(0, 100);
  if (input.file_path) return input.file_path + (input.offset || input.limit ? ` (lines ${input.offset || 1}+${input.limit || ''})` : '');
  if (input.pattern) return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
  if (input.url) return input.url;
  if (input.query) return String(input.query).slice(0, 100);
  if (input.prompt) return String(input.prompt).replace(/\s+/g, ' ').slice(0, 80);
  return '';
}

/** Parse one transcript file. Returns API calls (deduplicated), tool results with their position, and compaction points. */
async function parseFile(file) {
  const calls = new Map(); // message id -> usage
  const order = []; // message ids in order
  const toolUses = new Map();
  const results = [];
  const compactAt = [];
  let toolDefs = null;
  // What is in the conversation since the last compaction, in characters: attachments by type, your text, the agent's text.
  let attach = {}, userChars = 0, assistantChars = 0;
  let startChars = null; // conversation characters present at the first request (calibrates the fixed part)
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== '{') continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'assistant' && o.message?.usage) {
      const id = `${o.message.id}:${o.requestId || ''}`;
      if (startChars === null) startChars = userChars + Object.values(attach).reduce((s, x) => s + x, 0);
      if (!calls.has(id)) order.push(id);
      calls.set(id, { u: o.message.usage, ts: o.timestamp, model: o.message.model });
      for (const c of o.message.content || []) {
        if (c?.type === 'tool_use') toolUses.set(c.id, { name: c.name, what: describe(c.name, c.input), input: c.input });
        if (c?.type === 'text') assistantChars += c.text?.length || 0;
        if (c?.type === 'tool_use') assistantChars += JSON.stringify(c.input || {}).length;
      }
    } else if (o.type === 'user' && Array.isArray(o.message?.content)) {
      for (const c of o.message.content) {
        if (c?.type === 'tool_result') results.push({ id: c.tool_use_id, chars: resultChars(c.content), at: order.length, ts: o.timestamp });
        else if (c?.type === 'text') userChars += c.text?.length || 0;
        else if (c?.type === 'image') userChars += 6000;
      }
    } else if (o.type === 'user' && typeof o.message?.content === 'string') {
      userChars += o.message.content.length;
    } else if (o.type === 'attachment' && o.attachment?.type) {
      const n = (o.rendered || []).reduce((s, r) => s + (typeof r?.content === 'string' ? r.content.length : 0), 0);
      attach[o.attachment.type] = (attach[o.attachment.type] || 0) + n;
    } else if (o.type === 'system' && o.subtype === 'compact_boundary') {
      compactAt.push(order.length);
      attach = {};
      userChars = 0;
      assistantChars = 0;
    } else if (o.type === 'api-request-shape' && Array.isArray(o.shape?.tools) && !toolDefs) {
      // Only the split matters here: character counts of the system prompt and of each tool definition.
      toolDefs = {
        systemChars: JSON.stringify(o.shape.system || '').length,
        tools: o.shape.tools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length })),
      };
    }
  }
  return { calls: order.map((id) => calls.get(id)), toolUses, results, compactAt, toolDefs, attach, userChars, assistantChars, startChars: startChars || 0 };
}

// Attachment types Claude Code injects, mapped to the categories of its own /context view.
const ATTACH_CATEGORY = {
  skill_listing: 'Skills',
  instructions: 'Memory files',
  nested_memory: 'Memory files',
  mcp_instructions_delta: 'MCP server instructions',
  agent_listing_delta: 'Custom agents',
};

/**
 * What the context holds at the last request of the main conversation, split like Claude Code's /context view.
 * Both totals are real API usage: the first request anchors the fixed part (system prompt, tools, skills, memory...), the last
 * request is the whole context. Messages = last - fixed. Splits inside each group are estimated from characters.
 */
function contextNow(p) {
  const first = p.calls[0], last = p.calls.at(-1);
  if (!last) return null;
  const size = (c) => (c.u.input_tokens || 0) + (c.u.cache_creation_input_tokens || 0) + (c.u.cache_read_input_tokens || 0);
  const total = size(last), start = size(first);
  const fixedParts = {}, msgParts = {};
  const add = (o, k, chars) => (o[k] = (o[k] || 0) + chars);
  if (p.toolDefs) {
    add(fixedParts, 'System prompt', p.toolDefs.systemChars);
    for (const t of p.toolDefs.tools) add(fixedParts, t.name.startsWith('mcp__') ? 'MCP tools' : 'System tools', t.chars);
  }
  for (const [type, chars] of Object.entries(p.attach))
    if (ATTACH_CATEGORY[type]) add(fixedParts, ATTACH_CATEGORY[type], chars);
    else add(msgParts, 'Messages: reminders and attachments', chars);
  const since = p.compactAt.at(-1) ?? -1;
  const byTool = {};
  for (const r of p.results)
    if (r.at > since) {
      const name = p.toolUses.get(r.id)?.name || '?';
      byTool[name] = (byTool[name] || 0) + r.chars;
    }
  for (const [name, chars] of Object.entries(byTool)) add(msgParts, `Messages: ${name} output`, chars);
  add(msgParts, 'Messages: your messages', p.userChars);
  add(msgParts, "Messages: agent's replies and tool calls", p.assistantChars);
  const sum = (o) => Object.values(o).reduce((s, x) => s + x, 0);
  // Fixed part in tokens: the first request minus what the conversation already held then (~4 chars/token for that bit).
  const fixedChars = sum(fixedParts) || 1;
  const fixedTokens = Math.min(total, Math.max(0, start - Math.round(p.startChars / 4)));
  const messages = Math.max(0, total - fixedTokens);
  const msgChars = sum(msgParts) || 1;
  const rows = [
    ...Object.entries(fixedParts).map(([name, chars]) => ({ name, tokens: Math.round((chars / fixedChars) * fixedTokens) })),
    ...Object.entries(msgParts).map(([name, chars]) => ({ name, tokens: Math.round((chars / msgChars) * messages) })),
  ].filter((r) => r.tokens > 0);
  return { total, messages, rows: rows.sort((a, b) => b.tokens - a.tokens), compactions: p.compactAt.length };
}

export async function analyzeSession(s) {
  const parts = [await parseFile(s.file)];
  const subDir = join(s.file.replace(/\.jsonl$/, ''), 'subagents');
  if (existsSync(subDir)) for (const f of readdirSync(subDir)) if (f.endsWith('.jsonl')) parts.push(await parseFile(join(subDir, f)));

  const out = { id: s.id, mtime: s.mtime, calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, start: 0, peak: 0, compactions: 0,
    subagents: parts.length - 1, results: [], toolDefs: parts[0].toolDefs, firstTs: null, lastTs: null };
  for (const [pi, p] of parts.entries()) {
    out.compactions += p.compactAt.length;
    p.calls.forEach((c, i) => {
      const ctx = (c.u.input_tokens || 0) + (c.u.cache_creation_input_tokens || 0) + (c.u.cache_read_input_tokens || 0);
      out.calls++;
      out.input += c.u.input_tokens || 0;
      out.cacheWrite += c.u.cache_creation_input_tokens || 0;
      out.cacheRead += c.u.cache_read_input_tokens || 0;
      out.output += c.u.output_tokens || 0;
      out.peak = Math.max(out.peak, ctx);
      if (pi === 0 && i === 0) out.start = ctx;
      if (c.ts && (!out.firstTs || c.ts < out.firstTs)) out.firstTs = c.ts;
      if (c.ts && (!out.lastTs || c.ts > out.lastTs)) out.lastTs = c.ts;
    });
    for (const r of p.results) {
      const use = p.toolUses.get(r.id) || { name: '?', what: '' };
      // A result stays in context and is re-sent with every later request until the next compaction.
      const nextCompact = p.compactAt.find((x) => x > r.at) ?? p.calls.length;
      const carried = Math.max(0, nextCompact - r.at);
      out.results.push({ tool: use.name, what: use.what, path: use.input?.file_path, tokens: estTokens(r.chars), carried, sub: pi > 0 });
    }
  }
  out.total = out.input + out.cacheWrite + out.cacheRead + out.output;
  out.contextNow = contextNow(parts[0]);
  return out;
}

/** Turn many analyzed sessions into findings with concrete fixes. */
export function findings(sessions) {
  const all = sessions.flatMap((s) => s.results.map((r) => ({ ...r, session: s.id })));
  const big = all.filter((r) => r.tokens >= 2500).sort((a, b) => b.tokens * Math.max(1, b.carried) - a.tokens * Math.max(1, a.carried));

  const byTool = new Map();
  for (const r of all) {
    const t = byTool.get(r.tool) || { tool: r.tool, count: 0, tokens: 0, carriedTokens: 0 };
    t.count++;
    t.tokens += r.tokens;
    t.carriedTokens += r.tokens * r.carried;
    byTool.set(r.tool, t);
  }

  // Same file read again in the same session.
  const rereads = [];
  for (const s of sessions) {
    const m = new Map();
    for (const r of s.results)
      if (r.tool === 'Read' && r.path) {
        const e = m.get(r.path) || { path: r.path, times: 0, inSubagents: 0, tokens: 0, session: s.id };
        e.times++;
        if (r.sub) e.inSubagents++;
        e.tokens += r.tokens;
        m.set(r.path, e);
      }
    for (const e of m.values()) if (e.times >= 3) rereads.push(e);
  }
  rereads.sort((a, b) => b.tokens - a.tokens);

  // Commands whose output is big again and again (grouped by their first two words).
  const cmd = new Map();
  for (const r of all)
    if ((r.tool === 'Bash' || r.tool === 'PowerShell') && r.tokens >= 2000) {
      // Drop a leading `cd <dir> &&` / `cd <dir>;`, unify path separators, then key on the command and its first argument.
      const bare = r.what.replace(/^\s*(?:cd|Set-Location)\s+("[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/i, '').replace(/\\/g, '/');
      const key = bare.split(' ').slice(0, 2).join(' ');
      const e = cmd.get(key) || { key, count: 0, tokens: 0 };
      e.count++;
      e.tokens += r.tokens;
      cmd.set(key, e);
    }

  return {
    big: big.slice(0, 12),
    byTool: [...byTool.values()].sort((a, b) => b.carriedTokens - a.carriedTokens),
    rereads: rereads.slice(0, 8),
    noisyCommands: [...cmd.values()].filter((e) => e.count >= 2).sort((a, b) => b.tokens - a.tokens).slice(0, 8),
  };
}
