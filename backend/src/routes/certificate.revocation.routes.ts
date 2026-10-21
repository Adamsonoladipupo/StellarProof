/**
 * Authenticated certificate routes, mounted alongside the public certificate
 * router under /api/v1/certificates. Each requires a Bearer token and is
 * limited to the certificate owner or an admin.
 *
 *   POST /api/v1/certificates/:id/revoke
 *     Records an off-chain revocation. The on-chain record is unchanged.
 *
 *   GET /api/v1/certificates/:id/share
 *     Issues a signed, expiring share link for the public certificate page.
 *
 *   GET /api/v1/certificates/:id/export.json
 *   GET /api/v1/certificates/:id/export.pdf
 *     Verifiable JSON export, or a PDF rendition with a verification QR code.
 *
 * Kept separate from certificate.routes.ts so the public routes do not load
 * the auth stack (and its environment checks).
 */
import { Router } from "express";
import { certificateController } from "../controllers/certificate.controller";
import { protect } from "../middlewares/auth.middleware";

const router = Router();

router.post(
  "/:id/revoke",
  protect,
  certificateController.revokeCertificate.bind(certificateController)
);

router.get(
  "/:id/share",
  protect,
  certificateController.shareCertificate.bind(certificateController)
);

router.get(
  "/:id/export.json",
  protect,
  certificateController.exportCertificateJson.bind(certificateController)
);

router.get(
  "/:id/export.pdf",
  protect,
  certificateController.exportCertificatePdf.bind(certificateController)
);

export default router;
