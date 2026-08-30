"use strict";

const { corsHeaders, isAllowedOrigin } = require("./cors");
const { buildWarnings, validateBatch } = require("./schema");
const {
  evaluateRateLimit,
  evaluateToken,
  extractAgentKey,
  sha256hex
} = require("./auth");

const API_VERSION = "2.0.0";
const MAX_ITEMS = 25;
const MAX_BODY_BYTES = 512 * 1024;
const COLLECTION_OPTIONS = "rentalOptions";
const COLLECTION_TOKENS = "agentTokens";
const COLLECTION_LOGS = "agentImportLogs";
const COLLECTION_BATCHES = "agentImportBatches";

function defaultNewId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function readHeader(req, name) {
  if (typeof req.get === "function") return req.get(name) || "";
  const headers = req.headers || {};
  return headers[name] || headers[name.toLowerCase()] || "";
}

function readPath(req) {
  const raw = req.path || req.url || "/";
  return `/${String(raw).split("?")[0].replace(/^\/+/, "").replace(/\/+$/, "")}`;
}

function getItems(body) {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.items)) return body.items;
  if (body && body.item && typeof body.item === "object") return [body.item];
  return [];
}

/**
 * Crea el handler HTTP. Recibe sus dependencias para poder testearlo sin
 * Firebase real.
 */
function createHandler(deps) {
  const db = deps.db;
  const fieldValue = deps.fieldValue;
  const now = deps.now || (() => Date.now());
  const newId = deps.newId || defaultNewId;
  const maxItems = deps.maxItems || MAX_ITEMS;

  function send(req, res, status, payload, extraHeaders) {
    const origin = readHeader(req, "origin");
    const headers = Object.assign({}, corsHeaders(origin), extraHeaders || {});
    headers["X-Api-Version"] = API_VERSION;
    headers["Cache-Control"] = "no-store";

    Object.entries(headers).forEach(([key, value]) => {
      if (value !== undefined && value !== null) res.set(key, value);
    });

    res.status(status).json(payload);
  }

  function fail(req, res, status, code, message, extra) {
    const requestId = (extra && extra.requestId) || newId();
    send(
      req,
      res,
      status,
      Object.assign(
        {
          ok: false,
          code,
          error: message,
          requestId,
          apiVersion: API_VERSION,
          originAllowed: isAllowedOrigin(readHeader(req, "origin")),
          timestamp: new Date(now()).toISOString()
        },
        extra || {}
      ),
      { "X-Request-Id": requestId }
    );
  }

  async function writeAuditLog(req, entry) {
    try {
      await db.collection(COLLECTION_LOGS).add(
        Object.assign(
          {
            createdAt: fieldValue.serverTimestamp(),
            createdAtIso: new Date(now()).toISOString(),
            origin: String(readHeader(req, "origin")).slice(0, 200),
            userAgent: String(readHeader(req, "user-agent")).slice(0, 300),
            source: "agent"
          },
          entry
        )
      );
    } catch (error) {
      // La auditoria nunca debe tumbar la importacion.
    }
  }

  async function findExistingOption(option) {
    const queries = [];
    if (option.listingUrl) {
      queries.push(["listingUrl", option.listingUrl]);
      queries.push(["sourceUrl", option.listingUrl]);
    }
    if (option.duplicateKey) {
      queries.push(["duplicateKey", option.duplicateKey]);
    }

    for (const [field, value] of queries) {
      const snapshot = await db.collection(COLLECTION_OPTIONS).where(field, "==", value).limit(1).get();
      if (!snapshot.empty) return snapshot.docs[0].id;
    }
    return null;
  }

  async function handleHealth(req, res) {
    const requestId = newId();
    let firestoreOk = true;
    try {
      await db.collection(COLLECTION_TOKENS).limit(1).get();
    } catch (error) {
      firestoreOk = false;
    }

    send(
      req,
      res,
      firestoreOk ? 200 : 503,
      {
        ok: firestoreOk,
        status: firestoreOk ? "healthy" : "degraded",
        service: "agentImportRentalOptions",
        apiVersion: API_VERSION,
        timestamp: new Date(now()).toISOString(),
        firestore: firestoreOk ? "ok" : "unreachable",
        requestId,
        origin: readHeader(req, "origin") || null,
        originAllowed: isAllowedOrigin(readHeader(req, "origin")),
        acceptedMethods: ["GET /health", "POST /"],
        agentKeyHeader: "X-Agent-Key",
        maxItemsPerBatch: maxItems
      },
      { "X-Request-Id": requestId }
    );
  }

  async function handleImport(req, res) {
    const requestId = newId();
    const startedAt = now();
    const origin = readHeader(req, "origin");

    const contentType = String(readHeader(req, "content-type") || "").toLowerCase();
    if (contentType && !contentType.includes("application/json")) {
      return fail(req, res, 415, "UNSUPPORTED_MEDIA_TYPE", "Usa Content-Type: application/json.", { requestId });
    }

    const rawBodySize = req.rawBody ? req.rawBody.length : Number(readHeader(req, "content-length")) || 0;
    if (rawBodySize > MAX_BODY_BYTES) {
      return fail(req, res, 413, "PAYLOAD_TOO_LARGE", "El cuerpo del request es demasiado grande.", { requestId });
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const dryRun = body.dryRun === true;
    const providedKey = extractAgentKey(req.headers || {}, body);

    if (!providedKey) {
      return fail(req, res, 401, "AUTH_MISSING", "Falta la clave temporal del agente en el header X-Agent-Key.", { requestId });
    }

    // ---- Autenticacion ----
    let tokenSnapshot = null;
    try {
      const snapshot = await db
        .collection(COLLECTION_TOKENS)
        .where("tokenHash", "==", sha256hex(providedKey))
        .limit(1)
        .get();
      tokenSnapshot = snapshot.empty ? null : snapshot.docs[0];
    } catch (error) {
      return fail(req, res, 503, "STORAGE_UNAVAILABLE", "No se pudo consultar el almacen de claves.", { requestId });
    }

    const tokenData = tokenSnapshot ? tokenSnapshot.data() : null;
    const authResult = evaluateToken(tokenData, startedAt);
    if (!authResult.ok) {
      await writeAuditLog(req, {
        requestId,
        outcome: authResult.code,
        totalReceived: getItems(body).length,
        createdCount: 0,
        updatedCount: 0,
        skippedDuplicateCount: 0,
        invalidCount: 0,
        failedCount: 0
      });
      return fail(req, res, authResult.status, authResult.code, authResult.message, { requestId });
    }

    // ---- Limite de uso ----
    const rate = evaluateRateLimit(tokenData, startedAt);
    if (!rate.allowed) {
      return fail(
        req,
        res,
        429,
        "RATE_LIMITED",
        `Demasiadas solicitudes con esta clave. Reintenta en ${rate.retryAfterSeconds} segundos.`,
        { requestId, retryAfterSeconds: rate.retryAfterSeconds }
      );
    }
    try {
      await tokenSnapshot.ref.update({
        rateWindowStart: new Date(rate.nextWindowStart),
        rateWindowCount: rate.nextCount,
        lastUsedAt: fieldValue.serverTimestamp(),
        useCount: fieldValue.increment(1)
      });
    } catch (error) {
      // No bloquea la importacion.
    }

    // ---- Idempotencia por lote ----
    const idempotencyKeyRaw = String(readHeader(req, "x-idempotency-key") || body.idempotencyKey || "").trim();
    const idempotencyDocId = idempotencyKeyRaw ? sha256hex(idempotencyKeyRaw).slice(0, 40) : "";
    if (idempotencyDocId && !dryRun) {
      try {
        const existing = await db.collection(COLLECTION_BATCHES).doc(idempotencyDocId).get();
        if (existing.exists) {
          const stored = existing.data() || {};
          if (stored.response) {
            return send(
              req,
              res,
              200,
              Object.assign({}, stored.response, { idempotentReplay: true, requestId }),
              { "X-Request-Id": requestId }
            );
          }
        }
      } catch (error) {
        // Si falla la lectura seguimos: peor caso, se reprocesa y el dedupe
        // por listingUrl evita duplicados.
      }
    }

    // ---- Validacion estricta ----
    const rawItems = getItems(body);
    if (!rawItems.length) {
      return fail(req, res, 400, "EMPTY_BATCH", "Envia items con al menos una opcion de arriendo.", { requestId });
    }
    if (rawItems.length > maxItems) {
      return fail(
        req,
        res,
        400,
        "BATCH_TOO_LARGE",
        `Maximo ${maxItems} opciones por lote. Recibidas ${rawItems.length}.`,
        { requestId }
      );
    }

    const validation = validateBatch(rawItems);

    const results = [];
    const counters = {
      created: 0,
      updated: 0,
      skippedDuplicate: 0,
      invalid: 0,
      failed: 0
    };

    validation.invalidRows.forEach((row) => {
      counters.invalid += 1;
      results.push({
        index: row.index,
        outcome: "invalid",
        title: row.normalized ? row.normalized.title : "",
        errors: row.errors
      });
    });

    // ---- Procesamiento ----
    const seenInBatch = new Map();

    for (const row of validation.validRows) {
      const option = row.normalized;
      const dedupeKey = option.duplicateKey;

      if (dedupeKey && seenInBatch.has(dedupeKey)) {
        counters.skippedDuplicate += 1;
        results.push({
          index: row.index,
          outcome: "skippedDuplicate",
          title: option.title,
          listingUrl: option.listingUrl,
          duplicateOfIndex: seenInBatch.get(dedupeKey),
          reason: "Otra opcion del mismo lote apunta al mismo anuncio."
        });
        continue;
      }
      if (dedupeKey) seenInBatch.set(dedupeKey, row.index);

      try {
        const existingId = await findExistingOption(option);

        if (dryRun) {
          results.push({
            index: row.index,
            outcome: existingId ? "wouldUpdate" : "wouldCreate",
            title: option.title,
            listingUrl: option.listingUrl,
            id: existingId || null
          });
          if (existingId) counters.updated += 1;
          else counters.created += 1;
          continue;
        }

        const timestamp = fieldValue.serverTimestamp();
        const payload = Object.assign({}, option, {
          source: "agent",
          importedBy: "agent",
          importedAt: timestamp,
          updatedAt: timestamp,
          sourceUrl: option.listingUrl,
          url: option.listingUrl,
          lastImportRequestId: requestId
        });
        delete payload.listingUrlRaw;

        if (existingId) {
          await db.collection(COLLECTION_OPTIONS).doc(existingId).set(payload, { merge: true });
          counters.updated += 1;
          results.push({ index: row.index, outcome: "updated", id: existingId, title: option.title, listingUrl: option.listingUrl });
        } else {
          const created = await db.collection(COLLECTION_OPTIONS).add(
            Object.assign({}, payload, {
              ratings: {},
              createdAt: timestamp,
              createdBy: "agent"
            })
          );
          counters.created += 1;
          results.push({ index: row.index, outcome: "created", id: created.id, title: option.title, listingUrl: option.listingUrl });
        }
      } catch (error) {
        counters.failed += 1;
        results.push({
          index: row.index,
          outcome: "failed",
          title: option.title,
          listingUrl: option.listingUrl,
          reason: "No se pudo guardar esta opcion. El resto del lote si se proceso."
        });
      }
    }

    results.sort((a, b) => a.index - b.index);

    const response = {
      ok: counters.failed === 0,
      requestId,
      apiVersion: API_VERSION,
      dryRun,
      mode: dryRun ? "validated_not_saved" : "saved",
      timestamp: new Date(now()).toISOString(),
      originAllowed: isAllowedOrigin(origin),
      totalReceived: rawItems.length,
      created: counters.created,
      updated: counters.updated,
      skippedDuplicate: counters.skippedDuplicate,
      invalid: counters.invalid,
      failed: counters.failed,
      warnings: buildWarnings(validation.validRows.map((row) => row.normalized)),
      errors: validation.errors,
      results,
      normalizedPreview: dryRun
        ? validation.validRows.map((row) => {
            const preview = Object.assign({}, row.normalized);
            delete preview.listingUrlRaw;
            return preview;
          })
        : [],
      durationMs: now() - startedAt
    };

    if (idempotencyDocId && !dryRun) {
      try {
        await db.collection(COLLECTION_BATCHES).doc(idempotencyDocId).set({
          createdAt: fieldValue.serverTimestamp(),
          requestId,
          response
        });
      } catch (error) {
        // No bloquea la respuesta.
      }
    }

    await writeAuditLog(req, {
      requestId,
      outcome: dryRun ? "DRY_RUN" : "IMPORTED",
      tokenId: tokenSnapshot.id,
      tokenLabel: String((tokenData && tokenData.label) || "").slice(0, 120),
      dryRun,
      totalReceived: rawItems.length,
      createdCount: counters.created,
      updatedCount: counters.updated,
      skippedDuplicateCount: counters.skippedDuplicate,
      invalidCount: counters.invalid,
      failedCount: counters.failed,
      durationMs: response.durationMs
    });

    return send(req, res, counters.failed ? 207 : 200, response, { "X-Request-Id": requestId });
  }

  return async function handler(req, res) {
    // El preflight debe responderse SIEMPRE y antes de cualquier otra logica.
    if (req.method === "OPTIONS") {
      const requestId = newId();
      const headers = Object.assign({}, corsHeaders(readHeader(req, "origin")), {
        "X-Request-Id": requestId,
        "X-Api-Version": API_VERSION
      });
      Object.entries(headers).forEach(([key, value]) => res.set(key, value));
      res.status(204).send("");
      return;
    }

    const path = readPath(req);

    try {
      if (path === "/health" || path === "/healthz") {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return fail(req, res, 405, "METHOD_NOT_ALLOWED", "Usa GET para /health.");
        }
        return await handleHealth(req, res);
      }

      if (req.method === "GET") {
        // Facilita el diagnostico manual desde el navegador.
        return await handleHealth(req, res);
      }

      if (req.method !== "POST") {
        return fail(req, res, 405, "METHOD_NOT_ALLOWED", "Usa POST para importar o GET /health para diagnosticar.");
      }

      return await handleImport(req, res);
    } catch (error) {
      return fail(req, res, 500, "INTERNAL_ERROR", "Error interno al procesar la solicitud.");
    }
  };
}

module.exports = {
  API_VERSION,
  MAX_BODY_BYTES,
  MAX_ITEMS,
  createHandler
};
