// /api/data -> api/data.js (lee y guarda los datos del usuario)
import { getStore } from '@netlify/blobs';
import handler from '../../api/data.js';
import { makeReq, makeRes, toResponse } from '../lib/adapter.js';

// El almacen se crea una sola vez por instancia de la funcion.
// El import de arriba es estatico a proposito: el empaquetador de Netlify
// (nft) sigue los imports desde el punto de entrada, y con un `require` suelto
// dentro de api/data.js el paquete no llegaba al bundle (500 en produccion).
try {
  handler.setStore(getStore({ name: 'aulavirtual', consistency: 'strong' }));
} catch (e) {
  // Sin contexto de Blobs (desarrollo en localhost): api/data.js usara otro
  // almacen (fichero local o Upstash) o devolvera un 500 explicativo.
}

export default async function (request) {
  const raw = await request.text();
  const req = makeReq(request, raw);
  const res = makeRes();
  await handler(req, res);
  return toResponse(res);
}

export const config = { path: '/api/data' };
