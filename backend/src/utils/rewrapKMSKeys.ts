/**
 * Operator entry point for the master-key rotation sweep.
 *
 * Procedure:
 *   1. Set MASTER_KEY to the new master key and MASTER_KEY_PREVIOUS to the old one.
 *   2. Run `pnpm kms:rewrap`. Every key is re-wrapped under MASTER_KEY.
 *   3. Once the sweep reports zero failures, remove MASTER_KEY_PREVIOUS.
 */
import { connectDatabase, disconnectDatabase } from '../config/database';
import { env } from '../config/env';
import { kmsService } from '../services/kms.service';
import logger from './logger';

async function main(): Promise<void> {
  await connectDatabase();

  try {
    const summary = await kmsService.rewrapKeysToCurrentMaster(env.KMS_ROTATION_BATCH_SIZE);

    logger.info('KMS master-key re-wrap complete', {
      scanned: summary.scanned,
      rewrapped: summary.rewrapped,
      alreadyCurrent: summary.alreadyCurrent,
      failed: summary.failed.length,
    });

    if (summary.failed.length > 0) {
      logger.error('KMS master-key re-wrap left keys unprocessed; keep MASTER_KEY_PREVIOUS set', {
        failedKeyIds: summary.failed,
      });
      process.exitCode = 1;
    }
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  logger.error('KMS master-key re-wrap aborted', { error: message });
  process.exitCode = 1;
});
