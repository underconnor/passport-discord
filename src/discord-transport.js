import { PermissionFlagsBits, Routes } from 'discord.js';
export const REST_OPTIONS = Object.freeze({ version: '10', timeout: 5000, retries: 0, rejectOnRateLimit: () => true });
const MANAGE_ROLES = PermissionFlagsBits.ManageRoles, ADMIN = PermissionFlagsBits.Administrator;
export class RoleError extends Error { constructor(code) { super('Discord role operation failed'); this.code = code; } }
function apiFailure(error) {
  if (error?.status === 404 && error?.code === 10007) return new RoleError('member_absent');
  if (error?.status === 403 || (error?.status === 404 && [10004, 10011].includes(error?.code))) return new RoleError('configuration_error');
  return new RoleError('retry');
}
export function rolePermissions(roles, member, config) {
  const target = roles.find(role => role.id === config.roleId);
  const own = roles.filter(role => role.id === config.guildId || member.roles.includes(role.id));
  let permissions = 0n; for (const role of own) permissions |= BigInt(role.permissions);
  const highest = Math.max(...own.map(role => role.position));
  // Strictly lower is conservative even when role positions tie.
  if (!target || target.id === config.guildId || target.managed || highest <= target.position || !(permissions & (MANAGE_ROLES | ADMIN))) throw new RoleError('configuration_error');
  return target;
}
export class DiscordTransport {
  constructor(rest, config, botUserId, clock = Date.now) { this.rest = rest; this.config = config; this.botUserId = botUserId; this.clock = clock; }
  async apply(job) {
    if (job.guildId !== this.config.guildId || job.roleId !== this.config.roleId) throw new RoleError('configuration_error');
    const remaining = () => Date.parse(job.expiresAt) - this.clock();
    const signal = () => { if (remaining() <= 5500) throw new RoleError('retry'); return AbortSignal.timeout(Math.min(5000, remaining() - 500)); };
    let checkingTarget = false;
    try {
      const [roles, own] = await Promise.all([
        this.rest.get(Routes.guildRoles(job.guildId), { signal: signal() }),
        this.rest.get(Routes.guildMember(job.guildId, this.botUserId), { signal: signal() }),
      ]);
      rolePermissions(roles, own, this.config);
      checkingTarget = true;
      const member = await this.rest.get(Routes.guildMember(job.guildId, job.discordUserId), { signal: signal() });
      if (!Array.isArray(member.roles)) throw new RoleError('retry');
      const hasRole = member.roles.includes(job.roleId);
      if (hasRole === job.desired) return;
      const route = Routes.guildMemberRole(job.guildId, job.discordUserId, job.roleId);
      // Modify only the managed role, never replace a member's full roles array.
      const options = { signal: signal(), reason: 'Passport verification reconciliation' };
      if (job.desired) await this.rest.put(route, options); else await this.rest.delete(route, options);
    } catch (error) {
      const failure = error instanceof RoleError ? error : apiFailure(error);
      if (failure.code === 'member_absent' && !checkingTarget) throw new RoleError('configuration_error');
      if (failure.code === 'member_absent' && !job.desired) return;
      throw failure;
    }
  }
}
