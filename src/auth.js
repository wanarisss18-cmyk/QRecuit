import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// HMAC secret persisted under storage/ so tokens survive restarts
function loadSecret() {
  if (process.env.AUTH_SECRET) return process.env.AUTH_SECRET;
  const file = path.join(config.dataDir, '.auth-secret');
  fs.mkdirSync(config.dataDir, { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8').trim();
}
const SECRET = loadSecret();

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

export const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

export function verifySignature(data, sig) {
  const expected = sign(data);
  return typeof sig === 'string' && sig.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

export function issueToken(user) {
  const payload = Buffer.from(
    JSON.stringify({ id: user.id, role: user.role, name: user.full_name, exp: Date.now() + config.tokenTtlMs })
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function readToken(token) {
  const [payload, sig] = String(token || '').split('.');
  if (!payload || !verifySignature(payload, sig)) return null;
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return data.exp > Date.now() ? data : null;
}

// What each role may do — the single place to adjust RBAC
export const PERMISSIONS = {
  'candidate:list': ['staff', 'manager'],
  // full national ID, parents' names, health / criminal self-declarations
  'candidate:view-sensitive': ['manager'],
  'document:view': ['staff', 'manager'],
  'document:view-rejected': ['manager'],
  'batch:export': ['staff', 'manager'],
  'check:record': ['manager'],
  'check:view-detail': ['manager'],
  'candidate:sync-and-print': ['staff', 'manager'],
  'audit:view': ['manager'],
  'retention:run': ['manager'],
};

export const can = (user, permission) => Boolean(user && PERMISSIONS[permission]?.includes(user.role));

export function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  // ?token= is accepted only so <img>/<a> tags can fetch protected files
  const user = readToken(header.startsWith('Bearer ') ? header.slice(7) : req.query.token);
  if (!user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  req.user = user;
  next();
}

export const requirePermission = (permission) => (req, res, next) =>
  can(req.user, permission) ? next() : res.status(403).json({ error: 'ไม่มีสิทธิ์ดำเนินการนี้' });
