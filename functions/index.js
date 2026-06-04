const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();

const db = admin.firestore();
const AGENT_IMPORT_SECRET = defineSecret("AGENT_IMPORT_SECRET");

const ALLOWED_ORIGINS = [
  "https://musicala.github.io",
  "https://musicala.github.io/arriendosmusicala",
  "https://musicala.github.io/arriendosmusicala/",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5500",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173"
];

const MAX_ITEMS = 25;
const MAX_BODY_BYTES = 256 * 1024;
const VALID_STATUSES = new Set([
  "nueva",
  "por_contactar",
  "agendada",
  "visitada",
  "favorita",
  "descartada"
]);
const VALID_CONFIDENCE = new Set(["alta", "media", "baja"]);
const STRING_FIELDS = [
  "title",
  "zone",
  "address",
  "visitDate",
  "nextActionDate",
  "nextAction",
  "contactName",
  "contactPhone",
  "listingUrl",
  "pros",
  "cons",
  "notes",
  "agentSummary"
];
const NUMBER_FIELDS = [
  "rent",
  "administration",
  "servicesEstimate",
  "setupEstimate",
  "area",
  "rooms",
  "bathrooms",
  "parking"
];

exports.agentImportRentalOptions = onRequest(
  {
    region: "us-central1",
    secrets: [AGENT_IMPORT_SECRET],
    maxInstances: 10
  },
  async (req, res) => {
    applyCors(req, res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json(makeError("Metodo no permitido. Usa POST.", "METHOD_NOT_ALLOWED"));
      return;
    }

    if (getBodySize(req) > MAX_BODY_BYTES) {
      res.status(413).json(makeError("Payload demasiado grande.", "VALIDATION_ERROR"));
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const providedKey = getAgentKey(req, body);
    const dryRun = body.dryRun === true;

    if (!providedKey || providedKey !== AGENT_IMPORT_SECRET.value()) {
      await writeAuditLog(req, {
        totalReceived: countReceived(body),
        createdCount: 0,
        updatedCount: 0,
        rejectedCount: countReceived(body),
        rejectedItems: [{ index: null, reason: "Clave invalida o ausente." }]
      });
      res.status(401).json(makeError("Clave de agente invalida o ausente.", "AUTH_FAILED"));
      return;
    }

    const rawItems = normalizeIncomingItems(body);

    if (!rawItems.length) {
      await writeAuditLog(req, {
        totalReceived: 0,
        createdCount: 0,
        updatedCount: 0,
        rejectedCount: 0,
        rejectedItems: [{ index: null, reason: "No se recibieron items." }]
      });
      res.status(400).json(makeError("Envia item o items con al menos una opcion.", "VALIDATION_ERROR"));
      return;
    }

    if (rawItems.length > MAX_ITEMS) {
      await writeAuditLog(req, {
        totalReceived: rawItems.length,
        createdCount: 0,
        updatedCount: 0,
        rejectedCount: rawItems.length,
        rejectedItems: [{ index: null, reason: `Maximo ${MAX_ITEMS} items por request.` }]
      });
      res.status(400).json(makeError(`Maximo ${MAX_ITEMS} items por request.`, "VALIDATION_ERROR"));
      return;
    }

    const results = [];
    const rejectedItems = [];
    let createdCount = 0;
    let updatedCount = 0;

    for (let index = 0; index < rawItems.length; index += 1) {
      const normalized = normalizeRentalOption(rawItems[index]);

      if (!normalized.title) {
        rejectedItems.push({ index, reason: "title es requerido." });
        results.push({ index, status: "rejected", reason: "title es requerido." });
        continue;
      }

      try {
        const existingId = await findExistingOption(normalized);
        if (dryRun) {
          if (existingId) {
            updatedCount += 1;
            results.push({ index, status: "would_update", id: existingId });
          } else {
            createdCount += 1;
            results.push({ index, status: "would_create" });
          }
          continue;
        }

        const now = admin.firestore.FieldValue.serverTimestamp();
        const payload = {
          ...normalized,
          source: "agent",
          importedBy: "agent",
          importedAt: now,
          updatedAt: now,
          sourceUrl: normalized.listingUrl || "",
          duplicateKey: normalized.duplicateKey
        };

        if (existingId) {
          await db.collection("rentalOptions").doc(existingId).set(payload, { merge: true });
          updatedCount += 1;
          results.push({ index, status: "updated", id: existingId });
        } else {
          const docRef = await db.collection("rentalOptions").add({
            ...payload,
            ratings: {},
            createdAt: now,
            createdBy: "agent"
          });
          createdCount += 1;
          results.push({ index, status: "created", id: docRef.id });
        }
      } catch (error) {
        rejectedItems.push({ index, title: normalized.title, reason: "No se pudo guardar el item." });
        results.push({ index, status: "rejected", reason: "No se pudo guardar el item." });
      }
    }

    await writeAuditLog(req, {
      totalReceived: rawItems.length,
      createdCount,
      updatedCount,
      rejectedCount: rejectedItems.length,
      rejectedItems,
      dryRun
    });

    res.status(200).json({
      ok: true,
      batchId: db.collection("agentImportLogs").doc().id,
      totalReceived: rawItems.length,
      createdCount,
      updatedCount,
      rejectedCount: rejectedItems.length,
      validCount: rawItems.length - rejectedItems.length,
      warnings: buildWarnings(rawItems.map(normalizeRentalOption)),
      errors: [],
      normalizedPreview: dryRun ? rawItems.map(normalizeRentalOption).slice(0, 5) : [],
      results
    });
  }
);

function applyCors(req, res) {
  const origin = req.get("origin") || "";
  if (isAllowedOrigin(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Max-Age", "3600");
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function getBodySize(req) {
  if (req.rawBody) return req.rawBody.length;
  const length = Number(req.get("content-length"));
  return Number.isFinite(length) ? length : 0;
}

function getAgentKey(req, body) {
  const authorization = req.get("authorization") || "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return (req.get("x-agent-key") || body.agentKey || "").toString().trim();
}

function normalizeIncomingItems(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.items)) return body.items;
  if (body.item && typeof body.item === "object") return [body.item];
  return [];
}

function countReceived(body) {
  return normalizeIncomingItems(body).length;
}

function normalizeRentalOption(input) {
  const item = input && typeof input === "object" ? input : {};
  const output = {};

  STRING_FIELDS.forEach((field) => {
    output[field] = normalizeString(item[field]);
  });

  output.listingUrl = normalizeString(item.listingUrl || item.url || item.sourceUrl);

  NUMBER_FIELDS.forEach((field) => {
    output[field] = normalizeNumber(item[field]);
  });

  output.status = VALID_STATUSES.has(normalizeString(item.status)) ? normalizeString(item.status) : "nueva";
  output.agentConfidence = VALID_CONFIDENCE.has(normalizeString(item.agentConfidence))
    ? normalizeString(item.agentConfidence)
    : "media";
  output.tags = normalizeList(item.tags);
  output.risks = normalizeList(item.risks);
  output.favorite = Boolean(item.favorite);
  output.duplicateKey = makeDuplicateKey(output);

  return output;
}

function normalizeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim().slice(0, 3000);
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;

  const raw = String(value).replace(/[^\d,.-]/g, "");
  const separators = raw.match(/[,.]/g) || [];
  const cleaned = separators.length > 1
    ? raw.replace(/[,.]/g, "")
    : raw.replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeList(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeString).filter(Boolean).slice(0, 30);
  }
  return normalizeString(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, 30);
}

function makeDuplicateKey(option) {
  return [
    option.title,
    option.zone,
    option.rent
  ]
    .map((part) => normalizeForKey(part))
    .filter(Boolean)
    .join("|")
    .slice(0, 500);
}

function normalizeForKey(value) {
  return normalizeString(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function findExistingOption(option) {
  if (option.listingUrl) {
    const sourceUrlSnapshot = await db
      .collection("rentalOptions")
      .where("sourceUrl", "==", option.listingUrl)
      .limit(1)
      .get();
    if (!sourceUrlSnapshot.empty) return sourceUrlSnapshot.docs[0].id;

    const listingUrlSnapshot = await db
      .collection("rentalOptions")
      .where("listingUrl", "==", option.listingUrl)
      .limit(1)
      .get();
    if (!listingUrlSnapshot.empty) return listingUrlSnapshot.docs[0].id;
  }

  if (option.duplicateKey) {
    const duplicateSnapshot = await db
      .collection("rentalOptions")
      .where("duplicateKey", "==", option.duplicateKey)
      .limit(1)
      .get();
    if (!duplicateSnapshot.empty) return duplicateSnapshot.docs[0].id;
  }

  return null;
}

async function writeAuditLog(req, summary) {
  await db.collection("agentImportLogs").add({
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    totalReceived: summary.totalReceived,
    createdCount: summary.createdCount,
    updatedCount: summary.updatedCount,
    rejectedCount: summary.rejectedCount,
    rejectedItems: sanitizeRejectedItems(summary.rejectedItems || []),
    userAgent: normalizeString(req.get("user-agent")),
    origin: normalizeString(req.get("origin")),
    ip: normalizeString(req.ip || req.get("x-forwarded-for")).slice(0, 120),
    source: "agent",
    dryRun: Boolean(summary.dryRun)
  });
}

function sanitizeRejectedItems(items) {
  return items.slice(0, MAX_ITEMS).map((item) => ({
    index: Number.isInteger(item.index) ? item.index : null,
    title: normalizeString(item.title).slice(0, 160),
    reason: normalizeString(item.reason).slice(0, 220)
  }));
}

function buildWarnings(items) {
  const warnings = [];
  const missingUrl = items.filter((item) => !item.listingUrl).length;
  const missingRent = items.filter((item) => !item.rent).length;
  if (missingUrl) warnings.push(`${missingUrl} opciones no tienen URL.`);
  if (missingRent) warnings.push(`${missingRent} opciones no tienen precio.`);
  return warnings;
}

function makeError(error, code, details = "") {
  return {
    ok: false,
    error,
    details,
    code
  };
}
