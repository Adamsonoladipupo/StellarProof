import { scValToNative, xdr, type rpc } from "@stellar/stellar-sdk";
import mongoose from "mongoose";
import Certificate from "../models/Certificate.model";
import Manifest from "../models/Manifest.model";
import { VerificationJobModel } from "../models/verificationJob.model";
import { EventIngestionCursorModel } from "../models/EventIngestionCursor.model";
import logger from "../utils/logger";

const STREAM = "certificate-indexer";
const TOPIC_CERTIFICATE_MINTED = xdr.ScVal.scvSymbol("CertificateMinted").toXDR("base64");

/** The verification job a minted certificate belongs to, resolved from the job's certificateId. */
export interface MintedJobRef {
  jobId: string;
  assetId: string;
  manifestId: string;
  creatorId: string;
}

/** Certificate cache fields that come from the chain event itself. */
export interface CertificateCacheInput extends MintedJobRef {
  certificateId: string;
  stellarNetwork: "testnet" | "mainnet";
  contractAddress: string;
  transactionHash: string;
  ledgerSequence: number;
  mintedAt: Date;
}

/** The RPC surface the indexer needs. `SorobanService` satisfies it. */
export interface CertificateIndexerRpc {
  getEvents(request: rpc.Server.GetEventsRequest): Promise<rpc.Api.GetEventsResponse>;
}

/** Storage port for the indexer. The Mongo adapter is below; tests inject fakes. */
export interface CertificateIndexerStore {
  findMintedJob(certificateId: string): Promise<MintedJobRef | null>;
  /** Inserts the cache row only if none exists for this certificateId. Returns true on insert. */
  insertIfMissing(input: CertificateCacheInput): Promise<boolean>;
  getCursor(): Promise<{ cursor: string } | null>;
  saveCursor(cursor: string, latestLedger: number): Promise<void>;
}

export interface CertificateIndexerConfig {
  provenanceContractId: string;
  stellarNetwork: "testnet" | "mainnet";
  startLedger?: number;
  limit: number;
}

export interface CertificateIndexResult {
  received: number;
  indexed: number;
  existing: number;
  skipped: number;
  latestLedger: number;
}

/** Reads the certificate id from the event payload, falling back to the topics. */
export function certificateIdFromEvent(event: rpc.Api.EventResponse): string | undefined {
  let payload: unknown;
  try {
    payload = scValToNative(event.value);
  } catch {
    payload = undefined;
  }
  if (payload instanceof Map) payload = Object.fromEntries(payload.entries());
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const fromPayload = record.certificate_id ?? record.certificateId;
    if (typeof fromPayload === "bigint" || typeof fromPayload === "number" || typeof fromPayload === "string") {
      return String(fromPayload);
    }
  }

  for (const topic of event.topic) {
    const value = scValToNative(topic);
    if (typeof value === "bigint" || typeof value === "number") return String(value);
  }
  return undefined;
}

/**
 * Backfills missing Certificate cache documents from CertificateMinted events.
 *
 * Each event is correlated to the verification job that already stores its
 * certificateId. Events with no matching job are logged and skipped, because a
 * cache row needs the asset, manifest and creator that only the job provides.
 * Inserts are keyed on certificateId, so reprocessing an event is harmless.
 */
export class CertificateIndexerService {
  constructor(
    private readonly rpcClient: CertificateIndexerRpc,
    private readonly store: CertificateIndexerStore,
    private readonly config: CertificateIndexerConfig
  ) {}

  async indexOnce(): Promise<CertificateIndexResult> {
    const saved = await this.store.getCursor();
    const response = await this.rpcClient.getEvents({
      filters: [
        {
          type: "contract",
          contractIds: [this.config.provenanceContractId],
          topics: [[TOPIC_CERTIFICATE_MINTED]],
        },
      ],
      limit: this.config.limit,
      ...(saved?.cursor
        ? { cursor: saved.cursor }
        : this.config.startLedger !== undefined && this.config.startLedger > 0
          ? { startLedger: this.config.startLedger }
          : {}),
    });

    let indexed = 0;
    let existing = 0;
    let skipped = 0;

    for (const event of response.events) {
      const outcome = await this.indexEvent(event);
      if (outcome === "indexed") indexed += 1;
      else if (outcome === "existing") existing += 1;
      else skipped += 1;

      await this.store.saveCursor(event.pagingToken, event.ledger);
    }

    if (response.events.length === 0 && response.cursor) {
      await this.store.saveCursor(response.cursor, response.latestLedger);
    }

    return {
      received: response.events.length,
      indexed,
      existing,
      skipped,
      latestLedger: response.latestLedger,
    };
  }

  private async indexEvent(event: rpc.Api.EventResponse): Promise<"indexed" | "existing" | "skipped"> {
    const certificateId = certificateIdFromEvent(event);
    const mintedAt = new Date(event.ledgerClosedAt);
    if (!certificateId || Number.isNaN(mintedAt.getTime())) {
      logger.warn("CertificateMinted event is missing certificateId or ledger time; skipping", {
        eventId: event.id,
      });
      return "skipped";
    }

    const job = await this.store.findMintedJob(certificateId);
    if (!job) {
      logger.warn("CertificateMinted event has no matching verification job; skipping", {
        eventId: event.id,
        certificateId,
      });
      return "skipped";
    }

    const inserted = await this.store.insertIfMissing({
      ...job,
      certificateId,
      stellarNetwork: this.config.stellarNetwork,
      contractAddress: this.config.provenanceContractId,
      transactionHash: event.txHash,
      ledgerSequence: event.ledger,
      mintedAt,
    });
    return inserted ? "indexed" : "existing";
  }
}

/** Mongo adapter used in production. */
export const mongoCertificateIndexerStore: CertificateIndexerStore = {
  async findMintedJob(certificateId) {
    const job = await VerificationJobModel.findOne({ certificateId })
      .select({ _id: 1, assetId: 1, manifestId: 1 })
      .lean<{ _id: mongoose.Types.ObjectId; assetId?: mongoose.Types.ObjectId; manifestId?: mongoose.Types.ObjectId }>();
    if (!job?.assetId || !job.manifestId) return null;

    const manifest = await Manifest.findById(job.manifestId).select({ creatorId: 1 }).lean<{ creatorId?: mongoose.Types.ObjectId }>();
    if (!manifest?.creatorId) return null;

    return {
      jobId: String(job._id),
      assetId: String(job.assetId),
      manifestId: String(job.manifestId),
      creatorId: String(manifest.creatorId),
    };
  },

  async insertIfMissing(input) {
    const result = await Certificate.updateOne(
      { certificateId: input.certificateId },
      {
        $setOnInsert: {
          verificationJobId: new mongoose.Types.ObjectId(input.jobId),
          assetId: new mongoose.Types.ObjectId(input.assetId),
          manifestId: new mongoose.Types.ObjectId(input.manifestId),
          creatorId: new mongoose.Types.ObjectId(input.creatorId),
          stellarNetwork: input.stellarNetwork,
          contractAddress: input.contractAddress,
          certificateId: input.certificateId,
          transactionHash: input.transactionHash,
          ledgerSequence: input.ledgerSequence,
          mintedAt: input.mintedAt,
        },
      },
      { upsert: true }
    );
    return result.upsertedCount === 1;
  },

  async getCursor() {
    return EventIngestionCursorModel.findOne({ stream: STREAM }).lean<{ cursor: string }>();
  },

  async saveCursor(cursor, latestLedger) {
    await EventIngestionCursorModel.updateOne(
      { stream: STREAM },
      { $set: { cursor, latestLedger } },
      { upsert: true }
    );
  },
};
