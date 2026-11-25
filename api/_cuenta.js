/* Identificación de la cuenta que hace la petición (común a data, tasks y emails).

   Antes bastaba con mandar CUALQUIER cadena de 16-128 letras/dígitos en
   X-Moodle-Token para entrar: el servidor no comprobaba nada con Moodle. Ahora
   el token se valida contra el aula virtual indicada (core_webservice_get_site_info)
   y los datos se guardan por (aula virtual + id de usuario de Moodle), no por el
   texto del token: el mismo alumno conserva sus datos aunque regenere el token y
   dos alumnos nunca comparten almacén.

   "Propietario": quien entra con MOODLE_TOKEN (o con el acceso heredado Basic).
   Solo él ve los datos heredados (`userdata.json`) y los correos de la cuenta de
   Gmail conectada a Composio. Cualquier otra cuenta empieza limpia. */
const crypto = require('node:crypto');

const KEY = 'userdata.json';
const DEFAULT_BASE = 'https://centros.edu.xunta.gal/iesteis/aulavirtual/';
const TOKEN_RE = /^[A-Za-z0-9]{16,128}$/;
const TTL_OK = 10 * 60 * 1000;
const CACHE_MAX = 200;
const CACHE = new Map();

function headerValue(req, name) {
  const h = (req && req.headers) || {};
  const v = h[name] !== undefined ? h[name] : h[name.toUpperCase()];
  return typeof v === 'string' ? v.trim() : '';
}

/* Hosts a los que el servidor NO debe llamar nunca (SSRF): la URL del aula la
   escribe el usuario. */
function hostPermitido(host) {
  const h = String(host || '').toLowerCase();
  if (!h || h.indexOf('.') < 0) return false;
  if (h === 'localhost' || /\.(local|internal|localhost|lan|home)$/.test(h)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;
  if (h.indexOf(':') >= 0 || h.indexOf('[') >= 0) return false;
  return true;
}

/* URL base del aula virtual: cabecera del navegador, o MOODLE_BASE / valor por
   defecto solo en el acceso heredado. Devuelve null si no es válida. */
function moodleBase(req, permitirDefecto) {
  let raw = headerValue(req, 'x-moodle-base');
  if (!raw && permitirDefecto) raw = String(process.env.MOODLE_BASE || '').trim() || DEFAULT_BASE;
  if (!raw) return null;
  let u;
  try { u = new URL(raw); } catch (e) { return null; }
  if (u.protocol !== 'https:' || !hostPermitido(u.hostname) || u.username || u.password) return null;
  return u.origin + u.pathname.replace(/\/+$/, '') + '/';
}

function sha(texto) {
  return crypto.createHash('sha256').update(String(texto)).digest('hex');
}

function basicValido(req) {
  const user = process.env.AUTH_USER;
  const pass = process.env.AUTH_PASS;
  if (!user || !pass) return false;
  const header = (req.headers && req.headers.authorization) || '';
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

/* Pregunta a Moodle quién es el dueño del token. Lanza un Error con
   `.invalido = true` si Moodle rechaza el token. */
async function consultarSitio(base, token) {
  const body = new URLSearchParams();
  body.set('wstoken', token);
  body.set('wsfunction', 'core_webservice_get_site_info');
  body.set('moodlewsrestformat', 'json');
  const r = await fetch(base + 'webservice/rest/server.php', {
    method: 'POST',
    body: body,
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error('Moodle respondió HTTP ' + r.status);
  let j;
  try { j = await r.json(); } catch (e) { throw new Error('Respuesta de Moodle no válida'); }
  if (j && j.exception) {
    const err = new Error((j.errorcode || 'error') + ': ' + (j.message || ''));
    err.invalido = /invalidtoken|invalidlogin|accessexception|forbidden|usernotfullysetup/i.test(String(j.errorcode || ''));
    throw err;
  }
  if (!j || !j.userid) {
    const err = new Error('Moodle no devolvió el usuario');
    err.invalido = true;
    throw err;
  }
  return { userid: Number(j.userid), name: String(j.fullname || ''), username: String(j.username || '') };
}

/* Resultado:
   { ok: true, key, owner, base, token, userid, name, username }
   { ok: false, status, error }  (status 401 -> responder con `unauthorized`) */
async function identificar(req) {
  const token = headerValue(req, 'x-moodle-token');
  if (token) {
    if (!TOKEN_RE.test(token)) return { ok: false, status: 401 };
    const base = moodleBase(req, false);
    if (!base) return { ok: false, status: 400, error: 'URL del aula virtual no válida (debe ser https://…)' };
    const ck = sha(base + '|' + token);
    let info = CACHE.get(ck);
    if (!info || info.exp < Date.now()) {
      try {
        info = await consultarSitio(base, token);
      } catch (e) {
        if (e && e.invalido) return { ok: false, status: 401 };
        return { ok: false, status: 503, error: 'No se pudo verificar el token con el aula virtual: ' + String((e && e.message) || e) };
      }
      info.exp = Date.now() + TTL_OK;
      if (CACHE.size >= CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
      CACHE.set(ck, info);
    }
    const propio = String(process.env.MOODLE_TOKEN || '').trim();
    const owner = !!propio && propio === token;
    const key = owner ? KEY : 'userdata.' + sha(new URL(base).host + '|' + info.userid).slice(0, 32) + '.json';
    return { ok: true, key: key, owner: owner, base: base, token: token, userid: info.userid, name: info.name, username: info.username };
  }
  if (basicValido(req)) {
    return {
      ok: true,
      key: KEY,
      owner: true,
      base: moodleBase(req, true) || DEFAULT_BASE,
      token: String(process.env.MOODLE_TOKEN || '').trim(),
      userid: 0,
      name: '',
      username: ''
    };
  }
  return { ok: false, status: 401 };
}

function unauthorized(res) {
  // Sin cabecera 'WWW-Authenticate' a propósito: con un reto "Basic", Chrome y
  // Edge abren su diálogo nativo encima de la app y el usuario nunca ve el
  // mensaje de error de la pantalla de acceso.
  res.statusCode = 401;
  res.end('401 Unauthorized');
}

/* Responde al fallo de `identificar`. */
function rechazar(res, cuenta) {
  if (cuenta.status === 401) return unauthorized(res);
  res.statusCode = cuenta.status || 500;
  return res.json({ error: cuenta.error || 'No autorizado' });
}

module.exports = { KEY, DEFAULT_BASE, TOKEN_RE, identificar, rechazar, unauthorized, moodleBase, hostPermitido };
