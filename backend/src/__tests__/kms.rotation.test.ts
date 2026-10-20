import crypto from 'crypto';
import mongoose from 'mongoose';
import { kmsService } from '../services/kms.service';
import KMSKey from '../models/KMSKey.model';
import { env } from '../config/env';

jest.mock('../config/env', () => ({
  env: {
    MASTER_KEY: 'master-current',
    MASTER_KEY_PREVIOUS: '',
  },
}));

jest.mock('../models/KMSKey.model', () => ({
  __esModule: true,
  default: {
    findById: jest.fn(),
    find: jest.fn(),
    updateMany: jest.fn(),
    findOne: jest.fn(),
  },
}));

const KMSKeyMock = KMSKey as unknown as Record<'findById' | 'find' | 'updateMany' | 'findOne', jest.Mock>;
const mutableEnv = env as unknown as { MASTER_KEY_PREVIOUS: string };

/** Wraps a symmetric key the same way the stored format has always been written. */
function wrapWith(masterSecret: string, symmetricKey: Buffer) {
  const master = crypto.createHash('sha256').update(masterSecret).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
  let encrypted = cipher.update(symmetricKey.toString('hex'), 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return {
    encryptedKeyValue: encrypted,
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

/** Unwraps a stored record with a given master secret; throws if the tag does not verify. */
function unwrapWith(masterSecret: string, record: { encryptedKeyValue: string; iv: string; authTag: string }) {
  const master = crypto.createHash('sha256').update(masterSecret).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', master, Buffer.from(record.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(record.authTag, 'hex'));
  let hex = decipher.update(record.encryptedKeyValue, 'hex', 'utf8');
  hex += decipher.final('utf8');
  return Buffer.from(hex, 'hex');
}

/** Builds a KMSKey-like document for the mocked model. */
function keyDoc(overrides: Record<string, unknown> & { wrapped: ReturnType<typeof wrapWith> }) {
  const { wrapped, ...rest } = overrides;
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    keyVersion: 'v1',
    isActive: true,
    expiresAt: undefined as Date | undefined,
    encryptedKeyValue: wrapped.encryptedKeyValue,
    iv: wrapped.iv,
    authTag: wrapped.authTag,
    save: jest.fn().mockResolvedValue(undefined),
    ...rest,
  };
  return { ...doc, id: doc._id.toHexString() };
}

/** Resolves successive KMSKey.find(...).sort().limit() calls with the given pages. */
function mockFindPages(pages: unknown[][]) {
  for (const page of pages) {
    const limit = jest.fn().mockResolvedValue(page);
    const sort = jest.fn().mockReturnValue({ limit });
    KMSKeyMock.find.mockReturnValueOnce({ sort });
  }
}

describe('KMS key expiry', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mutableEnv.MASTER_KEY_PREVIOUS = '';
  });

  it('rejects decryption with an expired key using KMS_KEY_EXPIRED', async () => {
    const past = new Date(Date.now() - 60_000);
    const doc = keyDoc({ wrapped: wrapWith('master-current', Buffer.alloc(32, 7)), expiresAt: past });
    KMSKeyMock.findById.mockResolvedValue(doc);

    const payload = kmsService.encryptBuffer(Buffer.from('secret'), Buffer.alloc(32, 7));

    await expect(kmsService.decryptWithStoredKey(doc.id, payload)).rejects.toMatchObject({
      code: 'KMS_KEY_EXPIRED',
      statusCode: 403,
    });
  });

  it('decrypts with a key whose expiry is still in the future', async () => {
    const symmetric = Buffer.alloc(32, 9);
    const doc = keyDoc({
      wrapped: wrapWith('master-current', symmetric),
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    KMSKeyMock.findById.mockResolvedValue(doc);

    const payload = kmsService.encryptBuffer(Buffer.from('hello'), symmetric);
    const plain = await kmsService.decryptWithStoredKey(doc.id, payload);

    expect(plain.toString('utf8')).toBe('hello');
  });

  it('treats a key without expiresAt as never expiring', () => {
    expect(() =>
      kmsService.assertKeyNotExpired({ keyVersion: 'v1', expiresAt: undefined })
    ).not.toThrow();
  });

  it('deactivates only active keys whose expiry has passed', async () => {
    const now = new Date('2026-10-20T00:00:00Z');
    KMSKeyMock.updateMany.mockResolvedValue({ modifiedCount: 3 });

    const count = await kmsService.deactivateExpiredKeys(now);

    expect(KMSKeyMock.updateMany).toHaveBeenCalledWith(
      { isActive: true, expiresAt: { $lte: now } },
      { $set: { isActive: false } }
    );
    expect(count).toBe(3);
  });

  it('excludes expired keys when resolving the active key', async () => {
    KMSKeyMock.findOne.mockResolvedValue(null);

    await kmsService.getActiveKey(new mongoose.Types.ObjectId().toHexString());

    const filter = KMSKeyMock.findOne.mock.calls[0][0];
    expect(filter.isActive).toBe(true);
    expect(filter.$or).toEqual([
      { expiresAt: null },
      { expiresAt: { $gt: expect.any(Date) } },
    ]);
  });
});

describe('KMS master-key rotation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mutableEnv.MASTER_KEY_PREVIOUS = '';
  });

  it('unwraps keys written under the previous master during the transition window', async () => {
    mutableEnv.MASTER_KEY_PREVIOUS = 'master-previous';
    const symmetric = Buffer.alloc(32, 4);
    const doc = keyDoc({ wrapped: wrapWith('master-previous', symmetric) });
    KMSKeyMock.findById.mockResolvedValue(doc);

    const payload = kmsService.encryptBuffer(Buffer.from('still readable'), symmetric);
    const plain = await kmsService.decryptWithStoredKey(doc.id, payload);

    expect(plain.toString('utf8')).toBe('still readable');
  });

  it('fails with KMS_MASTER_KEY_MISMATCH when no configured master can unwrap the key', async () => {
    const doc = keyDoc({ wrapped: wrapWith('some-other-master', Buffer.alloc(32, 1)) });
    KMSKeyMock.findById.mockResolvedValue(doc);

    const payload = kmsService.encryptBuffer(Buffer.from('x'), Buffer.alloc(32, 1));

    await expect(kmsService.decryptWithStoredKey(doc.id, payload)).rejects.toMatchObject({
      code: 'KMS_MASTER_KEY_MISMATCH',
    });
  });

  it('refuses to re-wrap when MASTER_KEY_PREVIOUS is not configured', async () => {
    await expect(kmsService.rewrapKeysToCurrentMaster()).rejects.toMatchObject({
      code: 'KMS_PREVIOUS_MASTER_KEY_MISSING',
    });
    expect(KMSKeyMock.find).not.toHaveBeenCalled();
  });

  it('re-wraps old-master keys, skips current ones, and reports unrecoverable keys', async () => {
    mutableEnv.MASTER_KEY_PREVIOUS = 'master-previous';
    const oldSymmetric = Buffer.alloc(32, 5);
    const current = keyDoc({ wrapped: wrapWith('master-current', Buffer.alloc(32, 6)) });
    const legacy = keyDoc({ wrapped: wrapWith('master-previous', oldSymmetric) });
    const broken = keyDoc({ wrapped: wrapWith('unknown-master', Buffer.alloc(32, 8)) });
    mockFindPages([[current, legacy, broken]]);

    const summary = await kmsService.rewrapKeysToCurrentMaster(10);

    expect(summary).toEqual({
      scanned: 3,
      rewrapped: 1,
      alreadyCurrent: 1,
      failed: [broken.id],
    });
    expect(current.save).not.toHaveBeenCalled();
    expect(legacy.save).toHaveBeenCalledTimes(1);
    expect(broken.save).not.toHaveBeenCalled();

    // The rewritten key now unwraps under the current master alone.
    expect(unwrapWith('master-current', legacy).equals(oldSymmetric)).toBe(true);
  });

  it('pages through keys in batches and stops on a short page', async () => {
    mutableEnv.MASTER_KEY_PREVIOUS = 'master-previous';
    const first = keyDoc({ wrapped: wrapWith('master-current', Buffer.alloc(32, 1)) });
    const second = keyDoc({ wrapped: wrapWith('master-previous', Buffer.alloc(32, 2)) });
    const third = keyDoc({ wrapped: wrapWith('master-previous', Buffer.alloc(32, 3)) });
    mockFindPages([[first, second], [third]]);

    const summary = await kmsService.rewrapKeysToCurrentMaster(2);

    expect(KMSKeyMock.find).toHaveBeenCalledTimes(2);
    expect(KMSKeyMock.find.mock.calls[1][0]).toEqual({ _id: { $gt: second._id } });
    expect(summary.scanned).toBe(3);
    expect(summary.rewrapped).toBe(2);
  });
});

describe('KMS rotation eligibility query', () => {
  beforeEach(() => jest.clearAllMocks());

  it('selects active, unexpired keys created before the cutoff, ordered by _id', async () => {
    const sort = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    KMSKeyMock.find.mockReturnValue({ sort });
    const cutoff = new Date('2026-07-22T00:00:00Z');
    const now = new Date('2026-10-20T00:00:00Z');

    await kmsService.findKeysDueForRotation({ cutoff, limit: 25, now });

    const filter = KMSKeyMock.find.mock.calls[0][0];
    expect(filter).toEqual({
      isActive: true,
      createdAt: { $lte: cutoff },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    });
    expect(sort).toHaveBeenCalledWith({ _id: 1 });
  });

  it('continues after the given _id when paginating', async () => {
    const sort = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) });
    KMSKeyMock.find.mockReturnValue({ sort });
    const afterId = new mongoose.Types.ObjectId();

    await kmsService.findKeysDueForRotation({ cutoff: new Date(), limit: 5, afterId });

    expect(KMSKeyMock.find.mock.calls[0][0]._id).toEqual({ $gt: afterId });
  });
});
