// Which tool definitions ride along with every request, and which of them were never called.
// Claude Code logs the tools of each conversation's first request (an "api-request-shape" line) and every tool_use the
// agent made, so "loaded but unused" comes straight from the transcripts.
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { estTokens } from './util.js';

const serverOf = (name) => (name.startsWith('mcp__') ? name.split('__')[1] : null);

/** One transcript: the tools sent with its first request ({name, chars}) and how often each tool was called. */
export async function scanTools(file) {
  let loaded = null;
  const calls = new Map();
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line || line[0] !== '{') continue;
    const shape = !loaded && line.includes('"api-request-shape"');
    if (!shape && !line.includes('"tool_use"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (shape && o.type === 'api-request-shape' && Array.isArray(o.shape?.tools)) {
      loaded = o.shape.tools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length }));
    } else if (o.type === 'assistant') {
      for (const c of o.message?.content || []) if (c?.type === 'tool_use' && c.name) calls.set(c.name, (calls.get(c.name) || 0) + 1);
    }
  }
  return { loaded: loaded || [], calls };
}

/** Transcripts of the given sessions, their subagents included. */
function files(sessions) {
  const out = [];
  for (const s of sessions) {
    out.push(s.file);
    const sub = join(s.file.replace(/\.jsonl$/, ''), 'subagents');
    if (existsSync(sub)) for (const f of readdirSync(sub)) if (f.endsWith('.jsonl')) out.push(join(sub, f));
  }
  return out;
}

/**
 * Aggregate over sessions. `configured` is the MCP servers found in .mcp.json / ~/.claude.json (names), so a server can be
 * labelled as one the user can remove, or one that came with the app or a plugin.
 * Returns { conversations, servers: [...], builtins: [...] }, unused first, biggest first.
 */
export async function toolUsage(sessions, configured = []) {
  const mine = new Set(configured.map((m) => m.name.replace(/[^A-Za-z0-9_-]/g, '_')));
  const servers = new Map();
  const builtins = new Map();
  let conversations = 0;
  for (const file of files(sessions)) {
    const { loaded, calls } = await scanTools(file);
    if (!loaded.length) continue;
    conversations++;
    const seen = new Set();
    for (const t of loaded) {
      const srv = serverOf(t.name);
      const map = srv ? servers : builtins;
      const key = srv || t.name;
      const e = map.get(key) || { name: key, tools: new Set(), chars: 0, loadedIn: 0, calls: 0, usedIn: 0 };
      e.tools.add(t.name);
      e.chars += t.chars;
      if (!seen.has(key)) {
        e.loadedIn++;
        seen.add(key);
      }
      map.set(key, e);
    }
    const usedHere = new Set();
    for (const [name, n] of calls) {
      const srv = serverOf(name);
      if (!seen.has(srv || name)) continue; // loaded later through tool search: not part of the fixed cost
      const e = (srv ? servers : builtins).get(srv || name);
      e.calls += n;
      usedHere.add(e.name);
    }
    for (const key of usedHere) ((servers.get(key) || builtins.get(key)).usedIn++);
  }
  const finish = (e, isServer) => ({
    name: e.name,
    tools: e.tools.size,
    tokens: estTokens(Math.round(e.chars / Math.max(1, e.loadedIn))), // per request, when loaded
    loadedIn: e.loadedIn,
    usedIn: e.usedIn,
    calls: e.calls,
    ...(isServer ? { source: mine.has(e.name) ? 'config' : 'app or plugin' } : {}),
  });
  const unusedFirst = (a, b) => (a.calls > 0) - (b.calls > 0) || b.tokens - a.tokens;
  return {
    conversations,
    servers: [...servers.values()].map((e) => finish(e, true)).sort(unusedFirst),
    builtins: [...builtins.values()].map((e) => finish(e, false)).sort(unusedFirst),
  };
}
