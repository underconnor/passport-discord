import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { snowflake } from './config.js';
export class PanelStore {
  constructor(file, config) { this.file = file; this.config = config; }
  async get() {
    let raw;
    try { raw = await readFile(this.file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('panel_state_invalid'); }
    try {
      if (raw.length > 4096) throw new Error(); const value = JSON.parse(raw);
      if (value.guildId !== this.config.guildId || value.channelId !== this.config.channelId || !snowflake(value.messageId)) throw new Error();
      return value.messageId;
    } catch { throw new Error('panel_state_invalid'); }
  }
  async set(messageId) {
    if (!snowflake(messageId)) throw new Error('panel_state_invalid');
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify({ guildId: this.config.guildId, channelId: this.config.channelId, messageId }), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
