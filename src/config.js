import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  root,
  port: Number(process.env.PORT || 3000),
  httpsPort: Number(process.env.HTTPS_PORT || 3443),
  dataDir: process.env.DATA_DIR || path.join(root, 'storage'),
  companyName: process.env.COMPANY_NAME || 'บริษัท สยามราชธานี จำกัด (มหาชน)',
  // Days to keep a rejected candidate's documents before auto-delete (PDPA)
  retentionDays: Number(process.env.RETENTION_DAYS || 30),
  retentionIntervalMs: 60 * 60 * 1000,
  maxUploadBytes: 10 * 1024 * 1024,
  tokenTtlMs: 8 * 60 * 60 * 1000,
  // claude | mock | off  (claude needs ANTHROPIC_API_KEY or an `ant auth login` profile)
  ocrProvider: process.env.OCR_PROVIDER || (process.env.ANTHROPIC_API_KEY ? 'claude' : 'mock'),
  ocrModel: process.env.OCR_MODEL || 'claude-opus-5-5',
  // Main HR system hand-off: POST JSON here when set, otherwise drop a file in storage/outbox
  mainSystemWebhook: process.env.MAIN_SYSTEM_WEBHOOK_URL || '',
  // Initial password for the 5 seeded HR accounts (local dev only — change after first login)
  seedPassword: process.env.SEED_PASSWORD || 'ChangeMe!2026',
};
