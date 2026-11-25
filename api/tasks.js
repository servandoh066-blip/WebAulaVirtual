const cuentas = require('./_cuenta.js');

function moodleWs(base) {
  return base + 'webservice/rest/server.php';
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
  /* Respaldo: los «contactos del curso» (el profesorado que Moodle enseña en
     la ficha del curso). Los ve cualquier alumno, aunque no tenga permiso para
     ver la lista de participantes. */
  const sinProfe = courseIds.filter(function (cid) { return !teach[cid]; });
  if (sinProfe.length) {
    try {
      const r = await ws(ctx, 'core_course_get_courses_by_field', { field: 'ids', value: sinProfe.join(',') });
      ((r && r.courses) || []).forEach(function (c) {
        const names = (c.contacts || [])
          .map(function (u) { return String((u && u.fullname) || '').trim(); })
          .filter(Boolean);
        if (names.length) teach[c.id] = names.slice(0, 3).join(', ');
      });
    } catch (e) {
      /* opcional */
    }
  }
  return { teach: teach, size: size, seen: seen };
}

const TIPO_EVENTO = {
  user: 'Evento personal',
  site: 'Evento del sitio',
  group: 'Evento de grupo',
  category: 'Evento de categoría'
};

/* Descripción del evento en texto plano: el HTML del profesor nunca se
   inserta tal cual en la página (evita inyectar código). Conserva los saltos
   de línea y las listas para que se lea como en Moodle. */
function textoPlano(html) {
  return String(html || '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<(br|\/p|\/div|\/tr|\/h[1-6]|\/ol|\/ul)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;/gi, "'").replace(/&amp;/gi, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+• /g, '\n• ')   // los puntos de una lista van seguidos
    .trim()
    .slice(0, 4000);
}

/* Enlace de un evento sin `url` (el calendario no la trae). `view.php?id=`
   espera el id de la actividad en el curso (cmid), no el de la instancia:
   usarlo con `instance` abría otra actividad. Se abre el día en el calendario. */
function eventUrl(base, e) {
  if (e.timestart > 0) {
    return base + 'calendar/view.php?view=day&time=' + e.timestart +
      (e.courseid ? '&course=' + e.courseid : '');
  }
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
  const cuenta = await cuentas.identificar(req);
  if (!cuenta.ok) return cuentas.rechazar(res, cuenta);

  // Token y aula ya verificados contra Moodle (api/_cuenta.js).
  if (!cuenta.token) {
    res.statusCode = 500;
    return res.json({ error: 'MOODLE_TOKEN no configurado' });
  }
  const ctx = { token: cuenta.token, base: cuenta.base, ws: moodleWs(cuenta.base) };

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

    /* ---- Fuente 1: la página «Próximos eventos» de Moodle ----
       calendar/view.php?view=upcoming usa exactamente esta función, con la
       ventana de días y el máximo de eventos que el alumno tiene en sus
       preferencias. Es la referencia de lo que hay que mostrar. */
    let source = '';
    let sourceError = '';
    let events = null;
    try {
      const up = await ws(ctx, 'core_calendar_get_calendar_upcoming_view', { courseid: 1, categoryid: 0 });
      if (!up || !Array.isArray(up.events)) throw new Error('respuesta sin eventos');
      events = up.events;
      source = 'upcoming';
    } catch (e) {
      sourceError = 'próximos eventos: ' + String((e && e.message) || e).slice(0, 160);
    }

    /* ---- Fuente 2: la misma ventana calculada con el calendario ----
       Desde el inicio de hoy hasta hoy + «días a mostrar» del alumno. */
    if (!events) {
      try {
        let dias = 21;
        try {
          const pr = await ws(ctx, 'core_user_get_user_preferences', { name: 'calendar_lookahead' });
          const v = Number(((pr && pr.preferences) || [])[0] && pr.preferences[0].value);
          if (isFinite(v) && v > 0) dias = Math.min(v, 365);
        } catch (e) { /* preferencia opcional */ }
        const inicio = nowSec - (nowSec % 86400) - 7200;
        const params = { options: { userevents: 1, siteevents: 1, timestart: inicio, timeend: inicio + dias * 86400 } };
        if (courseIds.length) params.events = { courseids: courseIds };
        const r = await ws(ctx, 'core_calendar_get_calendar_events', params);
        events = (r && r.events) || [];
        source = 'calendar';
      } catch (e) {
        sourceError += ' | calendario: ' + String((e && e.message) || e).slice(0, 160);
      }
    }

    if (events) {
      const vistos = {};
      const lista = [];
      events.forEach(function (e) {
        if (!e || !e.name) return;
        // «Fecha límite de calificación» es un evento para el profesorado.
        if (e.eventtype === 'gradingdue') return;
        const esEntrega = e.modulename === 'assign' && e.instance;
        const id = esEntrega ? 'a' + e.instance : 'e' + e.id;
        if (vistos[id]) return;
        vistos[id] = true;
        lista.push({ e: e, id: id, esEntrega: esEntrega });
      });
      const entregas = lista.filter(function (x) { return x.esEntrega; });
      const hechas = await mapLimit(entregas, 6, async function (x) {
        try {
          return isDelivered(await ws(ctx, 'mod_assign_get_submission_status', { assignid: x.e.instance, userid: me }));
        } catch (err) {
          return false;
        }
      });
      const hecha = {};
      entregas.forEach(function (x, i) { hecha[x.id] = hechas[i]; });
      lista.forEach(function (x) {
        const e = x.e;
        const cid = (e.course && e.course.id) || e.courseid || 0;
        const t = {
          id: x.id,
          s: (e.course && (e.course.fullname || e.course.shortname)) || courseNames[cid] || '',
          t: e.name,
          p: teachBy[cid] || '',
          u: e.url || eventUrl(ctx.base, e),
          d: e.timestart > 0 ? new Date(e.timestart * 1000).toISOString() : null
        };
        if (x.esEntrega) t.done = hecha[x.id] ? 1 : 0;
        // Lo mismo que enseña la tarjeta de «Próximos eventos» de Moodle.
        const ds = textoPlano(e.description);
        if (ds) t.ds = ds;
        t.k = TIPO_EVENTO[e.eventtype] || 'Evento de curso';
        if (e.action && e.action.url && e.action.name) {
          t.a = { n: String(e.action.name).slice(0, 80), u: String(e.action.url) };
        }
        tasks.push(t);
      });
    }

    /* ---- Último recurso: el método antiguo (todas las entregas de los cursos) ---- */
    if (!events && courseIds.length) {
      source = 'legacy';
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

    if (!events) try {
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
      source: source || 'legacy',
      sourceError: sourceError,
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
