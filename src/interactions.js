import { MessageFlags, PermissionFlagsBits, ButtonStyle, ComponentType } from 'discord.js';
import { safeLog } from './safe-log.js';
export const LINK_BUTTON = 'passport:link:v1';
const noMentions = { parse: [] };
export const panelMessage = () => ({ content: '아래 버튼을 눌러 u-saint 연동을 진행해주세요',
  allowedMentions: noMentions, components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Primary, custom_id: LINK_BUTTON, label: 'u-saint 연동하기' }] }] });
export class InteractionHandler {
  constructor(config, api, panel, { clock = Date.now, log = safeLog } = {}) { this.config = config; this.api = api; this.panel = panel; this.clock = clock; this.log = log; this.cooldowns = new Map(); this.settingUp = false; }
  async handle(interaction) {
    const setup = interaction.isChatInputCommand() && interaction.commandName === 'passport' && interaction.options.getSubcommand() === 'setup';
    const link = interaction.isButton() && interaction.customId === LINK_BUTTON;
    if (!setup && !link) return;
    const reply = content => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: noMentions });
    try {
      if (interaction.guildId !== this.config.guildId || interaction.channelId !== this.config.channelId || interaction.user.bot)
        return await reply('지정된 서버의 인증 채널에서 이용해 주세요.');
      if (setup) {
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return await reply('서버 관리 권한이 필요합니다.');
        if (this.settingUp) return await reply('인증 안내를 갱신하는 중입니다.');
        this.settingUp = true;
        try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await this.panel.publish(); await interaction.editReply({ content: '지정된 채널의 인증 안내를 준비했습니다.', allowedMentions: noMentions }); }
        finally { this.settingUp = false; }
        return;
      }
      // Accept only a button on a message authored by this bot in the configured channel.
      if (interaction.message?.author?.id !== interaction.client.user?.id) return await reply('인증 안내를 확인할 수 없습니다. 관리자에게 문의해 주세요.');
      const now = this.clock();
      for (const [key, expiry] of this.cooldowns) if (expiry <= now) this.cooldowns.delete(key);
      if (this.cooldowns.has(interaction.user.id) || this.cooldowns.size >= 10000) return await reply('잠시 후 다시 눌러 주세요.');
      this.cooldowns.set(interaction.user.id, now + 10000);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await this.api.createLink({ discordUserId: interaction.user.id, guildId: interaction.guildId,
        discordUsername: interaction.user.username, interactionId: interaction.id });
      await interaction.editReply({ content: '', allowedMentions: noMentions,
        components: [{ type: ComponentType.ActionRow, components: [{ type: ComponentType.Button, style: ButtonStyle.Link, label: 'u-saint 연동하기', url: result.url }] }] });
    } catch (error) {
      this.log(setup ? 'setup_failed' : 'interaction_failed');
      const content = error?.code === 'discord_already_linked' ? '이미 usaint 계정과 연결된 Discord 계정입니다. 오류라고 생각되시면 관리자에게 문의해주세요.' : '인증 요청을 처리하지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의해 주세요.';
      try { if (interaction.deferred || interaction.replied) await interaction.editReply({ content, components: [], allowedMentions: noMentions }); else await reply(content); } catch { /* Never log interaction tokens or Discord payloads. */ }
    }
  }
}
