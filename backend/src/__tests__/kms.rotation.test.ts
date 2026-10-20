/**
 * KMS key rotation: re-encryption of stored asset blobs.
 *
 * Crypto is real (AES-256-GCM in the same layout SPV uploads write), so the
 * tests prove that rotated blobs decrypt under the new key. Storage, the
 * database and the global fetch are mocked.
 */
import crypto from 'crypto';
import mongoose from 'mongoose';
import { Writable } from 'stream';
import { v2 as cloudinary } from 'cloudinary';
import KMSKey from '../models/KMSKey.model';
import Asset from '../models/Asset.model';
import SPVRecordModel from '../models/SPVRecord.model';
import { ipfsService } from '../services/ipfs.service';
import { kmsService } from '../services/kms.service';

jest.mock('cloudinary', () => ({
  v2: {
    url: jest.fn((publicId: string) => `https://res.example/raw/${publicId}`),
    uploader: {
      upload_stream: jest.fn(),
      destroy: jest.fn(),
    },
  },
}));

jest.mock('../services/ipfs.service', () => ({
  ipfsService: { upload: jest.fn() },
}));

jest.mock('../utils/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

jest.mock('../models/KMSKey.model', () => {
  const ctor: any = jest.fn();
  ctor.find = jest.fn();
  ctor.findById = jest.fn();
  ctor.updateMany = jest.fn();
  return { __esModule: true, default: ctor };
});

jest.mock('../models/Asset.model', () => {
  const model: any = { find: jest.fn() };
  return { __esModule: true, default: model };
});

jest.mock('../models/SPVRecord.model', () => {
  const model: any = { findOne: jest.fn(), updateMany: jest.fn() };
  return { __esModule: true, default: model };
});

const MASTER_HEX = crypto.randomBytes(32).toString('hex');
const MASTER = Buffer.from(MASTER_HEX, 'hex');
const USER_ID = new mongoose.Types.ObjectId().toHexString();

const KMSKeyModel = KMSKey as unknown as jest.Mock & {
  find: jest.Mock;
  findById: jest.Mock;
  updateMany: jest.Mock;
};
const AssetModel = Asset as unknown as { find: jest.Mock };
const SPVModel = SPVRecordModel as unknown as { findOne: jest.Mock; updateMany: jest.Mock };
const uploadStream = cloudinary.uploader.upload_stream as unknown as jest.Mock;
const destroy = cloudinary.uploader.destroy as unknown as jest.Mock;
const cloudinaryUrl = cloudinary.url as unknown as jest.Mock;
const ipfsUpload = ipfsService.upload as unknown as jest.Mock;

/** Wraps a data key the way SPV uploads store it: base64 ciphertext plus separate iv/tag. */
function wrapDataKey(dataKey: Buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER, iv);
  const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  return {
    encryptedKeyValue: wrapped.toString('base64'),
    iv: iv.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

/** Unwraps a stored KMSKey document, mirroring what the service must do. */
function unwrapStoredKey(doc: { encryptedKeyValue: string; iv: string; authTag: string }): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER, Buffer.from(doc.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(doc.authTag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(doc.encryptedKeyValue, 'base64')),
    decipher.final(),
  ]);
}

/** Encrypts a blob in the SPV upload layout: [authTag | IV | ciphertext]. */
function sealBlob(plaintext: Buffer, key: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([cipher.getAuthTag(), iv, ciphertext]);
}

function openBlob(blob: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(16, 28));
  decipher.setAuthTag(blob.subarray(0, 16));
  return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]);
}

function makeSession() {
  let active = false;
  return {
    startTransaction: jest.fn(() => {
      active = true;
    }),
    commitTransaction: jest.fn(async () => {
      active = false;
    }),
    abortTransaction: jest.fn(async () => {
      active = false;
    }),
    endSession: jest.fn(async () => undefined),
    inTransaction: jest.fn(() => active),
  };
}

/** Chainable stand-in for a Mongoose query that resolves to `value`. */
function query<T>(value: T) {
  const chain: any = {
    select: () => chain,
    session: () => Promise.resolve(value),
    then: (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject),
  };
  return chain;
}

interface FakeAsset {
  _id: mongoose.Types.ObjectId;
  storageProvider: string;
  storageReferenceId: string;
  fileName: string;
  encryptionKeyVersion: string;
  save: jest.Mock;
}

interface Fixture {
  session: ReturnType<typeof makeSession>;
  activeKeys: any[];
  allKeys: any[];
  assets: FakeAsset[];
  spvByAsset: Map<string, { kmsKeyId: mongoose.Types.ObjectId }>;
  keysById: Map<string, any>;
  blobsByUrl: Map<string, Buffer>;
  oldDataKeyByAsset: Map<string, Buffer>;
}

let fixture: Fixture;
let newKeyDocs: any[];
let uploadedBlobs: Buffer[];
let uploadCounter: number;

/**
 * Builds a user with one active key (v1) and `count` assets, each with its
 * own data key, as the live SPV upload path creates them.
 */
function buildFixture(count: number, options: { legacyKey?: boolean } = {}): Fixture {
  const fx: Fixture = {
    session: makeSession(),
    activeKeys: [],
    allKeys: [],
    assets: [],
    spvByAsset: new Map(),
    keysById: new Map(),
    blobsByUrl: new Map(),
    oldDataKeyByAsset: new Map(),
  };

  for (let i = 0; i < count; i += 1) {
    const dataKey = crypto.randomBytes(32);
    const keyId = new mongoose.Types.ObjectId();
    const wrapped = wrapDataKey(dataKey);
    const keyDoc = {
      _id: keyId,
      creatorId: USER_ID,
      keyVersion: 'v1',
      isActive: true,
      ...wrapped,
      ...(options.legacyKey && i === 0
        ? { encryptedKeyValue: crypto.randomBytes(48).toString('hex'), iv: crypto.randomBytes(16).toString('hex') }
        : {}),
    };
    fx.keysById.set(String(keyId), keyDoc);
    fx.activeKeys.push(keyDoc);
    fx.allKeys.push(keyDoc);

    const assetId = new mongoose.Types.ObjectId();
    const publicId = `stellarproof/spv/${USER_ID}/asset-${i}`;
    const asset: FakeAsset = {
      _id: assetId,
      storageProvider: 'cloudinary',
      storageReferenceId: publicId,
      fileName: `file-${i}.bin`,
      encryptionKeyVersion: 'v1',
      save: jest.fn().mockResolvedValue(undefined),
    };
    fx.assets.push(asset);
    fx.spvByAsset.set(String(assetId), { kmsKeyId: keyId });
    fx.oldDataKeyByAsset.set(String(assetId), dataKey);
    fx.blobsByUrl.set(
      `https://res.example/raw/${publicId}`,
      sealBlob(Buffer.from(`plaintext for asset ${i}`), dataKey)
    );
  }

  return fx;
}

beforeAll(() => {
  process.env.KMS_MASTER_KEY = MASTER_HEX;
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    const blob = fixture.blobsByUrl.get(url);
    if (!blob) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    return { ok: true, status: 200, arrayBuffer: async () => blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.length) } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterAll(() => {
  delete process.env.KMS_MASTER_KEY;
});

beforeEach(() => {
  jest.clearAllMocks();
  newKeyDocs = [];
  uploadedBlobs = [];
  uploadCounter = 0;

  // Each upload_stream collects the bytes written to it and reports a public_id.
  uploadStream.mockImplementation((_options: unknown, callback: (err: unknown, res: unknown) => void) => {
    const chunks: Buffer[] = [];
    const id = `rotated-${uploadCounter++}`;
    return new Writable({
      write(chunk, _enc, next) {
        chunks.push(chunk as Buffer);
        next();
      },
      final(done) {
        uploadedBlobs.push(Buffer.concat(chunks));
        callback(undefined, { public_id: id, secure_url: `https://res.example/${id}` });
        done();
      },
    });
  });
  destroy.mockResolvedValue({ result: 'ok' });

  KMSKeyModel.mockImplementation((data: Record<string, unknown>) => {
    const doc = {
      ...data,
      _id: new mongoose.Types.ObjectId(),
      save: jest.fn().mockResolvedValue(undefined),
    };
    newKeyDocs.push(doc);
    return doc;
  });
  KMSKeyModel.updateMany.mockReturnValue(query({ modifiedCount: 1 }));
  SPVModel.updateMany.mockReturnValue(query({ modifiedCount: 1 }));
});

function wireModels(fx: Fixture) {
  fixture = fx;
  KMSKeyModel.find.mockImplementation((filter: Record<string, unknown>) =>
    query(filter.isActive === true ? fx.activeKeys : fx.allKeys)
  );
  KMSKeyModel.findById.mockImplementation((id: unknown) => query(fx.keysById.get(String(id)) ?? null));
  AssetModel.find.mockReturnValue(query(fx.assets));
  SPVModel.findOne.mockImplementation((filter: { assetId: mongoose.Types.ObjectId }) =>
    query(fx.spvByAsset.get(String(filter.assetId)) ?? null)
  );
  jest.spyOn(mongoose, 'startSession').mockResolvedValue(fx.session as unknown as mongoose.ClientSession);
}

describe('KmsService.rotateKey', () => {
  it('re-encrypts every asset blob under one new data key and commits atomically', async () => {
    const fx = buildFixture(2);
    wireModels(fx);

    const result = await kmsService.rotateKey(USER_ID);

    expect(result).toEqual({ oldKeyVersion: 'v1', newKeyVersion: 'v2', assetsReEncrypted: 2 });
    expect(fx.session.commitTransaction).toHaveBeenCalledTimes(1);
    expect(fx.session.abortTransaction).not.toHaveBeenCalled();

    // The new KMSKey stores a data key that unwraps with KMS_MASTER_KEY.
    expect(newKeyDocs).toHaveLength(1);
    const newKey = newKeyDocs[0];
    expect(newKey).toMatchObject({ creatorId: USER_ID, keyVersion: 'v2', isActive: true, algorithm: 'AES-256-GCM' });
    const newDataKey = unwrapStoredKey(newKey);
    expect(newDataKey).toHaveLength(32);

    // Every rotated blob decrypts under the new key to the original plaintext.
    expect(uploadedBlobs).toHaveLength(2);
    const plaintexts = uploadedBlobs.map((blob) => openBlob(blob, newDataKey).toString());
    expect(plaintexts.sort()).toEqual(['plaintext for asset 0', 'plaintext for asset 1']);

    // Asset references move to the new blobs and the new version.
    fx.assets.forEach((asset) => {
      expect(asset.save).toHaveBeenCalledWith({ session: fx.session });
      expect(asset.encryptionKeyVersion).toBe('v2');
      expect(asset.storageReferenceId).toMatch(/^rotated-/);
    });

    // SPV records point at the new key, and the previous keys are deactivated.
    expect(SPVModel.updateMany).toHaveBeenCalledWith(
      { assetId: { $in: fx.assets.map((a) => a._id) } },
      { $set: { kmsKeyId: newKey._id } }
    );
    expect(KMSKeyModel.updateMany).toHaveBeenCalledWith(
      { creatorId: USER_ID, isActive: true, _id: { $ne: newKey._id } },
      { $set: { isActive: false } }
    );
  });

  it('deletes the replaced Cloudinary blobs only after the commit succeeds', async () => {
    const fx = buildFixture(2);
    wireModels(fx);
    const replacedRefs = fx.assets.map((a) => a.storageReferenceId);

    await kmsService.rotateKey(USER_ID);

    expect(destroy).toHaveBeenCalledTimes(2);
    for (const ref of replacedRefs) {
      expect(destroy).toHaveBeenCalledWith(ref, { resource_type: 'raw' });
    }
    const commitOrder = fx.session.commitTransaction.mock.invocationCallOrder[0];
    const destroyOrder = destroy.mock.invocationCallOrder[0];
    expect(commitOrder).toBeLessThan(destroyOrder);
  });

  it('aborts and destroys uploaded blobs when a later asset fails', async () => {
    const fx = buildFixture(2);
    wireModels(fx);
    const originalRefs = fx.assets.map((a) => a.storageReferenceId);
    // The second asset's blob cannot be fetched.
    fx.blobsByUrl.delete(`https://res.example/raw/${originalRefs[1]}`);

    await expect(kmsService.rotateKey(USER_ID)).rejects.toThrow(
      `Failed to re-encrypt asset ${fx.assets[1]._id}`
    );

    expect(fx.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(fx.session.commitTransaction).not.toHaveBeenCalled();
    // The first asset's new blob was uploaded, so it must be removed again.
    expect(destroy).toHaveBeenCalledWith('rotated-0', { resource_type: 'raw' });
    // The original blobs stay in place until a commit succeeds.
    for (const ref of originalRefs) {
      expect(destroy).not.toHaveBeenCalledWith(ref, expect.anything());
    }
    expect(KMSKeyModel.updateMany).not.toHaveBeenCalled();
    expect(SPVModel.updateMany).not.toHaveBeenCalled();
  });

  it('fails without changes when the user has no active key', async () => {
    const fx = buildFixture(1);
    fx.activeKeys = [];
    wireModels(fx);

    await expect(kmsService.rotateKey(USER_ID)).rejects.toThrow('No active KMS key found for user');
    expect(fx.session.abortTransaction).toHaveBeenCalledTimes(1);
    expect(fx.session.commitTransaction).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects a key stored in an unsupported wrapping format before touching any blob', async () => {
    const fx = buildFixture(1, { legacyKey: true });
    wireModels(fx);

    await expect(kmsService.rotateKey(USER_ID)).rejects.toThrow('is not in a supported wrapping format');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(fx.session.commitTransaction).not.toHaveBeenCalled();
  });

  it('fails when an asset has no SPV record that references its key', async () => {
    const fx = buildFixture(1);
    wireModels(fx);
    fx.spvByAsset.clear();

    await expect(kmsService.rotateKey(USER_ID)).rejects.toThrow('has no SPV record that references its key');
    expect(fx.session.commitTransaction).not.toHaveBeenCalled();
  });

  it('fails when the wrapping key is not configured', async () => {
    const fx = buildFixture(1);
    wireModels(fx);
    const previous = process.env.KMS_MASTER_KEY;
    delete process.env.KMS_MASTER_KEY;
    try {
      await expect(kmsService.rotateKey(USER_ID)).rejects.toThrow('KMS_MASTER_KEY must be a 64-character hex string');
      expect(fx.session.commitTransaction).not.toHaveBeenCalled();
    } finally {
      process.env.KMS_MASTER_KEY = previous;
    }
  });

  it('retains new blobs and does not delete replaced blobs when the commit fails', async () => {
    const fx = buildFixture(1);
    wireModels(fx);
    fx.session.commitTransaction.mockRejectedValueOnce(new Error('write conflict'));

    await expect(kmsService.rotateKey(USER_ID)).rejects.toThrow('write conflict');
    expect(destroy).not.toHaveBeenCalled();
  });

  it('reads the new blob layout as [authTag | IV | ciphertext]', async () => {
    const fx = buildFixture(1);
    wireModels(fx);

    await kmsService.rotateKey(USER_ID);

    const newDataKey = unwrapStoredKey(newKeyDocs[0]);
    const blob = uploadedBlobs[0];
    expect(blob.length).toBe('plaintext for asset 0'.length + 28);
    expect(openBlob(blob, newDataKey).toString()).toBe('plaintext for asset 0');
  });
});
