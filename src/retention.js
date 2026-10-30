import fs from 'node:fs';
import path from 'node:path';
import { db, tx } from './db.js';
import { config } from './config.js';

// PDPA: once a rejected candidate's retention date passes, delete every uploaded file
// (signature included) and blank out personal data. The row stays for statistics.
export function runRetention({ now = new Date() } = {}) {
  const due = db
    .prepare(
      `SELECT id, application_no FROM candidates
       WHERE status = 'REJECTED' AND purged_at IS NULL
         AND retention_delete_after IS NOT NULL AND retention_delete_after <= ?`
    )
    .all(now.toISOString());

  const purged = [];
  for (const c of due) {
    const docs = db.prepare('SELECT id, storage_path FROM documents WHERE candidate_id = ? AND deleted_at IS NULL').all(c.id);
    for (const d of docs) fs.rmSync(path.join(config.dataDir, d.storage_path), { force: true });
    tx(() => {
      db.prepare("UPDATE documents SET deleted_at = datetime('now'), ocr_json = NULL WHERE candidate_id = ?").run(c.id);
      db.prepare('DELETE FROM work_experiences WHERE candidate_id = ?').run(c.id);
      db.prepare('UPDATE background_checks SET case_detail = NULL WHERE candidate_id = ?').run(c.id);
      db.prepare(
        `UPDATE candidates SET national_id = NULL, title_th = NULL, first_name = NULL, last_name = NULL,
           first_name_en = NULL, last_name_en = NULL, birth_date = NULL, phone = NULL, email = NULL, line_id = NULL,
           addr_house_no = NULL, addr_moo = NULL, addr_soi = NULL, addr_road = NULL, addr_subdistrict = NULL,
           addr_district = NULL, addr_province = NULL, addr_postal_code = NULL,
           father_name = NULL, mother_name = NULL, application_json = NULL, review_flags = NULL,
           purged_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ?`
      ).run(c.id);
      db.prepare("INSERT INTO audit_logs (action, candidate_id, detail) VALUES ('RETENTION_PURGE', ?, ?)").run(
        c.id,
        JSON.stringify({ files: docs.length })
      );
    });
    purged.push(c.application_no);
  }
  return { purged };
}

export function scheduleRetention() {
  const tick = () => {
    const { purged } = runRetention();
    if (purged.length) console.log(`[retention] purged ${purged.length}: ${purged.join(', ')}`);
  };
  tick();
  return setInterval(tick, config.retentionIntervalMs).unref();
}

if (process.argv.includes('--run-once')) console.log(runRetention());
