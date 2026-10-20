import mongoose, { Schema, Document } from 'mongoose';

/**
 * SPVRecord Interface (Sealed Provenance Vault)
 * Represents the encrypted vault for a specific digital asset.
 * It holds the access control policies and references the KMS Key used for encryption.
 */
export interface ISPVRecord extends Document {
  assetId: mongoose.Types.ObjectId;      // The encrypted asset being protected
  creatorId: mongoose.Types.ObjectId;    // The owner of the vault
  kmsKeyId: mongoose.Types.ObjectId;     // Reference to the KMS key used for encryption

  // Provenance chain links (media -> manifest -> proof -> certificate).
  // Both are empty until the asset has been verified and minted; the
  // manifest and job are reachable from the certificate itself.
  certificateId?: mongoose.Types.ObjectId;       // Certificate minted for this asset
  verificationJobId?: mongoose.Types.ObjectId;   // Verification job that produced the certificate

  // Access Control Policies
  accessType: 'private' | 'public_with_conditions' | 'nft_holders_only' | 'specific_users';
  allowedUsers?: mongoose.Types.ObjectId[]; // List of user IDs allowed to decrypt
  nftContractAddress?: string;           // Stellar Contract ID if gated by NFT ownership
  
  // Vault State
  isSealed: boolean;                     // If true, the asset is fully locked
  
  createdAt: Date;
  updatedAt: Date;
}

const SPVRecordSchema: Schema = new Schema(
  {
    assetId: {
      type: Schema.Types.ObjectId,
      ref: 'Asset',
      required: true,
      unique: true, // One asset gets one vault record
    },
    creatorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    kmsKeyId: {
      type: Schema.Types.ObjectId,
      ref: 'KMSKey',
      required: true,
    },
    certificateId: {
      type: Schema.Types.ObjectId,
      ref: 'Certificate',
      index: true,
      default: undefined,
    },
    verificationJobId: {
      type: Schema.Types.ObjectId,
      ref: 'VerificationJob',
      index: true,
      default: undefined,
    },
    accessType: {
      type: String,
      enum: ['private', 'public_with_conditions', 'nft_holders_only', 'specific_users'],
      default: 'private',
    },
    allowedUsers: [{
      type: Schema.Types.ObjectId,
      ref: 'User',
    }],
    nftContractAddress: {
      type: String,
    },
    isSealed: {
      type: Boolean,
      default: true,
    }
  },
  { timestamps: true }
);

export default mongoose.models['SPVRecord'] as mongoose.Model<ISPVRecord> || mongoose.model<ISPVRecord>('SPVRecord', SPVRecordSchema);
