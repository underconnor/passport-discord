import { mkdir, readFile, rename, writeFile, unlink, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { snowflake } from './config.js';
import { nickname } from './api.js';

const validRecord = record => record && typeof record === 'object' && !Array.isArray(record)
  && Object.keys(record).sort().join(',') === 'managedNickname,originalNickname,phase'
  && nickname(record.originalNickname) && typeof record.managedNickname === 'string' && nickname(record.managedNickname)
  && ['pending', 'managed'].includes(record.phase);

// School names stay in this private state file only while we manage the nickname.
// Save the restoration source before sending an external PATCH so crash/timeout
// recovery cannot accidentally treat our previous nickname as the original.
export class NicknameStore {
  constructor(file, config) { this.file = file; this.guildId = config.guildId; }
  async read() {
    let content;
    try { content = await readFile(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return { version: 1, guildId: this.guildId, records: {} }; throw new Error('nickname_state_unavailable'); }
    try {
      if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error();
      const data = JSON.parse(content);
      if (!data || data.version !== 1 || data.guildId !== this.guildId || !data.records || typeof data.records !== 'object' || Array.isArray(data.records)
        || Object.keys(data).sort().join(',') !== 'guildId,records,version' || Object.keys(data.records).length > 10000
        || Object.entries(data.records).some(([id, record]) => !snowflake(id) || !validRecord(record))) throw new Error();
      return data;
    } catch { throw new Error('nickname_state_invalid'); }
  }
  async get(id) {
    if (!snowflake(id)) throw new Error('nickname_state_invalid');
    return (await this.read()).records[id] ?? null;
  }
  async set(id, value) {
    if (!snowflake(id) || (value !== null && !validRecord(value))) throw new Error('nickname_state_invalid');
    const data = await this.read();
    if (value === null) delete data.records[id];
    else { if (!data.records[id] && Object.keys(data.records).length >= 10000) throw new Error('nickname_state_capacity'); data.records[id] = value; }
    const content = JSON.stringify(data);
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) throw new Error('nickname_state_capacity');
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: 'wx', flush: true });
      await rename(temporary, this.file);
      const parent = await open(dirname(this.file), 'r');
      try { await parent.sync(); } finally { await parent.close(); }
    }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw new Error('nickname_state_unavailable'); }); }
  }
}
