import crypto from "crypto";
import express from "express";
import request from "supertest";
import { Keypair } from "@stellar/stellar-sdk";

jest.mock("../config/env", () => ({ env: { NODE_ENV: "test" } }));
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));
// Unrelated controller dependencies; not exercised by this route.
jest.mock("../services/verification.service", () => ({ verificationService: {} }));
jest.mock("../services/statusStream.service", () => ({ statusStreamService: {} }));

const findOne = jest.fn();
const findById = jest.fn();
jest.mock("../models/spv.model", () => ({
  SPVRecordModel: {
    findOne: (...a: unknown[]) => findOne(...a),
    findById: (...a: unknown[]) => findById(...a),
  },
}));

import spvSignatureRoutes from "../routes/v1/spvSignature.routes";
import { globalErrorHandler } from "../middlewares/errorHandler";

const lean = (value: unknown) => ({ lean: () => ({ exec: async () => value }) });
const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

const owner = Keypair.random();
const contentHash = sha256("original media bytes");
const sign = (kp: Keypair, hashHex: string): string =>
  kp.sign(Buffer.from(hashHex, "hex")).toString("hex");
const SPV_ID = "64b7f0c2a1b2c3d4e5f60718";
const record = { _id: SPV_ID, ownerPublicKey: owner.publicKey(), contentHash };

const app = express();
app.use(express.json());
app.use("/api/v1/verification", spvSignatureRoutes);
app.use(globalErrorHandler);

const URL = "/api/v1/verification/verify-signature";

describe("POST /api/v1/verification/verify-signature", () => {
  beforeEach(() => {
    findOne.mockReset().mockReturnValue(lean(record));
    findById.mockReset().mockReturnValue(lean(record));
  });

  it("returns 200 { valid: true } for a valid signature", async () => {
    const res = await request(app)
      .post(URL)
      .send({ contentHashHex: contentHash, signatureHex: sign(owner, contentHash) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { valid: true, spvId: SPV_ID, publicKey: owner.publicKey() },
    });
  });

  it("looks the record up by spvId when provided", async () => {
    const res = await request(app)
      .post(URL)
      .send({ contentHashHex: contentHash, signatureHex: sign(owner, contentHash), spvId: SPV_ID });
    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(true);
    expect(findById).toHaveBeenCalledWith(SPV_ID);
  });

  it("returns 200 { valid: false, reason } for a signature from another key", async () => {
    const res = await request(app)
      .post(URL)
      .send({ contentHashHex: contentHash, signatureHex: sign(Keypair.random(), contentHash) });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ valid: false, reason: "SIGNATURE_MISMATCH" });
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app).post(URL).send({});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: "VALIDATION_ERROR" });
  });

  it("returns 400 for a malformed signature", async () => {
    const res = await request(app).post(URL).send({ contentHashHex: contentHash, signatureHex: "abcd" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("signatureHex");
  });

  it("returns 400 for a malformed spvId and for unknown fields", async () => {
    const bad = await request(app)
      .post(URL)
      .send({ contentHashHex: contentHash, signatureHex: sign(owner, contentHash), spvId: "nope" });
    expect(bad.status).toBe(400);
    const extra = await request(app)
      .post(URL)
      .send({ contentHashHex: contentHash, signatureHex: sign(owner, contentHash), extra: 1 });
    expect(extra.status).toBe(400);
  });

  it("returns 404 when no SPV record exists", async () => {
    findOne.mockReturnValue(lean(null));
    const res = await request(app)
      .post(URL)
      .send({ contentHashHex: contentHash, signatureHex: sign(owner, contentHash) });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: "SPV_RECORD_NOT_FOUND" });
  });
});
