/**
 * Mongoose model for processed on-chain requests.
 *
 * One document per dedup key, where the key is `<eventKind>:<requestId>`
 * (or `<eventKind>:<eventId>` when the event carries no request id). The
 * unique index on `dedupKey` is what makes concurrent workers safe: only one
 * insert for a key can succeed. `expiresAt` drives a TTL index so the
 * collection does not grow without bound.
 */
import { Schema, model, type Document } from "mongoose";

export type ProcessedRequestStatus = "processing" | "completed";

export interface IProcessedRequest extends Document {
  dedupKey: string;
  eventId: string;
  status: ProcessedRequestStatus;
  jobId?: string;
  startedAt: Date;
  expiresAt: Date;
}

const ProcessedRequestSchema = new Schema<IProcessedRequest>(
  {
    dedupKey: { type: String, required: true, trim: true },
    eventId: { type: String, required: true, trim: true },
    status: {
      type: String,
      required: true,
      enum: ["processing", "completed"],
      default: "processing",
    },
    jobId: { type: String, trim: true, default: undefined },
    startedAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

ProcessedRequestSchema.index(
  { dedupKey: 1 },
  { unique: true, name: "unique_processed_request_key" }
);
ProcessedRequestSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "processed_request_ttl" }
);

export const ProcessedRequestModel = model<IProcessedRequest>(
  "ProcessedRequest",
  ProcessedRequestSchema
);
