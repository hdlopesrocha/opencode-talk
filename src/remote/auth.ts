import type { NextFunction, Request, Response } from "express";
import { createLogger } from "./logger.js";

const log = createLogger("auth");

/**
 * Simple Bearer-token auth for local/private deployments.
 * All /api/* routes require `Authorization: Bearer <token>`,
 * except /health which stays unauthenticated for probes.
 */
export function bearerAuthMiddleware(expectedToken: string) {
  if (!expectedToken) {
    log.warn("SESSION_API_TOKEN is empty — API auth is disabled. Set a token for any real deployment.");
  }
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.path === "/health" || req.path === "/api/health") {
      next();
      return;
    }
    if (!expectedToken) {
      next();
      return;
    }
    const header = req.header("authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token && timingSafeEqual(token, expectedToken)) {
      next();
      return;
    }
    res.status(401).json({ error: "unauthorized", message: "Invalid or missing API token" });
  };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Client helper: builds the Authorization header for Session API requests. */
export function authHeaders(token: string): Record<string, string> {
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}
