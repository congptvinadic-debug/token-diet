---
name: check
description: Show where this Claude Code session's tokens go and what to cut (token-diet now / models / sessions). Use when the user asks about token usage, context size, cost per model, or how to spend fewer tokens.
argument-hint: "[now|models|sessions|context|all]"
---

Run token-diet and report what it says, in the user's language, in a few lines: the biggest item and the one fix to make first.

```bash
node "${CLAUDE_PLUGIN_ROOT}/bin/token-diet.js" <subcommand> --no-color
```

Subcommand: $ARGUMENTS (use `now` if that is empty). `models` shows cost by model and where a cheaper one would do; `sessions` lists recent sessions; `all` covers every project.
Do not paste the whole output back: it is already in the context once.
