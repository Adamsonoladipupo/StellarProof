// @ts-nocheck
/**
 * SPV verifier: checks that a media object on IPFS matches the manifest that
 * claims to describe it, and that the manifest belongs to the requester.
 *
 * Checks, in order:
 *   1. The manifest is JSON with a `contentHash` and `creator`.
 *   2. SHA-256 of the media bytes equals the manifest's `contentHash`.
 *   3. The manifest's `creator` is the verification requester.
 *
 * A failed check is a verification verdict (`verified: false`), not an
 * error. Errors are reserved for being unable to reach a verdict, e.g. the
 * gateway is unreachable, and carry a `retryable` flag.
 */
import { StrKey } from "@stellar/stellar-sdk";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import { env } from "../config/env";
import { AppError } from "../errors/AppError";
import { assertCid, XdrValidationError } from "../utils/xdr";
import { CidFetchError, CidFetchService, normalizeSha256, type FetchedCid } from "./cidFetch.service";

export interface SpvVerificationRequest {
  mediaCid: string;
  manifestCid: string;
  requester: string;
}

export interface SpvVerificationResult {
  verified: boolean;
  /** SHA-256 hex of the media bytes. */
  contentHash: string;
  /** SHA-256 hex of the raw manifest bytes. */
  manifestHash: string;
  /** Why verification failed; present only when `verified` is false. */
  reason?: string;
}

export interface SpvVerifierConfig {
  gatewayUrl: string;
  fetchTimeoutMs: number;
  maxMediaBytes: number;
  maxManifestBytes: number;
}

/** A gateway fetch failed before a verdict could be reached. */
export class SpvFetchError extends AppError {
  public readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message, StatusCodes.BAD_GATEWAY, "SPV_FETCH_FAILED");
    this.name = "SpvFetchError";
    this.retryable = retryable;
    Object.setPrototypeOf(this, SpvFetchError.prototype);
  }
}

const manifestSchema = z
  .object({
    contentHash: z.string().min(1),
    creator: z.string().min(1),
  })
  .passthrough();

type FetchFn = typeof fetch;

export class SpvVerifierService {
  private readonly cidFetch: CidFetchService;

  constructor(config: SpvVerifierConfig, fetchFn: FetchFn = fetch) {
    this.cidFetch = new CidFetchService(
      {
        gatewayUrl: config.gatewayUrl,
        timeoutMs: config.fetchTimeoutMs,
        maxMediaBytes: config.maxMediaBytes,
        maxManifestBytes: config.maxManifestBytes,
      },
      fetchFn
    );
  }

  async verify(request: SpvVerificationRequest): Promise<SpvVerificationResult> {
    assertCid(request.mediaCid, "mediaCid");
    assertCid(request.manifestCid, "manifestCid");
    if (!StrKey.isValidEd25519PublicKey(request.requester)) {
      throw new XdrValidationError("requester", "expected a valid Stellar G... address");
    }

    const manifest = await this.download(this.cidFetch.fetchManifest(request.manifestCid));
    const media = await this.download(this.cidFetch.fetchMedia(request.mediaCid));

    const manifestHash = manifest.sha256;
    const contentHash = media.sha256;
    const reject = (reason: string): SpvVerificationResult => ({
      verified: false,
      contentHash,
      manifestHash,
      reason,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(manifest.bytes.toString("utf8"));
    } catch {
      return reject("Manifest is not valid JSON");
    }

    const parsedManifest = manifestSchema.safeParse(parsed);
    if (!parsedManifest.success) {
      return reject("Manifest is missing a contentHash or creator");
    }

    const declaredHash = normalizeSha256(parsedManifest.data.contentHash);
    if (!declaredHash) {
      return reject("Manifest contentHash is not a SHA-256 hex digest");
    }
    if (declaredHash !== contentHash) {
      return reject("Media SHA-256 does not match the manifest contentHash");
    }
    if (parsedManifest.data.creator !== request.requester) {
      return reject("Manifest creator does not match the verification requester");
    }

    return { verified: true, contentHash, manifestHash };
  }

  /** Maps gateway failures onto the SPV error contract the worker retries on. */
  private async download(pending: Promise<FetchedCid>): Promise<FetchedCid> {
    try {
      return await pending;
    } catch (err) {
      if (err instanceof CidFetchError) throw new SpvFetchError(err.message, err.retryable);
      throw err;
    }
  }
}

export const spvVerifierService = new SpvVerifierService({
  gatewayUrl: env.PINATA_GATEWAY_URL,
  fetchTimeoutMs: env.SPV_FETCH_TIMEOUT_MS,
  maxMediaBytes: env.SPV_MAX_MEDIA_BYTES,
  maxManifestBytes: env.SPV_MAX_MANIFEST_BYTES,
});
