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

export function install({ projectCwd = null, clip = true } = {}) {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const script = path.join(HOME_DIR, 'hook.mjs');
  fs.copyFileSync(new URL('./hook.js', import.meta.url), script);
  const cfgFile = path.join(HOME_DIR, 'config.json');
  if (!fs.existsSync(cfgFile)) fs.writeFileSync(cfgFile, JSON.stringify(DEFAULTS, null, 2) + '\n');

  const file = settingsPath(projectCwd);
  const settings = strip(readJson(file));
  const cmd = (mode) => `node "${script.replace(/\\/g, '/')}" ${mode}`;
  settings.hooks = settings.hooks || {};
  (settings.hooks.UserPromptSubmit = settings.hooks.UserPromptSubmit || []).push({ hooks: [{ type: 'command', command: cmd('prompt'), timeout: 10 }] });
  (settings.hooks.Stop = settings.hooks.Stop || []).push({ hooks: [{ type: 'command', command: cmd('stop'), timeout: 10 }] });
  if (clip)
    (settings.hooks.PostToolUse = settings.hooks.PostToolUse || []).push({
      matcher: 'Bash|PowerShell',
      hooks: [{ type: 'command', command: cmd('clip'), timeout: 10 }],
    });
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
