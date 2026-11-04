#!/usr/bin/env node
// token-diet: find where your coding agent's tokens go, and what to cut.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { auditContext } from '../lib/context.js';
import { analyzeSession, CARRY, compactSavings, findings, listProjects, listSessions, projectDir, REREAD } from '../lib/sessions.js';
import { fmt, median, pct } from '../lib/util.js';
import { loadConfig } from '../lib/hook.js';
import { install, uninstall } from '../lib/install.js';

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
  ${cyan('token-diet now')}                what fills the context of your latest session, like /context, and what to cut
  ${cyan('token-diet all')}                every project on this machine, biggest token users first
  ${cyan('token-diet install')}            add Claude Code hooks: a /compact reminder past 150k, and clipping of huge
                                command outputs (full text kept in a file). --here: this project only, --no-clip
  ${cyan('token-diet uninstall')}          remove them

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
  if (long.length) {
    const sv = compactSavings(list);
    const at100 = sv.caps.find((x) => x.cap === 100000);
    // The biggest lever by far in every project we measured, so it goes first.
    out.unshift([`${long.length} of ${list.length} sessions grew past 150k tokens of context; every request in them re-sent that much. Replayed with /compact at 100k, these ${list.length} sessions would have used ${fmt(at100.tokens)} instead of ${fmt(sv.actual)} input tokens (-${Math.round(at100.saved * 100)}%).`,
      'Run /compact (with a one-line note of the task) when the context reaches ~100k, and /clear when you switch tasks. Write progress to a file first if the task is long.']);
  }
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

// Breakdown of the context at the session's last request, like Claude Code's /context view, plus what to cut in it.
function printContextNow(a) {
  const c = a.contextNow;
  if (!c) return;
  heading(`Context now: ${fmt(c.total)} tokens (last request${c.compactions ? `, after ${c.compactions} compaction${c.compactions > 1 ? 's' : ''}` : ''})`);
  const fixed = c.rows.filter((r) => !r.name.startsWith('Messages'));
  const msgs = c.rows.filter((r) => r.name.startsWith('Messages'));
  const line = (r, indent = '  ') => console.log(`${indent}${('~' + fmt(r.tokens)).padStart(7)}  ${pct(r.tokens, c.total).padStart(4)}  ${r.name.replace('Messages: ', '')}`);
  console.log(`  ${('~' + fmt(c.messages)).padStart(7)}  ${pct(c.messages, c.total).padStart(4)}  ${bold('Messages')}`);
  for (const r of msgs.slice(0, 8)) line(r, '    ');
  for (const r of fixed) line(r);
  console.log(dim('  Total is the real size of the last request; the split is estimated from characters.'));

  const out = [];
  const top = msgs[0];
  const start = a.series[0]?.[0] || 0;
  if (c.total >= 100000 && c.messages / c.total >= 0.6) {
    const after = start + CARRY + REREAD;
    out.push([`Messages are ${pct(c.messages, c.total)} of a ${fmt(c.total)} context, re-sent with every request. After /compact the next requests would be about ${fmt(after)} each instead of ${fmt(c.total)} (-${pct(c.total - after, c.total)}).`,
      'Run /compact with a one-line note of what you are doing (it keeps a summary), or /clear when you move to another task. Do it again around 100k.']);
  }
  const sv = compactSavings([a]);
  if (sv.actual) {
    heading('This session with /compact at a fixed size (replayed on its real request sizes)');
    console.log(`  as it went      ${fmt(sv.actual).padStart(7)} input tokens`);
    for (const x of sv.caps) console.log(`  /compact at ${fmt(x.cap).padEnd(4)} ${fmt(x.tokens).padStart(7)}  ${green('-' + Math.round(x.saved * 100) + '%')}`);
    console.log(dim(`  Assumes each /compact keeps ~${fmt(CARRY)} of summary and the agent re-reads ~${fmt(REREAD)} of files afterwards.`));
  }
  if (top && top.tokens >= 15000) {
    const name = top.name.replace('Messages: ', '');
    const fix = /Read output/.test(name) ? 'Read only the lines you need (offset/limit) and Grep before reading whole files.'
      : /(Bash|PowerShell) output/.test(name) ? 'Cap command output (| head -50, | tail -30, quiet flags), or write it to a file and grep it.'
      : /your messages/.test(name) ? 'Pasted logs and screenshots stay in context: paste the relevant part or crop the image.'
      : /replies/.test(name) ? 'Ask for shorter answers (an output style or "be brief"), long replies stay in context too.'
      : /reminders/.test(name) ? 'Hook output and repeated reminders pile up: keep hook messages short.'
      : /mcp__|output/.test(name) ? 'This tool returns a lot each call: use its narrower calls or fewer calls per task.'
      : 'Keep this part smaller or start fresh after it.';
    out.push([`Biggest part of the messages: ${name} (~${fmt(top.tokens)}).`, fix]);
  }
  const get = (n) => fixed.find((r) => r.name === n)?.tokens || 0;
  if (get('MCP tools') >= 10000) out.push([`MCP tool definitions take ~${fmt(get('MCP tools'))} on every request.`, 'Turn off MCP servers this project does not use.']);
  if (get('Memory files') >= 5000) out.push([`Memory files (CLAUDE.md, AGENTS.md, memory index) take ~${fmt(get('Memory files'))}.`, 'Keep only rules the agent needs every time; move the rest into files it reads on demand.']);
  if (get('Skills') >= 5000) out.push([`The skills list takes ~${fmt(get('Skills'))}.`, 'Remove or disable skills and plugins you do not use.']);
  if (out.length) {
    heading('What to cut in this context');
    out.forEach(([why, fix], i) => {
      console.log(`  ${bold(`${i + 1}.`)} ${why}`);
      console.log(`     ${green('→')} ${fix}`);
    });
  }
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

  if (cmd === 'install' || cmd === 'uninstall') {
    const projectCwd = flags.has('--here') ? CWD : null;
    if (cmd === 'uninstall') {
      const r = uninstall({ projectCwd });
      return console.log(r.removed ? `Removed token-diet hooks from ${r.settings}` : `No token-diet hooks in ${r.settings}`);
    }
    const r = install({ projectCwd, clip: !flags.has('--no-clip') });
    const cfg = loadConfig();
    console.log(`${green('Installed')} in ${r.settings} (backup next to it as .token-diet.bak)\n`);
    console.log(`  ${bold('Compact reminder')}  when a session's context passes ${fmt(cfg.compactAt)} tokens, you get a line telling you to run /compact`);
    console.log(`                    (again every +${fmt(cfg.every)}, not on every message).`);
    if (!flags.has('--no-clip'))
      console.log(`  ${bold('Output clip')}       Bash/PowerShell output over ${fmt(cfg.clipChars)} chars (~${fmt(cfg.clipChars / 4)} tokens) is saved to a file and the agent sees the\n                    first ${cfg.headLines} and last ${cfg.tailLines} lines plus the path. End a command with "# full" to keep it whole.`);
    console.log(dim(`\n  Settings: ${r.config}\n  New sessions pick the hooks up; remove them with: token-diet uninstall${projectCwd ? ' --here' : ''}`));
    return;
  }

  if (cmd === 'context') {
    const ctx = auditContext(CWD);
    return JSON_OUT ? console.log(JSON.stringify(ctx, null, 2)) : printContext(ctx);
  }

  if (cmd === 'all') {
    const rows = [];
    for (const p of await listProjects(DAYS)) {
      const list = [];
      for (const s of p.sessions) list.push(await analyzeSession(s));
      const used = list.filter((s) => s.calls > 0);
      if (!used.length) continue;
      const f = findings(used);
      rows.push({
        project: p.cwd || p.name,
        sessions: used.length,
        requests: used.reduce((a, s) => a + s.calls, 0),
        input: used.reduce((a, s) => a + s.input + s.cacheWrite + s.cacheRead, 0),
        output: used.reduce((a, s) => a + s.output, 0),
        startMedian: median(used.map((s) => s.start).filter(Boolean)),
        over150k: used.filter((s) => s.peak >= 150000).length,
        topTool: f.byTool[0] ? `${toolName(f.byTool[0].tool)} ~${fmt(f.byTool[0].carriedTokens)}` : '-',
        cuts: tips(used, f, null).length,
      });
    }
    rows.splice(0, rows.length, ...rows.filter((r) => r.input > 0).sort((a, b) => b.input - a.input));
    if (JSON_OUT) return console.log(JSON.stringify(rows, null, 2));
    heading(`All projects, last ${DAYS} days (${rows.length})`);
    const total = rows.reduce((a, r) => a + r.input, 0);
    console.log(dim('  input     share  sessions  start ctx  >150k  most re-sent tool output       cuts  project'));
    for (const r of rows)
      console.log(`  ${fmt(r.input).padStart(6)}  ${pct(r.input, total).padStart(5)}  ${String(r.sessions).padStart(8)}  ${fmt(r.startMedian).padStart(9)}  ${String(r.over150k).padStart(5)}  ${cut(r.topTool, 30).padEnd(30)} ${String(r.cuts).padStart(4)}  ${r.project}`);
    console.log(dim('\n  Details for one project: token-diet --project "<path>"'));
    return;
  }

  const dir = projectDir(CWD);
  if (cmd === 'now') {
    // The most recently active session of this project (usually the one you are in).
    const s = listSessions(dir, 3650)[0];
    if (!s) return console.error(`No sessions in ${dir}`), process.exit(1);
    const a = await analyzeSession(s);
    if (JSON_OUT) return console.log(JSON.stringify(a.contextNow, null, 2));
    console.log(dim(`Session ${a.id}`));
    printContextNow(a);
    return;
  }
  if (cmd === 'session') {
    const id = args[1];
    const s = listSessions(dir, 3650).find((x) => x.id.startsWith(id || '\0'));
    if (!s) return console.error(`No session starting with "${id}" in ${dir}`), process.exit(1);
    const a = await analyzeSession(s);
    if (JSON_OUT) return console.log(JSON.stringify(a, null, 2));
    printSessionsTable([a], `Session ${a.id}${a.subagents ? ` (+${a.subagents} subagents)` : ''}`);
    const defs = toolDefSummary(a.toolDefs);
    if (defs) console.log(dim(`\n  Tool definitions: ${share(defs.toolShare)} of the fixed request (${defs.count} tools)${defs.mcp.length ? `; MCP ${defs.mcp.map(([n, x]) => `${n} ${share(x)}`).join(', ')}` : ''}`));
    printContextNow(a);
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
