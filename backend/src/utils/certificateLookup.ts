import mongoose, { type FilterQuery } from "mongoose";
import type { ICertificate } from "../models/Certificate.model";

/**
 * Matches a certificate by its cache `_id` or its on-chain `certificateId`,
 * so routes accept either identifier.
 */
export function certificateLookupQuery(id: string): FilterQuery<ICertificate> {
  return mongoose.Types.ObjectId.isValid(id)
    ? { $or: [{ _id: id }, { certificateId: id }] }
    : { certificateId: id };
}

/** URL of the frontend's public page for a certificate. */
export function publicCertificateUrl(publicAppUrl: string, certificateId: string): string {
  return `${publicAppUrl.replace(/\/+$/, "")}/certificate/${encodeURIComponent(certificateId)}`;
}
