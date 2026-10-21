/**
 * HTTP contract of the certificate share (#738) and export (#739) endpoints:
 * GET /api/v1/certificates/:id/share, /share/:token, /:id/export.json and
 * /:id/export.pdf.
 *
 * Real MongoDB (mongodb-memory-server) and the real `protect` middleware:
 * callers authenticate with a session JWT for a stored user.
 */
const JWT_SECRET = require("crypto").randomBytes(32).toString("hex") as string;

jest.mock("../config/env", () => ({
  env: {
    NODE_ENV: "test",
    JWT_SECRET,
    JWT_EXPIRES_IN: "1h",
    PUBLIC_APP_URL: "https://app.stellarproof.test",
    CERTIFICATE_SHARE_TOKEN_TTL_SECONDS: 3_600,
  },
}));
// The controller module also wires the list/verify/stats handlers; their
// service is not exercised by these routes.
jest.mock("../services/certificate.service", () => ({ certificateService: {} }));

import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import request from "supertest";
import { MongoMemoryServer } from "mongodb-memory-server";

import certificateRoutes from "../routes/certificate.routes";
import certificateAuthenticatedRoutes from "../routes/certificate.revocation.routes";
import { globalErrorHandler } from "../middlewares/errorHandler";
import {
  clearCertificateFixtures,
  storeCertificate,
  storeUser,
  type StoredCertificate,
  type StoredUser,
} from "../services/__tests__/fixtures/certificate.fixture";

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/certificates", certificateRoutes);
  app.use("/api/v1/certificates", certificateAuthenticatedRoutes);
  app.use(globalErrorHandler);
  return app;
}

const bearer = (user: StoredUser): string =>
  `Bearer ${jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: "1h" })}`;

let mongo: MongoMemoryServer;
const app = buildApp();

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterEach(clearCertificateFixtures);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("GET /api/v1/certificates/:id/share", () => {
  let stored: StoredCertificate;

  beforeEach(async () => {
    stored = await storeCertificate();
  });

  it("returns a signed share link to the owner", async () => {
    const res = await request(app)
      .get(`/api/v1/certificates/${stored.certificateId}/share`)
      .set("Authorization", bearer(stored.owner));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      certLink: `https://app.stellarproof.test/certificate/${stored.certificateId}?share=${res.body.data.token}`,
      token: expect.any(String),
      expiresAt: expect.any(String),
    });
  });

  it("requires authentication", async () => {
    const res = await request(app).get(`/api/v1/certificates/${stored.certificateId}/share`);
    expect(res.status).toBe(401);
  });

  it("returns 403 to another creator", async () => {
    const stranger = await storeUser();
    const res = await request(app)
      .get(`/api/v1/certificates/${stored.certificateId}/share`)
      .set("Authorization", bearer(stranger));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CERTIFICATE_SHARE_FORBIDDEN");
  });

  it("returns 404 for an unknown certificate", async () => {
    const res = await request(app)
      .get("/api/v1/certificates/999999999999/share")
      .set("Authorization", bearer(stored.owner));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe("CERTIFICATE_NOT_FOUND");
  });
});

describe("GET /api/v1/certificates/share/:token", () => {
  it("resolves a share token publicly, without owner PII", async () => {
    const stored = await storeCertificate();
    const share = await request(app)
      .get(`/api/v1/certificates/${stored.certificateId}/share`)
      .set("Authorization", bearer(stored.owner));

    const res = await request(app).get(`/api/v1/certificates/share/${share.body.data.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      certificateId: stored.certificateId,
      transactionHash: stored.transactionHash,
      explorerUrl: `https://stellar.expert/explorer/testnet/tx/${stored.transactionHash}`,
    });
    const body = JSON.stringify(res.body);
    for (const pii of [stored.owner.id, stored.owner.email, stored.owner.stellarPublicKey, stored.fileName]) {
      expect(body).not.toContain(pii);
    }
  });

  it("returns 401 for an invalid token", async () => {
    const res = await request(app).get("/api/v1/certificates/share/not-a-token");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("INVALID_SHARE_TOKEN");
  });

  it("does not accept a session token as a share token", async () => {
    const stored = await storeCertificate();
    const sessionToken = bearer(stored.owner).slice("Bearer ".length);

    const res = await request(app).get(`/api/v1/certificates/share/${sessionToken}`);

    expect(res.status).toBe(401);
  });
});

describe("GET /api/v1/certificates/:id/export.json", () => {
  it("downloads the verifiable JSON export", async () => {
    const stored = await storeCertificate();

    const res = await request(app)
      .get(`/api/v1/certificates/${stored.certificateId}/export.json`)
      .set("Authorization", bearer(stored.owner));

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="stellarproof-certificate-${stored.certificateId}.json"`
    );
    expect(res.body).toMatchObject({
      version: 1,
      certificate: { certificateId: stored.certificateId, transactionHash: stored.transactionHash },
      proof: { signature: stored.teeSignature, manifestHash: stored.manifestHash },
      links: { explorerUrl: `https://stellar.expert/explorer/testnet/tx/${stored.transactionHash}` },
    });
  });

  it("returns 403 to another creator", async () => {
    const stored = await storeCertificate();
    const stranger = await storeUser();

    const res = await request(app)
      .get(`/api/v1/certificates/${stored.certificateId}/export.json`)
      .set("Authorization", bearer(stranger));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("CERTIFICATE_EXPORT_FORBIDDEN");
  });
});

describe("GET /api/v1/certificates/:id/export.pdf", () => {
  it("downloads a PDF", async () => {
    const stored = await storeCertificate();

    const res = await request(app)
      .get(`/api/v1/certificates/${stored.certificateId}/export.pdf`)
      .set("Authorization", bearer(stored.owner))
      .responseType("blob");

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="stellarproof-certificate-${stored.certificateId}.pdf"`
    );
    const pdf = res.body as Buffer;
    expect(Number(res.headers["content-length"])).toBe(pdf.length);
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("requires authentication", async () => {
    const stored = await storeCertificate();
    const res = await request(app).get(`/api/v1/certificates/${stored.certificateId}/export.pdf`);
    expect(res.status).toBe(401);
  });
});
