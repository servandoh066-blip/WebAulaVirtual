let fs = null;
try {
  fs = require('node:fs/promises');
} catch (e) {
  fs = null;
}

const cuentas = require('./_cuenta.js');

const KEY = cuentas.KEY;
const MAX_BODY = 400000;
const EMPTY = { tasks: [], notes: {}, global: '', generalNote: '', skip: [], colors: {}, hide: [], sort: '', pos: {}, gord: {}, showdone: false, exams: {}, subjectColors: {}, customEvents: [], chartOrder: ['tasks', 'grades'], agendas: [], taskNotes: {}, modules: {}, accent: '', bgColor: '', customAgenda: [] };
const COLOR_RE = /^k-(red|orange|yellow|green|blue|purple|pink|gray)$/;
const SORT_MODES = ['date', 'date-desc', 'title'];
const CHART_KEYS = ['tasks', 'grades'];
const HEX_RE = /^#[0-9a-f]{6}$/i;

function str(v, max) {
  if (v === null || v === undefined) return '';
  return String(v).slice(0, max);
}

// ---------- Aislamiento de cuentas ----------
// Cada cuenta (aula virtual + id de usuario de Moodle, verificado contra
// Moodle en api/_cuenta.js) guarda sus datos en su propia clave. Solo el
// propietario (MOODLE_TOKEN o acceso heredado) usa `userdata.json`.

// Fichero local equivalente para una cuenta concreta (desarrollo).
function archivoLocalCuenta(clave) {
  const base = archivoLocal();
  if (!base || clave === KEY) return base;
  const sufijo = String(clave).replace(/^userdata\./, '').replace(/\.json$/i, '');
  if (!sufijo) return base;
  return /\.json$/i.test(base) ? base.replace(/\.json$/i, '.' + sufijo + '.json') : base + '.' + sufijo;
}

function sanitize(input) {
  const out = { tasks: [], notes: {}, global: '', generalNote: '', skip: [], colors: {}, hide: [], sort: '', pos: {}, gord: {}, showdone: false, exams: {}, subjectColors: {}, customEvents: [], chartOrder: CHART_KEYS.slice(), agendas: [], taskNotes: {}, modules: {}, accent: '', bgColor: '', customAgenda: [] };
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
        d: t.d ? str(t.d, 40) : null,
        p: str(t.p, 200)
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
      // Opacidad de la asignatura: del 0 % al 80 % (la interfaz lo expone así).
      let a = Number(v.a);
      if (!isFinite(a)) a = 0.8;
      a = Math.min(0.8, Math.max(0, a));
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
  /* Eventos propios del calendario (agenda). Antes se perdían al guardar. */
  if (Array.isArray(input.customEvents)) {
    input.customEvents.slice(0, 200).forEach(function (ev, i) {
      if (!ev || typeof ev !== 'object') return;
      const title = str(ev.title, 200).trim();
      const date = str(ev.date, 40).trim();
      if (!title || !date) return;
      const color = str(ev.color, 7).trim();
      out.customEvents.push({
        id: str(ev.id, 60) || 'ce' + i,
        title: title,
        subject: str(ev.subject, 250),
        date: date,
        color: HEX_RE.test(color) ? color.toLowerCase() : '',
        agenda: str(ev.agenda, 60)
      });
    });
  }
  /* Actividades del planificador personal de la pestaña Agenda.
     Independiente de las asignaturas: título, descripción, fecha, horario,
     categoría y color propio. */
  if (Array.isArray(input.customAgenda)) {
    input.customAgenda.slice(0, 400).forEach(function (act, i) {
      if (!act || typeof act !== 'object') return;
      const title = str(act.title, 160).trim();
      const date = str(act.date, 40).trim();
      if (!title || !date) return;
      const color = str(act.color, 7).trim();
      out.customAgenda.push({
        id: str(act.id, 60) || 'pl' + i,
        title: title,
        desc: str(act.desc, 2000),
        date: date,
        start: str(act.start, 8),
        end: str(act.end, 8),
        category: str(act.category, 60).trim() || 'Personal',
        color: HEX_RE.test(color) ? color.toLowerCase() : ''
      });
    });
  }
  /* Agendas múltiples (estilo TimeTree): id, nombre, color y visibilidad. */
  if (Array.isArray(input.agendas)) {
    const seenAg = [];
    input.agendas.slice(0, 20).forEach(function (a) {
      if (!a || typeof a !== 'object') return;
      const id = str(a.id, 60).trim();
      const name = str(a.name, 60).trim();
      if (!id || !name || seenAg.indexOf(id) !== -1) return;
      seenAg.push(id);
      const color = str(a.color, 7).trim();
      out.agendas.push({
        id: id,
        name: name,
        color: HEX_RE.test(color) ? color.toLowerCase() : '#64748b',
        enabled: a.enabled !== false
      });
    });
  }
  /* Anotaciones propias por tarea (clave = id de la tarea o composición). */
  if (input.taskNotes && typeof input.taskNotes === 'object' && !Array.isArray(input.taskNotes)) {
    Object.keys(input.taskNotes).slice(0, 300).forEach(function (k) {
      const key = str(k, 120);
      const val = str(input.taskNotes[k], 2000);
      if (key && val.trim()) out.taskNotes[key] = val;
    });
  }
  /* Orden de las tarjetas de diagramas (arrastrar y soltar). */
  if (Array.isArray(input.chartOrder)) {
    const seen = [];
    input.chartOrder.forEach(function (k) {
      if (typeof k === 'string' && CHART_KEYS.indexOf(k) !== -1 && seen.indexOf(k) === -1) seen.push(k);
    });
    CHART_KEYS.forEach(function (k) { if (seen.indexOf(k) === -1) seen.push(k); });
    out.chartOrder = seen;
  }
  /* Personalización de módulos: nombre, abreviatura y color por asignatura. */
  if (input.modules && typeof input.modules === 'object' && !Array.isArray(input.modules)) {
    Object.keys(input.modules).slice(0, 100).forEach(function (k) {
      const key = str(k, 250);
      if (!key) return;
      const v = input.modules[k];
      if (!v || typeof v !== 'object') return;
      const entry = {};
      const nm = str(v.name, 120).trim();
      const ab = str(v.abbr, 24).trim();
      const co = str(v.color, 7).trim();
      if (nm) entry.name = nm;
      if (ab) entry.abbr = ab;
      if (HEX_RE.test(co)) entry.color = co.toLowerCase();
      if (entry.name || entry.abbr || entry.color) out.modules[key] = entry;
    });
  }
  /* Color de acento del tema (personalizable desde Ajustes). */
  const accent = str(input.accent, 7).trim();
  if (HEX_RE.test(accent)) out.accent = accent.toLowerCase();
  /* Color de fondo elegido por el usuario: de el derivan las superficies. */
  const bgColor = str(input.bgColor, 7).trim();
  if (HEX_RE.test(bgColor)) out.bgColor = bgColor.toLowerCase();
  out.global = str(input.global, 8000);
  /* Bloc rapido de Inicio, vinculado a la cuenta activa. */
  out.generalNote = str(input.generalNote, 8000);
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
// Backends soportados:
//   1. Cloudflare KV (Workers) - si existe binding DATA
//   2. Netlify Blobs (nativo de Netlify)
//   3. Upstash Redis (REST): sólo si la URL y el token son valores reales.
//   4. Fichero local (desarrollo)
// El JSON completo se guarda en la clave `userdata.json`.

// `@netlify/blobs` se carga de forma tolerante
let netlifyGetStore = null;
try {
  netlifyGetStore = require('@netlify/blobs').getStore;
} catch (e) {
  netlifyGetStore = null;
}

let storeInyectado = null;
function setStore(store) {
  storeInyectado = store || null;
}

function archivoLocal() {
  if (!fs) return '';
  return process.env.LOCAL_DATA_FILE || '';
}

// Cloudflare KV binding
function getKv() {
  try {
    if (typeof globalThis !== 'undefined') {
      if (globalThis.__CF_KV_DATA__ && typeof globalThis.__CF_KV_DATA__.get === 'function') return globalThis.__CF_KV_DATA__;
      if (globalThis.DATA && typeof globalThis.DATA.get === 'function') return globalThis.DATA;
    }
    if (typeof global !== 'undefined') {
      if (global.__CF_KV_DATA__ && typeof global.__CF_KV_DATA__.get === 'function') return global.__CF_KV_DATA__;
      if (global.DATA && typeof global.DATA.get === 'function') return global.DATA;
    }
    if (typeof process !== 'undefined' && process.env) {
      if (process.env.__CF_KV_DATA__ && typeof process.env.__CF_KV_DATA__.get === 'function') return process.env.__CF_KV_DATA__;
      if (process.env.DATA && typeof process.env.DATA.get === 'function') return process.env.DATA;
    }
    if (typeof DATA !== 'undefined' && DATA && typeof DATA.get === 'function') return DATA;
  } catch (e) {}
  return null;
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
let blobsError = null;
function blobs() {
  if (storeInyectado) return Promise.resolve(storeInyectado);
  if (!netlifyGetStore) {
    blobsError = 'paquete @netlify/blobs no disponible en la funcion';
    return Promise.reject(new Error(blobsError));
  }
  if (!storePromise) {
    try {
      // consistency: 'strong' -> leer justo después de escribir devuelve lo último
      storePromise = Promise.resolve(netlifyGetStore({ name: 'aulavirtual', consistency: 'strong' }));
    } catch (err) {
      storePromise = null;
      blobsError = String((err && err.message) || err).slice(0, 300);
      return Promise.reject(err);
    }
  }
  return storePromise;
}

async function hayAlmacen() {
  if (getKv()) return true;
  if (archivoLocal()) return true;
  if (upstashConfigurado()) return true;
  try {
    await blobs();
    return true;
  } catch (e) {
    return getKv() ? true : false;
  }
}

async function almacenLeer(clave) {
  const k = clave || KEY;
  const kv = getKv();
  if (kv && typeof kv.get === 'function') {
    const raw = await kv.get(k);
    return raw == null ? null : raw;
  }
  if (archivoLocal()) {
    try {
      return await fs.readFile(archivoLocalCuenta(k), 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return null;
      throw err;
    }
  }
  if (upstashConfigurado()) {
    const r = await upstash(['GET', k]);
    if (!r.ok) throw new Error('upstash get ' + r.status);
    const j = await r.json();
    return j && j.result != null ? j.result : null;
  }
  if (netlifyGetStore || storeInyectado) {
    const store = await blobs();
    const raw = await store.get(k);
    return raw == null ? null : raw;
  }
  throw new Error('Sin almacén de datos configurado');
}

async function almacenEscribir(clave, texto) {
  const k = clave || KEY;
  const kv = getKv();
  if (kv && typeof kv.put === 'function') {
    await kv.put(k, texto);
    return;
  }
  if (archivoLocal()) {
    const destino = archivoLocalCuenta(k);
    const temporal = destino + '.tmp';
    await fs.writeFile(temporal, texto, 'utf8');
    await fs.rename(temporal, destino);
    return;
  }
  if (upstashConfigurado()) {
    const r = await upstash(['SET', k, texto]);
    if (!r.ok) throw new Error('upstash set ' + r.status);
    return;
  }
  if (netlifyGetStore || storeInyectado) {
    const store = await blobs();
    await store.set(k, texto);
    return;
  }
  throw new Error('Sin almacén de datos configurado');
}

// Lee del Blob antiguo de Vercel (sólo para migrar la primera vez).
// Sólo se intenta si el token tiene el formato real; un valor de relleno
// hacía perder 8 segundos en la primera lectura de cada usuario.
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

async function readData(clave) {
  const k = clave || KEY;
  const crudo = await almacenLeer(k);
  if (crudo == null) {
    // primera vez: intentamos traer los datos del Blob antiguo de Vercel
    // (solo para la cuenta propietaria de la clave heredada).
    if (k === KEY && tokenBlobValido()) {
      try {
        const migrated = await readFromBlob();
        if (migrated) {
          await writeData(migrated, k);
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

async function writeData(data, clave) {
  await almacenEscribir(clave || KEY, JSON.stringify(data));
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const cuenta = await cuentas.identificar(req);
  if (!cuenta.ok) return cuentas.rechazar(res, cuenta);
  // Inyectar KV desde _worker.js si viene en env
  if (typeof process !== 'undefined' && process.env) {
    if (process.env.DATA && typeof process.env.DATA.get === 'function') {
      if (typeof globalThis !== 'undefined') { globalThis.__CF_KV_DATA__ = process.env.DATA; globalThis.DATA = process.env.DATA; }
      if (typeof global !== 'undefined') { global.__CF_KV_DATA__ = process.env.DATA; global.DATA = process.env.DATA; }
    }
    if (process.env.__CF_KV_DATA__ && typeof process.env.__CF_KV_DATA__.get === 'function') {
      if (typeof globalThis !== 'undefined') { globalThis.__CF_KV_DATA__ = process.env.__CF_KV_DATA__; globalThis.DATA = globalThis.__CF_KV_DATA__; }
      if (typeof global !== 'undefined') { global.__CF_KV_DATA__ = process.env.__CF_KV_DATA__; global.DATA = global.__CF_KV_DATA__; }
    }
  }

  // Cada cuenta de Moodle verificada: su propio almacen (ver api/_cuenta.js).
  const clave = cuenta.key;

  if (req.method === 'GET') {
    try {
      res.statusCode = 200;
      return res.json(await readData(clave));
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
      await writeData(data, clave);
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
module.exports.setStore = setStore;
