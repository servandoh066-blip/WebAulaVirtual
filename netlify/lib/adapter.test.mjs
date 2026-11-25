// Comprueba el adaptador Netlify <-> Vercel: monta una Request, llama al handler
// original de api/*.js y verifica la Response resultante (incluida la autenticación).
import { strict as assert } from 'node:assert';
import { makeReq, makeRes, toResponse } from './adapter.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Credenciales FICTICIAS: el test no debe contener las credenciales reales.
// El escáner de secretos de Netlify bloquea el build si aparecen en el repo.
const TEST_USER = 'demo-user';
const TEST_PASS = 'demo-pass-123';
const TEST_B64 = Buffer.from(TEST_USER + ':' + TEST_PASS, 'utf8').toString('base64');

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

// --- el adaptador construye req/res compatibles ---
{
  const req = new Request('http://x/api/data', {
    method: 'POST',
    headers: { authorization: 'Basic ' + TEST_B64, 'content-type': 'application/json' },
    body: JSON.stringify({ notes: { DWEC: 'hola' } })
  });
  const body = await req.text();
  const r = makeReq(req, body);
  ok('makeReq: método', r.method === 'POST');
  ok('makeReq: cabeceras en minúscula', r.headers.authorization === 'Basic ' + TEST_B64);
  ok('makeReq: body de texto', r.body === body);
  ok('makeReq: ruta', r.url === '/api/data');
}

// --- un 401 NO lleva WWW-Authenticate ---
// Si lo llevase, Chrome y Edge abren su diálogo nativo de usuario/contraseña
// encima de la app y el usuario se queda atrapado sin poder entrar.
{
  const res = makeRes();
  res.statusCode = 401;
  res.end('401 Unauthorized');
  const out = toResponse(res);
  ok('401: estado', out.status === 401);
  ok('401: sin reto Basic (no abre el diálogo del navegador)', out.headers.get('www-authenticate') === null);
}

// --- una respuesta JSON se serializa bien ---
{
  const res = makeRes();
  res.setHeader('Cache-Control', 'no-store');
  res.statusCode = 200;
  res.json({ ok: true, n: 3 });
  const out = toResponse(res);
  ok('json: estado', out.status === 200);
  ok('json: content-type', /application\/json/.test(out.headers.get('content-type') || ''));
  const j = await out.json();
  ok('json: contenido', j.ok === true && j.n === 3);
  ok('json: cabecera propia', out.headers.get('cache-control') === 'no-store');
}

// --- el handler real de api/data.js funciona a través del adaptador ---
{
  process.env.AUTH_USER = TEST_USER;
  process.env.AUTH_PASS = TEST_PASS;
  const handler = require('./../../api/data.js');

  // sin credenciales -> 401
  const req1 = new Request('http://x/api/data');
  const res1 = makeRes();
  await handler(makeReq(req1, undefined), res1);
  ok('api/data sin auth -> 401', toResponse(res1).status === 401);
  ok('api/data 401 sin WWW-Authenticate', toResponse(res1).headers.get('www-authenticate') === null);

  // con credenciales pero sin Upstash -> 500 con mensaje claro
  const req2 = new Request('http://x/api/data', {
    headers: { authorization: 'Basic ' + TEST_B64 }
  });
  const res2 = makeRes();
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  const savedLocal = process.env.LOCAL_DATA_FILE;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.LOCAL_DATA_FILE;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await handler(makeReq(req2, undefined), res2);
  const out2 = toResponse(res2);
  ok('api/data con auth y sin Upstash -> 500', out2.status === 500);
  const j2 = await out2.json();
  ok('  y lo explica', /almacen|almacén/i.test(j2.error || '') && /blobs|upstash/i.test(j2.detalle || ''));
  if (savedUrl) process.env.UPSTASH_REDIS_REST_URL = savedUrl;
  if (savedTok) process.env.UPSTASH_REDIS_REST_TOKEN = savedTok;
  if (savedLocal) process.env.LOCAL_DATA_FILE = savedLocal;
}

// --- la contraseña con acentos viaja en UTF-8 (btoa() sola fallaría) ---
// btoa() lanza InvalidCharacterError con 'ñ' o 'á'; la app usa b64utf8(),
// que produce exactamente esto. El servidor debe aceptarlo.
{
  process.env.AUTH_USER = TEST_USER;
  process.env.AUTH_PASS = 'contraseña-ñ';
  const handler = require('./../../api/data.js');
  const b64 = Buffer.from(TEST_USER + ':contraseña-ñ', 'utf8').toString('base64');
  const req = new Request('http://x/api/data', { headers: { authorization: 'Basic ' + b64 } });
  const res = makeRes();
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  await handler(makeReq(req, undefined), res);
  // sin Upstash devuelve 500; lo que importa es que la autenticación NO falle
  ok('auth con contraseña acentuada (UTF-8)', toResponse(res).status !== 401);
  if (savedUrl) process.env.UPSTASH_REDIS_REST_URL = savedUrl;
  if (savedTok) process.env.UPSTASH_REDIS_REST_TOKEN = savedTok;
  process.env.AUTH_PASS = TEST_PASS;
}

// --- el stream de req imita al de Node: 'data' y luego 'end' ---
// (sin esto, readBody() de api/data.js se queda colgada si el body va vacío)
{
  async function leerStream(body) {
    const req = new Request('http://x/api/data', { method: 'POST' });
    const r = makeReq(req, body);
    const eventos = [];
    return await Promise.race([
      new Promise(function (resolve, reject) {
        r.on('data', function (c) { eventos.push('data:' + c.length); });
        r.on('end', function () { eventos.push('end'); resolve(eventos.join(',')); });
        r.on('error', reject);
      }),
      new Promise(function (resolve) { setTimeout(function () { resolve('TIMEOUT'); }, 2000); })
    ]);
  }
  ok('stream con body vacío: emite end', await leerStream('') === 'end');
  ok('stream con body: emite data y end', await leerStream('hola') === 'data:4,end');
}

// --- un POST con el cuerpo vacío no deja la función colgada ---
{
  process.env.AUTH_USER = TEST_USER;
  process.env.AUTH_PASS = TEST_PASS;
  const handler = require('./../../api/data.js');
  const req = new Request('http://x/api/data', {
    method: 'POST',
    headers: { authorization: 'Basic ' + TEST_B64, 'content-type': 'application/json' }
  });
  const res = makeRes();
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  // Upstash falso: falla rápido, así la respuesta no depende de la red
  process.env.UPSTASH_REDIS_REST_URL = 'http://127.0.0.1:1';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'x';
  const resultado = await Promise.race([
    handler(makeReq(req, ''), res).then(function () { return 'respondio'; }),
    new Promise(function (r) { setTimeout(function () { r('COLGADO'); }, 3000); })
  ]);
  ok('api/data con body vacío no se cuelga', resultado === 'respondio');
  if (savedUrl) process.env.UPSTASH_REDIS_REST_URL = savedUrl; else delete process.env.UPSTASH_REDIS_REST_URL;
  if (savedTok) process.env.UPSTASH_REDIS_REST_TOKEN = savedTok; else delete process.env.UPSTASH_REDIS_REST_TOKEN;
}

// --- almacen local en fichero: es el que se usa en localhost ---
{
  process.env.AUTH_USER = TEST_USER;
  process.env.AUTH_PASS = TEST_PASS;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const rutaMod = await import('node:path');
  const carpeta = await fsp.mkdtemp(rutaMod.join(os.tmpdir(), 'aula-'));
  process.env.LOCAL_DATA_FILE = rutaMod.join(carpeta, 'datos.json');
  const handlerData = require('./../../api/data.js');

  const peticionPost = new Request('http://x/api/data', {
    method: 'POST',
    headers: { authorization: 'Basic ' + TEST_B64, 'content-type': 'application/json' },
    body: JSON.stringify({ notes: { DWEC: 'hola' }, tasks: [{ id: 'a1', t: 'Tarea 1', s: 'DWEC' }] })
  });
  const resPost = makeRes();
  await handlerData(makeReq(peticionPost, await peticionPost.text()), resPost);
  ok('almacen local: POST -> 200', toResponse(resPost).status === 200);

  const peticionGet = new Request('http://x/api/data', {
    headers: { authorization: 'Basic ' + TEST_B64 }
  });
  const resGet = makeRes();
  await handlerData(makeReq(peticionGet, undefined), resGet);
  const salida = toResponse(resGet);
  const datos = await salida.json();
  ok('almacen local: GET -> 200', salida.status === 200);
  ok('almacen local: guarda las notas', datos.notes && datos.notes.DWEC === 'hola');
  ok(
    'almacen local: guarda las tareas',
    Array.isArray(datos.tasks) && datos.tasks.length === 1 && datos.tasks[0].t === 'Tarea 1'
  );

  delete process.env.LOCAL_DATA_FILE;
  await fsp.rm(carpeta, { recursive: true, force: true });
}

// --- cuentas: el token se valida contra Moodle y cada alumno tiene sus datos ---
{
  const os = await import('node:os');
  const fsp = await import('node:fs/promises');
  const rutaMod = await import('node:path');
  const carpeta = await fsp.mkdtemp(rutaMod.join(os.tmpdir(), 'aula-cuentas-'));
  process.env.LOCAL_DATA_FILE = rutaMod.join(carpeta, 'datos.json');
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.AUTH_USER;
  delete process.env.AUTH_PASS;
  const TOKEN_DUENO = 'A'.repeat(32);
  const TOKEN_ALUMNO = 'B'.repeat(32);
  const TOKEN_FALSO = 'C'.repeat(32);
  process.env.MOODLE_TOKEN = TOKEN_DUENO;
  const BASE = 'https://aula.universidad.example/';
  const usuarios = { [TOKEN_DUENO]: 1, [TOKEN_ALUMNO]: 2 };

  // Moodle falso: solo conoce dos tokens; para el resto responde invalidtoken.
  const fetchReal = globalThis.fetch;
  const fetchMoodle = async function (url, opts) {
    const u = String(url);
    if (!u.startsWith(BASE)) throw new Error('fetch inesperado: ' + u);
    const p = new URLSearchParams(String(opts && opts.body));
    const id = usuarios[p.get('wstoken')];
    if (!id) return new Response(JSON.stringify({ exception: 'moodle_exception', errorcode: 'invalidtoken', message: 'Invalid token' }), { status: 200 });
    if (p.get('wsfunction') === 'core_webservice_get_site_info') {
      return new Response(JSON.stringify({ userid: id, fullname: 'Alumno ' + id, username: 'u' + id }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };
  globalThis.fetch = fetchMoodle;

  const handlerData = require('./../../api/data.js');
  const handlerEmails = require('./../../api/emails.js');
  async function llamar(handler, metodo, token, base, cuerpo) {
    const headers = { 'content-type': 'application/json' };
    if (token) headers['x-moodle-token'] = token;
    if (base) headers['x-moodle-base'] = base;
    const init = { method: metodo, headers: headers };
    if (cuerpo !== undefined) init.body = JSON.stringify(cuerpo);
    const r = new Request('http://x/api/x', init);
    const res = makeRes();
    await handler(makeReq(r, cuerpo !== undefined ? await r.clone().text() : undefined), res);
    const out = toResponse(res);
    let json = null;
    try { json = await out.json(); } catch (e) { /* sin cuerpo JSON */ }
    return { status: out.status, json: json };
  }

  const falso = await llamar(handlerData, 'GET', TOKEN_FALSO, BASE);
  ok('token inventado (no existe en Moodle) -> 401', falso.status === 401);
  const corto = await llamar(handlerData, 'GET', 'abc', BASE);
  ok('token con formato inválido -> 401', corto.status === 401);
  const sinBase = await llamar(handlerData, 'GET', TOKEN_ALUMNO, '');
  ok('sin URL del aula -> 400', sinBase.status === 400);
  const interna = await llamar(handlerData, 'GET', TOKEN_ALUMNO, 'https://localhost/moodle');
  ok('URL interna (SSRF) rechazada -> 400', interna.status === 400);
  const ip = await llamar(handlerData, 'GET', TOKEN_ALUMNO, 'https://169.254.169.254/');
  ok('IP literal rechazada -> 400', ip.status === 400);
  const http = await llamar(handlerData, 'GET', TOKEN_ALUMNO, 'http://aula.universidad.example/');
  ok('http sin cifrar rechazado -> 400', http.status === 400);

  // El propietario guarda datos; el alumno NO los ve y los suyos no pisan los del dueño.
  const pDueno = await llamar(handlerData, 'POST', TOKEN_DUENO, BASE, { notes: { DWEC: 'privado del dueño' }, tasks: [{ id: 'a1', t: 'Mi tarea', s: 'DWEC' }], generalNote: 'secreto' });
  ok('propietario guarda -> 200', pDueno.status === 200);
  const gAlumno = await llamar(handlerData, 'GET', TOKEN_ALUMNO, BASE);
  ok('alumno nuevo: 200', gAlumno.status === 200);
  ok('alumno nuevo empieza SIN datos del propietario',
    gAlumno.json && gAlumno.json.tasks.length === 0 && !gAlumno.json.notes.DWEC && gAlumno.json.generalNote === '');
  await llamar(handlerData, 'POST', TOKEN_ALUMNO, BASE, { notes: { DWEC: 'mío' }, generalNote: 'nota alumno' });
  const gDueno = await llamar(handlerData, 'GET', TOKEN_DUENO, BASE);
  ok('los datos del propietario siguen intactos', gDueno.json.notes.DWEC === 'privado del dueño' && gDueno.json.tasks.length === 1);
  const gAlumno2 = await llamar(handlerData, 'GET', TOKEN_ALUMNO, BASE);
  ok('el alumno recupera lo suyo', gAlumno2.json.notes.DWEC === 'mío' && gAlumno2.json.generalNote === 'nota alumno');

  // Avisos: el correo (Composio) es del propietario y no se consulta para el alumno.
  process.env.COMPOSIO_API_KEY = 'clave-falsa';
  let composioLlamado = false;
  globalThis.fetch = async function (url, opts) {
    if (String(url).indexOf('composio') >= 0) { composioLlamado = true; return new Response(JSON.stringify({ data: { messages: [] } }), { status: 200 }); }
    return fetchMoodle(url, opts);
  };
  const eAlumno = await llamar(handlerEmails, 'GET', TOKEN_ALUMNO, BASE);
  ok('avisos del alumno: 200 sin depender del correo', eAlumno.status === 200 && Array.isArray(eAlumno.json.annots));
  ok('avisos del alumno: NO consulta el correo del propietario', composioLlamado === false);
  const eDueno = await llamar(handlerEmails, 'GET', TOKEN_DUENO, BASE);
  ok('avisos del propietario: sí consulta el correo', eDueno.status === 200 && composioLlamado === true);
  delete process.env.COMPOSIO_API_KEY;
  const eSinClave = await llamar(handlerEmails, 'GET', TOKEN_ALUMNO, BASE);
  ok('sin COMPOSIO_API_KEY los avisos ya no dan 500', eSinClave.status === 200);

  globalThis.fetch = fetchReal;
  delete process.env.MOODLE_TOKEN;
  delete process.env.LOCAL_DATA_FILE;
  await fsp.rm(carpeta, { recursive: true, force: true });
}

// --- tareas: salen de «Próximos eventos», no de todas las entregas del curso ---
{
  const TOKEN = 'D'.repeat(32);
  const BASE = 'https://aula2.universidad.example/';
  const ahora = Math.floor(Date.now() / 1000);
  let sinUpcoming = false;
  const llamadas = [];
  const fetchReal = globalThis.fetch;
  globalThis.fetch = async function (url, opts) {
    const p = new URLSearchParams(String(opts && opts.body));
    const fn = p.get('wsfunction');
    llamadas.push(fn);
    const J = function (o) { return new Response(JSON.stringify(o), { status: 200 }); };
    if (fn === 'core_webservice_get_site_info') return J({ userid: 7, fullname: 'Alumna', username: 'a7' });
    if (fn === 'core_enrol_get_users_courses') return J([{ id: 10, fullname: 'Bases de datos', shortname: 'BD' }]);
    if (fn === 'core_enrol_get_enrolled_users') return J([]);
    if (fn === 'core_course_get_courses_by_field') return J({ courses: [{ id: 10, contacts: [{ id: 3, fullname: 'Profesora Ejemplo' }] }] });
    if (fn === 'core_calendar_get_calendar_upcoming_view') {
      if (sinUpcoming) return J({ exception: 'webservice_access_exception', errorcode: 'accessexception', message: 'no permitido' });
      return J({ events: [
        { id: 1, name: 'Práctica 3', modulename: 'assign', instance: 55, eventtype: 'due', timestart: ahora + 86400, url: BASE + 'mod/assign/view.php?id=900', course: { id: 10, fullname: 'Bases de datos' },
          description: '<h3>Pasos</h3><ol><li>Crea la clave</li><li>Firma el &quot;documento&quot;</li></ol><script>alert(1)</script>',
          action: { name: 'Engadir entrega', url: BASE + 'mod/assign/view.php?id=900&action=editsubmission', actionable: true } },
        { id: 2, name: 'Calificar práctica 3', modulename: 'assign', instance: 55, eventtype: 'gradingdue', timestart: ahora + 90000, course: { id: 10 } },
        { id: 3, name: 'Cuestionario tema 2', modulename: 'quiz', instance: 8, eventtype: 'close', timestart: ahora + 172800, url: BASE + 'mod/quiz/view.php?id=901', course: { id: 10, fullname: 'Bases de datos' } }
      ] });
    }
    if (fn === 'core_user_get_user_preferences') return J({ preferences: [{ name: 'calendar_lookahead', value: '14' }] });
    if (fn === 'core_calendar_get_calendar_events') {
      return J({ events: [{ id: 4, name: 'Entrega final', modulename: 'assign', instance: 60, eventtype: 'due', timestart: ahora + 3600, courseid: 10 }] });
    }
    if (fn === 'mod_assign_get_submission_status') return J({ lastattempt: { submission: { status: p.get('assignid') === '55' ? 'submitted' : 'new' } } });
    if (fn === 'mod_assign_get_assignments') return J({ courses: [{ id: 10, assignments: [{ id: 99, cmid: 5, name: 'Tarea vieja de hace meses', duedate: ahora - 200 * 86400 }] }] });
    return J([]);
  };
  const handlerTasks = require('./../../api/tasks.js');
  async function pedir() {
    const r = new Request('http://x/api/tasks', { headers: { 'x-moodle-token': TOKEN, 'x-moodle-base': BASE } });
    const res = makeRes();
    await handlerTasks(makeReq(r, undefined), res);
    const out = toResponse(res);
    return { status: out.status, json: await out.json() };
  }

  const a = await pedir();
  const nombres = (a.json.tasks || []).map(function (t) { return t.t; });
  ok('tareas: 200', a.status === 200);
  ok('tareas: fuente = próximos eventos', a.json.source === 'upcoming');
  ok('tareas: solo lo que muestra Moodle', nombres.join('|') === 'Práctica 3|Cuestionario tema 2');
  ok('tareas: sin la entrega vieja de hace meses', nombres.indexOf('Tarea vieja de hace meses') < 0);
  ok('tareas: sin el evento de calificación (profesorado)', nombres.indexOf('Calificar práctica 3') < 0);
  ok('tareas: entrega con id estable y estado entregada', a.json.tasks[0].id === 'a55' && a.json.tasks[0].done === 1);
  ok('tareas: usa el enlace correcto que da Moodle', a.json.tasks[0].u === BASE + 'mod/assign/view.php?id=900');
  ok('tareas: trae la descripción en texto plano', a.json.tasks[0].ds === 'Pasos\n• Crea la clave\n• Firma el "documento"');
  ok('tareas: la descripción no lleva HTML ni scripts', !/[<>]|alert/.test(a.json.tasks[0].ds));
  ok('tareas: tipo de evento', a.json.tasks[0].k === 'Evento de curso');
  ok('tareas: acción de Moodle (Engadir entrega)', a.json.tasks[0].a && a.json.tasks[0].a.n === 'Engadir entrega');
  ok('tareas: sin acción si Moodle no la da', !a.json.tasks[1].a);
  ok('tareas: profesor desde los contactos del curso', a.json.tasks[0].p === 'Profesora Ejemplo' && a.json.teachers['Bases de datos'] === 'Profesora Ejemplo');

  sinUpcoming = true;
  const b = await pedir();
  ok('respaldo: fuente = calendario', b.json.source === 'calendar' && /próximos eventos/.test(b.json.sourceError));
  ok('respaldo: lee la ventana del calendario', b.json.tasks.length === 1 && b.json.tasks[0].t === 'Entrega final' && b.json.tasks[0].done === 0);
  ok('respaldo: enlace al día del calendario (no view.php?id=instancia)', /calendar\/view\.php\?view=day/.test(b.json.tasks[0].u));
  globalThis.fetch = fetchReal;
}

console.log('\n' + pass + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
