import { Router } from "express";
import { z } from "zod";
import { zodBody } from "../../middlewares/zodValidate";
import { verificationController } from "../../controllers/verification.controller";

const router = Router();

const verifySignatureSchema = z
  .object({
    contentHashHex: z.string().regex(/^(sha256:)?[a-fA-F0-9]{64}$/, "must be a 64-char SHA-256 hex digest"),
    signatureHex: z.string().regex(/^[a-fA-F0-9]{128}$/, "must be a 128-char hex Ed25519 signature"),
    spvId: z.string().regex(/^[a-f\d]{24}$/i, "must be a valid MongoDB ObjectId").optional(),
  })
  .strict();

/**
 * @swagger
 * /api/v1/verification/verify-signature:
 *   post:
 *     summary: Re-verify an SPV signature against its content hash
 *     tags: [Verification]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [contentHashHex, signatureHex]
 *             properties:
 *               contentHashHex: { type: string, description: SHA-256 hex digest of the content }
 *               signatureHex: { type: string, description: 128-char hex Ed25519 signature over the raw hash bytes }
 *               spvId: { type: string, description: Optional SPV record id }
 *     responses:
 *       200: { description: "Verdict returned: { valid, reason?, message? }" }
 *       400: { description: Invalid request body }
 *       404: { description: SPV record not found }
 */
router.post(
  "/verify-signature",
  zodBody(verifySignatureSchema),
  verificationController.verifySpvSignature.bind(verificationController)
);

export default router;
