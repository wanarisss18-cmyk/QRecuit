import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';

export class GatekeeperError extends Error {}

// The only way candidate data leaves for the main HR system.
// Refuses anything that has not PASSED the background check.
export function assertPassed(candidate) {
  if (!candidate || candidate.status !== 'PASSED' || candidate.is_locked) {
    throw new GatekeeperError('ห้ามคีย์เข้าสู่ระบบหลัก และห้ามพิมพ์เอกสาร — ผู้สมัครยังไม่ผ่านการตรวจประวัติ');
  }
}

function buildPayload(c) {
  const work = db.prepare('SELECT company, business_type, position, duties, salary, start_date, end_date, reason_leaving FROM work_experiences WHERE candidate_id = ?').all(c.id);
  return {
    source: 'q-recruit',
    application_no: c.application_no,
    national_id: c.national_id,
    title_th: c.title_th,
    first_name: c.first_name,
    last_name: c.last_name,
    first_name_en: c.first_name_en,
    last_name_en: c.last_name_en,
    birth_date: c.birth_date,
    phone: c.phone,
    email: c.email,
    address: {
      house_no: c.addr_house_no, moo: c.addr_moo, soi: c.addr_soi, road: c.addr_road,
      subdistrict: c.addr_subdistrict, district: c.addr_district, province: c.addr_province, postal_code: c.addr_postal_code,
    },
    position_applied: c.position_applied,
    application: JSON.parse(c.application_json || '{}'),
    work_experiences: work,
    background_check: 'PASSED',
  };
}

export async function syncToMainSystem(candidateId) {
  const c = db.prepare('SELECT * FROM candidates WHERE id = ?').get(candidateId);
  assertPassed(c);
  db.prepare("UPDATE candidates SET main_sync_status = 'QUEUED', main_sync_error = NULL WHERE id = ?").run(c.id);
  const payload = buildPayload(c);
  try {
    let ref;
    if (config.mainSystemWebhook) {
      const res = await fetch(config.mainSystemWebhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': c.application_no },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      ref = (await res.json().catch(() => ({}))).id ?? c.application_no;
    } else {
      // No API on the main system yet: drop a JSON file its import job can pick up
      const dir = path.join(config.dataDir, 'outbox');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${c.application_no}.json`);
      fs.writeFileSync(file, JSON.stringify(payload, null, 2));
      ref = `outbox/${c.application_no}.json`;
    }
    db.prepare("UPDATE candidates SET main_sync_status = 'SENT', main_sync_ref = ?, main_synced_at = datetime('now') WHERE id = ?").run(String(ref), c.id);
    return { ok: true, ref };
  } catch (err) {
    db.prepare("UPDATE candidates SET main_sync_status = 'FAILED', main_sync_error = ? WHERE id = ?").run(err.message, c.id);
    return { ok: false, error: err.message };
  }
}
