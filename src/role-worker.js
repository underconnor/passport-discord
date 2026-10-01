import { JobWorker } from './job-worker.js';
import { managedRole } from './config.js';
export class RoleWorker extends JobWorker {
  constructor(api, transport, config, options) {
    super(api, transport, config, {
      kind: 'role', claim: 'claim', ack: 'ack', apply: 'apply', concurrency: 2,
      accepts: (job, settings) => job.guildId === settings.guildId && job.authorization?.guildId === settings.guildId && managedRole(job.authorization, job.roleId),
      outcomes: ['member_absent', 'configuration_error'], recovered: ['applied', 'member_absent'],
    }, options);
  }
}
