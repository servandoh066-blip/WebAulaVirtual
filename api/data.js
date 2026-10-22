const KEY = 'userdata.json';
const MAX_BODY = 400000;
const EMPTY = { tasks: [], notes: {}, global: '', skip: [], colors: {}, hide: [], sort: '', pos: {}, gord: {}, showdone: false, exams: {}, subjectColors: {} };
const COLOR_RE = /^k-(red|orange|yellow|green|blue|purple|pink|gray)$/;
const SORT_MODES = ['date', 'date-desc', 'title'];

function unauthorized(res) {
  // Sin cabecera 'WWW-Authenticate' a propósito: si el 401 lleva un reto
  // "Basic", Chrome y Edge abren su diálogo nativo de usuario/contraseña
  // encima de la app, el usuario no puede cerrarlo y nunca llega a ver el
  // mensaje de error de la pantalla de acceso. La app detecta el 401 por
  // el código de estado, así que el reto no hace falta.
  res.statusCode = 401;
  res.end('401 Unauthorized');
}

function checkAuth(req) {
  const user = process.env.AUTH_USER;
  const pass = process.env.AUTH_PASS;
  if (!user || !pass) return false;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch (e) {
    return false;
  }
  const idx = decoded.indexOf(':');
  if (idx < 0) return false;
  return decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass;
}

function str(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).slice(0, max);
}

function sanitize(input) {
  const out = { tasks: [], notes: {}, global: '', skip: [], colors: {}, hide: [], sort: '', pos: {}, gord: {}, showdone: false, exams: {}, subjectColors: {} };
  if (!input || typeof input !== 'object') return out;
  if (Array.isArray(input.tasks)) {
    input.tasks.slice(0, 300).forEach(function (t, i) {
      if (!t || typeof t !== 'object') return;
      const title = str(t.t, 300);
      if (!title) return;
      out.tasks.push({
        id: str(t.id, 40) || 'c' + i,
        s: str(t.s, 250),
        t: title,
        d: t.d ? str(t.d, 40) : null
      });
    });
  }
  if (input.notes && typeof input.notes === 'object' && !Array.isArray(input.notes)) {
    Object.keys(input.notes).slice(0, 100).forEach(function (k) {
      const key = str(k, 250);
      if (!key) return;
      out.notes[key] = str(input.notes[k], 8000);
    });
  }
  // Exámenes: { asignatura: [{t: nombre, n: nota}] } (varias notas por asignatura).
  // Acepta el formato antiguo `grades: { asignatura: [nota, ...] }` y lo migra.
  const examOf = function (k) {
    let list = input.exams ? input.exams[k] : null;
    if (typeof list === 'number' || typeof list === 'string') list = [{ n: list }];
    if (!Array.isArray(list)) list = [];
    if (!list.length) {
      let old = input.grades && typeof input.grades === 'object' ? input.grades[k] : null;
      if (typeof old === 'number' || typeof old === 'string') old = [old];
      list = Array.isArray(old) ? old.map(function (n) { return { n: n }; }) : [];
    }
    const exams = [];
    list.slice(0, 50).forEach(function (e) {
      if (typeof e === 'number' || typeof e === 'string') e = { n: e };
      if (!e || typeof e !== 'object') return;
      let v = e.n;
      if (typeof v === 'string') {
        v = v.trim().replace(',', '.');
        if (!v) v = 0;
      }
      if (typeof v === 'boolean' || v === null || v === undefined) v = 0;
      const n = Number(v);
      exams.push({ t: str(e.t, 120), n: isFinite(n) ? Math.min(10, Math.max(0, n)) : 0 });
    });
    return exams;
  };
  const examKeys = (input.exams && typeof input.exams === 'object' && !Array.isArray(input.exams))
    ? input.exams
    : ((input.grades && typeof input.grades === 'object' && !Array.isArray(input.grades)) ? input.grades : null);
  if (examKeys) {
    Object.keys(examKeys).slice(0, 100).forEach(function (k) {
      const key = str(k, 250);
      if (!key) return;
      const exams = examOf(key);
      if (exams.length) out.exams[key] = exams;
    });
  }
  if (input.subjectColors && typeof input.subjectColors === 'object' && !Array.isArray(input.subjectColors)) {
    Object.keys(input.subjectColors).slice(0, 100).forEach(function (k) {
      const key = str(k, 250);
      if (!key) return;
      const v = input.subjectColors[k];
      if (!v || typeof v !== 'object') return;
      const c = str(v.c, 20).trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(c)) return;
      let a = Number(v.a);
      if (!isFinite(a)) a = 1;
      a = Math.min(1, Math.max(0.05, a));
      out.subjectColors[key] = { c: c.toLowerCase(), a: a };
    });
  }
  if (Array.isArray(input.skip)) {
    input.skip.slice(0, 500).forEach(function (id) {
      const v = str(id, 60);
      if (v) out.skip.push(v);
    });
  }
  if (Array.isArray(input.hide)) {
    input.hide.slice(0, 500).forEach(function (id) {
      const v = str(id, 60);
      if (v) out.hide.push(v);
    });
  }
  if (input.colors && typeof input.colors === 'object' && !Array.isArray(input.colors)) {
    Object.keys(input.colors).slice(0, 300).forEach(function (k) {
      const key = str(k, 60);
      const val = str(input.colors[k], 20);
      if (key && COLOR_RE.test(val)) out.colors[key] = val;
    });
  }
  if (SORT_MODES.indexOf(input.sort) >= 0) out.sort = input.sort;
  if (input.pos && typeof input.pos === 'object' && !Array.isArray(input.pos)) {
    Object.keys(input.pos).slice(0, 300).forEach(function (k) {
      const key = str(k, 60);
      const v = Number(input.pos[k]);
      if (key && isFinite(v)) out.pos[key] = v;
    });
  }
  if (input.gord && typeof input.gord === 'object' && !Array.isArray(input.gord)) {
    Object.keys(input.gord).slice(0, 100).forEach(function (k) {
      const key = str(k, 250);
      const v = Number(input.gord[k]);
      if (key && isFinite(v)) out.gord[key] = v;
    });
  }
  out.global = str(input.global, 8000);
  out.showdone = input.showdone === true;
  return out;
}

function readBody(req) {
  if (Buffer.isBuffer(req.body)) {
    return Promise.resolve(req.body.toString('utf8'));
  }
  if (typeof req.body === 'string' && req.body.trim()) {
    return Promise.resolve(req.body);
  }
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') {
    return Promise.resolve(JSON.stringify(req.body));
  }
  return new Promise(function (resolve, reject) {
    let size = 0;
    const chunks = [];
    req.on('data', function (c) {
      size += c.length;
      if (size > MAX_BODY) {
        const err = new Error('payload too large');
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function blobHeaders(extra) {
  return Object.assign({
    Authorization: 'Bearer ' + process.env.BLOB_READ_WRITE_TOKEN,
    'x-vercel-blob-access': 'private'
  }, extra || {});
}

// ---------- Almacén de datos ----------
// Dos backends, se elige automáticamente:
//   1. Netlify Blobs (nativo de Netlify): no necesita configuración ni cuentas.
//   2. Upstash Redis (REST): sólo si la URL y el token son valores reales.
// El JSON completo se guarda en la clave `userdata.json`.

// `@netlify/blobs` se carga de forma tolerante: en local no está el contexto
// de Blobs y el módulo puede no estar instalado, y aun así debe poder arrancar.
let netlifyGetStore = null;
try {
  netlifyGetStore = require('@netlify/blobs').getStore;
} catch (e) {
  netlifyGetStore = null;
}

function upstashConfigurado() {
  const url = process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return /^https:\/\//.test(url) && token.length > 0;
}

function upstash(cmd) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('UPSTASH no configurado');
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(8000)
  });
}

let storePromise = null;
function blobs() {
  if (!netlifyGetStore) return Promise.reject(new Error('Blobs no disponible'));
  if (!storePromise) {
    try {
      // consistency: 'strong' -> leer justo después de escribir devuelve lo último
      storePromise = Promise.resolve(netlifyGetStore({ name: 'aulavirtual', consistency: 'strong' }));
    } catch (err) {
      storePromise = null;
      return Promise.reject(err);
    }
  }
  return storePromise;
}

async function hayAlmacen() {
  if (upstashConfigurado()) return true;
  try {
    await blobs();
    return true;
  } catch (e) {
    return false;
  }
}

async function almacenLeer() {
  if (upstashConfigurado()) {
    const r = await upstash(['GET', KEY]);
    if (!r.ok) throw new Error('upstash get ' + r.status);
    const j = await r.json();
    return j && j.result != null ? j.result : null;
  }
  const store = await blobs();
  const raw = await store.get(KEY);
  return raw == null ? null : raw;
}

async function almacenEscribir(texto) {
  if (upstashConfigurado()) {
    const r = await upstash(['SET', KEY, texto]);
    if (!r.ok) throw new Error('upstash set ' + r.status);
    return;
  }
  const store = await blobs();
  await store.set(KEY, texto);
}

// Lee del Blob antiguo de Vercel (sólo para migrar la primera vez).
// Sólo se intenta si el token tiene pinta de ser real; los de relleno
// ("tu_token_blob") hacían perder 8 segundos en cada primera lectura.
function tokenBlobValido() {
  return /^vercel_blob_rw_/.test(process.env.BLOB_READ_WRITE_TOKEN || '');
}

async function readFromBlob() {
  if (!tokenBlobValido()) return null;
  const list = await fetch('https://blob.vercel-storage.com?limit=100', {
    headers: blobHeaders(),
    signal: AbortSignal.timeout(8000)
  });
  if (!list.ok) throw new Error('blob list ' + list.status);
  const j = await list.json();
  const b = (j.blobs || []).find(function (x) { return x.pathname === KEY; });
  if (!b) return null;
  const r = await fetch(b.url + '?cache=0', {
    headers: blobHeaders(),
    signal: AbortSignal.timeout(8000)
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('blob get ' + r.status);
  return sanitize(await r.json());
}

async function readData() {
  const crudo = await almacenLeer();
  if (crudo == null) {
    // primera vez: intentamos traer los datos del Blob antiguo de Vercel
    if (tokenBlobValido()) {
      try {
        const migrated = await readFromBlob();
        if (migrated) {
          await writeData(migrated);
          return migrated;
        }
      } catch (e) { /* si falla la migración, seguimos con datos vacíos */ }
    }
    return EMPTY;
  }
  try {
    return sanitize(typeof crudo === 'string' ? JSON.parse(crudo) : crudo);
  } catch (e) {
    return EMPTY;
  }
}

async function writeData(data) {
  await almacenEscribir(JSON.stringify(data));
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!checkAuth(req)) return unauthorized(res);
  if (!(await hayAlmacen())) {
    res.statusCode = 500;
    return res.json({ error: 'Sin almacén de datos: UPSTASH_REDIS_REST_URL/TOKEN no configurados y Netlify Blobs no disponible' });
  }

  if (req.method === 'GET') {
    try {
      res.statusCode = 200;
      return res.json(await readData());
    } catch (err) {
      res.statusCode = 502;
      return res.json({ error: String(err && err.message ? err.message : err) });
    }
  }

  if (req.method === 'POST') {
    try {
      let body = await readBody(req);
      if (typeof body === 'string') body = JSON.parse(body || '{}');
      const data = sanitize(body);
      await writeData(data);
      res.statusCode = 200;
      return res.json({ ok: true });
    } catch (err) {
      if (err instanceof SyntaxError) {
        res.statusCode = 400;
        return res.json({ error: 'JSON inválido' });
      }
      res.statusCode = err.statusCode || 502;
      return res.json({ error: String(err && err.message ? err.message : err) });
    }
  }

  res.statusCode = 405;
  return res.end('405');
};

module.exports.sanitize = sanitize;
