/**
 * Persists a minted certificate and every record it references (owner,
 * manifest, asset, completed verification job) through the real models, so
 * certificate share/export tests read the same shape production stores.
 */
import crypto from "crypto";
import mongoose from "mongoose";
import { Keypair, StrKey } from "@stellar/stellar-sdk";

import Asset from "../../../models/Asset.model";
import Certificate from "../../../models/Certificate.model";
import Manifest from "../../../models/Manifest.model";
import User from "../../../models/User.model";
import { VerificationJobModel } from "../../../models/verificationJob.model";
import { VerificationStatus } from "../../../types/verification.types";

export const MEDIA_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
export const MANIFEST_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

const hex = (bytes: number): string => crypto.randomBytes(bytes).toString("hex");

export interface StoredUser {
  id: string;
  role: "creator" | "developer" | "admin";
  email: string;
  stellarPublicKey: string;
}

export interface StoredCertificate {
  owner: StoredUser;
  certificateId: string;
  documentId: string;
  network: "testnet" | "mainnet";
  contractAddress: string;
  transactionHash: string;
  ledgerSequence: number;
  mintedAt: Date;
  contentHash: string;
  manifestHash: string;
  teeAttestationHash: string;
  teeSignature: string;
  codeMeasurementHash: string;
  attestationTransactionHash: string;
  fileName: string;
}

export async function storeUser(role: StoredUser["role"] = "creator"): Promise<StoredUser> {
  const email = `owner-${hex(6)}@example.com`;
  const stellarPublicKey = Keypair.random().publicKey();
  const user = await User.create({
    email,
    passwordHash: hex(32),
    role,
    stellarPublicKey,
    isActive: true,
  });
  return { id: String(user._id), role, email, stellarPublicKey };
}

export async function storeCertificate(
  options: {
    owner?: StoredUser;
    network?: "testnet" | "mainnet";
    storageProvider?: "ipfs" | "cloudinary";
    revokedAt?: Date;
  } = {}
): Promise<StoredCertificate> {
  const owner = options.owner ?? (await storeUser());
  const network = options.network ?? "testnet";
  const contentHash = `sha256:${hex(32)}`;
  const fileName = `holiday-photo-${hex(3)}.jpg`;

  const manifest = await Manifest.create({
    contentHash,
    creator: owner.stellarPublicKey,
    creatorId: owner.id,
    timestamp: new Date(),
    metadata: { description: "Original capture" },
    ipfsCid: MANIFEST_CID,
  });
  // The model derives manifestHash from the manifest content on save.
  const { manifestHash } = manifest;
  if (!manifestHash) throw new Error("Manifest was saved without a manifestHash");

  const asset = await Asset.create({
    creatorId: owner.id,
    fileName,
    mimeType: "image/jpeg",
    sizeBytes: 4_096,
    storageProvider: options.storageProvider ?? "ipfs",
    storageReferenceId: MEDIA_CID,
  });

  const teeAttestationHash = hex(32);
  const teeSignature = hex(64);
  const codeMeasurementHash = hex(32);
  const attestationTransactionHash = hex(32);
  const transactionHash = hex(32);
  const certificateId = String(crypto.randomInt(1, 1_000_000_000));

  const job = await VerificationJobModel.create({
    manifestId: manifest._id,
    assetId: asset._id,
    ownerPublicKey: owner.stellarPublicKey,
    contentHash,
    manifestHash,
    status: VerificationStatus.COMPLETED,
    teeAttestationHash,
    teeSignature,
    codeMeasurementHash,
    attestationTransactionHash,
    stellarTransactionHash: transactionHash,
    certificateId,
  });

  const mintedAt = new Date(Math.floor(Date.now() / 1_000) * 1_000);
  const ledgerSequence = crypto.randomInt(1_000_000, 9_000_000);
  const contractAddress = StrKey.encodeContract(crypto.randomBytes(32));
  const certificate = await Certificate.create({
    verificationJobId: job._id,
    assetId: asset._id,
    manifestId: manifest._id,
    creatorId: new mongoose.Types.ObjectId(owner.id),
    stellarNetwork: network,
    contractAddress,
    certificateId,
    transactionHash,
    ledgerSequence,
    mintedAt,
    ...(options.revokedAt
      ? { revoked: true, revokedAt: options.revokedAt, revokedBy: new mongoose.Types.ObjectId(owner.id) }
      : {}),
  });

  return {
    owner,
    certificateId,
    documentId: String(certificate._id),
    network,
    contractAddress,
    transactionHash,
    ledgerSequence,
    mintedAt,
    contentHash,
    manifestHash,
    teeAttestationHash,
    teeSignature,
    codeMeasurementHash,
    attestationTransactionHash,
    fileName,
  };
}

/** Drops every collection the fixture writes to. */
export async function clearCertificateFixtures(): Promise<void> {
  await Promise.all([
    Asset.deleteMany({}),
    Certificate.deleteMany({}),
    Manifest.deleteMany({}),
    User.deleteMany({}),
    VerificationJobModel.deleteMany({}),
  ]);
}
