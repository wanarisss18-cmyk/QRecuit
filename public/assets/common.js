// Shared browser helpers for the candidate portal and the HR dashboard

export function isValidThaiId(value) {
  const id = String(value || '').replace(/\D/g, '');
  if (id.length !== 13) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}

// 1-1004-00307-96-8
export function formatThaiId(value) {
  const d = String(value || '').replace(/\D/g, '');
  if (d.length !== 13) return value;
  return `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}`;
}

export async function api(url, { json, token, ...opts } = {}) {
  const headers = { ...(opts.headers || {}) };
  if (json !== undefined) {
    headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(json);
  }
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { ...opts, headers });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(body?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

export function toast(message, ms = 3500) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), ms);
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

// ISO date or SQLite UTC datetime -> "30 ต.ค. 2569" (+ time)
export function thaiDate(value, withTime = false) {
  if (!value) return '-';
  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const d = new Date(isDateOnly ? `${value}T00:00:00` : value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return value;
  const s = `${d.getDate()} ${TH_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
  return withTime && !isDateOnly ? `${s} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : s;
}

export const STATUS = {
  PENDING_CHECK: { label: 'รอส่งตรวจประวัติ', cls: 'b-pending' },
  IN_CHECK: { label: 'อยู่ระหว่างตรวจประวัติ', cls: 'b-check' },
  PASSED: { label: 'ผ่าน', cls: 'b-pass' },
  REJECTED: { label: 'ไม่ผ่าน (พบประวัติ)', cls: 'b-fail' },
};

export const DOC_LABEL = {
  ID_CARD: 'บัตรประชาชน', HOUSE_REG: 'ทะเบียนบ้าน', DRIVER_LICENSE: 'ใบขับขี่', PHOTO: 'รูปถ่าย',
  EDUCATION: 'วุฒิการศึกษา', SIGNATURE: 'ลายเซ็น', OTHER: 'อื่นๆ',
};

// Inline stroke icons (24x24 grid) so the UI needs no icon font or emoji
const ICONS = {
  idcard: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><circle cx="8.5" cy="11" r="2.2"/><path d="M5.5 16c.6-1.6 1.7-2.4 3-2.4s2.4.8 3 2.4M14 10h4.5M14 13.5h3"/>',
  home: '<path d="M3.5 10.5 12 4l8.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19z"/><path d="M9.5 20.5V14h5v6.5"/>',
  car: '<path d="M5 16.5h14M4 16.5V12l2-5h12l2 5v4.5"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/><path d="M4 12h16"/>',
  user: '<circle cx="12" cy="8.5" r="3.8"/><path d="M4.5 20c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/>',
  cap: '<path d="m2.5 9 9.5-4.5L21.5 9 12 13.5z"/><path d="M6.5 11v4.5c1.5 1.5 3.4 2.2 5.5 2.2s4-.7 5.5-2.2V11M21.5 9v5"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.2l1.5-2.2h5.6L16.3 7h2.2A1.5 1.5 0 0 1 20 8.5v9.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18z"/><circle cx="12" cy="13" r="3.6"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-4.5-4.5-8.5 8"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12.3 2.8 2.8L16.2 9.5"/>',
  alert: '<path d="M12 4 2.8 19.5h18.4z"/><path d="M12 10v4.2M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.4 3 7.9 7 9 4-1.1 7-4.6 7-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  back: '<path d="M15 5 8 12l7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  file: '<path d="M6.5 3.5h7l4 4V20a.5.5 0 0 1-.5.5h-10.5a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z"/><path d="M13.5 3.5v4h4M9 12h6M9 15.5h6"/>',
  pen: '<path d="M3.5 20.5c3-1 5-3 6.5-5M14.5 4.5l5 5L10 19l-5.5 1.5L6 15z"/>',
  scan: '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M4 12h16"/>',
  sparkle: '<path d="M12 3.5 13.6 9l5.4 1.6-5.4 1.6L12 17.5l-1.6-5.3L5 10.6 10.4 9z"/><path d="M19 3.5v3M17.5 5h3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>',
  share: '<path d="M12 15V4M8 7.5 12 4l4 3.5M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12"/>',
  briefcase: '<rect x="3" y="7.5" width="18" height="12" rx="2"/><path d="M9 7.5V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5v2M3 13h18"/>',
  phone: '<path d="M6.5 3.5h3l1.5 4-2 1.3a10 10 0 0 0 6.2 6.2l1.3-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 5 5.1 1.5 1.5 0 0 1 6.5 3.5z"/>',
  users: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 19.5c.9-3.2 3.2-5 6-5s5.1 1.8 6 5M16 5.5a3.3 3.3 0 0 1 0 6.3M18 14.8c1.4.8 2.4 2.4 3 4.7"/>',
  heart: '<path d="M12 19.5s-7.5-4.4-7.5-10A4.3 4.3 0 0 1 12 6.8a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10-7.5 10z"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  printer: '<path d="M7 9V4h10v5M7 17H5a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 5 9h14a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 19 17h-2"/><rect x="7" y="14" width="10" height="6.5"/>',
  send: '<path d="M20.5 3.5 10 14M20.5 3.5 14 20.5l-4-6.5-6.5-4z"/>',
  upload: '<path d="M12 16V4M7.5 8.5 12 4l4.5 4.5M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  refresh: '<path d="M4.5 12a7.5 7.5 0 0 1 13-5.1L20 9.5M20 4.5v5h-5M19.5 12a7.5 7.5 0 0 1-13 5.1L4 14.5M4 19.5v-5h5"/>',
};
export const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
