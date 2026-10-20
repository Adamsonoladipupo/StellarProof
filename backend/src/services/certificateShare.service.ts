/**
 * Certificate share links: signed, expiring tokens that let the public
 * certificate page render a certificate without exposing its owner.
 *
 * The token carries only the on-chain `certificateId` (as `sub`) and the
 * network. It is signed with a key derived from JWT_SECRET and scoped by
 * audience/issuer, so a share token never verifies as a session token and a
 * session token never verifies as a share token.
 */
import crypto from "crypto";
import jwt, { type JwtPayload, TokenExpiredError } from "jsonwebtoken";
import mongoose from "mongoose";
import { StatusCodes } from "http-status-codes";
import Certificate from "../models/Certificate.model";
import { AppError } from "../errors/AppError";
import { certificateLookupQuery, publicCertificateUrl } from "../utils/certificateLookup";
import { stellarExplorerTxUrl, type StellarNetwork } from "../utils/stellarExplorer";
import type {
  CertificateRequester,
  CertificateShareLink,
  SharedCertificateMetadata,
} from "../types/certificate.types";

const SHARE_TOKEN_AUDIENCE = "stellarproof:certificate-share";
const SHARE_TOKEN_ISSUER = "stellarproof";
const SHARE_TOKEN_ALGORITHM = "HS256";

export interface CertificateShareConfig {
  /** Root secret; the signing key is derived from it per purpose. */
  secret: string;
  ttlSeconds: number;
  publicAppUrl: string;
}

/** Certificate fields read for the shared view; owner relations are never selected. */
interface SharedCertificateRecord {
  certificateId: string;
  stellarNetwork: StellarNetwork;
  contractAddress: string;
  transactionHash: string;
  ledgerSequence: number;
  mintedAt: Date;
  revoked?: boolean;
  revokedAt?: Date | null;
  manifestId?: { contentHash?: string; manifestHash?: string } | null;
}

function shareSigningKey(secret: string): Buffer {
  return crypto.createHmac("sha256", secret).update("certificate-share-token").digest();
}

function invalidShareToken(): AppError {
  return new AppError("Share link is invalid", StatusCodes.UNAUTHORIZED, "INVALID_SHARE_TOKEN");
}

export class CertificateShareService {
  constructor(
    /**
     * Lazily resolves configuration so importing this service never requires
     * environment variables and tests can inject their own.
     */
    private readonly configFactory: () => CertificateShareConfig = loadShareConfig
  ) {}

  /**
   * Issues a share link for a certificate. Only the certificate's owner or an
   * admin may share it.
   *
   * @throws {AppError} 404 when the certificate does not exist.
   * @throws {AppError} 403 when the requester is neither owner nor admin.
   */
  async createShareLink(
    id: string,
    requester: CertificateRequester,
    now: Date = new Date()
  ): Promise<CertificateShareLink> {
    const certificate = await Certificate.findOne(certificateLookupQuery(id.trim()))
      .select("certificateId stellarNetwork creatorId")
      .lean<{ certificateId: string; stellarNetwork: StellarNetwork; creatorId: mongoose.Types.ObjectId }>();
    if (!certificate) {
      throw new AppError("Certificate not found", StatusCodes.NOT_FOUND, "CERTIFICATE_NOT_FOUND");
    }

    if (certificate.creatorId.toString() !== requester.id && requester.role !== "admin") {
      throw new AppError(
        "Only the certificate owner or an admin can share this certificate",
        StatusCodes.FORBIDDEN,
        "CERTIFICATE_SHARE_FORBIDDEN"
      );
    }

    const config = this.configFactory();
    const issuedAt = Math.floor(now.getTime() / 1_000);
    const expiresAt = issuedAt + config.ttlSeconds;
    const token = jwt.sign(
      { net: certificate.stellarNetwork, iat: issuedAt, exp: expiresAt },
      shareSigningKey(config.secret),
      {
        algorithm: SHARE_TOKEN_ALGORITHM,
        audience: SHARE_TOKEN_AUDIENCE,
        issuer: SHARE_TOKEN_ISSUER,
        subject: certificate.certificateId,
      }
    );

    const pageUrl = publicCertificateUrl(config.publicAppUrl, certificate.certificateId);
    return {
      certLink: `${pageUrl}?share=${encodeURIComponent(token)}`,
      token,
      expiresAt: new Date(expiresAt * 1_000).toISOString(),
    };
  }

  /**
   * Verifies a share token and returns the PII-free certificate metadata the
   * public page needs.
   *
   * @throws {AppError} 401 when the token is malformed, tampered or not a share token.
   * @throws {AppError} 410 when the token has expired.
   * @throws {AppError} 404 when the certificate no longer exists.
   */
  async resolveShareToken(token: string): Promise<SharedCertificateMetadata> {
    const config = this.configFactory();

    let payload: string | JwtPayload;
    try {
      payload = jwt.verify(token, shareSigningKey(config.secret), {
        algorithms: [SHARE_TOKEN_ALGORITHM],
        audience: SHARE_TOKEN_AUDIENCE,
        issuer: SHARE_TOKEN_ISSUER,
      });
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        throw new AppError("Share link has expired", StatusCodes.GONE, "SHARE_TOKEN_EXPIRED");
      }
      throw invalidShareToken();
    }

    const certificateId = typeof payload === "object" ? payload.sub : undefined;
    if (!certificateId) {
      throw invalidShareToken();
    }

    const certificate = await Certificate.findOne({ certificateId })
      .select(
        "certificateId stellarNetwork contractAddress transactionHash ledgerSequence mintedAt revoked revokedAt manifestId"
      )
      .populate("manifestId", "contentHash manifestHash")
      .lean<SharedCertificateRecord>();
    if (!certificate) {
      throw new AppError("Certificate not found", StatusCodes.NOT_FOUND, "CERTIFICATE_NOT_FOUND");
    }

    return toSharedMetadata(certificate);
  }
}

function toSharedMetadata(certificate: SharedCertificateRecord): SharedCertificateMetadata {
  return {
    certificateId: certificate.certificateId,
    network: certificate.stellarNetwork,
    contractAddress: certificate.contractAddress,
    transactionHash: certificate.transactionHash,
    ledgerSequence: certificate.ledgerSequence,
    mintedAt: new Date(certificate.mintedAt).toISOString(),
    contentHash: certificate.manifestId?.contentHash ?? null,
    manifestHash: certificate.manifestId?.manifestHash ?? null,
    explorerUrl: stellarExplorerTxUrl(certificate.stellarNetwork, certificate.transactionHash),
    revocation: {
      revoked: certificate.revoked === true,
      revokedAt:
        certificate.revoked === true && certificate.revokedAt
          ? new Date(certificate.revokedAt).toISOString()
          : null,
    },
  };
}

function loadShareConfig(): CertificateShareConfig {
  const { env } = require("../config/env") as typeof import("../config/env");
  return {
    secret: env.JWT_SECRET,
    ttlSeconds: env.CERTIFICATE_SHARE_TOKEN_TTL_SECONDS,
    publicAppUrl: env.PUBLIC_APP_URL,
  };
}

export const certificateShareService = new CertificateShareService();
