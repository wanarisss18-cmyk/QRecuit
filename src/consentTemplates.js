import crypto from 'node:crypto';
import { config } from './config.js';
import { formatThaiId } from './thaiId.js';

// The documents the candidate used to print and sign on paper, now e-signed once.
// Bump `version` whenever the wording changes; consents.content_sha256 pins the exact text agreed to.
// Text is a working draft modelled on the current paper forms — have Legal approve before go-live.
const C = config.companyName;
const HQ = '329 หมู่ที่ 10 ถนนรถรางสายเก่า ตำบลสำโรง อำเภอพระประแดง จังหวัดสมุทรปราการ 10130';

export const CONSENT_TEMPLATES = [
  {
    type: 'CERTIFIED_COPY',
    version: '2026-10',
    title: 'รับรองสำเนาถูกต้อง',
    body: (c) => `ข้าพเจ้า ${c.fullName} ขอรับรองว่าภาพเอกสาร (บัตรประจำตัวประชาชน ทะเบียนบ้าน ใบอนุญาตขับรถ และเอกสารอื่นที่แนบ) ที่อัปโหลดเข้าสู่ระบบเป็นสำเนาถูกต้องตรงกับต้นฉบับ และให้ใช้เพื่อการสมัครงานกับ ${C} เท่านั้น`,
  },
  {
    type: 'APPLICATION_TRUTH',
    version: '2026-10',
    title: 'คำรับรองข้อมูลในใบสมัคร',
    body: () => `ข้าพเจ้าทราบดีว่าข้อความที่ได้กรอกไว้ในใบสมัครนี้ถือเป็นสาระสำคัญ และเป็นคุณสมบัติในการพิจารณารับเข้าทำงาน จึงขอรับรองว่าข้อความทั้งหมดเป็นความจริงและถูกต้องทุกประการ หากข้อความตอนหนึ่งตอนใดไม่ตรงกับความเป็นจริงหรือเป็นข้อความเท็จ ให้ถือเป็นหลักฐานได้ว่าข้าพเจ้าได้พ้นจากการเป็นลูกจ้างบริษัทฯ`,
  },
  {
    type: 'PDPA',
    version: '2026-10',
    title: 'เอกสารแสดงความยินยอม (Consent Form) — PDPA',
    body: () => `ข้าพเจ้า "ให้" ความยินยอมแก่ ${C} ในการจัดเก็บ รวบรวม เก็บรักษา ใช้ ตลอดจนเปิดเผยข้อมูลส่วนบุคคลของข้าพเจ้า ให้แก่ ${C} และ/หรือคู่ค้า และ/หรือผู้สนใจใช้บริการ และ/หรือพันธมิตรทางธุรกิจ เพื่อการวิเคราะห์ คัดสรร และนำเสนอข้อมูลส่วนบุคคลของข้าพเจ้าในการเข้าทำงาน
รวมถึงยินยอมให้ใช้ระบบปัญญาประดิษฐ์ (AI) ของผู้ให้บริการภายนอก ซึ่งอาจประมวลผลนอกประเทศไทย อ่านข้อมูลจากภาพเอกสารเพื่อกรอกใบสมัครแทนการพิมพ์
ข้าพเจ้าได้อ่านคำประกาศเกี่ยวกับความเป็นส่วนตัวสำหรับผู้สมัครงานและพนักงานแล้ว และทราบว่าสามารถถอนความยินยอมได้ทุกเมื่อ เว้นแต่มีข้อจำกัดสิทธิตามกฎหมายหรือสัญญา ทั้งนี้การถอนความยินยอมอาจทำให้ข้าพเจ้าไม่ได้รับการคัดสรร และไม่กระทบการประมวลผลที่ได้ดำเนินการไปแล้ว
กรณีไม่ผ่านการคัดเลือก บริษัทฯ จะลบเอกสารของข้าพเจ้าภายใน ${config.retentionDays} วันนับจากวันที่ทราบผล`,
  },
  {
    type: 'BACKGROUND_CHECK',
    version: '2026-10',
    title: 'หนังสือยินยอมให้ตรวจประวัติบุคคล',
    body: (c) => `เรียน ผู้บังคับการกองทะเบียนประวัติอาชญากร
ข้าพเจ้า ${c.fullName} เลขประจำตัวประชาชน ${c.nationalId} อยู่บ้านเลขที่ ${c.address} บิดาชื่อ ${c.fatherName || '-'} มารดาชื่อ ${c.motherName || '-'}
ขอยินยอมให้ ${C} สำนักงานตั้งอยู่ที่ ${HQ} ซึ่งเป็นบริษัทฯ ที่ข้าพเจ้าเข้ามาสมัครงาน มีสิทธิในการดำเนินการใด ๆ ในการตรวจสอบประวัติของข้าพเจ้ากับกองทะเบียนประวัติอาชญากร โดยไม่มีเงื่อนไขใด ๆ ทั้งสิ้น`,
  },
  {
    type: 'EMPLOYMENT_CONTRACT',
    version: '2026-10',
    title: 'สัญญาจ้าง (รวมข้อ 15 การเปิดเผยข้อมูลแก่ลูกค้า)',
    body: (c) => `สัญญาระหว่าง ${C} ("ผู้ว่าจ้าง") กับ ${c.fullName} ("ผู้รับจ้าง")
ข้าพเจ้าได้อ่านและยอมรับเงื่อนไขในสัญญาจ้างฉบับเต็ม (ข้อ 1–15) ซึ่งแสดงในหน้านี้ รวมถึงข้อ 15: ผู้รับจ้างยินยอมให้ผู้ว่าจ้างเปิดเผยข้อมูลส่วนบุคคลของผู้รับจ้างแก่ลูกค้าหรือบุคคลอื่นใดที่ผู้ว่าจ้างเห็นสมควร เพื่อประโยชน์ในการประกอบกิจการจัดหาพนักงาน Outsource
สัญญามีผลเมื่อผู้ว่าจ้างลงนาม ซึ่งจะทำหลังผ่านการตรวจสอบประวัติแล้วเท่านั้น
[ใส่ข้อความสัญญาฉบับเต็มที่ฝ่ายกฎหมายอนุมัติที่นี่]`,
  },
  {
    type: 'POLICY_ACK',
    version: '2026-10',
    title: 'รับทราบประกาศบริษัทฯ (Application Tik Track)',
    body: () => `บริษัทฯ มีนโยบายพัฒนาระบบ Payroll เพื่อให้การจ่ายค่าจ้างรวดเร็วและถูกต้อง จึงขอให้พนักงานทุกท่าน Download Application Tik Track เพื่อแจ้งสถานะการปฏิบัติงาน ข้าพเจ้ารับทราบประกาศนี้แล้ว`,
  },
];

export function renderConsents(candidate) {
  const ctx = {
    fullName: `${candidate.title_th || ''}${candidate.first_name} ${candidate.last_name}`.trim(),
    nationalId: formatThaiId(candidate.national_id),
    address: formatAddress(candidate),
    fatherName: candidate.father_name,
    motherName: candidate.mother_name,
  };
  return CONSENT_TEMPLATES.map((t) => {
    const text = t.body(ctx);
    return { type: t.type, version: t.version, title: t.title, text, sha256: crypto.createHash('sha256').update(text).digest('hex') };
  });
}

export function formatAddress(c) {
  return [
    c.addr_house_no,
    c.addr_moo && `หมู่ ${c.addr_moo}`,
    c.addr_soi && `ซ.${c.addr_soi}`,
    c.addr_road && `ถ.${c.addr_road}`,
    c.addr_subdistrict && `ต./แขวง ${c.addr_subdistrict}`,
    c.addr_district && `อ./เขต ${c.addr_district}`,
    c.addr_province && `จ.${c.addr_province}`,
    c.addr_postal_code,
  ].filter(Boolean).join(' ');
}
