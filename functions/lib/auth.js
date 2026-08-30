"use strict";

const crypto = require("crypto");

/**
 * Autenticacion por clave temporal.
 *
 * Reglas de seguridad:
 * - La clave en claro NUNCA se guarda (ni en Firestore, ni en logs, ni en la
 *   auditoria). Solo se guarda su hash SHA-256.
 * - La comparacion se hace por hash, con lookup indexado.
 * - Nunca se devuelve la clave (ni parcial) en mensajes de error.
 */

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 40;

function sha256hex(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

/**
 * Extrae la clave del request. Preferimos el header propio X-Agent-Key:
 * el header Authorization lo intercepta la capa IAM de Cloud Run y hace que
 * la peticion muera antes de llegar al codigo (causa del "Failed to fetch").
 */
function extractAgentKey(headers, body) {
  const get = (name) => {
    const value = headers && (headers[name] || headers[name.toLowerCase()]);
    return value === undefined || value === null ? "" : String(value);
  };

  const direct = get("x-agent-key").trim();
  if (direct) return direct;

  const authorization = get("authorization").trim();
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }

  if (body && typeof body === "object" && typeof body.agentKey === "string") {
    return body.agentKey.trim();
  }

  return "";
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  return null;
}

/**
 * Evalua el estado de un documento de token. Puro y testeable.
 */
function evaluateToken(tokenData, nowMs) {
  if (!tokenData) {
    return { ok: false, status: 401, code: "AUTH_INVALID", message: "Clave de agente invalida." };
  }
  if (tokenData.revoked === true) {
    return { ok: false, status: 403, code: "AUTH_REVOKED", message: "Clave de agente revocada." };
  }
  const expiresAtMs = toMillis(tokenData.expiresAt);
  if (expiresAtMs !== null && expiresAtMs < nowMs) {
    return { ok: false, status: 403, code: "AUTH_EXPIRED", message: "Clave de agente vencida." };
  }
  if (tokenData.scope && tokenData.scope !== "import") {
    return { ok: false, status: 403, code: "AUTH_SCOPE", message: "La clave no tiene permiso de importacion." };
  }
  return { ok: true, status: 200, code: "AUTH_OK", message: "Clave valida." };
}

/**
 * Limite de uso por clave: ventana deslizante simple guardada en el token.
 * Permite lotes pequenos de IA pero corta abuso.
 */
function evaluateRateLimit(tokenData, nowMs, options = {}) {
  const windowMs = options.windowMs || RATE_LIMIT_WINDOW_MS;
  const maxRequests = options.maxRequests || RATE_LIMIT_MAX_REQUESTS;
  const windowStart = toMillis(tokenData && tokenData.rateWindowStart);
  const count = Number((tokenData && tokenData.rateWindowCount) || 0);

  if (windowStart === null || nowMs - windowStart > windowMs) {
    return { allowed: true, nextWindowStart: nowMs, nextCount: 1, retryAfterSeconds: 0 };
  }

  if (count >= maxRequests) {
    return {
      allowed: false,
      nextWindowStart: windowStart,
      nextCount: count,
      retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000))
    };
  }

  return { allowed: true, nextWindowStart: windowStart, nextCount: count + 1, retryAfterSeconds: 0 };
}

module.exports = {
  RATE_LIMIT_MAX_REQUESTS,
  RATE_LIMIT_WINDOW_MS,
  evaluateRateLimit,
  evaluateToken,
  extractAgentKey,
  sha256hex
};
