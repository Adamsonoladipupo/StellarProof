import crypto from 'crypto';
import mongoose from 'mongoose';
import { StatusCodes } from 'http-status-codes';
import KMSKey, { IKMSKey } from '../models/KMSKey.model';
import Asset from '../models/Asset.model';
import { AppError } from '../errors/AppError';
import { cloudinaryService } from './cloudinary.service';
import { ipfsService } from './ipfs.service';
import { kmsAuditService } from './kmsAudit.service';
import { v2 as cloudinary } from 'cloudinary';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce is standard for GCM buffers
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag

/** A symmetric key wrapped (encrypted) by a master key, in the hex format stored on KMSKey. */
interface WrappedKey {
  encrypted: string;
  iv: string;
  authTag: string;
}

type WrappedKeyRecord = Pick<IKMSKey, 'encryptedKeyValue' | 'iv' | 'authTag'>;

export interface MasterKeys {
  current: Buffer;
  previous?: Buffer;
}

export interface KeyRewrapSummary {
  scanned: number;
  rewrapped: number;
  alreadyCurrent: number;
  failed: string[];
}

/**
 * Resolves the 256-bit master keys from validated configuration.
 * Loaded lazily so importing this module never triggers environment validation.
 * Keys are derived with SHA-256 as before, so symmetric keys wrapped under an
 * existing MASTER_KEY remain decryptable.
 */
function resolveMasterKeys(): MasterKeys {
  const { env } = require('../config/env') as typeof import('../config/env');
  const derive = (secret: string): Buffer => crypto.createHash('sha256').update(secret).digest();

  return {
    current: derive(env.MASTER_KEY),
    previous: env.MASTER_KEY_PREVIOUS ? derive(env.MASTER_KEY_PREVIOUS) : undefined,
  };
}

/** Filter matching keys that have no expiry or whose expiry is still in the future. */
function unexpiredFilter(now: Date) {
  return { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] };
}

export class KmsService {
  /**
   * Generates a new 256-bit symmetric key for encryption
   */
  generateSymmetricKey(): Buffer {
    return crypto.randomBytes(32);
  }

  /**
   * Encrypts a buffer using AES-256-GCM.
   * Returns a concatenated buffer: [IV (12 bytes) + Ciphertext + Auth Tag (16 bytes)]
   * @param buffer The plaintext buffer to encrypt
   * @param key A 32-byte (256-bit) encryption key
   */
  encryptBuffer(buffer: Buffer, key: Buffer): Buffer {
    if (key.length !== 32) {
      throw new Error('Invalid KMS key length. AES-256 requires exactly a 32-byte key.');
    }

    try {
      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

      const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
      const authTag = cipher.getAuthTag();

      // Ensure the auth tag is appended to the payload per requirements
      return Buffer.concat([iv, ciphertext, authTag]);
    } catch (error) {
      throw new Error(`KMS Encryption failed: ${(error as Error).message}`);
    }
  }

  /**
   * Decrypts an AES-256-GCM encrypted buffer.
   * Expects the exact packed format: [IV (12 bytes) + Ciphertext + Auth Tag (16 bytes)]
   * @param encryptedBuffer The packed encrypted payload
   * @param key A 32-byte (256-bit) decryption key
   */
  decryptBuffer(encryptedBuffer: Buffer, key: Buffer): Buffer {
    if (key.length !== 32) {
      throw new Error('Invalid KMS key length. AES-256 requires exactly a 32-byte key.');
    }

    if (encryptedBuffer.length < IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('Encrypted payload is too short. Missing IV or Auth Tag.');
    }

    try {
      const iv = encryptedBuffer.subarray(0, IV_LENGTH);
      const authTag = encryptedBuffer.subarray(encryptedBuffer.length - AUTH_TAG_LENGTH);
      const ciphertext = encryptedBuffer.subarray(IV_LENGTH, encryptedBuffer.length - AUTH_TAG_LENGTH);

      const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);

      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      throw new Error(`KMS Decryption failed: ${(error as Error).message}`);
    }
  }

  /**
   * Encrypts a symmetric key using the given master key (Hex output for DB storage)
   */
  private wrapSymmetricKey(symmetricKey: Buffer, masterKey: Buffer): WrappedKey {
    const iv = crypto.randomBytes(16); // 16 bytes for hex storage format
    const cipher = crypto.createCipheriv(ALGORITHM, masterKey, iv);

    let encrypted = cipher.update(symmetricKey.toString('hex'), 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex')
    };
  }

  /**
   * Attempts to unwrap a stored symmetric key with one master key.
   * Returns null when the GCM auth tag does not verify under that key.
   */
  private tryUnwrapWithMaster(record: WrappedKeyRecord, masterKey: Buffer): Buffer | null {
    try {
      const decipher = crypto.createDecipheriv(ALGORITHM, masterKey, Buffer.from(record.iv, 'hex'));
      decipher.setAuthTag(Buffer.from(record.authTag, 'hex'));

      let decryptedHex = decipher.update(record.encryptedKeyValue, 'hex', 'utf8');
      decryptedHex += decipher.final('utf8');
      return Buffer.from(decryptedHex, 'hex');
    } catch {
      return null;
    }
  }

  /**
   * Unwraps a stored symmetric key. During a master-key rotation window the
   * previous master key is tried when the current one does not verify.
   */
  private unwrapSymmetricKey(record: WrappedKeyRecord): Buffer {
    const { current, previous } = resolveMasterKeys();
    const symmetricKey =
      this.tryUnwrapWithMaster(record, current) ??
      (previous ? this.tryUnwrapWithMaster(record, previous) : null);

    if (!symmetricKey) {
      throw new AppError(
        'KMS key could not be unwrapped with the configured master keys',
        StatusCodes.INTERNAL_SERVER_ERROR,
        'KMS_MASTER_KEY_MISMATCH'
      );
    }
    return symmetricKey;
  }

  /**
   * Gets the active, unexpired KMS key for a user
   */
  async getActiveKey(userId: string): Promise<IKMSKey | null> {
    return await KMSKey.findOne({
      creatorId: userId,
      isActive: true,
      ...unexpiredFilter(new Date()),
    });
  }

  /**
   * Gets all KMS keys for a user
   */
  async getAllKeys(userId: string): Promise<IKMSKey[]> {
    return await KMSKey.find({ creatorId: userId }).sort({ createdAt: -1 });
  }

  /**
   * Revokes a KMS key. The state change and its audit row commit together.
   * @param actorId The user performing the revocation, when known.
   */
  async revokeKey(keyId: string, actorId?: string): Promise<IKMSKey> {
    const session = await mongoose.startSession();
    try {
      let revoked: IKMSKey | undefined;
      await session.withTransaction(async () => {
        const key = await KMSKey.findById(keyId).session(session);
        if (!key) throw new Error('KMS key not found');
        if (!key.isActive) throw new Error('KMS key is already inactive');

        key.isActive = false;
        await key.save({ session });
        await kmsAuditService.record(
          {
            action: 'revoke',
            actorId,
            keyId: key._id,
            keyVersion: key.keyVersion,
          },
          session
        );
        revoked = key;
      });
      if (!revoked) throw new Error('KMS key revocation did not complete');
      return revoked;
    } finally {
      session.endSession();
    }
  }

  /**
   * Throws KMS_KEY_EXPIRED when the key's expiry has passed.
   */
  assertKeyNotExpired(key: Pick<IKMSKey, 'keyVersion' | 'expiresAt'>, now: Date = new Date()): void {
    if (key.expiresAt && key.expiresAt.getTime() <= now.getTime()) {
      throw new AppError(
        `KMS key ${key.keyVersion} expired at ${key.expiresAt.toISOString()}`,
        StatusCodes.FORBIDDEN,
        'KMS_KEY_EXPIRED'
      );
    }
  }

  /**
   * Decrypts a payload with a stored KMS key. Expired keys are rejected with
   * KMS_KEY_EXPIRED before any key material is unwrapped.
   */
  async decryptWithStoredKey(keyId: string, encryptedBuffer: Buffer, now: Date = new Date()): Promise<Buffer> {
    const key = await KMSKey.findById(keyId);
    if (!key) {
      throw new AppError('KMS key not found', StatusCodes.NOT_FOUND, 'KMS_KEY_NOT_FOUND');
    }

    this.assertKeyNotExpired(key, now);
    return this.decryptBuffer(encryptedBuffer, this.unwrapSymmetricKey(key));
  }

  /**
   * Deactivates keys whose expiry has passed. Returns the number of keys deactivated.
   */
  async deactivateExpiredKeys(now: Date = new Date()): Promise<number> {
    const result = await KMSKey.updateMany(
      { isActive: true, expiresAt: { $lte: now } },
      { $set: { isActive: false } }
    );
    return result.modifiedCount;
  }

  /**
   * Returns one page of active, unexpired keys created before `cutoff`, in _id
   * order and starting after `afterId`. Pagination by _id keeps the scheduled
   * sweep stable while the keys it rotates are being replaced.
   */
  async findKeysDueForRotation(params: {
    cutoff: Date;
    limit: number;
    afterId?: mongoose.Types.ObjectId;
    now?: Date;
  }): Promise<IKMSKey[]> {
    const { cutoff, limit, afterId, now = new Date() } = params;
    const filter: Record<string, unknown> = {
      isActive: true,
      createdAt: { $lte: cutoff },
      ...unexpiredFilter(now),
    };
    if (afterId) {
      filter._id = { $gt: afterId };
    }

    return await KMSKey.find(filter).sort({ _id: 1 }).limit(limit);
  }

  /**
   * Re-wraps every stored symmetric key under the current master key.
   *
   * Keys that already unwrap under the current master are skipped, so the
   * sweep is idempotent and can be re-run after an interruption. Each key is
   * saved on its own: a crash leaves unprocessed keys still readable through
   * MASTER_KEY_PREVIOUS.
   */
  async rewrapKeysToCurrentMaster(batchSize = 100): Promise<KeyRewrapSummary> {
    const { current, previous } = resolveMasterKeys();
    if (!previous) {
      throw new AppError(
        'MASTER_KEY_PREVIOUS must be set to re-wrap KMS keys',
        StatusCodes.INTERNAL_SERVER_ERROR,
        'KMS_PREVIOUS_MASTER_KEY_MISSING'
      );
    }

    const summary: KeyRewrapSummary = { scanned: 0, rewrapped: 0, alreadyCurrent: 0, failed: [] };
    let afterId: mongoose.Types.ObjectId | undefined;
    let batch: IKMSKey[];

    do {
      batch = await KMSKey.find(afterId ? { _id: { $gt: afterId } } : {})
        .sort({ _id: 1 })
        .limit(batchSize);

      for (const key of batch) {
        summary.scanned += 1;

        if (this.tryUnwrapWithMaster(key, current) !== null) {
          summary.alreadyCurrent += 1;
          continue;
        }

        const symmetricKey = this.tryUnwrapWithMaster(key, previous);
        if (!symmetricKey) {
          summary.failed.push(key.id);
          continue;
        }

        try {
          const wrapped = this.wrapSymmetricKey(symmetricKey, current);
          key.encryptedKeyValue = wrapped.encrypted;
          key.iv = wrapped.iv;
          key.authTag = wrapped.authTag;
          await key.save();
          summary.rewrapped += 1;
        } catch {
          summary.failed.push(key.id);
        }
      }

      afterId = batch[batch.length - 1]?._id;
    } while (batch.length === batchSize);

    return summary;
  }

  /**
   * Rotates a KMS key for a user
   */
  async rotateKey(userId: string): Promise<{
    oldKeyVersion: string;
    newKeyVersion: string;
    assetsReEncrypted: number;
  }> {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const activeKey = await KMSKey.findOne({
        creatorId: userId,
        isActive: true,
        ...unexpiredFilter(new Date()),
      }).session(session);
      if (!activeKey) throw new Error('No active KMS key found for user');

      const oldKeyVersion = activeKey.keyVersion;
      const versionMatch = oldKeyVersion.match(/^v(\d+)$/);
      if (!versionMatch) throw new Error('Invalid key version format');

      const newKeyVersion = `v${parseInt(versionMatch[1]) + 1}`;

      // Generate new symmetric key and encrypt with the current master
      const newSymmetricKey = this.generateSymmetricKey();
      const encryptedNewKey = this.wrapSymmetricKey(newSymmetricKey, resolveMasterKeys().current);

      // Decrypt old symmetric key to access existing asset data
      const oldSymmetricKey = this.unwrapSymmetricKey(activeKey);

      // Find all assets encrypted with the old key
      const assetsToReEncrypt = await Asset.find({
        creatorId: userId,
        isEncrypted: true,
        encryptionKeyVersion: oldKeyVersion
      }).session(session);

      // Re-encrypt actual asset data and update metadata
      for (const asset of assetsToReEncrypt) {
        try {
          // 1. Resolve URL and fetch the encrypted blob from storage
          let downloadUrl = '';
          if (asset.storageProvider === 'cloudinary') {
            downloadUrl = cloudinary.url(asset.storageReferenceId, { resource_type: 'raw', secure: true });
          } else if (asset.storageProvider === 'ipfs') {
            downloadUrl = `${process.env.PINATA_GATEWAY_URL}/${asset.storageReferenceId}`;
          } else {
            throw new Error(`Storage provider ${asset.storageProvider} not supported for rotation`);
          }

          const response = await fetch(downloadUrl);
          if (!response.ok) throw new Error(`Failed to fetch blob from ${asset.storageProvider}`);
          const encryptedBlob = Buffer.from(await response.arrayBuffer());

          // 2. Decrypt with old key, Re-encrypt with new key
          const decryptedPayload = this.decryptBuffer(encryptedBlob, oldSymmetricKey);
          const newEncryptedBlob = this.encryptBuffer(decryptedPayload, newSymmetricKey);

          // 3. Upload the newly encrypted blob
          if (asset.storageProvider === 'cloudinary') {
            const uploadResult = await cloudinaryService.uploadBuffer(newEncryptedBlob, `stellarproof/spv-rotated/${userId}`);
            asset.storageReferenceId = uploadResult.public_id;
          } else if (asset.storageProvider === 'ipfs') {
            const uploadResult = await ipfsService.upload({ content: newEncryptedBlob, name: asset.fileName });
            asset.storageReferenceId = uploadResult.cid;
          }
        } catch (error) {
          throw new Error(`Failed to re-encrypt asset ${asset._id}: ${(error as Error).message}`);
        }

        asset.encryptionKeyVersion = newKeyVersion;
        await asset.save({ session });
      }

      // Deactivate old key
      activeKey.isActive = false;
      await activeKey.save({ session });

      // Save new key
      const newKey = new KMSKey({
        creatorId: userId,
        keyVersion: newKeyVersion,
        algorithm: ALGORITHM.toUpperCase(),
        encryptedKeyValue: encryptedNewKey.encrypted,
        iv: encryptedNewKey.iv,
        authTag: encryptedNewKey.authTag,
        isActive: true
      });

      await newKey.save({ session });
      await kmsAuditService.record(
        {
          action: 'rotate',
          actorId: userId,
          keyId: newKey._id,
          keyVersion: newKeyVersion,
          metadata: {
            previousKeyId: activeKey._id.toString(),
            previousKeyVersion: oldKeyVersion,
            assetsReEncrypted: assetsToReEncrypt.length,
          },
        },
        session
      );
      await session.commitTransaction();

      return {
        oldKeyVersion,
        newKeyVersion,
        assetsReEncrypted: assetsToReEncrypt.length
      };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }
}

export const kmsService = new KmsService();
