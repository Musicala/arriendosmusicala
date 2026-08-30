"use strict";

/**
 * Servidor de desarrollo y pruebas.
 * - Sirve los archivos estáticos del proyecto (el frontend real, sin cambios).
 * - Monta la MISMA Cloud Function (functions/lib/handler.js) sobre un Firestore
 *   en memoria, en un puerto DISTINTO, para que el navegador haga una petición
 *   cross-origin real y el CORS se ejerza de verdad.
 *
 * Uso: node test/dev-server.js [puertoWeb] [puertoApi]
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const { createHandler } = require("../functions/lib/handler");
const { sha256hex } = require("../functions/lib/auth");
const { FirestoreStub, fieldValue } = require("../functions/test/firestore-stub");

const ROOT = path.join(__dirname, "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

const DEMO_KEY = process.env.DEMO_AGENT_KEY || "clave-demo-local-no-sensible";

function createApi() {
  const db = new FirestoreStub();
  db.seed("agentTokens", "tokenDemo", {
    tokenHash: sha256hex(DEMO_KEY),
    label: "Clave demo local",
    revoked: false,
    expiresAt: new Date(Date.now() + 7 * 86400000),
    useCount: 0
  });
  db.seed("agentTokens", "tokenVencido", {
    tokenHash: sha256hex("clave-vencida"),
    label: "Vencida",
    revoked: false,
    expiresAt: new Date(Date.now() - 86400000)
  });

  const handler = createHandler({ db, fieldValue });

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const rawBody = Buffer.concat(chunks);
      let body;
      try {
        body = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : undefined;
      } catch (error) {
        body = undefined;
      }

      const expressish = {
        method: req.method,
        path: new URL(req.url, "http://x").pathname,
        url: req.url,
        headers: req.headers,
        body,
        rawBody,
        get: (name) => req.headers[String(name).toLowerCase()] || ""
      };

      const shim = {
        _status: 200,
        set(key, value) {
          res.setHeader(key, value);
          return this;
        },
        status(code) {
          this._status = code;
          return this;
        },
        json(payload) {
          res.writeHead(this._status, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(payload));
          return this;
        },
        send(payload) {
          res.writeHead(this._status);
          res.end(payload || "");
          return this;
        }
      };

      await handler(expressish, shim);
    });
  });

  return { server, db };
}

function createWeb() {
  return http.createServer((req, res) => {
    const requested = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const filePath = path.join(ROOT, requested === "/" ? "index.html" : requested);

    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("no encontrado");
      return;
    }

    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function start(webPort = 4173, apiPort = 4174) {
  const { server: api, db } = createApi();
  const web = createWeb();
  await new Promise((resolve) => api.listen(apiPort, "127.0.0.1", resolve));
  await new Promise((resolve) => web.listen(webPort, "127.0.0.1", resolve));
  return {
    db,
    webUrl: `http://127.0.0.1:${webPort}`,
    apiUrl: `http://127.0.0.1:${apiPort}`,
    demoKey: DEMO_KEY,
    async stop() {
      await new Promise((resolve) => api.close(resolve));
      await new Promise((resolve) => web.close(resolve));
    }
  };
}

module.exports = { start, DEMO_KEY };

if (require.main === module) {
  start(Number(process.argv[2]) || 4173, Number(process.argv[3]) || 4174).then((info) => {
    console.log(`Frontend:  ${info.webUrl}/agent-import.html`);
    console.log(`Endpoint:  ${info.apiUrl}`);
    console.log(`Clave demo: ${info.demoKey}`);
  });
}
