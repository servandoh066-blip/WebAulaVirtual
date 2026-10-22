// /api/data -> api/data.js (lee y guarda los datos del usuario)
import handler from '../../api/data.js';
import { makeReq, makeRes, toResponse } from '../lib/adapter.js';

export default async function (request) {
  const raw = await request.text();
  const req = makeReq(request, raw);
  const res = makeRes();
  await handler(req, res);
  return toResponse(res);
}

export const config = { path: '/api/data' };
