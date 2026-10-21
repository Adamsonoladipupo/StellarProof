/**
 * Certificate export: a verifiable JSON bundle of a certificate's proof data
 * (CIDs, hashes, TEE signature, explorer URL) and a PDF rendition carrying a
 * QR code that opens the public verification page.
 *
 * Every value comes from the certificate cache and the manifest, asset and
 * verification job it references.
 */
import mongoose from "mongoose";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import { StatusCodes } from "http-status-codes";
import Certificate from "../models/Certificate.model";
import { AppError } from "../errors/AppError";
import { certificateLookupQuery, publicCertificateUrl } from "../utils/certificateLookup";
import { stellarExplorerTxUrl, type StellarNetwork } from "../utils/stellarExplorer";
import type { CertificateExport, CertificateRequester } from "../types/certificate.types";

export interface CertificateExportConfig {
  publicAppUrl: string;
}

/** Certificate cache document with the relations the export reads. */
interface ExportCertificateRecord {
  certificateId: string;
  stellarNetwork: StellarNetwork;
  contractAddress: string;
  transactionHash: string;
  ledgerSequence: number;
  mintedAt: Date;
  revoked?: boolean;
  revokedAt?: Date | null;
  creatorId: mongoose.Types.ObjectId;
  manifestId?: {
    contentHash?: string;
    manifestHash?: string;
    ipfsCid?: string;
    creator?: string;
  } | null;
  assetId?: { storageProvider?: string; storageReferenceId?: string } | null;
  verificationJobId?: {
    ownerPublicKey?: string;
    teeAttestationHash?: string;
    teeSignature?: string;
    codeMeasurementHash?: string;
    attestationTransactionHash?: string;
  } | null;
}

const PDF_MARGIN = 56;
const QR_SIZE = 150;

export class CertificateExportService {
  constructor(
    /**
     * Lazily resolves configuration so importing this service never requires
     * environment variables and tests can inject their own.
     */
    private readonly configFactory: () => CertificateExportConfig = loadExportConfig
  ) {}

  /**
   * Builds the verifiable JSON export of a certificate. Only the certificate's
   * owner or an admin may export it.
   *
   * @throws {AppError} 404 when the certificate does not exist.
   * @throws {AppError} 403 when the requester is neither owner nor admin.
   */
  async buildJsonExport(
    id: string,
    requester: CertificateRequester,
    now: Date = new Date()
  ): Promise<CertificateExport> {
    const certificate = await Certificate.findOne(certificateLookupQuery(id.trim()))
      .populate("manifestId", "contentHash manifestHash ipfsCid creator")
      .populate("assetId", "storageProvider storageReferenceId")
      .populate(
        "verificationJobId",
        "ownerPublicKey teeAttestationHash teeSignature codeMeasurementHash attestationTransactionHash"
      )
      .lean<ExportCertificateRecord>();
    if (!certificate) {
      throw new AppError("Certificate not found", StatusCodes.NOT_FOUND, "CERTIFICATE_NOT_FOUND");
    }

    if (certificate.creatorId.toString() !== requester.id && requester.role !== "admin") {
      throw new AppError(
        "Only the certificate owner or an admin can export this certificate",
        StatusCodes.FORBIDDEN,
        "CERTIFICATE_EXPORT_FORBIDDEN"
      );
    }

    const { publicAppUrl } = this.configFactory();
    const { manifestId: manifest, assetId: asset, verificationJobId: job } = certificate;
    const revoked = certificate.revoked === true;

    return {
      version: 1,
      exportedAt: now.toISOString(),
      certificate: {
        certificateId: certificate.certificateId,
        network: certificate.stellarNetwork,
        contractAddress: certificate.contractAddress,
        transactionHash: certificate.transactionHash,
        ledgerSequence: certificate.ledgerSequence,
        mintedAt: new Date(certificate.mintedAt).toISOString(),
        revocation: {
          revoked,
          revokedAt: revoked && certificate.revokedAt ? new Date(certificate.revokedAt).toISOString() : null,
        },
      },
      proof: {
        mediaCid: asset?.storageProvider === "ipfs" ? asset.storageReferenceId ?? null : null,
        manifestCid: manifest?.ipfsCid ?? null,
        contentHash: manifest?.contentHash ?? null,
        manifestHash: manifest?.manifestHash ?? null,
        attestationHash: job?.teeAttestationHash ?? null,
        signature: job?.teeSignature ?? null,
        codeMeasurementHash: job?.codeMeasurementHash ?? null,
        attestationTransactionHash: job?.attestationTransactionHash ?? null,
        creator: job?.ownerPublicKey ?? manifest?.creator ?? null,
      },
      links: {
        explorerUrl: stellarExplorerTxUrl(certificate.stellarNetwork, certificate.transactionHash),
        verificationUrl: publicCertificateUrl(publicAppUrl, certificate.certificateId),
      },
    };
  }

  /**
   * Renders an export as a single-page PDF with a QR code that opens the
   * public verification page.
   */
  async renderPdf(data: CertificateExport): Promise<Buffer> {
    const qr = await QRCode.toBuffer(data.links.verificationUrl, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: QR_SIZE * 2,
    });

    const doc = new PDFDocument({
      size: "A4",
      margin: PDF_MARGIN,
      info: {
        Title: `StellarProof Certificate ${data.certificate.certificateId}`,
        Subject: "Provenance certificate export",
        Creator: "StellarProof",
      },
    });
    const finished = collectPdf(doc);
    const contentWidth = doc.page.width - PDF_MARGIN * 2;

    doc.font("Helvetica-Bold").fontSize(20).text("StellarProof Provenance Certificate");
    doc.moveDown(0.3);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor("#555555")
      .text(`Exported ${data.exportedAt} · ${data.certificate.network}`);
    doc.fillColor("#000000");

    if (data.certificate.revocation.revoked) {
      doc.moveDown(0.6);
      doc
        .font("Helvetica-Bold")
        .fillColor("#B00020")
        .text(`REVOKED${data.certificate.revocation.revokedAt ? ` on ${data.certificate.revocation.revokedAt}` : ""}`);
      doc.fillColor("#000000");
    }

    const qrTop = doc.y + 16;
    doc.image(qr, PDF_MARGIN + contentWidth - QR_SIZE, qrTop, { width: QR_SIZE, height: QR_SIZE });
    doc
      .font("Helvetica")
      .fontSize(8)
      .text("Scan to verify", PDF_MARGIN + contentWidth - QR_SIZE, qrTop + QR_SIZE + 4, {
        width: QR_SIZE,
        align: "center",
      });
    doc.x = PDF_MARGIN;
    doc.y = qrTop;

    const fieldWidth = contentWidth - QR_SIZE - 24;
    writeSection(doc, "Certificate", fieldWidth, [
      ["Certificate ID", data.certificate.certificateId],
      ["Contract", data.certificate.contractAddress],
      ["Mint transaction", data.certificate.transactionHash],
      ["Ledger", String(data.certificate.ledgerSequence)],
      ["Minted at", data.certificate.mintedAt],
    ]);
    // Full-width sections start below the QR code and its caption.
    doc.y = Math.max(doc.y, qrTop + QR_SIZE + 16);
    writeSection(doc, "Proof", contentWidth, [
      ["Media CID", data.proof.mediaCid],
      ["Manifest CID", data.proof.manifestCid],
      ["Content hash", data.proof.contentHash],
      ["Manifest hash", data.proof.manifestHash],
      ["Attestation hash", data.proof.attestationHash],
      ["Oracle signature", data.proof.signature],
      ["Code measurement", data.proof.codeMeasurementHash],
      ["Attestation transaction", data.proof.attestationTransactionHash],
      ["Creator", data.proof.creator],
    ]);
    writeSection(doc, "Verify", contentWidth, [
      ["Stellar explorer", data.links.explorerUrl],
      ["Verification page", data.links.verificationUrl],
    ]);

    doc.end();
    return finished;
  }
}

function writeSection(
  doc: PDFKit.PDFDocument,
  title: string,
  width: number,
  rows: Array<[label: string, value: string | null]>
): void {
  doc.moveDown(1);
  doc.font("Helvetica-Bold").fontSize(12).text(title, PDF_MARGIN, doc.y, { width });
  doc.moveDown(0.3);
  for (const [label, value] of rows) {
    doc.font("Helvetica").fontSize(8).fillColor("#555555").text(label, { width });
    doc
      .font("Courier")
      .fontSize(9)
      .fillColor("#000000")
      .text(value ?? "Not recorded", { width, lineBreak: true });
    doc.moveDown(0.4);
  }
}

function collectPdf(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });
}

function loadExportConfig(): CertificateExportConfig {
  const { env } = require("../config/env") as typeof import("../config/env");
  return { publicAppUrl: env.PUBLIC_APP_URL };
}

export const certificateExportService = new CertificateExportService();
