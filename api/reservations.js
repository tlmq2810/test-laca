// Vercel Serverless Function: POST /api/reservations
// Configure RESEND_API_KEY, BOOKING_TO_EMAIL and BOOKING_FROM_EMAIL in
// Vercel → Project → Settings → Environment Variables (see .env.example).
import { handleReservation, clientIp } from '../lib/reservation.js';

async function readBody(req) {
  if (typeof req.body === 'string') return req.body;
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20_000) break;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  const headers = { get: name => { const v = req.headers[name.toLowerCase()]; return Array.isArray(v) ? v[0] : v || null; } };
  const result = await handleReservation({
    method: req.method,
    headers,
    bodyText: req.method === 'POST' ? await readBody(req) : '',
    ip: clientIp(headers, req.socket?.remoteAddress)
  }, process.env);
  for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
  res.status(result.status).send(result.body);
}
