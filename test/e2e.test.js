"use strict";

/**
 * Prueba de extremo a extremo del flujo real de agent-import.html en un
 * navegador Chromium, contra la Cloud Function real corriendo en otro origen
 * (cross-origin de verdad, con preflight OPTIONS y CORS reales).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { chromium } = require("playwright");
const { start } = require("./dev-server");

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "fixtures", "ejemplo-4-inmuebles.json"), "utf8")
);
const SHOTS = path.join(__dirname, "screenshots");

test("flujo completo en el navegador: conectar, validar, guardar", async (t) => {
  fs.mkdirSync(SHOTS, { recursive: true });

  const server = await start(4273, 4274);
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });

  const consoleErrors = [];
  page.on("pageerror", (error) => consoleErrors.push(String(error)));
  page.on("console", (message) => {
    // Ignoramos el ruido de red del entorno de pruebas: la página sondea el
    // endpoint por defecto al abrir, y aquí ese host no es alcanzable.
    const text = message.text();
    if (message.type() !== "error") return;
    if (/Failed to load resource/i.test(text)) return;
    consoleErrors.push(text);
  });

  t.after(async () => {
    await browser.close();
    await server.stop();
  });

  await page.goto(`${server.webUrl}/agent-import.html`);

  // --- 1. Conexión: la página prueba /health sola al abrir ---
  await page.fill("#functionUrlInput", server.apiUrl);
  await page.click("#testConnectionBtn");
  await page.waitForFunction(
    () => document.querySelector("#connectionBadge").textContent.trim() === "Conectado",
    null,
    { timeout: 15000 }
  );
  const connectionText = await page.textContent("#connectionBox");
  assert.match(connectionText, /Estado HTTP/);
  assert.match(connectionText, /200/);
  assert.match(connectionText, /Origen permitido por el backend\s*Sí/);
  await page.screenshot({ path: path.join(SHOTS, "01-conexion.png"), fullPage: true });

  // El sondeo automático de apertura (contra el endpoint por defecto) no debe
  // pisar el resultado de esta prueba manual, aunque termine después.
  await page.waitForTimeout(2500);
  assert.equal(await page.textContent("#connectionBadge"), "Conectado");
  assert.match(await page.textContent("#connectionBox"), /Origen permitido por el backend\s*Sí/);

  // --- 2. Clave y JSON ---
  await page.fill("#agentKeyInput", server.demoKey);
  await page.waitForFunction(
    () => document.querySelector("#keyBadge").textContent.includes("memoria")
  );

  await page.fill("#jsonInput", JSON.stringify(FIXTURE, null, 2));
  await page.waitForFunction(
    () => document.querySelector("#jsonBadge").textContent.includes("4 listas")
  );

  // La vista previa muestra una fila por inmueble.
  assert.equal(await page.locator(".rows-table tbody tr").count(), 4);
  await page.screenshot({ path: path.join(SHOTS, "02-vista-previa.png"), fullPage: true });

  // --- 3. Validar sin guardar ---
  await page.click("#validateBtn");
  await page.waitForSelector(".result-head--dry", { timeout: 20000 });
  const dryText = await page.textContent("#resultBox");
  assert.match(dryText, /Validado · NO guardado/);
  assert.match(dryText, /Validación completada sin guardar/);
  assert.equal(server.db.all("rentalOptions").length, 0, "validar no debe guardar nada");
  await page.screenshot({ path: path.join(SHOTS, "03-validado-sin-guardar.png"), fullPage: true });

  // --- 4. Guardar de verdad ---
  await page.click("#importBtn");
  await page.waitForSelector(".result-head--saved", { timeout: 20000 });
  const savedText = await page.textContent("#resultBox");
  assert.match(savedText, /Guardado en el tablero/);
  assert.match(savedText, /Importación completada/);

  const saved = server.db.all("rentalOptions");
  assert.equal(saved.length, 4, "los 4 inmuebles quedaron guardados");
  assert.ok(saved.every((doc) => typeof doc.rent === "number" && doc.source === "agent"));
  await page.screenshot({ path: path.join(SHOTS, "04-guardado.png"), fullPage: true });

  // --- 5. El JSON y la vista previa siguen intactos ---
  assert.ok((await page.inputValue("#jsonInput")).includes("Pasadena"));
  assert.equal(await page.locator(".rows-table tbody tr").count(), 4);

  // --- 6. Reimportar no duplica ---
  await page.click("#importBtn");
  await page.waitForFunction(
    () => document.querySelector("#resultBox").textContent.includes("Importación completada"),
    null,
    { timeout: 20000 }
  );
  assert.equal(server.db.all("rentalOptions").length, 4, "reimportar no crea duplicados");

  // --- 7. Reporte de diagnóstico sin la clave ---
  await page.click("#toggleDiagnosticBtn");
  const report = await page.textContent("#diagnosticBox");
  assert.ok(!report.includes(server.demoKey), "el diagnóstico nunca incluye la clave");
  assert.match(report, /requestId/);
  assert.match(report, /endpoint/);
  await page.screenshot({ path: path.join(SHOTS, "05-diagnostico.png"), fullPage: true });

  assert.deepEqual(consoleErrors, [], "la página no debe producir errores de consola");
});

test("la interfaz explica un endpoint inalcanzable en vez de decir solo 'Failed to fetch'", async (t) => {
  const server = await start(4275, 4276);
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1200 } });
  t.after(async () => {
    await browser.close();
    await server.stop();
  });

  await page.goto(`${server.webUrl}/agent-import.html`);
  // Puerto cerrado: el host no responde.
  await page.fill("#functionUrlInput", "http://127.0.0.1:4999");
  await page.click("#testConnectionBtn");
  await page.waitForSelector(".diag-error", { timeout: 20000 });

  const text = await page.textContent("#connectionBox");
  assert.match(text, /No se pudo alcanzar el host|Fallo de red/);
  assert.match(text, /Cómo arreglarlo/);
  assert.match(text, /Host alcanzable\s*No/);
  assert.equal(await page.textContent("#connectionBadge"), "Sin conexión");

  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, "06-endpoint-inalcanzable.png"), fullPage: true });
});

test("una clave vencida se explica en la interfaz sin filtrar la clave", async (t) => {
  const server = await start(4277, 4278);
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  t.after(async () => {
    await browser.close();
    await server.stop();
  });

  await page.goto(`${server.webUrl}/agent-import.html`);
  await page.fill("#functionUrlInput", server.apiUrl);
  await page.fill("#agentKeyInput", "clave-vencida");
  await page.fill("#jsonInput", JSON.stringify(FIXTURE));
  await page.click("#importBtn");

  await page.waitForSelector(".result-head--error", { timeout: 20000 });
  const text = await page.textContent("#resultBox");
  assert.match(text, /HTTP_403/);
  assert.match(text, /vencida|revocada|permisos/i);
  assert.ok(!text.includes("clave-vencida"), "no se muestra la clave en el error");
  assert.equal(server.db.all("rentalOptions").length, 0);

  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, "07-clave-vencida.png"), fullPage: true });
});

test("una URL inválida se marca fila por fila y no bloquea las válidas", async (t) => {
  const server = await start(4279, 4280);
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--no-sandbox"]
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
  t.after(async () => {
    await browser.close();
    await server.stop();
  });

  await page.goto(`${server.webUrl}/agent-import.html`);
  await page.fill("#functionUrlInput", server.apiUrl);
  await page.fill("#agentKeyInput", server.demoKey);
  await page.fill(
    "#jsonInput",
    JSON.stringify({
      items: [
        FIXTURE.items[0],
        { title: "Casa sin URL real", zone: "Pasadena", rent: 5000000, listingUrl: "esto-no-es-una-url" }
      ]
    })
  );

  await page.waitForFunction(() => document.querySelectorAll(".row--error").length === 1);
  const rowText = await page.textContent(".row--error");
  assert.match(rowText, /1 error/);

  await page.click(".row--error .row-errors summary");
  const errorDetail = await page.textContent(".row--error .row-errors");
  assert.match(errorDetail, /listingUrl/);
  assert.match(errorDetail, /URL absoluta/);

  await page.click("#importBtn");
  await page.waitForSelector(".result-head--saved", { timeout: 20000 });
  assert.equal(server.db.all("rentalOptions").length, 1, "solo se guarda la válida");

  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, "08-url-invalida.png"), fullPage: true });
});
