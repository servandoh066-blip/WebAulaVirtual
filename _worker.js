import handlerData from './api/data.js';
import handlerTasks from './api/tasks.js';
import handlerEmails from './api/emails.js';

/* La autenticacion no se resuelve aqui: cada funcion de api/*.js comprueba
   cabecera X-Moodle-Token (pantalla de acceso) o Basic (antiguo). Si este
   worker volviera a exigir Basic por su cuenta, la entrada con token de
   Moodle devolveria siempre 401 y la app mostraria "El token no es valido
   o ha caducado". */

/* Secrets del despliegue hacia process.env, que es donde api/*.js los lee.
   Solo las claves definidas: asignar undefined a process.env deja el texto
   "undefined" y romperia el acceso heredado con Basic. */
function copiarEnv(env) {
  [
    'AUTH_USER',
    'AUTH_PASS',
    'MOODLE_TOKEN',
    'COMPOSIO_API_KEY',
    'COMPOSIO_USER_ID',
    'BLOB_READ_WRITE_TOKEN',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN'
  ].forEach(function (clave) {
    if (env[clave] !== undefined && env[clave] !== null) process.env[clave] = String(env[clave]);
  });
}

async function toNodeReqRes(request, env) {
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
  
  const bodyBuffer = request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
  const body = bodyBuffer ? Buffer.from(bodyBuffer) : undefined;
  
  const req = {
    method: request.method,
    url: url.pathname + url.search,
    headers,
    body,
    query: Object.fromEntries(url.searchParams),
    on: () => req,
    socket: {}
  };
  
  let statusCode = 200;
  const resHeaders = {};
  const chunks = [];
  
  const res = {
    statusCode: 200,
    setHeader: (k, v) => { resHeaders[k.toLowerCase()] = v; },
    getHeader: (k) => resHeaders[k.toLowerCase()],
    end: (data) => {
      if (data) chunks.push(data);
      statusCode = res.statusCode || statusCode;
    },
    json: (obj) => {
      resHeaders['content-type'] = 'application/json; charset=utf-8';
      res.statusCode = res.statusCode || 200;
      chunks.push(JSON.stringify(obj));
      statusCode = res.statusCode;
    },
    write: (data) => { if (data) chunks.push(data); }
  };
  
  return { req, res, getResponse: () => new Response(chunks.join(''), { status: res.statusCode || statusCode, headers: resHeaders }) };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Inyectar KV binding en global para api/data.js
    try {
      if (env.DATA) {
        if (typeof globalThis !== 'undefined') {
          globalThis.__CF_KV_DATA__ = env.DATA;
          globalThis.DATA = env.DATA;
        }
        if (typeof global !== 'undefined') {
          global.__CF_KV_DATA__ = env.DATA;
          global.DATA = env.DATA;
        }
      }
    } catch (e) {}
    
    if (url.pathname.startsWith('/api/')) {
      const path = url.pathname.replace('/api/', '').replace(/\/$/, '');

      try {
        if (path === 'data') {
          const { req, res, getResponse } = await toNodeReqRes(request, env);
          copiarEnv(env);
          if (env.DATA) {
            process.env.DATA = env.DATA;
            process.env.__CF_KV_DATA__ = env.DATA;
            try {
              globalThis.__CF_KV_DATA__ = env.DATA;
              globalThis.DATA = env.DATA;
              global.__CF_KV_DATA__ = env.DATA;
              global.DATA = env.DATA;
            } catch (e) {}
          }
          
          await handlerData(req, res);
          return getResponse();
        }
        
        if (path === 'tasks') {
          const { req, res, getResponse } = await toNodeReqRes(request, env);
          copiarEnv(env);

          await handlerTasks(req, res);
          return getResponse();
        }

        if (path === 'emails') {
          const { req, res, getResponse } = await toNodeReqRes(request, env);
          copiarEnv(env);

          await handlerEmails(req, res);
          return getResponse();
        }
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { 
          status: 500, 
          headers: { 'content-type': 'application/json' } 
        });
      }
      
      return new Response('Not Found', { status: 404 });
    }
    
    return env.ASSETS.fetch(request);
  }
}