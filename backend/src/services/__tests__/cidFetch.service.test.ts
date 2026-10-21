/**
 * CID fetch service: gateway download with size caps, timeouts and SHA-256
 * integrity re-hashing (issue #697).
 *
 * Real MongoDB:  mongodb-memory-server, for the request-backed lookup.
 * IPFS boundary: the gateway is a fetch stand-in returning real `Response`
 *                objects, so streaming and header handling run unchanged.
 */
jest.mock("../../config/env", () => ({
  env: {
    PINATA_GATEWAY_URL: "https://gateway.invalid/ipfs",
    SPV_FETCH_TIMEOUT_MS: 30_000,
    SPV_MAX_MEDIA_BYTES: 1_000_000,
    SPV_MAX_MANIFEST_BYTES: 100_000,
  },
}));

import crypto from "crypto";
import mongoose from "mongoose";
import { Keypair } from "@stellar/stellar-sdk";
import { MongoMemoryServer } from "mongodb-memory-server";

import {
  CidFetchError,
  CidFetchService,
  CidIntegrityError,
  normalizeSha256,
} from "../cidFetch.service";
import { VerificationRequestEventModel } from "../../models/verificationRequestEvent.model";
import { AppError } from "../../errors/AppError";
import { XdrValidationError } from "../../utils/xdr";

const MEDIA_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const MANIFEST_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const GATEWAY = "https://gateway.invalid/ipfs/";

const sha256 = (data: Buffer | string): string =>
  crypto.createHash("sha256").update(data).digest("hex");

const media = crypto.randomBytes(2_048);
const manifest = JSON.stringify({
  contentHash: `sha256:${sha256(media)}`,
  creator: Keypair.random().publicKey(),
});

type Route = Buffer | string | number | (() => Response);

/** Gateway stand-in serving fixed bodies (or statuses) per CID. */
function gateway(routes: Record<string, Route>): jest.Mock {
  return jest.fn(async (url: string) => {
    const cid = url.slice(url.lastIndexOf("/") + 1);
    const route = routes[cid];
    if (typeof route === "function") return route();
    if (typeof route === "number") return new Response(null, { status: route });
    return new Response(typeof route === "string" ? route : new Uint8Array(route));
  });
}

function service(
  fetchFn: jest.Mock,
  limits: Partial<{ maxMediaBytes: number; maxManifestBytes: number; timeoutMs: number }> = {}
): CidFetchService {
  return new CidFetchService(
    {
      gatewayUrl: GATEWAY,
      timeoutMs: limits.timeoutMs ?? 1_000,
      maxMediaBytes: limits.maxMediaBytes ?? 1_000_000,
      maxManifestBytes: limits.maxManifestBytes ?? 100_000,
    },
    fetchFn as unknown as typeof fetch
  );
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (err: unknown) => err
  );
}

describe("CidFetchService.fetch", () => {
  it("downloads a CID from the configured gateway and re-hashes it", async () => {
    const fetchFn = gateway({ [MEDIA_CID]: media });

    const result = await service(fetchFn).fetchMedia(MEDIA_CID);

    expect(fetchFn).toHaveBeenCalledWith(
      `https://gateway.invalid/ipfs/${MEDIA_CID}`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(result).toEqual({
      cid: MEDIA_CID,
      bytes: media,
      size: media.length,
      sha256: sha256(media),
    });
  });

  it.each([
    ["a bare hex digest", () => sha256(media)],
    ["a sha256:-prefixed digest", () => `sha256:${sha256(media)}`],
    ["an upper-case digest", () => sha256(media).toUpperCase()],
  ])("accepts content matching %s", async (_label, expected) => {
    const result = await service(gateway({ [MEDIA_CID]: media })).fetchMedia(MEDIA_CID, expected());
    expect(result.sha256).toBe(sha256(media));
  });

  it("rejects content whose digest does not match the expected hash", async () => {
    const tampered = Buffer.concat([media, Buffer.from([0])]);
    const err = await rejection(
      service(gateway({ [MEDIA_CID]: tampered })).fetchMedia(MEDIA_CID, sha256(media))
    );

    expect(err).toBeInstanceOf(CidIntegrityError);
    expect(err).toMatchObject({
      statusCode: 422,
      code: "CID_INTEGRITY_MISMATCH",
      cid: MEDIA_CID,
      expectedSha256: sha256(media),
      actualSha256: sha256(tampered),
    });
  });

  it("rejects an expected hash that is not a SHA-256 digest before downloading", async () => {
    const fetchFn = gateway({ [MEDIA_CID]: media });
    const err = await rejection(service(fetchFn).fetchMedia(MEDIA_CID, "not-a-digest"));

    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 400, code: "INVALID_EXPECTED_HASH" });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects malformed CIDs without contacting the gateway", async () => {
    const fetchFn = gateway({});
    await expect(service(fetchFn).fetchMedia("not-a-cid")).rejects.toThrow(XdrValidationError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [404, true],
    [429, true],
    [503, true],
    [400, false],
    [403, false],
  ])("maps gateway HTTP %i to CidFetchError(retryable=%s)", async (status, retryable) => {
    const err = await rejection(service(gateway({ [MEDIA_CID]: status })).fetchMedia(MEDIA_CID));

    expect(err).toBeInstanceOf(CidFetchError);
    expect(err).toMatchObject({ statusCode: 502, code: "CID_FETCH_FAILED", retryable });
  });

  it("treats network failures as retryable", async () => {
    const fetchFn = jest.fn().mockRejectedValue(new TypeError("fetch failed"));
    const err = await rejection(service(fetchFn).fetchManifest(MANIFEST_CID));

    expect(err).toBeInstanceOf(CidFetchError);
    expect((err as CidFetchError).retryable).toBe(true);
  });

  it("aborts a download that exceeds the timeout", async () => {
    const fetchFn = jest.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        })
    );
    const err = await rejection(service(fetchFn, { timeoutMs: 50 }).fetchMedia(MEDIA_CID));

    expect(err).toBeInstanceOf(CidFetchError);
    expect((err as CidFetchError).retryable).toBe(true);
    expect((err as CidFetchError).message).toMatch(/timeout|aborted/i);
  });

  it("refuses content whose declared length exceeds the cap", async () => {
    const fetchFn = gateway({
      [MEDIA_CID]: () =>
        new Response(new Uint8Array(media), { headers: { "content-length": String(media.length) } }),
    });
    const err = await rejection(
      service(fetchFn, { maxMediaBytes: media.length - 1 }).fetchMedia(MEDIA_CID)
    );

    expect(err).toBeInstanceOf(CidFetchError);
    expect(err).toMatchObject({ retryable: false });
    expect((err as CidFetchError).message).toContain(`${media.length - 1}-byte limit`);
  });

  it("aborts a streamed body once it exceeds the cap, even without content-length", async () => {
    let cancelled = false;
    const chunk = new Uint8Array(1_024);
    const fetchFn = gateway({
      [MEDIA_CID]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(chunk);
            },
            cancel() {
              cancelled = true;
            },
          })
        ),
    });
    const err = await rejection(service(fetchFn, { maxMediaBytes: 4_096 }).fetchMedia(MEDIA_CID));

    expect(err).toBeInstanceOf(CidFetchError);
    expect(err).toMatchObject({ retryable: false });
    expect(cancelled).toBe(true);
  });

  it("applies the manifest cap to manifests and the media cap to media", async () => {
    const fetchFn = gateway({ [MEDIA_CID]: media, [MANIFEST_CID]: manifest });
    const limited = service(fetchFn, {
      maxMediaBytes: media.length,
      maxManifestBytes: Buffer.byteLength(manifest) - 1,
    });

    await expect(limited.fetchMedia(MEDIA_CID)).resolves.toMatchObject({ size: media.length });
    await expect(limited.fetchManifest(MANIFEST_CID)).rejects.toBeInstanceOf(CidFetchError);
  });
});

describe("normalizeSha256", () => {
  it("normalises bare and prefixed digests and rejects anything else", () => {
    const digest = sha256("x");
    expect(normalizeSha256(digest.toUpperCase())).toBe(digest);
    expect(normalizeSha256(`sha256:${digest}`)).toBe(digest);
    expect(normalizeSha256(digest.slice(1))).toBeNull();
    expect(normalizeSha256(`md5:${digest}`)).toBeNull();
  });
});

describe("CidFetchService.fetchVerificationArtifacts", () => {
  let mongo: MongoMemoryServer;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await VerificationRequestEventModel.init();
  });

  afterEach(async () => {
    await VerificationRequestEventModel.deleteMany({});
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });

  async function storeRequest(hashes: { contentHash?: string; manifestHash?: string }): Promise<string> {
    const eventId = new mongoose.Types.ObjectId().toString();
    await VerificationRequestEventModel.create({
      eventId,
      mediaCid: MEDIA_CID,
      manifestCid: MANIFEST_CID,
      requester: Keypair.random().publicKey(),
      ...hashes,
    });
    return eventId;
  }

  it("fetches the stored request's media and manifest and checks the recorded digests", async () => {
    const eventId = await storeRequest({
      contentHash: `sha256:${sha256(media)}`,
      manifestHash: sha256(manifest),
    });
    const fetchFn = gateway({ [MEDIA_CID]: media, [MANIFEST_CID]: manifest });

    const artifacts = await service(fetchFn).fetchVerificationArtifacts(eventId);

    expect(artifacts.eventId).toBe(eventId);
    expect(artifacts.media).toMatchObject({ cid: MEDIA_CID, sha256: sha256(media), size: media.length });
    expect(artifacts.manifest).toMatchObject({ cid: MANIFEST_CID, sha256: sha256(manifest) });
    expect(artifacts.manifest.bytes.toString("utf8")).toBe(manifest);
  });

  it("downloads without a digest check when the request has no recorded hashes yet", async () => {
    const eventId = await storeRequest({});
    const fetchFn = gateway({ [MEDIA_CID]: media, [MANIFEST_CID]: manifest });

    const artifacts = await service(fetchFn).fetchVerificationArtifacts(eventId);

    expect(artifacts.media.sha256).toBe(sha256(media));
    expect(artifacts.manifest.sha256).toBe(sha256(manifest));
  });

  it("fails integrity when the gateway serves different media than was recorded", async () => {
    const eventId = await storeRequest({ contentHash: sha256(media), manifestHash: sha256(manifest) });
    const fetchFn = gateway({ [MEDIA_CID]: crypto.randomBytes(64), [MANIFEST_CID]: manifest });

    const err = await rejection(service(fetchFn).fetchVerificationArtifacts(eventId));

    expect(err).toBeInstanceOf(CidIntegrityError);
    expect(err).toMatchObject({ cid: MEDIA_CID, expectedSha256: sha256(media) });
  });

  it("returns 404 for an unknown request", async () => {
    const fetchFn = gateway({});
    const err = await rejection(service(fetchFn).fetchVerificationArtifacts("does-not-exist"));

    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 404, code: "VERIFICATION_REQUEST_NOT_FOUND" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
