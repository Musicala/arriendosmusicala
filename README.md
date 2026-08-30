# Arriendos Musicala

Tablero privado para comparar opciones de arriendo de la sede de Musicala, con
un flujo de **importación por agente** que permite que una persona —o una IA con
navegador— investigue inmuebles, pegue un JSON y lo guarde de forma verificable.

---

## 1. Arquitectura

```
Navegador (GitHub Pages)                 Google Cloud
┌──────────────────────────┐            ┌─────────────────────────────────┐
│ index.html   (tablero)   │  Firebase  │ Firestore                       │
│ app.js                   │◄──SDK────► │  · rentalOptions                │
│                          │            │  · agentTokens (solo hash)      │
│ agent-import.html        │            │  · agentImportLogs (auditoría)  │
│ agent-import.js          │            │  · agentImportBatches (idemp.)  │
│   · valida en pantalla   │            └─────────────────────────────────┘
│   · clave solo en memoria│                        ▲
└──────────┬───────────────┘                        │ Admin SDK
           │ POST /  ·  GET /health                 │
           │ X-Agent-Key, X-Idempotency-Key         │
           ▼                                        │
   Cloud Function v2 `agentImportRentalOptions` ────┘
     functions/index.js      → wiring con firebase-admin
     functions/lib/cors.js   → CORS en TODAS las respuestas
     functions/lib/auth.js   → clave temporal, expiración, rate limit
     functions/lib/normalize.js → normalización sin inventar datos
     functions/lib/schema.js → validación estricta por fila
     functions/lib/handler.js → router /health + importación
```

El acceso al tablero está restringido por `firestore.rules` a dos cuentas de
Google. El importador no usa esas credenciales: usa una **clave temporal** que
el equipo genera desde el tablero (Modo Agente) y que caduca en 7 días.

---

## 2. Endpoint correcto

| Uso | URL |
| --- | --- |
| **Importar (producción)** | `https://us-central1-arriendos-musicala.cloudfunctions.net/agentImportRentalOptions` |
| Diagnóstico | `.../agentImportRentalOptions/health` |
| Alias Cloud Run (equivalente) | `https://agentimportrentaloptions-<hash>-uc.a.run.app` |

Se usa por defecto la URL de `cloudfunctions.net` porque es **estable entre
despliegues**; la URL `run.app` incluye un hash que puede cambiar y fue una de
las razones por las que la configuración anterior quedó apuntando a un destino
inservible.

### Contrato HTTP

```
GET  /health                     → estado, versión, fecha, origen permitido
OPTIONS  /                       → preflight CORS (siempre 204)
POST /                           → importar / validar
     Content-Type: application/json
     X-Agent-Key: <clave temporal>          (recomendado)
     Authorization: Bearer <clave>          (compatibilidad)
     X-Idempotency-Key: <id único por lote> (opcional pero recomendado)
     Body: { "items": [...], "dryRun": true|false }
```

Respuesta:

```json
{
  "ok": true,
  "requestId": "req_...",
  "mode": "validated_not_saved" | "saved",
  "totalReceived": 4,
  "created": 4, "updated": 0, "skippedDuplicate": 0, "invalid": 0, "failed": 0,
  "warnings": [], "errors": [{"index":1,"field":"listingUrl","cause":"...","suggestion":"..."}],
  "results": [{"index":0,"outcome":"created","id":"..."}]
}
```

Códigos: `200` ok · `207` guardado parcial · `400` lote inválido ·
`401` clave ausente/desconocida · `403` vencida/revocada · `413` payload grande ·
`415` Content-Type · `429` límite de uso · `500`/`503` error del backend.
**Todas** las respuestas, incluidas las de error, llevan cabeceras CORS.

### Orígenes permitidos

- `https://musicala.github.io`
- `http://localhost:*` y `http://127.0.0.1:*` (cualquier puerto)
- `https://*.github.io`, `https://arriendos-musicala*.web.app`, `*.firebaseapp.com`

---

## 3. Contrato del JSON de importación

Campos obligatorios: `title`, `zone`, `listingUrl`.
Campos numéricos (0 si no se conocen): `rent`, `administration`,
`servicesEstimate`, `setupEstimate`, `area`, `rooms`, `bathrooms`, `parking`.
Se aceptan `"6.500.000"` o `"$ 6.500.000"` y se normalizan a `6500000`.

- `status`: `nueva`, `por_contactar`, `agendada`, `visitada`, `favorita`, `descartada`.
- `agentConfidence`: `alta`, `media`, `baja`.
- `tags` y `risks`: array de strings (o string separada por comas).
- `listingUrl` debe apuntar **al anuncio individual**. Una portada
  (`https://portal.com`) o un buscador (`...?q=casa`) se rechaza con
  explicación y sugerencia.
- **Nunca se inventan datos**: lo que falta queda en `""` o `0`.

Ejemplo listo para usar: [`fixtures/ejemplo-4-inmuebles.json`](fixtures/ejemplo-4-inmuebles.json)
(4 inmuebles, sin información sensible).

### Duplicados e idempotencia

- La identidad de un anuncio es su `listingUrl` **normalizada** (sin `www.`,
  sin `utm_*`, sin `#`, sin barra final, siempre `https`). Sin URL, se usa
  `title|zone|rent`.
- Reimportar el mismo JSON **actualiza**, no duplica.
- Dos filas del mismo lote que apuntan al mismo anuncio → `skippedDuplicate`.
- `X-Idempotency-Key` guarda el resultado del lote: un reintento por timeout
  devuelve el resultado original (`idempotentReplay: true`) en vez de reescribir.

---

## 4. Despliegue

### Backend (obligatorio para que el importador funcione)

```bash
cd functions
npm install
cd ..
firebase deploy --only functions,firestore:rules
```

> **Paso crítico.** La función debe aceptar invocaciones sin autenticación de
> IAM. `functions/index.js` ya declara `invoker: "public"`, pero si el proyecto
> tiene una política de organización que lo bloquea, hay que concederlo a mano:
>
> ```bash
> gcloud run services add-iam-policy-binding agentimportrentaloptions \
>   --region=us-central1 \
>   --member=allUsers \
>   --role=roles/run.invoker
> ```
>
> Sin esto, Google responde **403 al preflight `OPTIONS` sin cabeceras CORS** y
> el navegador solo puede reportar `Failed to fetch` sin status. Es exactamente
> el fallo que motivó esta versión.

Verificación después de desplegar:

```bash
# 1. ¿Responde y está sano?
curl -s https://us-central1-arriendos-musicala.cloudfunctions.net/agentImportRentalOptions/health | jq

# 2. ¿El preflight desde GitHub Pages devuelve CORS? Debe verse
#    access-control-allow-origin: https://musicala.github.io
curl -i -X OPTIONS \
  https://us-central1-arriendos-musicala.cloudfunctions.net/agentImportRentalOptions \
  -H "Origin: https://musicala.github.io" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: content-type,x-agent-key"
```

### Frontend

El frontend es estático. GitHub Pages publica la rama configurada del
repositorio en `https://musicala.github.io/arriendosmusicala/`. No hay build:
`git push` a la rama publicada es el despliegue.

---

## 5. Claves temporales

**Generar:** entra al tablero con una cuenta autorizada → *Modo Agente / IA* →
*Generar clave para IA*. La clave en claro se muestra **una sola vez** y el
prompt completo (con endpoint y clave) se copia al portapapeles.

**Revocar:** en el mismo diálogo, botón *Revocar* junto a la clave.

Garantías de seguridad:

- En Firestore solo se guarda `sha256(clave)`, nunca la clave.
- En el importador la clave vive **solo en una variable en memoria**: no se
  escribe en `localStorage`, ni en la URL, ni en el JSON normalizado, ni en el
  reporte de diagnóstico, ni en `console`. Se borra al recargar, al salir, con
  el botón *Borrar clave ahora* y tras 15 minutos de inactividad.
- Ningún mensaje de error muestra la clave, ni siquiera parcialmente.
- El backend valida vencimiento, revocación y alcance, y aplica un límite de
  40 peticiones cada 5 minutos por clave.
- La auditoría (`agentImportLogs`) registra fecha, `requestId`, id y etiqueta de
  la clave, conteos y duración — nunca la clave.

---

## 6. Cómo probar el flujo

### Local, sin Firebase

```bash
npm install
npm run dev
# Frontend:  http://127.0.0.1:4173/agent-import.html
# Endpoint:  http://127.0.0.1:4174
# Clave demo: clave-demo-local-no-sensible
```

Levanta el frontend real y la misma Cloud Function sobre un Firestore en
memoria, en **puertos distintos**, de modo que el CORS se ejerce de verdad.

### Pruebas automáticas

```bash
npm test              # todo
npm run test:backend  # 40 pruebas: unitarias + integración
npm run test:e2e      # 4 pruebas en Chromium real
```

Cubren: normalización de números/URLs, esquema por fila, duplicados,
autenticación (válida, vencida, revocada, ausente), CORS y `OPTIONS`, `/health`,
validación sin guardar, guardado de 4 inmuebles, URL inválida, reintento e
idempotencia, límite de uso, error del backend y no filtración de la clave.

### Manual desde la página publicada

1. Abre `https://musicala.github.io/arriendosmusicala/agent-import.html`.
2. Paso 1 → *Probar conexión*. Debe decir **Conectado** y *Origen permitido: Sí*.
3. Paso 2 → pega la clave temporal.
4. Paso 3 → pega el JSON (o *Cargar ejemplo*).
5. Paso 4 → revisa la tabla inmueble por inmueble.
6. *Solo validar, no guardar* → aparece un panel **ámbar**: “Validado · NO guardado”.
7. *Guardar en el tablero* → panel **verde**: “Guardado en el tablero”, con
   creadas / actualizadas / duplicadas / inválidas / fallidas y los `requestId`.
8. *Ver los registros en el tablero* para confirmarlos en `index.html`.

---

## 7. Diagnóstico de errores

El importador **no** dice “Failed to fetch” y se calla. Distingue:

| Situación | Qué muestra |
| --- | --- |
| Host inalcanzable | `DNS_OR_NETWORK` — “No se pudo alcanzar el host”, con `Host alcanzable: No` |
| Servidor vivo pero navegador bloquea | `CORS_OR_IAM` — incluye el comando `gcloud ... add-iam-policy-binding` |
| Sin respuesta a tiempo | `TIMEOUT` (45 s) |
| 401 / 403 | Clave ausente, desconocida, vencida o revocada |
| 404 / 405 | URL o método equivocados |
| 429 | Límite de uso, con segundos de espera |
| 5xx | Error del backend, con `requestId` para buscar en los logs |

Para saber si es CORS o red, la página hace un sondeo `mode: "no-cors"` contra
el host: si la conexión abre, el host existe y el problema es CORS/IAM.

**Reporte de diagnóstico:** botón *Copiar reporte de diagnóstico* al final de la
página. Incluye endpoint, hora, navegador, origen, estado HTTP, `requestId`,
respuesta del servidor y el historial de intentos. **Nunca incluye la clave.**

Logs del backend:

```bash
firebase functions:log --only agentImportRentalOptions
```

Cada respuesta trae un `requestId` (también en la cabecera `X-Request-Id`) que
aparece en los logs y en la colección `agentImportLogs`.

---

## 8. Estructura del repositorio

```
index.html / app.js          Tablero privado
agent-import.html / .js      Importador por agente
styles.css                   Estilos (paleta formal: azul pizarra + grafito)
firebase.config.js           Configuración del cliente Firebase
firestore.rules              Reglas de acceso
functions/
  index.js                   Cloud Function (wiring)
  lib/                       cors · auth · normalize · schema · handler
  test/                      40 pruebas (unitarias + integración)
test/
  dev-server.js              Servidor local: frontend + API en otro origen
  e2e.test.js                Pruebas en Chromium real
fixtures/
  ejemplo-4-inmuebles.json   Ejemplo sin datos sensibles
AGENT_PROMPT.md              Prompt base para la IA investigadora
```
