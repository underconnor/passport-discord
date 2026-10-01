import { safeLog } from './safe-log.js';

// Each durable stream owns its health and in-flight lease work. A nickname failure
// must never skip or acknowledge a role job, even when both target the same user.
export class JobWorker {
  constructor(api, transport, config, definition, { clock = Date.now, log = safeLog } = {}) {
    this.api = api; this.transport = transport; this.config = config; this.definition = definition; this.clock = clock; this.log = log;
    this.pending = null; this.stopped = false; this.failed = false; this.lastSuccess = 0; this.lastFailure = null;
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
    if (!this.configurationFailures.size && !this.configurationOverflow) this.log(`${this.definition.kind}_configuration_error`);
    if (this.configurationFailures.size < 4096) this.configurationFailures.add(id);
    else if (!this.configurationFailures.has(id)) this.configurationOverflow = true;
  }
  async run() {
    const d = this.definition;
    try {
      const jobs = await this.api[d.claim]();
      for (const job of jobs) {
        if (this.stopped) break;
        let outcome = 'applied';
        if (!d.accepts(job, this.config)) outcome = 'configuration_error';
        else if (Date.parse(job.expiresAt) <= this.clock() + 5500) outcome = 'retry';
        else try { await this.transport[d.apply](job); } catch (error) {
          outcome = d.outcomes.includes(error?.code) ? error.code : 'retry';
        }
        if (outcome === 'configuration_error') this.configurationFailed(job.id);
        // A late external response is never acknowledged as a current success.
        if (Date.parse(job.expiresAt) <= this.clock()) continue;
        try { await this.api[d.ack](job, outcome); }
        catch (error) { if (error?.status !== 409) throw error; continue; }
        // A stale acknowledgement cannot clear a current failure.
        if (d.recovered.includes(outcome) && this.configurationFailures.delete(job.id)
          && !this.configurationFailures.size && !this.configurationOverflow) this.log(`${d.kind}_configuration_recovered`);
        if (outcome === 'retry' && outcome !== this.lastFailure) this.log(`${d.kind}_retry`);
        this.lastFailure = outcome === 'applied' ? null : outcome;
      }
      this.lastSuccess = this.clock(); if (this.failed) this.log(`${d.kind}_api_recovered`); this.failed = false;
    } catch { if (!this.failed) this.log(`${d.kind}_api_unavailable`); this.failed = true; }
  }
}
