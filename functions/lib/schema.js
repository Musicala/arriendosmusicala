"use strict";

/**
 * Validacion estricta server-side. La misma funcion se reutiliza en el cliente
 * (via ESM wrapper) para que la vista previa y el backend digan exactamente lo
 * mismo. Devuelve errores por fila con indice, campo, causa y sugerencia.
 */

const {
  NUMBER_FIELDS,
  VALID_CONFIDENCE,
  VALID_STATUSES,
  normalizeRentalOption,
  normalizeString
} = require("./normalize");

const MAX_RENT = 500000000;
const MAX_AREA = 100000;

// Rutas que casi siempre son buscadores o portadas, no un anuncio concreto.
const NON_DIRECT_PATH_RE = /^\/(buscar|busqueda|search|resultados|listado|arriendos?|venta|inmuebles?)\/?$/i;
const SEARCH_QUERY_KEYS = ["q", "query", "search", "keywords"];

function issue(index, field, cause, suggestion) {
  return { index, field, cause, suggestion };
}

function validateListingUrl(index, normalized) {
  const raw = normalized.listingUrlRaw;

  if (!raw) {
    return issue(
      index,
      "listingUrl",
      "Falta listingUrl.",
      "Incluye la URL completa del anuncio, por ejemplo https://www.metrocuadrado.com/inmueble/123456"
    );
  }

  if (!normalized.listingUrl) {
    return issue(
      index,
      "listingUrl",
      "listingUrl no es una URL http(s) valida.",
      "Usa una URL absoluta con https:// y un dominio real. No uses texto ni rutas relativas."
    );
  }

  let parsed;
  try {
    parsed = new URL(normalized.listingUrl);
  } catch (error) {
    return issue(index, "listingUrl", "listingUrl no se pudo interpretar.", "Revisa la URL del anuncio.");
  }

  const hasSearchQuery = SEARCH_QUERY_KEYS.some((key) => parsed.searchParams.has(key));
  const isRoot = parsed.pathname === "/" || parsed.pathname === "";

  if (isRoot || NON_DIRECT_PATH_RE.test(parsed.pathname) || hasSearchQuery) {
    return issue(
      index,
      "listingUrl",
      "listingUrl apunta a una portada o a un buscador, no al anuncio.",
      "Abre el anuncio individual y copia esa URL (debe identificar un inmueble concreto)."
    );
  }

  return null;
}

/**
 * Valida un item ya normalizado. Devuelve { valid, normalized, errors }.
 */
function validateRentalOption(rawItem, index) {
  const errors = [];

  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
    return {
      valid: false,
      normalized: null,
      errors: [
        issue(index, "item", "El elemento no es un objeto JSON.", "Cada opcion debe ser un objeto { \"title\": ..., \"listingUrl\": ... }")
      ]
    };
  }

  const normalized = normalizeRentalOption(rawItem);

  if (!normalized.title) {
    errors.push(
      issue(index, "title", "title es obligatorio y no puede estar vacio.", "Usa el titulo real del anuncio.")
    );
  } else if (normalized.title.length < 3) {
    errors.push(issue(index, "title", "title es demasiado corto.", "Usa al menos 3 caracteres."));
  }

  if (!normalized.zone) {
    errors.push(
      issue(index, "zone", "zone es obligatorio.", "Indica el barrio o zona, por ejemplo \"Pasadena\".")
    );
  }

  const urlError = validateListingUrl(index, normalized);
  if (urlError) errors.push(urlError);

  NUMBER_FIELDS.forEach((field) => {
    const original = rawItem[field];
    if (original === undefined || original === null || original === "") return;
    if (typeof original === "boolean" || typeof original === "object") {
      errors.push(
        issue(index, field, `${field} debe ser un numero.`, `Envia ${field} como numero, por ejemplo 6500000.`)
      );
      return;
    }
    if (typeof original === "number" && (!Number.isFinite(original) || original < 0)) {
      errors.push(
        issue(index, field, `${field} debe ser un numero mayor o igual a 0.`, `Corrige ${field} o dejalo en 0.`)
      );
      return;
    }
    if (typeof original === "string" && normalizeString(original) && normalized[field] === 0 && !/^0([.,]0+)?$/.test(normalizeString(original))) {
      errors.push(
        issue(
          index,
          field,
          `${field} no se pudo interpretar como numero ("${normalizeString(original, 40)}").`,
          `Envia ${field} solo con digitos, por ejemplo 6500000.`
        )
      );
    }
  });

  if (normalized.rent > MAX_RENT) {
    errors.push(issue(index, "rent", "rent es demasiado alto para un canon mensual.", "Revisa si incluiste el precio de venta en vez del arriendo."));
  }
  if (normalized.area > MAX_AREA) {
    errors.push(issue(index, "area", "area es demasiado grande.", "Revisa el area en metros cuadrados."));
  }

  if (rawItem.status !== undefined && rawItem.status !== null && rawItem.status !== "") {
    const requested = normalizeString(rawItem.status, 40).toLowerCase().replace(/[\s-]+/g, "_");
    if (requested && !VALID_STATUSES.includes(requested)) {
      errors.push(issue(index, "status", `status "${requested}" no es un valor permitido.`, `Usa uno de: ${VALID_STATUSES.join(", ")}.`));
    }
  }

  if (rawItem.agentConfidence !== undefined && rawItem.agentConfidence !== null && rawItem.agentConfidence !== "") {
    const requested = normalizeString(rawItem.agentConfidence, 40).toLowerCase();
    if (requested && !VALID_CONFIDENCE.includes(requested)) {
      errors.push(
        issue(index, "agentConfidence", `agentConfidence "${requested}" no es valido.`, `Usa uno de: ${VALID_CONFIDENCE.join(", ")}.`)
      );
    }
  }

  const uniqueErrors = [];
  const seen = new Set();
  errors.forEach((error) => {
    const key = `${error.field}::${error.cause}`;
    if (seen.has(key)) return;
    seen.add(key);
    uniqueErrors.push(error);
  });

  return { valid: uniqueErrors.length === 0, normalized, errors: uniqueErrors };
}

/**
 * Valida un lote completo. No lanza: siempre devuelve el detalle por fila.
 */
function validateBatch(items) {
  const rows = items.map((item, index) => {
    const result = validateRentalOption(item, index);
    return { index, ...result };
  });

  return {
    rows,
    validRows: rows.filter((row) => row.valid),
    invalidRows: rows.filter((row) => !row.valid),
    errors: rows.flatMap((row) => row.errors)
  };
}

function buildWarnings(normalizedItems) {
  const warnings = [];
  const count = (predicate) => normalizedItems.filter(predicate).length;

  const noRent = count((item) => !item.rent);
  const noArea = count((item) => !item.area);
  const noRooms = count((item) => !item.rooms);
  const noBathrooms = count((item) => !item.bathrooms);
  const noContact = count((item) => !item.contactPhone && !item.contactName);

  if (noRent) warnings.push(`${noRent} opciones no traen canon (rent).`);
  if (noArea) warnings.push(`${noArea} opciones no traen area.`);
  if (noRooms) warnings.push(`${noRooms} opciones no traen numero de salones.`);
  if (noBathrooms) warnings.push(`${noBathrooms} opciones no traen numero de banos.`);
  if (noContact) warnings.push(`${noContact} opciones no traen datos de contacto.`);

  return warnings;
}

module.exports = {
  MAX_AREA,
  MAX_RENT,
  buildWarnings,
  validateBatch,
  validateRentalOption
};
