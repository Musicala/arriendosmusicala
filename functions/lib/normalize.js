"use strict";

/**
 * Normalizacion pura (sin dependencias de Firebase) para poder testearla.
 * Regla central: NUNCA inventar datos. Si un dato falta se conserva vacio o 0.
 */

const VALID_STATUSES = [
  "nueva",
  "por_contactar",
  "agendada",
  "visitada",
  "favorita",
  "descartada"
];

const VALID_CONFIDENCE = ["alta", "media", "baja"];

const STRING_FIELDS = [
  "title",
  "zone",
  "address",
  "visitDate",
  "nextActionDate",
  "nextAction",
  "contactName",
  "contactPhone",
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

const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gclid",
  "fbclid",
  "msclkid",
  "ref",
  "referrer"
];

function normalizeString(value, maxLength = 3000) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/**
 * Convierte "$ 6.500.000", "6500000", "6,5" o 6500000 en numero.
 * Devuelve 0 para vacio o no interpretable (nunca null ni NaN).
 */
function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "boolean") return 0;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  const raw = String(value).replace(/[^\d,.-]/g, "");
  if (!raw) return 0;

  const separators = raw.match(/[,.]/g) || [];
  let cleaned;
  if (separators.length === 0) {
    cleaned = raw;
  } else {
    const lastSeparator = Math.max(raw.lastIndexOf(","), raw.lastIndexOf("."));
    const decimals = raw.slice(lastSeparator + 1);
    // Un grupo final de 3 digitos es separador de miles (6.500.000);
    // cualquier otro largo es decimal (1.234,56 o 6,5).
    if (decimals.length === 3 || decimals.length === 0) {
      cleaned = raw.replace(/[,.]/g, "");
    } else {
      cleaned = raw.slice(0, lastSeparator).replace(/[,.]/g, "") + "." + decimals;
    }
  }

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeList(value, maxItems = 30) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item, 120)).filter(Boolean).slice(0, maxItems);
  }
  return normalizeString(value)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeEnum(value, allowed, fallback) {
  const candidate = normalizeString(value, 40).toLowerCase().replace(/[\s-]+/g, "_");
  return allowed.includes(candidate) ? candidate : fallback;
}

/**
 * Normaliza una URL de anuncio para usarla como identidad estable:
 * minusculas en host, sin "www.", sin hash, sin parametros de tracking,
 * sin barra final. Devuelve "" si no es una URL http(s) usable.
 */
function normalizeListingUrl(value) {
  const raw = normalizeString(value, 2000);
  if (!raw) return "";

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    return "";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
  if (!parsed.hostname.includes(".")) return "";

  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
  parsed.protocol = "https:";
  parsed.port = "";

  TRACKING_PARAMS.forEach((param) => parsed.searchParams.delete(param));
  parsed.searchParams.sort();

  let path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path || "/";

  return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "/" : "");
}

function normalizeForKey(value) {
  return normalizeString(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Clave de duplicado. La URL normalizada manda; si no hay URL usamos
 * titulo + zona + canon como respaldo.
 */
function makeDuplicateKey(option) {
  if (option.listingUrl) return `url:${option.listingUrl}`.slice(0, 500);
  const fallback = [option.title, option.zone, option.rent]
    .map(normalizeForKey)
    .filter(Boolean)
    .join("|");
  return fallback ? `meta:${fallback}`.slice(0, 500) : "";
}

function normalizeRentalOption(input) {
  const item = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const output = {};

  STRING_FIELDS.forEach((field) => {
    output[field] = normalizeString(item[field]);
  });

  output.listingUrl = normalizeListingUrl(item.listingUrl || item.url || item.sourceUrl);
  output.listingUrlRaw = normalizeString(item.listingUrl || item.url || item.sourceUrl, 2000);

  output.rooms = normalizeNumber(
    item.rooms ?? item.spaces ?? item.salones ?? item.roomsCount
  );
  output.bathrooms = normalizeNumber(
    item.bathrooms ?? item.baths ?? item.banos ?? item["baños"] ?? item.bathroomsCount
  );

  NUMBER_FIELDS.forEach((field) => {
    if (field === "rooms" || field === "bathrooms") return;
    output[field] = normalizeNumber(item[field]);
  });

  output.status = normalizeEnum(item.status, VALID_STATUSES, "nueva");
  output.agentConfidence = normalizeEnum(item.agentConfidence, VALID_CONFIDENCE, "media");
  output.tags = normalizeList(item.tags);
  output.risks = normalizeList(item.risks);
  output.favorite = item.favorite === true;
  output.duplicateKey = makeDuplicateKey(output);

  return output;
}

module.exports = {
  NUMBER_FIELDS,
  STRING_FIELDS,
  VALID_CONFIDENCE,
  VALID_STATUSES,
  makeDuplicateKey,
  normalizeEnum,
  normalizeForKey,
  normalizeList,
  normalizeListingUrl,
  normalizeNumber,
  normalizeRentalOption,
  normalizeString
};
