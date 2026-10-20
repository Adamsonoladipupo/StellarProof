import crypto from "crypto";
import { Keypair } from "@stellar/stellar-sdk";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const findById = jest.fn();
const findOne = jest.fn();
jest.mock("../models/spv.model", () => ({
  SPVRecordModel: {
    findById: (...args: unknown[]) => findById(...args),
    findOne: (...args: unknown[]) => findOne(...args),
  },
}));

import { AppError } from "../errors/AppError";
import { SpvSignatureService } from "../services/spvSignature.service";

const sha256 = (data: string): string => crypto.createHash("sha256").update(data).digest("hex");
const lean = (value: unknown) => ({ lean: () => ({ exec: async () => value }) });

const owner = Keypair.random();
const contentHash = sha256("original media bytes");
const signHash = (kp: Keypair, hashHex: string): string =>
  kp.sign(Buffer.from(hashHex, "hex")).toString("hex");

const SPV_ID = "64b7f0c2a1b2c3d4e5f60718";
const record = {
  _id: SPV_ID,
  ownerPublicKey: owner.publicKey(),
  contentHash,
  manifestHash: sha256("manifest"),
  encryptedPayload: "cipher",
  storageId: "Qm...",
  accessType: "public",
};

describe("SpvSignatureService.verify", () => {
  const service = new SpvSignatureService();

  beforeEach(() => {
    findById.mockReset();
    findOne.mockReset();
    findById.mockReturnValue(lean(record));
    findOne.mockReturnValue(lean(record));
  });

  it("accepts a valid signature looked up by contentHash", async () => {
    const result = await service.verify({
      contentHashHex: contentHash,
      signatureHex: signHash(owner, contentHash),
    });
    expect(result).toEqual({ valid: true, spvId: SPV_ID, publicKey: owner.publicKey() });
    expect(findOne).toHaveBeenCalledTimes(1);
    expect(findById).not.toHaveBeenCalled();
  });

  it("accepts a valid signature looked up by spvId", async () => {
    const result = await service.verify({
      contentHashHex: contentHash,
      signatureHex: signHash(owner, contentHash),
      spvId: SPV_ID,
    });
    expect(result.valid).toBe(true);
    expect(findById).toHaveBeenCalledWith(SPV_ID);
    expect(findOne).not.toHaveBeenCalled();
  });

  it("accepts a sha256:-prefixed hash and uppercase hex", async () => {
    const result = await service.verify({
      contentHashHex: `sha256:${contentHash.toUpperCase()}`,
      signatureHex: signHash(owner, contentHash).toUpperCase(),
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a signature made by a different key", async () => {
    const result = await service.verify({
      contentHashHex: contentHash,
      signatureHex: signHash(Keypair.random(), contentHash),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("SIGNATURE_MISMATCH");
    expect(result.publicKey).toBe(owner.publicKey());
  });

  it("rejects a signature over a different hash", async () => {
    const result = await service.verify({
      contentHashHex: contentHash,
      signatureHex: signHash(owner, sha256("tampered")),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("SIGNATURE_MISMATCH");
  });

  it("rejects when the submitted hash differs from the stored record (spvId given)", async () => {
    const other = sha256("other content");
    const result = await service.verify({
      contentHashHex: other,
      signatureHex: signHash(owner, other),
      spvId: SPV_ID,
    });
    expect(result).toMatchObject({ valid: false, reason: "CONTENT_HASH_MISMATCH", spvId: SPV_ID });
  });

  it("returns INVALID_CONTENT_HASH_FORMAT without touching the database", async () => {
    const result = await service.verify({ contentHashHex: "abc", signatureHex: "00".repeat(64) });
    expect(result).toMatchObject({ valid: false, reason: "INVALID_CONTENT_HASH_FORMAT" });
    expect(findOne).not.toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  it("returns INVALID_SIGNATURE_FORMAT for a wrong-length signature", async () => {
    const result = await service.verify({ contentHashHex: contentHash, signatureHex: "abcd" });
    expect(result).toMatchObject({ valid: false, reason: "INVALID_SIGNATURE_FORMAT" });
    expect(findOne).not.toHaveBeenCalled();
  });

  it("returns INVALID_PUBLIC_KEY when the stored key is malformed", async () => {
    findOne.mockReturnValue(lean({ ...record, ownerPublicKey: "not-a-stellar-key" }));
    const result = await service.verify({
      contentHashHex: contentHash,
      signatureHex: signHash(owner, contentHash),
    });
    expect(result).toMatchObject({ valid: false, reason: "INVALID_PUBLIC_KEY" });
  });

  it("throws a 404 AppError when no SPV record exists", async () => {
    findOne.mockReturnValue(lean(null));
    await expect(
      service.verify({ contentHashHex: contentHash, signatureHex: signHash(owner, contentHash) }),
    ).rejects.toMatchObject({ statusCode: 404, code: "SPV_RECORD_NOT_FOUND" });
  });

  it("throws a 400 AppError for a malformed spvId", async () => {
    const promise = service.verify({
      contentHashHex: contentHash,
      signatureHex: signHash(owner, contentHash),
      spvId: "not-an-object-id",
    });
    await expect(promise).rejects.toBeInstanceOf(AppError);
    await expect(promise).rejects.toMatchObject({ statusCode: 400, code: "INVALID_SPV_ID" });
  });
});
