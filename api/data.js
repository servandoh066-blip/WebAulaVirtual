const KEY = 'userdata.json';
const MAX_BODY = 400000;
const EMPTY = { tasks: [], notes: {}, global: '', skip: [], colors: {}, hide: [], sort: '', pos: {}, showdone: false };
const COLOR_RE = /^k-(red|orange|yellow|green|blue|purple|pink|gray)$/;
const SORT_MODES = ['date', 'date-desc', 'title'];

function unauthorized(res) {
  res.setHeader('WWW-Authenticate', 'Basic realm="Tareas Aula Virtual", charset="UTF-8');
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
  const out = { tasks: [], notes: {}, global: '', skip: [], colors: {}, hide: [], sort: '', pos: {}, showdone: false };
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
  out.global = str(input.global, 8000);
  out.showdone = input.showdone === true;
  return out;
}

function readBody(req) {
  if (req.body !== undefined && req.body !== null && req.body !== '') {
    return Promise.resolve(req.body);
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

async function readData() {
  const list = await fetch('https://blob.vercel-storage.com?limit=100', {
    headers: blobHeaders(),
    signal: AbortSignal.timeout(8000)
  });
  if (!list.ok) throw new Error('blob list ' + list.status);
  const j = await list.json();
  const b = (j.blobs || []).find(function (x) { return x.pathname === KEY; });
  if (!b) return EMPTY;
  const r = await fetch(b.url + '?cache=0', {
    headers: blobHeaders(),
    signal: AbortSignal.timeout(8000)
  });
  if (r.status === 404) return EMPTY;
  if (!r.ok) throw new Error('blob get ' + r.status);
  return sanitize(await r.json());
}

async function writeData(data) {
  const r = await fetch('https://blob.vercel-storage.com/' + KEY, {
    method: 'PUT',
    headers: blobHeaders({ 'Content-Type': 'application/json', 'x-add-random-suffix': '0' }),
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error('blob put ' + r.status);
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!checkAuth(req)) return unauthorized(res);
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    res.statusCode = 500;
    return res.json({ error: 'BLOB_READ_WRITE_TOKEN no configurado' });
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
