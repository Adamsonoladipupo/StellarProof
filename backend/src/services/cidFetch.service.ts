/**
 * CID fetch service: resolves and downloads media and manifest CIDs from the
 * configured IPFS gateway so they can be verified (SPV) before attestation.
 *
 * Every download is:
 *   - bounded by a per-request timeout covering headers and body;
 *   - capped in size, both on the declared `content-length` and while
 *     streaming, so an oversized object is aborted before it is buffered;
 *   - re-hashed (SHA-256) and, when the caller knows the expected digest,
 *     compared against it.
 *
 * Gateway problems raise `CidFetchError` with a `retryable` flag. A digest
 * mismatch raises `CidIntegrityError`, which is never retryable: the content
 * behind the CID is not what was recorded.
 */
import crypto from "crypto";
import { StatusCodes } from "http-status-codes";
import { env } from "../config/env";
import { AppError } from "../errors/AppError";
import { VerificationRequestEventModel } from "../models/verificationRequestEvent.model";
import type { IVerificationRequestEvent } from "../types/verificationRequestEvent.types";
import { assertCid } from "../utils/xdr";

export interface CidFetchConfig {
  gatewayUrl: string;
  timeoutMs: number;
  maxMediaBytes: number;
  maxManifestBytes: number;
}

export interface CidFetchOptions {
  /** Abort the download once more than this many bytes have been received. */
  maxBytes: number;
  /** Expected SHA-256 of the content, as `<hex>` or `sha256:<hex>`. */
  expectedSha256?: string;
}

export interface FetchedCid {
  cid: string;
  bytes: Buffer;
  size: number;
  /** SHA-256 hex digest of `bytes`. */
  sha256: string;
}

export interface VerificationArtifacts {
  eventId: string;
  manifest: FetchedCid;
  media: FetchedCid;
}

/** The gateway could not deliver the content. */
export class CidFetchError extends AppError {
  public readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message, StatusCodes.BAD_GATEWAY, "CID_FETCH_FAILED");
    this.name = "CidFetchError";
    this.retryable = retryable;
    Object.setPrototypeOf(this, CidFetchError.prototype);
  }
}

/** The downloaded content does not hash to the expected digest. */
export class CidIntegrityError extends AppError {
  public readonly cid: string;
  public readonly expectedSha256: string;
  public readonly actualSha256: string;

  constructor(cid: string, expectedSha256: string, actualSha256: string) {
    super(
      `Content for ${cid} hashes to ${actualSha256}, expected ${expectedSha256}`,
      StatusCodes.UNPROCESSABLE_ENTITY,
      "CID_INTEGRITY_MISMATCH"
    );
    this.name = "CidIntegrityError";
    this.cid = cid;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
    Object.setPrototypeOf(this, CidIntegrityError.prototype);
  }
}

/** Accepts `<hex>` or `sha256:<hex>`, as written by the manifest pipeline. */
export function normalizeSha256(value: string): string | null {
  const hex = value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
  return /^[0-9a-fA-F]{64}$/.test(hex) ? hex.toLowerCase() : null;
}

type FetchFn = typeof fetch;

export class CidFetchService {
  constructor(
    private readonly config: CidFetchConfig,
    private readonly fetchFn: FetchFn = fetch
  ) {}

  /** Downloads a media CID within the configured media size cap. */
  fetchMedia(cid: string, expectedSha256?: string): Promise<FetchedCid> {
    return this.fetch(cid, { maxBytes: this.config.maxMediaBytes, expectedSha256 });
  }

  /** Downloads a manifest CID within the configured manifest size cap. */
  fetchManifest(cid: string, expectedSha256?: string): Promise<FetchedCid> {
    return this.fetch(cid, { maxBytes: this.config.maxManifestBytes, expectedSha256 });
  }

  /**
   * Loads a verification request from the database and downloads its
   * manifest and media, checking each against the digest recorded on the
   * request (`manifestHash` / `contentHash`) when one is present.
   *
   * @throws {AppError} 404 when no request exists for `eventId`.
   */
  async fetchVerificationArtifacts(eventId: string): Promise<VerificationArtifacts> {
    const event = await VerificationRequestEventModel.findOne({ eventId })
      .select("eventId mediaCid manifestCid contentHash manifestHash")
      .lean<Pick<IVerificationRequestEvent, "eventId" | "mediaCid" | "manifestCid" | "contentHash" | "manifestHash">>();
    if (!event) {
      throw new AppError(
        `Verification request not found: '${eventId}'`,
        StatusCodes.NOT_FOUND,
        "VERIFICATION_REQUEST_NOT_FOUND"
      );
    }

    const manifest = await this.fetchManifest(event.manifestCid, event.manifestHash);
    const media = await this.fetchMedia(event.mediaCid, event.contentHash);
    return { eventId: event.eventId, manifest, media };
  }

  /**
   * Downloads `cid` from the gateway and returns its bytes and SHA-256.
   *
   * @throws {XdrValidationError} when `cid` is not a CIDv0 or base32 CIDv1.
   * @throws {AppError} 400 when `expectedSha256` is not a SHA-256 digest.
   * @throws {CidFetchError} when the gateway fails, times out or the content
   *   exceeds `maxBytes`.
   * @throws {CidIntegrityError} when the content does not match `expectedSha256`.
   */
  async fetch(cid: string, options: CidFetchOptions): Promise<FetchedCid> {
    assertCid(cid, "cid");

    let expected: string | null = null;
    if (options.expectedSha256 !== undefined) {
      expected = normalizeSha256(options.expectedSha256);
      if (!expected) {
        throw new AppError(
          `Expected hash for ${cid} is not a SHA-256 hex digest`,
          StatusCodes.BAD_REQUEST,
          "INVALID_EXPECTED_HASH"
        );
      }
    }

    const bytes = await this.download(cid, options.maxBytes);
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (expected && expected !== sha256) {
      throw new CidIntegrityError(cid, expected, sha256);
    }

    return { cid, bytes, size: bytes.byteLength, sha256 };
  }

  private async download(cid: string, maxBytes: number): Promise<Buffer> {
    const url = `${this.config.gatewayUrl.replace(/\/+$/, "")}/${cid}`;
    const signal = AbortSignal.timeout(this.config.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchFn(url, { signal });
    } catch (err) {
      throw new CidFetchError(
        `Gateway request for ${cid} failed: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    }

    if (!response.ok) {
      // 404 is typical while content propagates; 5xx/429 are transient.
      const retryable =
        response.status === 404 || response.status === 429 || response.status >= 500;
      throw new CidFetchError(`Gateway returned HTTP ${response.status} for ${cid}`, retryable);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new CidFetchError(`${cid} exceeds the ${maxBytes}-byte limit`, false);
    }
    if (!response.body) {
      throw new CidFetchError(`Gateway returned an empty body for ${cid}`, true);
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new CidFetchError(`${cid} exceeds the ${maxBytes}-byte limit`, false);
        }
        chunks.push(Buffer.from(value));
      }
    } catch (err) {
      if (err instanceof CidFetchError) throw err;
      throw new CidFetchError(
        `Reading ${cid} from gateway failed: ${err instanceof Error ? err.message : String(err)}`,
        true
      );
    }

    return Buffer.concat(chunks);
  }
}

export const cidFetchService = new CidFetchService({
  gatewayUrl: env.PINATA_GATEWAY_URL,
  timeoutMs: env.SPV_FETCH_TIMEOUT_MS,
  maxMediaBytes: env.SPV_MAX_MEDIA_BYTES,
  maxManifestBytes: env.SPV_MAX_MANIFEST_BYTES,
});
