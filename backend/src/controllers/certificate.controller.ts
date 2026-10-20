import { once } from "events";
import type { Request, Response, NextFunction } from "express";
import { StatusCodes } from "http-status-codes";
import { AppError } from "../errors/AppError";
import { certificateService } from "../services/certificate.service";
import type { ListCertificatesQuery } from "../types/certificate.types";
import logger from "../utils/logger";
import { toCsvLine } from "../utils/csv";

/** Export columns, in order. Each entry maps a header to a document field. */
const CSV_COLUMNS = [
  "certificateId",
  "stellarNetwork",
  "contractAddress",
  "transactionHash",
  "ledgerSequence",
  "mintedAt",
  "creatorId",
  "assetId",
  "manifestId",
  "verificationJobId",
  "createdAt",
] as const;

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
   * GET /api/v1/certificates/export.csv
   * Streams every certificate matching the list filters as CSV. Rows are read
   * from MongoDB in batches and written with backpressure, so memory use does
   * not grow with the size of the export.
   */
  async exportCertificatesCsv(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const cursor = certificateService.streamCertificatesForExport(
        req.query as unknown as ListCertificatesQuery
      );

      res.status(StatusCodes.OK);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="certificates.csv"');
      res.write(toCsvLine(CSV_COLUMNS));

      try {
        for await (const certificate of cursor) {
          if (res.destroyed) break;
          const row = CSV_COLUMNS.map((column) => certificate[column]);
          if (!res.write(toCsvLine(row))) {
            await once(res, "drain");
          }
        }
        res.end();
      } catch (err) {
        // Headers are already sent, so the response cannot become a JSON error.
        logger.error("Certificate CSV export failed mid-stream", {
          error: err instanceof Error ? err.message : String(err),
        });
        res.destroy(err instanceof Error ? err : new Error(String(err)));
      } finally {
        await cursor.close().catch(() => undefined);
      }
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
