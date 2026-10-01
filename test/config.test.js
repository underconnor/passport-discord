import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFromEnv, secret, snowflake } from '../src/config.js';
import { safeLog } from '../src/safe-log.js';
export const env = { DISCORD_APPLICATION_ID: '100000000000000001', DISCORD_GUILD_ID: '100000000000000002', DISCORD_MEMBER_ROLE_ID: '100000000000000003', DISCORD_SETUP_CHANNEL_ID: '100000000000000004', DISCORD_TOKEN: 'synthetic-discord-'.repeat(3), PASSPORT_DISCORD_SERVICE_TOKEN: 'synthetic-passport-'.repeat(3), PASSPORT_API_BASE_URL: 'https://api.example.test', PASSPORT_WEB_ORIGIN: 'https://portal.example.test' };
test('valid config normalizes origin, enforces independent credentials and uint64 IDs', () => {
  assert.equal(configFromEnv(env).apiBase, 'https://api.example.test/');
  for (const changes of [{ DISCORD_GUILD_ID: '0' }, { DISCORD_GUILD_ID: '18446744073709551616' }, { DISCORD_MEMBER_ROLE_ID: env.DISCORD_GUILD_ID }, { PASSPORT_DISCORD_SERVICE_TOKEN: env.DISCORD_TOKEN }, { API_SERVICE_TOKEN: env.PASSPORT_DISCORD_SERVICE_TOKEN }, { DISCORD_TOKEN: 'raw-secret\nheader' }, { PASSPORT_NICKNAME_STATE_FILE: '/data/panel.json' }]) assert.throws(() => configFromEnv({ ...env, ...changes }), /configuration_invalid/);
  assert.ok(snowflake('18446744073709551615')); assert.ok(!snowflake('001'));
});
test('HTTPS required except explicit isolated opt-in; userinfo, query and web paths rejected', () => {
  for (const url of ['http://api.example', 'https://user:secret@api.example', 'https://api.example?secret=x', 'file:///tmp/a']) assert.throws(() => configFromEnv({ ...env, PASSPORT_API_BASE_URL: url }));
  assert.equal(configFromEnv({ ...env, PASSPORT_API_BASE_URL: 'http://127.0.0.1:1', PASSPORT_ALLOW_INSECURE_HTTP: 'true' }).apiBase, 'http://127.0.0.1:1/');
  assert.throws(() => configFromEnv({ ...env, PASSPORT_WEB_ORIGIN: 'https://portal.example/path' }));
});
test('secret files work without ambiguous overrides or exposing file contents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'passport-discord-secret-test-')); const file = join(dir, 'token');
  try { writeFileSync(file, 'synthetic-file-secret-'.repeat(3)+'\n', { mode: 0o600 }); assert.equal(secret({ TOKEN_FILE: file }, 'TOKEN'), 'synthetic-file-secret-'.repeat(3)); assert.throws(() => secret({ TOKEN: 'x'.repeat(40), TOKEN_FILE: file }, 'TOKEN')); }
  finally { rmSync(dir, { recursive: true }); }
});
test('logging emits allowlisted event names only', () => {
  const lines = []; safeLog('sensitive-token-from-an-error', line => lines.push(line));
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['at', 'event']); assert.ok(!lines[0].includes('sensitive-token'));
});
