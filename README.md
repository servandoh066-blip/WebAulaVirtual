# WebAulaVirtual
Tareas del Aula Virtual (IES Teis): Moodle + avisos de correo del instituto en una sola pagina

## Panel lateral (diagramas circulares)
Los dos diagramas son **interactivos**: el anillo está centrado en una asignatura y el resto de slices se atenúan.

- **Tareas por asignatura**: reparto de las tareas pendientes de cada asignatura. Al pasar el ratón por un slice se ven sus datos en el centro; al pulsarlo queda fijo. Debajo, una fila de puntos indica en qué slice estás y se pueden arrastrar para cambiar de asignatura.
- **Notas de examen**: notas de examen (0-10) de cada asignatura, coloreadas por tramo (suspenso / aprobado / bien / notable) y con la media en el centro. Misma interacción que el diagrama de tareas.
  En el campo 📝 de la cabecera de cada asignatura se escriben **todas las notas de examen separadas por punto y coma** (por ejemplo `7,5; 8,2`); el diagrama representa la **media de esa asignatura** y el chip muestra la media y el número de exámenes. Se guarda en la nube con el resto de datos.

Bajo los diagramas no se listan las asignaturas: solo el slice y la fila de puntos (pequeña, arrastrable).

## Color por asignatura (clic derecho)
Con **clic derecho en el nombre de una asignatura** se abre una paleta con:

- 14 colores predefinidos + un selector de color personalizado.
- Un control de **transparencia** (0 %–80 %).
- Vista previa del color resultante y botón para **restablecer** el color automático.

El color elegido se aplica al slice de esa asignatura **en los dos diagramas** (en el de notas sustituye al color del tramo, que sigue indicándose en el centro y en el tooltip) y también al punto correspondiente. Se guarda en `DATA.subjectColors` (`{c: '#rrggbb', a: 0..1}`) y se valida en `api/data.js`.

Los datos de las notas viajan en `DATA.grades` como una **lista de notas por asignatura** y se validan en `api/data.js` (0-10, hasta 50 exámenes por asignatura).

## Despliegue (Netlify)

El sitio está desplegado en Netlify. La estructura es:

```
public/index.html          la aplicación (fichero único, sin build)
api/*.js                   la lógica del servidor (no se publica)
netlify/functions/*.mjs    las funciones de Netlify (envuelven api/*.js)
netlify/lib/adapter.js     adaptador Netlify <-> Vercel (req/res)
```

`netlify.toml` publica solo `public/`, así que el código del servidor nunca sale
a internet. Las funciones usan `export const config = { path: '/api/data' }` para
atender directamente en `/api/data`, `/api/tasks` y `/api/emails`.

### Variables de entorno

Se configuran en *Site configuration > Environment variables* (marcarlas como
**Secret**). Los nombres están en `.env.example`:

| Variable | Para |
|---|---|
| `AUTH_USER`, `AUTH_PASS` | autenticación básica de las tres funciones |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` | almacenamiento de los datos |
| `MOODLE_TOKEN` | web service de Moodle |
| `COMPOSIO_API_KEY`, `COMPOSIO_USER_ID` | correos de la Xunta vía Composio |
| `BLOB_READ_WRITE_TOKEN` | solo para la migración inicial desde el Blob de Vercel |

`AUTH_USER` tiene que coincidir con el usuario que pide el login en la
aplicación (`USERNAME` en `public/index.html`).

### Desarrollo local

```bash
npm test          # comprueba el adaptador y los handlers
npm i -g netlify-cli
netlify dev       # sirve el sitio y las funciones en local
```

La primera vez que se llama a `/api/data` con el almacenamiento vacío, la
función copia los datos antiguos del Blob de Vercel al almacenamiento nuevo
(por eso `BLOB_READ_WRITE_TOKEN` hace falta solo en el primer despliegue).
