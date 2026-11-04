# token-diet

Find where your coding agent's tokens go, and what to cut.

```
npx token-diet
```

Run it in a project folder. It reads Claude Code's local session logs (`~/.claude/projects/...`) and the instruction files your
agents load, and tells you:

- **What every session starts with.** CLAUDE.md, AGENTS.md, rules files, the auto-memory index, and how much of the fixed request
  is tool definitions, per MCP server.
- **Which tool outputs were huge**, and how many later requests re-sent them. A 6k-token `cat` early in a session can be re-sent
  250 times before the session ends.
- **Commands that are noisy every time** (test runners, build scripts, your own scripts), so you can teach the agent the quiet form.
- **Files read again and again**, including by subagents that each start empty.
- **Sessions that grew too big**, and how much of the input was rebuilt instead of read from cache.

Each finding comes with a concrete fix. Nothing leaves your machine: no network calls, no dependencies. Node 18.17 or newer.

## Example (a real week on one project)

```
What to cut
  1. Every session starts at ~27k tokens of context (median of 74) before you type anything. About 78% of the
     fixed part is tool definitions (53 tools); MCP servers: Claude_Browser 14%, ccd_turn 5%, visualize 3%.
     → Disable MCP servers you do not use in this project, and move rarely needed instructions out of CLAUDE.md
       into files the agent reads on demand.
  3. Commands that are big every time: ".venv/Scripts/python scripts/pw.py" 76x ~194k, "scripts/scoreboard.py" 53x ~151k
     → Put the short version in CLAUDE.md, e.g. "run tests with `npm test --silent 2>&1 | tail -30`", so the agent
       uses it by default.
  5. Files read 3+ times in one session: data/ai_plans.json 22x (22 by subagents)
     → Each subagent starts empty and reads the same file again. Pass the needed part in the subagent prompt instead
       of telling it to read the file.
```

## What is in your context right now

```
$ token-diet now
Context now: 327k tokens (last request)
    ~265k   81%  Messages
      ~105k   32%  agent's replies and tool calls
       ~34k   10%  PowerShell output
       ~33k   10%  Bash output
       ~29k    9%  Read output
       ~17k    5%  your messages
     ~27k    8%  System tools
     ~12k    4%  MCP tools
     ~11k    3%  System prompt
    ~6.0k    2%  Skills
    ~2.6k    1%  Memory files

What to cut in this context
  1. Messages are 81% of a 327k context, re-sent with every request.
     → Run /compact with a one-line note of what you are doing (it keeps a summary), or /clear when you move to another task.
```

## Which model for which work

```
$ token-diet models
Models, last 7 days: $685 at API list prices
  claude-opus-5-5        session       3967   1.0B   2.9M   $308  45%
  claude-fable-5-1       session       1321 307.6M   1.4M   $202  30%
  claude-opus-5-5        subagent      2122 197.1M   1.0M   $100  15%
  ...
Where a cheaper model would likely do
  1. x-agent ran 52x as a general-purpose subagent on claude-opus-5-5, but .claude/agents/x-agent.md asks for model: sonnet.  -$21.14
     → Spawn it as its own agent type (subagent_type "x-agent"), not "read .claude/agents/x-agent.md and follow it".
  2. 3 subagents on opus only searched and read files ($6.80). On claude-haiku-5-5: $0.24.  -$6.55
```

Each session and subagent is sorted by what its tool calls show: searching and reading, running commands, editing code, or
mixed. Search goes to Haiku (subagents) or Sonnet (sessions), commands to Sonnet, Fable outside coding to Opus; code editing
keeps its model. Costs use Anthropic list prices; on a subscription they show how fast each model draws down your limits.
These are suggestions from the shape of the work, not a quality check: try the cheaper model on a few runs first.

## Make it automatic

```
npx token-diet install
```

Adds two Claude Code hooks to `~/.claude/settings.json` (`--here` for this project only, `token-diet uninstall` removes them):

- **Compact reminder.** When a session's context passes 150k tokens you get a one-line note to run `/compact`, again every
  +50k, not on every message. Only you can run `/compact`, but on a week of real sessions compacting at 150k would have cut
  input tokens by about half.
- **Output clip.** A Bash or PowerShell output over 16k characters (~4k tokens) is saved to `~/.claude/token-diet/out/` and
  the agent sees the first 60 and last 60 lines plus the file path, so it can grep the rest only if it needs it. End a
  command with `# full` to keep the whole output. Saved outputs are deleted after 7 days.

Limits live in `~/.claude/token-diet/config.json`: `compactAt`, `every`, `clipChars`, `headLines`, `tailLines`. The hook
script is copied next to it, so it keeps working without the npm package, and any error in it means "no change".

## Commands

```
token-diet                    context files + the last 7 days of sessions in this project
token-diet context            only the instruction files and MCP servers loaded every session
token-diet sessions           one line per session: requests, tokens, cache share, start and peak context
token-diet session <id>       one session in detail (an id prefix is enough)
token-diet now                what fills the context of your latest session (like /context), and what to cut
token-diet all                every project on this machine, biggest token users first
token-diet models             model per kind of work, API cost, cheaper-model suggestions (--all: every project)
token-diet install            add the hooks above (--here: this project only, --no-clip: reminder only)
token-diet uninstall          remove them

--days <n>   look back n days (default 7)     --project <dir>   another project
--json       machine-readable output          --no-color
```

## How the numbers are made

- Per-request token counts (input, cache writes, cache reads, output) are the API usage that Claude Code writes into its
  transcripts, deduplicated per message. Subagent transcripts are included.
- The size of a single file or tool output is estimated at ~4 characters per token and shown with `~`.
- "Re-sent" is size x the number of later requests in the same session before the next compaction: the output stayed in
  context and went with each of them (mostly as cache reads, which are cheaper but still count).
- Tool-definition shares come from the request shape newer Claude Code versions log; they are shares of characters, not tokens.
- `now` splits the context like Claude Code's /context view. The two anchors are real usage: the first request (system prompt,
  tools, skills, memory files: the fixed part) and the last request (everything). Messages = last - fixed, then split by tool
  output, your messages, the agent's replies and reminders by characters. On a 312k-token session it landed within a few k of
  /context per category.

Codex CLI and other agents: instruction files (AGENTS.md, GEMINI.md, Cursor and Copilot rules) are audited; session analysis is
Claude Code only for now. Pull requests welcome.

## Related

- [ai-limits](https://github.com/congptvinadic-debug/ai-limits): what each AI coding plan actually allows, `npx ai-limits claude`.
- How much usage each plan gives, with sources: [getstackversus.com/limits](https://getstackversus.com/limits).

MIT license.
