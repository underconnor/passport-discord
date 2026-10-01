import { safeLog } from './safe-log.js';
export class RoleWorker {
  constructor(api, transport, config, { clock = Date.now, log = safeLog } = {}) {
    this.api = api; this.transport = transport; this.config = config; this.clock = clock; this.log = log;
    this.pending = null; this.stopped = false; this.failed = false; this.lastSuccess = 0; this.lastRoleFailure = null;
    this.configurationFailures = new Set(); this.configurationOverflow = false;
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.run().finally(() => { this.pending = null; }); return this.pending;
  }
  stop() { this.stopped = true; }
  isHealthy() {
    return !this.stopped && !this.failed && this.lastSuccess > 0 && this.clock() - this.lastSuccess < 120000
      && !this.configurationFailures.size && !this.configurationOverflow;
  }
  configurationFailed(id) {
    if (!this.configurationFailures.size && !this.configurationOverflow) this.log('role_configuration_error');
    if (this.configurationFailures.size < 4096) this.configurationFailures.add(id);
    else if (!this.configurationFailures.has(id)) this.configurationOverflow = true;
  }
  async run() {
    try {
      const jobs = await this.api.claim();
      for (const job of jobs) {
        if (this.stopped) break;
        let outcome = 'applied';
        if (job.guildId !== this.config.guildId || job.roleId !== this.config.roleId) outcome = 'configuration_error';
        else if (Date.parse(job.expiresAt) <= this.clock() + 5500) outcome = 'retry';
        else try { await this.transport.apply(job); } catch (error) {
          outcome = ['member_absent', 'configuration_error'].includes(error?.code) ? error.code : 'retry';
        }
        if (outcome === 'configuration_error') this.configurationFailed(job.id);
        // A late external response is never acknowledged as a current success.
        if (Date.parse(job.expiresAt) <= this.clock()) continue;
        try { await this.api.ack(job, outcome); }
        catch (error) { if (error?.status !== 409) throw error; continue; /* Stale evidence cannot clear a current failure. */ }
        if ((outcome === 'applied' || outcome === 'member_absent') && this.configurationFailures.delete(job.id)
          && !this.configurationFailures.size && !this.configurationOverflow) this.log('role_configuration_recovered');
        if (outcome === 'retry' && outcome !== this.lastRoleFailure) this.log('role_retry');
        this.lastRoleFailure = outcome === 'applied' ? null : outcome;
      }
      this.lastSuccess = this.clock(); if (this.failed) this.log('api_recovered'); this.failed = false;
    } catch { if (!this.failed) this.log('api_unavailable'); this.failed = true; }
  }
}
