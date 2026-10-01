import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { panelMessage } from './interactions.js';
export class DiscordPanel {
  constructor(client, config, store) { this.client = client; this.config = config; this.store = store; }
  async publish() {
    const channel = await this.client.channels.fetch(this.config.channelId, { force: true });
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== this.config.guildId
      || !channel.permissionsFor(this.client.user)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory])) throw new Error('panel_configuration_invalid');
    const previous = await this.store.get();
    let message;
    if (previous) {
      try { message = await channel.messages.fetch(previous); }
      catch (error) { if (error.code !== 10008) throw new Error('panel_unavailable'); }
      if (message && message.author.id !== this.client.user.id) throw new Error('panel_configuration_invalid');
    }
    if (message) await message.edit(panelMessage());
    else {
      message = await channel.send({ ...panelMessage(), nonce: this.config.channelId, enforceNonce: true });
      await this.store.set(message.id);
    }
  }
}
