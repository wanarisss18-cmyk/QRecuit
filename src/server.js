import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from './config.js';
import { db, tx, audit } from './db.js';
import { issueToken, verifyPassword, requireAuth, requirePermission, can, sign, verifySignature } from './auth.js';
import { isValidThaiId, maskThaiId } from './thaiId.js';
import { extractDocument, crossCheck, OcrError, OCR_DOC_TYPES } from './ocr.js';
import { renderConsents, CONSENT_TEMPLATES } from './consentTemplates.js';
import { assertPassed, syncToMainSystem, GatekeeperError } from './mainSystem.js';
import { runRetention, scheduleRetention } from './retention.js';

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(config.root, 'public')));
app.get('/', (req, res) => res.redirect('/apply/'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadBytes, files: 8 } });
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ---------- helpers ----------

function rateLimit(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip) || { n: 0, reset: now + windowMs };
    if (now > entry.reset) Object.assign(entry, { n: 0, reset: now + windowMs });
    entry.n += 1;
    hits.set(req.ip, entry);
    if (entry.n > max) return res.status(429).json({ error: 'ส่งคำขอถี่เกินไป กรุณารอสักครู่' });
    next();
  };
}

// Trust file content, not the browser's claimed MIME type
function sniffMime(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('hex') === '89504e47') return 'image/png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 4).toString() === '%PDF') return 'application/pdf';
  return null;
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

function saveFile(candidateId, docType, file, mime) {
  const rel = path.join('uploads', String(candidateId), `${docType}-${crypto.randomUUID()}.${EXT[mime]}`);
  fs.mkdirSync(path.join(config.dataDir, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, rel), file.buffer);
  return rel;
}

const bangkokDate = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

function nextApplicationNo() {
  const day = bangkokDate().replaceAll('-', '');
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM candidates WHERE application_no LIKE ?").get(`APP-${day}-%`);
  return `APP-${day}-${String(n + 1).padStart(4, '0')}`;
}

const getCandidate = (id) => db.prepare('SELECT * FROM candidates WHERE id = ?').get(Number(id));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- candidate portal (public) ----------

const OCR_TOKEN_DATA = (fileHash, result) => `${fileHash}.${JSON.stringify(result)}`;

app.post('/api/ocr', rateLimit(30, 10 * 60 * 1000), upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) throw new HttpError(400, 'กรุณาแนบรูปเอกสาร');
    const mime = sniffMime(req.file.buffer);
    if (!mime) throw new HttpError(400, 'รองรับเฉพาะไฟล์ JPG, PNG, WEBP หรือ PDF');
    const result = await extractDocument(req.file.buffer, mime, req.body.doc_type);
    // Signed so the submission can carry this result without paying for OCR twice
    res.json({ result, token: sign(OCR_TOKEN_DATA(sha256(req.file.buffer), result)) });
  } catch (err) {
    next(err);
  }
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

// The candidate reads exactly this text before signing; its hash is verified on submit
app.post('/api/consents/preview', (req, res) => {
  res.json({ consents: renderConsents(cleanPersonalLoose(req.body)) });
});
const cleanPersonalLoose = (input) => Object.fromEntries(PERSONAL_FIELDS.map((f) => [f, String(input?.[f] ?? '').trim()]));

const UPLOAD_FIELDS = ['ID_CARD', 'HOUSE_REG', 'DRIVER_LICENSE', 'PHOTO', 'EDUCATION', 'SIGNATURE'];

app.post(
  '/api/applications',
  rateLimit(10, 10 * 60 * 1000),
  upload.fields(UPLOAD_FIELDS.map((name) => ({ name, maxCount: 1 }))),
  (req, res, next) => {
    try {
      const data = JSON.parse(req.body.data || '{}');
      const personal = cleanPersonal(data.personal);
      const files = Object.fromEntries(Object.entries(req.files || {}).map(([k, [f]]) => [k, f]));
      for (const [k, label] of [['ID_CARD', 'รูปบัตรประชาชน'], ['HOUSE_REG', 'รูปทะเบียนบ้าน'], ['SIGNATURE', 'ลายเซ็น']]) {
        if (!files[k]) throw new HttpError(422, `กรุณาแนบ${label}`);
      }
      const mimes = {};
      for (const [k, f] of Object.entries(files)) {
        mimes[k] = sniffMime(f.buffer);
        if (!mimes[k] || (k === 'SIGNATURE' && mimes[k] !== 'image/png')) throw new HttpError(400, `ไฟล์ ${k} ไม่ถูกต้อง`);
      }

      // Every consent must be accepted, and against the exact text we would render now
      const expected = renderConsents(personal);
      const accepted = new Map((data.consents || []).map((c) => [c.type, c.sha256]));
      for (const c of expected) {
        if (accepted.get(c.type) !== c.sha256) throw new HttpError(422, `กรุณาอ่านและยินยอม "${c.title}" อีกครั้ง`);
      }

      // Keep OCR results only when their signature matches the uploaded file
      const ocrByType = {};
      for (const type of OCR_DOC_TYPES) {
        const o = data.ocr?.[type];
        if (o && files[type] && verifySignature(OCR_TOKEN_DATA(sha256(files[type].buffer), o.result), o.token)) {
          ocrByType[type] = o.result;
        }
      }
      const flags = crossCheck(ocrByType, personal);

      const trackingToken = crypto.randomBytes(18).toString('base64url');
      const result = tx(() => {
        const applicationNo = nextApplicationNo();
        const cols = [...PERSONAL_FIELDS, 'application_no', 'tracking_token', 'application_json', 'review_flags'];
        const values = [
          ...PERSONAL_FIELDS.map((f) => personal[f]),
          applicationNo, trackingToken, JSON.stringify(data.application || {}), flags.length ? JSON.stringify(flags) : null,
        ];
        const { lastInsertRowid } = db
          .prepare(`INSERT INTO candidates (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
          .run(...values);
        const candidateId = Number(lastInsertRowid);

        const insertWork = db.prepare(
          `INSERT INTO work_experiences (candidate_id, company, business_type, position, duties, salary, start_date, end_date, reason_leaving)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        for (const w of (data.work || []).slice(0, 10)) {
          if (!w?.company) continue;
          insertWork.run(candidateId, w.company, w.business_type || null, w.position || null, w.duties || null,
            Number(w.salary) || null, w.start_date || null, w.end_date || null, w.reason_leaving || null);
        }

        const insertDoc = db.prepare(
          `INSERT INTO documents (candidate_id, doc_type, storage_path, original_name, mime_type, size_bytes, sha256, ocr_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const docIds = {};
        for (const [type, f] of Object.entries(files)) {
          const rel = saveFile(candidateId, type, f, mimes[type]);
          docIds[type] = Number(insertDoc.run(candidateId, type, rel, f.originalname, mimes[type], f.size, sha256(f.buffer),
            ocrByType[type] ? JSON.stringify(ocrByType[type]) : null).lastInsertRowid);
        }

        const insertConsent = db.prepare(
          `INSERT INTO consents (candidate_id, consent_type, consent_version, content_sha256, signature_document_id, ip_address, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        for (const c of expected) {
          insertConsent.run(candidateId, c.type, c.version, c.sha256, docIds.SIGNATURE, req.ip, req.get('user-agent') || null);
        }
        return { candidateId, applicationNo };
      });

      res.status(201).json({ application_no: result.applicationNo, tracking_token: trackingToken });
    } catch (err) {
      if (String(err.message).includes('ux_candidates_active_nid') || String(err.message).includes('UNIQUE constraint failed: candidates.national_id')) {
        return next(new HttpError(409, 'เลขบัตรประชาชนนี้มีใบสมัครที่อยู่ระหว่างดำเนินการแล้ว'));
      }
      next(err);
    }
  }
);

const PUBLIC_STATUS = {
  PENDING_CHECK: { step: 1, text: 'ระบบได้รับข้อมูลเรียบร้อยแล้ว รอส่งตรวจสอบประวัติ' },
  IN_CHECK: { step: 2, text: 'ระบบได้รับข้อมูลเรียบร้อยแล้ว อยู่ระหว่างการตรวจสอบประวัติ' },
  PASSED: { step: 3, text: 'ผ่านการตรวจสอบประวัติแล้ว เจ้าหน้าที่จะติดต่อกลับเพื่อนัดหมาย' },
  // Deliberately neutral — the reason is never shown to the candidate
  REJECTED: { step: 3, text: 'ขอขอบคุณที่สนใจร่วมงานกับเรา ขณะนี้บริษัทฯ ยังไม่สามารถดำเนินการใบสมัครของท่านต่อได้' },
};

app.get('/api/applications/status/:token', rateLimit(60, 60 * 1000), (req, res) => {
  const c = db.prepare('SELECT application_no, first_name, position_applied, status, created_at FROM candidates WHERE tracking_token = ?').get(req.params.token);
  if (!c) return res.status(404).json({ error: 'ไม่พบใบสมัคร' });
  res.json({ ...c, ...PUBLIC_STATUS[c.status] });
});

app.get('/api/meta', (req, res) => {
  res.json({ company: config.companyName, ocr_provider: config.ocrProvider, consent_types: CONSENT_TEMPLATES.map((t) => t.title) });
});

// ---------- HR ----------

app.post('/api/auth/login', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users_hr WHERE username = ? AND is_active = 1').get(String(username || ''));
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  }
  req.user = user;
  audit(req, 'LOGIN');
  res.json({ token: issueToken(user), user: { name: user.full_name, role: user.role } });
});

const hr = express.Router();
hr.use(requireAuth);

hr.get('/me', (req, res) => {
  const permissions = Object.fromEntries(
    ['candidate:view-sensitive', 'check:record', 'check:view-detail', 'audit:view', 'retention:run'].map((p) => [p, can(req.user, p)])
  );
  res.json({ user: req.user, permissions });
});

hr.get('/candidates', requirePermission('candidate:list'), (req, res) => {
  const where = ['purged_at IS NULL'];
  const params = [];
  if (req.query.status) {
    where.push('status = ?');
    params.push(String(req.query.status));
  }
  if (req.query.q) {
    where.push("(first_name LIKE ? OR last_name LIKE ? OR application_no LIKE ? OR phone LIKE ?)");
    const q = `%${req.query.q}%`;
    params.push(q, q, q, q);
  }
  const rows = db.prepare(
    `SELECT id, application_no, national_id, title_th, first_name, last_name, phone, position_applied, status,
            main_sync_status, review_flags, created_at, updated_at
     FROM candidates WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 500`
  ).all(...params);
  const full = can(req.user, 'candidate:view-sensitive');
  const counts = Object.fromEntries(
    db.prepare('SELECT status, COUNT(*) AS n FROM candidates WHERE purged_at IS NULL GROUP BY status').all().map((r) => [r.status, r.n])
  );
  res.json({
    counts,
    candidates: rows.map((r) => ({
      ...r,
      national_id: full ? r.national_id : maskThaiId(r.national_id),
      flag_count: r.review_flags ? JSON.parse(r.review_flags).length : 0,
      review_flags: undefined,
    })),
  });
});

const SENSITIVE_APPLICATION_KEYS = ['declarations'];

function candidateView(req, c) {
  const full = can(req.user, 'candidate:view-sensitive');
  const application = JSON.parse(c.application_json || '{}');
  if (!full) for (const k of SENSITIVE_APPLICATION_KEYS) delete application[k];
  const { application_json, tracking_token, review_flags, ...rest } = c;
  return {
    ...rest,
    national_id: full ? c.national_id : maskThaiId(c.national_id),
    father_name: full ? c.father_name : null,
    mother_name: full ? c.mother_name : null,
    application,
    review_flags: JSON.parse(review_flags || '[]'),
  };
}

hr.get('/candidates/:id', requirePermission('candidate:list'), (req, res) => {
  const c = getCandidate(req.params.id);
  if (!c || c.purged_at) return res.status(404).json({ error: 'ไม่พบผู้สมัคร' });
  const canSeeDocs = can(req.user, 'document:view') && (c.status !== 'REJECTED' || can(req.user, 'document:view-rejected'));
  const documents = db.prepare('SELECT id, doc_type, mime_type, size_bytes, ocr_json, uploaded_at FROM documents WHERE candidate_id = ? AND deleted_at IS NULL').all(c.id)
    .map((d) => ({ ...d, ocr: JSON.parse(d.ocr_json || 'null'), ocr_json: undefined, viewable: canSeeDocs }));
  const checks = db.prepare(
    `SELECT bc.id, bc.status, bc.submitted_at, bc.result_at, bc.case_detail, b.batch_no, u.full_name AS recorded_by
     FROM background_checks bc LEFT JOIN check_batches b ON b.id = bc.batch_id LEFT JOIN users_hr u ON u.id = bc.recorded_by
     WHERE bc.candidate_id = ? ORDER BY bc.id DESC`
  ).all(c.id).map((k) => (can(req.user, 'check:view-detail') ? k : { ...k, case_detail: undefined }));
  audit(req, 'VIEW_CANDIDATE', c.id);
  res.json({
    candidate: candidateView(req, c),
    work: db.prepare('SELECT * FROM work_experiences WHERE candidate_id = ?').all(c.id),
    documents,
    consents: db.prepare('SELECT consent_type, consent_version, content_sha256, signed_at, ip_address FROM consents WHERE candidate_id = ?').all(c.id),
    checks,
    gate: {
      unlocked: c.status === 'PASSED',
      alert: c.status === 'REJECTED' ? 'ห้ามคีย์เข้าสู่ระบบหลัก และห้ามพิมพ์เอกสาร' : null,
    },
  });
});

hr.get('/documents/:id/file', requirePermission('document:view'), (req, res) => {
  const d = db.prepare(
    'SELECT d.*, c.status FROM documents d JOIN candidates c ON c.id = d.candidate_id WHERE d.id = ? AND d.deleted_at IS NULL'
  ).get(Number(req.params.id));
  if (!d) return res.status(404).json({ error: 'ไม่พบเอกสาร' });
  if (d.status === 'REJECTED' && !can(req.user, 'document:view-rejected')) return res.status(403).json({ error: 'ไม่มีสิทธิ์ดูเอกสารของเคสที่ถูกปฏิเสธ' });
  audit(req, 'VIEW_DOCUMENT', d.candidate_id, { document_id: d.id, doc_type: d.doc_type });
  res.set({ 'Content-Type': d.mime_type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.sendFile(path.join(config.dataDir, d.storage_path));
});

// --- Background check gatekeeper ---

const csvCell = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;

hr.post('/batches', requirePermission('batch:export'), (req, res) => {
  const ids = Array.isArray(req.body?.candidate_ids) ? req.body.candidate_ids.map(Number) : null;
  const rows = ids
    ? db.prepare(`SELECT * FROM candidates WHERE status = 'PENDING_CHECK' AND id IN (${ids.map(() => '?').join(',') || 'NULL'})`).all(...ids)
    : db.prepare("SELECT * FROM candidates WHERE status = 'PENDING_CHECK' ORDER BY created_at").all();
  if (!rows.length) return res.status(400).json({ error: 'ไม่มีผู้สมัครที่รอส่งตรวจประวัติ' });

  const batch = tx(() => {
    const day = bangkokDate().replaceAll('-', '');
    const { n } = db.prepare("SELECT COUNT(*) AS n FROM check_batches WHERE batch_no LIKE ?").get(`BC-${day}-%`);
    const batchNo = `BC-${day}-${String(n + 1).padStart(2, '0')}`;
    const batchId = Number(db.prepare('INSERT INTO check_batches (batch_no, exported_by, candidate_count) VALUES (?, ?, ?)').run(batchNo, req.user.id, rows.length).lastInsertRowid);
    const insertCheck = db.prepare('INSERT INTO background_checks (candidate_id, batch_id) VALUES (?, ?)');
    const setStatus = db.prepare("UPDATE candidates SET status = 'IN_CHECK', updated_at = datetime('now') WHERE id = ?");
    for (const c of rows) {
      insertCheck.run(c.id, batchId);
      setStatus.run(c.id);
    }
    return { id: batchId, batch_no: batchNo };
  });
  audit(req, 'BATCH_EXPORT', null, { ...batch, count: rows.length });
  res.status(201).json({ ...batch, count: rows.length, csv_url: `/api/hr/batches/${batch.id}/csv` });
});

hr.get('/batches', requirePermission('batch:export'), (req, res) => {
  res.json({
    batches: db.prepare(
      `SELECT b.*, u.full_name AS exported_by_name,
         SUM(bc.status = 'PENDING') AS pending, SUM(bc.status = 'PASSED') AS passed, SUM(bc.status = 'FAILED') AS failed
       FROM check_batches b JOIN users_hr u ON u.id = b.exported_by LEFT JOIN background_checks bc ON bc.batch_id = b.id
       GROUP BY b.id ORDER BY b.id DESC LIMIT 30`
    ).all(),
  });
});

hr.get('/batches/:id/pending', requirePermission('check:record'), (req, res) => {
  res.json({
    candidates: db.prepare(
      `SELECT c.id, c.application_no, c.national_id, c.title_th, c.first_name, c.last_name
       FROM background_checks bc JOIN candidates c ON c.id = bc.candidate_id
       WHERE bc.batch_id = ? AND bc.status = 'PENDING' ORDER BY c.id`
    ).all(Number(req.params.id)),
  });
});

// The file sent to the background-check office; contains full IDs, so it is audited
hr.get('/batches/:id/csv', requirePermission('batch:export'), (req, res) => {
  const batch = db.prepare('SELECT * FROM check_batches WHERE id = ?').get(Number(req.params.id));
  if (!batch) return res.status(404).json({ error: 'ไม่พบรอบส่งตรวจ' });
  const rows = db.prepare(
    `SELECT c.* FROM background_checks bc JOIN candidates c ON c.id = bc.candidate_id WHERE bc.batch_id = ? ORDER BY c.id`
  ).all(batch.id);
  const header = ['ลำดับ', 'เลขที่ใบสมัคร', 'เลขประจำตัวประชาชน', 'คำนำหน้า', 'ชื่อ', 'นามสกุล', 'วันเกิด', 'ชื่อบิดา', 'ชื่อมารดา', 'ที่อยู่ตามทะเบียนบ้าน', 'ตำแหน่ง'];
  const lines = rows.map((c, i) => [
    i + 1, c.application_no, c.national_id, c.title_th, c.first_name, c.last_name, c.birth_date, c.father_name, c.mother_name,
    [c.addr_house_no, c.addr_moo && `ม.${c.addr_moo}`, c.addr_soi && `ซ.${c.addr_soi}`, c.addr_road && `ถ.${c.addr_road}`,
      c.addr_subdistrict, c.addr_district, c.addr_province].filter(Boolean).join(' '),
    c.position_applied,
  ].map(csvCell).join(','));
  audit(req, 'BATCH_CSV_DOWNLOAD', null, { batch_no: batch.batch_no });
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${batch.batch_no}.csv"` });
  res.send('﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n'));
});

function recordResult(req, candidateId, result, caseDetail) {
  const c = getCandidate(candidateId);
  if (!c || c.status !== 'IN_CHECK') throw new HttpError(409, `ผู้สมัคร ${c?.application_no ?? candidateId} ไม่ได้อยู่ระหว่างตรวจประวัติ`);
  const check = db.prepare("SELECT id FROM background_checks WHERE candidate_id = ? AND status = 'PENDING' ORDER BY id DESC").get(c.id);
  if (result === 'FAILED') {
    const deleteAfter = new Date(Date.now() + config.retentionDays * 86400 * 1000).toISOString();
    db.prepare("UPDATE background_checks SET status = 'FAILED', result_at = datetime('now'), case_detail = ?, recorded_by = ? WHERE id = ?")
      .run(caseDetail || null, req.user.id, check.id);
    db.prepare(
      "UPDATE candidates SET status = 'REJECTED', is_locked = 1, main_sync_status = 'NOT_ALLOWED', retention_delete_after = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(deleteAfter, c.id);
  } else {
    db.prepare("UPDATE background_checks SET status = 'PASSED', result_at = datetime('now'), recorded_by = ? WHERE id = ?").run(req.user.id, check.id);
    db.prepare("UPDATE candidates SET status = 'PASSED', is_locked = 0, main_sync_status = 'QUEUED', updated_at = datetime('now') WHERE id = ?").run(c.id);
  }
  audit(req, `CHECK_${result}`, c.id);
  return c.id;
}

hr.post('/candidates/:id/check-result', requirePermission('check:record'), async (req, res, next) => {
  try {
    const result = req.body?.result;
    if (!['PASSED', 'FAILED'].includes(result)) throw new HttpError(400, 'result ต้องเป็น PASSED หรือ FAILED');
    const id = tx(() => recordResult(req, Number(req.params.id), result, req.body.case_detail));
    // Unlocked: hand the data to the main system right away
    const sync = result === 'PASSED' ? await syncToMainSystem(id) : null;
    res.json({ ok: true, sync });
  } catch (err) {
    next(err);
  }
});

// "ผลตรวจ = 0": everyone in the batch passes except the listed failures
hr.post('/batches/:id/results', requirePermission('check:record'), async (req, res, next) => {
  try {
    const failed = new Map((req.body?.failed || []).map((f) => [Number(f.candidate_id), f.case_detail]));
    const pending = db.prepare("SELECT candidate_id FROM background_checks WHERE batch_id = ? AND status = 'PENDING'").all(Number(req.params.id));
    if (!pending.length) throw new HttpError(400, 'ไม่มีผู้สมัครที่รอผลในรอบนี้');
    const passedIds = tx(() =>
      pending.map(({ candidate_id }) => {
        const r = failed.has(candidate_id) ? 'FAILED' : 'PASSED';
        recordResult(req, candidate_id, r, failed.get(candidate_id));
        return r === 'PASSED' ? candidate_id : null;
      }).filter(Boolean)
    );
    const syncs = [];
    for (const id of passedIds) syncs.push(await syncToMainSystem(id));
    res.json({ passed: passedIds.length, failed: pending.length - passedIds.length, sync_failed: syncs.filter((s) => !s.ok).length });
  } catch (err) {
    next(err);
  }
});

hr.post('/candidates/:id/reset-check', requirePermission('check:record'), (req, res) => {
  const c = getCandidate(req.params.id);
  if (!c || c.status !== 'IN_CHECK') return res.status(409).json({ error: 'ทำได้เฉพาะผู้สมัครที่อยู่ระหว่างตรวจประวัติ' });
  tx(() => {
    db.prepare("DELETE FROM background_checks WHERE candidate_id = ? AND status = 'PENDING'").run(c.id);
    db.prepare("UPDATE candidates SET status = 'PENDING_CHECK', updated_at = datetime('now') WHERE id = ?").run(c.id);
  });
  audit(req, 'CHECK_RESET', c.id);
  res.json({ ok: true });
});

// --- Unlocked actions (PASSED only) ---

hr.post('/candidates/:id/sync', requirePermission('candidate:sync-and-print'), async (req, res, next) => {
  try {
    const result = await syncToMainSystem(Number(req.params.id));
    audit(req, 'MAIN_SYNC', Number(req.params.id), result);
    res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    next(err);
  }
});

hr.get('/candidates/:id/dossier', requirePermission('candidate:sync-and-print'), (req, res, next) => {
  try {
    const c = getCandidate(req.params.id);
    assertPassed(c);
    const consents = renderConsents(c);
    const signed = db.prepare('SELECT consent_type, content_sha256, signed_at, signature_document_id FROM consents WHERE candidate_id = ?').all(c.id);
    audit(req, 'PRINT_DOSSIER', c.id);
    res.json({
      company: config.companyName,
      candidate: { ...c, application: JSON.parse(c.application_json || '{}'), application_json: undefined, tracking_token: undefined },
      work: db.prepare('SELECT * FROM work_experiences WHERE candidate_id = ?').all(c.id),
      documents: db.prepare('SELECT id, doc_type, mime_type FROM documents WHERE candidate_id = ? AND deleted_at IS NULL').all(c.id),
      consents: signed.map((s) => {
        const t = consents.find((x) => x.type === s.consent_type);
        // If the template changed after signing, show that instead of silently printing new wording
        return { ...s, title: t?.title, text: t?.sha256 === s.content_sha256 ? t.text : null };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// --- Manager tools ---

hr.get('/audit', requirePermission('audit:view'), (req, res) => {
  res.json({
    logs: db.prepare(
      `SELECT a.*, u.full_name AS user_name, c.application_no FROM audit_logs a
       LEFT JOIN users_hr u ON u.id = a.user_id LEFT JOIN candidates c ON c.id = a.candidate_id
       ORDER BY a.id DESC LIMIT 300`
    ).all(),
  });
});

hr.post('/retention/run', requirePermission('retention:run'), (req, res) => {
  const result = runRetention();
  audit(req, 'RETENTION_RUN', null, result);
  res.json(result);
});

app.use('/api/hr', hr);

// ---------- errors ----------

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof GatekeeperError) return res.status(423).json({ error: err.message, locked: true });
  if (err instanceof OcrError) return res.status(422).json({ error: err.message });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์ใหญ่เกิน 10MB' : err.message });
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  console.error(err);
  res.status(500).json({ error: 'เกิดข้อผิดพลาดในระบบ' });
});

scheduleRetention();
app.listen(config.port, () => {
  console.log(`Q-Recruit running at http://localhost:${config.port}  (OCR: ${config.ocrProvider})`);
  console.log(`  ผู้สมัคร: http://localhost:${config.port}/apply/`);
  console.log(`  HR:      http://localhost:${config.port}/hr/`);
});

// Phones only allow the in-page camera over HTTPS. For testing on the office Wi-Fi,
// a self-signed certificate in storage/certs turns on a second, HTTPS listener.
const certDir = path.join(config.dataDir, 'certs');
if (fs.existsSync(path.join(certDir, 'dev-cert.pem'))) {
  https
    .createServer({ key: fs.readFileSync(path.join(certDir, 'dev-key.pem')), cert: fs.readFileSync(path.join(certDir, 'dev-cert.pem')) }, app)
    .listen(config.httpsPort, () => console.log(`  HTTPS:   https://<this-computer-ip>:${config.httpsPort}/apply/  (self-signed, for phone testing)`));
}
