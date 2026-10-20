import cron from 'node-cron';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { kmsService } from '../services/kms.service';
import logger from '../utils/logger';

const DAY_MS = 24 * 60 * 60 * 1000;

let isRunning = false;

export interface KmsRotationCycleResult {
  expiredDeactivated: number;
  rotationEnabled: boolean;
  due: number;
  rotated: number;
  failed: number;
}

/**
 * One scheduled pass. Expired keys are deactivated first, then every active
 * key older than KMS_ROTATION_PERIOD_DAYS is rotated in batches. A failure on
 * one key is logged and does not stop the rest of the sweep.
 *
 * Returns null when a previous pass is still running.
 */
export async function runKmsRotationCycle(now: Date = new Date()): Promise<KmsRotationCycleResult | null> {
  if (isRunning) {
    logger.warn('KMS rotation job skipped — previous run has not finished yet');
    return null;
  }

  isRunning = true;

  try {
    const expiredDeactivated = await kmsService.deactivateExpiredKeys(now);
    if (expiredDeactivated > 0) {
      logger.info('KMS rotation job: deactivated expired keys', { count: expiredDeactivated });
    }

    const periodDays = env.KMS_ROTATION_PERIOD_DAYS;
    const result: KmsRotationCycleResult = {
      expiredDeactivated,
      rotationEnabled: periodDays > 0,
      due: 0,
      rotated: 0,
      failed: 0,
    };

    if (periodDays === 0) {
      return result;
    }

    const cutoff = new Date(now.getTime() - periodDays * DAY_MS);
    const batchSize = env.KMS_ROTATION_BATCH_SIZE;
    let afterId: mongoose.Types.ObjectId | undefined;
    let batch: Awaited<ReturnType<typeof kmsService.findKeysDueForRotation>>;

    logger.info('KMS rotation job: starting sweep', { cutoff: cutoff.toISOString(), batchSize });

    do {
      batch = await kmsService.findKeysDueForRotation({ cutoff, limit: batchSize, afterId, now });

      for (const key of batch) {
        result.due += 1;
        try {
          await kmsService.rotateKey(String(key.creatorId));
          result.rotated += 1;
        } catch (err: unknown) {
          result.failed += 1;
          const message = err instanceof Error ? err.message : String(err);
          logger.error('KMS rotation job: failed to rotate key', { keyId: key.id, error: message });
        }
      }

      afterId = batch[batch.length - 1]?._id;
      logger.info('KMS rotation job: batch complete', {
        processed: result.due,
        rotated: result.rotated,
        failed: result.failed,
      });
    } while (batch.length === batchSize);

    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('KMS rotation job: unhandled exception in cycle', { error: message });
    return null;
  } finally {
    isRunning = false;
  }
}

/**
 * Schedules the KMS lifecycle sweep on KMS_ROTATION_CRON_SCHEDULE.
 */
export function startKmsRotationJob() {
  const schedule = env.KMS_ROTATION_CRON_SCHEDULE;

  if (!cron.validate(schedule)) {
    throw new Error(
      `Invalid cron expression in KMS_ROTATION_CRON_SCHEDULE: "${schedule}". ` +
        'Expected a valid 5-part cron expression, e.g. "0 * * * *".',
    );
  }

  logger.info('KMS rotation job: scheduling', {
    schedule,
    rotationPeriodDays: env.KMS_ROTATION_PERIOD_DAYS,
  });

  return cron.schedule(
    schedule,
    () => {
      // Fire-and-forget — runKmsRotationCycle handles its own errors.
      void runKmsRotationCycle();
    },
    { timezone: 'UTC' },
  );
}
