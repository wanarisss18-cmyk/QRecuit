import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';
import { hashPassword } from './auth.js';

fs.mkdirSync(path.join(config.dataDir, 'uploads'), { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'recruit.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(fs.readFileSync(path.join(config.root, 'db', 'schema.sql'), 'utf8'));

export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function audit(req, action, candidateId = null, detail = null) {
  db.prepare(
    'INSERT INTO audit_logs (user_id, action, candidate_id, detail, ip_address) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user?.id ?? null, action, candidateId, detail ? JSON.stringify(detail) : null, req.ip ?? null);
}

// Seed the 5-person HR team on first run
const { n } = db.prepare('SELECT COUNT(*) AS n FROM users_hr').get();
if (n === 0) {
  const seed = [
    ['hr.manager', 'ผู้จัดการฝ่ายบุคคล', 'manager'],
    ['hr01', 'เจ้าหน้าที่ HR 1', 'staff'],
    ['hr02', 'เจ้าหน้าที่ HR 2', 'staff'],
    ['hr03', 'เจ้าหน้าที่ HR 3', 'staff'],
    ['hr04', 'เจ้าหน้าที่ HR 4', 'staff'],
  ];
  const insert = db.prepare('INSERT INTO users_hr (username, full_name, password_hash, role) VALUES (?, ?, ?, ?)');
  for (const [username, fullName, role] of seed) insert.run(username, fullName, hashPassword(config.seedPassword), role);
  console.log(`Seeded ${seed.length} HR accounts (initial password from SEED_PASSWORD / config).`);
}
