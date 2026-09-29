// Netlify Function (alternative host): POST /api/reservations
// Environment variables are set in Netlify → Site configuration → Environment variables.
import { handleReservation, clientIp } from '../../lib/reservation.js';

export default async (request, context) => {
  const result = await handleReservation({
    method: request.method,
    headers: request.headers,
    bodyText: request.method === 'POST' ? await request.text() : '',
    ip: context?.ip || clientIp(request.headers)
  }, process.env);
  return new Response(result.body || null, { status: result.status, headers: result.headers });
};

export const config = { path: '/api/reservations' };
