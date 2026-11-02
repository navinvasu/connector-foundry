// Connector Foundry server — real backend for the end-to-end prototype.
// Control plane + data plane in one Express process (PostgreSQL); the route
// modules map 1:1 onto the future Lambda function groups
// (see backend/functions/README.md).
// Local DB:  docker compose up -d in projects/connector-foundry/backend
// Prod DB:   Amazon RDS PostgreSQL — only DATABASE_URL changes.

import 'dotenv/config';
import { applySchema, pool } from './db.js';
import { logger } from './logger.js';
import { startWorker } from './queue.js';
import { startDriftSweeper } from './drift.js';
import { createApp } from './app.js';
import { assertBrokerBoot } from './broker/index.js';
import { assertProductionConfig, logResolvedConfig } from './boot-guards.js';

const app = createApp();
const PORT = Number(process.env.PORT ?? 4000);

async function main() {
  // AB-02: refuse to boot with a dev vault key in production — a static
  // local KEK in prod would silently downgrade the whole credential vault.
  assertBrokerBoot();
  // SE-07: same refusal for dev auth / dev signing secret / missing
  // Cognito client id in production, and one log line naming the modes.
  assertProductionConfig();
  logResolvedConfig();
  await applySchema();
  startWorker();
  startDriftSweeper(); // TE-03: schedule drift checks against prod releases
  app.listen(PORT, () => {
    logger.info({ msg: 'listening', port: PORT });
  });
}

main().catch((e) => {
  logger.error({ msg: 'failed to start', error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT', async () => { await pool.end(); process.exit(0); });
