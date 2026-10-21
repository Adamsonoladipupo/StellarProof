/**
 * Certificate share links (issue #738): signed, limited-claim tokens that
 * resolve to certificate metadata without owner PII.
 *
 * Real MongoDB: mongodb-memory-server, seeded through the real models.
 */
import crypto from "crypto";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

import { CertificateShareService, type CertificateShareConfig } from "../certificateShare.service";
import Certificate from "../../models/Certificate.model";
import { AppError } from "../../errors/AppError";
import {
  clearCertificateFixtures,
  storeCertificate,
  storeUser,
  type StoredCertificate,
} from "./fixtures/certificate.fixture";

const config: CertificateShareConfig = {
  secret: crypto.randomBytes(32).toString("hex"),
  ttlSeconds: 3_600,
  publicAppUrl: "https://app.stellarproof.test/",
};
const service = new CertificateShareService(() => config);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (err: unknown) => err
  );
}

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterEach(clearCertificateFixtures);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("CertificateShareService.createShareLink", () => {
  let stored: StoredCertificate;

  beforeEach(async () => {
    stored = await storeCertificate();
  });

  it("issues a public page link carrying a signed token", async () => {
    const now = new Date();
    const link = await service.createShareLink(stored.certificateId, stored.owner, now);

    expect(link.certLink).toBe(
      `https://app.stellarproof.test/certificate/${stored.certificateId}?share=${link.token}`
    );
    expect(link.expiresAt).toBe(
      new Date((Math.floor(now.getTime() / 1_000) + config.ttlSeconds) * 1_000).toISOString()
    );
  });

  it("accepts the certificate's database id as well as its on-chain id", async () => {
    const link = await service.createShareLink(stored.documentId, stored.owner);
    const metadata = await service.resolveShareToken(link.token);
    expect(metadata.certificateId).toBe(stored.certificateId);
  });

  it("signs only the certificate id and network, with audience, issuer and expiry", async () => {
    const { token } = await service.createShareLink(stored.certificateId, stored.owner);
    const header = jwt.decode(token, { complete: true })?.header;
    const claims = jwt.decode(token) as Record<string, unknown>;

    expect(header?.alg).toBe("HS256");
    expect(Object.keys(claims).sort()).toEqual(["aud", "exp", "iat", "iss", "net", "sub"]);
    expect(claims).toMatchObject({
      sub: stored.certificateId,
      net: stored.network,
      aud: "stellarproof:certificate-share",
      iss: "stellarproof",
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(config.ttlSeconds);
  });

  it("keeps owner details out of the token", async () => {
    const { token } = await service.createShareLink(stored.certificateId, stored.owner);
    const decoded = JSON.stringify(jwt.decode(token));

    for (const pii of [stored.owner.id, stored.owner.email, stored.owner.stellarPublicKey, stored.fileName]) {
      expect(decoded).not.toContain(pii);
    }
  });

  it("is signed with a key that is not the session secret", async () => {
    const { token } = await service.createShareLink(stored.certificateId, stored.owner);
    expect(() => jwt.verify(token, config.secret)).toThrow(jwt.JsonWebTokenError);
  });

  it("lets an admin share a certificate they do not own", async () => {
    const admin = await storeUser("admin");
    await expect(service.createShareLink(stored.certificateId, admin)).resolves.toMatchObject({
      token: expect.any(String),
    });
  });

  it("refuses a requester who is neither owner nor admin", async () => {
    const stranger = await storeUser("creator");
    const err = await rejection(service.createShareLink(stored.certificateId, stranger));
    expect(err).toMatchObject({ statusCode: 403, code: "CERTIFICATE_SHARE_FORBIDDEN" });
  });

  it("returns 404 for an unknown certificate", async () => {
    const err = await rejection(service.createShareLink("999999999999", stored.owner));
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ statusCode: 404, code: "CERTIFICATE_NOT_FOUND" });
  });
});

describe("CertificateShareService.resolveShareToken", () => {
  it("returns on-chain proof metadata from the database and nothing about the owner", async () => {
    const stored = await storeCertificate({ network: "mainnet" });
    const { token } = await service.createShareLink(stored.certificateId, stored.owner);

    const metadata = await service.resolveShareToken(token);

    expect(metadata).toEqual({
      certificateId: stored.certificateId,
      network: "mainnet",
      contractAddress: stored.contractAddress,
      transactionHash: stored.transactionHash,
      ledgerSequence: stored.ledgerSequence,
      mintedAt: stored.mintedAt.toISOString(),
      contentHash: stored.contentHash,
      manifestHash: stored.manifestHash,
      explorerUrl: `https://stellar.expert/explorer/public/tx/${stored.transactionHash}`,
      revocation: { revoked: false, revokedAt: null },
    });
    const serialized = JSON.stringify(metadata);
    for (const pii of [stored.owner.id, stored.owner.email, stored.owner.stellarPublicKey, stored.fileName]) {
      expect(serialized).not.toContain(pii);
    }
  });

  it("reports a revocation recorded after the link was issued", async () => {
    const stored = await storeCertificate();
    const { token } = await service.createShareLink(stored.certificateId, stored.owner);
    const revokedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    await Certificate.updateOne({ certificateId: stored.certificateId }, { revoked: true, revokedAt });

    const metadata = await service.resolveShareToken(token);

    expect(metadata.revocation).toEqual({ revoked: true, revokedAt: revokedAt.toISOString() });
  });

  it("returns 410 for an expired token", async () => {
    const stored = await storeCertificate();
    const issuedLongAgo = new Date(Date.now() - (config.ttlSeconds + 60) * 1_000);
    const { token } = await service.createShareLink(stored.certificateId, stored.owner, issuedLongAgo);

    const err = await rejection(service.resolveShareToken(token));

    expect(err).toMatchObject({ statusCode: 410, code: "SHARE_TOKEN_EXPIRED" });
  });

  it("rejects a token whose payload was altered", async () => {
    const stored = await storeCertificate();
    const other = await storeCertificate({ owner: stored.owner });
    const { token } = await service.createShareLink(stored.certificateId, stored.owner);
    const [header, , signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...(jwt.decode(token) as object), sub: other.certificateId })
    ).toString("base64url");

    const err = await rejection(service.resolveShareToken(`${header}.${forgedPayload}.${signature}`));

    expect(err).toMatchObject({ statusCode: 401, code: "INVALID_SHARE_TOKEN" });
  });

  it("rejects a session token signed with the raw JWT secret", async () => {
    const stored = await storeCertificate();
    const sessionToken = jwt.sign({ userId: stored.owner.id }, config.secret, { expiresIn: "1h" });

    const err = await rejection(service.resolveShareToken(sessionToken));

    expect(err).toMatchObject({ statusCode: 401, code: "INVALID_SHARE_TOKEN" });
  });

  it("rejects a token for another audience even when correctly signed", async () => {
    const stored = await storeCertificate();
    const { token } = await service.createShareLink(stored.certificateId, stored.owner);
    const claims = jwt.decode(token) as Record<string, unknown>;
    const key = crypto.createHmac("sha256", config.secret).update("certificate-share-token").digest();
    const otherAudience = jwt.sign({ ...claims, aud: "stellarproof:session" }, key);

    const err = await rejection(service.resolveShareToken(otherAudience));

    expect(err).toMatchObject({ statusCode: 401, code: "INVALID_SHARE_TOKEN" });
  });

  it("rejects garbage", async () => {
    const err = await rejection(service.resolveShareToken("not-a-jwt"));
    expect(err).toMatchObject({ statusCode: 401, code: "INVALID_SHARE_TOKEN" });
  });

  it("returns 404 when the certificate was removed after sharing", async () => {
    const stored = await storeCertificate();
    const { token } = await service.createShareLink(stored.certificateId, stored.owner);
    await Certificate.deleteOne({ certificateId: stored.certificateId });

    const err = await rejection(service.resolveShareToken(token));

    expect(err).toMatchObject({ statusCode: 404, code: "CERTIFICATE_NOT_FOUND" });
  });
});
