import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { makePool } from './db.js';
import { parseMealExcel } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '');

const app = express();
app.disable('x-powered-by');

// Basic JSON API
app.use(express.json({ limit: '1mb' }));

// Static pages
app.use(express.static(path.join(__dirname, 'public')));

// Upload temp dir
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

const pool = makePool();

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS week_menus (
      site TEXT NOT NULL,
      week_start DATE NOT NULL,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (site, week_start)
    );
  `);
}

function requireAdmin(req, res, next) {
  // Accept either header or form field
  const token = (req.headers['x-admin-token'] || req.body?.token || req.query?.token || '').toString();
  if (!ADMIN_TOKEN) {
    return res.status(500).json({ error: 'Server misconfigured: ADMIN_TOKEN not set' });
  }
  if (token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1 as ok');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// Get latest week payload for a site
app.get('/api/latest', async (req, res) => {
  const site = (req.query.site || 'main').toString();
  try {
    const { rows } = await pool.query(
      'SELECT payload FROM week_menus WHERE site=$1 ORDER BY updated_at DESC LIMIT 1',
      [site]
    );
    if (!rows.length) return res.status(404).json({ error: 'No data for this site yet' });
    res.json(rows[0].payload);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load latest', detail: String(e?.message || e) });
  }
});

// Backward-compatible endpoints used by the static UI
app.get('/api/weeks/latest', async (req, res) => {
  const site = (req.query.site || 'main').toString();
  try {
    const { rows } = await pool.query(
      'SELECT week_start FROM week_menus WHERE site=$1 ORDER BY updated_at DESC LIMIT 1',
      [site]
    );
    if (!rows.length) return res.status(404).json({ error: 'No data for this site yet' });
    res.json({ weekStart: rows[0].week_start });
  } catch (e) {
    res.status(500).json({ error: 'Failed to load latest weekStart', detail: String(e?.message || e) });
  }
});

app.get('/api/weeks/:weekStart', async (req, res) => {
  const site = (req.query.site || 'main').toString();
  const weekStart = (req.params.weekStart || '').toString();
  try {
    const { rows } = await pool.query(
      'SELECT payload FROM week_menus WHERE site=$1 AND week_start=$2',
      [site, weekStart]
    );
    if (!rows.length) return res.status(404).json({ error: 'No such week' });
    res.json(rows[0].payload);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load week', detail: String(e?.message || e) });
  }
});

// Upload & parse Excel, then upsert week
app.post('/api/upload', requireAdmin, upload.single('file'), async (req, res) => {
  const site = (req.body.site || req.query.site || 'main').toString();
  if (!req.file) return res.status(400).json({ error: 'file is required' });

  try {
    const payload = parseMealExcel(req.file.path, req.file.originalname, site);
    if (!payload.weekStart) return res.status(400).json({ error: 'Could not determine weekStart from the file' });

    await pool.query(
      `INSERT INTO week_menus(site, week_start, payload, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT(site, week_start)
       DO UPDATE SET payload=EXCLUDED.payload, updated_at=NOW()` ,
      [site, payload.weekStart, JSON.stringify(payload)]
    );

    res.json({ ok: true, site, weekStart: payload.weekStart, days: Object.keys(payload.days || {}).length });
  } catch (e) {
    res.status(500).json({ error: 'Upload/parse failed', detail: String(e?.message || e) });
  } finally {
    // cleanup temp file
    try { fs.unlinkSync(req.file.path); } catch {}
  }
});

// Helpful: list available weeks for a site
app.get('/api/weeks', async (req, res) => {
  const site = (req.query.site || 'main').toString();
  try {
    const { rows } = await pool.query(
      'SELECT week_start, updated_at FROM week_menus WHERE site=$1 ORDER BY week_start DESC',
      [site]
    );
    res.json({ site, weeks: rows.map(r => ({ weekStart: r.week_start, updatedAt: r.updated_at })) });
  } catch (e) {
    res.status(500).json({ error: 'Failed to list weeks', detail: String(e?.message || e) });
  }
});

// Load a specific week
app.get('/api/week', async (req, res) => {
  const site = (req.query.site || 'main').toString();
  const weekStart = (req.query.weekStart || '').toString();
  if (!weekStart) return res.status(400).json({ error: 'weekStart is required' });

  try {
    const { rows } = await pool.query(
      'SELECT payload FROM week_menus WHERE site=$1 AND week_start=$2',
      [site, weekStart]
    );
    if (!rows.length) return res.status(404).json({ error: 'No such week' });
    res.json(rows[0].payload);
  } catch (e) {
    res.status(500).json({ error: 'Failed to load week', detail: String(e?.message || e) });
  }
});

async function main() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Mealplan app listening on :${PORT}`);
  });
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
