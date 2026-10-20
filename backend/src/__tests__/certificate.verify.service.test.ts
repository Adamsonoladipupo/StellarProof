import { CertificateService } from "../services/certificate.service";
import Certificate from "../models/Certificate.model";
import type { OnChainCertificate } from "../services/contracts/ProvenanceContract";
import { AppError } from "../errors/AppError";

jest.mock("../models/Certificate.model");

const CertificateMock = Certificate as unknown as { findOne: jest.Mock };

const CERT_ID = "42";
const MANIFEST_HASH = "ab".repeat(32);
const ATTESTATION_HASH = "cd".repeat(32);
const CREATOR = "GCREATORPUBLICKEYFORTESTSONLYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const MINTED_AT = new Date("2026-01-01T00:00:00.000Z");

/** Cache row as returned by the populated `Certificate.findOne` lookup. */
function cachedRow(overrides: Record<string, unknown> = {}) {
  return {
    certificateId: CERT_ID,
    contractAddress: "CCONTRACTFORTESTSONLY",
    stellarNetwork: "testnet",
    mintedAt: MINTED_AT,
    assetId: { storageReferenceId: "bafy-storage" },
    manifestId: { manifestHash: MANIFEST_HASH, creator: CREATOR },
    creatorId: { stellarPublicKey: CREATOR },
    verificationJobId: { ownerPublicKey: CREATOR, teeAttestationHash: ATTESTATION_HASH },
    ...overrides,
  };
}

/** The on-chain record that matches `cachedRow()` exactly. */
function onChainRecord(overrides: Partial<OnChainCertificate> = {}): OnChainCertificate {
  return {
    storageId: "bafy-storage",
    manifestHash: MANIFEST_HASH,
    attestationHash: ATTESTATION_HASH,
    creator: CREATOR,
    timestamp: MINTED_AT,
    ...overrides,
  };
}

/** Wires the populate().lean() chain used by the verification lookup. */
function mockCachedRow(row: unknown) {
  const chain: { populate: jest.Mock; lean: jest.Mock } = {
    populate: jest.fn(),
    lean: jest.fn().mockResolvedValue(row),
  };
  chain.populate.mockReturnValue(chain);
  CertificateMock.findOne.mockReturnValue(chain);
}

describe("CertificateService.verifyCertificate", () => {
  let getCertificate: jest.Mock;
  let service: CertificateService;

  beforeEach(() => {
    jest.clearAllMocks();
    getCertificate = jest.fn();
    service = new CertificateService(() => ({ getCertificate }));
  });

  it("reports valid when the cached row matches the live on-chain record", async () => {
    mockCachedRow(cachedRow());
    getCertificate.mockResolvedValue(onChainRecord());

    const { valid, details } = await service.verifyCertificate(CERT_ID);

    expect(valid).toBe(true);
    expect(details.mismatches).toEqual([]);
    expect(Object.values(details.checks).every(Boolean)).toBe(true);
  });

  it("fetches the record on-chain for a cached certificate (live read)", async () => {
    mockCachedRow(cachedRow());
    getCertificate.mockResolvedValue(onChainRecord());

    await service.verifyCertificate(CERT_ID);

    expect(getCertificate).toHaveBeenCalledTimes(1);
    expect(getCertificate).toHaveBeenCalledWith(CERT_ID);
  });

  it("returns 404 without a chain read when the certificate is not cached", async () => {
    mockCachedRow(null);

    await expect(service.verifyCertificate(CERT_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: "CERTIFICATE_NOT_FOUND",
    });
    expect(getCertificate).not.toHaveBeenCalled();
  });

  it("rejects a blank certificate id without touching the cache or the chain", async () => {
    await expect(service.verifyCertificate("   ")).rejects.toBeInstanceOf(AppError);
    expect(CertificateMock.findOne).not.toHaveBeenCalled();
    expect(getCertificate).not.toHaveBeenCalled();
  });

  it("flags a tampered manifest hash and reports the single mismatched field", async () => {
    mockCachedRow(cachedRow());
    getCertificate.mockResolvedValue(onChainRecord({ manifestHash: "ef".repeat(32) }));

    const { valid, details } = await service.verifyCertificate(CERT_ID);

    expect(valid).toBe(false);
    expect(details.mismatches).toEqual(["manifestHash"]);
    expect(details.checks.storageId).toBe(true);
    expect(details.onChain?.manifestHash).toBe("ef".repeat(32));
  });

  it("lists each mismatched field when the storage id and creator both differ", async () => {
    mockCachedRow(cachedRow());
    getCertificate.mockResolvedValue(
      onChainRecord({ storageId: "bafy-other", creator: "GOTHERCREATOR" })
    );

    const { valid, details } = await service.verifyCertificate(CERT_ID);

    expect(valid).toBe(false);
    expect(details.mismatches).toEqual(["storageId", "creator"]);
  });

  it("reports invalid with a null on-chain record when the chain has no certificate", async () => {
    mockCachedRow(cachedRow());
    getCertificate.mockResolvedValue(null);

    const { valid, details } = await service.verifyCertificate(CERT_ID);

    expect(valid).toBe(false);
    expect(details.onChain).toBeNull();
    expect(details.mismatches).toEqual([
      "storageId",
      "manifestHash",
      "attestationHash",
      "creator",
      "timestamp",
    ]);
  });

  it("compares hashes case-insensitively", async () => {
    mockCachedRow(cachedRow());
    getCertificate.mockResolvedValue(
      onChainRecord({ manifestHash: MANIFEST_HASH.toUpperCase() })
    );

    const { valid } = await service.verifyCertificate(CERT_ID);

    expect(valid).toBe(true);
  });

  it("compares timestamps at second precision", async () => {
    mockCachedRow(cachedRow());
    getCertificate.mockResolvedValue(
      onChainRecord({ timestamp: new Date(MINTED_AT.getTime() + 500) })
    );

    const { valid } = await service.verifyCertificate(CERT_ID);

    expect(valid).toBe(true);
  });

  it("flags a timestamp that differs by a full second", async () => {
    mockCachedRow(cachedRow());
    getCertificate.mockResolvedValue(
      onChainRecord({ timestamp: new Date(MINTED_AT.getTime() + 1_000) })
    );

    const { valid, details } = await service.verifyCertificate(CERT_ID);

    expect(valid).toBe(false);
    expect(details.mismatches).toEqual(["timestamp"]);
  });

  it("propagates a chain read failure instead of reporting a false verdict", async () => {
    mockCachedRow(cachedRow());
    getCertificate.mockRejectedValue(new Error("RPC unavailable"));

    await expect(service.verifyCertificate(CERT_ID)).rejects.toThrow("RPC unavailable");
  });
});
