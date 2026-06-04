const DEFAULT_FUNCTION_URL = "https://us-central1-arriendos-musicala.cloudfunctions.net/agentImportRentalOptions";

const form = document.querySelector("#agentImportForm");
const functionUrlInput = document.querySelector("#functionUrlInput");
const agentKeyInput = document.querySelector("#agentKeyInput");
const jsonInput = document.querySelector("#jsonInput");
const previewBox = document.querySelector("#previewBox");
const resultBox = document.querySelector("#resultBox");

functionUrlInput.value = DEFAULT_FUNCTION_URL;

jsonInput.addEventListener("input", updatePreview);
form.addEventListener("submit", handleSubmit);
updatePreview();

function updatePreview() {
  const parsed = parsePayload();

  if (!jsonInput.value.trim()) {
    previewBox.textContent = "Sin JSON para importar.";
    return;
  }

  if (!parsed.ok) {
    previewBox.textContent = "JSON invalido. Revisa comillas, llaves y corchetes.";
    return;
  }

  const count = getItems(parsed.value).length;
  previewBox.textContent = count === 1
    ? "Vista previa: 1 opcion lista para enviar."
    : `Vista previa: ${count} opciones listas para enviar.`;
}

async function handleSubmit(event) {
  event.preventDefault();
  setResult("", true);

  const endpoint = functionUrlInput.value.trim();
  const agentKey = agentKeyInput.value;
  const parsed = parsePayload();

  if (!endpoint) {
    setResult("Falta la URL de la Cloud Function.");
    return;
  }

  if (!agentKey) {
    setResult("Falta la clave temporal del agente.");
    return;
  }

  if (!parsed.ok) {
    setResult("El JSON no es valido. Corrigelo antes de importar.");
    return;
  }

  const items = getItems(parsed.value);
  if (!items.length) {
    setResult("El JSON debe incluir item o items.");
    return;
  }

  if (items.length > 25) {
    setResult("Maximo 25 opciones por importacion.");
    return;
  }

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${agentKey}`
      },
      body: JSON.stringify(parsed.value)
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      setResult(data.error || "No se pudo importar. Revisa la clave y el endpoint.");
      return;
    }

    setResult(
      `Importacion completada. Creadas: ${data.createdCount || 0}. Actualizadas: ${data.updatedCount || 0}. Rechazadas: ${data.rejectedCount || 0}.`
    );
  } catch (error) {
    setResult("No se pudo conectar con la Cloud Function. Revisa la URL, CORS y el despliegue.");
  }
}

function parsePayload() {
  try {
    return { ok: true, value: JSON.parse(jsonInput.value || "{}") };
  } catch (error) {
    return { ok: false, value: null };
  }
}

function getItems(payload) {
  if (Array.isArray(payload.items)) return payload.items;
  if (payload.item && typeof payload.item === "object") return [payload.item];
  return [];
}

function setResult(message, hide = false) {
  resultBox.textContent = message;
  resultBox.classList.toggle("hidden", hide || !message);
}
