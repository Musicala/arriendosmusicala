// agent-import.js
// Importador de opciones de arriendo para personas y agentes de IA.
//
// Seguridad de la clave temporal:
// - Vive SOLO en memoria (variable `agentKey`) mientras dura la sesion.
// - Nunca se escribe en localStorage/sessionStorage, ni en la URL, ni en el
//   JSON normalizado, ni en los reportes de diagnostico, ni en console.
// - Se borra al recargar, al salir, al cancelar y tras 15 minutos de inactividad.

const DEFAULT_ENDPOINT =
  "https://us-central1-arriendos-musicala.cloudfunctions.net/agentImportRentalOptions";
const ENDPOINT_STORAGE_KEY = "arriendos.agentImport.endpoint"; // solo la URL, nunca la clave
const BATCH_SIZE = 25;
const REQUEST_TIMEOUT_MS = 45000;
const KEY_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

const VALID_STATUSES = ["nueva", "por_contactar", "agendada", "visitada", "favorita", "descartada"];
const VALID_CONFIDENCE = ["alta", "media", "baja"];
const NUMBER_FIELDS = [
  "rent", "administration", "servicesEstimate", "setupEstimate",
  "area", "rooms", "bathrooms", "parking"
];
const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "msclkid", "ref", "referrer"];
const NON_DIRECT_PATH_RE = /^\/(buscar|busqueda|search|resultados|listado|arriendos?|venta|inmuebles?)\/?$/i;
const SEARCH_QUERY_KEYS = ["q", "query", "search", "keywords"];

const SAMPLE_JSON = {
  items: [
    {
      title: "Casa comercial amplia en Pasadena",
      zone: "Pasadena",
      address: "Calle 104 con Carrera 50",
      rent: 6200000,
      administration: 0,
      area: 320,
      rooms: 7,
      bathrooms: 4,
      parking: 2,
      listingUrl: "https://www.metrocuadrado.com/inmueble/arriendo-casa-bogota-pasadena/ejemplo-1001",
      status: "nueva",
      agentConfidence: "alta",
      tags: ["casa", "uso mixto"],
      risks: ["Verificar uso de suelo"],
      pros: "Varios salones independientes y patio central.",
      cons: "Requiere insonorizacion en dos salones.",
      agentSummary: "Casa de dos pisos con 7 espacios utilizables."
    }
  ]
};

const els = {
  form: document.querySelector("#agentImportForm"),
  endpoint: document.querySelector("#functionUrlInput"),
  key: document.querySelector("#agentKeyInput"),
  json: document.querySelector("#jsonInput"),
  skipDuplicates: document.querySelector("#skipDuplicatesInput"),
  stopOnError: document.querySelector("#stopOnErrorInput"),
  preview: document.querySelector("#previewBox"),
  rows: document.querySelector("#rowsBox"),
  progress: document.querySelector("#progressBox"),
  result: document.querySelector("#resultBox"),
  connectionBox: document.querySelector("#connectionBox"),
  connectionBadge: document.querySelector("#connectionBadge"),
  keyBadge: document.querySelector("#keyBadge"),
  jsonBadge: document.querySelector("#jsonBadge"),
  diagnosticBox: document.querySelector("#diagnosticBox"),
  validateBtn: document.querySelector("#validateBtn"),
  importBtn: document.querySelector("#importBtn"),
  testConnectionBtn: document.querySelector("#testConnectionBtn"),
  resetEndpointBtn: document.querySelector("#resetEndpointBtn"),
  clearKeyBtn: document.querySelector("#clearKeyBtn"),
  loadSampleBtn: document.querySelector("#loadSampleBtn"),
  copyNormalizedBtn: document.querySelector("#copyNormalizedBtn"),
  downloadNormalizedBtn: document.querySelector("#downloadNormalizedBtn"),
  copyDiagnosticBtn: document.querySelector("#copyDiagnosticBtn"),
  toggleDiagnosticBtn: document.querySelector("#toggleDiagnosticBtn")
};

// La clave NUNCA sale de esta variable.
let agentKey = "";
let keyIdleTimer = null;

let state = buildState();
let lastRun = null;
// Solo el resultado de la última prueba de conexión puede pintar la UI:
// el sondeo automático de apertura no debe pisar una prueba manual posterior.
let connectionRunId = 0;
let lastFailure = null;
const diagnosticEvents = [];

// ---------------------------------------------------------------- utilidades

function normalizeString(value, maxLength = 3000) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return "";
  return String(value).replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "boolean") return 0;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : 0;

  const raw = String(value).replace(/[^\d,.-]/g, "");
  if (!raw) return 0;
  const separators = raw.match(/[,.]/g) || [];
  let cleaned;
  if (!separators.length) {
    cleaned = raw;
  } else {
    const last = Math.max(raw.lastIndexOf(","), raw.lastIndexOf("."));
    const decimals = raw.slice(last + 1);
    cleaned = decimals.length === 3 || decimals.length === 0
      ? raw.replace(/[,.]/g, "")
      : raw.slice(0, last).replace(/[,.]/g, "") + "." + decimals;
  }
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map((item) => normalizeString(item, 120)).filter(Boolean).slice(0, 30);
  return normalizeString(value).split(",").map((part) => part.trim()).filter(Boolean).slice(0, 30);
}

function normalizeEnum(value, allowed, fallback) {
  const candidate = normalizeString(value, 40).toLowerCase().replace(/[\s-]+/g, "_");
  return allowed.includes(candidate) ? candidate : fallback;
}

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
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString().replace(/\/$/, parsed.pathname === "/" ? "/" : "");
}

function normalizeForKey(value) {
  return normalizeString(value).toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Espejo del contrato de functions/lib/normalize.js (fuente de verdad: el backend). */
function normalizeItem(input) {
  const item = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const listingUrlRaw = normalizeString(item.listingUrl || item.url || item.sourceUrl, 2000);
  const output = {
    title: normalizeString(item.title),
    zone: normalizeString(item.zone),
    address: normalizeString(item.address),
    visitDate: normalizeString(item.visitDate),
    nextActionDate: normalizeString(item.nextActionDate),
    nextAction: normalizeString(item.nextAction),
    contactName: normalizeString(item.contactName),
    contactPhone: normalizeString(item.contactPhone),
    pros: normalizeString(item.pros),
    cons: normalizeString(item.cons),
    notes: normalizeString(item.notes),
    agentSummary: normalizeString(item.agentSummary),
    listingUrl: normalizeListingUrl(listingUrlRaw),
    rooms: normalizeNumber(item.rooms ?? item.spaces ?? item.salones),
    bathrooms: normalizeNumber(item.bathrooms ?? item.baths ?? item.banos ?? item["baños"]),
    status: normalizeEnum(item.status, VALID_STATUSES, "nueva"),
    agentConfidence: normalizeEnum(item.agentConfidence, VALID_CONFIDENCE, "media"),
    tags: normalizeList(item.tags),
    risks: normalizeList(item.risks),
    favorite: item.favorite === true
  };

  NUMBER_FIELDS.forEach((field) => {
    if (field === "rooms" || field === "bathrooms") return;
    output[field] = normalizeNumber(item[field]);
  });

  output.__raw = item;
  output.__listingUrlRaw = listingUrlRaw;
  output.__duplicateKey = output.listingUrl
    ? `url:${output.listingUrl}`
    : [output.title, output.zone, output.rent].map(normalizeForKey).filter(Boolean).join("|");

  return output;
}

/** Validacion de vista previa. La autoridad final es el backend (dryRun). */
function validateItem(normalized, index) {
  const errors = [];
  const push = (field, cause, suggestion) => errors.push({ index, field, cause, suggestion });
  const raw = normalized.__raw;

  if (!normalized.title) push("title", "title es obligatorio.", "Usa el titulo real del anuncio.");
  else if (normalized.title.length < 3) push("title", "title es demasiado corto.", "Usa al menos 3 caracteres.");

  if (!normalized.zone) push("zone", "zone es obligatorio.", "Indica el barrio o zona.");

  if (!normalized.__listingUrlRaw) {
    push("listingUrl", "Falta listingUrl.", "Incluye la URL completa del anuncio.");
  } else if (!normalized.listingUrl) {
    push("listingUrl", "listingUrl no es una URL http(s) valida.", "Usa una URL absoluta con https:// y un dominio real.");
  } else {
    const parsed = new URL(normalized.listingUrl);
    const isRoot = parsed.pathname === "/" || parsed.pathname === "";
    const isSearch = SEARCH_QUERY_KEYS.some((key) => parsed.searchParams.has(key));
    if (isRoot || NON_DIRECT_PATH_RE.test(parsed.pathname) || isSearch) {
      push("listingUrl", "listingUrl apunta a una portada o buscador, no al anuncio.", "Abre el anuncio individual y copia esa URL.");
    }
  }

  NUMBER_FIELDS.forEach((field) => {
    const original = raw[field];
    if (original === undefined || original === null || original === "") return;
    if (typeof original === "boolean" || typeof original === "object") {
      push(field, `${field} debe ser un numero.`, `Envia ${field} como numero, por ejemplo 6500000.`);
      return;
    }
    if (typeof original === "number" && (!Number.isFinite(original) || original < 0)) {
      push(field, `${field} debe ser un numero mayor o igual a 0.`, `Corrige ${field} o dejalo en 0.`);
      return;
    }
    if (typeof original === "string" && normalizeString(original) && normalized[field] === 0 && !/^0([.,]0+)?$/.test(normalizeString(original))) {
      push(field, `${field} no se pudo interpretar como numero ("${normalizeString(original, 40)}").`, `Envia ${field} solo con digitos.`);
    }
  });

  if (raw.status) {
    const requested = normalizeString(raw.status, 40).toLowerCase().replace(/[\s-]+/g, "_");
    if (!VALID_STATUSES.includes(requested)) {
      push("status", `status "${requested}" no es valido.`, `Usa uno de: ${VALID_STATUSES.join(", ")}.`);
    }
  }
  if (raw.agentConfidence) {
    const requested = normalizeString(raw.agentConfidence, 40).toLowerCase();
    if (!VALID_CONFIDENCE.includes(requested)) {
      push("agentConfidence", `agentConfidence "${requested}" no es valido.`, `Usa uno de: ${VALID_CONFIDENCE.join(", ")}.`);
    }
  }

  return errors;
}

function toPayloadItem(normalized) {
  const clean = { ...normalized };
  delete clean.__raw;
  delete clean.__duplicateKey;
  delete clean.__listingUrlRaw;
  return clean;
}

// ------------------------------------------------------------- parseo del JSON

function canParseJson(text) {
  try { JSON.parse(text); return true; } catch (error) { return false; }
}

function extractJsonFromText(rawText) {
  const raw = (rawText || "").trim();
  if (!raw) return "";
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced && canParseJson(fenced[1].trim())) return fenced[1].trim();
  if (canParseJson(raw)) return raw;
  for (let start = 0; start < raw.length; start += 1) {
    if (raw[start] !== "{" && raw[start] !== "[") continue;
    const closing = raw[start] === "{" ? "}" : "]";
    for (let end = raw.lastIndexOf(closing); end > start; end = raw.lastIndexOf(closing, end - 1)) {
      const candidate = raw.slice(start, end + 1).trim();
      if (canParseJson(candidate)) return candidate;
    }
  }
  return "";
}

function parseRawInput(rawText) {
  const jsonText = extractJsonFromText(rawText);
  if (!jsonText) return { ok: false, error: "No se encontro JSON valido para importar.", payload: null };
  try {
    return { ok: true, error: "", payload: JSON.parse(jsonText) };
  } catch (error) {
    return { ok: false, error: "JSON invalido. Revisa comillas, llaves y corchetes.", payload: null };
  }
}

function getItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (payload?.item && typeof payload.item === "object") return [payload.item];
  return [];
}

function buildState() {
  const rawText = els.json?.value || "";
  const parse = parseRawInput(rawText);
  const rawItems = parse.ok ? getItems(parse.payload) : [];
  const normalized = rawItems.map(normalizeItem);

  const rows = normalized.map((item, index) => ({
    index,
    item,
    errors: validateItem(item, index),
    duplicateOfIndex: null,
    skipped: false
  }));

  // Duplicados locales por URL normalizada.
  const seen = new Map();
  rows.forEach((row) => {
    const key = row.item.__duplicateKey;
    if (!key) return;
    if (seen.has(key)) row.duplicateOfIndex = seen.get(key);
    else seen.set(key, row.index);
  });

  const skipDuplicates = els.skipDuplicates?.checked !== false;
  rows.forEach((row) => {
    row.skipped = skipDuplicates && row.duplicateOfIndex !== null;
  });

  const sendableRows = rows.filter((row) => !row.skipped && row.errors.length === 0);
  const itemsToSend = sendableRows.map((row) => toPayloadItem(row.item));
  const batches = [];
  for (let index = 0; index < itemsToSend.length; index += BATCH_SIZE) {
    batches.push(itemsToSend.slice(index, index + BATCH_SIZE));
  }

  return {
    rawText, parse, rows, normalized, itemsToSend, batches,
    duplicateCount: rows.filter((row) => row.duplicateOfIndex !== null).length,
    skippedCount: rows.filter((row) => row.skipped).length,
    invalidCount: rows.filter((row) => row.errors.length > 0 && !row.skipped).length
  };
}

// ------------------------------------------------------------------ interfaz

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function money(value) {
  if (!value) return "—";
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
}

function setBadge(element, text, variant) {
  element.textContent = text;
  element.className = `badge badge--${variant}`;
}

function renderPreview() {
  const summary = state;

  if (!summary.rawText.trim()) {
    els.preview.innerHTML = '<p class="muted">Sin JSON para importar.</p>';
    els.rows.innerHTML = "";
    setBadge(els.jsonBadge, "Sin JSON", "idle");
    setToolButtons(false);
    return;
  }

  if (!summary.parse.ok) {
    els.preview.innerHTML = `<div class="agent-card agent-card--warn"><strong>${escapeHtml(summary.parse.error)}</strong></div>`;
    els.rows.innerHTML = "";
    setBadge(els.jsonBadge, "JSON invalido", "error");
    setToolButtons(false);
    return;
  }

  const ready = summary.itemsToSend.length;
  setBadge(
    els.jsonBadge,
    summary.invalidCount ? `${ready} listas · ${summary.invalidCount} con errores` : `${ready} listas para enviar`,
    summary.invalidCount ? "warn" : ready ? "ok" : "idle"
  );

  els.preview.innerHTML = `
    <div class="agent-preview-grid">
      <article class="agent-card"><span>Detectadas</span><strong>${summary.rows.length}</strong></article>
      <article class="agent-card"><span>Listas para enviar</span><strong>${ready}</strong></article>
      <article class="agent-card ${summary.invalidCount ? "agent-card--warn" : ""}"><span>Con errores</span><strong>${summary.invalidCount}</strong></article>
      <article class="agent-card ${summary.duplicateCount ? "agent-card--warn" : ""}">
        <span>Duplicados locales</span><strong>${summary.duplicateCount}</strong>
        <small>${summary.skippedCount ? `${summary.skippedCount} se omitiran` : "Se enviaran igual"}</small>
      </article>
      <article class="agent-card"><span>Lotes</span><strong>${summary.batches.length}</strong><small>máx. ${BATCH_SIZE} por lote</small></article>
    </div>
  `;

  renderRows();
  setToolButtons(Boolean(ready));
}

function renderRows() {
  if (!state.rows.length) {
    els.rows.innerHTML = "";
    return;
  }

  const rowsHtml = state.rows.map((row) => {
    const item = row.item;
    let status = { label: "Lista", variant: "ok" };
    if (row.skipped) status = { label: "Duplicada — se omite", variant: "warn" };
    else if (row.duplicateOfIndex !== null) status = { label: `Duplicada de la #${row.duplicateOfIndex + 1}`, variant: "warn" };
    if (row.errors.length) status = { label: `${row.errors.length} error(es)`, variant: "error" };

    const errorsHtml = row.errors.length
      ? `<details class="row-errors"><summary>Ver errores de esta opción</summary><ul>${row.errors
          .map((error) => `<li><code>${escapeHtml(error.field)}</code> — ${escapeHtml(error.cause)}<br /><em>${escapeHtml(error.suggestion)}</em></li>`)
          .join("")}</ul></details>`
      : "";

    const serverHtml = row.serverOutcome
      ? `<p class="row-server row-server--${escapeHtml(row.serverOutcome)}">Servidor: ${escapeHtml(row.serverLabel || row.serverOutcome)}</p>`
      : "";

    return `
      <tr class="row row--${status.variant}">
        <td class="row__index">${row.index + 1}</td>
        <td>
          <strong>${escapeHtml(item.title || "(sin título)")}</strong>
          <small>${escapeHtml(item.zone || "sin zona")}${item.area ? ` · ${item.area} m²` : ""}${item.rooms ? ` · ${item.rooms} espacios` : ""}</small>
          ${item.listingUrl ? `<a class="row__url" href="${escapeHtml(item.listingUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.listingUrl)}</a>` : '<small class="row__url row__url--missing">Sin URL válida</small>'}
          ${errorsHtml}
          ${serverHtml}
        </td>
        <td class="row__rent">${money(item.rent)}</td>
        <td><span class="badge badge--${status.variant}">${escapeHtml(status.label)}</span></td>
      </tr>`;
  }).join("");

  els.rows.innerHTML = `
    <div class="table-wrap">
      <table class="rows-table">
        <thead><tr><th>#</th><th>Inmueble</th><th>Canon</th><th>Estado</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>`;
}

function setToolButtons(enabled) {
  els.copyNormalizedBtn.disabled = !enabled;
  els.downloadNormalizedBtn.disabled = !enabled;
}

function updatePreview() {
  state = buildState();
  renderPreview();
}

// ---------------------------------------------------- manejo seguro de la clave

function setAgentKey(value) {
  agentKey = value || "";
  setBadge(els.keyBadge, agentKey ? "Clave en memoria" : "Sin clave", agentKey ? "ok" : "idle");
  restartKeyIdleTimer();
}

function clearAgentKey(reason) {
  agentKey = "";
  if (els.key) els.key.value = "";
  setBadge(els.keyBadge, "Sin clave", "idle");
  if (keyIdleTimer) window.clearTimeout(keyIdleTimer);
  keyIdleTimer = null;
  if (reason) els.progress.textContent = reason;
}

function restartKeyIdleTimer() {
  if (keyIdleTimer) window.clearTimeout(keyIdleTimer);
  if (!agentKey) return;
  keyIdleTimer = window.setTimeout(() => {
    clearAgentKey("La clave se borró por inactividad. Pégala de nuevo para continuar.");
  }, KEY_IDLE_TIMEOUT_MS);
}

// -------------------------------------------------------------- red y errores

function classifyFetchError(error, endpoint, reachable) {
  const name = error?.name || "";
  const message = error?.message || "";

  if (name === "AbortError") {
    return {
      code: "TIMEOUT",
      title: "Tiempo de espera agotado",
      detail: `El endpoint no respondió en ${REQUEST_TIMEOUT_MS / 1000} segundos.`,
      fix: "Reintenta. Si se repite, revisa los logs de la Cloud Function (arranque en frío o consulta lenta)."
    };
  }

  if (reachable === true) {
    return {
      code: "CORS_OR_IAM",
      title: "El servidor respondió, pero el navegador bloqueó la respuesta (CORS)",
      detail: `El host de ${endpoint} sí es alcanzable, así que no es DNS ni red. La respuesta llegó sin cabecera Access-Control-Allow-Origin válida para ${window.location.origin}.`,
      fix: "Causa más frecuente: la Cloud Function no permite invocaciones sin autenticar y Google responde 403 al preflight OPTIONS sin cabeceras CORS. Ejecuta: gcloud run services add-iam-policy-binding agentimportrentaloptions --region=us-central1 --member=allUsers --role=roles/run.invoker"
    };
  }

  if (reachable === false) {
    return {
      code: "DNS_OR_NETWORK",
      title: "No se pudo alcanzar el host",
      detail: `El navegador no logró abrir ninguna conexión con ${endpoint}. Es DNS, red, o la función no está desplegada en esa URL.`,
      fix: "Verifica que la URL sea exacta y que la función esté desplegada (firebase deploy --only functions)."
    };
  }

  return {
    code: "NETWORK",
    title: "Fallo de red",
    detail: message || "No se pudo conectar con el endpoint.",
    fix: "Revisa tu conexión y la URL del endpoint."
  };
}

function describeHttpStatus(status, body) {
  const serverMessage = body?.error ? ` Mensaje del servidor: ${body.error}` : "";
  const map = {
    400: ["Petición inválida (400)", "El JSON no cumple el contrato de importación."],
    401: ["Clave no válida o ausente (401)", "La clave temporal no existe o no se envió."],
    403: ["Acceso denegado (403)", "La clave está vencida, revocada, sin permisos, o la Cloud Function exige autenticación IAM."],
    404: ["Endpoint no encontrado (404)", "La URL no corresponde a ninguna función desplegada."],
    405: ["Método no permitido (405)", "El endpoint no acepta este método HTTP."],
    413: ["Payload demasiado grande (413)", "Divide el JSON en lotes más pequeños."],
    415: ["Content-Type no soportado (415)", "La petición debe ir como application/json."],
    429: ["Demasiadas solicitudes (429)", "Se superó el límite de uso de la clave. Espera y reintenta."],
    500: ["Error interno del servidor (500)", "Falló la función. Revisa los logs con el requestId."],
    503: ["Servicio no disponible (503)", "El backend o Firestore no está respondiendo."]
  };
  const entry = map[status] || [`Respuesta HTTP ${status}`, "Respuesta inesperada del servidor."];
  return { code: `HTTP_${status}`, title: entry[0], detail: entry[1] + serverMessage, fix: body?.code ? `Código del backend: ${body.code}` : "Revisa el reporte de diagnóstico." };
}

/** ¿El host existe y acepta conexiones? Usa no-cors: no lee la respuesta, solo prueba la red. */
async function probeReachability(endpoint) {
  try {
    await fetch(endpoint, { method: "GET", mode: "no-cors", cache: "no-store" });
    return true;
  } catch (error) {
    return false;
  }
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();

  try {
    const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch (error) { body = { rawResponse: text.slice(0, 2000) }; }

    return {
      ok: response.ok,
      status: response.status,
      body,
      rawText: text.slice(0, 4000),
      requestId: response.headers.get("X-Request-Id") || body?.requestId || "",
      durationMs: Date.now() - startedAt
    };
  } finally {
    window.clearTimeout(timer);
  }
}

function logDiagnostic(entry) {
  diagnosticEvents.push({ at: new Date().toISOString(), ...entry });
  if (diagnosticEvents.length > 40) diagnosticEvents.shift();
  renderDiagnostic();
}

function buildDiagnosticReport() {
  return {
    reporte: "Diagnóstico de importación · Arriendos Musicala",
    generadoEn: new Date().toISOString(),
    paginaOrigen: window.location.origin,
    paginaUrl: window.location.href,
    endpoint: els.endpoint.value.trim(),
    navegador: navigator.userAgent,
    idioma: navigator.language,
    claveEnMemoria: agentKey ? "sí (no se incluye en este reporte)" : "no",
    jsonDetectado: {
      opciones: state.rows.length,
      listas: state.itemsToSend.length,
      conErrores: state.invalidCount,
      duplicados: state.duplicateCount
    },
    ultimaEjecucion: lastRun,
    ultimoFallo: lastFailure,
    eventos: diagnosticEvents
  };
}

function renderDiagnostic() {
  els.diagnosticBox.textContent = JSON.stringify(buildDiagnosticReport(), null, 2);
}

// -------------------------------------------------------- prueba de conexión

async function testConnection() {
  const runId = (connectionRunId += 1);
  const isStale = () => runId !== connectionRunId;
  const endpoint = els.endpoint.value.trim();
  if (!endpoint) {
    setBadge(els.connectionBadge, "Falta endpoint", "error");
    els.connectionBox.innerHTML = '<strong>Escribe el endpoint antes de probar.</strong>';
    return false;
  }

  setBadge(els.connectionBadge, "Probando…", "idle");
  els.connectionBox.textContent = "Consultando /health…";

  const healthUrl = `${endpoint.replace(/\/+$/, "")}/health`;

  try {
    const result = await requestJson(healthUrl, { method: "GET", headers: { Accept: "application/json" } });
    logDiagnostic({ paso: "health", url: healthUrl, metodo: "GET", status: result.status, requestId: result.requestId, respuesta: result.body });

    if (isStale()) return false;

    const originAllowed = result.body?.originAllowed === true;
    const healthy = result.ok && result.body?.ok === true;

    setBadge(els.connectionBadge, healthy && originAllowed ? "Conectado" : healthy ? "Conectado (origen no permitido)" : "Con problemas", healthy && originAllowed ? "ok" : "warn");

    els.connectionBox.innerHTML = `
      <dl class="diag-list">
        <dt>URL consultada</dt><dd>${escapeHtml(healthUrl)}</dd>
        <dt>Método</dt><dd>GET</dd>
        <dt>Estado HTTP</dt><dd>${result.status}</dd>
        <dt>Origen de esta página</dt><dd>${escapeHtml(window.location.origin)}</dd>
        <dt>Origen permitido por el backend</dt><dd>${originAllowed ? "Sí" : "No — el backend no reconoce este origen"}</dd>
        <dt>Versión del backend</dt><dd>${escapeHtml(result.body?.apiVersion || "desconocida")}</dd>
        <dt>Firestore</dt><dd>${escapeHtml(result.body?.firestore || "desconocido")}</dd>
        <dt>Fecha del servidor</dt><dd>${escapeHtml(result.body?.timestamp || "—")}</dd>
        <dt>Request ID</dt><dd>${escapeHtml(result.requestId || "—")}</dd>
        <dt>Mensaje</dt><dd>${healthy ? "El endpoint responde y acepta peticiones del navegador." : escapeHtml(result.body?.error || "El endpoint respondió con un problema.")}</dd>
      </dl>`;

    return healthy && originAllowed;
  } catch (error) {
    const reachable = await probeReachability(endpoint);
    if (isStale()) return false;
    const diagnosis = classifyFetchError(error, endpoint, reachable);
    logDiagnostic({ paso: "health", url: healthUrl, metodo: "GET", status: 0, error: diagnosis.code, detalle: diagnosis.detail });

    setBadge(els.connectionBadge, "Sin conexión", "error");
    els.connectionBox.innerHTML = `
      <div class="diag-error">
        <strong>${escapeHtml(diagnosis.title)}</strong>
        <p>${escapeHtml(diagnosis.detail)}</p>
        <p class="diag-fix"><strong>Cómo arreglarlo:</strong> ${escapeHtml(diagnosis.fix)}</p>
        <dl class="diag-list">
          <dt>URL consultada</dt><dd>${escapeHtml(healthUrl)}</dd>
          <dt>Método</dt><dd>GET</dd>
          <dt>Estado HTTP</dt><dd>Sin respuesta (la petición no llegó a completarse)</dd>
          <dt>Host alcanzable</dt><dd>${reachable ? "Sí" : "No"}</dd>
          <dt>Origen de esta página</dt><dd>${escapeHtml(window.location.origin)}</dd>
        </dl>
      </div>`;
    return false;
  }
}

// ------------------------------------------------------------- envío de lotes

function newIdempotencyKey() {
  const random = crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `arriendos-${random}`;
}

async function sendBatch(batch, { dryRun, idempotencyKey, batchIndex, totalBatches }) {
  const endpoint = els.endpoint.value.trim();
  els.progress.textContent = `${dryRun ? "Validando" : "Guardando"} lote ${batchIndex + 1} de ${totalBatches}…`;

  const headers = { "Content-Type": "application/json", "X-Agent-Key": agentKey };
  if (!dryRun) headers["X-Idempotency-Key"] = `${idempotencyKey}-${batchIndex}`;

  let result;
  try {
    result = await requestJson(endpoint, { method: "POST", headers, body: JSON.stringify({ items: batch, dryRun }) });
  } catch (error) {
    const reachable = await probeReachability(endpoint);
    const diagnosis = classifyFetchError(error, endpoint, reachable);
    logDiagnostic({ paso: dryRun ? "validar" : "guardar", url: endpoint, metodo: "POST", status: 0, error: diagnosis.code, lote: batchIndex + 1 });
    throw { kind: "network", diagnosis, endpoint, batchIndex, batchSize: batch.length, status: 0, requestId: "" };
  }

  logDiagnostic({
    paso: dryRun ? "validar" : "guardar",
    url: endpoint, metodo: "POST", status: result.status,
    requestId: result.requestId, lote: batchIndex + 1,
    resumen: { created: result.body?.created, updated: result.body?.updated, skippedDuplicate: result.body?.skippedDuplicate, invalid: result.body?.invalid, failed: result.body?.failed }
  });

  // 207 = guardado parcial: es un resultado, no un error de transporte.
  if (!result.ok && result.status !== 207) {
    const diagnosis = describeHttpStatus(result.status, result.body);
    throw {
      kind: "http", diagnosis, endpoint, batchIndex, batchSize: batch.length,
      status: result.status, requestId: result.requestId,
      responseText: result.rawText, body: result.body
    };
  }

  return result;
}

async function run({ dryRun }) {
  setAgentKey(els.key.value);
  updatePreview();

  if (!els.endpoint.value.trim()) return renderBlocker("Falta el endpoint. Escríbelo en el paso 1.");
  if (!agentKey) return renderBlocker("Falta la clave temporal del agente. Pégala en el paso 2.");
  if (!state.parse.ok) return renderBlocker(state.parse.error);
  if (!state.itemsToSend.length) {
    return renderBlocker(
      state.invalidCount
        ? `Ninguna opción está lista para enviar: ${state.invalidCount} tienen errores. Revisa la tabla del paso 4.`
        : "No hay opciones para importar."
    );
  }

  setWorking(true);
  const idempotencyKey = newIdempotencyKey();
  const totals = {
    totalReceived: state.rows.length,
    totalSent: 0, batchesSent: 0, batchesTotal: state.batches.length,
    created: 0, updated: 0, skippedDuplicate: state.skippedCount,
    invalid: state.invalidCount, failed: 0,
    warnings: [], errors: [], requestIds: [], idempotentReplays: 0
  };

  const serverRows = [];
  let failure = null;

  for (let index = 0; index < state.batches.length; index += 1) {
    const batch = state.batches[index];
    try {
      const result = await sendBatch(batch, { dryRun, idempotencyKey, batchIndex: index, totalBatches: state.batches.length });
      const body = result.body || {};
      totals.totalSent += batch.length;
      totals.batchesSent += 1;
      totals.created += body.created || 0;
      totals.updated += body.updated || 0;
      totals.skippedDuplicate += body.skippedDuplicate || 0;
      totals.invalid += body.invalid || 0;
      totals.failed += body.failed || 0;
      totals.warnings.push(...(body.warnings || []));
      totals.errors.push(...(body.errors || []));
      if (result.requestId) totals.requestIds.push(result.requestId);
      if (body.idempotentReplay) totals.idempotentReplays += 1;
      serverRows.push(...(body.results || []).map((row) => ({ ...row, batchIndex: index })));
    } catch (error) {
      failure = { ...error, batch };
      if (els.stopOnError.checked) break;
      totals.batchesSent += 1;
      totals.failed += batch.length;
    }
  }

  applyServerOutcomes(serverRows, dryRun);

  lastRun = {
    modo: dryRun ? "validado_no_guardado" : "guardado",
    en: new Date().toISOString(),
    endpoint: els.endpoint.value.trim(),
    totales: { ...totals, warnings: totals.warnings.length, errors: totals.errors.length }
  };

  if (failure) {
    lastFailure = {
      en: new Date().toISOString(),
      tipo: failure.kind,
      codigo: failure.diagnosis.code,
      status: failure.status,
      requestId: failure.requestId || null,
      lote: failure.batchIndex + 1,
      respuesta: (failure.responseText || "").slice(0, 1500)
    };
    renderFailure(failure, totals, dryRun);
  } else {
    lastFailure = null;
    renderSuccess(totals, dryRun);
  }

  renderDiagnostic();
  setWorking(false);
  restartKeyIdleTimer();
  els.progress.textContent = failure
    ? "Terminó con errores. El JSON y la vista previa siguen intactos."
    : dryRun ? "Validación terminada. No se guardó nada." : "Guardado terminado.";
}

/** Marca cada fila de la tabla con el resultado real del servidor. */
function applyServerOutcomes(serverRows, dryRun) {
  const labels = {
    created: "creada", updated: "actualizada", wouldCreate: "se crearía",
    wouldUpdate: "se actualizaría", skippedDuplicate: "duplicada, omitida",
    invalid: "rechazada por el servidor", failed: "no se pudo guardar"
  };

  // Los indices del servidor son relativos a las filas enviadas.
  const sendableRows = state.rows.filter((row) => !row.skipped && row.errors.length === 0);
  serverRows.forEach((serverRow) => {
    const globalIndex = serverRow.batchIndex * BATCH_SIZE + serverRow.index;
    const target = sendableRows[globalIndex];
    if (!target) return;
    target.serverOutcome = serverRow.outcome;
    target.serverLabel = labels[serverRow.outcome] || serverRow.outcome;
    if (serverRow.errors?.length) {
      target.errors = serverRow.errors;
      target.serverLabel = `rechazada — ${serverRow.errors[0].cause}`;
    }
    if (serverRow.id) target.serverLabel += ` (id ${serverRow.id})`;
  });
  renderRows();
}

// ------------------------------------------------------------- resultado final

function renderBlocker(message) {
  els.result.innerHTML = `<div class="agent-card agent-card--warn"><strong>${escapeHtml(message)}</strong></div>`;
  els.result.classList.remove("hidden");
}

function renderSuccess(totals, dryRun) {
  els.result.innerHTML = `
    <div class="result-head ${dryRun ? "result-head--dry" : "result-head--saved"}">
      <span class="badge badge--${dryRun ? "warn" : "ok"}">${dryRun ? "Validado · NO guardado" : "Guardado en el tablero"}</span>
      <h2>${dryRun ? "Validación completada sin guardar" : "Importación completada"}</h2>
      <p>${dryRun
        ? "Nada se escribió en la base de datos. Si la tabla se ve bien, presiona “Guardar en el tablero”."
        : "Los registros ya están en Firestore. Vuelve al tablero para verlos."}</p>
    </div>
    <div class="agent-preview-grid">
      <article class="agent-card"><span>Recibidas</span><strong>${totals.totalReceived}</strong></article>
      <article class="agent-card"><span>${dryRun ? "Se crearían" : "Creadas"}</span><strong>${totals.created}</strong></article>
      <article class="agent-card"><span>${dryRun ? "Se actualizarían" : "Actualizadas"}</span><strong>${totals.updated}</strong></article>
      <article class="agent-card"><span>Duplicadas omitidas</span><strong>${totals.skippedDuplicate}</strong></article>
      <article class="agent-card ${totals.invalid ? "agent-card--warn" : ""}"><span>Inválidas</span><strong>${totals.invalid}</strong></article>
      <article class="agent-card ${totals.failed ? "agent-card--warn" : ""}"><span>Fallidas</span><strong>${totals.failed}</strong></article>
    </div>
    ${totals.idempotentReplays ? `<p class="hint">${totals.idempotentReplays} lote(s) ya se habían guardado con esta misma clave de idempotencia: se repitió el resultado original en vez de duplicar.</p>` : ""}
    ${totals.warnings.length ? `<details class="row-errors"><summary>${totals.warnings.length} advertencia(s)</summary><ul>${[...new Set(totals.warnings)].map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul></details>` : ""}
    ${totals.errors.length ? `<details class="row-errors"><summary>${totals.errors.length} error(es) por fila reportados por el servidor</summary><ul>${totals.errors.map((error) => `<li>Opción #${error.index + 1} · <code>${escapeHtml(error.field)}</code> — ${escapeHtml(error.cause)}<br /><em>${escapeHtml(error.suggestion)}</em></li>`).join("")}</ul></details>` : ""}
    <p class="hint">Request IDs: ${totals.requestIds.length ? escapeHtml(totals.requestIds.join(", ")) : "—"}</p>
    ${dryRun ? "" : '<div class="agent-import__tools"><a class="btn btn--primary btn--tiny" href="./index.html">Ver los registros en el tablero</a></div>'}
  `;
  els.result.classList.remove("hidden");
}

function renderFailure(failure, totals, dryRun) {
  const diagnosis = failure.diagnosis;
  els.result.innerHTML = `
    <div class="result-head result-head--error">
      <span class="badge badge--error">${escapeHtml(diagnosis.code)}</span>
      <h2>${escapeHtml(diagnosis.title)}</h2>
      <p>${escapeHtml(diagnosis.detail)}</p>
    </div>
    <p class="diag-fix"><strong>Cómo arreglarlo:</strong> ${escapeHtml(diagnosis.fix)}</p>
    <div class="agent-preview-grid">
      <article class="agent-card"><span>${dryRun ? "Se crearían" : "Creadas"}</span><strong>${totals.created}</strong></article>
      <article class="agent-card"><span>${dryRun ? "Se actualizarían" : "Actualizadas"}</span><strong>${totals.updated}</strong></article>
      <article class="agent-card agent-card--warn"><span>Lotes fallidos</span><strong>${totals.batchesTotal - totals.batchesSent + 1}</strong></article>
    </div>
    <details class="row-errors" open>
      <summary>Detalle técnico</summary>
      <dl class="diag-list">
        <dt>Endpoint</dt><dd>${escapeHtml(failure.endpoint)}</dd>
        <dt>Método</dt><dd>POST</dd>
        <dt>Estado HTTP</dt><dd>${failure.status || "sin respuesta"}</dd>
        <dt>Lote</dt><dd>${failure.batchIndex + 1} de ${totals.batchesTotal} (${failure.batchSize} opciones)</dd>
        <dt>Request ID</dt><dd>${escapeHtml(failure.requestId || "—")}</dd>
        <dt>Origen</dt><dd>${escapeHtml(window.location.origin)}</dd>
        <dt>Respuesta del servidor</dt><dd><pre>${escapeHtml(failure.responseText || "Sin respuesta legible")}</pre></dd>
      </dl>
    </details>
    <div class="agent-import__tools">
      <button id="retryBtn" class="btn btn--primary btn--tiny" type="button">Reintentar de forma segura</button>
      <button id="copyDiagnosticBtn2" class="btn btn--ghost btn--tiny" type="button">Copiar reporte de diagnóstico</button>
    </div>
    <p class="hint">El JSON y la vista previa siguen intactos. El reintento usa la misma clave de idempotencia, así que no puede duplicar lo que ya se guardó.</p>
  `;
  els.result.classList.remove("hidden");
  document.querySelector("#retryBtn").addEventListener("click", () => run({ dryRun }));
  document.querySelector("#copyDiagnosticBtn2").addEventListener("click", copyDiagnostic);
}

function setWorking(isWorking) {
  els.importBtn.disabled = isWorking;
  els.validateBtn.disabled = isWorking;
  els.testConnectionBtn.disabled = isWorking;
}

// ------------------------------------------------------------------- acciones

async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text || "");
    if (button) {
      const original = button.textContent;
      button.textContent = "¡Copiado!";
      window.setTimeout(() => { button.textContent = original; }, 1500);
    }
  } catch (error) {
    els.progress.textContent = "El navegador bloqueó el portapapeles. Copia el texto manualmente.";
  }
}

function copyDiagnostic(event) {
  renderDiagnostic();
  copyToClipboard(JSON.stringify(buildDiagnosticReport(), null, 2), event?.currentTarget);
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

// ----------------------------------------------------------------- arranque

function loadEndpoint() {
  let stored = "";
  try { stored = window.localStorage.getItem(ENDPOINT_STORAGE_KEY) || ""; } catch (error) { stored = ""; }
  els.endpoint.value = stored || DEFAULT_ENDPOINT;
}

function saveEndpoint() {
  try { window.localStorage.setItem(ENDPOINT_STORAGE_KEY, els.endpoint.value.trim()); } catch (error) { /* modo privado */ }
}

loadEndpoint();
updatePreview();
renderDiagnostic();
setBadge(els.keyBadge, "Sin clave", "idle");

els.json.addEventListener("input", updatePreview);
els.skipDuplicates.addEventListener("change", updatePreview);
els.key.addEventListener("input", () => setAgentKey(els.key.value));
els.endpoint.addEventListener("change", () => {
  connectionRunId += 1;
  saveEndpoint();
  setBadge(els.connectionBadge, "Sin probar", "idle");
  els.connectionBox.textContent = "El endpoint cambió. Vuelve a probar la conexión.";
});

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  run({ dryRun: false });
});
els.validateBtn.addEventListener("click", () => run({ dryRun: true }));
els.testConnectionBtn.addEventListener("click", testConnection);
els.resetEndpointBtn.addEventListener("click", () => {
  els.endpoint.value = DEFAULT_ENDPOINT;
  saveEndpoint();
  setBadge(els.connectionBadge, "Sin probar", "idle");
  els.connectionBox.textContent = "Endpoint restaurado. Prueba la conexión.";
});
els.clearKeyBtn.addEventListener("click", () => clearAgentKey("Clave borrada de la memoria."));
els.loadSampleBtn.addEventListener("click", () => {
  els.json.value = JSON.stringify(SAMPLE_JSON, null, 2);
  updatePreview();
});
els.copyNormalizedBtn.addEventListener("click", (event) =>
  copyToClipboard(JSON.stringify({ items: state.itemsToSend }, null, 2), event.currentTarget));
els.downloadNormalizedBtn.addEventListener("click", () =>
  downloadJson("arriendos-normalizados.json", { items: state.itemsToSend }));
els.copyDiagnosticBtn.addEventListener("click", copyDiagnostic);
els.toggleDiagnosticBtn.addEventListener("click", (event) => {
  renderDiagnostic();
  const hidden = els.diagnosticBox.classList.toggle("hidden");
  event.currentTarget.textContent = hidden ? "Ver reporte" : "Ocultar reporte";
});

// La clave no sobrevive a la salida de la página.
window.addEventListener("pagehide", () => clearAgentKey());
window.addEventListener("beforeunload", () => clearAgentKey());

// Prueba la conexión al abrir, para que el problema se vea antes de pegar nada.
testConnection();
