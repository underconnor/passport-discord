import { createServer } from 'node:http';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { configFromEnv } from './config.js';
import { PassportApi } from './api.js';
import { DiscordTransport, REST_OPTIONS } from './discord-transport.js';
import { InteractionHandler } from './interactions.js';
import { DiscordPanel } from './panel.js';
import { PanelStore } from './panel-store.js';
import { RoleWorker } from './role-worker.js';
import { safeLog } from './safe-log.js';

let client, worker, server, timer, stopping = false;
async function stop(code = 0) {
  if (stopping) return; stopping = true; safeLog('stopping');
  clearInterval(timer); worker?.stop();
  const deadline = setTimeout(() => process.exit(code), 10000); deadline.unref();
  await worker?.pending?.catch(() => {}); await client?.destroy();
  server?.close(); process.exitCode = code;
}
process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
process.on('unhandledRejection', () => { safeLog('fatal_error'); void stop(1); });
process.on('uncaughtException', () => { safeLog('fatal_error'); void stop(1); });
try {
  const config = configFromEnv(); const api = new PassportApi(config);
  client = new Client({ intents: [GatewayIntentBits.Guilds],
    rest: REST_OPTIONS,
    allowedMentions: { parse: [] } });
  const panel = new DiscordPanel(client, config, new PanelStore(config.stateFile, config));
  const interactions = new InteractionHandler(config, api, panel);
  client.on(Events.InteractionCreate, interaction => void interactions.handle(interaction));
  client.on(Events.Error, () => safeLog('gateway_unavailable'));
  client.on(Events.ShardError, () => safeLog('gateway_unavailable'));
  client.once(Events.ClientReady, ready => {
    if (ready.application.id !== config.applicationId) { safeLog('configuration_invalid'); void stop(1); return; }
    worker = new RoleWorker(api, new DiscordTransport(client.rest, config, ready.user.id), config);
    void worker.tick(); timer = setInterval(() => { if (client.isReady() && !stopping) void worker.tick(); }, 5000); timer.unref();
    safeLog('ready');
  });
  server = createServer((req, res) => {
    if (req.url !== '/healthz' || req.method !== 'GET') { res.writeHead(404).end(); return; }
    const healthy = !stopping && client.isReady() && Boolean(worker?.isHealthy());
    res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ status: healthy ? 'ok' : 'degraded' }));
  });
  server.listen(config.port, config.host);
  await client.login(config.discordToken);
} catch { safeLog('configuration_invalid'); await stop(1); }
