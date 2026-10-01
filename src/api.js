import { snowflake } from './config.js';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const safeCodes = new Set(['discord_already_linked', 'discord_guild_mismatch', 'discord_link_expired', 'discord_link_consumed', 'rate_limited', 'discord_lease_stale', 'discord_interaction_consumed']);
export class ApiError extends Error {
  constructor(status = 0, code = '') { super('Passport API request failed'); this.status = status; this.code = safeCodes.has(code) ? code : 'request_failed'; }
}
async function boundedJson(response) {
  if (!response.body) throw new ApiError(response.status);
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > 131072)) { await response.body.cancel().catch(() => {}); throw new ApiError(response.status); }
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 131072) throw new ApiError(response.status); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
export class PassportApi {
  constructor(config, request = fetch, clock = Date.now) { this.config = config; this.request = request; this.clock = clock; }
  async post(path, body) {
    try {
      const response = await this.request(new URL(path, this.config.apiBase), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${this.config.apiToken}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (response.status === 204) return undefined;
      const data = await boundedJson(response);
      if (!response.ok) throw new ApiError(response.status, data?.code);
      return data;
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(); }
  }
  async createLink(input) {
    if (!snowflake(input.discordUserId) || input.guildId !== this.config.guildId || !snowflake(input.interactionId)
      || typeof input.discordUsername !== 'string' || input.discordUsername.length < 1 || input.discordUsername.length > 80 || /[\x00-\x1f\x7f]/.test(input.discordUsername)) throw new ApiError();
    const result = await this.post('v1/discord/link-sessions', input);
    let url; try { url = new URL(result.url); } catch { throw new ApiError(); }
    const expiry = Date.parse(result.expiresAt);
    if (!uuid(result.id) || url.origin !== this.config.webOrigin || url.username || url.password || url.search
      || url.pathname !== `/discord/link/${result.id}` || !/^#token=[A-Za-z0-9_-]{43}$/.test(url.hash)
      || !Number.isFinite(expiry) || expiry <= this.clock() || expiry > this.clock() + 305000) throw new ApiError();
    return { id: result.id, url: url.href, expiresAt: result.expiresAt };
  }
  async claim() {
    const result = await this.post('v1/discord/roles/claim', { guildId: this.config.guildId, limit: 2 });
    if (!result || !Array.isArray(result.jobs) || result.jobs.length > 2) throw new ApiError();
    const ids = new Set();
    for (const job of result.jobs) {
      const expiry = Date.parse(job.expiresAt);
      if (!uuid(job.id) || ids.has(job.id) || !opaque(job.leaseToken) || !snowflake(job.guildId) || !snowflake(job.roleId)
        || !snowflake(job.discordUserId) || typeof job.desired !== 'boolean' || typeof job.version !== 'string' || !/^[1-9][0-9]{0,18}$/.test(job.version)
        || !Number.isFinite(expiry) || expiry <= this.clock() || expiry > this.clock() + 65000) throw new ApiError();
      ids.add(job.id);
    }
    return result.jobs;
  }
  async ack(job, outcome) {
    if (!uuid(job.id) || !['applied', 'retry', 'member_absent', 'configuration_error'].includes(outcome)) throw new ApiError();
    return this.post(`v1/discord/roles/${job.id}/ack`, { leaseToken: job.leaseToken, version: job.version, outcome });
  }
}
