/**
 * Re-verifies an SPV signature server-side.
 *
 * Convention: the signed payload is the raw 32 bytes of the SHA-256 content
 * hash (the hex digest decoded), and the verifying key is the `ownerPublicKey`
 * stored on the SPV record. A bad signature is a verdict (`valid: false` with
 * a reason), not an error; a missing record is an AppError (404).
 */
import mongoose from "mongoose";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../errors/AppError";
import { SPVRecordModel } from "../models/spv.model";
import type { ISPVRecord } from "../types/spv.types";
import type {
  SpvSignatureFailureReason,
  VerifySpvSignatureInput,
  VerifySpvSignatureResult,
} from "../types/spvSignature.types";
import { verifySignature } from "../utils/signature";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/;

/** Accepts `<hex>` or `sha256:<hex>`; returns lowercase hex or null. */
function normalizeHash(value: string): string | null {
  const hex = (value.startsWith("sha256:") ? value.slice(7) : value).toLowerCase();
  return SHA256_HEX.test(hex) ? hex : null;
}

function fail(
  reason: SpvSignatureFailureReason,
  message: string,
  extra: Pick<VerifySpvSignatureResult, "spvId" | "publicKey"> = {}
): VerifySpvSignatureResult {
  return { valid: false, reason, message, ...extra };
}

export class SpvSignatureService {
  async verify(input: VerifySpvSignatureInput): Promise<VerifySpvSignatureResult> {
    const contentHash = normalizeHash(input.contentHashHex);
    if (!contentHash) {
      return fail("INVALID_CONTENT_HASH_FORMAT", "contentHashHex must be a 64-char SHA-256 hex digest");
    }
    const signatureHex = input.signatureHex.toLowerCase();
    if (!SIGNATURE_HEX.test(signatureHex)) {
      return fail("INVALID_SIGNATURE_FORMAT", "signatureHex must be a 128-char hex Ed25519 signature");
    }

    const record = await this.findRecord(contentHash, input.spvId);
    const spvId = String(record._id);

    const recordHash = normalizeHash(record.contentHash);
    if (recordHash !== contentHash) {
      return fail("CONTENT_HASH_MISMATCH", "contentHashHex does not match the stored SPV record", { spvId });
    }

    const payload = Buffer.from(contentHash, "hex");
    const result = verifySignature(record.ownerPublicKey, payload, signatureHex);
    if (result.valid) {
      return { valid: true, spvId, publicKey: record.ownerPublicKey };
    }

    const reason: SpvSignatureFailureReason =
      result.error === "Invalid public key format" ? "INVALID_PUBLIC_KEY" : "SIGNATURE_MISMATCH";
    return fail(reason, result.error ?? "Signature verification failed", {
      spvId,
      publicKey: record.ownerPublicKey,
    });
  }

  private async findRecord(contentHash: string, spvId?: string): Promise<ISPVRecord> {
    if (spvId !== undefined && !mongoose.Types.ObjectId.isValid(spvId)) {
      throw new AppError("spvId must be a valid MongoDB ObjectId", StatusCodes.BAD_REQUEST, "INVALID_SPV_ID");
    }

    const record = spvId
      ? await SPVRecordModel.findById(spvId).lean<ISPVRecord>().exec()
      : await SPVRecordModel.findOne({ contentHash: { $in: [contentHash, `sha256:${contentHash}`] } })
          .lean<ISPVRecord>()
          .exec();

    if (!record) {
      throw new AppError("SPV record not found", StatusCodes.NOT_FOUND, "SPV_RECORD_NOT_FOUND");
    }
    return record;
  }
}

export const spvSignatureService = new SpvSignatureService();
