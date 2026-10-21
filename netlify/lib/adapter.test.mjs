// Comprueba el adaptador Netlify <-> Vercel: monta una Request, llama al handler
// original de api/*.js y verifica la Response resultante (incluida la autenticación).
import { strict as assert } from 'node:assert';
import { makeReq, makeRes, toResponse } from './adapter.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

let pass = 0, fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log('ok   ' + name); }
  else { fail++; console.log('FAIL ' + name); }
}

// --- el adaptador construye req/res compatibles ---
{
  const req = new Request('http://x/api/data', {
    method: 'POST',
    headers: { authorization: 'Basic dGFyZWFzOnRlaXMyMDI2', 'content-type': 'application/json' },
    body: JSON.stringify({ notes: { DWEC: 'hola' } })
  });
  const body = await req.text();
  const r = makeReq(req, body);
  ok('makeReq: método', r.method === 'POST');
  ok('makeReq: cabeceras en minúscula', r.headers.authorization === 'Basic dGFyZWFzOnRlaXMyMDI2');
  ok('makeReq: body de texto', r.body === body);
  ok('makeReq: ruta', r.url === '/api/data');
}

// --- una respuesta 401 lleva WWW-Authenticate ---
{
  const res = makeRes();
  res.statusCode = 401;
  res.end('401 Unauthorized');
  const out = toResponse(res);
  ok('401: estado', out.status === 401);
  ok('401: pide autenticación', /Basic realm=/.test(out.headers.get('www-authenticate') || ''));
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
  process.env.AUTH_USER = 'tareas';
  process.env.AUTH_PASS = 'teis2026';
  const handler = require('./../../api/data.js');

  // sin credenciales -> 401
  const req1 = new Request('http://x/api/data');
  const res1 = makeRes();
  await handler(makeReq(req1, undefined), res1);
  ok('api/data sin auth -> 401', toResponse(res1).status === 401);

  // con credenciales pero sin Upstash -> 500 con mensaje claro
  const req2 = new Request('http://x/api/data', {
    headers: { authorization: 'Basic ' + Buffer.from('tareas:teis2026').toString('base64') }
  });
  const res2 = makeRes();
  const savedUrl = process.env.UPSTASH_REDIS_REST_URL;
  const savedTok = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.BLOB_READ_WRITE_TOKEN;
  await handler(makeReq(req2, undefined), res2);
  const out2 = toResponse(res2);
  ok('api/data con auth y sin Upstash -> 500', out2.status === 500);
  const j2 = await out2.json();
  ok('  y lo explica', /UPSTASH/.test(j2.error || ''));
  if (savedUrl) process.env.UPSTASH_REDIS_REST_URL = savedUrl;
  if (savedTok) process.env.UPSTASH_REDIS_REST_TOKEN = savedTok;
}

console.log('\n' + pass + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
