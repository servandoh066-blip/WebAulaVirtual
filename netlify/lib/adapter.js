// Adaptador Netlify <-> Vercel.
// Netlify Functions v2 usa (Request) => Response (estilo Web API).
// Nuestras funciones están escritas al estilo Vercel/Node (req, res),
// así que aquí montamos un `req` y un `res` compatibles, llamamos al
// handler original y devolvemos un `Response`. Así no hay que tocar
// la lógica de api/*.js (ni sus tests).

function makeReq(request, body) {
  const url = new URL(request.url);
  const headers = {};
  request.headers.forEach(function (v, k) { headers[k.toLowerCase()] = v; });
  return {
    method: request.method,
    url: url.pathname + url.search,
    headers: headers,
    body: body,
    query: Object.fromEntries(url.searchParams),
    on: function () {},        // el handler sólo los usa si no hay body
    destroy: function () {}
  };
}

function makeRes() {
  const state = { statusCode: 200, headers: {}, chunks: [], ended: false };
  function finish(value) {
    if (state.ended) return;
    state.ended = true;
    state.chunks.push(value === undefined || value === null ? '' : String(value));
  }
  const res = {
    statusCode: 200,
    setHeader: function (k, v) { state.headers[k] = v; },
    getHeader: function (k) { return state.headers[k]; },
    end: function (value) { state.statusCode = res.statusCode; finish(value); },
    json: function (obj) {
      state.statusCode = res.statusCode;
      state.headers['Content-Type'] = state.headers['Content-Type'] || 'application/json; charset=utf-8';
      finish(JSON.stringify(obj));
    },
    write: function (value) { finish(value); }
  };
  res.__state = state;
  return res;
}

// Monta el Response de salida con el estado acumulado en `res`.
function toResponse(res) {
  const s = res.__state;
  const headers = Object.assign({}, s.headers);
  if (s.statusCode === 401 && !headers['WWW-Authenticate']) {
    headers['WWW-Authenticate'] = 'Basic realm="Tareas Aula Virtual", charset="UTF-8"';
  }
  return new Response(s.chunks.join(''), { status: s.statusCode, headers: headers });
}

module.exports = { makeReq, makeRes, toResponse };
