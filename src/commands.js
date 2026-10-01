import { pathToFileURL } from 'node:url';
import { REST, Routes, PermissionFlagsBits } from 'discord.js';
import { configFromEnv } from './config.js';
import { REST_OPTIONS } from './discord-transport.js';
import { safeLog } from './safe-log.js';
export const command = Object.freeze({ name: 'passport', description: 'Passport 인증 안내 관리',
  default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
  options: [{ type: 1, name: 'setup', description: '지정된 채널에 인증 안내를 게시하거나 갱신합니다' }] });
export async function registerCommands(rest, config) {
  // Create by name updates this command; do not bulk-overwrite unrelated commands.
  await rest.post(Routes.applicationGuildCommands(config.applicationId, config.guildId), { body: command });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--dry-run')) console.log(JSON.stringify(command, null, 2));
  else if (process.argv.includes('--register')) {
    try { const config = configFromEnv(); await registerCommands(new REST(REST_OPTIONS).setToken(config.discordToken), config); safeLog('commands_registered'); }
    catch { safeLog('configuration_invalid'); process.exitCode = 1; }
  } else process.exitCode = 1;
}
