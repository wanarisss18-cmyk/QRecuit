import { api, thaiDate, toast, esc, icon, STATUS, DOC_LABEL } from '/assets/common.js';

let token = sessionStorage.getItem('hrToken');
let me = null;
let filter = { status: '', q: '' };
let candidates = [];
const selected = new Set();

const $ = (id) => document.getElementById(id);
const call = (url, opts = {}) => api(url, { ...opts, token }).catch((err) => {
  if (err.status === 401) logout();
  throw err;
});
const fileUrl = (docId) => `/api/hr/documents/${docId}/file?token=${encodeURIComponent(token)}`;

// ---------- auth ----------

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const res = await api('/api/auth/login', { method: 'POST', json: { username: f.get('username'), password: f.get('password') } });
    token = res.token;
    sessionStorage.setItem('hrToken', token);
    start();
  } catch (err) {
    $('loginError').textContent = err.message;
  }
});

function logout() {
  token = null;
  sessionStorage.removeItem('hrToken');
  $('boardView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  $('logout').classList.add('hidden');
  $('who').textContent = '';
}
$('logout').addEventListener('click', logout);

async function start() {
  if (!token) return logout();
  try {
    me = await call('/api/hr/me');
  } catch {
    return;
  }
  $('loginView').classList.add('hidden');
  $('boardView').classList.remove('hidden');
  $('logout').classList.remove('hidden');
  $('who').textContent = `${me.user.name} · ${me.user.role === 'manager' ? 'ผู้จัดการ' : 'เจ้าหน้าที่'}`;
  document.querySelectorAll('.manager-only').forEach((el) => el.classList.toggle('hidden', !me.permissions['audit:view']));
  loadBoard();
}

// ---------- tabs ----------

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll('[data-panel]').forEach((p) => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
    ({ board: loadBoard, batches: loadBatches, audit: loadAudit })[tab.dataset.tab]();
  });
}

// ---------- board ----------

function cutoffText() {
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setHours(16, 0, 0, 0);
  const mins = Math.round((cutoff - now) / 60000);
  return mins > 0
    ? `ผลตรวจประวัติออก 16:00 น. — เหลือเวลาอีก ${Math.floor(mins / 60)} ชม. ${mins % 60} นาที ควรส่ง Batch ก่อนเวลานี้`
    : 'เลย 16:00 น. แล้ว — ผู้สมัครที่ส่งตอนนี้จะได้ผลรอบถัดไป';
}

async function loadBoard() {
  const qs = new URLSearchParams(Object.entries(filter).filter(([, v]) => v));
  const res = await call(`/api/hr/candidates?${qs}`);
  candidates = res.candidates;
  $('cutoff').textContent = cutoffText();
  const total = Object.values(res.counts).reduce((a, b) => a + b, 0);
  $('kpis').innerHTML = [['', 'ทั้งหมด', total], ...Object.entries(STATUS).map(([k, s]) => [k, s.label, res.counts[k] || 0])]
    .map(([k, l, n]) => `<button class="kpi ${filter.status === k ? 'active' : ''}" data-status="${k}"><div class="n">${n}</div><div class="l">${l}</div></button>`)
    .join('');
  $('kpis').querySelectorAll('.kpi').forEach((b) => b.addEventListener('click', () => { filter.status = b.dataset.status; loadBoard(); }));

  selected.clear();
  $('selectAll').checked = false;
  $('rows').innerHTML = candidates.length ? candidates.map((c) => `
    <tr class="click ${c.status === 'REJECTED' ? 'rejected' : ''}" data-id="${c.id}">
      <td>${c.status === 'PENDING_CHECK' ? `<input type="checkbox" data-sel="${c.id}">` : ''}</td>
      <td>${esc(c.application_no)}</td>
      <td>${esc(`${c.title_th || ''}${c.first_name} ${c.last_name}`)} ${c.flag_count ? `<span class="flag" title="OCR พบข้อมูลไม่ตรงกัน">${icon('alert')} ${c.flag_count}</span>` : ''}</td>
      <td>${esc(c.national_id)}</td>
      <td>${esc(c.position_applied)}</td>
      <td><span class="badge ${STATUS[c.status].cls}">${STATUS[c.status].label}</span></td>
      <td>${syncBadge(c.main_sync_status)}</td>
      <td class="small">${thaiDate(c.created_at, true)}</td>
    </tr>`).join('') : '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">ไม่มีผู้สมัคร</td></tr>';
}

function syncBadge(s) {
  return {
    NOT_ALLOWED: `<span class="badge b-neutral">${icon('lock')} ห้ามคีย์</span>`,
    QUEUED: '<span class="badge b-check">กำลังส่ง</span>',
    SENT: '<span class="badge b-pass">✓ ส่งแล้ว</span>',
    FAILED: '<span class="badge b-fail">ส่งไม่สำเร็จ</span>',
  }[s] || '';
}

$('rows').addEventListener('click', (e) => {
  const sel = e.target.closest('[data-sel]');
  if (sel) {
    sel.checked ? selected.add(Number(sel.dataset.sel)) : selected.delete(Number(sel.dataset.sel));
    return;
  }
  const row = e.target.closest('tr[data-id]');
  if (row) openDetail(Number(row.dataset.id));
});
$('selectAll').addEventListener('change', (e) => {
  document.querySelectorAll('[data-sel]').forEach((b) => {
    b.checked = e.target.checked;
    e.target.checked ? selected.add(Number(b.dataset.sel)) : selected.delete(Number(b.dataset.sel));
  });
});

let searchTimer;
$('search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { filter.q = e.target.value.trim(); loadBoard(); }, 250);
});

async function downloadCsv(batchId, batchNo) {
  const res = await fetch(`/api/hr/batches/${batchId}/csv`, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) return toast('ดาวน์โหลดไม่สำเร็จ');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await res.blob()), download: `${batchNo}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
}

$('exportBtn').addEventListener('click', async () => {
  const ids = [...selected];
  const what = ids.length ? `${ids.length} คนที่เลือก` : 'ผู้สมัครทุกคนที่ "รอส่งตรวจประวัติ"';
  if (!confirm(`ส่งตรวจประวัติ ${what}?\nสถานะจะเปลี่ยนเป็น "อยู่ระหว่างตรวจประวัติ" และดาวน์โหลดไฟล์ CSV`)) return;
  try {
    const batch = await call('/api/hr/batches', { method: 'POST', json: ids.length ? { candidate_ids: ids } : {} });
    await downloadCsv(batch.id, batch.batch_no);
    toast(`สร้างรอบ ${batch.batch_no} (${batch.count} คน) แล้ว`);
    loadBoard();
  } catch (err) {
    toast(err.message);
  }
});

// ---------- detail drawer ----------

const dlg = $('detail');
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

const FLAG_TEXT = {
  DOCS_DISAGREE: 'ข้อมูลในเอกสารแต่ละใบไม่ตรงกัน',
  EDITED_AFTER_OCR: 'ผู้สมัครแก้ไขต่างจากที่ AI อ่านจากบัตร',
};
const FIELD_TEXT = { national_id: 'เลขบัตร', first_name: 'ชื่อ', first_name_th: 'ชื่อ', last_name: 'นามสกุล', last_name_th: 'นามสกุล', birth_date: 'วันเกิด' };

async function openDetail(id) {
  $('detailBody').innerHTML = '<div class="drawer-body"><span class="spinner"></span></div>';
  if (!dlg.open) dlg.showModal();
  let d;
  try {
    d = await call(`/api/hr/candidates/${id}`);
  } catch (err) {
    $('detailBody').innerHTML = `<div class="drawer-body alert alert-danger">${esc(err.message)}</div>`;
    return;
  }
  const c = d.candidate;
  const a = c.application || {};
  const isManager = me.permissions['check:record'];
  const kv = (pairs) => `<dl class="kv">${pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `<dt>${k}</dt><dd>${v === null || v === '' ? '-' : esc(v)}</dd>`).join('')}</dl>`;

  $('detailBody').innerHTML = `
    <div class="drawer-head">
      <div style="flex:1"><strong>${esc(`${c.title_th || ''}${c.first_name} ${c.last_name}`)}</strong><br>
        <span class="small muted">${esc(c.application_no)} · ${esc(c.position_applied)}</span></div>
      <span class="badge ${STATUS[c.status].cls}">${STATUS[c.status].label}</span>
      <button class="btn btn-sm" data-close>ปิด</button>
    </div>
    <div class="drawer-body">
      ${d.gate.alert ? `<div class="alert alert-danger">${icon('lock')}<span>${esc(d.gate.alert)}</span></div>` : ''}
      ${c.status === 'PASSED' ? `<div class="alert alert-ok">${icon('checkCircle')}<span>ผ่านการตรวจประวัติแล้ว — ปลดล็อกการส่งเข้าระบบหลักและการพิมพ์เอกสาร</span></div>` : ''}
      <div class="gate">
        ${isManager && c.status === 'IN_CHECK' ? `
          <button class="btn btn-ok" data-act="pass">ไม่พบประวัติ = 0 (ผ่าน)</button>
          <button class="btn btn-danger" data-act="fail">พบประวัติ / ไม่ผ่าน</button>
          <button class="btn" data-act="reset">ยกเลิกการส่งตรวจ</button>` : ''}
        <button class="btn" data-act="sync" ${d.gate.unlocked ? '' : 'disabled title="ปลดล็อกเมื่อผ่านการตรวจประวัติเท่านั้น"'}>${icon('send')} ส่งเข้าระบบหลัก${c.main_sync_status === 'SENT' ? ' (ซ้ำ)' : ''}</button>
        <a class="btn ${d.gate.unlocked ? '' : 'disabled'}" ${d.gate.unlocked ? `href="/hr/print.html?id=${c.id}" target="_blank"` : 'aria-disabled="true" title="ปลดล็อกเมื่อผ่านการตรวจประวัติเท่านั้น"'}>${icon('printer')} Print / PDF ชุดเอกสาร</a>
      </div>
      ${c.main_sync_status === 'FAILED' ? `<div class="alert alert-warn small">ส่งเข้าระบบหลักไม่สำเร็จ: ${esc(c.main_sync_error)}</div>` : ''}
      ${c.main_sync_status === 'SENT' ? `<p class="small muted">ส่งเข้าระบบหลักแล้ว ${thaiDate(c.main_synced_at, true)} · อ้างอิง ${esc(c.main_sync_ref)}</p>` : ''}

      ${c.review_flags.length ? `<div class="card"><h3>${icon('alert')} จุดที่ควรตรวจ (จาก AI OCR)</h3><ul class="small">${c.review_flags.map((f) =>
        `<li><strong>${FIELD_TEXT[f.field] || f.field}</strong>: ${FLAG_TEXT[f.kind] || f.kind} — ${esc(Object.entries(f.detail).map(([k, v]) => `${DOC_LABEL[k] || k}: ${v}`).join(' / '))}</li>`).join('')}</ul></div>` : ''}

      <div class="card"><h3>เอกสาร</h3>
        <div class="docs">${d.documents.map((doc) => `
          <div class="doc">
            ${doc.viewable && doc.mime_type.startsWith('image/') ? `<a href="${fileUrl(doc.id)}" target="_blank"><img src="${fileUrl(doc.id)}" alt="${DOC_LABEL[doc.doc_type]}" loading="lazy"></a>`
              : doc.viewable ? `<a href="${fileUrl(doc.id)}" target="_blank" class="btn btn-sm" style="margin:8px">เปิด PDF</a>` : `<div class="muted small" style="padding:8px">${icon('lock')} ไม่มีสิทธิ์ดู</div>`}
            <div class="cap"><strong>${DOC_LABEL[doc.doc_type]}</strong>${doc.ocr ? ' · <span class="badge b-pass">AI OCR</span>' : ''}</div>
            ${doc.ocr ? `<details class="cap"><summary>ผลที่ AI อ่าน</summary><table class="ocr-table">${Object.entries(doc.ocr)
              .filter(([k, v]) => v && !['low_confidence_fields', 'provider', 'document_type_detected', 'handwritten_annotation_present'].includes(k))
              .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}${doc.ocr.low_confidence_fields.includes(k) ? ' <span class="flag">?</span>' : ''}</td></tr>`).join('')}</table></details>` : ''}
          </div>`).join('')}</div>
      </div>

      <div class="card"><h3>ข้อมูลส่วนตัว</h3>${kv([
        ['เลขบัตรประชาชน', c.national_id], ['ชื่อ (อังกฤษ)', [c.first_name_en, c.last_name_en].filter(Boolean).join(' ')],
        ['วันเกิด', thaiDate(c.birth_date)], ['ชื่อเล่น', a.nickname], ['เบอร์โทร', c.phone], ['LINE', c.line_id], ['อีเมล', c.email],
        ['ที่อยู่ทะเบียนบ้าน', [c.addr_house_no, c.addr_moo && `ม.${c.addr_moo}`, c.addr_soi && `ซ.${c.addr_soi}`, c.addr_road && `ถ.${c.addr_road}`, c.addr_subdistrict, c.addr_district, c.addr_province, c.addr_postal_code].filter(Boolean).join(' ')],
        ['บิดา', c.father_name ?? '(เฉพาะผู้จัดการ)'], ['มารดา', c.mother_name ?? '(เฉพาะผู้จัดการ)'],
        ['สถานภาพ', a.marital_status], ['ทหาร', a.military_status],
      ])}</div>

      <div class="card"><h3>งานที่สมัคร / การศึกษา / ความสามารถ</h3>${kv([
        ['ค่าจ้างที่ต้องการ', a.expected_salary], ['เริ่มงานได้', a.available_from], ['ทราบข่าวจาก', a.source],
        ['การศึกษา', [a.education?.level, a.education?.major, a.education?.institution, a.education?.year && `ปี ${a.education.year}`].filter(Boolean).join(' · ')],
        ['ใบขับขี่', [a.driving_license?.license_type, a.driving_license?.license_no, a.driving_license?.expiry_date && `หมดอายุ ${thaiDate(a.driving_license.expiry_date)}`].filter(Boolean).join(' · ')],
        ['ขับได้', (a.driving?.vehicles || []).join(', ')],
        ['เกียร์', [a.driving?.manual && 'ธรรมดา', a.driving?.automatic && 'อัตโนมัติ'].filter(Boolean).join(', ')],
        ['ติดต่อฉุกเฉิน', [a.emergency?.name, a.emergency?.relation, a.emergency?.phone].filter(Boolean).join(' · ')],
        ...(a.declarations ? [['คำรับรองตนเอง', Object.entries(a.declarations).map(([k, v]) => `${k}: ${v || '-'}`).join(' · ')]] : []),
      ])}
      ${d.work.length ? `<h3 style="margin-top:12px">ประวัติการทำงาน</h3><ul class="small">${d.work.map((w) =>
        `<li><strong>${esc(w.company)}</strong> · ${esc(w.position || '')} ${w.salary ? `· ${w.salary.toLocaleString()} บาท` : ''} ${w.reason_leaving ? `· ออกเพราะ ${esc(w.reason_leaving)}` : ''}</li>`).join('')}</ul>` : ''}
      </div>

      <div class="card"><h3>ประวัติการตรวจ</h3>
        ${d.checks.length ? `<ul class="small">${d.checks.map((k) => `<li>${esc(k.batch_no || '-')} · ${k.status} · ส่ง ${thaiDate(k.submitted_at, true)}${k.result_at ? ` · ผล ${thaiDate(k.result_at, true)} โดย ${esc(k.recorded_by)}` : ''}${k.case_detail ? `<br><span class="hint err">ผลคดี: ${esc(k.case_detail)}</span>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">ยังไม่ได้ส่งตรวจ</p>'}
        <h3>เอกสารที่ลงนามอิเล็กทรอนิกส์</h3>
        <ul class="small">${d.consents.map((x) => `<li>${esc(x.consent_type)} v${esc(x.consent_version)} · ${thaiDate(x.signed_at, true)} · IP ${esc(x.ip_address)}</li>`).join('')}</ul>
      </div>
    </div>`;

  $('detailBody').querySelector('[data-close]').addEventListener('click', () => dlg.close());
  $('detailBody').querySelectorAll('[data-act]').forEach((btn) => btn.addEventListener('click', () => act(btn.dataset.act, c)));
}

async function act(action, c) {
  try {
    if (action === 'pass') {
      if (!confirm(`ยืนยัน: ${c.first_name} ${c.last_name} ไม่พบประวัติ (ผ่าน)?\nระบบจะส่งข้อมูลเข้าระบบหลักอัตโนมัติ`)) return;
      const r = await call(`/api/hr/candidates/${c.id}/check-result`, { method: 'POST', json: { result: 'PASSED' } });
      toast(r.sync?.ok ? 'บันทึกผ่าน และส่งเข้าระบบหลักแล้ว' : `บันทึกผ่านแล้ว แต่ส่งเข้าระบบหลักไม่สำเร็จ: ${r.sync?.error}`);
    } else if (action === 'fail') {
      const detail = prompt('พบประวัติ — ระบุผลคดี (เห็นเฉพาะผู้จัดการ):');
      if (detail === null) return;
      await call(`/api/hr/candidates/${c.id}/check-result`, { method: 'POST', json: { result: 'FAILED', case_detail: detail } });
      toast('บันทึกไม่ผ่าน — Lock เคสแล้ว');
    } else if (action === 'reset') {
      await call(`/api/hr/candidates/${c.id}/reset-check`, { method: 'POST' });
    } else if (action === 'sync') {
      const r = await call(`/api/hr/candidates/${c.id}/sync`, { method: 'POST' });
      toast(`ส่งเข้าระบบหลักแล้ว (${r.ref})`);
    }
    await openDetail(c.id);
    loadBoard();
  } catch (err) {
    toast(err.message);
    if (err.status === 423) openDetail(c.id);
  }
}

// ---------- batches ----------

async function loadBatches() {
  const { batches } = await call('/api/hr/batches');
  $('batchRows').innerHTML = batches.length ? batches.map((b) => `
    <tr>
      <td><strong>${esc(b.batch_no)}</strong></td><td class="small">${thaiDate(b.exported_at, true)}</td><td>${esc(b.exported_by_name)}</td>
      <td>${b.candidate_count}</td><td>${b.pending || 0}</td><td>${b.passed || 0}</td><td>${b.failed || 0}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-sm" data-csv="${b.id}" data-no="${esc(b.batch_no)}">CSV</button>
        ${me.permissions['check:record'] && b.pending ? `<button class="btn btn-sm btn-primary" data-result="${b.id}" data-no="${esc(b.batch_no)}">บันทึกผล 16:00</button>` : ''}
      </td>
    </tr>`).join('') : '<tr><td colspan="8" class="muted" style="text-align:center;padding:24px">ยังไม่มีรอบส่งตรวจ</td></tr>';
}

$('batchRows').addEventListener('click', (e) => {
  const csv = e.target.closest('[data-csv]');
  if (csv) downloadCsv(csv.dataset.csv, csv.dataset.no);
  const res = e.target.closest('[data-result]');
  if (res) openBatchResult(Number(res.dataset.result), res.dataset.no);
});

// Background-check office returns "0" for clean records: default everyone to PASS, tick only those with a record
async function openBatchResult(batchId, batchNo) {
  const { candidates: members } = await call(`/api/hr/batches/${batchId}/pending`);
  const formEl = $('resultForm');
  formEl.innerHTML = `
    <h2>บันทึกผลตรวจประวัติ ${esc(batchNo)}</h2>
    <p class="muted small">ติ๊กเฉพาะคนที่ <strong>พบประวัติ</strong> — คนที่เหลือจะถูกบันทึกเป็น "ไม่พบประวัติ = 0 (ผ่าน)" และส่งเข้าระบบหลักอัตโนมัติ</p>
    ${members.map((c) => `
      <div class="batch-item">
        <input type="checkbox" data-fail="${c.id}">
        <div><strong>${esc(`${c.title_th || ''}${c.first_name} ${c.last_name}`)}</strong> <span class="muted small">${esc(c.application_no)} · ${esc(c.national_id)}</span></div>
        <textarea class="hidden" data-detail="${c.id}" placeholder="ผลคดี"></textarea>
      </div>`).join('')}
    <div class="actions"><button class="btn" value="cancel">ยกเลิก</button><button class="btn btn-primary" id="saveResults" value="save">บันทึกผล</button></div>`;
  formEl.querySelectorAll('[data-fail]').forEach((b) => b.addEventListener('change', () =>
    formEl.querySelector(`[data-detail="${b.dataset.fail}"]`).classList.toggle('hidden', !b.checked)));
  $('resultDlg').showModal();
  $('saveResults').onclick = async (e) => {
    e.preventDefault();
    const failed = [...formEl.querySelectorAll('[data-fail]:checked')].map((b) => ({
      candidate_id: Number(b.dataset.fail), case_detail: formEl.querySelector(`[data-detail="${b.dataset.fail}"]`).value,
    }));
    if (!confirm(`ผ่าน ${members.length - failed.length} คน · ไม่ผ่าน ${failed.length} คน — ยืนยัน?`)) return;
    try {
      const r = await call(`/api/hr/batches/${batchId}/results`, { method: 'POST', json: { failed } });
      $('resultDlg').close();
      toast(`บันทึกแล้ว: ผ่าน ${r.passed} · ไม่ผ่าน ${r.failed}${r.sync_failed ? ` · ส่งเข้าระบบหลักไม่สำเร็จ ${r.sync_failed}` : ''}`);
      loadBatches();
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- audit (manager) ----------

async function loadAudit() {
  const { logs } = await call('/api/hr/audit');
  $('auditRows').innerHTML = logs.map((l) => `
    <tr><td>${thaiDate(l.created_at, true)}</td><td>${esc(l.user_name || 'ระบบ')}</td><td>${esc(l.action)}</td>
    <td>${esc(l.application_no || '')}</td><td class="muted">${esc(l.detail || '')}</td></tr>`).join('');
}

$('retentionBtn').addEventListener('click', async () => {
  if (!confirm('ลบไฟล์และข้อมูลส่วนบุคคลของผู้สมัครที่ไม่ผ่านและครบกำหนดเก็บแล้ว? (ย้อนกลับไม่ได้)')) return;
  const r = await call('/api/hr/retention/run', { method: 'POST' });
  toast(`ลบแล้ว ${r.purged.length} ราย`);
  loadAudit();
});

start();
