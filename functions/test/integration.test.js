"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const { createHandler } = require("../lib/handler");
const { sha256hex } = require("../lib/auth");
const { FirestoreStub, fieldValue } = require("./firestore-stub");
const { makeRequest, makeResponse } = require("./http-stub");

const GITHUB_PAGES_ORIGIN = "https://musicala.github.io";
const VALID_KEY = "clave-de-prueba-no-sensible";
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "fixtures", "ejemplo-4-inmuebles.json"), "utf8")
);

function setup(options = {}) {
  const db = new FirestoreStub();
  db.seed("agentTokens", "token1", {
    tokenHash: sha256hex(VALID_KEY),
    label: "Clave de prueba",
    revoked: false,
    expiresAt: new Date(Date.now() + 86400000),
    useCount: 0
  });
  db.seed("agentTokens", "tokenVencido", {
    tokenHash: sha256hex("clave-vencida"),
    label: "Vencida",
    revoked: false,
    expiresAt: new Date(Date.now() - 86400000)
  });
  db.seed("agentTokens", "tokenRevocado", {
    tokenHash: sha256hex("clave-revocada"),
    label: "Revocada",
    revoked: true,
    expiresAt: new Date(Date.now() + 86400000)
  });

  let counter = 0;
  const handler = createHandler(
    Object.assign({ db, fieldValue, newId: () => `req_test_${(counter += 1)}` }, options)
  );
  return { db, handler };
}

async function call(handler, requestOptions) {
  const req = makeRequest(requestOptions);
  const res = makeResponse();
  await handler(req, res);
  return res;
}

function importRequest(items, extra = {}) {
  return {
    method: "POST",
    path: "/",
    headers: Object.assign(
      { Origin: GITHUB_PAGES_ORIGIN, "Content-Type": "application/json", "X-Agent-Key": VALID_KEY },
      extra.headers || {}
    ),
    body: Object.assign({ items }, extra.body || {})
  };
}

test("OPTIONS responde 204 con CORS completo para el origen de GitHub Pages", async () => {
  const { handler } = setup();
  const res = await call(handler, {
    method: "OPTIONS",
    path: "/",
    headers: {
      Origin: GITHUB_PAGES_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type,x-agent-key"
    }
  });

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], GITHUB_PAGES_ORIGIN);
  assert.match(res.headers["access-control-allow-headers"], /x-agent-key/i);
  assert.match(res.headers["access-control-allow-methods"], /POST/);
});

test("OPTIONS desde localhost tambien queda autorizado", async () => {
  const { handler } = setup();
  const res = await call(handler, { method: "OPTIONS", path: "/", headers: { Origin: "http://localhost:5173" } });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:5173");
});

test("OPTIONS desde un origen no autorizado no rompe: responde sin Allow-Origin", async () => {
  const { handler } = setup();
  const res = await call(handler, { method: "OPTIONS", path: "/", headers: { Origin: "https://malicioso.com" } });
  assert.equal(res.statusCode, 204);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("GET /health responde JSON con estado, version y fecha", async () => {
  const { handler } = setup();
  const res = await call(handler, { method: "GET", path: "/health", headers: { Origin: GITHUB_PAGES_ORIGIN } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, "healthy");
  assert.equal(res.body.originAllowed, true);
  assert.equal(res.body.agentKeyHeader, "X-Agent-Key");
  assert.ok(res.body.apiVersion);
  assert.ok(!Number.isNaN(Date.parse(res.body.timestamp)));
  assert.equal(res.headers["access-control-allow-origin"], GITHUB_PAGES_ORIGIN);
  assert.ok(res.headers["x-request-id"]);
});

test("/health reporta degradado si Firestore no responde", async () => {
  const { db, handler } = setup();
  db.down = true;
  const res = await call(handler, { method: "GET", path: "/health", headers: { Origin: GITHUB_PAGES_ORIGIN } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.firestore, "unreachable");
});

test("los errores 4xx tambien traen cabeceras CORS (nunca 'Failed to fetch' mudo)", async () => {
  const { handler } = setup();
  const sinClave = await call(handler, {
    method: "POST",
    path: "/",
    headers: { Origin: GITHUB_PAGES_ORIGIN, "Content-Type": "application/json" },
    body: { items: [] }
  });
  assert.equal(sinClave.statusCode, 401);
  assert.equal(sinClave.headers["access-control-allow-origin"], GITHUB_PAGES_ORIGIN);
  assert.equal(sinClave.body.code, "AUTH_MISSING");
  assert.ok(sinClave.body.requestId);

  const metodoMalo = await call(handler, { method: "DELETE", path: "/", headers: { Origin: GITHUB_PAGES_ORIGIN } });
  assert.equal(metodoMalo.statusCode, 405);
  assert.equal(metodoMalo.headers["access-control-allow-origin"], GITHUB_PAGES_ORIGIN);
});

test("dryRun valida sin guardar y devuelve la vista previa normalizada", async () => {
  const { db, handler } = setup();
  const res = await call(handler, importRequest(FIXTURE.items, { body: { dryRun: true } }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mode, "validated_not_saved");
  assert.equal(res.body.totalReceived, 4);
  assert.equal(res.body.created, 4);
  assert.equal(res.body.invalid, 0);
  assert.equal(res.body.normalizedPreview.length, 4);
  assert.equal(db.all("rentalOptions").length, 0, "dryRun no debe escribir nada");
  assert.ok(res.body.results.every((row) => row.outcome === "wouldCreate"));
});

test("importa 4 inmuebles validos desde un origen equivalente a GitHub Pages", async () => {
  const { db, handler } = setup();
  const res = await call(handler, importRequest(FIXTURE.items));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.mode, "saved");
  assert.equal(res.body.created, 4);
  assert.equal(res.body.updated, 0);
  assert.equal(res.body.failed, 0);

  const saved = db.all("rentalOptions");
  assert.equal(saved.length, 4);
  saved.forEach((doc) => {
    assert.equal(typeof doc.title, "string");
    assert.equal(typeof doc.rent, "number");
    assert.equal(doc.source, "agent");
    assert.deepEqual(doc.ratings, {});
    assert.ok(doc.sourceUrl.startsWith("https://"));
    assert.equal(doc.listingUrlRaw, undefined, "no se guarda el campo auxiliar");
  });
  assert.equal(saved.find((doc) => doc.zone === "Pontevedra").rent, 5800000);
});

test("reimportar el mismo JSON actualiza y no duplica", async () => {
  const { db, handler } = setup();
  await call(handler, importRequest(FIXTURE.items));
  const segunda = await call(handler, importRequest(FIXTURE.items));

  assert.equal(segunda.body.created, 0);
  assert.equal(segunda.body.updated, 4);
  assert.equal(db.all("rentalOptions").length, 4);
});

test("duplicados dentro del mismo lote se reportan como skippedDuplicate", async () => {
  const { db, handler } = setup();
  const items = [FIXTURE.items[0], Object.assign({}, FIXTURE.items[0], { title: "Mismo anuncio, otro titulo" })];
  const res = await call(handler, importRequest(items));

  assert.equal(res.body.created, 1);
  assert.equal(res.body.skippedDuplicate, 1);
  assert.equal(db.all("rentalOptions").length, 1);
  const skipped = res.body.results.find((row) => row.outcome === "skippedDuplicate");
  assert.equal(skipped.duplicateOfIndex, 0);
  assert.ok(skipped.reason);
});

test("la clave de idempotencia evita duplicar tras un reintento por timeout", async () => {
  const { db, handler } = setup();
  const headers = { "X-Idempotency-Key": "lote-abc-123" };

  const primera = await call(handler, importRequest(FIXTURE.items, { headers }));
  const reintento = await call(handler, importRequest(FIXTURE.items, { headers }));

  assert.equal(primera.body.created, 4);
  assert.equal(reintento.body.idempotentReplay, true);
  assert.equal(reintento.body.created, 4, "el reintento repite el resultado original");
  assert.equal(db.all("rentalOptions").length, 4);
});

test("una URL invalida se rechaza fila por fila sin tumbar el lote", async () => {
  const { db, handler } = setup();
  const items = [
    FIXTURE.items[0],
    { title: "Casa sin URL real", zone: "Pasadena", rent: 5000000, listingUrl: "esto-no-es-una-url" },
    { title: "Casa apuntando al buscador", zone: "Andes", rent: 5000000, listingUrl: "https://metrocuadrado.com/buscar?q=casa" }
  ];
  const res = await call(handler, importRequest(items));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.created, 1);
  assert.equal(res.body.invalid, 2);
  assert.equal(db.all("rentalOptions").length, 1);

  const invalidos = res.body.results.filter((row) => row.outcome === "invalid");
  assert.equal(invalidos.length, 2);
  invalidos.forEach((row) => {
    assert.ok(row.errors.length > 0);
    assert.equal(row.errors[0].field, "listingUrl");
    assert.ok(row.errors[0].suggestion);
    assert.equal(typeof row.index, "number");
  });
});

test("clave vencida devuelve 403 legible y no guarda nada", async () => {
  const { db, handler } = setup();
  const res = await call(handler, importRequest(FIXTURE.items, { headers: { "X-Agent-Key": "clave-vencida" } }));

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "AUTH_EXPIRED");
  assert.equal(res.headers["access-control-allow-origin"], GITHUB_PAGES_ORIGIN);
  assert.equal(db.all("rentalOptions").length, 0);
});

test("clave revocada devuelve 403 y clave desconocida devuelve 401", async () => {
  const { handler } = setup();
  const revocada = await call(handler, importRequest(FIXTURE.items, { headers: { "X-Agent-Key": "clave-revocada" } }));
  const desconocida = await call(handler, importRequest(FIXTURE.items, { headers: { "X-Agent-Key": "clave-que-no-existe" } }));

  assert.equal(revocada.statusCode, 403);
  assert.equal(revocada.body.code, "AUTH_REVOKED");
  assert.equal(desconocida.statusCode, 401);
  assert.equal(desconocida.body.code, "AUTH_INVALID");
});

test("ninguna respuesta ni la auditoria filtran la clave en claro", async () => {
  const { db, handler } = setup();
  const res = await call(handler, importRequest(FIXTURE.items));

  assert.ok(!JSON.stringify(res.body).includes(VALID_KEY));
  assert.ok(!JSON.stringify(db.all("agentImportLogs")).includes(VALID_KEY));
  assert.ok(!JSON.stringify(db.all("rentalOptions")).includes(VALID_KEY));

  const errorRes = await call(handler, importRequest(FIXTURE.items, { headers: { "X-Agent-Key": "clave-vencida" } }));
  assert.ok(!JSON.stringify(errorRes.body).includes("clave-vencida"));
});

test("la auditoria registra el lote sin la clave", async () => {
  const { db, handler } = setup();
  await call(handler, importRequest(FIXTURE.items));

  const logs = db.all("agentImportLogs");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].createdCount, 4);
  assert.equal(logs[0].tokenId, "token1");
  assert.ok(logs[0].requestId);
  assert.equal(logs[0].tokenHash, undefined);
});

test("el limite de uso responde 429 con retryAfterSeconds", async () => {
  const { db, handler } = setup();
  db.seed("agentTokens", "token1", {
    tokenHash: sha256hex(VALID_KEY),
    revoked: false,
    expiresAt: new Date(Date.now() + 86400000),
    rateWindowStart: new Date(Date.now()),
    rateWindowCount: 40
  });

  const res = await call(handler, importRequest(FIXTURE.items));
  assert.equal(res.statusCode, 429);
  assert.equal(res.body.code, "RATE_LIMITED");
  assert.ok(res.body.retryAfterSeconds > 0);
  assert.equal(res.headers["access-control-allow-origin"], GITHUB_PAGES_ORIGIN);
});

test("un fallo del backend se reporta de forma legible y con CORS", async () => {
  const { db, handler } = setup();
  db.failCollection = "rentalOptions";

  const res = await call(handler, importRequest([FIXTURE.items[0]]));

  assert.equal(res.statusCode, 207);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.failed, 1);
  assert.equal(res.headers["access-control-allow-origin"], GITHUB_PAGES_ORIGIN);
  const fallido = res.body.results[0];
  assert.equal(fallido.outcome, "failed");
  assert.ok(fallido.reason.length > 0);
  assert.ok(res.body.requestId);
});

test("Firestore caido devuelve 503 legible en vez de un error opaco", async () => {
  const { db, handler } = setup();
  db.down = true;
  const res = await call(handler, importRequest(FIXTURE.items));
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.code, "STORAGE_UNAVAILABLE");
  assert.equal(res.headers["access-control-allow-origin"], GITHUB_PAGES_ORIGIN);
});

test("lote vacio o demasiado grande devuelve 400 explicativo", async () => {
  const { handler } = setup();
  const vacio = await call(handler, importRequest([]));
  assert.equal(vacio.statusCode, 400);
  assert.equal(vacio.body.code, "EMPTY_BATCH");

  const grande = await call(handler, importRequest(new Array(26).fill(FIXTURE.items[0])));
  assert.equal(grande.statusCode, 400);
  assert.equal(grande.body.code, "BATCH_TOO_LARGE");
  assert.match(grande.body.error, /25/);
});

test("Content-Type incorrecto devuelve 415 en vez de fallar en silencio", async () => {
  const { handler } = setup();
  const res = await call(handler, {
    method: "POST",
    path: "/",
    headers: { Origin: GITHUB_PAGES_ORIGIN, "Content-Type": "text/plain", "X-Agent-Key": VALID_KEY },
    body: { items: [] }
  });
  assert.equal(res.statusCode, 415);
  assert.equal(res.body.code, "UNSUPPORTED_MEDIA_TYPE");
});

test("Authorization: Bearer sigue funcionando por compatibilidad", async () => {
  const { handler } = setup();
  const res = await call(handler, {
    method: "POST",
    path: "/",
    headers: { Origin: GITHUB_PAGES_ORIGIN, "Content-Type": "application/json", Authorization: `Bearer ${VALID_KEY}` },
    body: { items: FIXTURE.items, dryRun: true }
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.created, 4);
});
