// Cloudflare Workers edition of src/server.js — same API, backed by D1 (database) and R2 (files).
// Static pages in public/ are served by Workers Static Assets; everything else lands here.
import { Hono } from 'hono';
import { Buffer } from 'node:buffer';
import { config } from '../src/config.js';
import { isValidThaiId, maskThaiId } from '../src/thaiId.js';
import { extractDocument, crossCheck, OcrError, OCR_DOC_TYPES } from '../src/ocr.js';
import { renderConsents, CONSENT_TEMPLATES } from '../src/consentTemplates.js';

const app = new Hono();

// ---------- per-request setup ----------

function configure(env) {
  Object.assign(config, {
    companyName: env.COMPANY_NAME || config.companyName,
    retentionDays: Number(env.RETENTION_DAYS || config.retentionDays),
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    ocrProvider: env.OCR_PROVIDER || (env.ANTHROPIC_API_KEY ? 'claude' : 'mock'),
    ocrModel: env.OCR_MODEL || config.ocrModel,
    mainSystemWebhook: env.MAIN_SYSTEM_WEBHOOK_URL || '',
  });
}

const clean = (params) => params.map((v) => (v === undefined ? null : v));
const dbOf = (env) => ({
  stmt: (sql, ...p) => env.DB.prepare(sql).bind(...clean(p)),
  one: (sql, ...p) => env.DB.prepare(sql).bind(...clean(p)).first(),
  all: async (sql, ...p) => (await env.DB.prepare(sql).bind(...clean(p)).all()).results,
  run: (sql, ...p) => env.DB.prepare(sql).bind(...clean(p)).run(),
  batch: (stmts) => env.DB.batch(stmts),
});

// Document files: R2 when the DOCS bucket is bound, otherwise Workers KV (FILES)
const storeOf = (env) => (env.DOCS
  ? {
      put: (key, value, type) => env.DOCS.put(key, value, { httpMetadata: { contentType: type } }),
      get: async (key) => (await env.DOCS.get(key))?.body ?? null,
      delete: (keys) => env.DOCS.delete(keys),
    }
  : {
      put: (key, value, type) => env.FILES.put(key, value, { metadata: { contentType: type } }),
      get: (key) => env.FILES.get(key, 'stream'),
      delete: (keys) => Promise.all(keys.map((k) => env.FILES.delete(k))),
    });

app.use('*', async (c, next) => {
  configure(c.env);
  c.set('db', dbOf(c.env));
  c.set('store', storeOf(c.env));
  await next();
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
class GatekeeperError extends Error {}

const ip = (c) => c.req.header('cf-connecting-ip') || null;

async function audit(c, action, candidateId = null, detail = null) {
  await c.get('db').run(
    'INSERT INTO audit_logs (user_id, action, candidate_id, detail, ip_address) VALUES (?, ?, ?, ?, ?)',
    c.get('user')?.id ?? null, action, candidateId, detail ? JSON.stringify(detail) : null, ip(c)
  );
}

// Per-isolate only — a light brake, not a guarantee. Use Cloudflare WAF rate limiting in production.
function rateLimit(max, windowMs) {
  const hits = new Map();
  return async (c, next) => {
    const key = ip(c) || 'anon';
    const now = Date.now();
    const entry = hits.get(key) || { n: 0, reset: now + windowMs };
    if (now > entry.reset) Object.assign(entry, { n: 0, reset: now + windowMs });
    entry.n += 1;
    hits.set(key, entry);
    if (entry.n > max) return c.json({ error: 'ส่งคำขอถี่เกินไป กรุณารอสักครู่' }, 429);
    await next();
  };
}

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (bytes) => toHex(await crypto.subtle.digest('SHA-256', bytes));

function sniffMime(b) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  const ascii = (s, e) => String.fromCharCode(...b.subarray(s, e));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(0, 4) === '%PDF') return 'application/pdf';
  return null;
}
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

const bangkokDate = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// ---------- auth (PBKDF2 via WebCrypto: scrypt is too CPU-heavy for Workers limits) ----------

const PBKDF2_ITER = 60000;
const enc = new TextEncoder();

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${PBKDF2_ITER}$${toHex(salt)}$${toHex(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}
async function verifyPassword(password, stored) {
  const [kind, iter, saltHex, hashHex] = String(stored).split('$');
  if (kind !== 'pbkdf2') return false;
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  return timingSafeEqual(toHex(await pbkdf2(password, salt, Number(iter))), hashHex);
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Buffer.from(await crypto.subtle.sign('HMAC', key, enc.encode(data))).toString('base64url');
}
const verifyHmac = async (env, data, sig) => timingSafeEqual(await hmac(env, data), sig);

async function issueToken(env, user) {
  const payload = Buffer.from(JSON.stringify({ id: user.id, role: user.role, name: user.full_name, exp: Date.now() + config.tokenTtlMs })).toString('base64url');
  return `${payload}.${await hmac(env, payload)}`;
}
async function readToken(env, token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !sig || !(await verifyHmac(env, payload, sig))) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return data.exp > Date.now() ? data : null;
}

// Same role table as src/auth.js
const PERMISSIONS = {
  'candidate:list': ['staff', 'manager'],
  'candidate:view-sensitive': ['manager'],
  'document:view': ['staff', 'manager'],
  'document:view-rejected': ['manager'],
  'batch:export': ['staff', 'manager'],
  'check:record': ['manager'],
  'check:view-detail': ['manager'],
  'candidate:sync-and-print': ['staff', 'manager'],
  'audit:view': ['manager'],
  'retention:run': ['manager'],
};
const can = (user, p) => Boolean(user && PERMISSIONS[p]?.includes(user.role));

const requireAuth = async (c, next) => {
  const header = c.req.header('authorization') || '';
  let user = null;
  try {
    user = await readToken(c.env, header.startsWith('Bearer ') ? header.slice(7) : c.req.query('token'));
  } catch { /* malformed token */ }
  if (!user) return c.json({ error: 'กรุณาเข้าสู่ระบบ' }, 401);
  c.set('user', user);
  await next();
};
const requirePermission = (p) => async (c, next) => (can(c.get('user'), p) ? next() : c.json({ error: 'ไม่มีสิทธิ์ดำเนินการนี้' }, 403));

// The 5-person HR team is created on first login, from the SEED_PASSWORD secret
async function ensureSeed(env, db) {
  const { n } = await db.one('SELECT COUNT(*) AS n FROM users_hr');
  if (n > 0) return;
  if (!env.SEED_PASSWORD) throw new HttpError(503, 'ยังไม่ได้ตั้งค่า SEED_PASSWORD');
  const seed = [
    ['hr.manager', 'ผู้จัดการฝ่ายบุคคล', 'manager'],
    ['hr01', 'เจ้าหน้าที่ HR 1', 'staff'],
    ['hr02', 'เจ้าหน้าที่ HR 2', 'staff'],
    ['hr03', 'เจ้าหน้าที่ HR 3', 'staff'],
    ['hr04', 'เจ้าหน้าที่ HR 4', 'staff'],
  ];
  const hash = await hashPassword(env.SEED_PASSWORD);
  await db.batch(seed.map(([u, name, role]) =>
    db.stmt('INSERT OR IGNORE INTO users_hr (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)', u, name, hash, role)));
}

// ---------- candidate portal (public) ----------

app.get('/', (c) => c.redirect('/apply/'));

const OCR_TOKEN_DATA = (fileHash, result) => `${fileHash}.${JSON.stringify(result)}`;

async function readUpload(file) {
  if (!file || typeof file === 'string') return null;
  if (file.size > config.maxUploadBytes) throw new HttpError(400, 'ไฟล์ใหญ่เกิน 10MB');
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { bytes, name: file.name, size: bytes.length, mime: sniffMime(bytes), hash: await sha256(bytes) };
}

app.post('/api/ocr', rateLimit(30, 10 * 60 * 1000), async (c) => {
  const form = await c.req.formData();
  const f = await readUpload(form.get('file'));
  if (!f) throw new HttpError(400, 'กรุณาแนบรูปเอกสาร');
  if (!f.mime) throw new HttpError(400, 'รองรับเฉพาะไฟล์ JPG, PNG, WEBP หรือ PDF');
  const result = await extractDocument(Buffer.from(f.bytes), f.mime, form.get('doc_type'));
  return c.json({ result, token: await hmac(c.env, OCR_TOKEN_DATA(f.hash, result)) });
});

const PERSONAL_FIELDS = [
  'national_id', 'title_th', 'first_name', 'last_name', 'first_name_en', 'last_name_en', 'birth_date',
  'phone', 'email', 'line_id', 'addr_house_no', 'addr_moo', 'addr_soi', 'addr_road', 'addr_subdistrict',
  'addr_district', 'addr_province', 'addr_postal_code', 'father_name', 'mother_name', 'position_applied',
];

function cleanPersonal(input) {
  const p = Object.fromEntries(PERSONAL_FIELDS.map((f) => [f, String(input?.[f] ?? '').trim() || null]));
  if (p.national_id) p.national_id = p.national_id.replace(/\D/g, '');
  if (p.phone) p.phone = p.phone.replace(/\D/g, '');
  const errors = [];
  if (!isValidThaiId(p.national_id)) errors.push('เลขประจำตัวประชาชนไม่ถูกต้อง');
  for (const [f, label] of [['first_name', 'ชื่อ'], ['last_name', 'นามสกุล'], ['position_applied', 'ตำแหน่งที่สมัคร'],
    ['addr_house_no', 'บ้านเลขที่'], ['addr_province', 'จังหวัด'], ['father_name', 'ชื่อบิดา'], ['mother_name', 'ชื่อมารดา']]) {
    if (!p[f]) errors.push(`กรุณากรอก${label}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.birth_date || '')) errors.push('วันเกิดไม่ถูกต้อง');
  if (!/^0\d{8,9}$/.test(p.phone || '')) errors.push('เบอร์โทรศัพท์ไม่ถูกต้อง');
  if (errors.length) throw new HttpError(422, errors.join(', '));
  return p;
}

app.post('/api/consents/preview', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const loose = Object.fromEntries(PERSONAL_FIELDS.map((f) => [f, String(body?.[f] ?? '').trim()]));
  return c.json({ consents: renderConsents(loose) });
});

const UPLOAD_FIELDS = ['ID_CARD', 'HOUSE_REG', 'DRIVER_LICENSE', 'PHOTO', 'EDUCATION', 'SIGNATURE'];

async function nextApplicationNo(db) {
  const day = bangkokDate().replaceAll('-', '');
  const { n } = await db.one('SELECT COUNT(*) AS n FROM candidates WHERE application_no LIKE ?', `APP-${day}-%`);
  return `APP-${day}-${String(n + 1).padStart(4, '0')}`;
}

app.post('/api/applications', rateLimit(10, 10 * 60 * 1000), async (c) => {
  const db = c.get('db');
  const form = await c.req.formData();
  const data = JSON.parse(form.get('data') || '{}');
  const personal = cleanPersonal(data.personal);

  const files = {};
  for (const k of UPLOAD_FIELDS) {
    const f = await readUpload(form.get(k));
    if (f) files[k] = f;
  }
  for (const [k, label] of [['ID_CARD', 'รูปบัตรประชาชน'], ['HOUSE_REG', 'รูปทะเบียนบ้าน'], ['SIGNATURE', 'ลายเซ็น']]) {
    if (!files[k]) throw new HttpError(422, `กรุณาแนบ${label}`);
  }
  for (const [k, f] of Object.entries(files)) {
    if (!f.mime || (k === 'SIGNATURE' && f.mime !== 'image/png')) throw new HttpError(400, `ไฟล์ ${k} ไม่ถูกต้อง`);
  }

  const expected = renderConsents(personal);
  const accepted = new Map((data.consents || []).map((x) => [x.type, x.sha256]));
  for (const x of expected) {
    if (accepted.get(x.type) !== x.sha256) throw new HttpError(422, `กรุณาอ่านและยินยอม "${x.title}" อีกครั้ง`);
  }

  const ocrByType = {};
  for (const type of OCR_DOC_TYPES) {
    const o = data.ocr?.[type];
    if (o && files[type] && (await verifyHmac(c.env, OCR_TOKEN_DATA(files[type].hash, o.result), o.token))) ocrByType[type] = o.result;
  }
  const flags = crossCheck(ocrByType, personal);

  const trackingToken = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url');
  const keys = [];
  // Two tries: a parallel submission can take the same daily sequence number
  for (let attempt = 0; attempt < 2; attempt++) {
    const applicationNo = await nextApplicationNo(db);
    const candId = `(SELECT id FROM candidates WHERE application_no = '${applicationNo}')`;
    const stmts = [];
    const cols = [...PERSONAL_FIELDS, 'application_no', 'tracking_token', 'application_json', 'review_flags'];
    stmts.push(db.stmt(
      `INSERT INTO candidates (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      ...PERSONAL_FIELDS.map((f) => personal[f]), applicationNo, trackingToken,
      JSON.stringify(data.application || {}), flags.length ? JSON.stringify(flags) : null
    ));
    for (const w of (data.work || []).slice(0, 10)) {
      if (!w?.company) continue;
      stmts.push(db.stmt(
        `INSERT INTO work_experiences (candidate_id, company, business_type, position, duties, salary, start_date, end_date, reason_leaving)
         VALUES (${candId}, ?, ?, ?, ?, ?, ?, ?, ?)`,
        w.company, w.business_type || null, w.position || null, w.duties || null, Number(w.salary) || null,
        w.start_date || null, w.end_date || null, w.reason_leaving || null
      ));
    }
    let signatureKey = null;
    for (const [type, f] of Object.entries(files)) {
      const key = `uploads/${applicationNo}/${type}-${crypto.randomUUID()}.${EXT[f.mime]}`;
      await c.get('store').put(key, f.bytes, f.mime);
      keys.push(key);
      if (type === 'SIGNATURE') signatureKey = key;
      stmts.push(db.stmt(
        `INSERT INTO documents (candidate_id, doc_type, storage_path, original_name, mime_type, size_bytes, sha256, ocr_json)
         VALUES (${candId}, ?, ?, ?, ?, ?, ?, ?)`,
        type, key, f.name, f.mime, f.size, f.hash, ocrByType[type] ? JSON.stringify(ocrByType[type]) : null
      ));
    }
    for (const x of expected) {
      stmts.push(db.stmt(
        `INSERT INTO consents (candidate_id, consent_type, consent_version, content_sha256, signature_document_id, ip_address, user_agent)
         VALUES (${candId}, ?, ?, ?, (SELECT id FROM documents WHERE storage_path = ?), ?, ?)`,
        x.type, x.version, x.sha256, signatureKey, ip(c), c.req.header('user-agent') || null
      ));
    }
    try {
      await db.batch(stmts); // atomic
      return c.json({ application_no: applicationNo, tracking_token: trackingToken }, 201);
    } catch (err) {
      await c.get('store').delete(keys.splice(0));
      const msg = String(err.message);
      if (msg.includes('national_id')) throw new HttpError(409, 'เลขบัตรประชาชนนี้มีใบสมัครที่อยู่ระหว่างดำเนินการแล้ว');
      if (!msg.includes('application_no') || attempt === 1) throw err;
    }
  }
});

const PUBLIC_STATUS = {
  PENDING_CHECK: { step: 1, text: 'ระบบได้รับข้อมูลเรียบร้อยแล้ว รอส่งตรวจสอบประวัติ' },
  IN_CHECK: { step: 2, text: 'ระบบได้รับข้อมูลเรียบร้อยแล้ว อยู่ระหว่างการตรวจสอบประวัติ' },
  PASSED: { step: 3, text: 'ผ่านการตรวจสอบประวัติแล้ว เจ้าหน้าที่จะติดต่อกลับเพื่อนัดหมาย' },
  REJECTED: { step: 3, text: 'ขอขอบคุณที่สนใจร่วมงานกับเรา ขณะนี้บริษัทฯ ยังไม่สามารถดำเนินการใบสมัครของท่านต่อได้' },
};

app.get('/api/applications/status/:token', rateLimit(60, 60 * 1000), async (c) => {
  const s = await c.get('db').one(
    'SELECT application_no, first_name, position_applied, status, created_at FROM candidates WHERE tracking_token = ?', c.req.param('token'));
  if (!s) return c.json({ error: 'ไม่พบใบสมัคร' }, 404);
  return c.json({ ...s, ...PUBLIC_STATUS[s.status] });
});

app.get('/api/meta', (c) => c.json({ company: config.companyName, ocr_provider: config.ocrProvider, consent_types: CONSENT_TEMPLATES.map((t) => t.title) }));

// ---------- HR ----------

app.post('/api/auth/login', rateLimit(10, 15 * 60 * 1000), async (c) => {
  const db = c.get('db');
  await ensureSeed(c.env, db);
  const { username, password } = await c.req.json().catch(() => ({}));
  const user = await db.one('SELECT * FROM users_hr WHERE username = ? AND is_active = 1', String(username || ''));
  if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) {
    return c.json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' }, 401);
  }
  c.set('user', user);
  await audit(c, 'LOGIN');
  return c.json({ token: await issueToken(c.env, user), user: { name: user.full_name, role: user.role } });
});

const hr = new Hono();
hr.use('*', requireAuth);

hr.get('/me', (c) => {
  const permissions = Object.fromEntries(
    ['candidate:view-sensitive', 'check:record', 'check:view-detail', 'audit:view', 'retention:run'].map((p) => [p, can(c.get('user'), p)]));
  return c.json({ user: c.get('user'), permissions });
});

hr.get('/candidates', requirePermission('candidate:list'), async (c) => {
  const db = c.get('db');
  const where = ['purged_at IS NULL'];
  const params = [];
  if (c.req.query('status')) {
    where.push('status = ?');
    params.push(c.req.query('status'));
  }
  if (c.req.query('q')) {
    where.push('(first_name LIKE ? OR last_name LIKE ? OR application_no LIKE ? OR phone LIKE ?)');
    const q = `%${c.req.query('q')}%`;
    params.push(q, q, q, q);
  }
  const rows = await db.all(
    `SELECT id, application_no, national_id, title_th, first_name, last_name, phone, position_applied, status,
            main_sync_status, review_flags, created_at, updated_at
     FROM candidates WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`, ...params);
  const full = can(c.get('user'), 'candidate:view-sensitive');
  const counts = Object.fromEntries(
    (await db.all('SELECT status, COUNT(*) AS n FROM candidates WHERE purged_at IS NULL GROUP BY status')).map((r) => [r.status, r.n]));
  return c.json({
    counts,
    candidates: rows.map((r) => ({
      ...r,
      national_id: full ? r.national_id : maskThaiId(r.national_id),
      flag_count: r.review_flags ? JSON.parse(r.review_flags).length : 0,
      review_flags: undefined,
    })),
  });
});

function candidateView(user, cand) {
  const full = can(user, 'candidate:view-sensitive');
  const application = JSON.parse(cand.application_json || '{}');
  if (!full) delete application.declarations;
  const { application_json, tracking_token, review_flags, ...rest } = cand;
  return {
    ...rest,
    national_id: full ? cand.national_id : maskThaiId(cand.national_id),
    father_name: full ? cand.father_name : null,
    mother_name: full ? cand.mother_name : null,
    application,
    review_flags: JSON.parse(review_flags || '[]'),
  };
}

const getCandidate = (db, id) => db.one('SELECT * FROM candidates WHERE id = ?', Number(id));

hr.get('/candidates/:id', requirePermission('candidate:list'), async (c) => {
  const db = c.get('db');
  const user = c.get('user');
  const cand = await getCandidate(db, c.req.param('id'));
  if (!cand || cand.purged_at) return c.json({ error: 'ไม่พบผู้สมัคร' }, 404);
  const canSeeDocs = can(user, 'document:view') && (cand.status !== 'REJECTED' || can(user, 'document:view-rejected'));
  const documents = (await db.all('SELECT id, doc_type, mime_type, size_bytes, ocr_json, uploaded_at FROM documents WHERE candidate_id = ? AND deleted_at IS NULL', cand.id))
    .map((d) => ({ ...d, ocr: JSON.parse(d.ocr_json || 'null'), ocr_json: undefined, viewable: canSeeDocs }));
  const checks = (await db.all(
    `SELECT bc.id, bc.status, bc.submitted_at, bc.result_at, bc.case_detail, b.batch_no, u.full_name AS recorded_by
     FROM background_checks bc LEFT JOIN check_batches b ON b.id = bc.batch_id LEFT JOIN users_hr u ON u.id = bc.recorded_by
     WHERE bc.candidate_id = ? ORDER BY bc.id DESC`, cand.id))
    .map((k) => (can(user, 'check:view-detail') ? k : { ...k, case_detail: undefined }));
  await audit(c, 'VIEW_CANDIDATE', cand.id);
  return c.json({
    candidate: candidateView(user, cand),
    work: await db.all('SELECT * FROM work_experiences WHERE candidate_id = ?', cand.id),
    documents,
    consents: await db.all('SELECT consent_type, consent_version, content_sha256, signed_at, ip_address FROM consents WHERE candidate_id = ?', cand.id),
    checks,
    gate: { unlocked: cand.status === 'PASSED', alert: cand.status === 'REJECTED' ? 'ห้ามคีย์เข้าสู่ระบบหลัก และห้ามพิมพ์เอกสาร' : null },
  });
});

hr.get('/documents/:id/file', requirePermission('document:view'), async (c) => {
  const d = await c.get('db').one(
    'SELECT d.*, c.status FROM documents d JOIN candidates c ON c.id = d.candidate_id WHERE d.id = ? AND d.deleted_at IS NULL', Number(c.req.param('id')));
  if (!d) return c.json({ error: 'ไม่พบเอกสาร' }, 404);
  if (d.status === 'REJECTED' && !can(c.get('user'), 'document:view-rejected')) return c.json({ error: 'ไม่มีสิทธิ์ดูเอกสารของเคสที่ถูกปฏิเสธ' }, 403);
  const body = await c.get('store').get(d.storage_path);
  if (!body) return c.json({ error: 'ไม่พบไฟล์' }, 404);
  await audit(c, 'VIEW_DOCUMENT', d.candidate_id, { document_id: d.id, doc_type: d.doc_type });
  return new Response(body, {
    headers: { 'Content-Type': d.mime_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
  });
});

// --- Background check gatekeeper ---

const csvCell = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;

hr.post('/batches', requirePermission('batch:export'), async (c) => {
  const db = c.get('db');
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body?.candidate_ids) ? body.candidate_ids.map(Number) : null;
  const rows = ids
    ? await db.all(`SELECT id FROM candidates WHERE status = 'PENDING_CHECK' AND id IN (${ids.map(() => '?').join(',') || 'NULL'})`, ...ids)
    : await db.all("SELECT id FROM candidates WHERE status = 'PENDING_CHECK' ORDER BY created_at");
  if (!rows.length) return c.json({ error: 'ไม่มีผู้สมัครที่รอส่งตรวจประวัติ' }, 400);
  const day = bangkokDate().replaceAll('-', '');
  const { n } = await db.one('SELECT COUNT(*) AS n FROM check_batches WHERE batch_no LIKE ?', `BC-${day}-%`);
  const batchNo = `BC-${day}-${String(n + 1).padStart(2, '0')}`;
  const batchId = `(SELECT id FROM check_batches WHERE batch_no = '${batchNo}')`;
  await db.batch([
    db.stmt('INSERT INTO check_batches (batch_no, exported_by, candidate_count) VALUES (?, ?, ?)', batchNo, c.get('user').id, rows.length),
    ...rows.flatMap((r) => [
      db.stmt(`INSERT INTO background_checks (candidate_id, batch_id) VALUES (?, ${batchId})`, r.id),
      db.stmt("UPDATE candidates SET status = 'IN_CHECK', updated_at = datetime('now') WHERE id = ?", r.id),
    ]),
  ]);
  const { id } = await db.one('SELECT id FROM check_batches WHERE batch_no = ?', batchNo);
  await audit(c, 'BATCH_EXPORT', null, { id, batch_no: batchNo, count: rows.length });
  return c.json({ id, batch_no: batchNo, count: rows.length, csv_url: `/api/hr/batches/${id}/csv` }, 201);
});

hr.get('/batches', requirePermission('batch:export'), async (c) => c.json({
  batches: await c.get('db').all(
    `SELECT b.*, u.full_name AS exported_by_name,
       SUM(bc.status = 'PENDING') AS pending, SUM(bc.status = 'PASSED') AS passed, SUM(bc.status = 'FAILED') AS failed
     FROM check_batches b JOIN users_hr u ON u.id = b.exported_by LEFT JOIN background_checks bc ON bc.batch_id = b.id
     GROUP BY b.id ORDER BY b.id DESC LIMIT 30`),
}));

hr.get('/batches/:id/pending', requirePermission('check:record'), async (c) => c.json({
  candidates: await c.get('db').all(
    `SELECT c.id, c.application_no, c.national_id, c.title_th, c.first_name, c.last_name
     FROM background_checks bc JOIN candidates c ON c.id = bc.candidate_id
     WHERE bc.batch_id = ? AND bc.status = 'PENDING' ORDER BY c.id`, Number(c.req.param('id'))),
}));

hr.get('/batches/:id/csv', requirePermission('batch:export'), async (c) => {
  const db = c.get('db');
  const batch = await db.one('SELECT * FROM check_batches WHERE id = ?', Number(c.req.param('id')));
  if (!batch) return c.json({ error: 'ไม่พบรอบส่งตรวจ' }, 404);
  const rows = await db.all('SELECT c.* FROM background_checks bc JOIN candidates c ON c.id = bc.candidate_id WHERE bc.batch_id = ? ORDER BY c.id', batch.id);
  const header = ['ลำดับ', 'เลขที่ใบสมัคร', 'เลขประจำตัวประชาชน', 'คำนำหน้า', 'ชื่อ', 'นามสกุล', 'วันเกิด', 'ชื่อบิดา', 'ชื่อมารดา', 'ที่อยู่ตามทะเบียนบ้าน', 'ตำแหน่ง'];
  const lines = rows.map((r, i) => [
    i + 1, r.application_no, r.national_id, r.title_th, r.first_name, r.last_name, r.birth_date, r.father_name, r.mother_name,
    [r.addr_house_no, r.addr_moo && `ม.${r.addr_moo}`, r.addr_soi && `ซ.${r.addr_soi}`, r.addr_road && `ถ.${r.addr_road}`,
      r.addr_subdistrict, r.addr_district, r.addr_province].filter(Boolean).join(' '),
    r.position_applied,
  ].map(csvCell).join(','));
  await audit(c, 'BATCH_CSV_DOWNLOAD', null, { batch_no: batch.batch_no });
  return new Response('﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n'), {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${batch.batch_no}.csv"` },
  });
});

// Statements that record one result; run together with db.batch so a batch result is all-or-nothing
async function resultStatements(db, userId, candidateId, result, caseDetail) {
  const cand = await getCandidate(db, candidateId);
  if (!cand || cand.status !== 'IN_CHECK') throw new HttpError(409, `ผู้สมัคร ${cand?.application_no ?? candidateId} ไม่ได้อยู่ระหว่างตรวจประวัติ`);
  const check = await db.one("SELECT id FROM background_checks WHERE candidate_id = ? AND status = 'PENDING' ORDER BY id DESC", cand.id);
  if (result === 'FAILED') {
    const deleteAfter = new Date(Date.now() + config.retentionDays * 86400 * 1000).toISOString();
    return [
      db.stmt("UPDATE background_checks SET status = 'FAILED', result_at = datetime('now'), case_detail = ?, recorded_by = ? WHERE id = ?", caseDetail || null, userId, check.id),
      db.stmt("UPDATE candidates SET status = 'REJECTED', is_locked = 1, main_sync_status = 'NOT_ALLOWED', retention_delete_after = ?, updated_at = datetime('now') WHERE id = ?", deleteAfter, cand.id),
      db.stmt("INSERT INTO audit_logs (user_id, action, candidate_id) VALUES (?, 'CHECK_FAILED', ?)", userId, cand.id),
    ];
  }
  return [
    db.stmt("UPDATE background_checks SET status = 'PASSED', result_at = datetime('now'), recorded_by = ? WHERE id = ?", userId, check.id),
    db.stmt("UPDATE candidates SET status = 'PASSED', is_locked = 0, main_sync_status = 'QUEUED', updated_at = datetime('now') WHERE id = ?", cand.id),
    db.stmt("INSERT INTO audit_logs (user_id, action, candidate_id) VALUES (?, 'CHECK_PASSED', ?)", userId, cand.id),
  ];
}

function assertPassed(cand) {
  if (!cand || cand.status !== 'PASSED' || cand.is_locked) {
    throw new GatekeeperError('ห้ามคีย์เข้าสู่ระบบหลัก และห้ามพิมพ์เอกสาร — ผู้สมัครยังไม่ผ่านการตรวจประวัติ');
  }
}

// The only way candidate data leaves for the main HR system (webhook, or a JSON file in R2 outbox/)
async function syncToMainSystem(env, db, candidateId) {
  const cand = await getCandidate(db, candidateId);
  assertPassed(cand);
  await db.run("UPDATE candidates SET main_sync_status = 'QUEUED', main_sync_error = NULL WHERE id = ?", cand.id);
  const payload = {
    source: 'q-recruit', application_no: cand.application_no, national_id: cand.national_id, title_th: cand.title_th,
    first_name: cand.first_name, last_name: cand.last_name, first_name_en: cand.first_name_en, last_name_en: cand.last_name_en,
    birth_date: cand.birth_date, phone: cand.phone, email: cand.email,
    address: {
      house_no: cand.addr_house_no, moo: cand.addr_moo, soi: cand.addr_soi, road: cand.addr_road,
      subdistrict: cand.addr_subdistrict, district: cand.addr_district, province: cand.addr_province, postal_code: cand.addr_postal_code,
    },
    position_applied: cand.position_applied,
    application: JSON.parse(cand.application_json || '{}'),
    work_experiences: await db.all('SELECT company, business_type, position, duties, salary, start_date, end_date, reason_leaving FROM work_experiences WHERE candidate_id = ?', cand.id),
    background_check: 'PASSED',
  };
  try {
    let ref;
    if (config.mainSystemWebhook) {
      const res = await fetch(config.mainSystemWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': cand.application_no },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ref = (await res.json().catch(() => ({}))).id ?? cand.application_no;
    } else {
      ref = `outbox/${cand.application_no}.json`;
      await storeOf(env).put(ref, JSON.stringify(payload, null, 2), 'application/json');
    }
    await db.run("UPDATE candidates SET main_sync_status = 'SENT', main_sync_ref = ?, main_synced_at = datetime('now') WHERE id = ?", String(ref), cand.id);
    return { ok: true, ref };
  } catch (err) {
    await db.run("UPDATE candidates SET main_sync_status = 'FAILED', main_sync_error = ? WHERE id = ?", err.message, cand.id);
    return { ok: false, error: err.message };
  }
}

hr.post('/candidates/:id/check-result', requirePermission('check:record'), async (c) => {
  const db = c.get('db');
  const body = await c.req.json().catch(() => ({}));
  if (!['PASSED', 'FAILED'].includes(body?.result)) throw new HttpError(400, 'result ต้องเป็น PASSED หรือ FAILED');
  const id = Number(c.req.param('id'));
  await db.batch(await resultStatements(db, c.get('user').id, id, body.result, body.case_detail));
  const sync = body.result === 'PASSED' ? await syncToMainSystem(c.env, db, id) : null;
  return c.json({ ok: true, sync });
});

hr.post('/batches/:id/results', requirePermission('check:record'), async (c) => {
  const db = c.get('db');
  const body = await c.req.json().catch(() => ({}));
  const failed = new Map((body?.failed || []).map((f) => [Number(f.candidate_id), f.case_detail]));
  const pending = await db.all("SELECT candidate_id FROM background_checks WHERE batch_id = ? AND status = 'PENDING'", Number(c.req.param('id')));
  if (!pending.length) throw new HttpError(400, 'ไม่มีผู้สมัครที่รอผลในรอบนี้');
  const stmts = [];
  const passedIds = [];
  for (const { candidate_id } of pending) {
    const r = failed.has(candidate_id) ? 'FAILED' : 'PASSED';
    stmts.push(...(await resultStatements(db, c.get('user').id, candidate_id, r, failed.get(candidate_id))));
    if (r === 'PASSED') passedIds.push(candidate_id);
  }
  await db.batch(stmts);
  const syncs = [];
  for (const id of passedIds) syncs.push(await syncToMainSystem(c.env, db, id));
  return c.json({ passed: passedIds.length, failed: pending.length - passedIds.length, sync_failed: syncs.filter((s) => !s.ok).length });
});

hr.post('/candidates/:id/reset-check', requirePermission('check:record'), async (c) => {
  const db = c.get('db');
  const cand = await getCandidate(db, c.req.param('id'));
  if (!cand || cand.status !== 'IN_CHECK') return c.json({ error: 'ทำได้เฉพาะผู้สมัครที่อยู่ระหว่างตรวจประวัติ' }, 409);
  await db.batch([
    db.stmt("DELETE FROM background_checks WHERE candidate_id = ? AND status = 'PENDING'", cand.id),
    db.stmt("UPDATE candidates SET status = 'PENDING_CHECK', updated_at = datetime('now') WHERE id = ?", cand.id),
  ]);
  await audit(c, 'CHECK_RESET', cand.id);
  return c.json({ ok: true });
});

// --- Unlocked actions (PASSED only) ---

hr.post('/candidates/:id/sync', requirePermission('candidate:sync-and-print'), async (c) => {
  const id = Number(c.req.param('id'));
  const result = await syncToMainSystem(c.env, c.get('db'), id);
  await audit(c, 'MAIN_SYNC', id, result);
  return c.json(result, result.ok ? 200 : 502);
});

hr.get('/candidates/:id/dossier', requirePermission('candidate:sync-and-print'), async (c) => {
  const db = c.get('db');
  const cand = await getCandidate(db, c.req.param('id'));
  assertPassed(cand);
  const rendered = renderConsents(cand);
  const signed = await db.all('SELECT consent_type, content_sha256, signed_at, signature_document_id FROM consents WHERE candidate_id = ?', cand.id);
  await audit(c, 'PRINT_DOSSIER', cand.id);
  return c.json({
    company: config.companyName,
    candidate: { ...cand, application: JSON.parse(cand.application_json || '{}'), application_json: undefined, tracking_token: undefined },
    work: await db.all('SELECT * FROM work_experiences WHERE candidate_id = ?', cand.id),
    documents: await db.all('SELECT id, doc_type, mime_type FROM documents WHERE candidate_id = ? AND deleted_at IS NULL', cand.id),
    consents: signed.map((s) => {
      const t = rendered.find((x) => x.type === s.consent_type);
      return { ...s, title: t?.title, text: t?.sha256 === s.content_sha256 ? t.text : null };
    }),
  });
});

// --- Manager tools ---

hr.get('/audit', requirePermission('audit:view'), async (c) => c.json({
  logs: await c.get('db').all(
    `SELECT a.*, u.full_name AS user_name, c.application_no FROM audit_logs a
     LEFT JOIN users_hr u ON u.id = a.user_id LEFT JOIN candidates c ON c.id = a.candidate_id
     ORDER BY a.id DESC LIMIT 300`),
}));

hr.post('/retention/run', requirePermission('retention:run'), async (c) => {
  const result = await runRetention(c.env);
  await audit(c, 'RETENTION_RUN', null, result);
  return c.json(result);
});

app.route('/api/hr', hr);

// ---------- retention (PDPA) — also runs hourly via the cron trigger ----------

async function runRetention(env) {
  configure(env);
  const db = dbOf(env);
  const due = await db.all(
    `SELECT id, application_no FROM candidates
     WHERE status = 'REJECTED' AND purged_at IS NULL AND retention_delete_after IS NOT NULL AND retention_delete_after <= ?`,
    new Date().toISOString());
  const purged = [];
  for (const cand of due) {
    const docs = await db.all('SELECT storage_path FROM documents WHERE candidate_id = ? AND deleted_at IS NULL', cand.id);
    if (docs.length) await storeOf(env).delete(docs.map((d) => d.storage_path));
    await db.batch([
      db.stmt("UPDATE documents SET deleted_at = datetime('now'), ocr_json = NULL WHERE candidate_id = ?", cand.id),
      db.stmt('DELETE FROM work_experiences WHERE candidate_id = ?', cand.id),
      db.stmt('UPDATE background_checks SET case_detail = NULL WHERE candidate_id = ?', cand.id),
      db.stmt(
        `UPDATE candidates SET national_id = NULL, title_th = NULL, first_name = NULL, last_name = NULL,
           first_name_en = NULL, last_name_en = NULL, birth_date = NULL, phone = NULL, email = NULL, line_id = NULL,
           addr_house_no = NULL, addr_moo = NULL, addr_soi = NULL, addr_road = NULL, addr_subdistrict = NULL,
           addr_district = NULL, addr_province = NULL, addr_postal_code = NULL,
           father_name = NULL, mother_name = NULL, application_json = NULL, review_flags = NULL,
           purged_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`, cand.id),
      db.stmt("INSERT INTO audit_logs (action, candidate_id, detail) VALUES ('RETENTION_PURGE', ?, ?)", cand.id, JSON.stringify({ files: docs.length })),
    ]);
    purged.push(cand.application_no);
  }
  return { purged };
}

// ---------- errors ----------

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof GatekeeperError) return c.json({ error: err.message, locked: true }, 423);
  if (err instanceof OcrError) return c.json({ error: err.message }, 422);
  if (err instanceof SyntaxError) return c.json({ error: 'ข้อมูลไม่ถูกต้อง' }, 400);
  console.error(err);
  return c.json({ error: 'เกิดข้อผิดพลาดในระบบ' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runRetention(env).then((r) => r.purged.length && console.log('[retention] purged', r.purged)));
  },
};
