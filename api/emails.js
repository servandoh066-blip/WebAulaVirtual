const EXEC = 'https://backend.composio.dev/api/v3.1/tools/execute/';
const QUERY = 'newer_than:14d {from:edu.xunta.gal from:xunta.gal}';
const MAX_LIST = 60;
const MAX_DEEP = 4;

function unauthorized(res) {
  // Sin cabecera 'WWW-Authenticate' a propósito (ver api/data.js): el reto
  // "Basic" hace que el navegador abra su diálogo nativo sobre la app.
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

async function execTool(slug, args) {
  const key = process.env.COMPOSIO_API_KEY;
  const r = await fetch(EXEC + slug, {
    method: 'POST',
    headers: { 'x-api-key': key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ arguments: args, user_id: process.env.COMPOSIO_USER_ID || 'default' }),
    signal: AbortSignal.timeout(20000)
  });
  let j = null;
  try { j = await r.json(); } catch (e) { /* sin cuerpo */ }
  if (!r.ok) {
    const m = j && j.error && (j.error.message || j.error.slug);
    throw new Error('composio ' + r.status + (m ? ': ' + m : ''));
  }
  if (j && j.error && !hasMessages(j)) {
    throw new Error('composio: ' + (typeof j.error === 'string' ? j.error : (j.error.message || j.error.slug || 'error')));
  }
  return j;
}

function findProp(obj, prop, depth) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (Array.isArray(obj[prop])) return obj[prop];
  if (obj[prop] && typeof obj[prop] === 'object' && prop === 'payload') return obj[prop];
  const keys = Object.keys(obj);
  for (let i = 0; i < keys.length; i++) {
    const v = obj[keys[i]];
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const found = findProp(v, prop, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function hasMessages(j) { return !!findProp(j, 'messages', 0); }

/* ---------------- filtro ---------------- */

function isXunta(sender) {
  return /@[\w.-]*xunta\.gal\b/i.test(String(sender || ''));
}

function excluded(subject) {
  const s = String(subject || '').toLowerCase();
  if (/vostede\s+fixo\s+(?:(?:a\s+súa|unha|un)\s+)?entrega/.test(s)) return true;
  if (/assignments\s+due\s+in\s+7\s+days/.test(s)) return true;
  if (/^due\s+on\b/.test(s)) return true;
  if (/entregas?\s+pendientes?\s+en\s+7\s+d[ií]as/.test(s)) return true;
  return false;
}

/* ---------------- fechas ---------------- */

const MONTHS = {
  xaneiro: 1, febreiro: 2, marzo: 3, abril: 4, maio: 5, xuño: 6, xullo: 7, agosto: 8,
  setembro: 9, outubro: 10, novembro: 11, decembro: 12,
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, septiembre: 9,
  octubre: 10, noviembre: 11, diciembre: 12,
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8,
  september: 9, october: 10, november: 11, december: 12
};

const GOOD_CTX = /(due|venc|pendent|entrega|control|examen|exame|reuni|cita|convoca|clase|dia|día|martes|luns|xoves|venres|m[eé]rcores|mi[eé]rcoles|s[aá]bado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i;
const BAD_CTX = /(abert[ao]s?|opens|open from|alta|cread|empez|inici|start|desde el|desde o|dende|from:)/i;

function pad(n) { return (n < 10 ? '0' : '') + n; }

function timeNear(text, from) {
  const win = text.slice(from, from + 80);
  let m = win.match(/(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?|h(?:oras?)?)?/i);
  if (!m) {
    const win2 = text.slice(Math.max(0, from - 40), from);
    const rev = win2.match(/(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?|h(?:oras?)?)?/i);
    m = rev;
  }
  if (!m) return null;
  let hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (/^p/.test(ap) && hh < 12) hh += 12;
  if (/^a/.test(ap) && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;
  return { hh: hh, mm: mm };
}

function findDates(text, inSubject) {
  const out = [];
  let m;
  const numRe = /\b(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})\b/g;
  while ((m = numRe.exec(text)) !== null) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += 2000;
    const mo = parseInt(m[2], 10), d = parseInt(m[1], 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2020 || y > 2035) continue;
    const t = timeNear(text, numRe.lastIndex);
    out.push({ y: y, mo: mo, d: d, hh: t ? t.hh : 23, mm: t ? t.mm : 59, pos: m.index, score: 0 });
  }
  const txtRe = /\b(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+(?:de\s+|del\s+)?(\d{4})\b/gi;
  while ((m = txtRe.exec(text)) !== null) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) continue;
    const d = parseInt(m[1], 10);
    const y = parseInt(m[3], 10);
    if (d < 1 || d > 31 || y < 2020 || y > 2035) continue;
    const t = timeNear(text, txtRe.lastIndex);
    out.push({ y: y, mo: mo, d: d, hh: t ? t.hh : 23, mm: t ? t.mm : 59, pos: m.index, score: 0 });
  }
  const enRe = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})\b/gi;
  while ((m = enRe.exec(text)) !== null) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (!mo) continue;
    const d = parseInt(m[2], 10);
    const y = parseInt(m[3], 10);
    if (d < 1 || d > 31 || y < 2020 || y > 2035) continue;
    const t = timeNear(text, enRe.lastIndex);
    out.push({ y: y, mo: mo, d: d, hh: t ? t.hh : 23, mm: t ? t.mm : 59, pos: m.index, score: 0 });
  }
  out.forEach(function (o) {
    const ctx = text.slice(Math.max(0, o.pos - 70), o.pos + 6);
    if (GOOD_CTX.test(ctx)) o.score += 2;
    if (BAD_CTX.test(ctx)) o.score -= 3;
    if (inSubject) o.score += 2;
  });
  return out;
}

function bestDate(subject, body) {
  const all = findDates(String(subject || ''), true).concat(findDates(String(body || ''), false));
  if (!all.length) return null;
  let best = all[0];
  all.forEach(function (o) {
    if (o.score > best.score) best = o;
  });
  if (best.score < 0) return null;
  return best.y + '-' + pad(best.mo) + '-' + pad(best.d) + 'T' + pad(best.hh) + ':' + pad(best.mm) + ':00';
}

/* ---------------- asignatura / título ---------------- */

function stripCourseNoise(s) {
  return String(s || '')
    .replace(/\s*\(?(?:20\d{2}|\d{2})-\d{2}\)?\s*$/, '')
    .replace(/\s+20\d{2}-20\d{2}\s*$/, '')
    .replace(/\s*\(?\s*curso\s*$/i, '')
    .replace(/\s*\(\s*\)\s*$/, '')
    .replace(/[.\s]+$/, '')
    .trim();
}

function cutField(s, marks) {
  const re = new RegExp('\\s+(?:' + marks.join('|') + ')\\s*:', 'i');
  const i = String(s || '').search(re);
  return i > 0 ? String(s).slice(0, i) : String(s || '');
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').replace(/[.,;»|]+\s*$/, '').trim();
}

function parseMessage(m) {
  const subject = cleanText(m.subject);
  const snippet = String((m.preview && (m.preview.body || m.preview.subject)) || m.messageText || '')
    .replace(/&gt;/gi, '>').replace(/&lt;/gi, '<').replace(/&amp;/gi, '&');
  let title = subject;
  let hint = '';
  let x;

  // "Novo correo en Aula Virtual": el título real está en el cuerpo
  if (/^Novo correo/i.test(subject)) {
    const a = snippet.match(/Asunto:\s*([^\n\r]+)/i);
    if (a) title = cleanText(cutField(a[1], ['Curso', 'Data', 'Asunto', 'De']));
    const c = snippet.match(/Curso:\s*([^\n\r]+)/i);
    if (c) hint = stripCourseNoise(cutField(c[1], ['Data', 'Asunto', 'De', 'Ficheiro', 'Ver']));
  }

  if (!hint && (x = snippet.match(/\bCurso:\s*([^\n\r]+)/i))) {
    hint = stripCourseNoise(cutField(x[1], ['Data', 'Asunto', 'De', 'Ficheiro', 'Ver']));
  }
  if (!hint && (x = snippet.match(/\bin course\s+([^.\n\r]+)/i))) hint = stripCourseNoise(x[1]);
  if (!hint && (x = snippet.match(/\bno curso\s+([^.\n\r(]+)/i))) hint = stripCourseNoise(x[1]);

  if (!/^Novo correo/i.test(subject)) {
    const ci = subject.indexOf(': ');
    if (ci > 0 && ci <= 70) {
      const pre = subject.slice(0, ci);
      const generic = /^(tarefa|tarea|tarefas|tareas|recordatorio|aviso|reunión|reunion|anuncio|correo|mensaxe|mensaje|actividade|actividad)$/i;
      if (!/^(due on|hi|hola|re|fw)/i.test(pre)) {
        if (!generic.test(pre) && !hint) hint = stripCourseNoise(pre);
        title = subject.slice(ci + 2);
      }
    }
  }

  if (!hint && (x = snippet.match(/^[A-Za-z0-9ÁÉÍÓÚÑ_ -]{2,40}\s*->/))) {
    hint = stripCourseNoise(x[0].replace(/\s*->.*/, ''));
  }

  title = cleanText(title).replace(/^[»\s]+/, '');
  if (!title) title = subject;

  const d = bestDate(subject, snippet);
  const ts = m.messageTimestamp || null;
  const url = m.display_url || (m.messageId ? 'https://mail.google.com/mail/u/0/#inbox/' + m.messageId : '');

  return {
    id: String(m.messageId || url || subject).slice(0, 60),
    title: title.slice(0, 300),
    hint: hint.slice(0, 150),
    d: d,
    ts: ts,
    url: url,
    snippet: cleanText(snippet).slice(0, 400)
  };
}

/* ---------------- cuerpo completo (para fechas que no aparecen) ---------------- */

function b64urlToText(s) {
  try {
    let b = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    return Buffer.from(b, 'base64').toString('utf8');
  } catch (e) { return ''; }
}

function collectText(node, out, depth) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  if (node.mimeType === 'text/plain' && node.body && node.body.data) {
    out.push(b64urlToText(node.body.data));
    return;
  }
  if (Array.isArray(node.parts)) {
    node.parts.forEach(function (p) { collectText(p, out, depth + 1); });
  }
  if (node.payload) collectText(node.payload, out, depth + 1);
  if (node.body && node.body.data && !out.length) out.push(b64urlToText(node.body.data));
}

async function hydrateDate(item) {
  try {
    const j = await execTool('GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID', { message_id: item.id, format: 'full' });
    const payload = findProp(j, 'payload', 0) || j;
    const parts = [];
    collectText(payload, parts, 0);
    const body = parts.join('\n').replace(/<[^>]+>/g, ' ');
    if (body) {
      const d = bestDate(item.snippet || '', body);
      if (d) item.d = d;
    }
  } catch (e) {
    /* el cuerpo es opcional */
  }
}

/* ---------------- handler ---------------- */

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end('405');
  }
  if (!checkAuth(req)) return unauthorized(res);
  if (!process.env.COMPOSIO_API_KEY) {
    res.statusCode = 500;
    return res.json({ error: 'COMPOSIO_API_KEY no configurado' });
  }

  try {
    const j = await execTool('GMAIL_FETCH_EMAILS', {
      query: QUERY,
      max_results: MAX_LIST,
      verbose: false,
      include_payload: false
    });
    const raw = findProp(j, 'messages', 0) || [];
    const items = [];
    raw.forEach(function (m) {
      if (!m) return;
      if (!isXunta(m.sender)) return;
      if (excluded(m.subject)) return;
      if (!m.messageId) return;
      items.push(parseMessage(m));
    });
    items.sort(function (a, b) {
      const ta = a.ts ? Date.parse(a.ts) : 0;
      const tb = b.ts ? Date.parse(b.ts) : 0;
      return tb - ta;
    });

    const missing = items.filter(function (i) { return !i.d; }).slice(0, MAX_DEEP);
    if (missing.length) {
      await Promise.all(missing.map(hydrateDate));
    }

    res.statusCode = 200;
    return res.json({ annots: items, fetchedAt: Math.floor(Date.now() / 1000) });
  } catch (err) {
    res.statusCode = 502;
    return res.json({ error: String(err && err.message ? err.message : err) });
  }
};

module.exports.parseMessage = parseMessage;
module.exports.bestDate = bestDate;
module.exports.excluded = excluded;
module.exports.isXunta = isXunta;
