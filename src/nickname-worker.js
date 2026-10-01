import { JobWorker } from './job-worker.js';
export class NicknameWorker extends JobWorker {
  constructor(api, transport, config, options) {
    super(api, transport, config, {
      kind: 'nickname', claim: 'claimNicknames', ack: 'ackNickname', apply: 'applyNickname',
      accepts: (job, settings) => job.guildId === settings.guildId && job.authorization?.contractVersion === 2
        && job.authorization.guildId === settings.guildId && (job.authorization.nicknameEnabled || job.nickname === null),
      outcomes: ['member_absent', 'configuration_error', 'not_manageable'],
      recovered: ['applied', 'member_absent', 'not_manageable'],
    }, options);
  }
}
