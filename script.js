'use strict';

/* 01. Config — option values must match lib/reservation.js (server validation). */
const API_ENDPOINT = '/api/reservations';
const RESTAURANT_PHONE = '093 636 8363';
const DRAFT_KEY = 'laca24_booking_draft';      // convenience only: unsent form data
const RECEIPT_KEY = 'laca24_last_request';     // convenience only: last server-confirmed request
const REQUEST_TIMEOUT_MS = 20000;
const guestOptions = Object.fromEntries([
  ...Array.from({ length: 20 }, (_, i) => [String(i + 1), `${i + 1} khách`]),
  ['21-30', '21–30 khách'], ['31-50', '31–50 khách'], ['50+', 'Trên 50 khách']
]);
const areaLabels = { any: 'Để LACA sắp xếp', courtyard: 'Sân trong', hall: 'Sảnh lớn', brick: 'Khu tường gạch' };
const timeSlots = [];
for (let h = 9; h <= 22; h++) for (const m of ['00', '30']) if (!(h === 22 && m === '30')) timeSlots.push(`${String(h).padStart(2, '0')}:${m}`);
const pageStartedAt = Date.now();

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage may be blocked */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
};
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const scrollBehavior = () => (reducedMotion() ? 'auto' : 'smooth');
let toastTimer;

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 5000);
}

/* 02. Header, scroll-spy and mobile drawer */
function initHeader() {
  const header = $('#site-header');
  const update = () => header.classList.toggle('scrolled', window.scrollY > 24);
  addEventListener('scroll', update, { passive: true });
  update();
  if (!('IntersectionObserver' in window)) return;
  const links = $$('.main-nav ul a');
  const observer = new IntersectionObserver(entries => entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    links.forEach(link => {
      const active = link.hash === `#${entry.target.id}`;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'location'); else link.removeAttribute('aria-current');
    });
  }), { rootMargin: '-40% 0px -55% 0px' });
  ['spaces', 'menu', 'events', 'gallery', 'contact'].forEach(id => observer.observe(document.getElementById(id)));
}

function initMobileMenu() {
  const header = $('#site-header');
  const toggle = $('.menu-toggle');
  const nav = $('#main-nav');
  const backdrop = $('.nav-backdrop');
  const isOpen = () => toggle.getAttribute('aria-expanded') === 'true';
  const setOpen = (open, restoreFocus = false) => {
    nav.classList.toggle('is-open', open);
    document.body.classList.toggle('menu-open', open);
    backdrop.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Đóng menu' : 'Mở menu');
    // Wait one frame pair: the drawer is still visibility:hidden at transition start.
    if (open) requestAnimationFrame(() => requestAnimationFrame(() => $('a', nav)?.focus({ preventScroll: true })));
    if (restoreFocus) toggle.focus();
  };
  toggle.addEventListener('click', () => setOpen(!isOpen()));
  backdrop.addEventListener('click', () => setOpen(false, true));
  $$('a', nav).forEach(link => link.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', event => {
    if (!isOpen()) return;
    if (event.key === 'Escape') setOpen(false, true);
    if (event.key === 'Tab') {
      // Keep focus inside the header (logo, drawer links, toggle) while the drawer is open.
      const focusable = $$('a, button', header).filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  matchMedia('(min-width: 980px)').addEventListener('change', event => { if (event.matches && isOpen()) setOpen(false); });
}

/* 03. Reservation form: options & validation in the restaurant timezone */
function getRestaurantNow() {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${v.year}-${v.month}-${v.day}`, time: `${v.hour}:${v.minute}` };
}

function addDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const displayDate = iso => iso.split('-').reverse().join('/');

function populateOptions(select, options, placeholder) {
  select.replaceChildren(new Option(placeholder, ''));
  Object.entries(options).forEach(([value, label]) => select.add(new Option(label, value)));
}

function refreshDateLimits() {
  const { date } = getRestaurantNow();
  ['#booking-date', '#quick-date'].forEach(id => { $(id).min = date; $(id).max = addDays(date, 120); });
}

function updateTimeAvailability(dateInput, timeSelect) {
  const now = getRestaurantNow();
  [...timeSelect.options].forEach(option => {
    option.disabled = Boolean(option.value && dateInput.value === now.date && option.value <= now.time);
  });
  if (timeSelect.selectedOptions[0]?.disabled) timeSelect.value = '';
}

const VALIDATED = ['name', 'phone', 'email', 'date', 'time', 'guests', 'consent'];

function setFieldError(name, message) {
  const field = $('#booking-form').elements.namedItem(name);
  const error = document.getElementById(`${name}-error`);
  if (!field || !error) return;
  error.textContent = message;
  field.setAttribute('aria-invalid', String(Boolean(message)));
}

function validateField(name) {
  const form = $('#booking-form');
  const field = form.elements.namedItem(name);
  const value = String(field.value || '').trim();
  const now = getRestaurantNow();
  let error = '';
  switch (name) {
    case 'name':
      if (value.length < 2) error = 'Vui lòng nhập họ tên có ít nhất 2 ký tự.';
      break;
    case 'phone':
      // Vietnamese mobiles (03/05/07/08/09) and 11-digit landlines (02x).
      if (!/^(?:(?:0|\+84|84)(?:[35789]\d{8}|2\d{9}))$/.test(value.replace(/[\s.()-]/g, ''))) error = 'Nhập số điện thoại Việt Nam hợp lệ, ví dụ 0912 345 678.';
      break;
    case 'email':
      if (value && !/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(value)) error = 'Địa chỉ email chưa đúng định dạng.';
      break;
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) error = 'Vui lòng chọn ngày.';
      else if (value < now.date) error = 'Ngày đặt bàn không được trước hôm nay.';
      else if (value > addDays(now.date, 120)) error = 'Chỉ nhận yêu cầu trong vòng 120 ngày tới.';
      break;
    case 'time':
      if (!timeSlots.includes(value)) error = 'Vui lòng chọn giờ đến.';
      else if (form.elements.date.value === now.date && value <= now.time) error = 'Giờ này đã qua. Vui lòng chọn giờ muộn hơn.';
      break;
    case 'guests':
      if (!Object.hasOwn(guestOptions, value)) error = 'Vui lòng chọn số khách.';
      break;
    case 'consent':
      if (!field.checked) error = 'Bạn cần đồng ý để LACA liên hệ xác nhận.';
      break;
  }
  setFieldError(name, error);
  return !error;
}

function validateBookingForm() {
  const valid = VALIDATED.map(validateField).every(Boolean);
  if (!valid) {
    $('[aria-invalid="true"]', $('#booking-form'))?.focus();
    $('#form-status').textContent = 'Vui lòng kiểm tra các thông tin được đánh dấu.';
  }
  return valid;
}

/* 04. Draft recovery (localStorage is never the booking record) */
const DRAFT_FIELDS = ['name', 'phone', 'email', 'date', 'time', 'guests', 'area', 'occasion', 'note'];

function saveDraft() {
  const form = $('#booking-form');
  const draft = Object.fromEntries(DRAFT_FIELDS.map(name => [name, form.elements.namedItem(name).value]));
  if (DRAFT_FIELDS.some(name => name !== 'area' && name !== 'occasion' && draft[name])) storage.set(DRAFT_KEY, { ...draft, savedAt: Date.now() });
}

function restoreDraft() {
  const draft = storage.get(DRAFT_KEY);
  if (!draft || typeof draft !== 'object' || Date.now() - Number(draft.savedAt) > 7 * 864e5) { storage.remove(DRAFT_KEY); return; }
  const form = $('#booking-form');
  const now = getRestaurantNow();
  DRAFT_FIELDS.forEach(name => {
    const value = draft[name];
    if (typeof value !== 'string' || !value) return;
    if (name === 'date' && value < now.date) return;
    if (name === 'area') { const radio = $(`input[name="area"][value="${CSS.escape(value)}"]`, form); if (radio) radio.checked = true; return; }
    const field = form.elements.namedItem(name);
    if (field.tagName === 'SELECT' && ![...field.options].some(o => o.value === value)) return;
    field.value = value.slice(0, 1000);
  });
  updateTimeAvailability($('#booking-date'), $('#booking-time'));
  $('#draft-note').hidden = false;
}

/* 05. Submission — success is shown only after the server confirms delivery. */
function readForm() {
  const form = $('#booking-form');
  const data = Object.fromEntries(new FormData(form));
  return {
    name: data.name.trim().replace(/\s+/g, ' '),
    phone: data.phone.trim(),
    email: data.email.trim(),
    date: data.date,
    time: data.time,
    guests: data.guests,
    area: data.area || 'any',
    occasion: data.occasion || 'casual',
    note: data.note.trim(),
    consent: form.elements.consent.checked,
    website: data.website || '',
    startedAt: pageStartedAt,
    page: location.href.split('#')[0]
  };
}

function showFormError(message) {
  $('#form-error-message').textContent = message;
  $('#form-error').hidden = false;
  $('#form-error').scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
}

async function postReservation(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    let body = null;
    try { body = await response.json(); } catch { /* non-JSON (e.g. static host without API) */ }
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function initBookingForm() {
  const form = $('#booking-form');
  populateOptions($('#booking-time'), Object.fromEntries(timeSlots.map(t => [t, t])), 'Chọn giờ');
  populateOptions($('#quick-time'), Object.fromEntries(timeSlots.map(t => [t, t])), 'Chọn giờ');
  populateOptions($('#booking-guests'), guestOptions, 'Chọn số khách');
  populateOptions($('#quick-guests'), guestOptions, 'Số khách');
  refreshDateLimits();

  const now = getRestaurantNow();
  $('#quick-date').value = now.date;
  $('#quick-time').value = '19:00';
  $('#quick-guests').value = '4';
  updateTimeAvailability($('#quick-date'), $('#quick-time'));

  [['#quick-date', '#quick-time'], ['#booking-date', '#booking-time']].forEach(([dateId, timeId]) => {
    $(dateId).addEventListener('change', () => updateTimeAvailability($(dateId), $(timeId)));
    $(dateId).addEventListener('focus', refreshDateLimits);
  });
  addEventListener('focus', refreshDateLimits);

  let draftTimer;
  ['input', 'change'].forEach(type => form.addEventListener(type, event => {
    const name = event.target.name;
    if (VALIDATED.includes(name) && event.target.getAttribute('aria-invalid') === 'true') validateField(name);
    if (name === 'date' && $('#booking-time').value) validateField('time');
    $('#form-status').textContent = '';
    clearTimeout(draftTimer);
    draftTimer = setTimeout(saveDraft, 400);
  }));
  form.addEventListener('focusout', event => {
    const { name, value } = event.target;
    if (VALIDATED.includes(name) && name !== 'consent' && value) validateField(name);
  });

  restoreDraft();
  $('#draft-clear').addEventListener('click', () => {
    storage.remove(DRAFT_KEY);
    form.reset();
    VALIDATED.forEach(name => setFieldError(name, ''));
    $('#draft-note').hidden = true;
    $('#customer-name').focus();
  });

  let submitting = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitting) return;
    $('#form-error').hidden = true;
    refreshDateLimits();
    if (!validateBookingForm()) return;

    submitting = true;
    const button = $('.submit-booking');
    const label = $('.submit-label', button);
    button.disabled = true;
    button.classList.add('is-loading');
    form.setAttribute('aria-busy', 'true');
    label.textContent = 'Đang gửi yêu cầu…';
    $('#form-status').textContent = 'Đang gửi yêu cầu đặt bàn…';

    try {
      const { response, body } = await postReservation(readForm());
      if (response.ok && body?.ok === true && typeof body.reference === 'string') {
        const receipt = { reference: body.reference, receivedAt: body.receivedAt, booking: body.booking };
        storage.set(RECEIPT_KEY, receipt);
        storage.remove(DRAFT_KEY);
        form.reset();
        VALIDATED.forEach(name => setFieldError(name, ''));
        $('#draft-note').hidden = true;
        $('#form-status').textContent = '';
        $('#booking-history').hidden = false;
        updateTimeAvailability($('#booking-date'), $('#booking-time'));
        showBookingModal(receipt);
        return;
      }
      if (body?.fields && typeof body.fields === 'object') {
        Object.entries(body.fields).forEach(([name, message]) => { if (VALIDATED.includes(name)) setFieldError(name, String(message)); });
        $('[aria-invalid="true"]', form)?.focus();
      }
      $('#form-status').textContent = '';
      showFormError(typeof body?.message === 'string' && body.message
        ? body.message
        : `Hệ thống đặt bàn online đang gián đoạn. Thông tin của bạn vẫn còn trong form — vui lòng thử lại hoặc gọi ${RESTAURANT_PHONE}.`);
    } catch (error) {
      $('#form-status').textContent = '';
      showFormError(error?.name === 'AbortError'
        ? `Máy chủ phản hồi quá lâu nên chưa xác nhận được việc gửi. Vui lòng gọi ${RESTAURANT_PHONE} để chắc chắn LACA đã nhận yêu cầu.`
        : `Không kết nối được máy chủ. Thông tin vẫn còn trong form — kiểm tra mạng rồi thử lại, hoặc gọi ${RESTAURANT_PHONE}.`);
    } finally {
      submitting = false;
      button.disabled = false;
      button.classList.remove('is-loading');
      form.removeAttribute('aria-busy');
      label.textContent = 'Gửi yêu cầu đặt bàn';
    }
  });

  // Quick booking copies date/time/guests into the full form.
  $('#quick-booking').addEventListener('submit', event => {
    event.preventDefault();
    refreshDateLimits();
    updateTimeAvailability($('#quick-date'), $('#quick-time'));
    if (!event.currentTarget.reportValidity()) return;
    ['date', 'time', 'guests'].forEach(name => {
      form.elements.namedItem(name).value = document.getElementById(`quick-${name}`).value;
      setFieldError(name, '');
    });
    updateTimeAvailability($('#booking-date'), $('#booking-time'));
    saveDraft();
    $('#booking').scrollIntoView({ behavior: scrollBehavior() });
    $('#customer-name').focus({ preventScroll: true });
    showToast('Đã chọn ngày, giờ và số khách. Điền nốt thông tin liên hệ nhé.');
  });

  // "Đặt bàn khu vực này" / event CTAs pre-select area and occasion.
  $$('[data-space], [data-occasion]').forEach(link => link.addEventListener('click', () => {
    const notes = [];
    if (link.dataset.space) {
      const radio = $(`input[name="area"][value="${CSS.escape(link.dataset.space)}"]`, form);
      if (radio) { radio.checked = true; notes.push(areaLabels[link.dataset.space]); }
    }
    if (link.dataset.occasion) {
      form.elements.occasion.value = link.dataset.occasion;
      notes.push(form.elements.occasion.selectedOptions[0]?.textContent);
    }
    if (notes.length) showToast(`Đã chọn: ${notes.filter(Boolean).join(' · ')}`);
  }));

  const receipt = storage.get(RECEIPT_KEY);
  const hasReceipt = receipt && typeof receipt.reference === 'string' && receipt.booking && typeof receipt.booking.date === 'string';
  $('#booking-history').hidden = !hasReceipt;
  $('#booking-history').addEventListener('click', () => {
    const latest = storage.get(RECEIPT_KEY);
    if (latest?.reference) showBookingModal(latest);
  });
}

/* 06. Dialogs — guest data is always rendered with textContent. */
function openDialog(dialog, returnFocusTo = document.activeElement) {
  dialog.returnFocusTo = returnFocusTo;
  dialog.showModal();
  document.body.classList.add('dialog-open');
}

function initDialogs() {
  $$('dialog').forEach(dialog => {
    $$('[data-close-dialog]', dialog).forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
    dialog.addEventListener('close', () => {
      document.body.classList.remove('dialog-open');
      const target = dialog.returnFocusTo;
      if (target?.isConnected && !target.disabled && !target.hidden) target.focus({ preventScroll: true });
    });
  });
}

function showBookingModal(receipt) {
  const b = receipt.booking || {};
  const rows = [
    ['Mã yêu cầu', receipt.reference],
    ['Tên', b.name],
    ['Điện thoại', b.phone],
    ['Ngày', typeof b.date === 'string' ? displayDate(b.date) : ''],
    ['Giờ', b.time],
    ['Số khách', b.guests],
    ['Khu vực', b.area],
    ['Dịp', b.occasion]
  ].filter(([, value]) => value);
  const summary = $('#booking-summary');
  summary.replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const detail = document.createElement('dd');
    term.textContent = label;
    detail.textContent = String(value);
    row.append(term, detail);
    return row;
  }));
  // The submit button is disabled while this opens; return focus to the receipt button instead.
  openDialog($('#booking-modal'), $('#booking-history'));
}

/* 07. Gallery lightbox (progressively enhances plain image links) */
function initGallery() {
  const items = $$('.gallery-item');
  const lightbox = $('#lightbox');
  const image = $('#lightbox-image');
  let active = 0;
  const show = index => {
    active = (index + items.length) % items.length;
    const item = items[active];
    image.src = item.href;
    image.alt = $('img', item).alt;
    $('#lightbox-caption').textContent = item.dataset.caption || '';
    $('#lightbox-counter').textContent = `${String(active + 1).padStart(2, '0')} / ${String(items.length).padStart(2, '0')}`;
  };
  items.forEach((item, index) => {
    item.setAttribute('aria-label', `Xem ảnh lớn: ${item.dataset.caption || $('img', item).alt}`);
    item.addEventListener('click', event => {
      event.preventDefault();
      show(index);
      openDialog(lightbox);
    });
  });
  $('#lightbox-prev').addEventListener('click', () => show(active - 1));
  $('#lightbox-next').addEventListener('click', () => show(active + 1));
  lightbox.addEventListener('keydown', event => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); show(active - 1); }
    if (event.key === 'ArrowRight') { event.preventDefault(); show(active + 1); }
  });
}

/* 08. Motion & mobile action bar */
// Reveal anything the viewport has reached OR already passed, so fast scrolls,
// anchor jumps and find-in-page can never leave content invisible.
function initReveal() {
  if (reducedMotion()) return;
  let pending = $$('.reveal');
  let queued = false;
  const check = () => {
    queued = false;
    const atBottom = scrollY + innerHeight >= document.documentElement.scrollHeight - 4;
    const limit = atBottom ? innerHeight : innerHeight * 0.92;
    pending = pending.filter(element => {
      if (element.getBoundingClientRect().top >= limit) return true;
      element.classList.add('is-visible');
      return false;
    });
    if (!pending.length) removeEventListener('scroll', onScroll);
  };
  const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(check); } };
  const revealAll = () => { pending.forEach(element => element.classList.add('is-visible')); pending = []; };
  document.body.classList.add('motion-ready');
  check();
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll, { passive: true });
  addEventListener('hashchange', () => setTimeout(check, 50));
  addEventListener('beforeprint', revealAll);
}

function initActionBar() {
  const bar = $('#action-bar');
  const visible = new Set();
  let formFocused = false;
  const update = () => bar.classList.toggle('is-hidden', visible.size > 0 || formFocused);
  // Never cover form fields: hide while any form is on screen or being typed in.
  document.addEventListener('focusin', event => { formFocused = Boolean(event.target.closest('form')); update(); });
  document.addEventListener('focusout', () => { formFocused = false; requestAnimationFrame(update); });
  if (!('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => (entry.isIntersecting ? visible.add(entry.target) : visible.delete(entry.target)));
    update();
  });
  [$('.quick-booking-wrap'), $('#booking')].forEach(section => observer.observe(section));
}

function init() {
  initHeader();
  initMobileMenu();
  initDialogs();
  initBookingForm();
  initGallery();
  initReveal();
  initActionBar();
}

init();
