// `token-diet install` / `uninstall`: add or remove the hooks in Claude Code's settings.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULTS, HOME_DIR } from './hook.js';

const MARK = 'token-diet';

export function settingsPath(projectCwd) {
  return projectCwd ? path.join(projectCwd, '.claude', 'settings.local.json') : path.join(os.homedir(), '.claude', 'settings.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw new Error(`cannot parse ${file}: ${e.message}`);
  }
}

// Drop our handlers (and matcher groups left empty) from every event.
function strip(settings) {
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(MARK)) }))
      .filter((g) => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (!Object.keys(hooks).length) delete settings.hooks;
  else settings.hooks = hooks;
  return settings;
}

function write(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.token-diet.bak`);
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
}

// Hook events and the hook.js mode each one runs (the same set the plugin's hooks/hooks.json declares).
const EVENTS = [
  ['UserPromptSubmit', 'prompt'],
  ['Stop', 'stop'],
  ['PostToolUse', 'clip', 'Bash|PowerShell|mcp__.*'],
  ['PreCompact', 'end'],
  ['SessionEnd', 'end'],
  ['SessionStart', 'start', 'startup|clear'],
];

export function install({ projectCwd = null, clip = true, handoff = true } = {}) {
  // The hook files are copied next to the config, with a package.json that marks them as ES modules, so the hooks
  // keep working without the npm package.
  fs.mkdirSync(HOME_DIR, { recursive: true });
  for (const f of ['hook.js', 'handoff.js']) fs.copyFileSync(new URL(`./${f}`, import.meta.url), path.join(HOME_DIR, f));
  fs.writeFileSync(path.join(HOME_DIR, 'package.json'), '{ "type": "module" }\n');
  fs.rmSync(path.join(HOME_DIR, 'hook.mjs'), { force: true }); // 1.0 copied a single hook.mjs
  const script = path.join(HOME_DIR, 'hook.js');
  const cfgFile = path.join(HOME_DIR, 'config.json');
  if (!fs.existsSync(cfgFile)) fs.writeFileSync(cfgFile, JSON.stringify(DEFAULTS, null, 2) + '\n');

  const file = settingsPath(projectCwd);
  const settings = strip(readJson(file));
  settings.hooks = settings.hooks || {};
  for (const [event, mode, matcher] of EVENTS) {
    if (mode === 'clip' && !clip) continue;
    if ((mode === 'end' || mode === 'start') && !handoff) continue;
    const group = { hooks: [{ type: 'command', command: `node "${script.replace(/\\/g, '/')}" ${mode}`, timeout: 10 }] };
    if (matcher) group.matcher = matcher;
    (settings.hooks[event] = settings.hooks[event] || []).push(group);
  }
  write(file, settings);
  return { settings: file, script, config: cfgFile };
}

export function uninstall({ projectCwd = null } = {}) {
  const file = settingsPath(projectCwd);
  if (!fs.existsSync(file)) return { settings: file, removed: false };
  const before = JSON.stringify(readJson(file));
  const settings = strip(JSON.parse(before));
  const removed = JSON.stringify(settings) !== before;
  if (removed) write(file, settings);
  return { settings: file, removed };
}
