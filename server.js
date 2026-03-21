/**
 * MisCuentas RD — Bot Server v2
 * Stack : Express + Telegram Webhooks + PostgreSQL (Railway) + Groq Vision + Gemini
 * Host  : Railway
 */

'use strict';

const express  = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// ─── ENV ──────────────────────────────────────────────────────────────────────
const {
  TELEGRAM_BOT_TOKEN,
  DATABASE_URL,
  GEMINI_API_KEY,
  GROQ_API_KEY,
  CRON_SECRET,
  WEBHOOK_SECRET,          // token aleatorio para validar llamadas de Telegram
  SESSION_SECRET = 'miscuentas_secret_change_me', // secreto para firmar tokens de sesión
  PORT = 3000,
  API_BASE = '',
} = process.env;

['TELEGRAM_BOT_TOKEN', 'DATABASE_URL'].forEach(k => {
  if (!process.env[k]) { console.error(`❌ Missing env: ${k}`); process.exit(1); }
});

// ─── POSTGRES ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', err => console.error('PG pool error:', err.message));

// ─── SESSION TOKENS ───────────────────────────────────────────────────────────
const crypto = require('crypto');

function generateToken(userId) {
  const payload = `${userId}:${Date.now()}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(`${payload}:${sig}`).toString('base64url');
}

function verifyToken(token) {
  try {
    const decoded = Buffer.from(token, 'base64url').toString();
    const lastColon = decoded.lastIndexOf(':');
    const payload = decoded.substring(0, lastColon);
    const sig = decoded.substring(lastColon + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    if (sig !== expected) return null;
    const colonIdx = payload.indexOf(':');
    return payload.substring(0, colonIdx); // userId
  } catch {
    return null;
  }
}

// ─── TELEGRAM OAUTH TOKENS (DB-backed) ─────────────────────────────────────────

// Create a pending auth token
async function createAuthToken(token, telegramId) {
  const sessionToken = generateToken(telegramId);
  await query(
    `INSERT INTO auth_tokens (token, telegram_id, session_token, created_at)
     VALUES($1, $2, $3, NOW())
     ON CONFLICT (token) DO UPDATE SET
       telegram_id = EXCLUDED.telegram_id,
       session_token = EXCLUDED.session_token,
       created_at = NOW()`,
    [token, telegramId, sessionToken]
  );
  return sessionToken;
}

// Get and delete an auth token (one-time use)
async function consumeAuthToken(token) {
  const r = await query(
    `SELECT telegram_id, session_token FROM auth_tokens
     WHERE token = $1 AND created_at > NOW() - INTERVAL '30 minutes'`,
    [token]
  );
  if (!r.rows[0]) return null;
  await query('DELETE FROM auth_tokens WHERE token = $1', [token]);
  return r.rows[0];
}

// Check if token exists and is pending (not yet completed by bot)
async function getAuthTokenStatus(token) {
  const r = await query(
    `SELECT telegram_id, session_token FROM auth_tokens
     WHERE token = $1 AND created_at > NOW() - INTERVAL '30 minutes'`,
    [token]
  );
  if (!r.rows[0]) return { exists: false, expired: true };
  return { exists: true, telegram_id: r.rows[0].telegram_id, session_token: r.rows[0].session_token };
}

function authMiddleware(req, res, next) {
  const token = req.headers['x-session-token'];
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  const userId = verifyToken(token);
  if (!userId) return res.status(401).json({ error: 'invalid token' });
  req.userId = userId;
  next();
}

async function query(sql, params = []) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// ─── TELEGRAM API ─────────────────────────────────────────────────────────────
const TG = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function tgCall(method, body) {
  const res = await fetch(`${TG}/${method}`, {
    method : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body   : JSON.stringify(body),
    signal : AbortSignal.timeout(15000),
  });
  return res.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

async function getFileLink(fileId) {
  const r = await tgCall('getFile', { file_id: fileId });
  if (!r.ok) throw new Error('getFile failed');
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${r.result.file_path}`;
}

// ─── WEBHOOK SETUP ────────────────────────────────────────────────────────────
async function setWebhook(baseUrl) {
  const url = `${baseUrl}/webhook/${WEBHOOK_SECRET || 'tg'}`;
  const r   = await tgCall('setWebhook', { url, drop_pending_updates: true });
  console.log('Webhook set:', r.ok ? '✅' : '❌', r.description || '');
  return r;
}

// ─── DB HELPERS ───────────────────────────────────────────────────────────────
async function ensureUser(id, lang = 'es') {
  await query(
    `INSERT INTO users(id, lang) VALUES($1,$2)
     ON CONFLICT(id) DO NOTHING`,
    [id, lang]
  );
}

async function getUser(id) {
  const r = await query('SELECT * FROM users WHERE id=$1', [id]);
  return r.rows[0] || null;
}

async function getUserLang(id) {
  const r = await query('SELECT lang FROM users WHERE id=$1', [id]);
  return r.rows[0]?.lang || 'es';
}

async function setUserLang(id, lang) {
  await query('UPDATE users SET lang=$2 WHERE id=$1', [id, lang]);
}

async function getMonthTxs(userId, month, year) {
  const r = await query(
    `SELECT * FROM transactions
     WHERE user_id=$1
       AND EXTRACT(MONTH FROM tx_date)=$2
       AND EXTRACT(YEAR  FROM tx_date)=$3
     ORDER BY created_at ASC`,
    [userId, month + 1, year]          // month es 0-based en JS
  );
  return r.rows;
}

async function getAllTxs(userId) {
  const r = await query(
    `SELECT * FROM transactions WHERE user_id=$1 ORDER BY created_at ASC`,
    [userId]
  );
  return r.rows;
}

async function insertTx(tx) {
  await query(
    `INSERT INTO transactions(id, user_id, type, amount, description, category, account, tx_date)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tx.id, tx.userId, tx.type, tx.amount, tx.description, tx.category, tx.account, tx.date]
  );
}

async function deleteTxById(txId, userId) {
  await query('DELETE FROM transactions WHERE id=$1 AND user_id=$2', [txId, userId]);
}

async function getBudgets(userId) {
  const r = await query('SELECT category, amount FROM budgets WHERE user_id=$1', [userId]);
  const obj = {};
  r.rows.forEach(row => { obj[row.category] = parseFloat(row.amount); });
  return obj;
}

async function setBudget(userId, category, amount) {
  await query(
    `INSERT INTO budgets(user_id, category, amount) VALUES($1,$2,$3)
     ON CONFLICT(user_id, category) DO UPDATE SET amount=$3`,
    [userId, category, amount]
  );
}

async function getPending(userId) {
  const r = await query('SELECT tx_data FROM pending_tx WHERE user_id=$1', [userId]);
  return r.rows[0]?.tx_data || null;
}

async function setPending(userId, txData) {
  await query(
    `INSERT INTO pending_tx(user_id, tx_data) VALUES($1,$2)
     ON CONFLICT(user_id) DO UPDATE SET tx_data=$2, created_at=NOW()`,
    [userId, JSON.stringify(txData)]
  );
}

async function clearPending(userId) {
  await query('DELETE FROM pending_tx WHERE user_id=$1', [userId]);
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
function uid() {
  return `tx_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
}

function fmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                   'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const MONTHS_EN = ['January','February','March','April','May','June',
                   'July','August','September','October','November','December'];

const CAT_EMOJI = {
  comida:'🍽️', transporte:'🚗', servicios:'💡', salud:'🏥',
  entretenimiento:'🎬', ropa:'👕', educacion:'📚', salario:'💼',
  negocio:'🏪', inversion:'📈', prestamo:'🤝', ahorro:'💰', otro:'📦',
  food:'🍽️', transport:'🚗', health:'🏥', entertainment:'🎬',
  clothes:'👕', education:'📚', salary:'💼', business:'🏪', savings:'💰',
};
const ACC_EMOJI = { efectivo:'💵', banco:'🏦', tarjeta:'💳' };

function detectLang(msg = '') {
  const t = msg.toLowerCase();
  const esWords = ['gasté','gaste','pagué','pague','compré','compre','deposité','deposite',
    'cobré','cobre','recibí','recibi','ingresé','ingrese','sueldo','quincena','resumen',
    'cuentas','alertas','historial','presupuesto','ayuda','hola','gracias','si','sí','buenos'];
  return esWords.some(w => t.includes(w)) ? 'es' : 'en';
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
const MSG = {
  welcome: (id, lang) => lang === 'es'
    ? `👋 *¡Bienvenido a MisCuentas!*\n\n🎉 Ya puedes registrar tus finanzas.\n\nTu Telegram ID: \`${id}\`\nÚsalo para entrar al panel web.\n\nEnvía *ayuda* para ver los comandos.`
    : `👋 *Welcome to MisCuentas!*\n\n🎉 Start tracking your finances now.\n\nYour Telegram ID: \`${id}\`\nUse it to log in to the web panel.\n\nSend *help* for all commands.`,

  miid: (id, lang) => lang === 'es'
    ? `🪪 *Tu Telegram ID:*\n\n\`${id}\`\n\nÚsalo para entrar al panel web.`
    : `🪪 *Your Telegram ID:*\n\n\`${id}\`\n\nUse it to log in to the web panel.`,

  recorded: (tx, lang) => {
    const catE  = CAT_EMOJI[tx.category] || '📦';
    const accE  = ACC_EMOJI[tx.account]  || '💵';
    const arrow = tx.type === 'ingreso' ? '▲' : '▼';
    return lang === 'es'
      ? `✅ *Registrado*\n\n${arrow} ${catE} ${tx.description}\n💰 ${fmt(tx.amount)}\n${accE} ${tx.account}`
      : `✅ *Recorded*\n\n${arrow} ${catE} ${tx.description}\n💰 ${fmt(tx.amount)}\n${accE} ${tx.account}`;
  },

  receiptPreview: (tx, lang) => lang === 'es'
    ? `🧾 *Factura detectada*\n\n📍 ${tx.description}\n💰 ${fmt(tx.amount)}\n${CAT_EMOJI[tx.category]||'📦'} ${tx.category}\n\n✅ Responde *si* para confirmar\n❌ Responde *no* para cancelar\n💡 Para cambiar cuenta: *si banco* o *si tarjeta*`
    : `🧾 *Receipt detected*\n\n📍 ${tx.description}\n💰 ${fmt(tx.amount)}\n${CAT_EMOJI[tx.category]||'📦'} ${tx.category}\n\n✅ Reply *yes* to confirm\n❌ Reply *no* to cancel\n💡 To change account: *yes bank* or *yes card*`,

  noPending  : (lang) => lang === 'es' ? '❌ No hay transacción pendiente.'  : '❌ No pending transaction.',
  cancelled  : (lang) => lang === 'es' ? '❌ Cancelado.'                     : '❌ Cancelled.',
  notUnderstood: (lang) => lang === 'es'
    ? `🤔 No entendí ese mensaje.\n\nEnvía *ayuda* para ver los comandos.\n\nEjemplos:\n• gasté 350 en comida\n• pagué la luz 1200 con banco\n• deposité el sueldo 28000\n• 📷 Envía una foto de factura`
    : `🤔 I didn't understand that.\n\nSend *help* to see commands.\n\nExamples:\n• spent 50 on food\n• paid rent 800 with bank\n• received salary 2000\n• 📷 Send a receipt photo`,

  help: (lang) => lang === 'es'
    ? `📖 *MisCuentas — Comandos*\n\n💰 *Consultas:*\n• resumen — Balance del mes\n• cuentas — Por cuenta\n• alertas — Alertas financieras\n• historial — Últimos movimientos\n• presupuesto — Ver límites\n\n📝 *Registrar:*\n• gasté 350 en comida\n• pagué la luz 1200 con banco\n• deposité el sueldo 28000\n\n📷 *Facturas:*\n• Envía una foto de factura\n\n📊 *Presupuestos:*\n• presupuesto comida 5000\n\n🪪 *Mi ID:* /miid`
    : `📖 *MisCuentas — Commands*\n\n💰 *Queries:*\n• summary / resumen\n• accounts / cuentas\n• alerts / alertas\n• history / historial\n• budget / presupuesto\n\n📝 *Record:*\n• spent 50 on food\n• paid rent 800 with bank\n• received salary 2000\n\n📷 *Receipts:*\n• Send a photo of any receipt\n\n📊 *Budgets:*\n• budget food 500\n\n🪪 *My ID:* /miid`,

  noGroq   : (lang) => lang === 'es' ? '❌ El análisis de fotos no está configurado.' : '❌ Photo analysis is not configured.',
  analyzing: (lang) => lang === 'es' ? '🔄 *Analizando factura...*'                  : '🔄 *Analyzing receipt...*',
  photoError: (lang) => lang === 'es' ? '❌ No pude analizar la imagen. Intenta con una foto más clara.' : '❌ Could not analyze the image. Try a clearer photo.',
  generalError: (lang) => lang === 'es' ? '❌ Ocurrió un error. Intenta de nuevo.' : '❌ An error occurred. Please try again.',
};

// ─── GROQ VISION ──────────────────────────────────────────────────────────────
async function analyzeReceipt(base64, mimeType) {
  if (!GROQ_API_KEY) return null;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method : 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body   : JSON.stringify({
        model   : 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Analyze this receipt. Reply ONLY with valid JSON on one line, no markdown:\n{"success":true,"amount":NUMBER,"description":"STORE_NAME","category":"CATEGORY"}\nCATEGORY must be one of: comida,transporte,servicios,salud,entretenimiento,ropa,educacion,negocio,otro\nIf not a receipt reply: {"success":false}' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ]}],
        temperature: 0,
        max_tokens : 150,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const d   = await r.json();
    if (d.error) { console.error('Groq error:', d.error.message); return null; }
    const raw = d.choices?.[0]?.message?.content?.trim() || '';
    const m   = raw.match(/\{[^{}]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (e) { console.error('analyzeReceipt:', e.message); return null; }
}

// ─── GEMINI AI PARSER ─────────────────────────────────────────────────────────
async function parseWithAI(message) {
  if (!GEMINI_API_KEY) return null;
  const prompt = `You are a personal finance assistant. Parse this message and respond ONLY with valid JSON on one line, no markdown.

Message: "${message}"

Format: {"type":"ingreso|egreso|comando","amount":number_or_null,"desc":"text","cat":"category","account":"efectivo|banco|tarjeta","cmd":null,"budget_cat":null,"budget_amount":null}

Categories: comida, transporte, servicios, salud, entretenimiento, ropa, educacion, salario, negocio, inversion, prestamo, ahorro, otro

Rules:
- tarjeta/card/credit → account: tarjeta
- banco/bank/transfer/deposito → account: banco
- no mention → account: efectivo
- income words (received,earned,deposited,salary,cobré,ingresé,recibí,deposité,sueldo,quincena) → type:ingreso
- expense words (spent,paid,bought,gasté,pagué,compré) → type:egreso
- commands: resumen/summary, cuentas/accounts, alertas/alerts, historial/history, presupuesto/budget, ayuda/help, miid → type:comando, cmd:command_name
- "budget/presupuesto X 500" → type:comando, cmd:set_budget, budget_cat:X, budget_amount:500
- yes/si/confirm + optional account → type:comando, cmd:confirmar, account: parsed_account_or_efectivo
- no/cancel → type:comando, cmd:cancelar`;

  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_API_KEY}`,
      {
        method : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body   : JSON.stringify({
          contents         : [{ parts: [{ text: prompt }] }],
          generationConfig : { temperature: 0.1, maxOutputTokens: 200 },
        }),
        signal: AbortSignal.timeout(15000),
      }
    );
    const d    = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim()
                   .replace(/```json|```/g, '').trim();
    if (!text) return null;
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch { return null; }
}

// ─── FALLBACK PARSER ──────────────────────────────────────────────────────────
const CAT_KW = {
  comida         : ['food','comida','almuerzo','desayuno','cena','restaurant','mercado','colmado','pizza','pollo','supermercado','grocery','lunch','dinner','breakfast'],
  transporte     : ['transport','transporte','gas','gasolina','taxi','uber','carro','bus','car','fuel','metro'],
  servicios      : ['luz','agua','internet','telefono','phone','netflix','spotify','cable','electric','water','service'],
  salud          : ['salud','health','medico','doctor','farmacia','pharmacy','medicina','hospital','dentista'],
  entretenimiento: ['entertainment','entretenimiento','cine','movie','fiesta','party','bar','viaje','hotel','travel'],
  ropa           : ['ropa','clothes','zapatos','shoes','camisa','shirt','tienda','store'],
  educacion      : ['school','escuela','universidad','university','libro','book','curso','course'],
  salario        : ['salary','salario','sueldo','quincena','nomina','payroll'],
  negocio        : ['business','negocio','venta','sale','cliente','client'],
  inversion      : ['investment','inversion','dividendo','dividend','stocks'],
  ahorro         : ['savings','ahorro','fondo','fund'],
  prestamo       : ['loan','prestamo','deuda','debt'],
};
const INC_VERBS = ['ingresé','ingrese','recibí','recibi','gané','gane','cobré','cobre',
                   'deposité','deposite','entró','entro','quincena','sueldo','salario',
                   'received','earned','got paid','deposited','salary','income'];
const EXP_VERBS = ['gasté','gaste','pagué','pague','compré','compre',
                   'spent','paid','bought','me costó','me costo','purchased'];

function detectCat(t) {
  for (const [c, kws] of Object.entries(CAT_KW)) if (kws.some(k => t.includes(k))) return c;
  return 'otro';
}
function detectAcc(t) {
  if (['tarjeta','card','credit','debit','credito','debito'].some(k => t.includes(k))) return 'tarjeta';
  if (['banco','bank','transfer','transferencia','deposito','deposit'].some(k => t.includes(k))) return 'banco';
  return 'efectivo';
}

function fallbackParse(msg) {
  const t = msg.trim().toLowerCase().replace(/^\//, '');
  const CMDS = {
    resumen:'resumen', balance:'resumen', summary:'resumen', hoy:'resumen',
    alertas:'alertas', alerts:'alertas',
    ayuda:'ayuda', help:'ayuda', start:'ayuda',
    'ver cuentas':'ver_cuentas', cuentas:'ver_cuentas', accounts:'ver_cuentas',
    presupuesto:'presupuesto', budget:'presupuesto',
    historial:'historial', history:'historial',
    miid:'miid',
    si:'confirmar', sí:'confirmar', yes:'confirmar', confirm:'confirmar',
    no:'cancelar', cancel:'cancelar',
  };
  if (CMDS[t]) return { type: 'comando', cmd: CMDS[t] };

  // presupuesto comida 5000
  const bm = t.match(/(?:presupuesto|budget)\s+(\w+)\s+(\d+(?:[.,]\d+)?)/);
  if (bm) return { type:'comando', cmd:'set_budget', budget_cat:bm[1], budget_amount:parseFloat(bm[2].replace(',','.')) };

  // si banco / yes card
  const confirmAcc = t.match(/^(?:si|sí|yes|confirm)\s+(banco|bank|tarjeta|card|efectivo|cash)$/);
  if (confirmAcc) return { type:'comando', cmd:'confirmar', account: detectAcc(confirmAcc[1]) };

  const am = t.match(/(\d+(?:[.,]\d+)?)/);
  if (!am) return null;
  const amount = parseFloat(am[1].replace(',', '.'));
  if (!amount || amount <= 0) return null;

  const hasInc = INC_VERBS.some(v => t.includes(v));
  const hasExp = EXP_VERBS.some(v => t.includes(v));
  let type;
  if (hasInc && !hasExp) type = 'ingreso';
  else if (hasExp) type = 'egreso';
  else {
    const np = t.match(/\d+(?:[.,]\d+)?\s+(?:en|de|para|for|on)\s+(.+)/i);
    if (np) return { type:'egreso', amount, desc:np[1].trim(), cat:detectCat(np[1]+' '+t), account:detectAcc(t) };
    return null;
  }

  let desc = t
    .replace(/\d+(?:[.,]\d+)?/g, '')
    .replace(/\b(el|la|los|las|un|una|de|del|con|al|en|por|para|a|mi|the|a|an|for|on|at|in|with|from)\b/gi, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!desc || desc.length < 2) {
    if (t.includes('quincena')) desc = 'Quincena';
    else if (t.includes('sueldo') || t.includes('salary')) desc = 'Salary';
    else desc = type === 'ingreso' ? 'Income' : 'Expense';
  }
  desc = desc.charAt(0).toUpperCase() + desc.slice(1);
  return { type, amount, desc, cat: detectCat(t), account: detectAcc(t) };
}

// ─── MESSAGE HANDLER ──────────────────────────────────────────────────────────
async function handleText(msgText, chatId) {
  const id  = String(chatId);
  const msg = msgText.trim();
  const now = new Date();

  // Obtener o crear usuario
  let user = await getUser(id);
  if (!user) {
    const lang = detectLang(msg);
    await ensureUser(id, lang);
    user = { id, lang };
    await sendMessage(chatId, MSG.welcome(id, lang));
    return;
  }

  const lang = user.lang || 'es';

  // /miid o miid
  if (/^\/miid$|^miid$/i.test(msg)) {
    await sendMessage(chatId, MSG.miid(id, lang));
    return;
  }

  const parsed = await parseWithAI(msg) || fallbackParse(msg);

  // ── CONFIRMAR (foto pendiente) ──
  if (parsed?.cmd === 'confirmar') {
    const pending = await getPending(id);
    if (!pending) { await sendMessage(chatId, MSG.noPending(lang)); return; }
    // Cambiar cuenta si se especificó
    if (parsed.account && parsed.account !== 'efectivo') pending.account = parsed.account;
    const tx = { ...pending, userId: id };
    await insertTx(tx);
    await clearPending(id);
    await sendMessage(chatId, MSG.recorded(tx, lang));
    return;
  }

  // ── CANCELAR ──
  if (parsed?.cmd === 'cancelar') {
    const pending = await getPending(id);
    if (pending) { await clearPending(id); await sendMessage(chatId, MSG.cancelled(lang)); }
    else { await sendMessage(chatId, MSG.noPending(lang)); }
    return;
  }

  if (!parsed) { await sendMessage(chatId, MSG.notUnderstood(lang)); return; }

  const { cmd } = parsed;
  const month = now.getMonth();
  const year  = now.getFullYear();

  // ── MIID ──
  if (cmd === 'miid') { await sendMessage(chatId, MSG.miid(id, lang)); return; }

  // ── RESUMEN ──
  if (cmd === 'resumen') {
    const txs = await getMonthTxs(id, month, year);
    const inc = txs.filter(t => t.type === 'ingreso').reduce((s, t) => s + parseFloat(t.amount), 0);
    const exp = txs.filter(t => t.type === 'egreso').reduce((s, t)  => s + parseFloat(t.amount), 0);
    const bal = inc - exp;
    const MN  = lang === 'es' ? MONTHS_ES : MONTHS_EN;
    const text = lang === 'es'
      ? `💰 *Resumen — ${MN[month]} ${year}*\n\n▲ Ingresos: *${fmt(inc)}*\n▼ Egresos: *${fmt(exp)}*\n\n${bal >= 0 ? '✅' : '🚨'} Balance: *${fmt(bal)}*\n\n_${txs.length} movimiento(s)_`
      : `💰 *Summary — ${MN[month]} ${year}*\n\n▲ Income: *${fmt(inc)}*\n▼ Expenses: *${fmt(exp)}*\n\n${bal >= 0 ? '✅' : '🚨'} Balance: *${fmt(bal)}*\n\n_${txs.length} transaction(s)_`;
    await sendMessage(chatId, text);
    return;
  }

  // ── CUENTAS ──
  if (cmd === 'ver_cuentas') {
    const txs  = await getMonthTxs(id, month, year);
    const MN   = lang === 'es' ? MONTHS_ES : MONTHS_EN;
    const lines = ['efectivo','banco','tarjeta'].map(acc => {
      const inc = txs.filter(t => t.type==='ingreso' && t.account===acc).reduce((s,t) => s+parseFloat(t.amount), 0);
      const exp = txs.filter(t => t.type==='egreso'  && t.account===acc).reduce((s,t) => s+parseFloat(t.amount), 0);
      return `${ACC_EMOJI[acc]} *${acc}*\n   ▲ ${fmt(inc)}  ▼ ${fmt(exp)}\n   Balance: ${fmt(inc-exp)}`;
    });
    await sendMessage(chatId, lang === 'es'
      ? `🏦 *Cuentas — ${MN[month]}*\n\n${lines.join('\n\n')}`
      : `🏦 *Accounts — ${MN[month]}*\n\n${lines.join('\n\n')}`);
    return;
  }

  // ── ALERTAS ──
  if (cmd === 'alertas') {
    const txs     = await getMonthTxs(id, month, year);
    const budgets = await getBudgets(id);
    const inc = txs.filter(t => t.type==='ingreso').reduce((s,t) => s+parseFloat(t.amount), 0);
    const exp = txs.filter(t => t.type==='egreso').reduce((s,t)  => s+parseFloat(t.amount), 0);
    const alerts = [];
    if (inc > 0) {
      const pct = (exp / inc) * 100;
      if (pct >= 100) alerts.push(`🚨 Egresos superaron ingresos (${pct.toFixed(0)}%)`);
      else if (pct >= 80) alerts.push(`⚠️ Gastaste el ${pct.toFixed(0)}% de tus ingresos`);
      else alerts.push(`✅ Finanzas saludables (${pct.toFixed(0)}% gastado)`);
    }
    for (const [cat, limit] of Object.entries(budgets)) {
      const spent = txs.filter(t => t.type==='egreso' && t.category===cat).reduce((s,t) => s+parseFloat(t.amount), 0);
      const pct   = (spent / limit) * 100;
      const e     = CAT_EMOJI[cat] || '📦';
      if (pct >= 100) alerts.push(`🚨 ${e} ${cat}: SUPERADO (${fmt(spent)})`);
      else if (pct >= 80) alerts.push(`⚠️ ${e} ${cat}: ${pct.toFixed(0)}% usado`);
    }
    const MN = lang === 'es' ? MONTHS_ES : MONTHS_EN;
    await sendMessage(chatId, lang === 'es'
      ? `🔔 *Alertas — ${MN[month]}*\n\n${alerts.join('\n') || 'Sin alertas ✅'}`
      : `🔔 *Alerts — ${MN[month]}*\n\n${alerts.join('\n') || 'No alerts ✅'}`);
    return;
  }

  // ── HISTORIAL ──
  if (cmd === 'historial') {
    const txs = await getMonthTxs(id, month, year);
    const MN  = lang === 'es' ? MONTHS_ES : MONTHS_EN;
    const last5 = [...txs].reverse().slice(0, 5);
    if (!last5.length) {
      await sendMessage(chatId, lang === 'es' ? `📭 Sin movimientos en ${MN[month]}` : `📭 No transactions in ${MN[month]}`);
      return;
    }
    const lines = last5.map(t =>
      `${t.type==='ingreso'?'▲':'▼'} ${CAT_EMOJI[t.category]||'📦'} ${t.description} — ${fmt(t.amount)}`
    );
    await sendMessage(chatId, lang === 'es'
      ? `📋 *Recientes — ${MN[month]}*\n\n${lines.join('\n')}`
      : `📋 *Recent — ${MN[month]}*\n\n${lines.join('\n')}`);
    return;
  }

  // ── PRESUPUESTO ──
  if (cmd === 'presupuesto') {
    const budgets = await getBudgets(id);
    const txs     = await getMonthTxs(id, month, year);
    const MN      = lang === 'es' ? MONTHS_ES : MONTHS_EN;
    if (!Object.keys(budgets).length) {
      await sendMessage(chatId, lang === 'es'
        ? `📊 *Sin presupuestos.*\n\nCrea uno:\n• presupuesto comida 5000`
        : `📊 *No budgets set.*\n\nCreate one:\n• budget food 500`);
      return;
    }
    const lines = Object.entries(budgets).map(([cat, limit]) => {
      const spent = txs.filter(t => t.type==='egreso' && t.category===cat).reduce((s,t) => s+parseFloat(t.amount), 0);
      const pct   = Math.min(100, (spent / limit) * 100);
      const bar   = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
      return `${CAT_EMOJI[cat]||'📦'} ${cat}\n   ${bar} ${pct.toFixed(0)}%\n   ${fmt(spent)} / ${fmt(limit)}`;
    });
    await sendMessage(chatId, lang === 'es'
      ? `📊 *Presupuestos — ${MN[month]}*\n\n${lines.join('\n\n')}`
      : `📊 *Budgets — ${MN[month]}*\n\n${lines.join('\n\n')}`);
    return;
  }

  // ── SET_BUDGET ──
  if (cmd === 'set_budget') {
    if (!parsed.budget_cat || !parsed.budget_amount || parsed.budget_amount <= 0) {
      await sendMessage(chatId, lang === 'es' ? '❌ Ejemplo: presupuesto comida 5000' : '❌ Example: budget food 500');
      return;
    }
    await setBudget(id, parsed.budget_cat, parsed.budget_amount);
    await sendMessage(chatId, lang === 'es'
      ? `✅ Presupuesto:\n\n${CAT_EMOJI[parsed.budget_cat]||'📦'} *${parsed.budget_cat}*: ${fmt(parsed.budget_amount)}/mes`
      : `✅ Budget set:\n\n${CAT_EMOJI[parsed.budget_cat]||'📦'} *${parsed.budget_cat}*: ${fmt(parsed.budget_amount)}/month`);
    return;
  }

  // ── AYUDA ──
  if (cmd === 'ayuda') { await sendMessage(chatId, MSG.help(lang)); return; }

  // ── TRANSACCIÓN ──
  if (parsed.type === 'ingreso' || parsed.type === 'egreso') {
    const tx = {
      id         : uid(),
      userId     : id,
      type       : parsed.type,
      amount     : parsed.amount,
      description: parsed.desc || (parsed.type === 'ingreso' ? 'Income' : 'Expense'),
      category   : parsed.cat  || 'otro',
      account    : parsed.account || 'efectivo',
      date       : now.toISOString().split('T')[0],
    };
    await insertTx(tx);
    // Update lang detection
    const detectedLang = detectLang(msg);
    if (detectedLang !== lang) await setUserLang(id, detectedLang);
    await sendMessage(chatId, MSG.recorded(tx, lang));
    return;
  }

  await sendMessage(chatId, MSG.notUnderstood(lang));
}

async function handlePhoto(msg, chatId) {
  const id   = String(chatId);
  const user = await getUser(id);
  const lang = user?.lang || 'es';

  if (!GROQ_API_KEY) { await sendMessage(chatId, MSG.noGroq(lang)); return; }

  try {
    const photo = msg.photo?.[msg.photo.length - 1];
    if (!photo) { await sendMessage(chatId, MSG.photoError(lang)); return; }

    await sendMessage(chatId, MSG.analyzing(lang));

    const link = await getFileLink(photo.file_id);
    const res  = await fetch(link, { signal: AbortSignal.timeout(15000) });
    const buf  = await res.arrayBuffer();
    const b64  = Buffer.from(buf).toString('base64');
    const mime = link.endsWith('.png') ? 'image/png' : 'image/jpeg';

    const result = await analyzeReceipt(b64, mime);
    if (!result?.success) { await sendMessage(chatId, MSG.photoError(lang)); return; }

    const now = new Date();
    const tx  = {
      id         : uid(),
      type       : 'egreso',
      amount     : result.amount,
      description: result.description || 'Receipt',
      category   : result.category    || 'otro',
      account    : 'efectivo',
      date       : now.toISOString().split('T')[0],
    };
    await ensureUser(id, lang);
    await setPending(id, tx);
    await sendMessage(chatId, MSG.receiptPreview(tx, lang));
  } catch (e) {
    console.error('handlePhoto:', e.message);
    await sendMessage(chatId, MSG.photoError(lang));
  }
}

// ─── RESUMEN SEMANAL ──────────────────────────────────────────────────────────
async function sendWeeklySummaries() {
  const now   = new Date();
  const month = now.getMonth();
  const year  = now.getFullYear();

  const usersRes = await query('SELECT id, lang FROM users');
  let sent = 0;

  for (const user of usersRes.rows) {
    try {
      const txs = await getMonthTxs(user.id, month, year);
      if (!txs.length) continue;

      const inc = txs.filter(t => t.type==='ingreso').reduce((s,t) => s+parseFloat(t.amount), 0);
      const exp = txs.filter(t => t.type==='egreso').reduce((s,t)  => s+parseFloat(t.amount), 0);
      const bal = inc - exp;
      const MN  = user.lang === 'es' ? MONTHS_ES : MONTHS_EN;

      // Top 3 categorías de gasto
      const byCat = {};
      txs.filter(t => t.type==='egreso').forEach(t => {
        byCat[t.category] = (byCat[t.category] || 0) + parseFloat(t.amount);
      });
      const top3 = Object.entries(byCat)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cat, amt]) => `  ${CAT_EMOJI[cat]||'📦'} ${cat}: ${fmt(amt)}`)
        .join('\n');

      const msg = user.lang === 'es'
        ? `📊 *Resumen Semanal — ${MN[month]} ${year}*\n\n▲ Ingresos: *${fmt(inc)}*\n▼ Egresos: *${fmt(exp)}*\n${bal>=0?'✅':'🚨'} Balance: *${fmt(bal)}*\n\n🏆 *Top gastos:*\n${top3||'  Sin gastos'}\n\n_${txs.length} movimiento(s) este mes_`
        : `📊 *Weekly Summary — ${MN[month]} ${year}*\n\n▲ Income: *${fmt(inc)}*\n▼ Expenses: *${fmt(exp)}*\n${bal>=0?'✅':'🚨'} Balance: *${fmt(bal)}*\n\n🏆 *Top expenses:*\n${top3||'  No expenses'}\n\n_${txs.length} transaction(s) this month_`;

      await sendMessage(user.id, msg);
      sent++;
      await new Promise(r => setTimeout(r, 50)); // rate-limit amigable
    } catch (e) {
      console.error(`Weekly summary error for ${user.id}:`, e.message);
    }
  }
  return sent;
}

// ─── WEBHOOK HANDLER ──────────────────────────────────────────────────────────
app.post(`/webhook/:secret`, async (req, res) => {
  // Validar secret para evitar llamadas no autorizadas
  if (req.params.secret !== (WEBHOOK_SECRET || 'tg')) {
    return res.sendStatus(403);
  }
  res.sendStatus(200); // Responder inmediatamente a Telegram

  const update = req.body;

  // Log para debug — ver qué llega de Telegram
  console.log('Webhook received:', JSON.stringify(update).substring(0, 300));

  const msg    = update?.message;
  if (!msg) {
    //可能是callback_query或其他类型的update
    console.log('No message in update, type:', update.update_id ? 'id:' + update.update_id : 'unknown');
    return;
  }

  // ── Handle deep link: t.me/Miscuentasrdbot/miscuentas?start=TOKEN ────────────
  // When user clicks START, Telegram sends a callback_query with data containing the start parameter
  const cq = update?.callback_query;
  if (cq) {
    const chatId = String(cq.from.id);
    const data   = cq.data || '';

    // data looks like "start=TG_TOKEN" or just "start" — extract the token
    let authToken = null;
    let isDeepLink = false;
    if (data.startsWith('start=')) {
      authToken = data.replace('start=', '').trim();
      isDeepLink = true;
    } else if (data.startsWith('tg_')) {
      authToken = data;
      isDeepLink = true;
    }

    // Answer the callback query to remove loading state in Telegram
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cq.id }),
      }).catch(() => {});
    } catch(e) { /* ignore */ }

    if (isDeepLink && authToken) {
      // Deep link with token — save to DB
      try {
        await ensureUser(chatId, 'es');
        await createAuthToken(authToken, chatId);
        const lang = await getUserLang(chatId);
        await sendMessage(chatId, lang === 'es'
          ? `✅ ¡Cuenta conectada! Tu ID es:\n\n${chatId}\n\n📋 Cópialo y pégalo en la web.`
          : `✅ Account connected! Your ID:\n\n${chatId}\n\n📋 Copy and paste on the web.`
        );
      } catch(e) {
        console.error('Telegram OAuth callback error:', e.message);
      }
    } else {
      // Plain START click — just send welcome message with ID
      try {
        await ensureUser(chatId, 'es');
        const lang = await getUserLang(chatId);
        await sendMessage(chatId, lang === 'es'
          ? `👋 ¡Bienvenido a MisCuentas!\n\nTu Telegram ID:\n\n${chatId}\n\n📋 Cópialo y pégalo en la web para iniciar sesión.\n\n💰 MisCuentas — Finanzas Personales 💰`
          : `👋 Welcome to MisCuentas!\n\nYour Telegram ID:\n\n${chatId}\n\n📋 Copy and paste on the web to log in.\n\n💰 MisCuentas — Personal Finance 💰`
        );
      } catch(e) {
        console.error('Telegram welcome error:', e.message);
      }
    }
    return;
  }

  const chatId = msg.chat.id;
  const text   = msg.text || '';

  // ── TELEGRAM OAUTH: /start tg_xxx or /start miscuentas?start=tg_xxx ────────
  // Handles both: t.me/Miscuentasrdbot?start=tg_xxx  AND  t.me/Miscuentasrdbot/miscuentas?start=tg_xxx
  let authToken = null;
  if (text.startsWith('/start tg_')) {
    authToken = text.replace('/start tg_', '').trim();
  } else if (text.startsWith('/start miscuentas?start=')) {
    authToken = text.replace('/start miscuentas?start=', '').trim();
  } else if (/^\/start miscuentas$/.test(text)) {
    // Bot was opened from t.me/Miscuentasrdbot/miscuentas without a token — redirect to bot
    await sendMessage(chatId, '👋 Usa el botón de "Iniciar con Telegram" en la web para conectar tu cuenta.\n\nO envía /start nuevamente con un token válido.');
    return;
  }
  if (authToken) {
    try {
      // Generar session token para el usuario
      await ensureUser(String(chatId), 'es');

      // Guardar token en DB (persiste aunque Railway se reinicie)
      await createAuthToken(authToken, String(chatId));

      // Responder al usuario
      const lang = await getUserLang(String(chatId));
      await sendMessage(chatId, lang === 'es'
        ? '✅ ¡Cuenta conectada! Puedes volver a la web. Bienvenido a MisCuentas 💰'
        : '✅ Account connected! You can go back to the web. Welcome to MisCuentas 💰'
      );
    } catch(e) {
      console.error('Telegram OAuth error:', e.message);
    }
    return;
  }

  try {
    if (msg.photo?.length > 0) {
      await handlePhoto(msg, chatId);
    } else if (msg.text) {
      await handleText(msg.text, chatId);
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    try { await sendMessage(chatId, MSG.generalError('es')); } catch {}
  }
});

// ─── REST API (para el frontend en GitHub Pages) ──────────────────────────────
const ALLOWED_ORIGINS = [
  'https://stiwall.github.io',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-session-token');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── TELEGRAM OAUTH ────────────────────────────────────────────────────────────

// Página que ve el usuario al abrir el deep link desde Telegram
app.get('/miscuentas', (req, res) => {
  const { start } = req.query;
  if (!start || !start.startsWith('tg_')) {
    return res.redirect('https://t.me/Miscuentasrdbot');
  }
  const base = API_BASE || `https://${req.headers.host}`;
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Conectando...</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #080d1a; color: #eeeef8; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; text-align: center; }
    .container { padding: 24px; }
    h2 { color: #00e5a0; font-size: 24px; margin-bottom: 12px; }
    p  { color: #a0a0c0; font-size: 16px; }
    .spinner { font-size: 48px; animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner">⏳</div>
    <h2>Conectando tu cuenta...</h2>
    <p>Espera un momento</p>
  </div>
  <script>
    // Notify server we're here, then poll until auth is confirmed or timeout
    const token = '${start}';
    let attempts = 0;
    const maxAttempts = 15;

    function updateStatus(msg) {
      const p = document.querySelector('p');
      if (p) p.textContent = msg;
    }

    function poll() {
      attempts++;
      fetch('${base}/auth-status?token=' + token)
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            document.querySelector('h2').textContent = '✅ ¡Conectado!';
            updateStatus('Ya puedes cerrar esta ventana');
            setTimeout(() => window.close(), 1500);
          } else if (attempts < maxAttempts) {
            updateStatus('Esperando... (' + attempts + '/' + maxAttempts + ')');
            setTimeout(poll, 1000);
          } else {
            document.querySelector('h2').textContent = '⏳ Procesando';
            updateStatus('El servidor está procesando. Puedes cerrar esta ventana.');
            setTimeout(() => window.close(), 2000);
          }
        })
        .catch(() => {
          if (attempts < maxAttempts) {
            setTimeout(poll, 1000);
          } else {
            document.querySelector('h2').textContent = '⚠️ Listo';
            updateStatus('Cierra esta ventana y vuelve a la app');
            setTimeout(() => window.close(), 2000);
          }
        });
    }

    // Initial notification
    fetch('${base}/api/telegram-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token })
    }).catch(() => {});

    // Start polling after a short delay (give Telegram time to send webhook)
    setTimeout(poll, 2000);
  </script>
</body>
</html>`);
});

// Endpoint que la página miscuentas llama al abrirse ( Deep link mini-app )
// El token ya fue guardado por el webhook cuando el usuario clickeó START
app.post('/api/telegram-auth', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  res.json({ ok: true, pending: true });
});

// Polling endpoint — la web consulta si el token fue completado
app.get('/auth-status', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const result = await consumeAuthToken(token);

  if (!result) {
    // Token no existe o expiró
    return res.json({ pending: false, ok: false, expired: true });
  }

  // Token consumido y eliminado (de DB) — retornamos los datos
  res.json({
    ok: true,
    telegram_id: result.telegram_id,
    token: result.session_token
  });
});

app.get('/', (_, res) => res.json({ status: 'ok', service: 'MisCuentas v2', uptime: Math.floor(process.uptime()) }));
app.get('/health', (_, res) => res.json({ status: 'healthy', groq: !!GROQ_API_KEY, gemini: !!GEMINI_API_KEY }));

// Login / upsert de usuario — devuelve token de sesión
app.post('/api/login', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'id required' });
    const id = String(phone);
    await ensureUser(id, 'es');
    const token = generateToken(id);
    res.json({ ok: true, token, userId: id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET datos del usuario — requiere token válido
app.get('/api/data/:id', authMiddleware, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    // Solo puede ver sus propios datos
    if (req.userId !== id) return res.status(403).json({ error: 'forbidden' });
    await ensureUser(id);
    const txs     = await getAllTxs(id);
    const budgets = await getBudgets(id);
    const normalized = txs.map(t => ({
      id       : t.id,
      type     : t.type,
      amount   : parseFloat(t.amount),
      desc     : t.description,
      cat      : t.category,
      account  : t.account,
      date     : t.tx_date instanceof Date ? t.tx_date.toISOString().split('T')[0] : t.tx_date,
      timestamp: t.created_at,
    }));
    res.json({ transactions: normalized, budgets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST — requiere token válido
app.post('/api/data/:id', authMiddleware, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    if (req.userId !== id) return res.status(403).json({ error: 'forbidden' });
    const { transactions, budgets } = req.body;
    await ensureUser(id);

    if (Array.isArray(transactions)) {
      const existing = await query('SELECT id FROM transactions WHERE user_id=$1', [id]);
      const existingIds = new Set(existing.rows.map(r => String(r.id)));

      for (const t of transactions) {
        const txId = String(t.id || t.timestamp || '');
        if (!txId || existingIds.has(txId)) continue;
        await query(
          `INSERT INTO transactions(id, user_id, type, amount, description, category, account, tx_date)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING`,
          [txId, id, t.type, t.amount, t.desc || t.description || 'Transaction',
           t.cat || t.category || 'otro', t.account || 'efectivo',
           t.date || new Date().toISOString().split('T')[0]]
        );
      }
    }

    if (budgets && typeof budgets === 'object') {
      for (const [cat, amount] of Object.entries(budgets)) {
        if (amount > 0) await setBudget(id, cat, amount);
      }
    }

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE — requiere token válido
app.delete('/api/data/:id/tx/:txId', authMiddleware, async (req, res) => {
  try {
    const id = decodeURIComponent(req.params.id);
    if (req.userId !== id) return res.status(403).json({ error: 'forbidden' });
    const txId = req.params.txId;
    await deleteTxById(txId, id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resumen semanal (llamado por cron-job.org los lunes 7am RD)
app.post('/send-weekly', async (req, res) => {
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (CRON_SECRET && secret !== CRON_SECRET) return res.status(403).json({ error: 'forbidden' });
  try {
    const sent = await sendWeeklySummaries();
    res.json({ ok: true, sent });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Registro del webhook (llamar una vez desde Railway shell o al startup)
app.post('/setup-webhook', async (req, res) => {
  const secret = req.headers['x-setup-secret'] || req.query.secret;
  if (CRON_SECRET && secret !== CRON_SECRET) return res.status(403).json({ error: 'forbidden' });
  try {
    const base = req.body.base_url || `https://${req.headers.host}`;
    const r    = await setWebhook(base);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── INIT DB — crea tablas automáticamente si no existen ──────────────────────
async function initDB() {
  console.log('🗄️  Initializing database schema...');

  // Eliminar índice problemático si existe (de versiones anteriores)
  try {
    await query(`DROP INDEX IF EXISTS idx_tx_user_month`);
  } catch(e) { /* ignorar */ }

  // Tablas — cada una en try/catch para no fallar si ya existen con diferencias
  const tables = [
    `CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      registered  BOOLEAN NOT NULL DEFAULT TRUE,
      lang        TEXT NOT NULL DEFAULT 'es',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS transactions (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type        TEXT NOT NULL CHECK (type IN ('ingreso','egreso')),
      amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      description TEXT NOT NULL,
      category    TEXT NOT NULL DEFAULT 'otro',
      account     TEXT NOT NULL DEFAULT 'efectivo'
                  CHECK (account IN ('efectivo','banco','tarjeta')),
      tx_date     DATE NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `CREATE TABLE IF NOT EXISTS budgets (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category    TEXT NOT NULL,
      amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),
      PRIMARY KEY (user_id, category)
    )`,
    `CREATE TABLE IF NOT EXISTS pending_tx (
      user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      tx_data     JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,

    // Auth tokens para Telegram OAuth (tabla persistente, no se pierde en restart)
    `CREATE TABLE IF NOT EXISTS auth_tokens (
      token        TEXT PRIMARY KEY,
      telegram_id  TEXT NOT NULL,
      session_token TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ];

  for (const sql of tables) {
    try { await query(sql); }
    catch(e) { console.warn('Table warning (ignored):', e.message); }
  }

  // Índice simple — sin funciones, siempre IMMUTABLE
  try {
    await query(`CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, tx_date)`);
  } catch(e) { console.warn('Index warning (ignored):', e.message); }

  console.log('✅  Database schema ready');
}

// ─── START ────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await initDB();
  } catch (e) {
    console.error('❌  initDB failed:', e.message);
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n========================================`);
    console.log(`✅  MisCuentas v2 started`);
    console.log(`🌐  Port       : ${PORT}`);
    console.log(`🗄️  Database   : PostgreSQL (Railway)`);
    console.log(`📸  Vision     : ${GROQ_API_KEY   ? 'Groq ✅'   : '❌ GROQ_API_KEY missing'}`);
    console.log(`🧠  AI Parser  : ${GEMINI_API_KEY ? 'Gemini ✅' : 'Fallback only'}`);
    console.log(`🔔  Webhook    : POST /webhook/${WEBHOOK_SECRET || 'tg'}`);
    console.log(`========================================\n`);
  });
}

start();

process.on('SIGTERM', () => { pool.end(); process.exit(0); });
process.on('SIGINT',  () => { pool.end(); process.exit(0); });

