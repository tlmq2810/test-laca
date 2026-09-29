/**
 * LACA 24 — reservation request core.
 *
 * Runtime-agnostic: no framework, no dependencies. Adapters for Vercel
 * (api/reservations.js), Netlify (netlify/functions/reservations.mjs) and the
 * local dev server (scripts/dev-server.mjs) all call handleReservation().
 *
 * A reservation is only a REQUEST. Nothing here checks table availability;
 * the restaurant confirms by phone after receiving the email.
 */
import { randomInt } from 'node:crypto';

/* 01. Business constants — keep in sync with the <form> in index.html. */
export const RESTAURANT = {
  name: 'LACA 24',
  phoneDisplay: '093 636 8363',
  phoneE164: '+84936368363',
  address: '24 Lý Quốc Sư, Hoàn Kiếm, Hà Nội',
  hours: '09:00 – 23:00 hằng ngày',
  timeZone: 'Asia/Ho_Chi_Minh'
};

const GUEST_VALUES = [...Array.from({ length: 20 }, (_, i) => String(i + 1)), '21-30', '31-50', '50+'];
export const GUEST_LABELS = Object.fromEntries(GUEST_VALUES.map(value => [value,
  value === '50+' ? 'Trên 50 khách' : `${value.replace('-', '–')} khách`]));

export const AREA_LABELS = {
  any: 'Để LACA sắp xếp',
  courtyard: 'Sân trong (ngoài trời)',
  hall: 'Sảnh lớn (có sân khấu)',
  brick: 'Khu tường gạch (trong nhà)'
};

export const OCCASION_LABELS = {
  casual: 'Ăn uống, gặp gỡ',
  birthday: 'Sinh nhật',
  reunion: 'Họp lớp / họp mặt',
  company: 'Liên hoan công ty',
  event: 'Sự kiện riêng',
  other: 'Khác'
};

// Arrival slots 09:00–22:00 (the venue closes at 23:00).
export const TIME_SLOTS = [];
for (let h = 9; h <= 22; h++) for (const m of ['00', '30']) if (!(h === 22 && m === '30')) TIME_SLOTS.push(`${String(h).padStart(2, '0')}:${m}`);

const MAX_DAYS_AHEAD = 120;
const MAX_BODY_BYTES = 10_000;
const MIN_FILL_MS = 2_500;

/* 02. Time helpers (restaurant timezone) */
export function hanoiNow(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: RESTAURANT.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { date: `${v.year}-${v.month}-${v.day}`, time: `${v.hour}:${v.minute}`, stamp: `${v.day}/${v.month}/${v.year} ${v.hour}:${v.minute}:${v.second}` };
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const toDisplayDate = iso => iso.split('-').reverse().join('/');

/* 03. Normalisation & validation */
const clean = (value, max) => String(value ?? '')
  .normalize('NFC')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .replace(/[\t ]+/g, ' ')
  .trim()
  .slice(0, max);

const singleLine = value => value.replace(/[\r\n]+/g, ' ');

export function normalizePhone(raw) {
  const compact = String(raw ?? '').replace(/[\s.()-]/g, '');
  if (!/^(?:(?:0|\+84|84)(?:[35789]\d{8}|2\d{9}))$/.test(compact)) return null;
  return compact.replace(/^(\+84|84)/, '0');
}

export const formatPhone = local => local.length === 10
  ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`
  : `${local.slice(0, 3)} ${local.slice(3, 7)} ${local.slice(7)}`;

export function validateReservation(input, now = hanoiNow()) {
  const errors = {};
  const data = {
    name: singleLine(clean(input.name, 100)).replace(/\s+/g, ' '),
    phone: normalizePhone(input.phone),
    email: singleLine(clean(input.email, 150)).toLowerCase(),
    date: clean(input.date, 10),
    time: clean(input.time, 5),
    guests: clean(input.guests, 5),
    area: clean(input.area, 20) || 'any',
    occasion: clean(input.occasion, 20) || 'casual',
    note: clean(input.note, 1000).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n')
  };

  if (data.name.length < 2) errors.name = 'Vui lòng nhập họ tên có ít nhất 2 ký tự.';
  if (!data.phone) errors.phone = 'Nhập số điện thoại Việt Nam hợp lệ, ví dụ 0912 345 678.';
  if (data.email && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(data.email)) errors.email = 'Địa chỉ email chưa đúng định dạng.';

  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date) || Number.isNaN(Date.parse(`${data.date}T00:00:00Z`))) errors.date = 'Vui lòng chọn ngày.';
  else if (data.date < now.date) errors.date = 'Ngày đặt bàn không được trước hôm nay.';
  else if (data.date > addDays(now.date, MAX_DAYS_AHEAD)) errors.date = `Chỉ nhận yêu cầu trong vòng ${MAX_DAYS_AHEAD} ngày tới.`;

  if (!TIME_SLOTS.includes(data.time)) errors.time = 'Vui lòng chọn giờ đến.';
  else if (!errors.date && data.date === now.date && data.time <= now.time) errors.time = 'Giờ này đã qua. Vui lòng chọn giờ muộn hơn.';

  if (!Object.hasOwn(GUEST_LABELS, data.guests)) errors.guests = 'Vui lòng chọn số khách.';
  if (!Object.hasOwn(AREA_LABELS, data.area)) errors.area = 'Khu vực không hợp lệ.';
  if (!Object.hasOwn(OCCASION_LABELS, data.occasion)) errors.occasion = 'Dịp không hợp lệ.';
  if (input.consent !== true) errors.consent = 'Bạn cần đồng ý để LACA liên hệ xác nhận.';

  return { data, errors, valid: Object.keys(errors).length === 0 };
}

/* 04. Reference code: LACA-YYMMDD-XXXX (no ambiguous characters) */
const REF_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export function createReference(now = hanoiNow()) {
  const suffix = Array.from({ length: 4 }, () => REF_ALPHABET[randomInt(REF_ALPHABET.length)]).join('');
  return `LACA-${now.date.slice(2).replaceAll('-', '')}-${suffix}`;
}

/* 05. Email rendering — every dynamic value is HTML-escaped. */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

function describe(booking) {
  return [
    ['Mã đặt bàn', booking.reference],
    ['Ngày gửi yêu cầu', booking.receivedAtDisplay],
    ['Họ tên', booking.name],
    ['Số điện thoại', formatPhone(booking.phone)],
    ['Email khách', booking.email || '—'],
    ['Ngày đặt', toDisplayDate(booking.date)],
    ['Giờ', booking.time],
    ['Số khách', GUEST_LABELS[booking.guests]],
    ['Khu vực mong muốn', AREA_LABELS[booking.area]],
    ['Dịp', OCCASION_LABELS[booking.occasion]],
    ['Ghi chú', booking.note || '—']
  ];
}

export function restaurantEmail(booking) {
  const guestsShort = GUEST_LABELS[booking.guests];
  const subject = singleLine(`[LACA24] Đặt bàn mới — ${booking.time} ${toDisplayDate(booking.date).slice(0, 5)} — ${guestsShort} — ${booking.name}`).slice(0, 200);
  const rows = describe(booking);
  const rowHtml = rows.map(([label, value]) => `<tr><td style="padding:10px 14px;border-bottom:1px solid #eee3cc;color:#6b6152;font-size:13px;width:38%;vertical-align:top">${escapeHtml(label)}</td><td style="padding:10px 14px;border-bottom:1px solid #eee3cc;color:#1b1814;font-size:15px;font-weight:600;white-space:pre-wrap;word-break:break-word">${escapeHtml(value)}</td></tr>`).join('');
  const tel = `tel:${escapeHtml(booking.phone)}`;
  const html = `<!doctype html><html lang="vi"><body style="margin:0;background:#f4efe4;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:620px;margin:0 auto;padding:24px 16px">
  <div style="background:#1b1814;color:#fbb017;padding:18px 22px;border-radius:10px 10px 0 0;font-size:13px;letter-spacing:2px;font-weight:700">LACA 24 · YÊU CẦU ĐẶT BÀN MỚI</div>
  <div style="background:#ffffff;padding:22px;border:1px solid #eee3cc;border-top:0">
    <p style="margin:0 0 6px;color:#6b6152;font-size:13px">Gọi lại cho khách để xác nhận:</p>
    <a href="${tel}" style="display:block;background:#fbb017;color:#1b1814;text-decoration:none;font-size:30px;font-weight:800;letter-spacing:1px;padding:16px 18px;border-radius:8px;text-align:center">📞 ${escapeHtml(formatPhone(booking.phone))}</a>
    <p style="margin:14px 0 0;font-size:17px;color:#1b1814"><strong>${escapeHtml(booking.name)}</strong> · ${escapeHtml(guestsShort)} · <strong>${escapeHtml(booking.time)} ${escapeHtml(toDisplayDate(booking.date))}</strong></p>
    <table role="presentation" style="width:100%;border-collapse:collapse;margin-top:18px">${rowHtml}</table>
    <p style="margin:18px 0 0;padding:12px 14px;background:#fff8e6;border-left:4px solid #fbb017;color:#4a4236;font-size:13px">Đây là <strong>yêu cầu</strong> từ website, chưa phải bàn đã xác nhận. Khách đang chờ LACA gọi lại.</p>
  </div>
  <div style="padding:14px 4px;color:#8a8070;font-size:11px;line-height:1.6">
    Nguồn: ${escapeHtml(booking.sourcePage || 'website')}<br>
    Thời điểm gửi (giờ Hà Nội): ${escapeHtml(booking.receivedAtDisplay)} · ISO: ${escapeHtml(booking.receivedAt)}<br>
    IP: ${escapeHtml(booking.ip || 'n/a')} · Thời gian điền form: ${escapeHtml(booking.fillSeconds ?? 'n/a')} giây<br>
    Trình duyệt: ${escapeHtml(booking.userAgent || 'n/a')}
  </div>
</div></body></html>`;
  const text = [
    'LACA 24 — YÊU CẦU ĐẶT BÀN MỚI',
    `GỌI LẠI CHO KHÁCH: ${formatPhone(booking.phone)}`,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    'Đây là yêu cầu từ website, chưa phải bàn đã xác nhận.',
    `Nguồn: ${booking.sourcePage || 'website'}`,
    `Thời điểm gửi: ${booking.receivedAtDisplay} (${booking.receivedAt})`,
    `IP: ${booking.ip || 'n/a'}`
  ].join('\n');
  return { subject, html, text };
}

export function customerEmail(booking) {
  const rows = describe(booking).filter(([label]) => !['Ngày gửi yêu cầu', 'Email khách'].includes(label));
  const rowHtml = rows.map(([label, value]) => `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee3cc;color:#6b6152;font-size:13px;width:40%">${escapeHtml(label)}</td><td style="padding:8px 12px;border-bottom:1px solid #eee3cc;color:#1b1814;font-size:14px;white-space:pre-wrap;word-break:break-word">${escapeHtml(value)}</td></tr>`).join('');
  const subject = `LACA 24 đã nhận yêu cầu đặt bàn ${booking.reference}`;
  const html = `<!doctype html><html lang="vi"><body style="margin:0;background:#f4efe4;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
  <div style="background:#1b1814;color:#fbb017;padding:16px 20px;border-radius:10px 10px 0 0;font-weight:700;letter-spacing:2px;font-size:13px">LACA 24</div>
  <div style="background:#fff;padding:22px;border:1px solid #eee3cc;border-top:0;color:#1b1814">
    <p style="margin:0 0 10px;font-size:16px">Chào ${escapeHtml(booking.name)},</p>
    <p style="margin:0 0 10px;font-size:15px;line-height:1.6">LACA 24 đã nhận được yêu cầu đặt bàn của bạn. <strong>Yêu cầu này chưa phải là xác nhận giữ bàn</strong> — nhà hàng sẽ gọi lại qua số ${escapeHtml(formatPhone(booking.phone))} để xác nhận tình trạng bàn.</p>
    <table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0">${rowHtml}</table>
    <p style="margin:0;font-size:14px;line-height:1.7">Cần đổi giờ hoặc hỏi thêm? Gọi <a href="tel:${RESTAURANT.phoneE164}" style="color:#b37400;font-weight:700">${RESTAURANT.phoneDisplay}</a><br>${escapeHtml(RESTAURANT.address)} · ${escapeHtml(RESTAURANT.hours)}</p>
  </div>
</div></body></html>`;
  const text = [
    `Chào ${booking.name},`,
    'LACA 24 đã nhận được yêu cầu đặt bàn của bạn. Yêu cầu này CHƯA phải là xác nhận giữ bàn — nhà hàng sẽ gọi lại để xác nhận tình trạng bàn.',
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    '',
    `Hotline: ${RESTAURANT.phoneDisplay}`,
    RESTAURANT.address
  ].join('\n');
  return { subject, html, text };
}

/* 06. Email provider: Resend (https://resend.com/docs/api-reference/emails/send-email) */
export function createResendSender(apiKey) {
  return async function send({ from, to, replyTo, subject, html, text, idempotencyKey }) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
      },
      body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Resend ${response.status}: ${detail.slice(0, 300)}`);
    }
    return response.json();
  };
}

/* 07. Best-effort rate limit (per warm serverless instance). For stricter
 * protection add Turnstile (see verifyTurnstile) or a shared KV store. */
const hits = new Map();
export function rateLimited(key, { limit = 5, windowMs = 10 * 60_000 } = {}) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter(t => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5_000) for (const [k, v] of hits) if (now - v.at(-1) > windowMs) hits.delete(k);
  return recent.length > limit;
}

/* Optional Cloudflare Turnstile. Active only when TURNSTILE_SECRET_KEY is set;
 * the frontend must then render the widget and send `turnstileToken`. */
async function verifyTurnstile(secret, token, ip) {
  if (!token) return false;
  const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(8_000) });
  const result = await r.json().catch(() => ({}));
  return result.success === true;
}

/* 08. HTTP handler.
 * request: { method, headers: { get(name) }, bodyText, ip }
 * env:     process.env-like object
 * deps:    { send } optional override (used by the local dev server) */
const json = (status, body, extraHeaders = {}) => ({
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders },
  body: JSON.stringify(body)
});

const GENERIC_FAIL = `Chưa gửi được yêu cầu. Vui lòng thử lại hoặc gọi ${RESTAURANT.phoneDisplay} để đặt bàn.`;

export async function handleReservation(request, env = {}, deps = {}) {
  const origin = request.headers.get('origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  const cors = allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};

  if (request.method === 'OPTIONS') return { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type' }, body: '' };
  if (request.method !== 'POST') return json(405, { ok: false, error: 'method_not_allowed', message: 'Method not allowed' }, { Allow: 'POST' });
  if (allowed.length && origin && !allowed.includes(origin)) return json(403, { ok: false, error: 'forbidden_origin', message: GENERIC_FAIL });
  if (!(request.headers.get('content-type') || '').toLowerCase().includes('application/json')) return json(415, { ok: false, error: 'unsupported_media_type', message: GENERIC_FAIL }, cors);
  if (Buffer.byteLength(request.bodyText || '', 'utf8') > MAX_BODY_BYTES) return json(413, { ok: false, error: 'payload_too_large', message: GENERIC_FAIL }, cors);

  let input;
  try { input = JSON.parse(request.bodyText || ''); } catch { input = null; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return json(400, { ok: false, error: 'malformed', message: GENERIC_FAIL }, cors);

  // Honeypot + minimum fill time: typical bot signatures. Never reported as success.
  const startedAt = Number(input.startedAt);
  const fillMs = Number.isFinite(startedAt) ? Date.now() - startedAt : null;
  if (clean(input.website, 200) || (fillMs !== null && fillMs < MIN_FILL_MS)) {
    return json(400, { ok: false, error: 'rejected', message: 'Yêu cầu chưa hợp lệ. Vui lòng kiểm tra lại và gửi lần nữa, hoặc gọi ' + RESTAURANT.phoneDisplay + '.' }, cors);
  }

  const ip = request.ip || '';
  if (rateLimited(ip || 'unknown')) return json(429, { ok: false, error: 'rate_limited', message: `Bạn đã gửi nhiều yêu cầu trong thời gian ngắn. Vui lòng đợi ít phút hoặc gọi ${RESTAURANT.phoneDisplay}.` }, cors);

  if (env.TURNSTILE_SECRET_KEY && !(await verifyTurnstile(env.TURNSTILE_SECRET_KEY, input.turnstileToken, ip).catch(() => false))) {
    return json(400, { ok: false, error: 'captcha_failed', message: 'Không xác minh được bạn không phải robot. Vui lòng thử lại.' }, cors);
  }

  const now = hanoiNow();
  const { data, errors, valid } = validateReservation(input, now);
  if (!valid) return json(400, { ok: false, error: 'validation', fields: errors, message: 'Vui lòng kiểm tra lại các thông tin được đánh dấu.' }, cors);

  const send = deps.send || (env.RESEND_API_KEY ? createResendSender(env.RESEND_API_KEY) : null);
  const to = env.BOOKING_TO_EMAIL;
  const from = env.BOOKING_FROM_EMAIL;
  if (!send || !to || !from) {
    console.error('[reservations] not configured: set RESEND_API_KEY, BOOKING_TO_EMAIL, BOOKING_FROM_EMAIL');
    return json(503, { ok: false, error: 'not_configured', message: GENERIC_FAIL }, cors);
  }

  const received = new Date();
  const booking = {
    ...data,
    reference: createReference(now),
    receivedAt: received.toISOString(),
    receivedAtDisplay: hanoiNow(received).stamp,
    sourcePage: clean(input.page, 300).replace(/[^\x20-\x7E -￿]/g, ''),
    ip,
    userAgent: clean(request.headers.get('user-agent'), 200),
    fillSeconds: fillMs !== null ? Math.round(fillMs / 1000) : null
  };

  try {
    const mail = restaurantEmail(booking);
    await send({ from, to, replyTo: booking.email || undefined, subject: mail.subject, html: mail.html, text: mail.text, idempotencyKey: `restaurant-${booking.reference}` });
  } catch (error) {
    console.error('[reservations] restaurant email failed', booking.reference, error?.message);
    return json(502, { ok: false, error: 'email_failed', message: GENERIC_FAIL }, cors);
  }

  // Acknowledgement to the guest is optional and never blocks success.
  let customerNotified = false;
  if (booking.email && String(env.SEND_CUSTOMER_ACK).toLowerCase() === 'true') {
    try {
      const mail = customerEmail(booking);
      await send({ from, to: booking.email, subject: mail.subject, html: mail.html, text: mail.text, idempotencyKey: `customer-${booking.reference}` });
      customerNotified = true;
    } catch (error) {
      console.warn('[reservations] customer acknowledgement failed', booking.reference, error?.message);
    }
  }

  console.log('[reservations] delivered', booking.reference);
  return json(200, {
    ok: true,
    status: 'pending_confirmation',
    reference: booking.reference,
    receivedAt: booking.receivedAt,
    customerNotified,
    booking: {
      name: booking.name, phone: formatPhone(booking.phone), date: booking.date, time: booking.time,
      guests: GUEST_LABELS[booking.guests], area: AREA_LABELS[booking.area], occasion: OCCASION_LABELS[booking.occasion]
    }
  }, cors);
}

export function clientIp(headers, fallback = '') {
  const forwarded = headers.get('x-forwarded-for') || '';
  return (headers.get('x-nf-client-connection-ip') || headers.get('x-real-ip') || forwarded.split(',')[0] || fallback).trim().slice(0, 64);
}
