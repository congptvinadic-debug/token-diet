import { homedir } from 'node:os';
import { join } from 'node:path';

// Rough token estimate: ~4 characters per token for English prose and code. Every number built on this is shown with "~".
export const estTokens = (chars) => Math.ceil(chars / 4);

export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// Claude Code stores a project's sessions under ~/.claude/projects/<cwd with every non-alphanumeric character replaced by "-">.
export const projectSlug = (cwd) => cwd.replace(/[^A-Za-z0-9]/g, '-');

export function fmt(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '-');

export function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
