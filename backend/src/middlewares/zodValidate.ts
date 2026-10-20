import type { NextFunction, Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import type { ZodTypeAny } from "zod";
import { AppError } from "../errors/AppError";

/** Validates `req.body` against a zod schema and replaces it with the parsed value. */
export const zodBody =
  (schema: ZodTypeAny) =>
  (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      const details = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
      next(new AppError(`Invalid request body: ${details.join("; ")}`, StatusCodes.BAD_REQUEST, "VALIDATION_ERROR"));
      return;
    }
    req.body = parsed.data;
    next();
  };
