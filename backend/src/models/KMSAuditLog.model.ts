import mongoose, { Schema, Document } from 'mongoose';

/** KMS operations recorded in the audit trail. */
export const KMS_AUDIT_ACTIONS = ['encrypt', 'decrypt', 'rotate', 'revoke', 'expire'] as const;
export type KmsAuditAction = (typeof KMS_AUDIT_ACTIONS)[number];

/**
 * KMSAuditLog Interface
 * One immutable row per KMS operation, stored in the `auditLogs` collection
 * and read by the audit dashboard. Never store key material in `metadata`.
 */
export interface IKMSAuditLog extends Document {
  action: KmsAuditAction;
  timestamp: Date;
  /** The user who triggered the operation, when known. */
  actorId?: mongoose.Types.ObjectId;
  /** The KMSKey document the operation applied to. */
  keyId?: mongoose.Types.ObjectId;
  keyVersion?: string;
  /** The asset involved, for per-asset operations such as decrypt. */
  assetId?: mongoose.Types.ObjectId;
  /** Small, non-sensitive context such as counts or the previous key id. */
  metadata?: Record<string, string | number | boolean>;
}

const KMSAuditLogSchema: Schema = new Schema(
  {
    action: {
      type: String,
      enum: KMS_AUDIT_ACTIONS,
      required: true,
    },
    timestamp: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      index: true,
    },
    keyId: {
      type: Schema.Types.ObjectId,
      ref: 'KMSKey',
      index: true,
    },
    keyVersion: {
      type: String,
    },
    assetId: {
      type: Schema.Types.ObjectId,
      ref: 'Asset',
      index: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: undefined,
    },
  },
  {
    collection: 'auditLogs',
    versionKey: false,
  }
);

KMSAuditLogSchema.index({ timestamp: -1 });

export default mongoose.models['KMSAuditLog'] as mongoose.Model<IKMSAuditLog> ||
  mongoose.model<IKMSAuditLog>('KMSAuditLog', KMSAuditLogSchema);
