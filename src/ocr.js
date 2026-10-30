import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import { isValidThaiId } from './thaiId.js';

export const OCR_DOC_TYPES = ['ID_CARD', 'HOUSE_REG', 'DRIVER_LICENSE'];

const str = { type: ['string', 'null'] };
const FIELDS = {
  document_type_detected: { type: 'string', enum: ['ID_CARD', 'HOUSE_REG', 'DRIVER_LICENSE', 'OTHER'] },
  national_id: str,
  title_th: str,
  first_name_th: str,
  last_name_th: str,
  title_en: str,
  first_name_en: str,
  last_name_en: str,
  birth_date: str,
  gender: str,
  religion: str,
  addr_house_no: str,
  addr_moo: str,
  addr_soi: str,
  addr_road: str,
  addr_subdistrict: str,
  addr_district: str,
  addr_province: str,
  addr_postal_code: str,
  house_code: str,
  father_name: str,
  mother_name: str,
  license_no: str,
  license_type: str,
  issue_date: str,
  expiry_date: str,
  handwritten_annotation_present: { type: 'boolean' },
  low_confidence_fields: { type: 'array', items: { type: 'string' } },
  notes: str,
};
const SCHEMA = {
  type: 'object',
  properties: FIELDS,
  required: Object.keys(FIELDS),
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You extract data from photos of Thai identity documents submitted by job applicants:
Thai national ID cards (บัตรประจำตัวประชาชน), house registration books (ทะเบียนบ้าน / ท.ร.14), and driving licences (ใบอนุญาตขับรถ).

Rules:
- Applicants often hand-write red text across the copy such as "ใช้เพื่อสมัครงาน…เท่านั้น" or "สำเนาถูกต้อง" plus a signature. Read the printed document underneath; never copy that annotation into a field. Set handwritten_annotation_present accordingly.
- Dates: return ISO yyyy-mm-dd in the Gregorian calendar. Thai dates use the Buddhist Era (subtract 543) and abbreviated months (ม.ค. ก.พ. มี.ค. เม.ย. พ.ค. มิ.ย. ก.ค. ส.ค. ก.ย. ต.ค. พ.ย. ธ.ค.). When both Thai and English dates are printed, use them to cross-check.
- national_id: the 13 digits only, no spaces or dashes.
- Names: split the Thai title (นาย, นาง, นางสาว, ด.ช., ด.ญ.) from the first name. On a house registration book, the person is the one listed in รายการบุคคลในบ้าน; take father_name/mother_name from มารดา/บิดา ชื่อ.
- Address: split into house number, หมู่, ซอย, ถนน, ตำบล/แขวง, อำเภอ/เขต, จังหวัด. Strip prefixes like "ซ.", "ต.", "แขวง", "เขต". Expand "กรุงเทพฯ"/"กทม." to "กรุงเทพมหานคร". Use the printed address, not handwritten corrections, unless the printed one is unreadable.
- license_type: copy the Thai licence class text (e.g. "รถยนต์ส่วนบุคคล", "รถจักรยานยนต์ส่วนบุคคล").
- If a value is not on this document or you cannot read it, return null. Never guess. List every field you returned but are not fully sure of (partly covered by the annotation, blurry, faded) in low_confidence_fields.
- notes: one short sentence in Thai if the photo has problems the applicant should fix (blurry, cropped, wrong document), otherwise null.`;

let client;
const getClient = () => (client ??= new Anthropic());

async function extractWithClaude(buffer, mimeType, docType) {
  const source = { type: 'base64', media_type: mimeType, data: buffer.toString('base64') };
  const fileBlock = mimeType === 'application/pdf' ? { type: 'document', source } : { type: 'image', source };

  let response;
  try {
    response = await callClaude(fileBlock, docType);
  } catch (err) {
    if (err instanceof Anthropic.APIError || err instanceof Anthropic.AnthropicError) {
      console.error('[ocr]', err.status ?? '', err.message);
      throw new OcrError('ระบบอ่านเอกสารอัตโนมัติไม่พร้อมใช้งานชั่วคราว กรุณากรอกข้อมูลเอง');
    }
    throw err;
  }

  if (response.stop_reason === 'refusal') throw new OcrError('ระบบ AI ไม่สามารถอ่านเอกสารนี้ได้ กรุณากรอกข้อมูลเอง');
  if (response.stop_reason === 'max_tokens') throw new OcrError('ผลการอ่านเอกสารไม่สมบูรณ์ กรุณาลองใหม่');
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new OcrError('ไม่ได้รับผลการอ่านเอกสาร');
  return JSON.parse(text);
}

function callClaude(fileBlock, docType) {
  return getClient().beta.messages.create({
    model: config.ocrModel,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [fileBlock, { type: 'text', text: `The applicant says this is a ${docType}. Extract the fields.` }],
      },
    ],
  });
}

// Fictional data so the UI can be exercised without an API key
function extractMock(docType) {
  const empty = Object.fromEntries(Object.keys(FIELDS).map((k) => [k, null]));
  const person = {
    national_id: '1234567890121', title_th: 'นาย', first_name_th: 'สมชาย', last_name_th: 'ทดสอบระบบ',
    birth_date: '1990-05-17',
  };
  const address = {
    addr_house_no: '99/9', addr_moo: null, addr_soi: 'ตัวอย่าง 1', addr_road: 'ทดสอบ',
    addr_subdistrict: 'สำโรง', addr_district: 'พระประแดง', addr_province: 'สมุทรปราการ',
  };
  const byType = {
    ID_CARD: { ...person, ...address, title_en: 'Mr.', first_name_en: 'Somchai', last_name_en: 'Thodsobrabob',
      religion: 'พุทธ', issue_date: '2022-03-03', expiry_date: '2030-05-16' },
    HOUSE_REG: { ...person, ...address, house_code: '1101-000000-1', gender: 'ชาย',
      father_name: 'นายสมศักดิ์ ทดสอบระบบ', mother_name: 'นางสมใจ ทดสอบระบบ' },
    DRIVER_LICENSE: { ...person, title_en: 'Mr.', first_name_en: 'SOMCHAI', last_name_en: 'THODSOBRABOB',
      license_no: '65000001', license_type: 'รถยนต์ส่วนบุคคล', issue_date: '2021-01-10', expiry_date: '2026-12-31' },
  };
  return {
    ...empty, ...byType[docType], document_type_detected: docType,
    handwritten_annotation_present: true, low_confidence_fields: docType === 'HOUSE_REG' ? ['addr_soi'] : [],
    notes: null,
  };
}

export class OcrError extends Error {}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_FIELDS = ['birth_date', 'issue_date', 'expiry_date'];

// Model output is a draft: re-check what can be checked deterministically
function postProcess(result) {
  const out = { ...result, low_confidence_fields: [...new Set(result.low_confidence_fields || [])] };
  if (out.national_id) {
    out.national_id = out.national_id.replace(/\D/g, '');
    if (!isValidThaiId(out.national_id)) out.low_confidence_fields.push('national_id');
  }
  for (const f of DATE_FIELDS) {
    if (out[f] && !ISO_DATE.test(out[f])) {
      out[f] = null;
      out.low_confidence_fields.push(f);
    }
    // A Buddhist-era year that slipped through unconverted
    if (out[f] && Number(out[f].slice(0, 4)) > new Date().getFullYear() + 20) {
      out[f] = `${Number(out[f].slice(0, 4)) - 543}${out[f].slice(4)}`;
    }
  }
  out.low_confidence_fields = [...new Set(out.low_confidence_fields)];
  return out;
}

export async function extractDocument(buffer, mimeType, docType) {
  if (!OCR_DOC_TYPES.includes(docType)) throw new OcrError('เอกสารประเภทนี้ไม่รองรับการอ่านอัตโนมัติ');
  if (config.ocrProvider === 'off') throw new OcrError('ระบบอ่านเอกสารอัตโนมัติปิดอยู่ กรุณากรอกข้อมูลเอง');
  const raw = config.ocrProvider === 'mock' ? extractMock(docType) : await extractWithClaude(buffer, mimeType, docType);
  return { provider: config.ocrProvider, ...postProcess(raw) };
}

// Fields that must agree across ID card, house registration and driving licence
const CROSS_CHECK = ['national_id', 'first_name_th', 'last_name_th', 'birth_date'];

export function crossCheck(ocrByType, confirmed) {
  const flags = [];
  for (const field of CROSS_CHECK) {
    const seen = Object.entries(ocrByType).filter(([, r]) => r?.[field]);
    const values = new Set(seen.map(([, r]) => r[field]));
    if (values.size > 1) {
      flags.push({ field, kind: 'DOCS_DISAGREE', detail: Object.fromEntries(seen.map(([t, r]) => [t, r[field]])) });
    }
  }
  // What the candidate submitted vs what AI read on the ID card
  const id = ocrByType.ID_CARD;
  const map = { national_id: 'national_id', first_name_th: 'first_name', last_name_th: 'last_name', birth_date: 'birth_date' };
  if (id) {
    for (const [ocrField, formField] of Object.entries(map)) {
      if (id[ocrField] && confirmed[formField] && id[ocrField] !== confirmed[formField]) {
        flags.push({ field: formField, kind: 'EDITED_AFTER_OCR', detail: { ocr: id[ocrField], submitted: confirmed[formField] } });
      }
    }
  }
  return flags;
}
