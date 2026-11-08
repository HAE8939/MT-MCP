import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';

import { loadConfig } from './config.js';
import { loadEnvFile } from './envFile.js';
import { createHttpApp } from './http/createApp.js';
import { log } from './logger.js';
import { createHubHandler } from './mcp/createHub.js';
import { createTencentCosStore } from './packs/imagebed/cos.js';
import { toolPacks } from './packs/registry.js';
import { SERVICE_NAME } from './version.js';

loadEnvFile(resolve(process.cwd(), '.env'));

const config = loadConfig(process.env);
if (config.tokenIsPlaceholder) {
  log.warn('MCP_AUTH_TOKEN is still the example placeholder. Replace it before colleagues connect.');
}
const cosPlaceholders = new Set(['your-secret-id', 'your-secret-key']);
if (config.cos && (cosPlaceholders.has(config.cos.secretId) || cosPlaceholders.has(config.cos.secretKey))) {
  log.warn('COS credentials are still the example placeholders. Uploads will fail until they are replaced.');
}
for (const pack of toolPacks) {
  if (pack.reservedEnv && process.env[pack.reservedEnv] === 'true' && !pack.enabled(config)) {
    log.warn(`${pack.id} was requested via ${pack.reservedEnv} but is not implemented. No tools were registered.`);
  }
}

const store = config.cos ? createTencentCosStore(config.cos) : null;
const handler = createHubHandler(config, store);
const app = createHttpApp({ config, handler });

const server: Server = createServer(app);
server.listen(config.port, config.host, () => {
  log.info('listening', {
    service: SERVICE_NAME,
    host: config.host,
    port: config.port,
    packs: toolPacks.map((pack) => ({ id: pack.id, enabled: pack.enabled(config) })),
    imagebed: config.cos
      ? { region: config.cos.region, bucket: config.cos.bucket, prefix: config.cos.prefix }
      : null,
  });
});

function shutdown(signal: string): void {
  log.info('shutting down', { signal });
  server.close(() => {
    void handler.close().finally(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
