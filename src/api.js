import { snowflake } from './config.js';
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const version = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;
export const nickname = value => value === null || (typeof value === 'string' && [...value].length >= 1 && [...value].length <= 32 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value));
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const safeCodes = new Set(['discord_already_linked', 'discord_guild_mismatch', 'discord_link_expired', 'discord_link_consumed', 'rate_limited', 'discord_lease_stale', 'discord_interaction_consumed', 'discord_settings_changed']);
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
  async requestJson(path, body) {
    try {
      const response = await this.request(new URL(path, this.config.apiBase), {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${this.config.apiToken}`, Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (response.status === 204) return undefined;
      const data = await boundedJson(response);
      if (!response.ok) throw new ApiError(response.status, data?.code);
      return data;
    } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(); }
  }
  async post(path, body) { return this.requestJson(path, body); }
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
  async configuration() {
    const value = await this.requestJson('v2/discord/config');
    if (!value || value.contractVersion !== 2 || value.guildId !== this.config.guildId || !version(value.settingsRevision)
      || typeof value.nicknameEnabled !== 'boolean' || !Array.isArray(value.managedRoleIds) || value.managedRoleIds.length > 256
      || new Set(value.managedRoleIds).size !== value.managedRoleIds.length
      || value.managedRoleIds.some(role => !snowflake(role) || role === this.config.guildId)) throw new ApiError();
    return Object.freeze({ contractVersion: 2, settingsRevision: value.settingsRevision, guildId: value.guildId,
      managedRoleIds: Object.freeze([...value.managedRoleIds]), nicknameEnabled: value.nicknameEnabled });
  }
  async claimStream(stream) {
    // Bind each returned job to the exact, validated settings used to claim it.
    // Role and nickname workers may fetch different revisions concurrently.
    const authorization = await this.configuration();
    const result = await this.post(`v2/discord/${stream}/claim`, {
      contractVersion: 2, guildId: this.config.guildId, settingsRevision: authorization.settingsRevision, limit: 2,
    });
    if (!result || result.contractVersion !== 2 || !Array.isArray(result.jobs) || result.jobs.length > 2) throw new ApiError();
    const ids = new Set();
    for (const job of result.jobs) {
      const expiry = Date.parse(job.expiresAt);
      if (!uuid(job.id) || ids.has(job.id) || !opaque(job.leaseToken) || !snowflake(job.guildId)
        || !snowflake(job.discordUserId) || !version(job.version)
        || !Number.isFinite(expiry) || expiry <= this.clock() || expiry > this.clock() + 65000) throw new ApiError();
      if (stream === 'roles') {
        if (!snowflake(job.roleId) || typeof job.desired !== 'boolean' || !['verification', 'member', 'semester'].includes(job.kind)
          || !(job.semester === null || (typeof job.semester === 'string' && /^\d{2}-[12]$/.test(job.semester)))
          || ((job.kind === 'semester') !== (job.semester !== null))) throw new ApiError();
      } else if (!nickname(job.nickname)) throw new ApiError();
      ids.add(job.id);
    }
    return result.jobs.map(job => Object.freeze({ ...job, authorization }));
  }
  async claim() { return this.claimStream('roles'); }
  async claimNicknames() { return this.claimStream('nicknames'); }
  async ackStream(stream, job, outcome) {
    const outcomes = ['applied', 'retry', 'member_absent', 'configuration_error'];
    if (stream === 'nicknames') outcomes.push('not_manageable');
    if (!uuid(job.id) || !opaque(job.leaseToken) || !version(job.version) || !outcomes.includes(outcome)) throw new ApiError();
    return this.post(`v2/discord/${stream}/${job.id}/ack`, { contractVersion: 2, leaseToken: job.leaseToken, version: job.version, outcome });
  }
  async ack(job, outcome) { return this.ackStream('roles', job, outcome); }
  async ackNickname(job, outcome) { return this.ackStream('nicknames', job, outcome); }
}
