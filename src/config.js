import { readFileSync, statSync } from 'node:fs';

export const snowflake = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;
export function secret(env, name) {
  const file = env[`${name}_FILE`];
  if (file && env[name]) throw new Error('configuration_invalid');
  let value = env[name];
  if (file) {
    try { if (!statSync(file).isFile() || statSync(file).size > 8192) throw new Error(); value = readFileSync(file, 'utf8').trim(); }
    catch { throw new Error('configuration_invalid'); }
  }
  if (typeof value !== 'string' || value.length < 32 || value.length > 512 || /\s/.test(value)) throw new Error('configuration_invalid');
  return value;
}
export function configFromEnv(env = process.env) {
  const names = ['DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID', 'DISCORD_MEMBER_ROLE_ID', 'DISCORD_SETUP_CHANNEL_ID'];
  if (names.some(name => !snowflake(env[name])) || env.DISCORD_GUILD_ID === env.DISCORD_MEMBER_ROLE_ID) throw new Error('configuration_invalid');
  const allowInsecure = env.PASSPORT_ALLOW_INSECURE_HTTP === 'true';
  const endpoint = value => {
    let url; try { url = new URL(value); } catch { throw new Error('configuration_invalid'); }
    if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (allowInsecure && url.protocol === 'http:'))) throw new Error('configuration_invalid');
    return url;
  };
  const api = endpoint(env.PASSPORT_API_BASE_URL), web = endpoint(env.PASSPORT_WEB_ORIGIN);
  if (web.pathname !== '/') throw new Error('configuration_invalid');
  if (!api.pathname.endsWith('/')) api.pathname += '/';
  const port = Number(env.PORT ?? 3102);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('configuration_invalid');
  const discordToken = secret(env, 'DISCORD_TOKEN'), apiToken = secret(env, 'PASSPORT_DISCORD_SERVICE_TOKEN');
  if (discordToken === apiToken || (env.API_SERVICE_TOKEN && env.API_SERVICE_TOKEN === apiToken)) throw new Error('configuration_invalid');
  return Object.freeze({ applicationId: env.DISCORD_APPLICATION_ID, guildId: env.DISCORD_GUILD_ID,
    roleId: env.DISCORD_MEMBER_ROLE_ID, channelId: env.DISCORD_SETUP_CHANNEL_ID,
    discordToken, apiToken, apiBase: api.href, webOrigin: web.origin,
    stateFile: env.PASSPORT_STATE_FILE ?? '/data/panel.json', host: env.BIND_HOST ?? '127.0.0.1', port });
}
