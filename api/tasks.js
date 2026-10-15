const WS = 'https://centros.edu.xunta.gal/iesteis/aulavirtual/webservice/rest/server.php';
const BASE = 'https://centros.edu.xunta.gal/iesteis/aulavirtual/';

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

async function ws(fn, params) {
  const body = new URLSearchParams();
  body.set('wstoken', process.env.MOODLE_TOKEN);
  body.set('wsfunction', fn);
  body.set('moodlewsrestformat', 'json');
  Object.keys(params || {}).forEach(function (k) {
    appendParams(body, k, params[k]);
  });
  const r = await fetch(WS, { method: 'POST', body, signal: AbortSignal.timeout(12000) });
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

async function calendarEvents(nowSec, courseIds) {
  const params = {
    options: {
      userevents: 1,
      siteevents: 1,
      timestart: nowSec - 172800,
      timeend: nowSec + 7776000
    }
  };
  if (courseIds.length) params.events = { courseids: courseIds };
  const r = await ws('core_calendar_get_calendar_events', params);
  return (r && r.events) || [];
}

function eventUrl(e) {
  if (e.modulename && e.instance) return BASE + 'mod/' + e.modulename + '/view.php?id=' + e.instance;
  if (e.courseid) return BASE + 'course/view.php?id=' + e.courseid;
  return BASE;
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.statusCode = 405;
    return res.end('405');
  }
  if (!checkAuth(req)) return unauthorized(res);
  if (!process.env.MOODLE_TOKEN) {
    res.statusCode = 500;
    return res.json({ error: 'MOODLE_TOKEN no configurado' });
  }

  try {
    const info = await ws('core_webservice_get_site_info', {});
    const me = info.userid;
    const nowSec = Math.floor(Date.now() / 1000);

    const courses = await ws('core_enrol_get_users_courses', { userid: me });
    const courseIds = courses.map(function (c) { return c.id; });
    const courseNames = {};
    courses.forEach(function (c) { courseNames[c.id] = c.fullname || c.shortname; });

    const tasks = [];

    if (courseIds.length) {
      const byCourse = await ws('mod_assign_get_assignments', { courseids: courseIds });
      const assignments = [];
      (byCourse.courses || []).forEach(function (c) {
        (c.assignments || []).forEach(function (a) {
          a._courseId = c.id;
          a._courseName = courseNames[c.id] || c.fullname || '';
          assignments.push(a);
        });
      });

      const candidates = assignments.filter(function (a) {
        const duedate = a.duedate || 0;
        const from = a.allowsubmissionsfromdate || 0;
        if (duedate > 0) return duedate > nowSec - 31536000;
        return from > nowSec - 7776000;
      });

      const delivered = await mapLimit(candidates, 6, async function (a) {
        try {
          const st = await ws('mod_assign_get_submission_status', {
            assignid: a.id,
            userid: me
          });
          return isDelivered(st);
        } catch (e) {
          return false;
        }
      });

      candidates.forEach(function (a, i) {
        if (delivered[i]) return;
        const duedate = a.duedate || 0;
        if (!duedate && a.nosubmissions) return;
        tasks.push({
          s: a._courseName,
          t: a.name,
          u: BASE + 'mod/assign/view.php?id=' + a.cmid,
          d: duedate > 0 ? new Date(duedate * 1000).toISOString() : null
        });
      });
    }

    try {
      const events = await calendarEvents(nowSec, courseIds);
      const seen = {};
      tasks.forEach(function (t) { seen[t.t] = true; });
      events.forEach(function (e) {
        if ((e.modulename || '') === 'assign') return;
        if (e.timestart < nowSec - 172800) return;
        if (seen[e.name]) return;
        seen[e.name] = true;
        tasks.push({
          s: courseNames[e.courseid] || '',
          t: e.name,
          u: eventUrl(e),
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
    return res.json({ tasks: tasks, fetchedAt: nowSec, user: info.fullname });
  } catch (err) {
    res.statusCode = 502;
    return res.json({ error: String(err && err.message ? err.message : err) });
  }
};
