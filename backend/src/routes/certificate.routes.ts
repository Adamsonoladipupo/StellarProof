/**
 * Certificate Routes – request validation schemas and route definitions.
 *
 * Endpoints:
 *   GET /api/v1/certificates?creatorId=<ObjectId>&search=<term>&limit=20&skip=0
 *     Returns a paginated list of certificates. `creatorId` narrows the list
 *     to a single owner; when omitted the endpoint exposes the public global
 *     certificate index. `search` matches the on-chain certificateId,
 *     transactionHash and contractAddress (case-insensitive).
 *
 *   GET /api/v1/certificates/verify/:certificateId
 *     Publicly verifies a certificate by cross-checking the off-chain cache
 *     against `provenance.get_certificate` and returning `{ valid, details }`.
 *
 *   GET /api/v1/certificates/stats?creatorId=<ObjectId>
 *     Creator dashboard metrics: total minted, unique verified assets and a
 *     trailing 12-month mint series.
 *
 *   GET /api/v1/certificates/share/:token
 *     Resolves a signed share token to certificate metadata without owner PII.
 *
 *   POST /api/v1/certificates/:id/revoke (authenticated; see
 *     certificate.revocation.routes.ts)
 *     Owner or admin records an off-chain revocation.
 *
 * All Zod schemas are co-located with the routes that use them.
 */
import { Router } from "express";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { StatusCodes } from "http-status-codes";
import { certificateController } from "../controllers/certificate.controller";

// ---------------------------------------------------------------------------
// Zod schema – query parameters for the certificate list endpoint.
// Exported so the validation contract can be unit-tested directly.
// ---------------------------------------------------------------------------
export const listCertificatesQuerySchema = z.object({
  creatorId: z
    .string()
    .regex(/^[a-f\d]{24}$/i, "creatorId must be a valid MongoDB ObjectId")
    .optional(),
  search: z
    .string()
    .trim()
    .max(256, "search must be at most 256 characters")
    .optional(),
  limit: z
    .string()
    .optional()
    .default("20")
    .transform(Number)
    .pipe(
      z
        .number()
        .int("limit must be an integer")
        .min(1, "limit must be at least 1")
        .max(100, "limit must be at most 100")
    ),
  skip: z
    .string()
    .optional()
    .default("0")
    .transform(Number)
    .pipe(
      z
        .number()
        .int("skip must be an integer")
        .min(0, "skip must be a non-negative integer")
    ),
});

// ---------------------------------------------------------------------------
// Zod schema – path parameters for the public verification endpoint.
// Accepts either a certificate `certificateId` or a MongoDB ObjectId, so no
// format is enforced beyond a sane length.
// ---------------------------------------------------------------------------
export const verifyCertificateParamsSchema = z.object({
  certificateId: z
    .string()
    .trim()
    .min(1, "certificateId is required")
    .max(128, "certificateId must be at most 128 characters"),
});

// ---------------------------------------------------------------------------
// Query validation middleware
// ---------------------------------------------------------------------------
function validateListCertificatesQuery(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const result = listCertificatesQuerySchema.safeParse(req.query);
  if (!result.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      error: "Invalid query parameters",
      details: result.error.flatten().fieldErrors,
    });
    return;
  }
  req.query = result.data as unknown as typeof req.query;
  next();
}

// ---------------------------------------------------------------------------
// Path parameter validation middleware
// ---------------------------------------------------------------------------
function validateVerifyCertificateParams(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const result = verifyCertificateParamsSchema.safeParse(req.params);
  if (!result.success) {
    res.status(StatusCodes.BAD_REQUEST).json({
      success: false,
      error: "Invalid path parameters",
      details: result.error.flatten().fieldErrors,
    });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const router = Router();

/**
 * GET /api/v1/certificates/verify/:certificateId
 *
 * Public verification endpoint. Cross-checks the off-chain certificate cache
 * against the ledger-stored provenance record.
 *
 * Response 200:
 * {
 *   "success": true,
 *   "data": {
 *     "valid": true,
 *     "details": { "certificateId": "41", "onChain": { ... }, ... }
 *   }
 * }
 */
router.get(
  "/verify/:certificateId",
  validateVerifyCertificateParams,
  certificateController.verifyCertificate.bind(certificateController)
);

/**
 * GET /api/v1/certificates/export.csv?creatorId=<ObjectId>&search=<term>
 *
 * Streams every certificate matching the same `creatorId` and `search`
 * filters as the list endpoint as `text/csv`. `limit` and `skip` are accepted
 * for parity with the list endpoint but do not paginate the export.
 */
router.get(
  "/export.csv",
  validateListCertificatesQuery,
  certificateController.exportCertificatesCsv.bind(certificateController)
);

/**
 * GET /api/v1/certificates?creatorId=<ObjectId>&search=<term>&limit=20&skip=0
 *
 * Query parameters:
 *   - creatorId  (optional) – MongoDB ObjectId of the certificate owner. When
 *                omitted, the public global certificate index is returned.
 *   - search     (optional, ≤256 chars) – matches certificateId, transactionHash
 *                and contractAddress (case-insensitive).
 *   - limit      (optional, 1–100, default 20) – page size.
 *   - skip       (optional, ≥0, default 0)     – offset for pagination.
 *
 * Response 200:
 * {
 *   "success": true,
 *   "data": {
 *     "certificates": [ ...ICertificate ],
 *     "total": 42,
 *     "limit": 20,
 *     "skip": 0
 *   }
 * }
 */
router.get(
  "/",
  validateListCertificatesQuery,
  certificateController.listCertificates.bind(certificateController)
);

/**
 * GET /api/v1/certificates/share/:token
 *
 * Public endpoint behind share links. Returns 401 for an invalid token, 410
 * once it has expired and 404 if the certificate no longer exists.
 */
router.get(
  "/share/:token",
  certificateController.getSharedCertificate.bind(certificateController)
);

/**
 * GET /api/v1/certificates/stats?creatorId=<ObjectId>
 *
 * Creator dashboard metrics: `totalMinted`, `uniqueAssetsVerified` and a
 * zero-filled trailing 12-month `monthlySeries` (UTC, oldest first).
 */
router.get(
  "/stats",
  certificateController.getCertificateStats.bind(certificateController)
);

export default router;
