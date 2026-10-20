/**
 * Creator dashboard metrics: CertificateService.getStats.
 * The Certificate model is mocked so the aggregation inputs and the
 * series construction can be checked directly.
 */
import mongoose from "mongoose";
import { certificateService } from "../services/certificate.service";
import Certificate from "../models/Certificate.model";
import { AppError } from "../errors/AppError";

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
  countDocuments: jest.Mock;
  distinct: jest.Mock;
  aggregate: jest.Mock;
};

const CREATOR_ID = new mongoose.Types.ObjectId().toHexString();
const NOW = new Date("2026-10-19T12:00:00.000Z");

describe("CertificateService.getStats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects a missing or malformed creatorId without querying", async () => {
    const missing = await certificateService.getStats({ creatorId: "" }, NOW).catch((e: unknown) => e);
    const malformed = await certificateService.getStats({ creatorId: "not-an-id" }, NOW).catch((e: unknown) => e);

    expect(missing).toBeInstanceOf(AppError);
    expect(missing).toMatchObject({ statusCode: 400, code: "INVALID_CREATOR_ID" });
    expect(malformed).toMatchObject({ statusCode: 400, code: "INVALID_CREATOR_ID" });
    expect(CertificateModel.countDocuments).not.toHaveBeenCalled();
    expect(CertificateModel.aggregate).not.toHaveBeenCalled();
  });

  it("returns totals, distinct verified assets and a zero-filled 12-month series", async () => {
    CertificateModel.countDocuments.mockResolvedValue(5);
    CertificateModel.distinct.mockResolvedValue(["asset-a", "asset-b", "asset-c"]);
    CertificateModel.aggregate.mockResolvedValue([
      { _id: "2026-10", minted: 3 },
      { _id: "2026-02", minted: 2 },
    ]);

    const stats = await certificateService.getStats({ creatorId: CREATOR_ID }, NOW);

    expect(stats.totalMinted).toBe(5);
    expect(stats.uniqueAssetsVerified).toBe(3);
    expect(stats.monthlySeries).toHaveLength(12);
    expect(stats.monthlySeries[0]).toEqual({ month: "2025-11", minted: 0 });
    expect(stats.monthlySeries[11]).toEqual({ month: "2026-10", minted: 3 });
    expect(stats.monthlySeries).toContainEqual({ month: "2026-02", minted: 2 });
    expect(stats.monthlySeries.map((point) => point.month)).toEqual(
      [...stats.monthlySeries.map((point) => point.month)].sort()
    );
  });

  it("scopes every query to the creator and to the trailing window", async () => {
    CertificateModel.countDocuments.mockResolvedValue(0);
    CertificateModel.distinct.mockResolvedValue([]);
    CertificateModel.aggregate.mockResolvedValue([]);
    const owner = { creatorId: new mongoose.Types.ObjectId(CREATOR_ID) };

    await certificateService.getStats({ creatorId: CREATOR_ID }, NOW);

    expect(CertificateModel.countDocuments).toHaveBeenCalledWith(owner);
    expect(CertificateModel.distinct).toHaveBeenCalledWith("assetId", owner);
    const pipeline = CertificateModel.aggregate.mock.calls[0][0];
    expect(pipeline[0]).toEqual({
      $match: {
        ...owner,
        mintedAt: { $gte: new Date("2025-11-01T00:00:00.000Z"), $lte: NOW },
      },
    });
  });

  it("buckets months by UTC, so a late-evening local date keeps its UTC month", async () => {
    CertificateModel.countDocuments.mockResolvedValue(0);
    CertificateModel.distinct.mockResolvedValue([]);
    CertificateModel.aggregate.mockResolvedValue([]);

    const stats = await certificateService.getStats(
      { creatorId: CREATOR_ID },
      new Date("2026-01-01T00:30:00.000Z")
    );

    expect(stats.monthlySeries[0].month).toBe("2025-02");
    expect(stats.monthlySeries[11].month).toBe("2026-01");
  });

  it("returns zeros and an empty series for a creator with no certificates", async () => {
    CertificateModel.countDocuments.mockResolvedValue(0);
    CertificateModel.distinct.mockResolvedValue([]);
    CertificateModel.aggregate.mockResolvedValue([]);

    const stats = await certificateService.getStats({ creatorId: CREATOR_ID }, NOW);

    expect(stats).toEqual({
      totalMinted: 0,
      uniqueAssetsVerified: 0,
      monthlySeries: expect.any(Array),
    });
    expect(stats.monthlySeries.every((point) => point.minted === 0)).toBe(true);
  });
});
