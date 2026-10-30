# Q-Recruit — Smart Recruitment & OCR Portal

ระบบรับสมัครงานออนไลน์ + AI OCR + Background Check Gatekeeper สำหรับ บริษัท สยามราชธานี จำกัด (มหาชน)

| เอกสาร | เนื้อหา |
|---|---|
| [docs/01-workflow.md](docs/01-workflow.md) | User Journey ผู้สมัคร / Workflow HR / State machine / RBAC |
| [docs/02-database.md](docs/02-database.md) | ER Diagram + เหตุผลการออกแบบ |
| [docs/03-ai-ocr.md](docs/03-ai-ocr.md) | การออกแบบ AI OCR, ค่าใช้จ่าย, PDPA |
| [db/schema.sql](db/schema.sql) | SQL schema |

## เริ่มใช้งาน (Node.js 22.13+)

```bash
npm install
npm start
```

- ผู้สมัคร: http://localhost:3000/apply/ (เปิดบนมือถือได้)
- HR: http://localhost:3000/hr/ — บัญชีเริ่มต้น `hr.manager` (ผู้จัดการ), `hr01`–`hr04` (เจ้าหน้าที่) รหัสผ่านเริ่มต้นอยู่ใน `SEED_PASSWORD` / [src/config.js](src/config.js) — **เปลี่ยนก่อนใช้งานจริง**

ถ้าไม่ได้ตั้ง `ANTHROPIC_API_KEY` ระบบจะใช้ `OCR_PROVIDER=mock` (คืนข้อมูลสมมติ) เพื่อทดลอง UI ได้ทันที

## ทดสอบกล้องสแกนบนมือถือจริง (Wi-Fi เดียวกัน)

มือถือเปิดกล้องในหน้าเว็บได้เฉพาะ HTTPS — ถ้ามีไฟล์ `storage/certs/dev-cert.pem` + `dev-key.pem` เซิร์ฟเวอร์จะเปิด HTTPS ที่พอร์ต 3443 เพิ่ม

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -keyout storage/certs/dev-key.pem -out storage/certs/dev-cert.pem -subj "/CN=Q-Recruit Dev" -addext "subjectAltName=IP:<IP เครื่องนี้>,IP:127.0.0.1,DNS:localhost"
```

เปิด `https://<IP เครื่องนี้>:3443/apply/` บนมือถือ → กดผ่านคำเตือนใบรับรอง (Advanced → Proceed) → อนุญาตกล้อง
Windows Firewall ต้องอนุญาต Node.js รับการเชื่อมต่อขาเข้า — ใบรับรองนี้ใช้ทดสอบเท่านั้น ใช้งานจริงต้องมีโดเมนและใบรับรองจริง

## ตัวแปรสภาพแวดล้อม

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `ANTHROPIC_API_KEY` | – | เปิด AI OCR จริงด้วย Claude |
| `OCR_PROVIDER` | `claude` ถ้ามี key, ไม่งั้น `mock` | `claude` / `mock` / `off` |
| `OCR_MODEL` | `claude-opus-5-5` | |
| `MAIN_SYSTEM_WEBHOOK_URL` | – | URL ของระบบหลักที่จะ POST ข้อมูลผู้ผ่าน; ถ้าไม่ตั้ง จะเขียนไฟล์ JSON ลง `storage/outbox/` |
| `RETENTION_DAYS` | `30` | ลบเอกสารของผู้ไม่ผ่านหลังจากได้ผลกี่วัน |
| `SEED_PASSWORD` | ดู config | รหัสผ่านเริ่มต้นของ 5 บัญชี HR (ใช้ตอนสร้าง DB ครั้งแรกเท่านั้น) |
| `PORT`, `DATA_DIR`, `COMPANY_NAME`, `AUTH_SECRET` | | |

## โครงสร้างโค้ด

```
src/
  server.js           Express API (ผู้สมัคร + HR) และ Gatekeeper
  ocr.js              AI OCR (Claude Vision + Structured Outputs) + ตรวจข้อมูลข้ามเอกสาร
  consentTemplates.js เอกสารที่เซ็นอิเล็กทรอนิกส์ (รับรองสำเนา, PDPA, ตรวจประวัติ, สัญญา, ประกาศ)
  mainSystem.js       ส่งข้อมูลเข้าระบบหลัก — ปฏิเสธทุกเคสที่ยังไม่ PASSED
  retention.js        ลบข้อมูลผู้ไม่ผ่านตามกำหนด (รันทุกชั่วโมง / npm run retention)
  auth.js             Login, token, ตาราง RBAC (PERMISSIONS)
public/
  apply/              Candidate Portal (mobile-first, 5 ขั้นตอน)
  status/             หน้าติดตามสถานะ
  hr/                 Dashboard + หน้า Print/PDF
```

## API หลัก

| Method | Path | สิทธิ์ |
|---|---|---|
| POST | `/api/ocr` | สาธารณะ (rate-limited) |
| POST | `/api/applications` | สาธารณะ |
| GET | `/api/applications/status/:token` | สาธารณะ |
| GET | `/api/hr/candidates` · `/api/hr/candidates/:id` | staff, manager |
| POST | `/api/hr/batches` → CSV | staff, manager |
| POST | `/api/hr/candidates/:id/check-result` · `/api/hr/batches/:id/results` | manager |
| POST | `/api/hr/candidates/:id/sync` · GET `/dossier` | staff, manager — **423 Locked ถ้าไม่ PASSED** |
| GET | `/api/hr/audit` · POST `/api/hr/retention/run` | manager |

## ก่อนขึ้น Production

1. ให้ฝ่ายกฎหมายตรวจข้อความใน `src/consentTemplates.js` (โดยเฉพาะสัญญาจ้างฉบับเต็ม และข้อความยินยอมให้ AI ภายนอกประมวลผล)
2. ทำ DPA กับผู้ให้บริการ AI / พิจารณา Zero Data Retention
3. HTTPS, เข้ารหัสเลขบัตรระดับคอลัมน์, ย้ายไฟล์ไป Object Storage แบบ private (ดู docs/02-database.md)
4. เชื่อม `MAIN_SYSTEM_WEBHOOK_URL` กับระบบ HR หลัก
5. เปลี่ยนรหัสผ่านเริ่มต้นทั้ง 5 บัญชี
