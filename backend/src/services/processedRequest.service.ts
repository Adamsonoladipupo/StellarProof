/**
 * Exactly-once guard for on-chain request processing.
 *
 * `runOnce` claims a dedup key before running the handler. A key that is
 * already completed is skipped. A key that is in progress is skipped too,
 * unless its claim is older than the lease, which means the previous worker
 * crashed; only then can another worker take it over. A handler that does not
 * handle the event, or that throws, releases the claim so a later delivery can
 * try again.
 */
import { ProcessedRequestModel, type ProcessedRequestStatus } from "../models/ProcessedRequest.model";
import logger from "../utils/logger";

export const PROCESSED_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PROCESSING_LEASE_MS = 10 * 60 * 1000;

export interface ProcessedRequestRecord {
  dedupKey: string;
  eventId: string;
  status: ProcessedRequestStatus;
  jobId?: string;
  startedAt: Date;
  expiresAt: Date;
}

export interface ProcessedRequestStore {
  /** Inserts a new record. Returns false when the dedup key already exists. */
  insert(record: ProcessedRequestRecord): Promise<boolean>;
  find(dedupKey: string): Promise<ProcessedRequestRecord | null>;
  /**
   * Compare-and-swap for a stale claim: replaces the record only while it still
   * carries the `observedStartedAt` the caller saw. Returns false if another
   * worker got there first.
   */
  takeOver(dedupKey: string, observedStartedAt: Date, record: ProcessedRequestRecord): Promise<boolean>;
  complete(dedupKey: string, jobId: string | undefined): Promise<void>;
  release(dedupKey: string, eventId: string): Promise<void>;
}

export type ProcessOutcome =
  /** The handler ran and handled the event. */
  | { outcome: "handled"; jobId?: string }
  /** The handler ran but nothing matched; the claim was released. */
  | { outcome: "unhandled" }
  /** Another delivery already completed, or is still in progress. */
  | { outcome: "duplicate" };

export interface ProcessHandlerResult {
  handled: boolean;
  jobId?: string;
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: number }).code === 11000;
}

export const mongooseProcessedRequestStore: ProcessedRequestStore = {
  async insert(record) {
    try {
      await ProcessedRequestModel.create(record);
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) return false;
      throw error;
    }
  },
  async find(dedupKey) {
    return ProcessedRequestModel.findOne({ dedupKey }).lean<ProcessedRequestRecord>();
  },
  async takeOver(dedupKey, observedStartedAt, record) {
    const result = await ProcessedRequestModel.updateOne(
      { dedupKey, status: "processing", startedAt: observedStartedAt },
      { $set: record }
    );
    return result.modifiedCount === 1;
  },
  async complete(dedupKey, jobId) {
    await ProcessedRequestModel.updateOne(
      { dedupKey },
      { $set: { status: "completed", jobId: jobId ?? null } }
    );
  },
  async release(dedupKey, eventId) {
    await ProcessedRequestModel.deleteOne({ dedupKey, eventId, status: "processing" });
  },
};

export class ProcessedRequestService {
  constructor(
    private readonly store: ProcessedRequestStore = mongooseProcessedRequestStore,
    private readonly now: () => Date = () => new Date(),
    private readonly leaseMs: number = PROCESSING_LEASE_MS,
    private readonly ttlMs: number = PROCESSED_REQUEST_TTL_MS
  ) {}

  async runOnce(
    dedupKey: string,
    eventId: string,
    handler: () => Promise<ProcessHandlerResult>
  ): Promise<ProcessOutcome> {
    if (!(await this.claim(dedupKey, eventId))) {
      logger.info("Skipping duplicate on-chain request", { dedupKey, eventId });
      return { outcome: "duplicate" };
    }

    let result: ProcessHandlerResult;
    try {
      result = await handler();
    } catch (error) {
      await this.store.release(dedupKey, eventId);
      throw error;
    }

    if (!result.handled) {
      await this.store.release(dedupKey, eventId);
      return { outcome: "unhandled" };
    }

    await this.store.complete(dedupKey, result.jobId);
    return { outcome: "handled", jobId: result.jobId };
  }

  private async claim(dedupKey: string, eventId: string): Promise<boolean> {
    const now = this.now();
    const record: ProcessedRequestRecord = {
      dedupKey,
      eventId,
      status: "processing",
      startedAt: now,
      expiresAt: new Date(now.getTime() + this.ttlMs),
    };

    if (await this.store.insert(record)) return true;

    const existing = await this.store.find(dedupKey);
    if (!existing) return this.store.insert(record);
    if (existing.status === "completed") return false;

    const stale = existing.startedAt.getTime() <= now.getTime() - this.leaseMs;
    return stale ? this.store.takeOver(dedupKey, existing.startedAt, record) : false;
  }
}

export const processedRequestService = new ProcessedRequestService();
