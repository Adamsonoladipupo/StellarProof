import mongoose from 'mongoose';
import KMSAuditLog from '../models/KMSAuditLog.model';
import { KmsAuditService } from '../services/kmsAudit.service';
import { AppError } from '../errors/AppError';

jest.mock('../models/KMSAuditLog.model', () => {
  const actual = jest.requireActual('../models/KMSAuditLog.model');
  return {
    __esModule: true,
    ...actual,
    default: {
      create: jest.fn(),
      find: jest.fn(),
    },
  };
});

const MockedLog = KMSAuditLog as unknown as {
  create: jest.Mock;
  find: jest.Mock;
};

describe('KmsAuditService', () => {
  const service = new KmsAuditService();
  const actorId = new mongoose.Types.ObjectId().toHexString();
  const keyId = new mongoose.Types.ObjectId().toHexString();

  beforeEach(() => {
    jest.clearAllMocks();
    MockedLog.create.mockImplementation(async (docs: unknown[]) => docs);
  });

  it('writes one audit row with ObjectId references and the session', async () => {
    const session = {} as mongoose.ClientSession;

    await service.record(
      { action: 'revoke', actorId, keyId, keyVersion: 'v2', metadata: { assetsReEncrypted: 3 } },
      session
    );

    expect(MockedLog.create).toHaveBeenCalledTimes(1);
    const [[doc], options] = MockedLog.create.mock.calls[0];
    expect(doc.action).toBe('revoke');
    expect(doc.actorId).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(doc.actorId.toHexString()).toBe(actorId);
    expect(doc.keyId.toHexString()).toBe(keyId);
    expect(doc.keyVersion).toBe('v2');
    expect(doc.metadata).toEqual({ assetsReEncrypted: 3 });
    expect(doc.timestamp).toBeInstanceOf(Date);
    expect(options).toEqual({ session });
  });

  it('rejects an unknown action before touching the database', async () => {
    await expect(
      service.record({ action: 'delete' as never })
    ).rejects.toMatchObject({ code: 'INVALID_KMS_AUDIT_ACTION', statusCode: 400 });
    expect(MockedLog.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed actor id', async () => {
    await expect(
      service.record({ action: 'rotate', actorId: 'not-an-id' })
    ).rejects.toBeInstanceOf(AppError);
    expect(MockedLog.create).not.toHaveBeenCalled();
  });

  it('validates list pagination bounds', async () => {
    await expect(service.listEntries({}, { limit: 0, skip: 0 })).rejects.toMatchObject({
      code: 'INVALID_PAGINATION',
    });
    await expect(service.listEntries({}, { limit: 201, skip: 0 })).rejects.toMatchObject({
      code: 'INVALID_PAGINATION',
    });
    await expect(service.listEntries({}, { limit: 10, skip: -1 })).rejects.toMatchObject({
      code: 'INVALID_PAGINATION',
    });
    expect(MockedLog.find).not.toHaveBeenCalled();
  });

  it('filters, sorts newest first and pages the list', async () => {
    const exec = jest.fn().mockResolvedValue([]);
    const limit = jest.fn().mockReturnValue({ exec });
    const skip = jest.fn().mockReturnValue({ limit });
    const sort = jest.fn().mockReturnValue({ skip });
    MockedLog.find.mockReturnValue({ sort });

    await service.listEntries({ action: 'rotate', keyId }, { limit: 25, skip: 50 });

    expect(MockedLog.find).toHaveBeenCalledWith({
      action: 'rotate',
      keyId: new mongoose.Types.ObjectId(keyId),
    });
    expect(sort).toHaveBeenCalledWith({ timestamp: -1, _id: -1 });
    expect(skip).toHaveBeenCalledWith(50);
    expect(limit).toHaveBeenCalledWith(25);
  });
});
