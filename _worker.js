import handlerData from './api/data.js';
import handlerTasks from './api/tasks.js';
import handlerEmails from './api/emails.js';

function unauthorized(resHeaders) {
  const headers = new Headers(resHeaders);
  return new Response('401 Unauthorized', { status: 401, headers });
}

function checkAuth(request, env) {
  const user = env.AUTH_USER;
  const pass = env.AUTH_PASS;
  if (!user || !pass) return false;
  const header = request.headers.get('authorization') || '';
  if (!header.startsWith('Basic ')) return false;
  try {
    const decoded = atob(header.slice(6));
    const idx = decoded.indexOf(':');
    if (idx < 0) return false;
    return decoded.slice(0, idx) === user && decoded.slice(idx + 1) === pass;
  } catch {
    return false;
  }
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
      
      if (path === 'data' || path === 'tasks') {
        if (!checkAuth(request, env)) {
          return new Response('401 Unauthorized', { status: 401 });
        }
      }
      
      try {
        if (path === 'data') {
          const { req, res, getResponse } = await toNodeReqRes(request, env);
          process.env.AUTH_USER = env.AUTH_USER;
          process.env.AUTH_PASS = env.AUTH_PASS;
          process.env.MOODLE_TOKEN = env.MOODLE_TOKEN;
          process.env.COMPOSIO_API_KEY = env.COMPOSIO_API_KEY;
          process.env.COMPOSIO_USER_ID = env.COMPOSIO_USER_ID;
          process.env.BLOB_READ_WRITE_TOKEN = env.BLOB_READ_WRITE_TOKEN;
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
          process.env.AUTH_USER = env.AUTH_USER;
          process.env.AUTH_PASS = env.AUTH_PASS;
          process.env.MOODLE_TOKEN = env.MOODLE_TOKEN;
          
          await handlerTasks(req, res);
          return getResponse();
        }
        
        if (path === 'emails') {
          const { req, res, getResponse } = await toNodeReqRes(request, env);
          process.env.AUTH_USER = env.AUTH_USER;
          process.env.AUTH_PASS = env.AUTH_PASS;
          process.env.COMPOSIO_API_KEY = env.COMPOSIO_API_KEY;
          process.env.COMPOSIO_USER_ID = env.COMPOSIO_USER_ID;
          
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