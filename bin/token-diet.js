#!/usr/bin/env node
// token-diet: find where your coding agent's tokens go, and what to cut.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditContext } from '../lib/context.js';
import { analyzeSession, findings, listSessions, projectDir } from '../lib/sessions.js';
import { fmt, median, pct } from '../lib/util.js';

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(['--days', '--project', '--top']);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const args = argv.filter((a, i) => !a.startsWith('--') && !VALUE_FLAGS.has(argv[i - 1]));
const val = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const JSON_OUT = flags.has('--json');
const DAYS = Number(val('--days', 7));
const CWD = resolve(val('--project', process.cwd()));
const color = process.stdout.isTTY && !flags.has('--no-color') && !process.env.NO_COLOR;
const c = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c('1'), dim = c('2'), cyan = c('36'), yellow = c('33'), red = c('31'), green = c('32');
const W = Math.min(process.stdout.columns || 100, 120);
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

const HELP = `${bold('token-diet')}: find where your coding agent's tokens go, and what to cut

  ${cyan('token-diet')}                    context files + the last 7 days of Claude Code sessions in this project
  ${cyan('token-diet context')}            only the instruction files and MCP servers loaded every session
  ${cyan('token-diet sessions')}           one line per session: requests, tokens, peak context
  ${cyan('token-diet session <id>')}       one session in detail (id prefix is enough)

  --days <n>        look back n days (default 7)      --project <dir>   another project (default: current dir)
  --json            machine-readable output            --no-color

Reads local files only (~/.claude/projects). Nothing is uploaded. Token counts per request come from the usage Claude Code
records; sizes of single files and tool outputs are estimates (~4 characters per token) and are marked with ~.`;

function heading(s) {
  console.log('\n' + bold(s));
}

function printContext(ctx) {
  heading('Loaded at the start of every session');
  if (!ctx.files.length) console.log(dim('  No CLAUDE.md, AGENTS.md or rules files found.'));
  for (const f of ctx.files) {
    const t = f.tokens >= 5000 ? red(`~${fmt(f.tokens)}`) : f.tokens >= 2000 ? yellow(`~${fmt(f.tokens)}`) : `~${fmt(f.tokens)}`;
    console.log(`  ${t.padEnd(color ? 16 : 7)} ${cut(f.path, W - 40)} ${dim(`${f.agent}, ${f.note}`)}`);
  }
  if (ctx.files.length) console.log(dim(`  total ~${fmt(ctx.totalTokens)} tokens of instructions, sent with every request`));
  if (ctx.duplicateTokens >= 50) {
    console.log(yellow(`  ~${fmt(ctx.duplicateTokens)} tokens are lines repeated across these files, e.g.:`));
    for (const l of ctx.dupExamples) console.log(dim(`    "${l}"`));
  }
  if (ctx.mcp.length) console.log(`  MCP servers configured: ${ctx.mcp.map((m) => m.name).join(', ')} ${dim('(each adds its tool definitions to every request)')}`);
}

// Split of the request's fixed part (system prompt + tool definitions), as shares of characters. Shares, not token counts:
// JSON schemas and prose tokenize differently, so only the proportions are reliable.
function toolDefSummary(defs) {
  if (!defs?.tools?.length) return null;
  const toolChars = defs.tools.reduce((s, d) => s + d.chars, 0);
  const all = toolChars + defs.systemChars;
  const byServer = new Map();
  for (const d of defs.tools.filter((t) => t.name.startsWith('mcp__'))) {
    const server = d.name.split('__')[1];
    byServer.set(server, (byServer.get(server) || 0) + d.chars);
  }
  return {
    count: defs.tools.length,
    toolShare: toolChars / all,
    mcp: [...byServer].sort((a, b) => b[1] - a[1]).map(([name, chars]) => [name, chars / all]),
  };
}
const share = (x) => `${Math.round(x * 100)}%`;
const toolName = (n) => (n.startsWith('mcp__') ? n.slice(5).replace('__', ':') : n);

function printSessionsTable(list, title = `Sessions in the last ${DAYS} days (${list.length})`) {
  heading(title);
  console.log(dim('  id        requests   tokens in   cache read   output   start ctx   peak ctx   compactions'));
  for (const s of list.slice(0, Number(val('--top', 15))))
    console.log(`  ${s.id.slice(0, 8)}  ${String(s.calls).padStart(8)}  ${fmt(s.input + s.cacheWrite + s.cacheRead).padStart(10)}  ${pct(s.cacheRead, s.input + s.cacheWrite + s.cacheRead).padStart(11)}  ${fmt(s.output).padStart(7)}  ${fmt(s.start).padStart(10)}  ${fmt(s.peak).padStart(9)}  ${String(s.compactions).padStart(11)}`);
}

function tips(list, f, ctx) {
  const out = [];
  const starts = list.map((s) => s.start).filter(Boolean);
  const start = median(starts);
  const defs = toolDefSummary(list.find((s) => s.toolDefs)?.toolDefs);
  if (start >= 20000) {
    let why = `Every session starts at ~${fmt(start)} tokens of context (median of ${starts.length}) before you type anything.`;
    if (defs) why += ` About ${share(defs.toolShare)} of the fixed part is tool definitions (${defs.count} tools)${defs.mcp.length ? `; MCP servers: ${defs.mcp.slice(0, 4).map(([n, x]) => `${n} ${share(x)}`).join(', ')}` : ''}.`;
    if (ctx?.totalTokens) why += ` Instruction files are ~${fmt(ctx.totalTokens)}.`;
    out.push([why, 'Disable MCP servers you do not use in this project, and move rarely needed instructions out of CLAUDE.md into files the agent reads on demand.']);
  }
  const bash = f.byTool.find((t) => t.tool === 'Bash' || t.tool === 'PowerShell');
  const bigCmds = f.big.filter((r) => r.tool === 'Bash' || r.tool === 'PowerShell');
  if (bigCmds.length)
    out.push([`${bigCmds.length} shell commands returned ${fmt(bigCmds.reduce((s, r) => s + r.tokens, 0))}+ tokens of output; the largest: "${cut(bigCmds[0].what, 70)}" (~${fmt(bigCmds[0].tokens)}, then re-sent with ${bigCmds[0].carried} later requests).`,
      'Ask for less output: pipe through head/tail or grep, use quiet flags (npm --silent, git --stat, pytest -q), or write long logs to a file and read only the part you need.']);
  if (f.noisyCommands.length)
    out.push([`Commands that are big every time: ${f.noisyCommands.slice(0, 4).map((e) => `"${e.key}" ${e.count}x ~${fmt(e.tokens)}`).join(', ')}.`,
      'Put the short version in CLAUDE.md, e.g. "run tests with `npm test --silent 2>&1 | tail -30`", so the agent uses it by default.']);
  const bigReads = f.big.filter((r) => r.tool === 'Read');
  if (bigReads.length)
    out.push([`${bigReads.length} file reads were over 2.5k tokens; the largest: ${cut(bigReads[0].what, 70)} (~${fmt(bigReads[0].tokens)}).`,
      'Have the agent Grep first and Read with offset/limit, or split very large files; a whole file stays in context for the rest of the session.']);
  if (f.rereads.length)
    out.push([`Files read 3+ times in one session: ${f.rereads.slice(0, 3).map((r) => `${cut(r.path, 50)} ${r.times}x${r.inSubagents ? ` (${r.inSubagents} by subagents)` : ''}`).join(', ')}.`,
      f.rereads[0].inSubagents > f.rereads[0].times / 2
        ? 'Each subagent starts empty and reads the same file again. Pass the needed part in the subagent prompt instead of telling it to read the file.'
        : 'Re-reading usually follows edits or a compaction. Read only the lines you need (offset/limit), or note the key lines in your prompt.']);
  const long = list.filter((s) => s.peak >= 150000);
  if (long.length)
    out.push([`${long.length} sessions grew past 150k tokens of context; every request in them re-sent that much.`,
      'Start a new session (/clear) when you switch tasks, and /compact with a short focus note before a long session gets heavy.']);
  const write = list.reduce((s, x) => s + x.cacheWrite, 0), read = list.reduce((s, x) => s + x.cacheRead, 0);
  if (write + read > 0 && write / (write + read) > 0.2)
    out.push([`${pct(write, write + read)} of cached input was written fresh rather than read from cache.`,
      'The prompt cache expires after a few minutes idle and is per model: long pauses mid-task and switching models force a full rewrite of the context.']);
  return out;
}

function printFindings(list, f, ctx, title = `Last ${DAYS} days in this project`) {
  const tot = list.reduce((a, s) => ({ in: a.in + s.input + s.cacheWrite + s.cacheRead, out: a.out + s.output, calls: a.calls + s.calls, cr: a.cr + s.cacheRead }), { in: 0, out: 0, calls: 0, cr: 0 });
  heading(title);
  console.log(`  ${list.length} session${list.length === 1 ? '' : 's'}, ${fmt(tot.calls)} requests, ${bold(fmt(tot.in))} input tokens (${pct(tot.cr, tot.in)} from cache), ${fmt(tot.out)} output tokens`);
  console.log(dim(`  Most input is the same context re-sent with each request, so what stays in context matters more than what you type.`));

  if (f.byTool.length) {
    heading('Tool output by tool (size, and size x later requests that re-sent it)');
    for (const t of f.byTool.slice(0, 8)) console.log(`  ${cut(toolName(t.tool), 24).padEnd(24)} ${String(t.count).padStart(5)} calls  ~${fmt(t.tokens).padStart(6)}  re-sent ~${fmt(t.carriedTokens)}`);
  }
  if (f.big.length) {
    heading('Largest single tool outputs');
    console.log(dim('  size    re-sent  tool        what'));
    for (const r of f.big.slice(0, 8)) console.log(`  ~${fmt(r.tokens).padStart(5)}  x${String(r.carried).padEnd(6)} ${cut(toolName(r.tool), 11).padEnd(11)} ${dim(cut(r.what || '', W - 34))}`);
  }
  const t = tips(list, f, ctx);
  heading(t.length ? 'What to cut' : 'Nothing big to cut. Nice.');
  t.forEach(([why, fix], i) => {
    console.log(`  ${bold(`${i + 1}.`)} ${why}`);
    console.log(`     ${green('→')} ${fix}`);
  });
  console.log(dim('\n  How much usage each plan gives: https://getstackversus.com/limits'));
}

async function load(days) {
  const sessions = listSessions(projectDir(CWD), days);
  const out = [];
  for (const s of sessions) out.push(await analyzeSession(s));
  return out.filter((s) => s.calls > 0);
}

async function main() {
  const cmd = args[0];
  if (flags.has('--help') || cmd === 'help') return console.log(HELP);
  if (flags.has('--version')) return console.log(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version);

  if (cmd === 'context') {
    const ctx = auditContext(CWD);
    return JSON_OUT ? console.log(JSON.stringify(ctx, null, 2)) : printContext(ctx);
  }

  const dir = projectDir(CWD);
  if (cmd === 'session') {
    const id = args[1];
    const s = listSessions(dir, 3650).find((x) => x.id.startsWith(id || '\0'));
    if (!s) return console.error(`No session starting with "${id}" in ${dir}`), process.exit(1);
    const a = await analyzeSession(s);
    if (JSON_OUT) return console.log(JSON.stringify(a, null, 2));
    printSessionsTable([a], `Session ${a.id}${a.subagents ? ` (+${a.subagents} subagents)` : ''}`);
    const defs = toolDefSummary(a.toolDefs);
    if (defs) console.log(dim(`\n  Tool definitions: ${share(defs.toolShare)} of the fixed request (${defs.count} tools)${defs.mcp.length ? `; MCP ${defs.mcp.map(([n, x]) => `${n} ${share(x)}`).join(', ')}` : ''}`));
    printFindings([a], findings([a]), null, 'Totals');
    return;
  }

  const list = await load(DAYS);
  if (cmd === 'sessions') return JSON_OUT ? console.log(JSON.stringify(list.map(({ results, ...s }) => s), null, 2)) : printSessionsTable(list);

  const ctx = auditContext(CWD);
  const f = findings(list);
  if (JSON_OUT) return console.log(JSON.stringify({ context: ctx, sessions: list.map(({ results, ...s }) => s), findings: f }, null, 2));
  printContext(ctx);
  if (!list.length) {
    console.log(dim(`\n  No Claude Code sessions for ${CWD} in the last ${DAYS} days (looked in ${dir}).`));
    return;
  }
  printFindings(list, f, ctx);
}

main().catch((e) => {
  console.error(`token-diet: ${e.stack || e.message}`);
  process.exit(1);
});
