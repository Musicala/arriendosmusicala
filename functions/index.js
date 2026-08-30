"use strict";

const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");

const { createHandler } = require("./lib/handler");

admin.initializeApp();

const db = admin.firestore();

const handler = createHandler({
  db,
  fieldValue: {
    serverTimestamp: () => admin.firestore.FieldValue.serverTimestamp(),
    increment: (value) => admin.firestore.FieldValue.increment(value)
  }
});

/**
 * Endpoint publico de importacion por agente.
 *
 * IMPORTANTE PARA EL DESPLIEGUE: esta funcion debe permitir invocaciones sin
 * autenticacion de IAM (invoker: "public"). Si el servicio de Cloud Run exige
 * IAM, Google responde 403 al preflight OPTIONS sin cabeceras CORS y el
 * navegador solo puede reportar "Failed to fetch" sin status. La autorizacion
 * real la hace la clave temporal (X-Agent-Key) dentro del codigo.
 */
exports.agentImportRentalOptions = onRequest(
  {
    region: "us-central1",
    maxInstances: 10,
    invoker: "public",
    cors: false,
    timeoutSeconds: 120,
    memory: "256MiB"
  },
  handler
);
