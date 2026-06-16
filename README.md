# Musicala Arriendos

App web ligera para registrar, comparar y calificar opciones de arrendamiento para Musicala.

## Que hace

- Login con Google usando Firebase Authentication.
- Base de datos en Cloud Firestore.
- Acceso privado para Alek y Cata.
- Registro de opciones de arriendo con ubicacion, zona, canon, administracion, area, salones/espacios, cantidad de baños, contacto, link, estado, fecha de visita, pros, contras, riesgos, etiquetas y proxima accion.
- Calificacion independiente de Alek y Cata.
- Puntaje ponderado para comparar opciones.
- Filtros por busqueda, estado, presupuesto maximo, puntaje minimo y orden.
- Vista tipo tablero con KPIs.

## Archivos

```txt
musicala-arriendos-app/
|-- index.html
|-- agent-import.html
|-- agent-import.js
|-- styles.css
|-- app.js
|-- firebase.config.js
|-- firestore.rules
|-- functions/
|   |-- index.js
|   |-- package.json
|   `-- .gitignore
`-- README.md
```

## Configuracion rapida

1. El proyecto ya apunta a Firebase `arriendos-musicala` desde `firebase.config.js`.
2. En Firebase, activa Authentication > Sign-in method > Google.
3. Activa Firestore Database.
4. Revisa los correos permitidos en:
   - `app.js`
   - `firestore.rules`
5. Sube `firestore.rules` desde la consola de Firebase o con Firebase CLI.
6. Abre `index.html` con Live Server o subelo a GitHub Pages.

## Correos incluidos por defecto

- Alek: `alekcaballeromusic@gmail.com`
- Cata: `catalina.medina.leal@gmail.com`

Si Cata usa otro correo para Google, cambialo en `app.js` y `firestore.rules`.

## Nota importante

El filtro visual de roles en el frontend ayuda a la experiencia, pero la seguridad real esta en `firestore.rules`. No confies solo en el HTML para proteger datos privados.

## Modo Agente seguro

El Modo Agente permite que una IA (ChatGPT Agent, Claude, etc.) cargue opciones de arriendo encontradas en internet sin iniciar sesion con Google. La IA entra a `agent-import.html`, pega una clave temporal y pega un JSON con una o varias opciones. El frontend solo envia esos datos a la Cloud Function `agentImportRentalOptions`.

### Generar la clave desde la app (sin terminal)

Ya no necesitas Firebase CLI para crear claves en el dia a dia. Alek o Cata, despues de iniciar sesion con Google, presionan el boton **"Modo Agente / IA"** en el tablero:

1. (Opcional) ponen un nombre a la clave (ej. "Busqueda junio").
2. Presionan **"Generar clave para IA"**. La app crea una clave temporal valida 7 dias.
3. La clave en claro se muestra **una sola vez** (estilo GitHub/Stripe). El prompt completo, con endpoint y clave ya incluidos, se copia automaticamente al portapapeles.
4. Pegan ese prompt en la IA y listo.
5. Pueden **revocar** cualquier clave activa desde la misma ventana.

En Firestore, la clave nunca se guarda en claro: solo su hash SHA-256 (no reversible) en la coleccion `agentTokens`, junto con su caducidad, estado y contador de usos. La Cloud Function valida la clave recibida calculando su hash y comparandolo, y rechaza claves vencidas o revocadas. La funcion usa Firebase Admin SDK para crear o actualizar documentos en `rentalOptions`, por eso no se abre acceso publico en `firestore.rules`.

La funcion:

- acepta `Authorization: Bearer <clave>`, `X-Agent-Key: <clave>` o `agentKey` en el body;
- limita cada request a 25 opciones, pero `agent-import.html` divide automaticamente JSON grandes en lotes;
- normaliza numeros, estados, etiquetas y riesgos;
- crea o actualiza opciones, pero no borra registros;
- deduplica por `listingUrl` / `sourceUrl` o por `duplicateKey`;
- registra auditoria en `agentImportLogs`;
- nunca guarda la clave en Firestore, logs, consola ni respuestas JSON.

La pagina `agent-import.html` acepta:

- `{ "items": [...] }`
- `{ "item": {...} }`
- `[{...}, {...}]`
- bloques markdown con etiqueta `json`;
- texto con explicacion antes o despues del primer JSON valido.

Tambien muestra vista previa con total detectado, lotes, datos incompletos, opciones sin baños, opciones sin parqueadero, sin precio, sin URL y posibles duplicados locales.

### Despliegue inicial (una sola vez)

Ya no se usa el secreto `AGENT_IMPORT_SECRET`. Las claves se crean desde la app. Lo unico que se hace por terminal, y solo una vez, es desplegar la funcion y las reglas:

```bash
cd functions
npm install
cd ..
firebase deploy --only functions,firestore:rules --project arriendos-musicala
```

Despues de esto, todas las claves se generan y revocan desde el boton "Modo Agente / IA" del tablero, sin volver a tocar la terminal.

### Desplegar Functions

La funcion esta en `functions/index.js` y usa Node.js 20. Desde la raiz del proyecto:

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

Cuando Firebase entregue la URL final, pegala en el campo "URL de Cloud Function" de `agent-import.html`. Si vas a usar GitHub Pages, agrega tu origen en la constante `ALLOWED_ORIGINS` de `functions/index.js`, por ejemplo:

```js
"https://TU_USUARIO.github.io"
```

Despues vuelve a desplegar:

```bash
firebase deploy --only functions
```

Con `npx`, si no tienes Firebase CLI instalado globalmente:

```bash
npx firebase-tools deploy --only functions,firestore:rules --project arriendos-musicala
```

### Probar localmente

Desde la raiz del proyecto:

```bash
python -m http.server 4173 --bind 127.0.0.1
```

Luego abre:

```txt
http://127.0.0.1:4173/agent-import.html
```

Prueba pegando un JSON con mas de 25 opciones. La vista previa debe mostrar 2 o mas lotes y el boton principal debe decir "Importar todo".

Para validar sin guardar, activa la casilla "Solo validar, no guardar". Eso envia `dryRun: true` a la Cloud Function.

### Desplegar en GitHub Pages

Este proyecto ya esta pensado para publicarse como sitio estatico. Sube estos archivos al repo de GitHub Pages:

- `index.html`
- `agent-import.html`
- `agent-import.js`
- `styles.css`
- `app.js`
- `firebase.config.js`
- `logo.png`

La URL publica esperada es:

```txt
https://musicala.github.io/arriendosmusicala/
```

La Cloud Function ya permite CORS desde:

```txt
https://musicala.github.io
```

Si cambias de dominio, agrega el nuevo origen en `ALLOWED_ORIGINS` dentro de `functions/index.js` y vuelve a desplegar Functions.

### Revisar logs de la Cloud Function

Con Firebase CLI:

```bash
npx firebase-tools functions:log --only agentImportRentalOptions --project arriendos-musicala
```

En Google Cloud Console:

1. Entra a `https://console.cloud.google.com/`.
2. Selecciona el proyecto `arriendos-musicala`.
3. Ve a Cloud Functions.
4. Abre `agentImportRentalOptions`.
5. Revisa la pestana Logs.

### Probar con curl

```bash
curl -X POST "URL_DE_LA_FUNCTION" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer TU_CLAVE_TEMPORAL" \
  -d '{
    "items": [
      {
        "title": "Casa de prueba para Musicala",
        "zone": "Galerias",
        "rent": 5000000,
        "rooms": 8,
        "bathrooms": 4,
        "listingUrl": "https://ejemplo.com/arriendo-1",
        "pros": "Amplia y bien ubicada",
        "cons": "Uso de suelo por verificar",
        "tags": ["prueba", "agente"]
      }
    ]
  }'
```

### Usarlo con ChatGPT Agent

Puedes pedirle al agente algo como:

```txt
Entra a agent-import.html, usa esta clave temporal y carga estas opciones de arriendo que encuentres para Musicala.
```

El agente debe pegar la clave en el campo password, pegar el JSON en el textarea y presionar "Importar opciones". La clave se mantiene solo en memoria durante el envio: no se guarda en `localStorage`, `sessionStorage` ni cookies.
