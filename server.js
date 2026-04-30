import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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
    note      TEXT,
    shared    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);

try { db.exec(`ALTER TABLE transactions ADD COLUMN shared INTEGER NOT NULL DEFAULT 0`); } catch {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN qty REAL`); } catch {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN unit TEXT`); } catch {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN shop TEXT`); } catch {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN vat REAL`); } catch {}
try { db.exec(`ALTER TABLE transactions ADD COLUMN receipt_id TEXT`); } catch {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tx_receipt ON transactions(receipt_id)`); } catch {}

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

  const sv = raw.shared;
  const shared = (sv === true || sv === 1 || sv === '1' ||
                  (typeof sv === 'string' && ['true','yes','да','совместно','shared'].includes(sv.toLowerCase()))) ? 1 : 0;

  let qty = null;
  if (raw.qty != null) {
    const n = typeof raw.qty === 'number' ? raw.qty : parseFloat(String(raw.qty).replace(',', '.').replace(/\s/g, ''));
    if (isFinite(n) && n > 0) qty = n;
  }
  let unit = null;
  if (raw.unit) {
    unit = String(raw.unit).trim().toLowerCase().replace(/\.$/, '').slice(0, 8);
    if (!unit) unit = null;
  }
  const shop = raw.shop ? String(raw.shop).trim().slice(0, 80) || null : null;
  let vat = null;
  if (raw.vat != null) {
    const n = typeof raw.vat === 'number' ? raw.vat : parseFloat(String(raw.vat).replace(',', '.'));
    if (isFinite(n) && n >= 0 && n <= 100) vat = n;
  }
  const receipt_id = raw.receipt_id ? String(raw.receipt_id).slice(0, 60) || null : null;

  return {
    id: String(raw.id || uid()),
    type, name, category, amount, date, note, shared,
    qty, unit, shop, vat, receipt_id,
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

const INSERT_TX_SQL = 'INSERT INTO transactions (id,type,name,category,amount,date,ts,note,shared,qty,unit,shop,vat,receipt_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
const insertTxParams = (tx) => [tx.id, tx.type, tx.name, tx.category, tx.amount, tx.date, tx.ts, tx.note, tx.shared, tx.qty, tx.unit, tx.shop, tx.vat, tx.receipt_id];

app.post('/api/transactions', auth, (req, res) => {
  const tx = validateTx(req.body);
  if (!tx) return res.status(400).json({ error: 'invalid transaction' });
  db.prepare(INSERT_TX_SQL).run(...insertTxParams(tx));
  res.status(201).json(tx);
});

app.post('/api/transactions/bulk', auth, (req, res) => {
  const body = req.body;
  const arr = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : null;
  if (!arr) return res.status(400).json({ error: 'expected an array of transactions' });

  const stmt = db.prepare(INSERT_TX_SQL);
  const rejected = [];
  const inserted = [];
  const isMeta = body && typeof body === 'object' && !Array.isArray(body);
  const forceShared = isMeta && (body.shared === true || body.shared === 1);
  const forceShop = isMeta && body.shop ? String(body.shop) : null;
  const forceReceiptId = isMeta && body.receipt_id ? String(body.receipt_id) : null;

  db.exec('BEGIN');
  try {
    for (let i = 0; i < arr.length; i++) {
      const overrides = {};
      if (forceShared) overrides.shared = true;
      if (forceShop && !arr[i]?.shop) overrides.shop = forceShop;
      if (forceReceiptId && !arr[i]?.receipt_id) overrides.receipt_id = forceReceiptId;
      const raw = Object.keys(overrides).length ? { ...arr[i], ...overrides } : arr[i];
      const tx = validateTx(raw);
      if (!tx) { rejected.push({ index: i, raw: arr[i] }); continue; }
      try {
        stmt.run(...insertTxParams(tx));
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

app.put('/api/transactions/:id', auth, (req, res) => {
  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const tx = validateTx({ ...req.body, id: existing.id, ts: existing.ts });
  if (!tx) return res.status(400).json({ error: 'invalid transaction' });
  db.prepare('UPDATE transactions SET type=?, name=?, category=?, amount=?, date=?, note=?, shared=?, qty=?, unit=?, shop=?, vat=?, receipt_id=? WHERE id=?')
    .run(tx.type, tx.name, tx.category, tx.amount, tx.date, tx.note, tx.shared, tx.qty, tx.unit, tx.shop, tx.vat, tx.receipt_id, tx.id);
  res.json(tx);
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

// ── OFD receipt fetch ──
const OFD_ALLOWED_HOSTS = new Set([
  'check.ofd.ru',
  'consumer.1-ofd.ru',
  'lk.platformaofd.ru',
  'receipt.taxcom.ru'
]);

function decodeHtmlText(s) {
  if (s == null) return '';
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRuNumber(s) {
  if (s == null) return null;
  const cleaned = String(s).replace(/\s|&nbsp;/g, '').replace(',', '.').replace(/[^\d.\-]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : null;
}

function parseOfdRu(html) {
  // Slice the products region, fall back to whole html
  const startIdx = html.indexOf('<!-- Products -->');
  const endIdx = html.indexOf('<!-- /Products -->');
  const productsHtml = (startIdx >= 0 && endIdx > startIdx) ? html.slice(startIdx, endIdx) : html;

  const blocks = productsHtml.split('<div class="margin-top-10 clear-both ifw-bill-item">');
  const items = [];
  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const nameMatch = block.match(/<b>([^<]+)<\/b>/);
    if (!nameMatch) continue;
    const name = decodeHtmlText(nameMatch[1]);

    // <span>QTY</span><span> X </span><span>PRICE</span>
    const qpMatch = block.match(/<span>([\d\s.,]+)<\/span>\s*<span>\s*X\s*<\/span>\s*<span>([\d\s.,]+)<\/span>/);
    const qty = qpMatch ? parseRuNumber(qpMatch[1]) : null;
    const unitPrice = qpMatch ? parseRuNumber(qpMatch[2]) : null;

    // ifw-bill-item-total: <span> = </span><span>TOTAL</span>
    const totalMatch = block.match(/ifw-bill-item-total[^>]*>[\s\S]*?<span>\s*=\s*<\/span>\s*<span>([\d\s.,]+)<\/span>/);
    let total = totalMatch ? parseRuNumber(totalMatch[1]) : null;
    if (total == null && qty != null && unitPrice != null) total = qty * unitPrice;

    // VAT rate: text "СУММ НДС N%"
    const vatRateMatch = block.match(/НДС\s*(\d+(?:[.,]\d+)?)\s*%/);
    const vat = vatRateMatch ? parseRuNumber(vatRateMatch[1]) : null;

    // Unit (Мера кол-ва предмета расчета): nearest <div>...</div> after that label
    const unitMatch = block.match(/Мера\s+кол-ва[\s\S]{0,400}?<div[^>]*text-right[^>]*>([^<]+)<\/div>/i);
    let unit = unitMatch ? decodeHtmlText(unitMatch[1]).toLowerCase().replace(/\.$/, '') : null;
    if (unit && !/^[a-zа-я]+$/i.test(unit)) unit = null;

    if (name && total != null && total > 0) {
      items.push({
        name,
        amount: Math.round(total * 100) / 100,
        qty: qty != null && qty > 0 ? qty : null,
        unit: unit || null,
        vat
      });
    }
  }

  // Receipt-level fields
  // Store: <h2>Кассовый чек / ...</h2> ... <span>ООО "..."</span>
  let shop = null;
  const shopMatch = html.match(/<div class="text-align-center"><span>([^<]+)<\/span><\/div>/);
  if (shopMatch) {
    const raw = decodeHtmlText(shopMatch[1]);
    // Try to extract a friendly name, e.g. ООО "Лента" → Лента
    const m = raw.match(/["«»“”]([^"«»“”]+)["«»“”]/);
    shop = (m ? m[1] : raw).trim().slice(0, 40);
  }

  // Date: "ДАТА ВЫДАЧИ" in left col, value in right col  → "23.04.26 10:29"
  let date = null;
  const dateMatch = html.match(/ДАТА\s+ВЫДАЧИ[\s\S]{0,300}?<div[^>]*text-right[^>]*>([^<]+)<\/div>/i);
  if (dateMatch) {
    const raw = decodeHtmlText(dateMatch[1]);
    const dm = raw.match(/(\d{1,2})[.](\d{1,2})[.](\d{2,4})/);
    if (dm) {
      let y = dm[3];
      if (y.length === 2) y = (Number(y) >= 70 ? '19' : '20') + y;
      date = `${y}-${dm[2].padStart(2,'0')}-${dm[1].padStart(2,'0')}`;
    }
  }

  // Total: "ИТОГ" in left col, value in right col
  let total = null;
  const totalMatch = html.match(/>ИТОГ<\/div>\s*<div[^>]*text-right[^>]*>([^<]+)<\/div>/);
  if (totalMatch) total = parseRuNumber(totalMatch[1]);

  // Receipt fiscal sign (ФПД) — stable identifier
  let fpd = null;
  const fpdMatch = html.match(/ФПД[^<]*<\/span>\s*<span>([^<]+)<\/span>/i);
  if (fpdMatch) fpd = decodeHtmlText(fpdMatch[1]).slice(0, 40);

  return { shop, date, total, items, fpd };
}

const OFD_PARSERS = {
  'check.ofd.ru': parseOfdRu
};

app.post('/api/ofd/fetch', auth, async (req, res) => {
  const url = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
  if (!url) return res.status(400).json({ error: 'url required' });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'invalid url' }); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return res.status(400).json({ error: 'http/https only' });
  }
  if (!OFD_ALLOWED_HOSTS.has(parsed.hostname)) {
    return res.status(400).json({ error: `OFD provider not supported: ${parsed.hostname}` });
  }

  let html;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'error',
      headers: { 'User-Agent': 'Mozilla/5.0 Kapital/1.0', 'Accept': 'text/html' }
    });
    clearTimeout(t);
    if (!r.ok) return res.status(502).json({ error: `OFD HTTP ${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) return res.status(413).json({ error: 'response too large' });
    html = buf.toString('utf8');
  } catch (e) {
    return res.status(502).json({ error: `OFD fetch failed: ${e.name === 'AbortError' ? 'timeout' : e.message}` });
  }

  const parser = OFD_PARSERS[parsed.hostname];
  if (!parser) return res.status(501).json({ error: 'parser not implemented for ' + parsed.hostname });

  let receipt;
  try { receipt = parser(html); }
  catch (e) { return res.status(500).json({ error: 'parse failed: ' + e.message }); }

  if (!receipt.items || !receipt.items.length) {
    return res.status(422).json({ error: 'no items found in receipt', receipt });
  }
  res.json(receipt);
});

// ── Full backup ──
app.get('/api/backup/db', auth, (req, res) => {
  const tmp = path.join(os.tmpdir(), `kapital-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
  try {
    const escaped = tmp.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    return res.status(500).json({ error: 'backup failed: ' + e.message });
  }

  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}-${String(d.getMinutes()).padStart(2,'0')}`;
  const filename = `kapital-backup-${stamp}.db`;
  res.set({
    'Content-Type': 'application/vnd.sqlite3',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  const stream = fs.createReadStream(tmp);
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; fs.unlink(tmp, () => {}); };
  stream.on('close', cleanup);
  stream.on('error', (e) => {
    cleanup();
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.end();
  });
  res.on('close', cleanup);
  stream.pipe(res);
});

app.post('/api/backup/restore', auth, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') return res.status(400).json({ error: 'invalid body' });

  const transactions = Array.isArray(body) ? body
    : Array.isArray(body.transactions) ? body.transactions
    : Array.isArray(body.items) ? body.items
    : null;
  if (!transactions) return res.status(400).json({ error: 'expected transactions array or {transactions: [...]}' });

  const settings = (body.settings && typeof body.settings === 'object' && !Array.isArray(body.settings)) ? body.settings : null;
  const mode = body.mode === 'merge' ? 'merge' : 'replace';

  const stmt = db.prepare(INSERT_TX_SQL);
  const setStmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  let inserted = 0, rejected = 0;

  db.exec('BEGIN');
  try {
    if (mode === 'replace') {
      db.exec('DELETE FROM transactions');
      if (settings) db.exec('DELETE FROM settings');
    }
    for (let i = 0; i < transactions.length; i++) {
      const tx = validateTx(transactions[i]);
      if (!tx) { rejected++; continue; }
      try {
        stmt.run(...insertTxParams(tx));
        inserted++;
      } catch (e) {
        if (mode === 'merge' && /UNIQUE/i.test(e.message)) continue;
        rejected++;
      }
    }
    if (settings) {
      for (const [k, v] of Object.entries(settings)) setStmt.run(String(k), JSON.stringify(v));
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ error: e.message });
  }

  res.json({ ok: true, mode, inserted, rejected, settings: settings ? Object.keys(settings).length : 0 });
});

app.get('/api/backup/json', auth, (_req, res) => {
  const transactions = db.prepare('SELECT * FROM transactions ORDER BY date ASC, ts ASC').all();
  const settingsRows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of settingsRows) {
    try { settings[r.key] = JSON.parse(r.value); } catch { settings[r.key] = r.value; }
  }
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}_${String(d.getHours()).padStart(2,'0')}-${String(d.getMinutes()).padStart(2,'0')}`;
  const filename = `kapital-backup-${stamp}.json`;
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`
  });
  res.send(JSON.stringify({
    app: 'kapital',
    version: 2,
    exported_at: new Date().toISOString(),
    counts: { transactions: transactions.length, settings: Object.keys(settings).length },
    transactions,
    settings
  }, null, 2));
});

app.use(express.static(__dirname, { extensions: ['html'], index: 'index.html' }));

function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

app.listen(PORT, HOST, () => {
  const wildcard = HOST === '0.0.0.0' || HOST === '::';
  const primary = wildcard ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Капиталъ слушает ${primary}`);
  if (wildcard) {
    for (const addr of lanAddresses()) console.log(`              · http://${addr}:${PORT}`);
  }
  console.log(`БД: ${DB_PATH}`);
});

process.on('SIGTERM', () => { db.close(); process.exit(0); });
process.on('SIGINT',  () => { db.close(); process.exit(0); });