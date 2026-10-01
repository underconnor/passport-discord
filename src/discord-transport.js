import { PermissionFlagsBits, Routes } from 'discord.js';
import { managedRole, snowflake } from './config.js';
import { nickname } from './api.js';
export const REST_OPTIONS = Object.freeze({ version: '10', timeout: 5000, retries: 0, rejectOnRateLimit: () => true });
const MANAGE_ROLES = PermissionFlagsBits.ManageRoles, MANAGE_NICKNAMES = PermissionFlagsBits.ManageNicknames, ADMIN = PermissionFlagsBits.Administrator;
export class RoleError extends Error { constructor(code) { super('Discord reconciliation failed'); this.code = code; } }
function apiFailure(error) {
  if (error?.status === 404 && error?.code === 10007) return new RoleError('member_absent');
  if (error?.status === 403 || error?.status === 400 || (error?.status === 404 && [10004, 10011].includes(error?.code))) return new RoleError('configuration_error');
  return new RoleError('retry');
}
function memberRoles(roles, member, guildId) {
  if (!Array.isArray(roles) || !Array.isArray(member?.roles) || !roles.some(role => role.id === guildId)
    || member.roles.some(id => !roles.some(role => role.id === id))) throw new RoleError('retry');
  return roles.filter(role => role.id === guildId || member.roles.includes(role.id));
}
function ownPermissions(roles, member, guildId) {
  const own = memberRoles(roles, member, guildId);
  let permissions = 0n; for (const role of own) permissions |= BigInt(role.permissions);
  return { permissions, highest: Math.max(...own.map(role => role.position)) };
}
export function rolePermissions(roles, member, config, roleId) {
  const target = roles.find(role => role.id === roleId);
  const { permissions, highest } = ownPermissions(roles, member, config.guildId);
  // Strictly lower is conservative even when role positions tie.
  if (!target || target.id === config.guildId || target.managed || highest <= target.position || !(permissions & (MANAGE_ROLES | ADMIN))) throw new RoleError('configuration_error');
  return target;
}
export function nicknamePermissions(roles, own, member, guild, config, botUserId, userId) {
  const { permissions, highest } = ownPermissions(roles, own, config.guildId);
  if (!(permissions & (MANAGE_NICKNAMES | ADMIN))) throw new RoleError('configuration_error');
  if (!snowflake(guild?.owner_id)) throw new RoleError('retry');
  const targetRoles = memberRoles(roles, member, config.guildId);
  if (userId === guild.owner_id || userId === botUserId || highest <= Math.max(...targetRoles.map(role => role.position))) throw new RoleError('not_manageable');
}
export class DiscordTransport {
  constructor(rest, config, botUserId, clock = Date.now, nicknameStore = null) {
    this.rest = rest; this.config = config; this.botUserId = botUserId; this.clock = clock; this.nicknameStore = nicknameStore;
  }
  signal(job) {
    const remaining = Date.parse(job.expiresAt) - this.clock();
    if (!Number.isFinite(remaining) || remaining <= 5500) throw new RoleError('retry');
    return AbortSignal.timeout(Math.min(5000, remaining - 500));
  }
  async apply(job) {
    if (job.guildId !== this.config.guildId || job.authorization?.guildId !== this.config.guildId || !managedRole(job.authorization, job.roleId)) throw new RoleError('configuration_error');
    let checkingTarget = false;
    try {
      const [roles, own] = await Promise.all([
        this.rest.get(Routes.guildRoles(job.guildId), { signal: this.signal(job) }),
        this.rest.get(Routes.guildMember(job.guildId, this.botUserId), { signal: this.signal(job) }),
      ]);
      rolePermissions(roles, own, this.config, job.roleId);
      checkingTarget = true;
      const member = await this.rest.get(Routes.guildMember(job.guildId, job.discordUserId), { signal: this.signal(job) });
      if (!Array.isArray(member.roles)) throw new RoleError('retry');
      const hasRole = member.roles.includes(job.roleId);
      if (hasRole === job.desired) return;
      const route = Routes.guildMemberRole(job.guildId, job.discordUserId, job.roleId);
      // Modify only this allowlisted role, never replace a member's roles array.
      const options = { signal: this.signal(job), reason: 'Passport verification reconciliation' };
      if (job.desired) await this.rest.put(route, options); else await this.rest.delete(route, options);
    } catch (error) {
      const failure = error instanceof RoleError ? error : apiFailure(error);
      if (failure.code === 'member_absent' && !checkingTarget) throw new RoleError('configuration_error');
      if (failure.code === 'member_absent' && !job.desired) return;
      throw failure;
    }
  }
  async nicknameState(method, ...args) {
    if (!this.nicknameStore) throw new RoleError('configuration_error');
    try { return await this.nicknameStore[method](...args); }
    catch { throw new RoleError('configuration_error'); }
  }
  async applyNickname(job) {
    if (job.guildId !== this.config.guildId || job.authorization?.contractVersion !== 2 || job.authorization.guildId !== this.config.guildId
      || (!job.authorization.nicknameEnabled && job.nickname !== null) || !nickname(job.nickname)) throw new RoleError('configuration_error');
    const previous = await this.nicknameState('get', job.discordUserId);
    // A release without evidence that this bot managed a nickname is a no-op.
    if (job.nickname === null && !previous) return;
    let checkingTarget = false;
    try {
      const [roles, own, guild] = await Promise.all([
        this.rest.get(Routes.guildRoles(job.guildId), { signal: this.signal(job) }),
        this.rest.get(Routes.guildMember(job.guildId, this.botUserId), { signal: this.signal(job) }),
        this.rest.get(Routes.guild(job.guildId), { signal: this.signal(job) }),
      ]);
      checkingTarget = true;
      const member = await this.rest.get(Routes.guildMember(job.guildId, job.discordUserId), { signal: this.signal(job) });
      const current = member.nick ?? null;
      if (!nickname(current)) throw new RoleError('retry');
      if (job.nickname === null && current !== previous.managedNickname) {
        // An operator/member changed it since our last write. Preserve their value.
        await this.nicknameState('set', job.discordUserId, null); return;
      }
      if (job.nickname !== null && current === job.nickname) {
        // A pre-existing matching nickname is not evidence that we own it.
        if (previous && previous.managedNickname !== current) await this.nicknameState('set', job.discordUserId, null);
        else if (previous?.phase === 'pending') await this.nicknameState('set', job.discordUserId, { ...previous, phase: 'managed' });
        return;
      }
      nicknamePermissions(roles, own, member, guild, this.config, this.botUserId, job.discordUserId);
      const desired = job.nickname === null ? previous.originalNickname : job.nickname;
      const original = previous && previous.managedNickname === current ? previous.originalNickname : current;
      if (job.nickname !== null) await this.nicknameState('set', job.discordUserId, { originalNickname: original, managedNickname: desired, phase: 'pending' });
      let patchStarted = false;
      try {
        const options = { body: { nick: desired }, signal: this.signal(job), reason: 'Passport verified identity nickname' };
        patchStarted = true;
        const updated = await this.rest.patch(Routes.guildMember(job.guildId, job.discordUserId), options);
        if ((updated?.nick ?? null) !== desired) throw new RoleError('retry');
      } catch (error) {
        // A definitive rejection never transfers ownership to us. A timeout may
        // have applied remotely, so retain the pending restoration journal.
        if (job.nickname !== null && (!patchStarted || [400, 403, 404].includes(error?.status))) await this.nicknameState('set', job.discordUserId, previous);
        throw error;
      }
      if (job.nickname === null) await this.nicknameState('set', job.discordUserId, null);
      else await this.nicknameState('set', job.discordUserId, { originalNickname: original, managedNickname: desired, phase: 'managed' });
    } catch (error) {
      const failure = error instanceof RoleError ? error : apiFailure(error);
      if (failure.code === 'member_absent' && !checkingTarget) throw new RoleError('configuration_error');
      if (failure.code === 'member_absent' && job.nickname === null) await this.nicknameState('set', job.discordUserId, null);
      throw failure;
    }
  }
}
