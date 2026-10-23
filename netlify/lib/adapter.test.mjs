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

console.log('\n' + pass + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
