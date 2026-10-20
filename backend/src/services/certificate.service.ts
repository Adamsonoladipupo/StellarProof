import mongoose, { type FilterQuery } from "mongoose";
import { StatusCodes } from "http-status-codes";
import Certificate, { type ICertificate } from "../models/Certificate.model";
import { AppError } from "../errors/AppError";
import type {
  ProvenanceContract,
  OnChainCertificate,
} from "./contracts/ProvenanceContract";
import type {
  ListCertificatesQuery,
  CertificateListResult,
  CertificateRequester,
  CertificateStats,
  CertificateStatsQuery,
  CertificateMonthlyMintCount,
  CertificateRevocationStatus,
  CertificateVerificationData,
  CertificateVerificationDetails,
  CertificateVerificationResult,
  CertificateVerificationChecks,
} from "../types/certificate.types";

/** Escape user input so it can be safely embedded in a MongoDB `$regex`. */
function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Builds the Mongo filter shared by the paginated list and the CSV export, so
 * both return the same set of certificates for the same query.
 */
function buildCertificateFilter(creatorId?: string, search?: string): FilterQuery<ICertificate> {
  const conditions: FilterQuery<ICertificate>[] = [];

  // Per-owner listing when creatorId is supplied; otherwise the query
  // targets the public global certificate index.
  if (creatorId) {
    conditions.push({ creatorId: new mongoose.Types.ObjectId(creatorId) });
  }

  // Full-text-ish search across the on-chain identifiers of a certificate.
  if (search) {
    const matcher = { $regex: escapeRegex(search), $options: "i" };
    conditions.push({
      $or: [
        { certificateId: matcher },
        { transactionHash: matcher },
        { contractAddress: matcher },
      ],
    });
  }

  return conditions.length > 0 ? { $and: conditions } : {};
}

/** Lean certificate document as read for CSV export (no populated relations). */
export interface CertificateExportRecord {
  certificateId: string;
  stellarNetwork: string;
  contractAddress: string;
  transactionHash: string;
  ledgerSequence: number;
  mintedAt: Date;
  creatorId: mongoose.Types.ObjectId;
  assetId: mongoose.Types.ObjectId;
  manifestId: mongoose.Types.ObjectId;
  verificationJobId: mongoose.Types.ObjectId;
  createdAt: Date;
}

/** Streaming view of a Mongo query cursor: iterable, and closable on early exit. */
export type CertificateExportCursor = AsyncIterable<CertificateExportRecord> & {
  close(): Promise<void>;
};

/** Certificate cache document with the relations required for verification. */
interface PopulatedVerificationCertificate {
  certificateId: string;
  contractAddress: string;
  stellarNetwork: 'testnet' | 'mainnet';
  mintedAt: Date;
  revoked?: boolean;
  revokedAt?: Date | null;
  assetId?: { storageReferenceId?: string } | null;
  manifestId?: { manifestHash?: string; creator?: string } | null;
  creatorId?: { stellarPublicKey?: string } | null;
  verificationJobId?: {
    ownerPublicKey?: string;
    teeAttestationHash?: string;
  } | null;
}

export class CertificateService {
  constructor(
    /**
     * Lazily resolves the on-chain provenance reader. Kept as a factory so
     * importing this service never requires Stellar credentials and unit
     * tests can inject a fake reader.
     */
    private readonly provenanceFactory: () => Pick<
      ProvenanceContract,
      "getCertificate"
    > = createProvenanceReader
  ) {}

  async listCertificates(query: ListCertificatesQuery): Promise<CertificateListResult> {
    const { creatorId, search, limit, skip } = query;

    if (creatorId && !mongoose.Types.ObjectId.isValid(creatorId)) {
      throw new AppError(
        "creatorId must be a valid MongoDB ObjectId",
        StatusCodes.BAD_REQUEST,
        "INVALID_CREATOR_ID"
      );
    }

    if (limit < 1 || limit > 100) {
      throw new AppError(
        "limit must be between 1 and 100",
        StatusCodes.BAD_REQUEST,
        "INVALID_PAGINATION"
      );
    }

    if (skip < 0) {
      throw new AppError(
        "skip must be a non-negative integer",
        StatusCodes.BAD_REQUEST,
        "INVALID_PAGINATION"
      );
    }

    const filter = buildCertificateFilter(creatorId, search);

    const [certificates, total] = await Promise.all([
      Certificate.find(filter)
        // Populate the linked asset + manifest so the frontend can render
        // human-readable names/descriptions without extra round-trips.
        .populate("assetId", "fileName mimeType storageReferenceId")
        .populate("manifestId", "contentHash creator metadata")
        .sort({ mintedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<Record<string, unknown>[]>(),
      Certificate.countDocuments(filter),
    ]);

    return { certificates, total, limit, skip };
  }

  /**
   * Returns a lazy cursor over every certificate matching the list filters.
   * Pagination is not applied: an export covers the full filtered set and is
   * read from MongoDB in batches so memory stays flat for large exports.
   *
   * @throws {AppError} 400 when `creatorId` is not a valid ObjectId.
   */
  streamCertificatesForExport(
    query: Pick<ListCertificatesQuery, "creatorId" | "search">
  ): CertificateExportCursor {
    const { creatorId, search } = query;

    if (creatorId && !mongoose.Types.ObjectId.isValid(creatorId)) {
      throw new AppError(
        "creatorId must be a valid MongoDB ObjectId",
        StatusCodes.BAD_REQUEST,
        "INVALID_CREATOR_ID"
      );
    }

    return Certificate.find(buildCertificateFilter(creatorId, search))
      .sort({ mintedAt: -1, createdAt: -1 })
      .lean<CertificateExportRecord>()
      .cursor();
  }

  async getCertificateById(id: string): Promise<ICertificate | null> {
    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { certificateId: id }] }
      : { certificateId: id };

    return Certificate.findOne(query)
      .populate("manifestId")
      .populate("assetId")
      .exec();
  }

  /**
   * Cross-checks the off-chain certificate cache against the ledger-stored
   * provenance record (`provenance.get_certificate`).
   *
   * @throws {AppError} 400 when `certificateId` is missing.
   * @throws {AppError} 404 when no matching certificate exists in the cache.
   */
  async verifyCertificate(
    certificateId: string
  ): Promise<CertificateVerificationResult> {
    const id = certificateId?.trim();
    if (!id) {
      throw new AppError(
        "Certificate id is required",
        StatusCodes.BAD_REQUEST,
        "MISSING_CERTIFICATE_ID"
      );
    }

    const cached = await this.findCachedForVerification(id);
    if (!cached) {
      throw new AppError(
        "Certificate not found",
        StatusCodes.NOT_FOUND,
        "CERTIFICATE_NOT_FOUND"
      );
    }

    const offChain = toOffChainData(cached);
    const onChainRecord = await this.provenanceFactory().getCertificate(
      cached.certificateId
    );
    const onChain = onChainRecord
      ? toOnChainData(cached.certificateId, onChainRecord)
      : null;

    const checks = compareCertificates(offChain, onChain);
    const mismatches = collectMismatches(checks);
    const valid = onChain !== null && Object.values(checks).every(Boolean);

    const details: CertificateVerificationDetails = {
      certificateId: cached.certificateId,
      network: cached.stellarNetwork,
      contractAddress: cached.contractAddress,
      offChain,
      onChain,
      checks,
      mismatches,
      revocation: toRevocationStatus(cached),
    };

    return { valid, details };
  }

  /**
   * Records an off-chain revocation of a certificate. Only the certificate's
   * owner or an admin may revoke it. The on-chain record is not touched.
   *
   * @throws {AppError} 404 when the certificate does not exist.
   * @throws {AppError} 403 when the requester is neither owner nor admin.
   * @throws {AppError} 409 when the certificate is already revoked.
   */
  async revokeCertificate(
    id: string,
    requester: CertificateRequester,
    now: Date = new Date()
  ): Promise<ICertificate> {
    const lookup = certificateLookupQuery(id.trim());
    const certificate = await Certificate.findOne(lookup)
      .select("creatorId revoked")
      .lean<{ _id: mongoose.Types.ObjectId; creatorId: mongoose.Types.ObjectId }>();
    if (!certificate) {
      throw new AppError(
        "Certificate not found",
        StatusCodes.NOT_FOUND,
        "CERTIFICATE_NOT_FOUND"
      );
    }

    const isOwner = certificate.creatorId.toString() === requester.id;
    if (!isOwner && requester.role !== "admin") {
      throw new AppError(
        "Only the certificate owner or an admin can revoke this certificate",
        StatusCodes.FORBIDDEN,
        "CERTIFICATE_REVOCATION_FORBIDDEN"
      );
    }

    // The revoked guard is part of the filter, so two concurrent revocations
    // cannot both succeed and overwrite each other's revokedBy/revokedAt.
    const revoked = await Certificate.findOneAndUpdate(
      { _id: certificate._id, revoked: { $ne: true } },
      {
        $set: {
          revoked: true,
          revokedAt: now,
          revokedBy: new mongoose.Types.ObjectId(requester.id),
        },
      },
      { new: true }
    );
    if (!revoked) {
      throw new AppError(
        "Certificate is already revoked",
        StatusCodes.CONFLICT,
        "CERTIFICATE_ALREADY_REVOKED"
      );
    }

    return revoked;
  }

  /**
   * Aggregates the creator dashboard metrics: total mints, distinct verified
   * assets and a zero-filled trailing 12-month UTC mint series.
   *
   * @throws {AppError} 400 when `creatorId` is missing or not an ObjectId.
   */
  async getStats(
    query: CertificateStatsQuery,
    now: Date = new Date()
  ): Promise<CertificateStats> {
    const { creatorId } = query;
    if (!creatorId || !mongoose.Types.ObjectId.isValid(creatorId)) {
      throw new AppError(
        "creatorId must be a valid MongoDB ObjectId",
        StatusCodes.BAD_REQUEST,
        "INVALID_CREATOR_ID"
      );
    }

    const owner = { creatorId: new mongoose.Types.ObjectId(creatorId) };
    const windowStart = startOfUtcMonth(now, -(MONTHLY_SERIES_LENGTH - 1));

    const [totalMinted, assetIds, monthlyRows] = await Promise.all([
      Certificate.countDocuments(owner),
      Certificate.distinct("assetId", owner),
      Certificate.aggregate<{ _id: string; minted: number }>([
        { $match: { ...owner, mintedAt: { $gte: windowStart, $lte: now } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$mintedAt" } },
            minted: { $sum: 1 },
          },
        },
      ]),
    ]);

    return {
      totalMinted,
      uniqueAssetsVerified: assetIds.length,
      monthlySeries: buildMonthlySeries(monthlyRows, now),
    };
  }

  /** Loads the cache document plus every relation needed for verification. */
  private async findCachedForVerification(
    id: string
  ): Promise<PopulatedVerificationCertificate | null> {
    const query = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ _id: id }, { certificateId: id }] }
      : { certificateId: id };

    return Certificate.findOne(query)
      .populate("manifestId", "manifestHash creator")
      .populate("assetId", "storageReferenceId")
      .populate("creatorId", "stellarPublicKey")
      .populate("verificationJobId", "ownerPublicKey teeAttestationHash")
      .lean<PopulatedVerificationCertificate>();
  }
}

/** The on-chain `creator` is the mint recipient (the verification requester). */
function resolveCreator(cached: PopulatedVerificationCertificate): string | null {
  return (
    cached.verificationJobId?.ownerPublicKey ??
    cached.creatorId?.stellarPublicKey ??
    cached.manifestId?.creator ??
    null
  );
}

function toOffChainData(
  cached: PopulatedVerificationCertificate
): CertificateVerificationData {
  return {
    certificateId: cached.certificateId,
    storageId: cached.assetId?.storageReferenceId ?? null,
    manifestHash: cached.manifestId?.manifestHash ?? null,
    attestationHash: cached.verificationJobId?.teeAttestationHash ?? null,
    creator: resolveCreator(cached),
    timestamp: cached.mintedAt
      ? new Date(cached.mintedAt).toISOString()
      : null,
  };
}

function toOnChainData(
  certificateId: string,
  record: OnChainCertificate
): CertificateVerificationData {
  return {
    certificateId,
    storageId: record.storageId,
    manifestHash: record.manifestHash,
    attestationHash: record.attestationHash,
    creator: record.creator,
    timestamp: record.timestamp.toISOString(),
  };
}

/** Hashes are compared case-insensitively; CIDs and addresses are exact. */
function compareCertificates(
  offChain: CertificateVerificationData,
  onChain: CertificateVerificationData | null
): CertificateVerificationChecks {
  if (!onChain) {
    return {
      storageId: false,
      manifestHash: false,
      attestationHash: false,
      creator: false,
      timestamp: false,
    };
  }

  return {
    storageId: offChain.storageId === onChain.storageId,
    manifestHash: equalsIgnoreCase(offChain.manifestHash, onChain.manifestHash),
    attestationHash: equalsIgnoreCase(
      offChain.attestationHash,
      onChain.attestationHash
    ),
    creator: offChain.creator === onChain.creator,
    timestamp: equalsTimestamp(offChain.timestamp, onChain.timestamp),
  };
}

function equalsIgnoreCase(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

/** Compares two ISO timestamps at second precision (ledger time is u64s). */
function equalsTimestamp(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const left = Math.floor(new Date(a).getTime() / 1_000);
  const right = Math.floor(new Date(b).getTime() / 1_000);
  return Number.isFinite(left) && Number.isFinite(right) && left === right;
}

function collectMismatches(checks: CertificateVerificationChecks): string[] {
  return (Object.keys(checks) as (keyof CertificateVerificationChecks)[]).filter(
    (key) => !checks[key]
  );
}

/**
 * Builds the production {@link ProvenanceContract} read client. Loaded lazily
 * so the service (and its unit tests) never require Stellar credentials.
 */
function createProvenanceReader(): Pick<ProvenanceContract, "getCertificate"> {
  const { env } = require("../config/env") as typeof import("../config/env");
  const { ProvenanceContract } = require("./contracts/ProvenanceContract") as typeof import("./contracts/ProvenanceContract");
  const { SorobanContractQueryClient } = require("./contracts/ContractReader") as typeof import("./contracts/ContractReader");
  const { Keypair, StrKey } = require("@stellar/stellar-sdk") as typeof import("@stellar/stellar-sdk");

  if (!StrKey.isValidEd25519SecretSeed(env.STELLAR_ORACLE_SECRET_KEY)) {
    throw new AppError(
      "STELLAR_ORACLE_SECRET_KEY must be a valid Stellar secret seed",
      StatusCodes.INTERNAL_SERVER_ERROR,
      "PROVENANCE_CONFIG_INVALID"
    );
  }

  const sourceAccount = Keypair.fromSecret(
    env.STELLAR_ORACLE_SECRET_KEY
  ).publicKey();
  const queryClient = new SorobanContractQueryClient(sourceAccount);
  return new ProvenanceContract(env.STELLAR_PROVENANCE_CONTRACT_ID, queryClient);
}

export const certificateService = new CertificateService();
