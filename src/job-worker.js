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
  async process(job) {
    const d = this.definition;
    let outcome = 'applied';
    if (!d.accepts(job, this.config)) outcome = 'configuration_error';
    else if (Date.parse(job.expiresAt) <= this.clock() + 5500) outcome = 'retry';
    else try { await this.transport[d.apply](job); } catch (error) {
      outcome = d.outcomes.includes(error?.code) ? error.code : 'retry';
    }
    if (outcome === 'configuration_error') this.configurationFailed(job.id);
    // A late external response is never acknowledged as a current success.
    if (Date.parse(job.expiresAt) <= this.clock()) return;
    try { await this.api[d.ack](job, outcome); }
    catch (error) { if (error?.status !== 409) throw error; return; }
    // A stale acknowledgement cannot clear a current failure.
    if (d.recovered.includes(outcome) && this.configurationFailures.delete(job.id)
      && !this.configurationFailures.size && !this.configurationOverflow) this.log(`${d.kind}_configuration_recovered`);
    if (outcome === 'retry' && outcome !== this.lastFailure) this.log(`${d.kind}_retry`);
    this.lastFailure = outcome === 'applied' ? null : outcome;
  }
  async run() {
    const d = this.definition;
    try {
      const jobs = await this.api[d.claim]();
      const byUser = new Map();
      for (const job of jobs) {
        if (!byUser.has(job.discordUserId)) byUser.set(job.discordUserId, []);
        byUser.get(job.discordUserId).push(job);
      }
      const groups = [...byUser.values()]; let next = 0, apiFailed = false;
      // Never overlap roles for one user. A failed ack stops new work, while all
      // already running requests settle before this tick releases single-flight.
      await Promise.all(Array.from({ length: Math.min(d.concurrency, groups.length) }, async () => {
        while (!this.stopped && !apiFailed && next < groups.length) {
          for (const job of groups[next++]) {
            if (this.stopped || apiFailed) break;
            try { await this.process(job); } catch { apiFailed = true; break; }
          }
        }
      }));
      if (apiFailed) throw new Error('Reconciliation acknowledgement unavailable');
      this.lastSuccess = this.clock(); if (this.failed) this.log(`${d.kind}_api_recovered`); this.failed = false;
    } catch { if (!this.failed) this.log(`${d.kind}_api_unavailable`); this.failed = true; }
  }
}
