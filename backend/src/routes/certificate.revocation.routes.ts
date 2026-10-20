/**
 * Authenticated certificate routes, mounted alongside the public certificate
 * router under /api/v1/certificates.
 *
 *   POST /api/v1/certificates/:id/revoke
 *     Records an off-chain revocation. Requires a Bearer token; only the
 *     certificate owner or an admin may revoke. The on-chain record is unchanged.
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

export default router;
