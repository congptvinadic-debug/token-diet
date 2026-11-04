import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeHome } from './helpers.js';

const home = fakeHome();
const { install, uninstall } = await import('../lib/install.js');
const settingsFile = path.join(home, '.claude', 'settings.json');
const read = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^﻿/, ''));

test('install adds the hooks once, keeps other settings, uninstall removes only ours', () => {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const mine = { matcher: 'Write', hooks: [{ type: 'command', command: 'echo mine' }] };
  fs.writeFileSync(settingsFile, '﻿' + JSON.stringify({ model: 'opus', hooks: { PostToolUse: [mine] } }));

  install();
  install(); // twice: no duplicates
  const s = read();
  assert.equal(s.model, 'opus');
  const cmds = Object.values(s.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(cmds.filter((c) => c.includes('token-diet')).length, 6);
  const clip = s.hooks.PostToolUse.find((g) => g.hooks[0].command.endsWith(' clip'));
  assert.equal(clip.matcher, 'Bash|PowerShell|mcp__.*');
  for (const f of ['hook.js', 'handoff.js', 'package.json', 'config.json']) assert.ok(fs.existsSync(path.join(home, '.claude', 'token-diet', f)), f);

  uninstall();
  assert.deepEqual(read().hooks.PostToolUse, [mine]);
  assert.equal(read().model, 'opus');
});

test('install --no-clip --no-handoff adds only the reminders', () => {
  install({ clip: false, handoff: false });
  const events = Object.keys(read().hooks).filter((e) => read().hooks[e].some((g) => g.hooks[0].command.includes('token-diet')));
  assert.deepEqual(events.sort(), ['Stop', 'UserPromptSubmit']);
  uninstall();
});

test('the plugin hooks.json uses the same clip matcher', () => {
  const plugin = JSON.parse(fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8'));
  assert.equal(plugin.hooks.PostToolUse[0].matcher, 'Bash|PowerShell|mcp__.*');
  for (const groups of Object.values(plugin.hooks)) for (const g of groups) assert.match(g.hooks[0].args[0], /\$\{CLAUDE_PLUGIN_ROOT\}\/lib\/hook\.js/);
});
