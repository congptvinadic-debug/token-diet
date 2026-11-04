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

## Commands

```
token-diet                    context files + the last 7 days of sessions in this project
token-diet context            only the instruction files and MCP servers loaded every session
token-diet sessions           one line per session: requests, tokens, cache share, start and peak context
token-diet session <id>       one session in detail (an id prefix is enough)

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

Codex CLI and other agents: instruction files (AGENTS.md, GEMINI.md, Cursor and Copilot rules) are audited; session analysis is
Claude Code only for now. Pull requests welcome.

## Related

- [ai-limits](https://github.com/congptvinadic-debug/ai-limits): what each AI coding plan actually allows, `npx ai-limits claude`.
- How much usage each plan gives, with sources: [getstackversus.com/limits](https://getstackversus.com/limits).

MIT license.
