/**
 * Certificate export (issue #739): verifiable JSON with proof data and a PDF
 * rendition carrying a verification QR code.
 *
 * Real MongoDB: mongodb-memory-server, seeded through the real models.
 */
import zlib from "zlib";
import mongoose from "mongoose";
import QRCode from "qrcode";
import { MongoMemoryServer } from "mongodb-memory-server";

import { CertificateExportService } from "../certificateExport.service";
import Manifest from "../../models/Manifest.model";
import { VerificationJobModel } from "../../models/verificationJob.model";
import {
  MANIFEST_CID,
  MEDIA_CID,
  clearCertificateFixtures,
  storeCertificate,
  storeUser,
} from "./fixtures/certificate.fixture";

const PUBLIC_APP_URL = "https://app.stellarproof.test";
const service = new CertificateExportService(() => ({ publicAppUrl: PUBLIC_APP_URL }));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (err: unknown) => err
  );
}

/**
 * Text drawn on a pdfkit page: content streams are Flate-compressed and
 * standard-font strings are written as hex, so inflate and decode them.
 */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString("latin1");
  let text = "";
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;
    try {
      content = zlib.inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const [, hex] of content.matchAll(/<([0-9a-fA-F]+)>/g)) {
      text += Buffer.from(hex, "hex").toString("latin1");
    }
  }
  return text;
}

let mongo: MongoMemoryServer;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterEach(async () => {
  await clearCertificateFixtures();
  jest.restoreAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

describe("CertificateExportService.buildJsonExport", () => {
  it("exports the certificate's CIDs, hashes, signature and links from the database", async () => {
    const stored = await storeCertificate();
    const now = new Date();

    const data = await service.buildJsonExport(stored.certificateId, stored.owner, now);

    expect(data).toEqual({
      version: 1,
      exportedAt: now.toISOString(),
      certificate: {
        certificateId: stored.certificateId,
        network: "testnet",
        contractAddress: stored.contractAddress,
        transactionHash: stored.transactionHash,
        ledgerSequence: stored.ledgerSequence,
        mintedAt: stored.mintedAt.toISOString(),
        revocation: { revoked: false, revokedAt: null },
      },
      proof: {
        mediaCid: MEDIA_CID,
        manifestCid: MANIFEST_CID,
        contentHash: stored.contentHash,
        manifestHash: stored.manifestHash,
        attestationHash: stored.teeAttestationHash,
        signature: stored.teeSignature,
        codeMeasurementHash: stored.codeMeasurementHash,
        attestationTransactionHash: stored.attestationTransactionHash,
        creator: stored.owner.stellarPublicKey,
      },
      links: {
        explorerUrl: `https://stellar.expert/explorer/testnet/tx/${stored.transactionHash}`,
        verificationUrl: `${PUBLIC_APP_URL}/certificate/${stored.certificateId}`,
      },
    });
  });

  it("links mainnet certificates to the public explorer", async () => {
    const stored = await storeCertificate({ network: "mainnet" });
    const data = await service.buildJsonExport(stored.documentId, stored.owner);
    expect(data.links.explorerUrl).toBe(
      `https://stellar.expert/explorer/public/tx/${stored.transactionHash}`
    );
  });

  it("only reports a media CID when the asset lives on IPFS", async () => {
    const stored = await storeCertificate({ storageProvider: "cloudinary" });
    const data = await service.buildJsonExport(stored.certificateId, stored.owner);
    expect(data.proof.mediaCid).toBeNull();
  });

  it("marks values the pipeline has not recorded as null rather than inventing them", async () => {
    const stored = await storeCertificate();
    await VerificationJobModel.updateMany({}, { $unset: { teeSignature: 1, codeMeasurementHash: 1 } });
    await Manifest.updateMany({}, { $unset: { ipfsCid: 1 } });

    const data = await service.buildJsonExport(stored.certificateId, stored.owner);

    expect(data.proof).toMatchObject({ signature: null, codeMeasurementHash: null, manifestCid: null });
  });

  it("includes revocation state", async () => {
    const revokedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
    const stored = await storeCertificate({ revokedAt });
    const data = await service.buildJsonExport(stored.certificateId, stored.owner);
    expect(data.certificate.revocation).toEqual({ revoked: true, revokedAt: revokedAt.toISOString() });
  });

  it("lets an admin export a certificate they do not own", async () => {
    const stored = await storeCertificate();
    const admin = await storeUser("admin");
    await expect(service.buildJsonExport(stored.certificateId, admin)).resolves.toMatchObject({
      certificate: { certificateId: stored.certificateId },
    });
  });

  it("refuses a requester who is neither owner nor admin", async () => {
    const stored = await storeCertificate();
    const stranger = await storeUser("creator");
    const err = await rejection(service.buildJsonExport(stored.certificateId, stranger));
    expect(err).toMatchObject({ statusCode: 403, code: "CERTIFICATE_EXPORT_FORBIDDEN" });
  });

  it("returns 404 for an unknown certificate", async () => {
    const owner = await storeUser();
    const err = await rejection(service.buildJsonExport("999999999999", owner));
    expect(err).toMatchObject({ statusCode: 404, code: "CERTIFICATE_NOT_FOUND" });
  });
});

describe("CertificateExportService.renderPdf", () => {
  it("renders a PDF that prints the proof data and the explorer URL", async () => {
    const stored = await storeCertificate();
    const data = await service.buildJsonExport(stored.certificateId, stored.owner);

    const pdf = await service.renderPdf(data);

    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.subarray(-6).toString()).toMatch(/%%EOF\s*$/);
    const text = pdfText(pdf);
    for (const value of [
      stored.certificateId,
      stored.transactionHash,
      stored.contentHash,
      stored.manifestHash,
      stored.teeSignature,
      MEDIA_CID,
      MANIFEST_CID,
      data.links.explorerUrl,
      data.links.verificationUrl,
    ]) {
      expect(text.replace(/\s/g, "")).toContain(value);
    }
    expect(text).not.toContain("REVOKED");
  });

  it("embeds a QR code that encodes the verification URL", async () => {
    const stored = await storeCertificate();
    const data = await service.buildJsonExport(stored.certificateId, stored.owner);
    const toBuffer = jest.spyOn(QRCode, "toBuffer");

    const pdf = await service.renderPdf(data);

    expect(toBuffer).toHaveBeenCalledWith(data.links.verificationUrl, expect.any(Object));
    expect(pdf.toString("latin1")).toMatch(/\/Subtype\s*\/Image/);
  });

  it("flags a revoked certificate", async () => {
    const stored = await storeCertificate({ revokedAt: new Date() });
    const data = await service.buildJsonExport(stored.certificateId, stored.owner);

    const pdf = await service.renderPdf(data);

    expect(pdfText(pdf)).toContain("REVOKED");
  });
});
