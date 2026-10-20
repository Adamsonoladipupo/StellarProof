import type { Request, Response, NextFunction } from "express";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../errors/AppError";
import { certificateService } from "../services/certificate.service";
import type { ListCertificatesQuery } from "../types/certificate.types";

export class CertificateController {
  async listCertificates(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const query = req.query as unknown as ListCertificatesQuery;
      const result = await certificateService.listCertificates(query);
      res.status(StatusCodes.OK).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  async getCertificateById(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const id = req.params.id?.trim();
      if (!id) {
        throw new AppError(
          "Certificate id is required",
          StatusCodes.BAD_REQUEST,
          "MISSING_CERTIFICATE_ID"
        );
      }

      const certificate = await certificateService.getCertificateById(id);
      if (!certificate) {
        throw new AppError(
          "Certificate not found",
          StatusCodes.NOT_FOUND,
          "CERTIFICATE_NOT_FOUND"
        );
      }

      res.status(StatusCodes.OK).json({
        success: true,
        data: certificate,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/certificates/verify/:certificateId
   * Verifies a cached certificate against on-chain provenance data.
   */
  async verifyCertificate(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const certificateId = req.params.certificateId?.trim();
      if (!certificateId) {
        throw new AppError(
          "Certificate id is required",
          StatusCodes.BAD_REQUEST,
          "MISSING_CERTIFICATE_ID"
        );
      }

      const result = await certificateService.verifyCertificate(certificateId);

      res.status(StatusCodes.OK).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/certificates/stats?creatorId=<ObjectId>
   * Creator dashboard metrics: total mints, unique verified assets and the
   * trailing 12-month mint series.
   */
  async getCertificateStats(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const creatorId =
        typeof req.query.creatorId === "string" ? req.query.creatorId.trim() : "";
      const stats = await certificateService.getStats({ creatorId });

      res.status(StatusCodes.OK).json({
        success: true,
        data: stats,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/certificates/:id/revoke
   * Owner or admin records an off-chain revocation. The on-chain record is
   * not modified.
   */
  async revokeCertificate(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const id = req.params.id?.trim();
      if (!id) {
        throw new AppError(
          "Certificate id is required",
          StatusCodes.BAD_REQUEST,
          "MISSING_CERTIFICATE_ID"
        );
      }

      if (!req.user) {
        throw new AppError(
          "Authentication required",
          StatusCodes.UNAUTHORIZED,
          "UNAUTHORIZED"
        );
      }

      const certificate = await certificateService.revokeCertificate(id, {
        id: req.user.id,
        role: req.user.role,
      });

      res.status(StatusCodes.OK).json({
        success: true,
        data: certificate,
      });
    } catch (err) {
      next(err);
    }
  }
}

export const certificateController = new CertificateController();

export const getCertificateById = (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => certificateController.getCertificateById(req, res, next);

export const verifyCertificate = (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => certificateController.verifyCertificate(req, res, next);
