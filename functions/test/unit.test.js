"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  makeDuplicateKey,
  normalizeList,
  normalizeListingUrl,
  normalizeNumber,
  normalizeRentalOption,
  normalizeString
} = require("../lib/normalize");
const { validateBatch, validateRentalOption } = require("../lib/schema");
const { evaluateRateLimit, evaluateToken, extractAgentKey, sha256hex } = require("../lib/auth");
const { corsHeaders, isAllowedOrigin } = require("../lib/cors");

test("normalizeNumber interpreta formatos colombianos", () => {
  assert.equal(normalizeNumber("$ 6.500.000"), 6500000);
  assert.equal(normalizeNumber("6,500,000"), 6500000);
  assert.equal(normalizeNumber("1.234,56"), 1234.56);
  assert.equal(normalizeNumber(6500000), 6500000);
  assert.equal(normalizeNumber("6,5"), 6.5);
});

test("normalizeNumber no inventa datos: vacio y basura son 0", () => {
  assert.equal(normalizeNumber(""), 0);
  assert.equal(normalizeNumber(null), 0);
  assert.equal(normalizeNumber(undefined), 0);
  assert.equal(normalizeNumber("no sabemos"), 0);
  assert.equal(normalizeNumber(-4), 0);
  assert.equal(normalizeNumber(Number.NaN), 0);
});

test("normalizeString recorta y colapsa espacios sin inventar contenido", () => {
  assert.equal(normalizeString("  Casa   grande \n "), "Casa grande");
  assert.equal(normalizeString(null), "");
  assert.equal(normalizeString({ a: 1 }), "");
});

test("normalizeList acepta arrays y strings separadas por coma", () => {
  assert.deepEqual(normalizeList(["a", " b ", ""]), ["a", "b"]);
  assert.deepEqual(normalizeList("a, b ,c"), ["a", "b", "c"]);
  assert.deepEqual(normalizeList(null), []);
});

test("normalizeListingUrl canonicaliza host, tracking y barra final", () => {
  assert.equal(
    normalizeListingUrl("https://WWW.Metrocuadrado.com/inmueble/123/?utm_source=ia&b=2#seccion"),
    "https://metrocuadrado.com/inmueble/123?b=2"
  );
  assert.equal(normalizeListingUrl("http://fincaraiz.com.co/x/9"), "https://fincaraiz.com.co/x/9");
  assert.equal(normalizeListingUrl("no es una url"), "");
  assert.equal(normalizeListingUrl("ftp://fincaraiz.com.co/x"), "");
  assert.equal(normalizeListingUrl(""), "");
});

test("makeDuplicateKey usa la URL normalizada como identidad principal", () => {
  const a = normalizeRentalOption({ title: "Casa A", listingUrl: "https://www.metrocuadrado.com/inmueble/7/" });
  const b = normalizeRentalOption({ title: "Otro titulo", listingUrl: "http://metrocuadrado.com/inmueble/7?utm_source=x" });
  assert.equal(a.duplicateKey, b.duplicateKey);
  assert.ok(a.duplicateKey.startsWith("url:"));
});

test("makeDuplicateKey cae a titulo|zona|canon cuando no hay URL", () => {
  const key = makeDuplicateKey({ title: "Casa Ñ", zone: "Pasadena", rent: 100, listingUrl: "" });
  assert.equal(key, "meta:casa n|pasadena|100");
});

test("validateRentalOption acepta un inmueble completo", () => {
  const result = validateRentalOption(
    {
      title: "Casa amplia en Pasadena",
      zone: "Pasadena",
      rent: "6.200.000",
      listingUrl: "https://www.metrocuadrado.com/inmueble/1001",
      status: "nueva",
      agentConfidence: "alta"
    },
    0
  );
  assert.equal(result.valid, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.normalized.rent, 6200000);
});

test("validateRentalOption exige title, zone y listingUrl", () => {
  const result = validateRentalOption({}, 3);
  const fields = result.errors.map((error) => error.field).sort();
  assert.deepEqual(fields, ["listingUrl", "title", "zone"]);
  result.errors.forEach((error) => {
    assert.equal(error.index, 3);
    assert.ok(error.cause.length > 0);
    assert.ok(error.suggestion.length > 0);
  });
});

test("validateRentalOption rechaza URLs no directas al anuncio", () => {
  const portada = validateRentalOption({ title: "Casa", zone: "Z", listingUrl: "https://metrocuadrado.com" }, 0);
  const buscador = validateRentalOption({ title: "Casa", zone: "Z", listingUrl: "https://metrocuadrado.com/buscar?q=casa" }, 0);
  assert.equal(portada.valid, false);
  assert.equal(buscador.valid, false);
  assert.ok(portada.errors.some((error) => /portada|buscador/.test(error.cause)));
});

test("validateRentalOption rechaza numeros no numericos y enums invalidos", () => {
  const result = validateRentalOption(
    {
      title: "Casa",
      zone: "Pasadena",
      listingUrl: "https://metrocuadrado.com/inmueble/2",
      rent: "carisimo",
      status: "vendida",
      agentConfidence: "altisima"
    },
    0
  );
  const fields = result.errors.map((error) => error.field);
  assert.ok(fields.includes("rent"));
  assert.ok(fields.includes("status"));
  assert.ok(fields.includes("agentConfidence"));
});

test("validateBatch separa validos de invalidos conservando el indice", () => {
  const batch = validateBatch([
    { title: "Casa 1", zone: "A", listingUrl: "https://metrocuadrado.com/inmueble/1" },
    { title: "", zone: "", listingUrl: "" }
  ]);
  assert.equal(batch.validRows.length, 1);
  assert.equal(batch.invalidRows.length, 1);
  assert.equal(batch.invalidRows[0].index, 1);
});

test("extractAgentKey prefiere X-Agent-Key sobre Authorization", () => {
  assert.equal(extractAgentKey({ "x-agent-key": "abc" }, {}), "abc");
  assert.equal(extractAgentKey({ authorization: "Bearer xyz" }, {}), "xyz");
  assert.equal(extractAgentKey({}, { agentKey: "cuerpo" }), "cuerpo");
  assert.equal(extractAgentKey({}, {}), "");
});

test("sha256hex es estable y no reversible en el payload", () => {
  assert.equal(sha256hex("hola").length, 64);
  assert.equal(sha256hex("hola"), sha256hex("hola"));
  assert.notEqual(sha256hex("hola"), sha256hex("hol"));
});

test("evaluateToken distingue invalida, revocada, vencida y valida", () => {
  const now = Date.now();
  assert.equal(evaluateToken(null, now).code, "AUTH_INVALID");
  assert.equal(evaluateToken({ revoked: true }, now).code, "AUTH_REVOKED");
  assert.equal(evaluateToken({ expiresAt: new Date(now - 1000) }, now).code, "AUTH_EXPIRED");
  assert.equal(evaluateToken({ expiresAt: new Date(now + 10000) }, now).ok, true);
});

test("evaluateRateLimit permite lotes pequenos y corta el abuso", () => {
  const now = Date.now();
  assert.equal(evaluateRateLimit({}, now).allowed, true);
  assert.equal(evaluateRateLimit({ rateWindowStart: now, rateWindowCount: 3 }, now).allowed, true);
  const blocked = evaluateRateLimit({ rateWindowStart: now, rateWindowCount: 40 }, now);
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
  // Ventana vencida: vuelve a permitir.
  assert.equal(evaluateRateLimit({ rateWindowStart: now - 10 * 60 * 1000, rateWindowCount: 99 }, now).allowed, true);
});

test("isAllowedOrigin acepta GitHub Pages, localhost y previews del proyecto", () => {
  assert.equal(isAllowedOrigin("https://musicala.github.io"), true);
  assert.equal(isAllowedOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:5500"), true);
  assert.equal(isAllowedOrigin("https://arriendos-musicala.web.app"), true);
  assert.equal(isAllowedOrigin("https://sitio-malicioso.com"), false);
  assert.equal(isAllowedOrigin(""), false);
});

test("corsHeaders siempre permite los headers de la clave y la idempotencia", () => {
  const headers = corsHeaders("https://musicala.github.io");
  assert.equal(headers["Access-Control-Allow-Origin"], "https://musicala.github.io");
  assert.match(headers["Access-Control-Allow-Headers"], /X-Agent-Key/);
  assert.match(headers["Access-Control-Allow-Headers"], /X-Idempotency-Key/);
  assert.match(headers["Access-Control-Allow-Methods"], /OPTIONS/);
  assert.equal(corsHeaders("https://malicioso.com")["Access-Control-Allow-Origin"], undefined);
});
