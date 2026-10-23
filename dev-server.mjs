// Servidor de desarrollo para localhost.
//
// Sirve `public/` como sitio estatico y enruta /api/* a las mismas funciones
// que se despliegan en Netlify (netlify/functions/*.mjs), pasando por el mismo
// adaptador. Asi lo que se ve en local es lo que se ve en produccion.
//
// Uso:  node dev-server.mjs        (o: npm run dev)
// Puerto: http://127.0.0.1:8888

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const PUBLICO = path.join(RAIZ, 'public');
const FUNCIONES = path.join(RAIZ, 'netlify', 'functions');
const PUERTO = Number(process.env.PORT || 8888);

// ---------- .env ----------
// Parser minimo: LINEA=valor, admite comentarios y comillas simples/dobles.
async function cargarEnv() {
  let texto;
  try {
    texto = await readFile(path.join(RAIZ, '.env'), 'utf8');
  } catch (e) {
    return;
  }
  texto.split(/\r?\n/).forEach(function (linea) {
    const limpia = linea.trim();
    if (!limpia || limpia.startsWith('#')) return;
    const i = limpia.indexOf('=');
    if (i < 1) return;
    const clave = limpia.slice(0, i).trim();
    let valor = limpia.slice(i + 1).trim();
    if (
      (valor.startsWith('"') && valor.endsWith('"')) ||
      (valor.startsWith("'") && valor.endsWith("'"))
    ) {
      valor = valor.slice(1, -1);
    }
    if (!(clave in process.env)) process.env[clave] = valor;
  });
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function cabeceras(cabecerasNode) {
  const salida = {};
  for (const [clave, valor] of Object.entries(cabecerasNode)) {
    salida[clave] = Array.isArray(valor) ? valor.join(', ') : String(valor);
  }
  return salida;
}

async function leerCuerpo(req) {
  const trozos = [];
  for await (const trozo of req) trozos.push(trozo);
  return trozos.length ? Buffer.concat(trozos) : undefined;
}

// ---------- /api/* ----------
const cacheFunciones = new Map();

async function cargarFuncion(nombre) {
  if (!/^[a-z0-9-]+$/i.test(nombre)) return null;
  if (!cacheFunciones.has(nombre)) {
    const ruta = path.join(FUNCIONES, nombre + '.mjs');
    try {
      await stat(ruta);
    } catch (e) {
      return null;
    }
    cacheFunciones.set(nombre, import(rutaToUrl(ruta)));
  }
  return cacheFunciones.get(nombre);
}

function rutaToUrl(ruta) {
  return new URL('file:///' + ruta.replace(/\\/g, '/')).href;
}

async function atenderApi(req, res, nombre, url) {
  const cuerpo = req.method === 'GET' || req.method === 'HEAD' ? undefined : await leerCuerpo(req);
  const peticion = new Request(url, {
    method: req.method,
    headers: cabeceras(req.headers),
    body: cuerpo
  });

  // Modo demo: sin MOODLE_TOKEN la funcion real devuelve 500 y la pantalla de
  // acceso nunca se cierra. Solo en local se responde con una lista vacia para
  // poder ver y probar la interfaz.
  if (nombre === 'tasks' && !process.env.MOODLE_TOKEN && process.env.DEV_DEMO_TAREAS !== '0') {
    console.log('  [demo] /api/tasks -> lista vacia (falta MOODLE_TOKEN)');
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ tasks: [], teachers: {} }));
    return;
  }

  const modulo = await cargarFuncion(nombre);
  if (!modulo || typeof modulo.default !== 'function') {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'Funcion no encontrada: ' + nombre }));
    return;
  }

  const respuesta = await modulo.default(peticion);
  const texto = await respuesta.text();
  res.statusCode = respuesta.status;
  respuesta.headers.forEach(function (valor, clave) {
    if (clave.toLowerCase() === 'content-encoding') return;
    res.setHeader(clave, valor);
  });
  res.end(texto);
}

// ---------- estaticos ----------
async function atenderEstatico(req, res, url) {
  let ruta = decodeURIComponent(url.pathname);
  if (ruta === '/' || ruta === '') ruta = '/index.html';

  const destino = path.join(PUBLICO, path.normalize(ruta).replace(/^([/\\])+/, ''));
  if (!destino.startsWith(PUBLICO)) {
    res.statusCode = 403;
    res.end('403');
    return;
  }

  let contenido;
  try {
    contenido = await readFile(destino);
  } catch (e) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('404 ' + ruta);
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', TIPOS[path.extname(destino).toLowerCase()] || 'application/octet-stream');
  if (destino.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  res.end(contenido);
}

await cargarEnv();

// Backend de datos local: un unico fichero JSON junto al proyecto.
if (!process.env.LOCAL_DATA_FILE) {
  process.env.LOCAL_DATA_FILE = path.join(RAIZ, '.localdata.json');
}

const servidor = http.createServer(async function (req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || '127.0.0.1:' + PUERTO));
  const marca = new Date().toISOString().slice(11, 19);
  try {
    if (url.pathname.startsWith('/api/')) {
      const nombre = url.pathname.slice(5).replace(/\/$/, '');
      console.log(marca + ' ' + req.method + ' ' + url.pathname);
      await atenderApi(req, res, nombre, url);
      return;
    }
    await atenderEstatico(req, res, url);
  } catch (err) {
    console.error(marca + ' ERROR ' + url.pathname + ': ' + (err && err.stack ? err.stack : err));
    if (!res.headersSent) res.statusCode = 500;
    res.end('500 ' + String((err && err.message) || err));
  }
});

servidor.listen(PUERTO, '127.0.0.1', function () {
  console.log('');
  console.log('  Aula Virtual - servidor local');
  console.log('  http://127.0.0.1:' + PUERTO);
  console.log('  datos: ' + process.env.LOCAL_DATA_FILE);
  console.log('  usuario: ' + (process.env.AUTH_USER || '(sin AUTH_USER)'));
  console.log('  moodle: ' + (process.env.MOODLE_TOKEN ? 'token configurado' : 'sin token -> /api/tasks en modo demo'));
  console.log('');
});
