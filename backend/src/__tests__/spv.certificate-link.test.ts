/**
 * SPV record to certificate linkage: linkCertificate and the backfill.
 * Models are mocked; the service logic is real.
 */
import mongoose from "mongoose";
import { spvService } from "../services/spv.service";
import SPVRecordModel from "../models/SPVRecord.model";
import Certificate from "../models/Certificate.model";

jest.mock("../models/SPVRecord.model", () => {
  const model: any = { updateOne: jest.fn(), find: jest.fn() };
  return { __esModule: true, default: model };
});

jest.mock("../models/Certificate.model", () => {
  const model: any = { findOne: jest.fn() };
  return { __esModule: true, default: model };
});

const SPV = SPVRecordModel as unknown as { updateOne: jest.Mock; find: jest.Mock };
const CertificateModel = Certificate as unknown as { findOne: jest.Mock };

async function* asyncRecords<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

describe("SPVService.linkCertificate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("links an unlinked vault and reports one record updated", async () => {
    const assetId = new mongoose.Types.ObjectId();
    const certificateId = new mongoose.Types.ObjectId();
    const verificationJobId = new mongoose.Types.ObjectId();
    SPV.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const linked = await spvService.linkCertificate({ assetId, certificateId, verificationJobId });

    expect(linked).toBe(1);
    expect(SPV.updateOne).toHaveBeenCalledWith(
      { assetId, certificateId: { $exists: false } },
      { $set: { certificateId, verificationJobId } }
    );
  });

  it("never re-points a vault that is already linked", async () => {
    SPV.updateOne.mockResolvedValue({ modifiedCount: 0 });

    const linked = await spvService.linkCertificate({
      assetId: new mongoose.Types.ObjectId(),
      certificateId: new mongoose.Types.ObjectId(),
      verificationJobId: new mongoose.Types.ObjectId(),
    });

    expect(linked).toBe(0);
    expect(SPV.updateOne.mock.calls[0][0]).toHaveProperty("certificateId", { $exists: false });
  });
});

describe("SPVService.backfillCertificateLinks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("links records that have a certificate and skips the rest", async () => {
    const linkedAsset = new mongoose.Types.ObjectId();
    const unmintedAsset = new mongoose.Types.ObjectId();
    const certificateId = new mongoose.Types.ObjectId();
    const verificationJobId = new mongoose.Types.ObjectId();

    SPV.find.mockReturnValue({
      select: () => ({
        lean: () => ({
          cursor: () =>
            asyncRecords([
              { _id: new mongoose.Types.ObjectId(), assetId: linkedAsset },
              { _id: new mongoose.Types.ObjectId(), assetId: unmintedAsset },
            ]),
        }),
      }),
    });
    CertificateModel.findOne.mockImplementation((filter: { assetId: mongoose.Types.ObjectId }) => {
      const doc =
        String(filter.assetId) === String(linkedAsset)
          ? { _id: certificateId, verificationJobId }
          : null;
      const chain: any = {
        sort: () => chain,
        select: () => chain,
        lean: () => Promise.resolve(doc),
      };
      return chain;
    });
    SPV.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const summary = await spvService.backfillCertificateLinks();

    expect(summary).toEqual({ scanned: 2, linked: 1 });
    expect(SPV.find).toHaveBeenCalledWith({ certificateId: { $exists: false } });
    expect(SPV.updateOne).toHaveBeenCalledTimes(1);
    expect(SPV.updateOne).toHaveBeenCalledWith(
      { assetId: linkedAsset, certificateId: { $exists: false } },
      { $set: { certificateId, verificationJobId } }
    );
  });

  it("uses the most recently minted certificate for an asset", async () => {
    const assetId = new mongoose.Types.ObjectId();
    const sort = jest.fn();
    CertificateModel.findOne.mockImplementation(() => {
      const chain: any = {
        sort: (spec: unknown) => {
          sort(spec);
          return chain;
        },
        select: () => chain,
        lean: () => Promise.resolve(null),
      };
      return chain;
    });
    SPV.find.mockReturnValue({
      select: () => ({
        lean: () => ({
          cursor: () => asyncRecords([{ _id: new mongoose.Types.ObjectId(), assetId }]),
        }),
      }),
    });

    await spvService.backfillCertificateLinks();

    expect(sort).toHaveBeenCalledWith({ mintedAt: -1 });
    expect(SPV.updateOne).not.toHaveBeenCalled();
  });
});
