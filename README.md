# Musicala Arriendos

App web ligera para registrar, comparar y calificar opciones de arrendamiento para Musicala.

## Que hace

- Login con Google usando Firebase Authentication.
- Base de datos en Cloud Firestore.
- Acceso privado para Alek y Cata.
- Registro de opciones de arriendo con ubicacion, zona, canon, administracion, area, contacto, link, estado, fecha de visita, pros, contras, riesgos, etiquetas y proxima accion.
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

El Modo Agente permite que ChatGPT Agent cargue opciones de arriendo encontradas en internet sin iniciar sesion con Google. El agente entra a `agent-import.html`, pega una clave temporal y pega un JSON con una o varias opciones. El frontend solo envia esos datos a la Cloud Function `agentImportRentalOptions`.

La clave no esta en `app.js`, `index.html`, `agent-import.html`, `agent-import.js`, `firebase.config.js` ni en ningun archivo publico. La validacion real ocurre en Firebase Cloud Functions v2 contra el secreto `AGENT_IMPORT_SECRET` guardado en Firebase Secret Manager. La funcion usa Firebase Admin SDK para crear o actualizar documentos en `rentalOptions`, por eso no se abre acceso publico en `firestore.rules`.

La funcion:

- acepta `Authorization: Bearer <clave>`, `X-Agent-Key: <clave>` o `agentKey` en el body;
- limita cada request a 25 opciones;
- normaliza numeros, estados, etiquetas y riesgos;
- crea o actualiza opciones, pero no borra registros;
- deduplica por `listingUrl` / `sourceUrl` o por `duplicateKey`;
- registra auditoria en `agentImportLogs`;
- nunca guarda la clave en Firestore, logs, consola ni respuestas JSON.

### Crear la clave segura

Instala y autentica Firebase CLI si hace falta. Luego ejecuta:

```bash
firebase login
firebase init functions
firebase functions:secrets:set AGENT_IMPORT_SECRET
firebase deploy --only functions
```

Al ejecutar:

```bash
firebase functions:secrets:set AGENT_IMPORT_SECRET
```

Firebase pedira escribir la clave en consola. Esa clave NO debe subirse al repo. Esa clave sera la que podras darle a ChatGPT Agent cuando quieras que cargue opciones.

Si usas emulador local y necesitas un archivo `.env.local` o `.secret.local`, puedes crearlo dentro de `functions/`, pero no se sube a GitHub. Ya existe `functions/.gitignore` para evitar subir `node_modules`, `.env`, `.secret.local` y archivos sensibles.

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
