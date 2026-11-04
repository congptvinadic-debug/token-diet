// Shared test setup: a throwaway home directory (so hooks never touch the real ~/.claude) and transcript builders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-diet-test-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CLAUDE_CONFIG_DIR;
  return home;
}

let n = 0;
const ts = () => new Date(Date.UTC(2026, 10, 4, 10, 0, n++)).toISOString();

export const user = (text) => ({ type: 'user', timestamp: ts(), cwd: '/work/app', message: { role: 'user', content: text } });

export const assistant = ({ text = '', tools = [], usage = null, model = 'claude-sonnet-5-5' } = {}) => ({
  type: 'assistant',
  timestamp: ts(),
  requestId: `req_${n}`,
  message: {
    id: `msg_${n}`,
    model,
    role: 'assistant',
    content: [...(text ? [{ type: 'text', text }] : []), ...tools.map(([name, input], i) => ({ type: 'tool_use', id: `tu_${n}_${i}`, name, input }))],
    usage: usage || { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
});

export const toolResult = (id, text) => ({
  type: 'user',
  timestamp: ts(),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
  toolUseResult: { stdout: text, stderr: '' },
});

export const requestShape = (tools) => ({
  type: 'api-request-shape',
  timestamp: ts(),
  shape: { system: [{ type: 'text', text: 'system prompt' }], tools: tools.map(([name, size]) => ({ name, description: 'x'.repeat(size) })) },
});

export function writeTranscript(dir, name, lines) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return file;
}
