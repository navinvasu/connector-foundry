// One-shot schema runner: npm run db:init
import 'dotenv/config';
import { applySchema, pool } from './db.js';
import { logger } from './logger.js';

applySchema()
  .then(() => pool.end())
  .then(() => logger.info({ msg: 'schema applied' }))
  .catch((e) => {
    logger.error({ msg: 'schema apply failed', error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
