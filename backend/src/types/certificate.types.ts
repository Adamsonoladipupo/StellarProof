/**
 * Domain types for the Certificate list endpoint.
 * The canonical ICertificate shape is defined in models/Certificate.model.ts.
 */
import mongoose from "mongoose";

/** Validated query parameters for GET /api/v1/certificates */
export interface ListCertificatesQuery {
  /**
   * Optional MongoDB ObjectId of the certificate owner.
   * When omitted, the endpoint returns the public global certificate index
   * across all creators (used by the frontend Global Certificate Search).
   */
  creatorId?: string;
  /**
   * Optional full-text-ish search term. Matched (case-insensitively) against
   * the on-chain `certificateId`, `transactionHash` and `contractAddress`.
   */
  search?: string;
  /** Maximum number of records to return (1–100, default 20). */
  limit: number;
  /** Number of records to skip for offset-based pagination (default 0). */
  skip: number;
}

/** Paginated response envelope for the certificate list endpoint. */
export interface CertificateListResult {
  certificates: Record<string, unknown>[];
  total: number;
  limit: number;
  skip: number;
}

/**
 * Normalized certificate payload shared by the off-chain cache and the
 * on-chain provenance record. `null` marks data that could not be resolved
 * on either side.
 */
export interface CertificateVerificationData {
  certificateId: string;
  storageId: string | null;
  manifestHash: string | null;
  attestationHash: string | null;
  creator: string | null;
  /** ISO-8601 timestamp. */
  timestamp: string | null;
}

/** Field-by-field equality between the cache and the ledger record. */
export interface CertificateVerificationChecks {
  storageId: boolean;
  manifestHash: boolean;
  attestationHash: boolean;
  creator: boolean;
  timestamp: boolean;
}

/**
 * Off-chain revocation state of a cached certificate. Informational only:
 * it never changes `valid`, because the on-chain record stays authoritative.
 */
export interface CertificateRevocationStatus {
  revoked: boolean;
  /** ISO-8601 timestamp of the revocation; null when not revoked. */
  revokedAt: string | null;
}

/** Response of GET /api/v1/certificates/:id/share. */
export interface CertificateShareLink {
  /** Public certificate page URL carrying the signed share token. */
  certLink: string;
  /** The signed share token (JWT) embedded in `certLink`. */
  token: string;
  /** ISO-8601 expiry of the token. */
  expiresAt: string;
}

/**
 * Certificate metadata a share token unlocks for the public page. Holds only
 * on-chain proof data: no owner account, email, public key or file name.
 */
export interface SharedCertificateMetadata {
  certificateId: string;
  network: 'testnet' | 'mainnet';
  contractAddress: string;
  transactionHash: string;
  ledgerSequence: number;
  mintedAt: string;
  contentHash: string | null;
  manifestHash: string | null;
  explorerUrl: string;
  revocation: CertificateRevocationStatus;
}

/** Verifiable JSON export of a certificate (GET /api/v1/certificates/:id/export.json). */
export interface CertificateExport {
  /** Export format version; bumped on breaking changes to this shape. */
  version: 1;
  exportedAt: string;
  certificate: {
    certificateId: string;
    network: 'testnet' | 'mainnet';
    contractAddress: string;
    transactionHash: string;
    ledgerSequence: number;
    mintedAt: string;
    revocation: CertificateRevocationStatus;
  };
  proof: {
    /** Media CID, when the asset is stored on IPFS. */
    mediaCid: string | null;
    manifestCid: string | null;
    contentHash: string | null;
    manifestHash: string | null;
    /** TEE attestation hash recorded for the verification job. */
    attestationHash: string | null;
    /** Oracle signature over the attestation. */
    signature: string | null;
    codeMeasurementHash: string | null;
    attestationTransactionHash: string | null;
    /** Stellar public key the certificate was minted to. */
    creator: string | null;
  };
  links: {
    explorerUrl: string;
    verificationUrl: string;
  };
}

/** Full verification payload returned by GET /api/v1/certificates/verify/:id. */
export interface CertificateVerificationDetails {
  certificateId: string;
  network: 'testnet' | 'mainnet';
  contractAddress: string;
  offChain: CertificateVerificationData;
  onChain: CertificateVerificationData | null;
  checks: CertificateVerificationChecks;
  /** Human-readable list of fields that failed verification. */
  mismatches: string[];
  revocation: CertificateRevocationStatus;
}

/** Identity of the caller, used for owner/admin authorization. */
export interface CertificateRequester {
  id: string;
  role: 'creator' | 'developer' | 'admin';
}

/** Validated query parameters for GET /api/v1/certificates/stats. */
export interface CertificateStatsQuery {
  creatorId: string;
}

/** One calendar month (UTC) of minting activity, formatted as YYYY-MM. */
export interface CertificateMonthlyMintCount {
  month: string;
  minted: number;
}

/** Creator dashboard metrics returned by GET /api/v1/certificates/stats. */
export interface CertificateStats {
  /** Every certificate minted for the creator, including revoked ones. */
  totalMinted: number;
  /** Distinct assets that have a certificate for this creator. */
  uniqueAssetsVerified: number;
  /** Trailing 12 calendar months (UTC), oldest first, zero-filled. */
  monthlySeries: CertificateMonthlyMintCount[];
}

/** Result envelope: `valid` is true only when every field matches. */
export interface CertificateVerificationResult {
  valid: boolean;
  details: CertificateVerificationDetails;
}

/** Standard JSON envelope returned by every endpoint. */
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}
