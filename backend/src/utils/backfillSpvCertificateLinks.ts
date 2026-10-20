/**
 * One-off backfill for SPV records created before certificate/job linkage.
 *
 * Usage: pnpm backfill:spv-links
 *
 * Safe to re-run: records that already reference a certificate are skipped.
 * Requires MONGODB_URI in the environment (see .env.example).
 */
import mongoose from 'mongoose';
import { connectDB } from '../config/db';
import { spvService } from '../services/spv.service';

async function backfillSpvCertificateLinks(): Promise<void> {
  await connectDB();

  try {
    const { scanned, linked } = await spvService.backfillCertificateLinks();
    console.log(`SPV certificate backfill complete: scanned=${scanned} linked=${linked}`);
    process.exitCode = 0;
  } catch (error: unknown) {
    console.error('SPV certificate backfill failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

backfillSpvCertificateLinks();
