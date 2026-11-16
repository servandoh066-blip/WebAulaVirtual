const DEFAULT_WS = 'https://centros.edu.xunta.gal/iesteis/aulavirtual/webservice/rest/server.php';
const DEFAULT_BASE = 'https://centros.edu.xunta.gal/iesteis/aulavirtual/';
// Token de Moodle: 32 caracteres alfanuméricos. Se acepta por cabecera
// (X-Moodle-Token, lo introduce el usuario en la pantalla de acceso) con
// respaldo en MOODLE_TOKEN del entorno.
const TOKEN_RE = /^[A-Za-z0-9]{16,128}$/;

function unauthorized(res) {
  // Sin cabecera 'WWW-Authenticate' a propósito (ver api/data.js): el reto
  // "Basic" hace que el navegador abra su diálogo nativo sobre la app.
  res.statusCode = 401;
  res.end('401 Unauthorized');
}

function headerValue(req, name) {
  const h = req.headers || {};
  const v = h[name] !== undefined ? h[name] : h[name.toUpperCase()];
  return typeof v === 'string' ? v.trim() : '';
}

// Token del cliente (cabecera) o, si no viene, el del servidor.
function moodleToken(req) {
  const own = headerValue(req, 'x-moodle-token');
  if (own) return own;
  return String(process.env.MOODLE_TOKEN || '').trim();
}

// URL base del aula virtual: la que introduce el usuario o la del entorno.
function moodleBase(req) {
  let base = headerValue(req, 'x-moodle-base') ||
    String(process.env.MOODLE_BASE || '').trim() ||
    DEFAULT_BASE;
  if (!/^https?:\/\//i.test(base)) return null;
  return base.replace(/\/+$/, '') + '/';
}

function moodleWs(base) {
  if (!base) return DEFAULT_WS;
  return base + 'webservice/rest/server.php';
}

// Autenticación: token de Moodle en cabecera (nuevo acceso) o Basic (legacy).
function checkAuth(req) {
  const token = headerValue(req, 'x-moodle-token');
  if (token && TOKEN_RE.test(token)) return true;
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

function appendParams(body, prefix, v) {
  if (v === undefined || v === null) return;
  if (Array.isArray(v)) {
    v.forEach(function (x, i) { appendParams(body, prefix + '[' + i + ']', x); });
  } else if (typeof v === 'object') {
    Object.keys(v).forEach(function (k) { appendParams(body, prefix + '[' + k + ']', v[k]); });
  } else {
    body.set(prefix, String(v));
  }
}

async function ws(ctx, fn, params) {
  const body = new URLSearchParams();
  body.set('wstoken', ctx.token);
  body.set('wsfunction', fn);
  body.set('moodlewsrestformat', 'json');
  Object.keys(params || {}).forEach(function (k) {
    appendParams(body, k, params[k]);
  });
  const r = await fetch(ctx.ws, { method: 'POST', body, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error('WS HTTP ' + r.status);
  const j = await r.json();
  if (j && j.exception) throw new Error((j.errorcode || 'error') + ': ' + (j.message || ''));
  return j;
}

async function mapLimit(arr, limit, fn) {
  const out = new Array(arr.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async function () {
    while (next < arr.length) {
      const i = next++;
      out[i] = await fn(arr[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

function isDelivered(st) {
  if (!st || st.exception) return false;
  const la = st.lastattempt || {};
  if (la.graded) return true;
  const subs = [];
  if (la.submission) subs.push(la.submission);
  if (st.submission) subs.push(st.submission);
  if (st.groupsubmission) subs.push(st.groupsubmission);
  return subs.some(function (s) {
    if (!s) return false;
    if (s.status === 'submitted' || s.status === 'graded') return true;
    if (Number(s.status) === 2) return true;
    if (Number(s.submissionstatus) === 2) return true;
    return false;
  });
}

async function calendarEvents(ctx, nowSec, courseIds) {
  const params = {
    options: {
      userevents: 1,
      siteevents: 1,
      timestart: nowSec - 172800,
      timeend: nowSec + 7776000
    }
  };
  if (courseIds.length) params.events = { courseids: courseIds };
  const r = await ws(ctx, 'core_calendar_get_calendar_events', params);
  return (r && r.events) || [];
}

// Profesores + métricas de la tarjeta de módulo: participantes y último
// acceso del alumno al curso (ambos salen de la misma llamada al WS).
async function courseInfo(ctx, courseIds, me) {
  const teach = {};
  const size = {};
  const seen = {};
  await mapLimit(courseIds, 4, async function (cid) {
    try {
      const users = await ws(ctx, 'core_enrol_get_enrolled_users', { courseid: cid });
      const list = users || [];
      size[cid] = list.length;
      list.forEach(function (u) {
        if (me && u.id === me && u.lastaccess) seen[cid] = u.lastaccess;
      });
      const names = list
        .filter(function (u) {
          return (u.roles || []).some(function (r) {
            return /teacher|docen|profes|tutor/i.test(String(r.name || ''));
          });
        })
        .map(function (u) { return String(u.fullname || '').trim(); })
        .filter(Boolean);
      if (names.length) teach[cid] = names.slice(0, 3).join(', ');
    } catch (e) {
      /* el profesor y las métricas son opcionales */
    }
  });
  return { teach: teach, size: size, seen: seen };
}

function eventUrl(base, e) {
  if (e.modulename && e.instance) return base + 'mod/' + e.modulename + '/view.php?id=' + e.instance;
  if (e.courseid) return base + 'course/view.php?id=' + e.courseid;
  return base;
}

function isCandidate(a, nowSec) {
  const duedate = a.duedate || 0;
  const cutoff = a.cutoffdate || 0;
  const from = a.allowsubmissionsfromdate || 0;
  if (duedate > 0) return duedate > nowSec - 31536000;
  if (cutoff > 0) return cutoff > nowSec - 31536000;
  return from > nowSec - 7776000;
}

function dueTimestamp(a) {
  if ((a.duedate || 0) > 0) return a.duedate;
  if ((a.cutoffdate || 0) > 0) return a.cutoffdate;
  return 0;
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end('405');
  }
  if (!checkAuth(req)) return unauthorized(res);

  // Credenciales Moodle: cabeceras del navegador con respaldo en el entorno.
  const base = moodleBase(req);
  if (!base) {
    res.statusCode = 400;
    return res.json({ error: 'URL del aula virtual no válida' });
  }
  const token = moodleToken(req);
  if (!token) {
    res.statusCode = 500;
    return res.json({ error: 'MOODLE_TOKEN no configurado' });
  }
  const ctx = { token: token, base: base, ws: moodleWs(base) };

  try {
    const info = await ws(ctx, 'core_webservice_get_site_info', {});
    const me = info.userid;
    const nowSec = Math.floor(Date.now() / 1000);

    const courses = await ws(ctx, 'core_enrol_get_users_courses', { userid: me });
    const courseIds = courses.map(function (c) { return c.id; });
    const courseNames = {};
    courses.forEach(function (c) { courseNames[c.id] = c.fullname || c.shortname; });
    const info2 = await courseInfo(ctx, courseIds, me);
    const teachBy = info2.teach;
    const teachers = {};
    Object.keys(teachBy).forEach(function (cid) {
      if (courseNames[cid]) teachers[courseNames[cid]] = teachBy[cid];
    });
    /* Ficha de cada módulo para la vista «Módulos»: abreviatura, URL del
       curso, participantes y tiempo desde el último acceso. */
    const modules = courses.map(function (c) {
      return {
        id: c.id,
        name: courseNames[c.id],
        short: String(c.shortname || '').trim(),
        url: ctx.base + 'course/view.php?id=' + c.id,
        participants: typeof info2.size[c.id] === 'number' ? info2.size[c.id] : 0,
        lastAccess: info2.seen[c.id] || 0
      };
    });

    const tasks = [];

    if (courseIds.length) {
      const byCourse = await ws(ctx, 'mod_assign_get_assignments', { courseids: courseIds });
      const assignments = [];
      (byCourse.courses || []).forEach(function (c) {
        (c.assignments || []).forEach(function (a) {
          a._courseId = c.id;
          a._courseName = courseNames[c.id] || c.fullname || '';
          assignments.push(a);
        });
      });

      const candidates = assignments.filter(function (a) { return isCandidate(a, nowSec); });

      const delivered = await mapLimit(candidates, 6, async function (a) {
        try {
          const st = await ws(ctx, 'mod_assign_get_submission_status', {
            assignid: a.id,
            userid: me
          });
          return isDelivered(st);
        } catch (e) {
          return false;
        }
      });

      candidates.forEach(function (a, i) {
        const due = dueTimestamp(a);
        if (!due && a.nosubmissions) return;
        tasks.push({
          id: 'a' + a.id,
          s: a._courseName,
          t: a.name,
          p: teachBy[a._courseId] || '',
          u: ctx.base + 'mod/assign/view.php?id=' + a.cmid,
          d: due > 0 ? new Date(due * 1000).toISOString() : null,
          done: delivered[i] ? 1 : 0
        });
      });
    }

    try {
      const events = await calendarEvents(ctx, nowSec, courseIds);
      const seen = {};
      tasks.forEach(function (t) { seen[t.t] = true; });
      events.forEach(function (e) {
        if ((e.modulename || '') === 'assign') return;
        if (e.timestart < nowSec - 172800) return;
        if (seen[e.name]) return;
        seen[e.name] = true;
        tasks.push({
          id: 'e' + e.id,
          s: courseNames[e.courseid] || '',
          t: e.name,
          p: teachBy[e.courseid] || '',
          u: eventUrl(ctx.base, e),
          d: e.timestart > 0 ? new Date(e.timestart * 1000).toISOString() : null
        });
      });
    } catch (e) {
      /* el calendario es opcional */
    }

    tasks.sort(function (a, b) {
      if (!a.d && !b.d) return a.t.localeCompare(b.t);
      if (!a.d) return 1;
      if (!b.d) return -1;
      return a.d < b.d ? -1 : 1;
    });

    res.statusCode = 200;
    return res.json({
      tasks: tasks,
      teachers: teachers,
      modules: modules,
      fetchedAt: nowSec,
      user: info.fullname,
      username: info.username || ''
    });
  } catch (err) {
    res.statusCode = 502;
    return res.json({ error: String(err && err.message ? err.message : err) });
  }
};

module.exports.isCandidate = isCandidate;
module.exports.dueTimestamp = dueTimestamp;
