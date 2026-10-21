// /api/emails -> api/emails.js (correos de la Xunta vía Composio)
import { createRequire } from 'node:module';
import { makeReq, makeRes, toResponse } from '../lib/adapter.js';

const require = createRequire(import.meta.url);
const handler = require('../../api/emails.js');

export default async function (request) {
  const raw = request.method === 'POST' ? await request.text() : undefined;
  const req = makeReq(request, raw);
  const res = makeRes();
  await handler(req, res);
  return toResponse(res);
}

export const config = { path: '/api/emails' };
