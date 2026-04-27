import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.ACCESS_TOKEN;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'finance.db');

if (!TOKEN || TOKEN.length < 8) {
  console.error('FATAL: ACCESS_TOKEN env var is required (min 8 chars). See .env.example');
  process.exit(1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id        TEXT PRIMARY KEY,
    type      TEXT NOT NULL CHECK(type IN ('income','expense')),
    name      TEXT NOT NULL,
    category  TEXT NOT NULL,
    amount    REAL NOT NULL CHECK(amount >= 0),
    date      TEXT NOT NULL,
    ts        INTEGER NOT NULL,
    note      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

const CATEGORIES_EXPENSE = ['Еда','Транспорт','Жильё','Сигареты','Развлечения','Здоровье','Одежда','Связь','Подарки','Другое'];
const CATEGORIES_INCOME  = ['Зарплата','Подработка','Подарок','Возврат','Другое'];

function uid() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

function parseDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return s;
  if ((m = s.match(/^(\d{1,2})[.\/\-](\d{1,2})[.\/\-](\d{4})$/))) {
    return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  }
  if ((m = s.match(/^(\d{4})[.\/](\d{1,2})[.\/](\d{1,2})$/))) {
    return `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  return null;
}

function parseAmount(v) {
  if (typeof v === 'number') return isFinite(v) ? Math.max(0, v) : null;
  if (v == null) return null;
  const s = String(v).replace(/\s/g, '').replace(/[^\d.,\-]/g, '').replace(',', '.');
  const n = parseFloat(s);
  return isFinite(n) ? Math.max(0, n) : null;
}

function normalizeType(v) {
  if (!v) return 'expense';
  const s = String(v).toLowerCase().trim();
  if (['income','доход','доходы','+','зачисление','поступление'].includes(s)) return 'income';
  return 'expense';
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function validateTx(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = normalizeType(raw.type);
  const name = String(raw.name || raw.title || raw.description || '').trim().slice(0, 200);
  const amount = parseAmount(raw.amount ?? raw.sum ?? raw.price ?? raw.total);
  if (!name || amount == null || amount <= 0) return null;

  let category = String(raw.category || '').trim().slice(0, 80);
  const known = type === 'expense' ? CATEGORIES_EXPENSE : CATEGORIES_INCOME;
  if (!category) category = 'Другое';
  // accept any provided category; UI will offer the canonical list
  const date = parseDate(raw.date) || todayISO();
  const note = raw.note ? String(raw.note).slice(0, 500) : null;

  return {
    id: String(raw.id || uid()),
    type, name, category, amount, date, note,
    ts: Number(raw.ts) || Date.now()
  };
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4mb' }));

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const ok = h === `Bearer ${TOKEN}`;
  if (!ok) {
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/auth/check', auth, (_req, res) => res.json({ ok: true }));

app.get('/api/categories', auth, (_req, res) => {
  res.json({ expense: CATEGORIES_EXPENSE, income: CATEGORIES_INCOME });
});

app.get('/api/transactions', auth, (_req, res) => {
  const rows = db.prepare('SELECT * FROM transactions ORDER BY date DESC, ts DESC').all();
  res.json(rows);
});

app.post('/api/transactions', auth, (req, res) => {
  const tx = validateTx(req.body);
  if (!tx) return res.status(400).json({ error: 'invalid transaction' });
  db.prepare('INSERT INTO transactions (id,type,name,category,amount,date,ts,note) VALUES (?,?,?,?,?,?,?,?)')
    .run(tx.id, tx.type, tx.name, tx.category, tx.amount, tx.date, tx.ts, tx.note);
  res.status(201).json(tx);
});

app.post('/api/transactions/bulk', auth, (req, res) => {
  const body = req.body;
  const arr = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : null;
  if (!arr) return res.status(400).json({ error: 'expected an array of transactions' });

  const stmt = db.prepare('INSERT INTO transactions (id,type,name,category,amount,date,ts,note) VALUES (?,?,?,?,?,?,?,?)');
  const rejected = [];
  const inserted = [];

  db.exec('BEGIN');
  try {
    for (let i = 0; i < arr.length; i++) {
      const tx = validateTx(arr[i]);
      if (!tx) { rejected.push({ index: i, raw: arr[i] }); continue; }
      try {
        stmt.run(tx.id, tx.type, tx.name, tx.category, tx.amount, tx.date, tx.ts, tx.note);
        inserted.push(tx);
      } catch (e) {
        rejected.push({ index: i, raw: arr[i], reason: e.message });
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: e.message });
  }

  res.json({ inserted: inserted.length, rejected: rejected.length, items: inserted, errors: rejected });
});

app.delete('/api/transactions/:id', auth, (req, res) => {
  const r = db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  res.json({ ok: true, deleted: r.changes });
});

app.get('/api/settings', auth, (_req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) {
    try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  }
  res.json(out);
});

app.put('/api/settings', auth, (req, res) => {
  const body = req.body || {};
  const stmt = db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  db.exec('BEGIN');
  try {
    for (const [k, v] of Object.entries(body)) stmt.run(String(k), JSON.stringify(v));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true });
});

app.use(express.static(__dirname, { extensions: ['html'], index: 'index.html' }));

app.listen(PORT, HOST, () => {
  console.log(`Капиталъ слушает http://${HOST}:${PORT}`);
  console.log(`БД: ${DB_PATH}`);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });
