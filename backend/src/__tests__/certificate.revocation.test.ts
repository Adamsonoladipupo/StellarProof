/**
 * Off-chain certificate revocation and the revocation flag in verification.
 * The Certificate model is mocked; the service and HTTP wiring are real.
 */
import mongoose from "mongoose";
import request from "supertest";
import express, { type NextFunction, type Request, type Response } from "express";
import Certificate from "../models/Certificate.model";
import certificateRoutes from "../routes/certificate.routes";
import certificateRevocationRoutes from "../routes/certificate.revocation.routes";
import { CertificateService, certificateService } from "../services/certificate.service";
import { AppError } from "../errors/AppError";
import type { OnChainCertificate } from "../services/contracts/ProvenanceContract";

// The routes pull in the auth stack, which validates the full environment on
// import. These tests never reach a real service, so placeholder values suffice.
jest.mock("../config/env", () => ({
  env: new Proxy({ JWT_SECRET: "test-secret", JWT_EXPIRES_IN: "1h" }, {
    get: (target, key: string) => (key in target ? target[key as keyof typeof target] : "test"),
  }),
}));

jest.mock("../models/Certificate.model", () => {
  const model: any = {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    countDocuments: jest.fn(),
    distinct: jest.fn(),
    aggregate: jest.fn(),
  };
  return { __esModule: true, default: model };
});

const CertificateModel = Certificate as unknown as {
  findOne: jest.Mock;
  findOneAndUpdate: jest.Mock;
};

const OWNER_ID = new mongoose.Types.ObjectId().toHexString();
const OTHER_ID = new mongoose.Types.ObjectId().toHexString();
const CERT_OID = new mongoose.Types.ObjectId();
const NOW = new Date("2026-10-19T12:00:00.000Z");

/** Mocks the owner lookup used before a revocation. */
function mockLookup(doc: { _id: mongoose.Types.ObjectId; creatorId: mongoose.Types.ObjectId } | null) {
  CertificateModel.findOne.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(doc) }),
  });
}

describe("CertificateService.revokeCertificate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("lets the owner revoke, recording the time and the actor", async () => {
    mockLookup({ _id: CERT_OID, creatorId: new mongoose.Types.ObjectId(OWNER_ID) });
    const updated = { _id: CERT_OID, revoked: true, revokedAt: NOW };
    CertificateModel.findOneAndUpdate.mockResolvedValue(updated);

    const result = await certificateService.revokeCertificate(
      CERT_OID.toHexString(),
      { id: OWNER_ID, role: "creator" },
      NOW
    );

    expect(result).toBe(updated);
    expect(CertificateModel.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: CERT_OID, revoked: { $ne: true } },
      {
        $set: {
          revoked: true,
          revokedAt: NOW,
          revokedBy: new mongoose.Types.ObjectId(OWNER_ID),
        },
      },
      { new: true }
    );
  });

  it("lets an admin revoke a certificate they do not own", async () => {
    mockLookup({ _id: CERT_OID, creatorId: new mongoose.Types.ObjectId(OWNER_ID) });
    CertificateModel.findOneAndUpdate.mockResolvedValue({ _id: CERT_OID, revoked: true });

    await expect(
      certificateService.revokeCertificate(CERT_OID.toHexString(), { id: OTHER_ID, role: "admin" }, NOW)
    ).resolves.toBeDefined();
  });

  it("forbids a different creator and leaves the certificate untouched", async () => {
    mockLookup({ _id: CERT_OID, creatorId: new mongoose.Types.ObjectId(OWNER_ID) });

    const error = await certificateService
      .revokeCertificate(CERT_OID.toHexString(), { id: OTHER_ID, role: "creator" }, NOW)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ statusCode: 403, code: "CERTIFICATE_REVOCATION_FORBIDDEN" });
    expect(CertificateModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("returns 409 when the certificate was already revoked", async () => {
    mockLookup({ _id: CERT_OID, creatorId: new mongoose.Types.ObjectId(OWNER_ID) });
    CertificateModel.findOneAndUpdate.mockResolvedValue(null);

    await expect(
      certificateService.revokeCertificate(CERT_OID.toHexString(), { id: OWNER_ID, role: "creator" }, NOW)
    ).rejects.toMatchObject({ statusCode: 409, code: "CERTIFICATE_ALREADY_REVOKED" });
  });

  it("returns 404 for an unknown certificate", async () => {
    mockLookup(null);

    await expect(
      certificateService.revokeCertificate("missing-cert", { id: OWNER_ID, role: "creator" }, NOW)
    ).rejects.toMatchObject({ statusCode: 404, code: "CERTIFICATE_NOT_FOUND" });
    expect(CertificateModel.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("CertificateService.verifyCertificate revocation status", () => {
  const CREATOR = new mongoose.Types.ObjectId();
  const MINTED_AT = new Date("2026-10-01T00:00:00.000Z");

  /** Cache document whose off-chain fields match `onChain` exactly. */
  function cachedDoc(overrides: Record<string, unknown> = {}) {
    return {
      certificateId: "41",
      contractAddress: "CONTRACT",
      stellarNetwork: "testnet",
      mintedAt: MINTED_AT,
      assetId: { storageReferenceId: "cid-1" },
      manifestId: { manifestHash: "ab", creator: "GCREATOR" },
      creatorId: { stellarPublicKey: "GCREATOR" },
      verificationJobId: { ownerPublicKey: "GCREATOR", teeAttestationHash: "cd" },
      ...overrides,
    };
  }

  const onChain: OnChainCertificate = {
    storageId: "cid-1",
    manifestHash: "ab",
    attestationHash: "cd",
    creator: "GCREATOR",
    timestamp: MINTED_AT,
  } as unknown as OnChainCertificate;

  function serviceWith(doc: Record<string, unknown>) {
    const chain: any = {
      populate: () => chain,
      lean: () => Promise.resolve(doc),
    };
    CertificateModel.findOne.mockReturnValue(chain);
    return new CertificateService(() => ({ getCertificate: jest.fn().mockResolvedValue(onChain) }));
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reports an active certificate as not revoked", async () => {
    const result = await serviceWith(cachedDoc()).verifyCertificate("41");

    expect(result.details.revocation).toEqual({ revoked: false, revokedAt: null });
  });

  it("reports a revoked certificate without changing the on-chain verdict", async () => {
    const revokedAt = new Date("2026-10-10T08:00:00.000Z");
    const result = await serviceWith(cachedDoc({ revoked: true, revokedAt })).verifyCertificate("41");

    expect(result.valid).toBe(true);
    expect(result.details.mismatches).toEqual([]);
    expect(result.details.revocation).toEqual({ revoked: true, revokedAt: revokedAt.toISOString() });
  });

  it("treats cache documents written before the flag existed as not revoked", async () => {
    const result = await serviceWith(cachedDoc()).verifyCertificate("41");
    expect(result.details.revocation.revoked).toBe(false);
  });
});

describe("certificate HTTP routes", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/v1/certificates", certificateRoutes);
  app.use("/api/v1/certificates", certificateRevocationRoutes);
  // Minimal stand-in for the global error handler's AppError mapping.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ success: false, error: String(err) });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("requires a bearer token to revoke", async () => {
    const res = await request(app).post(`/api/v1/certificates/${CERT_OID.toHexString()}/revoke`);

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(CertificateModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("rejects a stats request without a valid creatorId before touching the database", async () => {
    const res = await request(app).get("/api/v1/certificates/stats");

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: "INVALID_CREATOR_ID" });
    expect(CertificateModel.findOne).not.toHaveBeenCalled();
  });
});
