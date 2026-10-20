import crypto from 'crypto';
import mongoose from 'mongoose';
import { Readable } from 'stream';
import KMSKey, { IKMSKey } from '../models/KMSKey.model';
import Asset, { IAsset } from '../models/Asset.model';
import SPVRecordModel from '../models/SPVRecord.model';
import { ipfsService } from './ipfs.service';
import { kmsAuditService } from './kmsAudit.service';
import { v2 as cloudinary } from 'cloudinary';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit nonce is standard for GCM buffers
const AUTH_TAG_LENGTH = 16; // 128-bit auth tag
const DATA_KEY_LENGTH = 32; // AES-256 data key

export interface RotateKeyResult {
  oldKeyVersion: string;
  newKeyVersion: string;
  assetsReEncrypted: number;
}

/** A blob stored by a provider, identified by the reference the Asset holds. */
interface StorageRef {
  provider: 'cloudinary' | 'ipfs';
  reference: string;
}

/** Blobs written or replaced during a rotation, used for storage cleanup. */
interface BlobTracker {
  uploaded: StorageRef[];
  replaced: StorageRef[];
}

/** Parses a key version such as `v3`. */
function parseKeyVersion(keyVersion: string): number {
  const match = keyVersion.match(/^v(\d+)$/);
  if (!match) throw new Error(`Invalid key version format: ${keyVersion}`);
  return parseInt(match[1], 10);
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
   * Gets the active KMS key for a user
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
   * Re-keys every encrypted asset owned by `userId` under one new data key.
   *
   * Each asset keeps its own data key, referenced by its SPVRecord. For every
   * asset the service unwraps that key with KMS_MASTER_KEY, downloads the
   * stored blob, decrypts it, re-encrypts it under the new key and uploads the
   * result to the same provider. All database writes (asset references and
   * versions, the new KMSKey, deactivation of previous keys and the SPVRecord
   * key pointers) are committed in a single transaction.
   *
   * Storage writes cannot join the transaction, so they are ordered around it:
   * new blobs are destroyed again if the transaction fails, and replaced blobs
   * are destroyed only after the commit succeeds.
   *
   * @throws {Error} when the user has no active key, an asset has no resolvable
   *   key, or any blob cannot be re-encrypted. Nothing is changed in that case.
   */
  async rotateKey(userId: string): Promise<RotateKeyResult> {
    const session = await mongoose.startSession();
    const blobs: BlobTracker = { uploaded: [], replaced: [] };
    let committing = false;
    let result: RotateKeyResult;

    try {
      session.startTransaction();
      result = await this.applyRotation(session, userId, blobs);
      committing = true;
      await session.commitTransaction();
    } catch (error) {
      if (committing) {
        // The commit outcome is unknown, so the database may already point at
        // the new blobs. Keep them and log them for reconciliation.
        logger.error('KMS rotation commit failed; new blobs retained for reconciliation', {
          userId,
          uploaded: blobs.uploaded,
        });
      } else {
        if (session.inTransaction()) await session.abortTransaction();
        await this.destroyBlobs(blobs.uploaded);
      }
      throw error;
    } finally {
      await session.endSession();
    }

    await this.destroyBlobs(blobs.replaced);
    return result;
  }

  /**
   * Performs the database and storage work of a rotation inside an open
   * transaction. It does not commit; the caller owns the transaction.
   */
  private async applyRotation(
    session: mongoose.ClientSession,
    userId: string,
    blobs: BlobTracker
  ): Promise<RotateKeyResult> {
    const activeKeys = await KMSKey.find({ creatorId: userId, isActive: true }).session(session);
    if (activeKeys.length === 0) throw new Error('No active KMS key found for user');

    const allKeys = await KMSKey.find({ creatorId: userId }).select('keyVersion').session(session);
    const oldKeyVersion = `v${Math.max(...activeKeys.map((key) => parseKeyVersion(key.keyVersion)))}`;
    const newKeyVersion = `v${Math.max(...allKeys.map((key) => parseKeyVersion(key.keyVersion))) + 1}`;

    const newDataKey = this.generateSymmetricKey();

    const assets = await Asset.find({
      creatorId: userId,
      isEncrypted: true,
      encryptionKeyVersion: { $ne: newKeyVersion },
    }).session(session);

    const reEncryptedAssetIds: mongoose.Types.ObjectId[] = [];

    for (const asset of assets) {
      const spvRecord = await SPVRecordModel.findOne({ assetId: asset._id }).session(session);
      if (!spvRecord) {
        throw new Error(`Asset ${asset._id} has no SPV record that references its key`);
      }

      const currentKey = await KMSKey.findById(spvRecord.kmsKeyId).session(session);
      if (!currentKey) {
        throw new Error(`KMS key ${spvRecord.kmsKeyId} for asset ${asset._id} was not found`);
      }

      let newRef: StorageRef;
      try {
        newRef = await this.reencryptStoredBlob(
          asset,
          userId,
          this.unwrapDataKey(currentKey),
          newDataKey
        );
      } catch (error) {
        throw new Error(`Failed to re-encrypt asset ${asset._id}: ${(error as Error).message}`);
      }

      blobs.uploaded.push(newRef);
      blobs.replaced.push({ provider: asset.storageProvider as StorageRef['provider'], reference: asset.storageReferenceId });

      asset.storageReferenceId = newRef.reference;
      asset.encryptionKeyVersion = newKeyVersion;
      await asset.save({ session });
      reEncryptedAssetIds.push(asset._id);
    }

    const wrapped = this.wrapDataKey(newDataKey);
    const newKey = new KMSKey({
      creatorId: userId,
      keyVersion: newKeyVersion,
      algorithm: ALGORITHM.toUpperCase(),
      encryptedKeyValue: wrapped.encryptedKeyValue,
      iv: wrapped.iv,
      authTag: wrapped.authTag,
      isActive: true,
    });
    await newKey.save({ session });

    await KMSKey.updateMany(
      { creatorId: userId, isActive: true, _id: { $ne: newKey._id } },
      { $set: { isActive: false } }
    ).session(session);

    if (reEncryptedAssetIds.length > 0) {
      await SPVRecordModel.updateMany(
        { assetId: { $in: reEncryptedAssetIds } },
        { $set: { kmsKeyId: newKey._id } }
      ).session(session);
    }

    return {
      oldKeyVersion,
      newKeyVersion,
      assetsReEncrypted: reEncryptedAssetIds.length,
    };
  }

  /**
   * Fetches an asset's stored blob, re-encrypts it from `fromKey` to `toKey`
   * and uploads the result to the same provider.
   */
  private async reencryptStoredBlob(
    asset: IAsset,
    userId: string,
    fromKey: Buffer,
    toKey: Buffer
  ): Promise<StorageRef> {
    const provider = asset.storageProvider;
    if (provider !== 'cloudinary' && provider !== 'ipfs') {
      throw new Error(`Storage provider ${provider} not supported for rotation`);
    }

    const blob = await this.fetchStoredBlob(provider, asset.storageReferenceId);
    const plaintext = this.decryptAssetPayload(blob, fromKey);
    const encrypted = this.encryptAssetPayload(plaintext, toKey);

    if (provider === 'cloudinary') {
      const publicId = `stellarproof/spv/${userId}/${crypto.randomUUID()}`;
      const uploaded = await this.uploadRawToCloudinary(encrypted, publicId);
      return { provider, reference: uploaded.public_id };
    }

    const uploaded = await ipfsService.upload({ content: encrypted, name: asset.fileName });
    return { provider, reference: uploaded.cid };
  }

  private async fetchStoredBlob(
    provider: StorageRef['provider'],
    reference: string
  ): Promise<Buffer> {
    let url: string;
    if (provider === 'cloudinary') {
      url = cloudinary.url(reference, { resource_type: 'raw', secure: true });
    } else {
      const gateway = process.env.PINATA_GATEWAY_URL;
      if (!gateway) throw new Error('PINATA_GATEWAY_URL is not configured');
      url = `${gateway.replace(/\/$/, '')}/${reference}`;
    }

    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to fetch blob from ${provider}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Decrypts an asset blob in the layout written by SPV uploads:
   * [authTag (16 bytes) | IV (12 bytes) | ciphertext].
   */
  private decryptAssetPayload(blob: Buffer, key: Buffer): Buffer {
    if (blob.length < AUTH_TAG_LENGTH + IV_LENGTH) {
      throw new Error('Encrypted payload is too short. Missing auth tag or IV.');
    }

    const authTag = blob.subarray(0, AUTH_TAG_LENGTH);
    const iv = blob.subarray(AUTH_TAG_LENGTH, AUTH_TAG_LENGTH + IV_LENGTH);
    const ciphertext = blob.subarray(AUTH_TAG_LENGTH + IV_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  /** Encrypts an asset blob in the SPV upload layout: [authTag | IV | ciphertext]. */
  private encryptAssetPayload(plaintext: Buffer, key: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([cipher.getAuthTag(), iv, ciphertext]);
  }

  /** Reads KMS_MASTER_KEY (64 hex characters) used to wrap per-asset data keys. */
  private resolveWrappingKey(): Buffer {
    const hex = process.env.KMS_MASTER_KEY;
    if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('KMS_MASTER_KEY must be a 64-character hex string (32 bytes for AES-256)');
    }
    return Buffer.from(hex, 'hex');
  }

  /**
   * Wraps a data key with KMS_MASTER_KEY, producing the fields stored on a
   * KMSKey document. Mirrors the layout written by SPV uploads.
   */
  private wrapDataKey(dataKey: Buffer): { encryptedKeyValue: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.resolveWrappingKey(), iv);
    const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);

    return {
      encryptedKeyValue: wrapped.toString('base64'),
      iv: iv.toString('hex'),
      authTag: cipher.getAuthTag().toString('hex'),
    };
  }

  /**
   * Unwraps the data key stored on a KMSKey document. Keys in any other
   * format (for example, the legacy hex format) are rejected explicitly.
   */
  private unwrapDataKey(kmsKey: IKMSKey): Buffer {
    const wrapped = Buffer.from(kmsKey.encryptedKeyValue, 'base64');
    const iv = Buffer.from(kmsKey.iv, 'hex');
    const authTag = Buffer.from(kmsKey.authTag, 'hex');

    if (
      wrapped.length !== DATA_KEY_LENGTH ||
      iv.length !== IV_LENGTH ||
      authTag.length !== AUTH_TAG_LENGTH
    ) {
      throw new Error(`KMS key ${kmsKey._id} is not in a supported wrapping format`);
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, this.resolveWrappingKey(), iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  }

  private uploadRawToCloudinary(buffer: Buffer, publicId: string): Promise<UploadApiResponse> {
    return new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        { resource_type: 'raw', public_id: publicId, overwrite: false },
        (error: UploadApiErrorResponse | undefined, result: UploadApiResponse | undefined) => {
          if (error || !result) {
            reject(error ?? new Error('Cloudinary upload_stream returned no result'));
            return;
          }
          resolve(result);
        }
      );

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

  /**
   * Deletes replaced or orphaned Cloudinary blobs. Failures are logged rather
   * than thrown: the database state is already final at this point.
   * IPFS content is not deleted here; it stays pinned until unpinned separately.
   */
  private async destroyBlobs(refs: StorageRef[]): Promise<void> {
    for (const ref of refs) {
      if (ref.provider !== 'cloudinary') continue;
      try {
        await cloudinary.uploader.destroy(ref.reference, { resource_type: 'raw' });
      } catch (error) {
        logger.warn('Failed to delete blob during KMS rotation', {
          provider: ref.provider,
          reference: ref.reference,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

export const kmsService = new KmsService();
