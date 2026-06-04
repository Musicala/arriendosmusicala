const DEFAULT_FUNCTION_URL = "https://us-central1-arriendos-musicala.cloudfunctions.net/agentImportRentalOptions";
const BATCH_SIZE = 25;
const DEV_LOGS = false;

const form = document.querySelector("#agentImportForm");
const functionUrlInput = document.querySelector("#functionUrlInput");
const agentKeyInput = document.querySelector("#agentKeyInput");
const jsonInput = document.querySelector("#jsonInput");
const stopOnErrorInput = document.querySelector("#stopOnErrorInput");
const skipDuplicatesInput = document.querySelector("#skipDuplicatesInput");
const dryRunInput = document.querySelector("#dryRunInput");
const previewBox = document.querySelector("#previewBox");
const progressBox = document.querySelector("#progressBox");
const resultBox = document.querySelector("#resultBox");
const importBtn = document.querySelector("#importBtn");
const copyNormalizedBtn = document.querySelector("#copyNormalizedBtn");
const downloadNormalizedBtn = document.querySelector("#downloadNormalizedBtn");
const copyBatch1Btn = document.querySelector("#copyBatch1Btn");
const copyBatch2Btn = document.querySelector("#copyBatch2Btn");

let currentState = buildState();
let failedBatch = null;

functionUrlInput.value = DEFAULT_FUNCTION_URL;

jsonInput.addEventListener("input", updatePreview);
skipDuplicatesInput.addEventListener("change", updatePreview);
form.addEventListener("submit", (event) => {
  event.preventDefault();
  importAllBatches();
});
copyNormalizedBtn.addEventListener("click", () => copyToClipboard(JSON.stringify({ items: currentState.itemsToSend }, null, 2)));
downloadNormalizedBtn.addEventListener("click", () => downloadJson("arriendos-normalizados.json", { items: currentState.itemsToSend }));
copyBatch1Btn.addEventListener("click", () => copyBatch(0));
copyBatch2Btn.addEventListener("click", () => copyBatch(1));

updatePreview();

function parseRawInput(rawText) {
  const jsonText = extractJsonFromText(rawText);
  if (!jsonText) {
    return { ok: false, error: "No se encontro JSON valido para importar.", payload: null };
  }

  try {
    return { ok: true, error: "", payload: JSON.parse(jsonText) };
  } catch (error) {
    return { ok: false, error: "JSON invalido. Revisa comillas, llaves y corchetes.", payload: null };
  }
}

function extractJsonFromText(rawText) {
  const raw = (rawText || "").trim();
  if (!raw) return "";

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const candidate = fenced[1].trim();
    if (canParseJson(candidate)) return candidate;
  }

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

function getItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (payload?.item && typeof payload.item === "object") return [payload.item];
  return [];
}

function normalizeItem(item) {
  const source = item && typeof item === "object" ? item : {};
  const listingUrl = normalizeString(source.listingUrl || source.url || source.sourceUrl);
  const status = normalizeString(source.status) || "pendiente";

  return {
    title: normalizeString(source.title) || "Opcion sin titulo",
    zone: normalizeString(source.zone),
    address: normalizeString(source.address),
    rent: normalizeNumber(source.rent),
    administration: normalizeNumber(source.administration),
    servicesEstimate: normalizeNumber(source.servicesEstimate),
    setupEstimate: normalizeNumber(source.setupEstimate),
    area: normalizeNumber(source.area),
    rooms: normalizeNumber(source.rooms),
    bathrooms: normalizeNumber(source.bathrooms),
    parking: normalizeNumber(source.parking),
    visitDate: normalizeString(source.visitDate),
    nextActionDate: normalizeString(source.nextActionDate),
    nextAction: normalizeString(source.nextAction) || "Contactar",
    contactName: normalizeString(source.contactName),
    contactPhone: normalizeString(source.contactPhone),
    listingUrl,
    url: listingUrl,
    tags: normalizeList(source.tags),
    risks: normalizeList(source.risks),
    pros: normalizeString(source.pros),
    cons: normalizeString(source.cons),
    notes: normalizeString(source.notes),
    source: normalizeString(source.source) || "Importacion por agente",
    status,
    agentSummary: normalizeString(source.agentSummary),
    agentConfidence: normalizeString(source.agentConfidence) || "media"
  };
}

function normalizeItems(items) {
  return items.map(normalizeItem);
}

function chunkItems(items, size = BATCH_SIZE) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function validateItems(items) {
  return {
    incompleteCount: items.filter((item) => !item.zone || !item.rent || !item.area || !item.rooms || !item.listingUrl).length,
    noParkingCount: items.filter((item) => !item.parking).length,
    noRentCount: items.filter((item) => !item.rent).length,
    noUrlCount: items.filter((item) => !item.listingUrl).length
  };
}

function detectDuplicates(items) {
  const seen = new Map();
  const duplicates = [];

  items.forEach((item, index) => {
    const key = makeDuplicateKey(item);
    if (!key) return;
    if (seen.has(key)) {
      duplicates.push({ index, firstIndex: seen.get(key), key });
      return;
    }
    seen.set(key, index);
  });

  return duplicates;
}

function renderPreview(summary) {
  if (!summary.rawText.trim()) {
    previewBox.innerHTML = "<p class=\"muted\">Sin JSON para importar.</p>";
    setToolButtons(false);
    return;
  }

  if (!summary.parse.ok) {
    previewBox.innerHTML = `<div class="agent-card agent-card--warn"><strong>${escapeHtml(summary.parse.error)}</strong></div>`;
    setToolButtons(false);
    return;
  }

  const batchSizes = summary.batches.map((batch) => batch.length).join(", ") || "0";
  const duplicateAction = skipDuplicatesInput.checked ? "Se omitiran duplicados locales." : "Se importaran igual.";

  previewBox.innerHTML = `
    <div class="agent-preview-grid">
      <article class="agent-card"><span>Total detectadas</span><strong>${summary.normalized.length}</strong></article>
      <article class="agent-card"><span>Total a enviar</span><strong>${summary.itemsToSend.length}</strong></article>
      <article class="agent-card"><span>Lotes</span><strong>${summary.batches.length}</strong><small>${escapeHtml(batchSizes)} por lote</small></article>
      <article class="agent-card"><span>Datos incompletos</span><strong>${summary.validation.incompleteCount}</strong></article>
      <article class="agent-card"><span>Sin parqueadero</span><strong>${summary.validation.noParkingCount}</strong></article>
      <article class="agent-card"><span>Sin precio</span><strong>${summary.validation.noRentCount}</strong></article>
      <article class="agent-card"><span>Sin URL</span><strong>${summary.validation.noUrlCount}</strong></article>
      <article class="agent-card ${summary.duplicates.length ? "agent-card--warn" : ""}">
        <span>Posibles duplicados</span><strong>${summary.duplicates.length}</strong><small>${duplicateAction}</small>
      </article>
    </div>
  `;
  setToolButtons(Boolean(summary.itemsToSend.length));
}

async function importBatch(batch, batchIndex, totalBatches) {
  const endpoint = functionUrlInput.value.trim();
  const agentKey = agentKeyInput.value;
  const dryRun = dryRunInput.checked;
  const payload = { items: batch, dryRun };

  progressBox.textContent = `Enviando lote ${batchIndex + 1}/${totalBatches}...`;
  importBtn.textContent = `Enviando lote ${batchIndex + 1}/${totalBatches}...`;

  if (DEV_LOGS) {
    console.info("Importando lote", { endpoint, batchIndex, totalBatches, count: batch.length, dryRun });
  }

  let response;
  let responseText = "";
  let data = {};

  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${agentKey}`
      },
      body: JSON.stringify(payload)
    });
    responseText = await response.text();
    data = responseText ? safeJson(responseText) : {};
  } catch (error) {
    throw buildFetchError(error, endpoint, batchIndex, batch, null, "");
  }

  if (!response.ok || data.ok === false) {
    throw buildFetchError(
      new Error(data.error || response.statusText || "La Cloud Function rechazo el lote."),
      endpoint,
      batchIndex,
      batch,
      response,
      responseText
    );
  }

  return {
    ...data,
    batchIndex,
    batchSize: batch.length,
    createdCount: data.createdCount || 0,
    updatedCount: data.updatedCount || 0,
    rejectedCount: data.rejectedCount || 0,
    warnings: data.warnings || [],
    errors: data.errors || []
  };
}

async function importAllBatches() {
  setResult("", true);
  failedBatch = null;
  currentState = buildState();

  if (!functionUrlInput.value.trim()) return renderResult({ ok: false, message: "Falta el endpoint." });
  if (!agentKeyInput.value) return renderResult({ ok: false, message: "Falta la clave temporal del agente." });
  if (!currentState.parse.ok) return renderResult({ ok: false, message: currentState.parse.error });
  if (!currentState.itemsToSend.length) return renderResult({ ok: false, message: "No hay opciones para importar." });

  const totalBatches = currentState.batches.length;
  const totals = {
    totalReceived: currentState.normalized.length,
    totalSent: 0,
    batchesSent: 0,
    createdCount: 0,
    updatedCount: 0,
    rejectedCount: 0,
    warnings: [],
    errors: []
  };

  setWorking(true);

  for (let index = 0; index < totalBatches; index += 1) {
    const batch = currentState.batches[index];
    progressBox.textContent = `Lote ${index + 1} de ${totalBatches}. Importadas ${totals.totalSent} de ${currentState.itemsToSend.length}.`;

    try {
      const result = await importBatch(batch, index, totalBatches);
      totals.totalSent += batch.length;
      totals.batchesSent += 1;
      totals.createdCount += result.createdCount || 0;
      totals.updatedCount += result.updatedCount || 0;
      totals.rejectedCount += result.rejectedCount || 0;
      totals.warnings.push(...(result.warnings || []));
      totals.errors.push(...(result.errors || []));
      renderResult({ ok: true, inProgress: true, totals, totalBatches });
    } catch (error) {
      failedBatch = { batch, batchIndex: index, totalBatches, error };
      renderError(error);
      if (stopOnErrorInput.checked) {
        setWorking(false);
        importBtn.textContent = "Importar todo";
        return;
      }
      totals.batchesSent += 1;
      totals.rejectedCount += batch.length;
      totals.errors.push(error.technical || { message: error.message || "Lote fallido" });
    }
  }

  progressBox.textContent = `Importadas ${totals.totalSent} de ${currentState.itemsToSend.length}.`;
  importBtn.textContent = "Completado";
  renderResult({ ok: true, totals, totalBatches, dryRun: dryRunInput.checked });
  importBtn.disabled = false;
  window.setTimeout(() => {
    importBtn.textContent = "Importar todo";
  }, 1400);
}

function renderResult(result) {
  if (!result.ok) {
    resultBox.innerHTML = `<div class="agent-card agent-card--warn"><strong>${escapeHtml(result.message)}</strong></div>`;
    resultBox.classList.remove("hidden");
    return;
  }

  const title = result.inProgress ? "Importacion en progreso" : result.dryRun ? "Validacion completada" : "Importacion completada";
  const totals = result.totals;
  resultBox.innerHTML = `
    <h2>${title}</h2>
    <div class="agent-preview-grid">
      <article class="agent-card"><span>Total recibidas</span><strong>${totals.totalReceived}</strong></article>
      <article class="agent-card"><span>Lotes enviados</span><strong>${totals.batchesSent}/${result.totalBatches}</strong></article>
      <article class="agent-card"><span>Creadas</span><strong>${totals.createdCount}</strong></article>
      <article class="agent-card"><span>Actualizadas</span><strong>${totals.updatedCount}</strong></article>
      <article class="agent-card"><span>Rechazadas</span><strong>${totals.rejectedCount}</strong></article>
      <article class="agent-card"><span>Advertencias</span><strong>${totals.warnings.length}</strong></article>
    </div>
  `;
  resultBox.classList.remove("hidden");
}

function renderError(error) {
  const detail = error.technical || {};
  failedBatch = failedBatch || {};

  resultBox.innerHTML = `
    <h2>No se pudo importar el lote</h2>
    <div class="agent-error">
      <p><strong>Sugerencia probable:</strong> ${escapeHtml(getSuggestion(detail.status, detail.message))}</p>
      <dl>
        <dt>Endpoint usado</dt><dd>${escapeHtml(detail.endpoint || "")}</dd>
        <dt>Metodo usado</dt><dd>POST</dd>
        <dt>Lote que fallo</dt><dd>${Number(detail.batchIndex) + 1}</dd>
        <dt>Opciones del lote</dt><dd>${detail.batchSize || 0}</dd>
        <dt>Mensaje</dt><dd>${escapeHtml(detail.message || "Error desconocido")}</dd>
        <dt>Status HTTP</dt><dd>${detail.status || "Sin status"}</dd>
        <dt>Respuesta del servidor</dt><dd><pre>${escapeHtml(detail.responseText || "Sin respuesta legible")}</pre></dd>
      </dl>
      <div class="agent-import__tools">
        <button id="retryFailedBtn" class="btn btn--primary btn--tiny" type="button">Reintentar lote fallido</button>
        <button id="copyFailedBtn" class="btn btn--ghost btn--tiny" type="button">Copiar JSON del lote fallido</button>
        <button id="downloadFailedBtn" class="btn btn--ghost btn--tiny" type="button">Descargar JSON del lote fallido</button>
      </div>
    </div>
  `;
  resultBox.classList.remove("hidden");

  document.querySelector("#retryFailedBtn").addEventListener("click", retryFailedBatch);
  document.querySelector("#copyFailedBtn").addEventListener("click", () => copyToClipboard(JSON.stringify({ items: failedBatch.batch || [] }, null, 2)));
  document.querySelector("#downloadFailedBtn").addEventListener("click", () => downloadJson("lote-fallido.json", { items: failedBatch.batch || [] }));
}

function copyToClipboard(text) {
  return navigator.clipboard.writeText(text || "");
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

function buildState() {
  const rawText = jsonInput?.value || "";
  const parse = parseRawInput(rawText);
  const rawItems = parse.ok ? getItems(parse.payload) : [];
  const normalized = normalizeItems(rawItems);
  const duplicates = detectDuplicates(normalized);
  const duplicateIndexes = new Set(duplicates.map((duplicate) => duplicate.index));
  const itemsToSend = skipDuplicatesInput?.checked
    ? normalized.filter((item, index) => !duplicateIndexes.has(index))
    : normalized;
  const batches = chunkItems(itemsToSend);

  return {
    rawText,
    parse,
    rawItems,
    normalized,
    itemsToSend,
    batches,
    validation: validateItems(normalized),
    duplicates
  };
}

function updatePreview() {
  currentState = buildState();
  renderPreview(currentState);
}

function copyBatch(index) {
  const batch = currentState.batches[index] || [];
  return copyToClipboard(JSON.stringify({ items: batch }, null, 2));
}

async function retryFailedBatch() {
  if (!failedBatch?.batch) return;
  setWorking(true);
  try {
    const result = await importBatch(failedBatch.batch, failedBatch.batchIndex, failedBatch.totalBatches);
    renderResult({
      ok: true,
      totals: {
        totalReceived: failedBatch.batch.length,
        totalSent: failedBatch.batch.length,
        batchesSent: 1,
        createdCount: result.createdCount || 0,
        updatedCount: result.updatedCount || 0,
        rejectedCount: result.rejectedCount || 0,
        warnings: result.warnings || [],
        errors: result.errors || []
      },
      totalBatches: 1,
      dryRun: dryRunInput.checked
    });
    failedBatch = null;
  } catch (error) {
    renderError(error);
  } finally {
    setWorking(false);
  }
}

function setWorking(isWorking) {
  importBtn.disabled = isWorking;
  importBtn.textContent = isWorking ? "Importando..." : "Importar todo";
}

function setToolButtons(enabled) {
  [copyNormalizedBtn, downloadNormalizedBtn, copyBatch1Btn, copyBatch2Btn].forEach((button) => {
    button.disabled = !enabled;
  });
  copyBatch2Btn.disabled = !enabled || currentState.batches.length < 2;
}

function buildFetchError(error, endpoint, batchIndex, batch, response, responseText) {
  const status = response?.status || 0;
  const message = error?.message || "No se pudo conectar con la Cloud Function.";
  return {
    message,
    technical: {
      endpoint,
      batchIndex,
      batchSize: batch.length,
      message,
      status,
      responseText,
      code: getErrorCode(status, message)
    }
  };
}

function getErrorCode(status, message) {
  if (status === 401 || status === 403) return "AUTH_FAILED";
  if (status === 404) return "NOT_FOUND";
  if (status >= 500) return "SERVER_ERROR";
  if (/failed to fetch|cors|network/i.test(message)) return "CORS_OR_NETWORK";
  return "VALIDATION_ERROR";
}

function getSuggestion(status, message) {
  if (status === 401 || status === 403) return "Revisar clave temporal o autorizacion.";
  if (status === 404) return "Revisar URL de la Cloud Function o despliegue.";
  if (status >= 500) return "Revisar logs de Firebase o Google Cloud Functions.";
  if (/failed to fetch|cors|network/i.test(message)) return "Probablemente CORS, red o endpoint inaccesible desde navegador.";
  return "Revisar respuesta del servidor y estructura del JSON.";
}

function canParseJson(text) {
  try {
    JSON.parse(text);
    return true;
  } catch (error) {
    return false;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return { rawResponse: text };
  }
}

function normalizeString(value) {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function normalizeNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const raw = String(value).replace(/[^\d,.-]/g, "");
  const separators = raw.match(/[,.]/g) || [];
  const cleaned = separators.length > 1 ? raw.replace(/[,.]/g, "") : raw.replace(",", ".");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(normalizeString).filter(Boolean);
  return normalizeString(value).split(",").map((part) => part.trim()).filter(Boolean);
}

function makeDuplicateKey(item) {
  return [item.title, item.zone, item.rent, item.area]
    .map(normalizeForKey)
    .join("|");
}

function normalizeForKey(value) {
  return normalizeString(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
