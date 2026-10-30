import { isValidThaiId, formatThaiId, toast, api, icon, esc, thaiDate } from '/assets/common.js';

const $ = (id) => document.getElementById(id);
const form = $('form');
const steps = [...document.querySelectorAll('.step')];
let step = 1;

const files = {};       // docType -> Blob (confirmed by the candidate)
const ocr = {};         // docType -> { result, token }
const fieldSource = {}; // form field name -> docType that filled it
const userEdited = new Set();
const extra = {};       // OCR values with no visible field (e.g. driving licence number)

function renderIcons(root = document) {
  for (const el of root.querySelectorAll('i[data-icon]')) el.outerHTML = icon(el.dataset.icon);
}
renderIcons();

api('/api/meta').then((m) => document.querySelectorAll('[data-company]').forEach((el) => { el.textContent = m.company; })).catch(() => {});

$('start').addEventListener('click', () => {
  $('welcome').classList.add('hidden');
  $('wizard').classList.remove('hidden');
  go(1);
});

// ---------- documents ----------

const DOCS = {
  ID_CARD: { title: 'บัตรประจำตัวประชาชน', icon: 'idcard', required: true, ocr: true, ratio: 1.586,
    hint: 'วางบัตรด้านหน้าให้อยู่ในกรอบ', tip: 'ถ่ายในที่สว่าง ไม่มีแสงสะท้อนบนบัตร เห็นตัวอักษรชัดเจน' },
  HOUSE_REG: { title: 'ทะเบียนบ้าน', icon: 'home', required: true, ocr: true, ratio: 0.78,
    hint: 'ถ่ายหน้าที่มีที่อยู่และชื่อของคุณ', tip: 'ถ้าอยู่คนละหน้า ให้กางเล่มถ่ายให้เห็นทั้งสองส่วนในรูปเดียว' },
  DRIVER_LICENSE: { title: 'ใบอนุญาตขับรถ', icon: 'car', ocr: true, ratio: 1.586,
    hint: 'วางใบขับขี่ด้านหน้าให้อยู่ในกรอบ', tip: 'ถ่ายในที่สว่าง ไม่มีแสงสะท้อน' },
  PHOTO: { title: 'รูปถ่ายหน้าตรง', icon: 'user', ratio: 0.8, facing: 'user',
    hint: 'มองกล้อง ให้ใบหน้าอยู่กลางกรอบ', tip: 'ถอดหมวกและแว่นกันแดด ใช้พื้นหลังสีเรียบ' },
  EDUCATION: { title: 'วุฒิการศึกษา', icon: 'cap', ratio: 0.72,
    hint: 'ให้เอกสารอยู่เต็มกรอบ', tip: 'ใบรับรองหรือ Transcript ก็ได้' },
};
const REQUIRED_DOCS = Object.keys(DOCS).filter((k) => DOCS[k].required);
const thumbs = {};

function renderDocList() {
  $('docList').innerHTML = Object.entries(DOCS).map(([type, d]) => {
    const has = Boolean(files[type]);
    const o = ocr[type]?.result;
    const unsure = o?.low_confidence_fields?.length || 0;
    const sub = !has
      ? (d.ocr ? 'AI อ่านข้อมูลและกรอกให้อัตโนมัติ' : 'แนบรูปเพื่อประกอบใบสมัคร')
      : o ? `อ่านข้อมูลแล้ว${unsure ? ` · ตรวจสอบ ${unsure} รายการ` : ' ✓'}` : 'แนบแล้ว ✓';
    return `
      <button type="button" class="doc ${has ? 'done' : ''} ${unsure ? 'warn' : ''}" data-doc="${type}">
        <span class="doc-thumb" ${thumbs[type] ? `style="background-image:url(${thumbs[type]})"` : ''}>${thumbs[type] ? '' : icon(d.icon)}</span>
        <span><span class="doc-title">${d.title} ${d.required ? '<span class="badge b-req">จำเป็น</span>' : '<span class="badge b-opt">ถ้ามี</span>'}</span>
          <span class="doc-sub">${sub}</span></span>
        <span class="doc-cta">${icon(has ? 'refresh' : 'camera')}<span class="t">${has ? 'ถ่ายใหม่' : 'สแกน'}</span></span>
      </button>`;
  }).join('');
  const done = REQUIRED_DOCS.filter((t) => files[t]).length;
  $('scanBar').style.width = `${(done / REQUIRED_DOCS.length) * 100}%`;
  $('scanCount').textContent = `สแกนแล้ว ${done} จาก ${REQUIRED_DOCS.length} เอกสารที่จำเป็น`;
}
$('docList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-doc]');
  if (btn) openScanner(btn.dataset.doc);
});

// ---------- scanner ----------

const scanner = $('scanner');
const video = $('scanVideo');
let stream = null;
let current = null; // { type, blob, res }
let procTimer = null;

const cameraInput = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/*', hidden: true });
document.body.append(cameraInput);

function setState(s) { scanner.dataset.state = s; }

async function openScanner(type) {
  const d = DOCS[type];
  current = { type };
  $('scanTitle').textContent = `สแกน${d.title}`;
  $('scanHint').textContent = d.hint;
  $('scanTip').textContent = d.tip;
  $('scanFrame').style.setProperty('--ratio', d.ratio);
  cameraInput.setAttribute('capture', d.facing || 'environment');
  setState('camera');
  scanner.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  await startCamera(d.facing || 'environment');
}

async function startCamera(facing) {
  stopCamera();
  if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
    $('scanTip').textContent = 'แตะปุ่มถ่ายรูปเพื่อเปิดกล้องของเครื่อง';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false,
    });
    video.srcObject = stream;
  } catch {
    stream = null;
    $('scanTip').textContent = 'ไม่สามารถเปิดกล้องในหน้านี้ได้ — แตะปุ่มถ่ายรูปเพื่อใช้กล้องของเครื่อง หรือเลือกรูปจากคลังภาพ';
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}

function closeScanner() {
  stopCamera();
  clearInterval(procTimer);
  scanner.classList.add('hidden');
  document.body.style.overflow = '';
  current = null;
}
$('scanClose').addEventListener('click', closeScanner);

$('shutter').addEventListener('click', async () => {
  if (!stream || !video.videoWidth) return cameraInput.click();
  const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  handleImage(await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9)), canvas);
});

for (const input of [cameraInput, $('scanGallery')]) {
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.value = '';
    if (!file || !current) return;
    if (file.type === 'application/pdf') return handleImage(file, null);
    try {
      const { blob, canvas } = await shrinkImage(file);
      handleImage(blob, canvas);
    } catch {
      toast('เปิดไฟล์นี้ไม่ได้ กรุณาใช้ไฟล์ JPG, PNG หรือ PDF');
    }
  });
}

async function shrinkImage(file, maxSide = 1600) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return { blob: await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.88)), canvas };
}

// Average luminance of a downscaled copy — catches photos taken in the dark
function brightness(canvas) {
  if (!canvas) return 255;
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.drawImage(canvas, 0, 0, 64, 64);
  const px = ctx.getImageData(0, 0, 64, 64).data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  return sum / (px.length / 4);
}

const PDF_PREVIEW = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 150"><rect width="120" height="150" rx="10" fill="#e8eef8"/><text x="60" y="85" font-size="28" text-anchor="middle" fill="#13315c" font-family="sans-serif" font-weight="700">PDF</text></svg>')}`;

async function handleImage(blob, canvas) {
  stopCamera();
  const type = current.type;
  current.blob = blob;
  current.preview = blob.type.startsWith('image/') ? URL.createObjectURL(blob) : PDF_PREVIEW;
  current.dark = brightness(canvas) < 55;
  $('scanPreview').src = current.preview;

  if (!DOCS[type].ocr) return showAttached('แนบเอกสารแล้ว', current.dark ? 'รูปค่อนข้างมืด แนะนำให้ถ่ายใหม่ในที่สว่าง' : 'ตรวจดูว่ารูปชัดเจน แล้วกด "ใช้รูปนี้"', !current.dark);

  setState('processing');
  const items = [...$('procSteps').children];
  items.forEach((li) => (li.className = ''));
  let i = 0;
  items[0].className = 'on';
  clearInterval(procTimer);
  procTimer = setInterval(() => {
    if (i < items.length - 1) { items[i].className = 'ok'; items[++i].className = 'on'; }
  }, 900);

  const started = Date.now();
  try {
    const body = new FormData();
    body.append('doc_type', type);
    body.append('file', blob, `${type}.${blob.type === 'application/pdf' ? 'pdf' : 'jpg'}`);
    const res = await api('/api/ocr', { method: 'POST', body });
    // Keep the scan animation on screen long enough to read, even when OCR is instant
    await new Promise((r) => setTimeout(r, Math.max(0, 1800 - (Date.now() - started))));
    if (current?.type !== type) return;
    clearInterval(procTimer);
    items.forEach((li) => (li.className = 'ok'));
    current.res = res;
    await new Promise((r) => setTimeout(r, 350));
    showResult(type, res.result);
  } catch (err) {
    clearInterval(procTimer);
    if (current?.type !== type) return;
    showAttached('อ่านข้อมูลอัตโนมัติไม่สำเร็จ', `${err.message} — คุณยังใช้รูปนี้และกรอกข้อมูลเองได้ หรือถ่ายใหม่ให้ชัดขึ้น`, false);
  }
}

function showAttached(title, sub, ok) {
  $('attachedTitle').textContent = title;
  $('attachedSub').textContent = sub;
  $('attachedDot').className = `ok-dot ${ok ? '' : 'warn'}`;
  $('attachedDot').innerHTML = icon(ok ? 'check' : 'alert');
  setState('attached');
}

const fullName = (r) => [r.title_th, r.first_name_th].filter(Boolean).join('') + (r.last_name_th ? ` ${r.last_name_th}` : '');
const addrText = (r) => [r.addr_house_no, r.addr_moo && `หมู่ ${r.addr_moo}`, r.addr_soi && `ซ.${r.addr_soi}`, r.addr_road && `ถ.${r.addr_road}`,
  r.addr_subdistrict, r.addr_district, r.addr_province, r.addr_postal_code].filter(Boolean).join(' ');
const ADDR_FIELDS = ['addr_house_no', 'addr_moo', 'addr_soi', 'addr_road', 'addr_subdistrict', 'addr_district', 'addr_province', 'addr_postal_code'];

const RESULT_ROWS = {
  ID_CARD: [
    ['เลขประจำตัวประชาชน', (r) => r.national_id && formatThaiId(r.national_id), ['national_id']],
    ['ชื่อ-นามสกุล', fullName, ['title_th', 'first_name_th', 'last_name_th']],
    ['ชื่ออังกฤษ', (r) => [r.title_en, r.first_name_en, r.last_name_en].filter(Boolean).join(' '), ['first_name_en', 'last_name_en']],
    ['วันเกิด', (r) => r.birth_date && thaiDate(r.birth_date), ['birth_date']],
    ['ที่อยู่', addrText, ADDR_FIELDS],
    ['ศาสนา', (r) => r.religion, ['religion']],
    ['บัตรหมดอายุ', (r) => r.expiry_date && thaiDate(r.expiry_date), ['expiry_date']],
  ],
  HOUSE_REG: [
    ['ชื่อ-นามสกุล', fullName, ['title_th', 'first_name_th', 'last_name_th']],
    ['เลขประจำตัวประชาชน', (r) => r.national_id && formatThaiId(r.national_id), ['national_id']],
    ['ที่อยู่ตามทะเบียนบ้าน', addrText, ADDR_FIELDS],
    ['รหัสประจำบ้าน', (r) => r.house_code, ['house_code']],
    ['บิดา', (r) => r.father_name, ['father_name']],
    ['มารดา', (r) => r.mother_name, ['mother_name']],
  ],
  DRIVER_LICENSE: [
    ['เลขที่ใบอนุญาต', (r) => r.license_no, ['license_no']],
    ['ประเภท', (r) => r.license_type, ['license_type']],
    ['ชื่อ-นามสกุล', fullName, ['title_th', 'first_name_th', 'last_name_th']],
    ['เลขประจำตัวประชาชน', (r) => r.national_id && formatThaiId(r.national_id), ['national_id']],
    ['วันหมดอายุ', (r) => r.expiry_date && thaiDate(r.expiry_date), ['expiry_date']],
  ],
};

function showResult(type, r) {
  const rows = RESULT_ROWS[type].map(([label, fn, keys]) => ({ label, value: fn(r), unsure: keys.some((k) => r.low_confidence_fields.includes(k)) }))
    .filter((x) => x.value);
  $('resultList').innerHTML = rows.map((x) =>
    `<dt>${x.label}</dt><dd class="${x.unsure ? 'unsure' : ''}"><span>${esc(x.value)}</span>${x.unsure ? '<span class="badge b-pending">โปรดตรวจ</span>' : ''}</dd>`).join('')
    || '<dt>ผลลัพธ์</dt><dd>ไม่พบข้อมูลที่อ่านได้</dd>';
  const unsure = rows.filter((x) => x.unsure).length;
  $('resultSub').textContent = `อ่านได้ ${rows.length} รายการ${unsure ? ` · ตรวจสอบ ${unsure} รายการ` : ''} — แก้ไขได้ในขั้นตอนถัดไป`;

  const warns = [];
  if (r.document_type_detected !== type && r.document_type_detected !== 'OTHER') warns.push(`ดูเหมือนรูปนี้เป็นเอกสารคนละประเภทกับ${DOCS[type].title}`);
  if (r.national_id && !isValidThaiId(r.national_id)) warns.push('เลขประจำตัวประชาชนที่อ่านได้ไม่ถูกต้อง กรุณาถ่ายใหม่ให้ชัดขึ้น');
  if (r.expiry_date && new Date(r.expiry_date) < new Date()) warns.push('เอกสารนี้หมดอายุแล้ว');
  if (current.dark) warns.push('รูปค่อนข้างมืด หากข้อมูลไม่ถูกต้องแนะนำให้ถ่ายใหม่');
  if (r.notes) warns.push(r.notes);
  $('resultWarn').innerHTML = warns.map((w) => `<div class="alert alert-warn small">${icon('alert')}<span>${esc(w)}</span></div>`).join('');
  setState('result');
}

function confirmCurrent(useOcr) {
  const { type, blob, res, preview } = current;
  files[type] = blob;
  thumbs[type] = preview;
  if (useOcr && res) {
    ocr[type] = res;
    applyOcr(type, res.result);
  } else {
    delete ocr[type];
  }
  closeScanner();
  renderDocList();
  showError('');
}
$('useResult').addEventListener('click', () => confirmCurrent(true));
$('useAttached').addEventListener('click', () => confirmCurrent(false));
for (const id of ['retake', 'retake2']) {
  $(id).addEventListener('click', () => {
    setState('camera');
    startCamera(DOCS[current.type].facing || 'environment');
  });
}

// ---------- OCR -> form ----------

// Which document is most trustworthy for each kind of field
const PRIORITY = {
  identity: { ID_CARD: 3, DRIVER_LICENSE: 2, HOUSE_REG: 1 },
  household: { HOUSE_REG: 3, ID_CARD: 2, DRIVER_LICENSE: 1 },
};
const OCR_MAP = {
  national_id: ['p.national_id', 'identity'],
  title_th: ['p.title_th', 'identity'],
  first_name_th: ['p.first_name', 'identity'],
  last_name_th: ['p.last_name', 'identity'],
  first_name_en: ['p.first_name_en', 'identity'],
  last_name_en: ['p.last_name_en', 'identity'],
  birth_date: ['p.birth_date', 'identity'],
  religion: ['a.religion', 'identity'],
  addr_house_no: ['p.addr_house_no', 'household'],
  addr_moo: ['p.addr_moo', 'household'],
  addr_soi: ['p.addr_soi', 'household'],
  addr_road: ['p.addr_road', 'household'],
  addr_subdistrict: ['p.addr_subdistrict', 'household'],
  addr_district: ['p.addr_district', 'household'],
  addr_province: ['p.addr_province', 'household'],
  addr_postal_code: ['p.addr_postal_code', 'household'],
  father_name: ['p.father_name', 'household'],
  mother_name: ['p.mother_name', 'household'],
};
const TITLE_ALIASES = { 'น.ส.': 'นางสาว', 'นส.': 'นางสาว', 'ด.ช.': 'นาย', 'ด.ญ.': 'นางสาว' };
const titleCase = (s) => s.toLowerCase().replace(/(^|\s|-)\S/g, (m) => m.toUpperCase());

function markField(el, state) {
  const f = el.closest('.field');
  if (!f) return;
  f.classList.remove('ai', 'unsure', 'locked', 'missing', 'field-error');
  if (state) f.classList.add(state);
}

function applyOcr(docType, r) {
  for (const [ocrField, [name, kind]] of Object.entries(OCR_MAP)) {
    let value = r[ocrField];
    const el = form.elements[name];
    if (!value || !el || userEdited.has(name)) continue;
    const prev = fieldSource[name];
    if (prev && prev !== docType && PRIORITY[kind][prev] > PRIORITY[kind][docType]) continue;
    if (ocrField === 'title_th') value = TITLE_ALIASES[value] || value;
    if (ocrField.endsWith('_en')) value = titleCase(value);
    if (ocrField === 'national_id') value = formatThaiId(value);
    el.value = value;
    fieldSource[name] = docType;
    markField(el, r.low_confidence_fields.includes(ocrField) ? 'unsure' : 'ai');
  }
  if (docType === 'ID_CARD' && r.expiry_date && !userEdited.has('a.id_card_expiry')) {
    form.elements['a.id_card_expiry'].value = r.expiry_date;
    fieldSource['a.id_card_expiry'] = docType;
    markField(form.elements['a.id_card_expiry'], 'ai');
  }
  if (docType === 'DRIVER_LICENSE') {
    extra.driving_license = { license_no: r.license_no, license_type: r.license_type, expiry_date: r.expiry_date };
    const box = form.querySelector('input[name="a.driving.license_types"][value="ชนิดที่ 1"]');
    if (r.license_type?.includes('ส่วนบุคคล') && r.license_type.includes('รถยนต์')) box.checked = true;
    if (r.license_type?.includes('จักรยานยนต์')) form.querySelector('input[name="a.driving.license_types"][value="จักรยานยนต์"]').checked = true;
  }
}

form.addEventListener('input', (e) => {
  if (!e.target.name) return;
  userEdited.add(e.target.name);
  const f = e.target.closest('.field');
  f?.classList.remove('ai', 'unsure', 'missing', 'field-error');
  e.target.classList.remove('field-error');
});

// ---------- step 2: review ----------

const nidInput = form.elements['p.national_id'];
function checkNationalId() {
  const digits = nidInput.value.replace(/\D/g, '');
  const hint = $('nidHint');
  if (!digits) { hint.innerHTML = ''; return false; }
  const ok = isValidThaiId(digits);
  hint.className = `hint ${ok ? 'ok' : 'err'}`;
  hint.innerHTML = ok ? `${icon('checkCircle')} เลขบัตรถูกต้อง` : `${icon('alert')} เลขบัตรไม่ถูกต้อง กรุณาตรวจสอบ`;
  return ok;
}
nidInput.addEventListener('input', checkNationalId);
nidInput.addEventListener('blur', () => { if (checkNationalId()) nidInput.value = formatThaiId(nidInput.value); });

function prepareReview() {
  let aiCount = 0;
  for (const section of form.querySelectorAll('[data-step="2"] [data-section]')) {
    let locked = 0;
    for (const el of section.querySelectorAll('input, select')) {
      const f = el.closest('.field');
      if (!f) continue;
      const confident = fieldSource[el.name] && !userEdited.has(el.name) && f.classList.contains('ai') && el.value;
      if (confident) {
        f.classList.add('locked');
        el.readOnly = true;
        locked++;
      }
      if (fieldSource[el.name] && el.value) aiCount++;
      if (el.required && !el.value.trim()) f.classList.add('missing');
    }
    section.querySelector('[data-unlock]').classList.toggle('hidden', !locked);
  }
  const missing = [...form.querySelectorAll('[data-step="2"] [required]')].filter((el) => !el.value.trim()).length;
  $('aiSummary').innerHTML = aiCount
    ? `<div class="ai-summary"><span class="ai-ic">${icon('sparkle', 'icon-lg')}</span>
        <div><div class="big">${aiCount} ช่อง</div><small>AI กรอกให้จากเอกสารของคุณแล้ว${missing ? ` · กรอกเพิ่มอีก ${missing} ช่อง` : ' · ตรวจสอบแล้วกดถัดไปได้เลย'}</small></div></div>`
    : `<div class="alert alert-info">${icon('info')}<span>ระบบอ่านเอกสารอัตโนมัติไม่ได้ กรุณากรอกข้อมูลด้านล่าง</span></div>`;
  const ids = new Set(Object.values(ocr).map((o) => o.result.national_id).filter(Boolean));
  $('crossCheck').innerHTML = ids.size > 1
    ? `<div class="alert alert-warn">${icon('alert')}<span>เลขบัตรประชาชนในเอกสารแต่ละใบไม่ตรงกัน กรุณาตรวจว่าเป็นเอกสารของคุณทั้งหมด</span></div>` : '';
  checkNationalId();
}

form.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-unlock]');
  if (!btn) return;
  const section = btn.closest('[data-section]');
  section.querySelectorAll('.field.locked').forEach((f) => {
    f.classList.remove('locked');
    f.querySelectorAll('input, select').forEach((el) => { el.readOnly = false; });
  });
  btn.classList.add('hidden');
  section.querySelector('input, select')?.focus();
});

const sameAddr = form.elements['a.current_same_as_registered'];
sameAddr.addEventListener('change', () => $('currentAddr').classList.toggle('hidden', sameAddr.checked));

// ---------- step 3 ----------

const POSITIONS = ['พนักงานขับรถส่วนกลาง', 'พนักงานขับรถผู้บริหาร', 'พนักงานรับจอดรถ (Valet)', 'พนักงานธุรการ', 'พนักงานต้อนรับ', 'ช่างอาคาร', 'IT Support'];
$('positionChips').innerHTML = POSITIONS.map((p) =>
  `<label class="chip"><input type="radio" name="pos" form="no-form" value="${esc(p)}"><span>${esc(p)}</span></label>`).join('');
const posInput = form.elements['p.position_applied'];
$('positionChips').addEventListener('change', (e) => {
  posInput.value = e.target.value;
  posInput.classList.remove('field-error');
});
posInput.addEventListener('input', () => {
  document.querySelectorAll('input[name="pos"]').forEach((r) => { r.checked = r.value === posInput.value; });
});

const workList = $('workList');
function addWork() {
  const node = $('workTpl').content.firstElementChild.cloneNode(true);
  node.querySelector('[data-remove]').addEventListener('click', () => { node.remove(); numberWork(); });
  workList.append(node);
  numberWork();
}
function numberWork() {
  workList.querySelectorAll('.work-head strong').forEach((s, i) => { s.textContent = i === 0 ? 'ที่ทำงานล่าสุด' : `ที่ทำงานก่อนหน้า ${i}`; });
}
$('addWork').addEventListener('click', addWork);
addWork();

// ---------- step 5: consents + signature ----------

let consents = [];
const accepted = new Set();
let reading = null;

async function loadConsents() {
  const { personal } = collect();
  consents = (await api('/api/consents/preview', { method: 'POST', json: personal })).consents;
  accepted.clear();
  renderConsents();
  $('sigName').textContent = `( ${personal.title_th || ''}${personal.first_name} ${personal.last_name} )`;
}

function renderConsents() {
  $('consentList').innerHTML = consents.map((c) => `
    <button type="button" class="consent-row ${accepted.has(c.type) ? 'ok' : ''}" data-read="${c.type}">
      <span class="st">${icon('check')}</span><span class="t">${esc(c.title)}</span><span class="r">${accepted.has(c.type) ? 'ยินยอมแล้ว' : 'อ่าน'}</span>
    </button>`).join('');
  $('acceptAll').checked = consents.length > 0 && accepted.size === consents.length;
}

$('consentList').addEventListener('click', (e) => {
  const row = e.target.closest('[data-read]');
  if (!row) return;
  reading = consents.find((c) => c.type === row.dataset.read);
  $('consentTitle').textContent = reading.title;
  $('consentText').textContent = reading.text;
  $('consentSheet').showModal();
  $('consentText').scrollTop = 0;
});
$('consentAgree').addEventListener('click', () => {
  accepted.add(reading.type);
  $('consentSheet').close();
  renderConsents();
});
$('consentSheet').querySelector('[data-close]').addEventListener('click', () => $('consentSheet').close());
$('acceptAll').addEventListener('change', (e) => {
  consents.forEach((c) => (e.target.checked ? accepted.add(c.type) : accepted.delete(c.type)));
  renderConsents();
});

const sig = $('sig');
const sigCtx = sig.getContext('2d');
let sigDirty = false;
let drawing = false;
let last = null;
function sizeSignature() {
  const ratio = window.devicePixelRatio || 1;
  sig.width = sig.clientWidth * ratio;
  sig.height = sig.clientHeight * ratio;
  sigCtx.setTransform(ratio, 0, 0, ratio, 0, 0);
  Object.assign(sigCtx, { lineWidth: 2.6, lineCap: 'round', lineJoin: 'round', strokeStyle: '#0d2a6b' });
  sigDirty = false;
  $('sigPh').classList.remove('hidden');
}
const pos = (e) => { const r = sig.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
sig.addEventListener('pointerdown', (e) => {
  drawing = true;
  sig.setPointerCapture(e.pointerId);
  last = pos(e);
});
sig.addEventListener('pointermove', (e) => {
  if (!drawing) return;
  const p = pos(e);
  // quadratic smoothing between the last point and the midpoint
  const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
  sigCtx.beginPath();
  sigCtx.moveTo(last.mid?.x ?? last.x, last.mid?.y ?? last.y);
  sigCtx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
  sigCtx.stroke();
  last = { ...p, mid };
  if (!sigDirty) $('sigPh').classList.add('hidden');
  sigDirty = true;
});
const endStroke = () => { drawing = false; last = null; };
sig.addEventListener('pointerup', endStroke);
sig.addEventListener('pointercancel', endStroke);
$('sigClear').addEventListener('click', sizeSignature);

// ---------- collect + validate + navigate ----------

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

function collect() {
  const personal = {};
  const application = {};
  for (const el of form.elements) {
    if (!el.name || !el.name.includes('.')) continue;
    const [scope, ...rest] = el.name.split('.');
    const path = rest.join('.');
    const target = scope === 'p' ? personal : application;
    if (el.type === 'checkbox') {
      if (el.value !== 'on') {
        const arr = path.split('.').reduce((o, k) => o?.[k], target) || [];
        setPath(target, path, el.checked ? [...arr, el.value] : arr);
      } else {
        setPath(target, path, el.checked);
      }
    } else {
      setPath(target, path, el.value.trim());
    }
  }
  personal.national_id = personal.national_id.replace(/\D/g, '');
  Object.assign(application, extra);
  const work = [...workList.querySelectorAll('.work-item')].map((item) =>
    Object.fromEntries([...item.querySelectorAll('[data-w]')].map((i) => [i.dataset.w, i.value.trim()]))
  ).filter((w) => w.company);
  return { personal, application, work };
}

function showError(msg) {
  const box = $('formError');
  box.innerHTML = msg ? `${icon('alert')}<span>${esc(msg)}</span>` : '';
  box.classList.toggle('hidden', !msg);
  if (msg) box.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function validateStep(n) {
  const section = steps[n - 1];
  let firstBad = null;
  for (const el of section.querySelectorAll('[required]')) {
    const bad = !el.value.trim();
    (el.closest('.field') || el).classList.toggle('field-error', bad);
    if (bad && !firstBad) firstBad = el;
  }
  if (n === 1) {
    const missing = REQUIRED_DOCS.filter((t) => !files[t]).map((t) => DOCS[t].title);
    if (missing.length) return `กรุณาสแกน${missing.join(' และ ')}`;
  }
  if (n === 2) {
    if (!checkNationalId()) { nidInput.closest('.field').classList.add('field-error'); firstBad ??= nidInput; }
    const phone = form.elements['p.phone'];
    if (!/^0\d{8,9}$/.test(phone.value.replace(/\D/g, ''))) { phone.closest('.field').classList.add('field-error'); firstBad ??= phone; }
  }
  if (firstBad) {
    firstBad.closest('[data-section]')?.querySelector('[data-unlock]:not(.hidden)')?.click();
    firstBad.focus({ preventScroll: true });
    firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return 'กรุณากรอกข้อมูลที่จำเป็นให้ครบและถูกต้อง';
  }
  if (n === 5) {
    if (accepted.size < consents.length) return 'กรุณาอ่านและยินยอมเอกสารให้ครบทุกฉบับ';
    if (!sigDirty) return 'กรุณาเซ็นชื่อในกรอบลายมือชื่อ';
  }
  return null;
}

async function go(n) {
  step = n;
  showError('');
  steps.forEach((s, i) => s.classList.toggle('hidden', i !== n - 1));
  document.querySelectorAll('#stepbar li').forEach((li, i) => {
    li.classList.toggle('done', i < n - 1);
    li.classList.toggle('current', i === n - 1);
    li.querySelector('.dot').innerHTML = i < n - 1 ? icon('check') : String(i + 1);
  });
  $('back').innerHTML = n === 1 ? `${icon('back')} หน้าแรก` : `${icon('back')} ย้อนกลับ`;
  $('next').innerHTML = n === 5 ? `${icon('send')} ส่งใบสมัคร` : `ถัดไป ${icon('next')}`;
  window.scrollTo({ top: 0 });
  if (n === 1) renderDocList();
  if (n === 2) prepareReview();
  if (n === 5) {
    requestAnimationFrame(sizeSignature);
    try { await loadConsents(); } catch (err) { showError(err.message); }
  }
}

$('back').addEventListener('click', () => {
  if (step === 1) {
    $('wizard').classList.add('hidden');
    $('welcome').classList.remove('hidden');
    return;
  }
  go(step - 1);
});
$('next').addEventListener('click', async () => {
  const err = validateStep(step);
  showError(err);
  if (err) return;
  if (step < 5) return go(step + 1);
  await submit();
});

async function submit() {
  const btn = $('next');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> กำลังส่งใบสมัคร…';
  try {
    const { personal, application, work } = collect();
    const body = new FormData();
    for (const [type, blob] of Object.entries(files)) {
      body.append(type, blob, `${type}.${blob.type === 'application/pdf' ? 'pdf' : 'jpg'}`);
    }
    body.append('SIGNATURE', await new Promise((r) => sig.toBlob(r, 'image/png')), 'signature.png');
    body.append('data', JSON.stringify({
      personal, application, work, ocr,
      consents: consents.map((c) => ({ type: c.type, sha256: c.sha256 })),
    }));
    const res = await api('/api/applications', { method: 'POST', body });
    showDone(res);
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.innerHTML = `${icon('send')} ส่งใบสมัคร`;
  }
}

function showDone(res) {
  $('wizard').classList.add('hidden');
  $('done').classList.remove('hidden');
  $('appNo').textContent = res.application_no;
  const url = `${location.origin}/status/?t=${encodeURIComponent(res.tracking_token)}`;
  $('statusLink').href = url;
  $('copyNo').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(res.application_no); toast('คัดลอกเลขที่ใบสมัครแล้ว'); } catch { toast(res.application_no); }
  });
  $('shareLink').addEventListener('click', async () => {
    if (navigator.share) {
      try { await navigator.share({ title: 'ติดตามสถานะใบสมัคร', text: `เลขที่ใบสมัคร ${res.application_no}`, url }); } catch { /* cancelled */ }
    } else {
      try { await navigator.clipboard.writeText(url); toast('คัดลอกลิงก์แล้ว เก็บไว้เพื่อติดตามสถานะ'); } catch { toast(url, 8000); }
    }
  });
  window.scrollTo({ top: 0 });
}
