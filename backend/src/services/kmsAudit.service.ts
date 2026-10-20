import mongoose, { type ClientSession } from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import KMSAuditLog, {
  KMS_AUDIT_ACTIONS,
  type IKMSAuditLog,
  type KmsAuditAction,
} from '../models/KMSAuditLog.model';
import { AppError } from '../errors/AppError';

/** Input for {@link KmsAuditService.record}. Ids are hex strings or ObjectIds. */
export interface KmsAuditEntry {
  action: KmsAuditAction;
  actorId?: string | mongoose.Types.ObjectId;
  keyId?: string | mongoose.Types.ObjectId;
  keyVersion?: string;
  assetId?: string | mongoose.Types.ObjectId;
  metadata?: Record<string, string | number | boolean>;
}

/** Filters accepted by {@link KmsAuditService.listEntries}. */
export interface KmsAuditFilter {
  action?: KmsAuditAction;
  actorId?: string;
  keyId?: string;
  assetId?: string;
}

export interface KmsAuditPage {
  limit: number;
  skip: number;
}

const MAX_PAGE_SIZE = 200;

export class KmsAuditService {
  /**
   * Appends one audit row. Pass `session` to commit the row atomically with the
   * KMS change it describes, so an operation can never succeed without its
   * audit record.
   *
   * @throws {AppError} 400 when the action or an id is invalid.
   */
  async record(entry: KmsAuditEntry, session?: ClientSession): Promise<IKMSAuditLog> {
    if (!KMS_AUDIT_ACTIONS.includes(entry.action)) {
      throw new AppError(
        `Unknown KMS audit action: ${String(entry.action)}`,
        StatusCodes.BAD_REQUEST,
        'INVALID_KMS_AUDIT_ACTION'
      );
    }

    const [doc] = await KMSAuditLog.create(
      [
        {
          action: entry.action,
          timestamp: new Date(),
          actorId: toObjectId(entry.actorId, 'actorId'),
          keyId: toObjectId(entry.keyId, 'keyId'),
          keyVersion: entry.keyVersion,
          assetId: toObjectId(entry.assetId, 'assetId'),
          metadata: entry.metadata,
        },
      ],
      { session }
    );
    return doc;
  }

  /**
   * Returns audit rows, newest first, for the audit dashboard.
   *
   * @throws {AppError} 400 for invalid ids or page bounds.
   */
  async listEntries(filter: KmsAuditFilter, page: KmsAuditPage): Promise<IKMSAuditLog[]> {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > MAX_PAGE_SIZE) {
      throw new AppError(
        `limit must be an integer between 1 and ${MAX_PAGE_SIZE}`,
        StatusCodes.BAD_REQUEST,
        'INVALID_PAGINATION'
      );
    }
    if (!Number.isInteger(page.skip) || page.skip < 0) {
      throw new AppError(
        'skip must be a non-negative integer',
        StatusCodes.BAD_REQUEST,
        'INVALID_PAGINATION'
      );
    }

    const query: Record<string, unknown> = {};
    if (filter.action) {
      if (!KMS_AUDIT_ACTIONS.includes(filter.action)) {
        throw new AppError('Unknown KMS audit action', StatusCodes.BAD_REQUEST, 'INVALID_KMS_AUDIT_ACTION');
      }
      query.action = filter.action;
    }
    if (filter.actorId) query.actorId = toObjectId(filter.actorId, 'actorId');
    if (filter.keyId) query.keyId = toObjectId(filter.keyId, 'keyId');
    if (filter.assetId) query.assetId = toObjectId(filter.assetId, 'assetId');

    return KMSAuditLog.find(query)
      .sort({ timestamp: -1, _id: -1 })
      .skip(page.skip)
      .limit(page.limit)
      .exec();
  }
}

function toObjectId(
  value: string | mongoose.Types.ObjectId | undefined,
  field: string
): mongoose.Types.ObjectId | undefined {
  if (value === undefined) return undefined;
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw new AppError(`${field} must be a valid ObjectId`, StatusCodes.BAD_REQUEST, 'INVALID_KMS_AUDIT_ID');
  }
  return new mongoose.Types.ObjectId(value);
}

export const kmsAuditService = new KmsAuditService();
