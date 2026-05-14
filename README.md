# Musicala Arriendos

App web ligera para registrar, comparar y calificar opciones de arrendamiento para Musicala.

## Qué hace

- Login con Google usando Firebase Authentication.
- Base de datos en Cloud Firestore.
- Acceso privado para Alek y Cata.
- Registro de opciones de arriendo con:
  - ubicación, zona, canon, administración, área, contacto, link, estado, fecha de visita;
  - pros, contras, riesgos, etiquetas y próxima acción;
  - calificación independiente de Alek y Cata;
  - puntaje ponderado para comparar opciones.
- Filtros por búsqueda, estado, presupuesto máximo, puntaje mínimo y orden.
- Vista tipo tablero con KPIs.

## Archivos

```txt
musicala-arriendos-app/
├── index.html
├── styles.css
├── app.js
├── firebase.config.js
├── firestore.rules
└── README.md
```

## Configuración rápida

1. El proyecto ya apunta a Firebase `arriendos-musicala` desde `firebase.config.js`.
2. En Firebase, activa Authentication > Sign-in method > Google.
3. Activa Firestore Database.
4. Revisa los correos permitidos en:
   - `app.js`
   - `firestore.rules`
5. Sube `firestore.rules` desde la consola de Firebase o con Firebase CLI.
6. Abre `index.html` con Live Server o súbelo a GitHub Pages.

## Correos incluidos por defecto

- Alek: `alekcaballeromusic@gmail.com`
- Cata: `catalina.medina.leal@gmail.com`

Si Cata usa otro correo para Google, cámbialo en `app.js` y `firestore.rules`.

## Nota importante

El filtro visual de roles en el frontend ayuda a la experiencia, pero la seguridad real está en `firestore.rules`. Sí, el internet es una selva con WiFi, no se confíen solo del HTML.
