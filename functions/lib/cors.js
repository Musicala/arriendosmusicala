"use strict";

/**
 * CORS centralizado. Se aplica a TODAS las respuestas (2xx, 4xx y 5xx) para que
 * el navegador nunca reciba un "Failed to fetch" sin diagnostico.
 */

const STATIC_ALLOWED_ORIGINS = [
  "https://musicala.github.io"
];

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

// Previews de GitHub Pages / Firebase Hosting del propio proyecto.
const PREVIEW_ORIGIN_RES = [
  /^https:\/\/[a-z0-9-]+\.github\.io$/i,
  /^https:\/\/arriendos-musicala(--[a-z0-9-]+)?\.web\.app$/i,
  /^https:\/\/arriendos-musicala(--[a-z0-9-]+)?\.firebaseapp\.com$/i
];

const ALLOWED_HEADERS = [
  "Content-Type",
  "X-Agent-Key",
  "X-Idempotency-Key",
  "X-Request-Source"
];

const EXPOSED_HEADERS = ["X-Request-Id", "X-Api-Version"];

function isAllowedOrigin(origin) {
  const value = (origin || "").trim();
  if (!value) return false;
  if (STATIC_ALLOWED_ORIGINS.includes(value)) return true;
  if (LOCAL_ORIGIN_RE.test(value)) return true;
  return PREVIEW_ORIGIN_RES.some((re) => re.test(value));
}

/**
 * Devuelve los headers CORS que corresponden a un origen dado.
 * Si el origen no esta permitido igual devolvemos headers utiles (sin
 * Allow-Origin) para que el cliente pueda explicar el problema.
 */
function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": ALLOWED_HEADERS.join(", "),
    "Access-Control-Expose-Headers": EXPOSED_HEADERS.join(", "),
    "Access-Control-Max-Age": "3600",
    Vary: "Origin"
  };

  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }

  return headers;
}

module.exports = {
  ALLOWED_HEADERS,
  EXPOSED_HEADERS,
  LOCAL_ORIGIN_RE,
  STATIC_ALLOWED_ORIGINS,
  corsHeaders,
  isAllowedOrigin
};
