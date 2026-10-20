/** Domain types for server-side SPV signature re-verification. */

export interface VerifySpvSignatureInput {
  /** SHA-256 digest of the content, 64 hex chars (optionally `sha256:` prefixed). */
  contentHashHex: string;
  /** Ed25519 signature over the raw 32-byte content hash, 128 hex chars. */
  signatureHex: string;
  /** Optional SPV record id; when given, the record's contentHash must match. */
  spvId?: string;
}

export type SpvSignatureFailureReason =
  | "INVALID_CONTENT_HASH_FORMAT"
  | "INVALID_SIGNATURE_FORMAT"
  | "CONTENT_HASH_MISMATCH"
  | "INVALID_PUBLIC_KEY"
  | "SIGNATURE_MISMATCH";

export interface VerifySpvSignatureResult {
  valid: boolean;
  /** Present only when `valid` is false. */
  reason?: SpvSignatureFailureReason;
  /** Human-readable explanation; present only when `valid` is false. */
  message?: string;
  /** Id of the SPV record whose key was used. */
  spvId?: string;
  /** Stellar G-address the signature was checked against. */
  publicKey?: string;
}
