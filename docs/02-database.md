# 02 — Database Schema / ER Diagram

SQL จริง: [`db/schema.sql`](../db/schema.sql) — SQLite (ใช้ `node:sqlite` ไม่ต้องติดตั้ง DB) ย้ายไป PostgreSQL ได้โดยเปลี่ยน `INTEGER PRIMARY KEY` → `BIGSERIAL`, วันที่ `TEXT` → `TIMESTAMPTZ`, `application_json`/`ocr_json` → `JSONB`

จาก 4 ตารางในโจทย์ เพิ่ม 4 ตารางที่จำเป็นเมื่อใช้งานจริง:

| ตาราง | ทำไมต้องมี |
|---|---|
| `work_experiences` | ใบสมัครมี "บริษัทล่าสุด / ก่อนล่าสุด" — 1 คนหลายแถว |
| `consents` | 1 แถว/เอกสารที่เซ็น (รับรองสำเนา, PDPA, ตรวจประวัติ, สัญญาจ้าง, NDA/ข้อ 15, ประกาศ Tik Track) + hash ของข้อความที่ยินยอม = หลักฐานทางกฎหมาย |
| `check_batches` | รอบการส่งตรวจประวัติรายวัน (ใครส่ง ส่งกี่คน) |
| `audit_logs` | บันทึกการเข้าถึงข้อมูลส่วนบุคคล (PDPA ม.39) |

การออกแบบที่สำคัญ:

- **ข้อมูลที่ต้องค้นหา/ใช้ในหนังสือราชการเป็นคอลัมน์** (เลขบัตร, ชื่อ, ที่อยู่ตามทะเบียนบ้านแยกช่อง, ชื่อบิดา/มารดา — หนังสือยินยอมตรวจประวัติถึงกองทะเบียนประวัติอาชญากรต้องใช้) ส่วนที่เหลือของใบสมัครกระดาษ (การศึกษา, ทักษะ, การขับขี่, คำรับรองสุขภาพ) อยู่ใน `application_json`
- **`documents.ocr_json`** เก็บผล AI OCR ดิบ ที่ผูกกับ sha256 ของไฟล์นั้นจริง → HR เห็นได้ว่าผู้สมัครแก้ข้อมูลจากที่ AI อ่านหรือไม่
- **ลายเซ็น** เก็บเป็น PNG ใน `documents (doc_type='SIGNATURE')` และอ้างจาก `consents.signature_document_id` → ลบตาม Retention ด้วยกลไกเดียวกับเอกสารอื่น
- **`main_sync_status`** = Gatekeeper ระดับฐานข้อมูล: ค่าเริ่มต้น `NOT_ALLOWED` จะเปลี่ยนเป็น `QUEUED` ได้เฉพาะเมื่อผลตรวจ = ผ่าน

```mermaid
erDiagram
  users_hr ||--o{ check_batches : exports
  users_hr ||--o{ background_checks : "records result"
  users_hr ||--o{ audit_logs : performs
  candidates ||--o{ work_experiences : has
  candidates ||--o{ documents : uploads
  candidates ||--o{ consents : signs
  candidates ||--o{ background_checks : "checked in"
  check_batches ||--o{ background_checks : contains
  documents ||--o{ consents : "signature of"

  users_hr {
    INTEGER id PK
    TEXT username UK
    TEXT full_name
    TEXT password_hash "scrypt"
    TEXT role "staff | manager"
    INTEGER is_active
  }
  candidates {
    INTEGER id PK
    TEXT application_no UK "APP-20261030-0001"
    TEXT tracking_token UK
    TEXT national_id "13 หลัก (จาก OCR)"
    TEXT title_th
    TEXT first_name
    TEXT last_name
    TEXT first_name_en
    TEXT last_name_en
    TEXT birth_date
    TEXT phone
    TEXT line_id
    TEXT addr_house_no "ที่อยู่ตามทะเบียนบ้าน 8 ช่อง"
    TEXT addr_province
    TEXT father_name
    TEXT mother_name
    TEXT position_applied
    TEXT application_json "ส่วนที่เหลือของใบสมัคร"
    TEXT status "PENDING_CHECK|IN_CHECK|PASSED|REJECTED"
    INTEGER is_locked
    TEXT main_sync_status "NOT_ALLOWED|QUEUED|SENT|FAILED"
    TEXT main_sync_ref
    TEXT retention_delete_after
    TEXT purged_at
    TEXT created_at
  }
  work_experiences {
    INTEGER id PK
    INTEGER candidate_id FK
    TEXT company
    TEXT position
    INTEGER salary
    TEXT start_date
    TEXT end_date
    TEXT reason_leaving
  }
  documents {
    INTEGER id PK
    INTEGER candidate_id FK
    TEXT doc_type "ID_CARD|DRIVER_LICENSE|HOUSE_REG|PHOTO|EDUCATION|SIGNATURE|OTHER"
    TEXT storage_path "local / S3 key"
    TEXT mime_type
    INTEGER size_bytes
    TEXT sha256
    TEXT ocr_json "ผล AI OCR"
    TEXT deleted_at
  }
  consents {
    INTEGER id PK
    INTEGER candidate_id FK
    TEXT consent_type "CERTIFIED_COPY|PDPA|BACKGROUND_CHECK|EMPLOYMENT_CONTRACT|..."
    TEXT consent_version
    TEXT content_sha256
    INTEGER signature_document_id FK
    TEXT signed_at
    TEXT ip_address
  }
  check_batches {
    INTEGER id PK
    TEXT batch_no UK
    INTEGER exported_by FK
    TEXT exported_at
    INTEGER candidate_count
  }
  background_checks {
    INTEGER id PK
    INTEGER candidate_id FK
    INTEGER batch_id FK
    TEXT status "PENDING|PASSED|FAILED"
    TEXT submitted_at
    TEXT result_at
    TEXT case_detail "manager เท่านั้น"
    INTEGER recorded_by FK
  }
  audit_logs {
    INTEGER id PK
    INTEGER user_id FK
    TEXT action
    INTEGER candidate_id
    TEXT detail
    TEXT created_at
  }
```

## Constraint ที่บังคับใช้

| สิ่งที่บังคับ | วิธี |
|---|---|
| เลขบัตรห้ามมีใบสมัครค้างซ้ำ | partial unique index `ux_candidates_active_nid` |
| สถานะอยู่ในชุดที่กำหนด | `CHECK (...)` |
| Gatekeeper | API ตรวจ `status = 'PASSED'` ก่อน sync / print — ตอบ HTTP 423 Locked |
| Retention | `retention_delete_after` ตั้งตอนบันทึก FAILED; job รายชั่วโมงลบไฟล์ + ปกปิด PII เหลือแค่สถิติ |

## เมื่อขึ้น Production

- เข้ารหัส `national_id` ระดับคอลัมน์ (AES-256-GCM) + เก็บ HMAC ไว้ค้นหาซ้ำ
- เก็บไฟล์ใน Object Storage แบบ private (S3 / Azure Blob / GCS) + signed URL อายุสั้น
- HTTPS เท่านั้น, backup เข้ารหัส, retention ของ backup ต้องสอดคล้องกัน
