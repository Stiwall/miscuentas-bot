/**
 * MisCuentas — Personal Finance Bot Server
 * Hosting: Railway | Stack: Express + Telegram + Groq Vision + JSONBin
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

// ─── ENV ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const JSONBIN_KEY    = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN    = process.env.JSONBIN_BIN_ID;
const GEMINI_KEY     = process.env.GEMINI_API_KEY;
const GROQ_KEY       = process.env.GROQ_API_KEY;

['TELEGRAM_BOT_TOKEN','JSONBIN_API_KEY','JSONBIN_BIN_ID'].forEach(k => {
  if (!process.env[k]) { console.error(`❌ Missing: ${k}`); process.exit(1); }
});

const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN}`;

// ─── TELEGRAM ─────────────────────────────────────────────────────────────
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', err => {
  console.error('Polling error:', err.message);
  if (err.message?.includes('409')) {
    setTimeout(() => bot.stopPolling().then(() => setTimeout(() => bot.startPolling(), 2000)).catch(() => {}), 5000);
  }
});

// ─── IN-MEMORY ────────────────────────────────────────────────────────────
const pendingTx = {}; // { chatId: tx } awaiting confirmation

// ─── LANGUAGE ─────────────────────────────────────────────────────────────
const userLang = {}; // { chatId: 'es'|'en' }

const MONTHS_ES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
const MONTHS_EN = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function detectLang(msg) {
  const t = msg.toLowerCase();
  const esWords = ['gasté','gaste','pagué','pague','compré','compre','deposité','deposite','cobré','cobre','recibí','recibi','ingresé','ingrese','sueldo','quincena','resumen','cuentas','alertas','historial','presupuesto','ayuda','hola','gracias','si','sí','buenos'];
  return esWords.some(w => t.includes(w)) ? 'es' : 'en';
}

function getLang(chatId, msg) {
  if (!userLang[chatId]) {
    userLang[chatId] = detectLang(msg || '');
  }
  return userLang[chatId];
}

const MSG = {
  miid: (id, lang) => lang === 'es'
    ? `🪪 Tu Telegram ID:\n\n\\`${id}\\`\n\nÚsalo para entrar al panel web.`
    : `🪪 Your Telegram ID:\n\n\\`${id}\\`\n\nUse it to log in to the web panel.`,
  welcome: (id, lang) => lang === 'es'
    ? `👋 *¡Bienvenido a MisCuentas!*\n\n🎉 Ya puedes registrar tus finanzas.\n\nTu ID: \\`${id}\\`\n\nEnvía *ayuda* para ver los comandos.`
    : `👋 *Welcome to MisCuentas!*\n\n🎉 Start tracking your finances now.\n\nYour ID: \\`${id}\\`\n\nSend *help* for all commands.`,
  recorded: (p, lang) => lang === 'es'
    ? `✅ *Registrado*\n\n${p.emoji} ${p.desc}\n💰 ${p.amount}\n${p.accEmoji} ${p.account}`
    : `✅ *Recorded*\n\n${p.emoji} ${p.desc}\n💰 ${p.amount}\n${p.accEmoji} ${p.account}`,
  noPending: (lang) => lang === 'es' ? '❌ No hay transacción pendiente.' : '❌ No pending transaction.',
  cancelled: (lang) => lang === 'es' ? '❌ Cancelado.' : '❌ Cancelled.',
  nothingCancel: (lang) => lang === 'es' ? '❌ Nada que cancelar.' : '❌ Nothing to cancel.',
  notUnderstood: (lang) => lang === 'es'
    ? `🤔 No entendí ese mensaje.\n\nEnvía *ayuda* para ver los comandos.\n\nEjemplos:\n• gasté 350 en comida\n• pagué la luz 1200 con banco\n• deposité el sueldo 28000\n• 📷 Envía una foto de factura`
    : `🤔 I didn't understand that.\n\nSend *help* to see commands.\n\nExamples:\n• spent 50 on food\n• paid rent 800 with bank\n• received salary 2000\n• 📷 Send a receipt photo`,
  notRecognized: (lang) => lang === 'es'
    ? '🤔 Comando no reconocido. Envía *ayuda* para ver los comandos.'
    : '🤔 Command not recognized. Send *help* for all commands.',
  receipt: (tx, lang) => lang === 'es'
    ? `🧾 *Factura detectada*\n\n📍 ${tx.desc}\n💰 ${tx.amount}\n${tx.catEmoji} ${tx.cat}\n\n✅ Responde *si* para confirmar\n❌ Responde *no* para cancelar\n\n💡 Para cambiar cuenta: *si banco* o *si tarjeta*`
    : `🧾 *Receipt detected*\n\n📍 ${tx.desc}\n💰 ${tx.amount}\n${tx.catEmoji} ${tx.cat}\n\n✅ Reply *yes* to confirm\n❌ Reply *no* to cancel\n\n💡 To change account: *yes bank* or *yes card*`,
  noGroq: (lang) => lang === 'es' ? '❌ El procesamiento de facturas no está configurado.' : '❌ Receipt processing is not configured.',
  noPhoto: (lang) => lang === 'es' ? '❌ No pude obtener la imagen. Intenta de nuevo.' : '❌ Could not get the image. Please try again.',
  analyzing: (lang) => lang === 'es' ? '🔄 *Analizando factura...*' : '🔄 *Analyzing receipt...*',
  photoError: (lang) => lang === 'es' ? '❌ No pude analizar la imagen. Intenta con una foto más clara.' : '❌ Could not analyze the image. Try a clearer photo.',
  photoUnreadable: (lang) => lang === 'es' ? '❌ No pude leer la factura. Asegúrate que sea clara y legible.' : '❌ Could not read the receipt. Make sure it is clear and legible.',
  generalError: (lang) => lang === 'es' ? '❌ Ocurrió un error. Intenta de nuevo.' : '❌ An error occurred. Please try again.',
};

// ─── DATA ─────────────────────────────────────────────────────────────────

async function loadData() {
  try {
    const r = await fetch(`${JSONBIN_URL}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_KEY },
      signal: AbortSignal.timeout(10000)
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const { record } = await r.json();
    if (record?.transactions && !record?.users) return { users: {} }; // migrate old format
    return record?.users ? record : { users: {} };
  } catch (e) {
    console.error('loadData:', e.message);
    return { users: {} };
  }
}

async function saveData(data) {
  const r = await fetch(JSONBIN_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_KEY },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
}

function getUser(data, id) {
  if (!data.users[id]) data.users[id] = { registered: false, transactions: [], budgets: {}, pending: null };
  const u = data.users[id];
  if (!u.transactions) u.transactions = [];
  if (!u.budgets) u.budgets = {};
  if (!('registered' in u)) u.registered = true; // migrate
  return u;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────
function fmt(n) {
  return Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function uid() {
  return `bot_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
}

function getMonthTxs(txs, month, year) {
  return txs.filter(t => {
    try { const d = new Date(t.date + 'T00:00:00'); return d.getMonth()===month && d.getFullYear()===year; }
    catch { return false; }
  });
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const CAT_EMOJI = {
  comida:'🍽️', transporte:'🚗', servicios:'💡', salud:'🏥',
  entretenimiento:'🎬', ropa:'👕', educacion:'📚', salario:'💼',
  negocio:'🏪', inversion:'📈', prestamo:'🤝', ahorro:'💰', otro:'📦',
  food:'🍽️', transport:'🚗', health:'🏥', entertainment:'🎬',
  clothes:'👕', education:'📚', salary:'💼', business:'🏪', savings:'💰'
};
const ACC_EMOJI = { efectivo:'💵', banco:'🏦', tarjeta:'💳', cash:'💵', bank:'🏦', card:'💳' };

function send(chatId, text) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// ─── GROQ VISION ──────────────────────────────────────────────────────────
async function analyzeReceipt(base64, mimeType) {
  if (!GROQ_KEY) return null;
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({
        model: 'meta-llama/llama-4-scout-17b-16e-instruct',
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Analyze this receipt. Reply ONLY with JSON on one line: {"success":true,"amount":NUMBER,"description":"STORE_NAME","category":"CATEGORY"} where CATEGORY is one of: comida,transporte,servicios,salud,entretenimiento,ropa,educacion,negocio,otro. If not a receipt: {"success":false}' },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
        ]}],
        temperature: 0, max_tokens: 150
      }),
      signal: AbortSignal.timeout(30000)
    });
    const d = await r.json();
    if (d.error) { console.log('Groq error:', d.error.message); return null; }
    const raw = d.choices?.[0]?.message?.content?.trim() || '';
    const m = raw.match(/\{[^{}]*\}/);
    if (!m) { console.log('Groq no JSON:', raw.substring(0,100)); return null; }
    return JSON.parse(m[0]);
  } catch (e) { console.error('analyzeReceipt:', e.message); return null; }
}

async function getPhoto(msg) {
  try {
    const photo = msg.photo?.[msg.photo.length - 1];
    if (!photo) return null;
    const link = await bot.getFileLink(photo.file_id);
    const res = await fetch(link);
    const buf = await res.arrayBuffer();
    return { base64: Buffer.from(buf).toString('base64'), mimeType: link.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  } catch (e) { console.error('getPhoto:', e.message); return null; }
}

// ─── AI TEXT PARSER (Gemini) ───────────────────────────────────────────────
async function parseWithAI(message) {
  if (!GEMINI_KEY) return null;
  try {
    const prompt = `You are a personal finance assistant. Parse this message and respond ONLY with JSON on one line, no markdown.

Message: "${message}"

Format: {"type":"ingreso|egreso|comando","amount":number_or_null,"desc":"text","cat":"category","account":"efectivo|banco|tarjeta","cmd":null,"budget_cat":null,"budget_amount":null}

Categories: comida, transporte, servicios, salud, entretenimiento, ropa, educacion, salario, negocio, inversion, prestamo, ahorro, otro

Rules:
- tarjeta/card/credit → account: tarjeta
- banco/bank/transfer/deposito → account: banco  
- no mention → account: efectivo
- income words (received, earned, deposited, salary, cobré, ingresé, recibí, deposité, sueldo, quincena) → type: ingreso
- expense words (spent, paid, bought, gasté, pagué, compré) → type: egreso
- commands: resumen/summary, cuentas/accounts, alertas/alerts, historial/history, presupuesto/budget, ayuda/help, miid → type:comando, cmd: command_name
- "budget/presupuesto X 500" → type:comando, cmd:set_budget, budget_cat:X, budget_amount:500
- yes/si/confirm → type:comando, cmd:confirmar
- no/cancel → type:comando, cmd:cancelar`;

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 200 } }),
      signal: AbortSignal.timeout(15000)
    });
    const d = await r.json();
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text?.trim().replace(/```json|```/g,'').trim();
    if (!text) return null;
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch (e) { return null; }
}

// ─── FALLBACK PARSER ──────────────────────────────────────────────────────
const CAT_KW = {
  comida:          ['food','comida','almuerzo','desayuno','cena','restaurant','mercado','colmado','pizza','pollo','supermercado','grocery','lunch','dinner','breakfast'],
  transporte:      ['transport','transporte','gas','gasolina','taxi','uber','carro','bus','car','fuel','metro','subway'],
  servicios:       ['luz','agua','internet','telefono','phone','netflix','spotify','cable','electric','water','service'],
  salud:           ['salud','health','medico','doctor','farmacia','pharmacy','medicina','hospital','dentista'],
  entretenimiento: ['entertainment','entretenimiento','cine','movie','fiesta','party','bar','viaje','hotel','travel'],
  ropa:            ['ropa','clothes','zapatos','shoes','camisa','shirt','tienda','store'],
  educacion:       ['school','escuela','universidad','university','libro','book','curso','course'],
  salario:         ['salary','salario','sueldo','quincena','nomina','payroll'],
  negocio:         ['business','negocio','venta','sale','cliente','client','invoice'],
  inversion:       ['investment','inversion','dividendo','dividend','stocks'],
  ahorro:          ['savings','ahorro','fondo','fund'],
  prestamo:        ['loan','prestamo','deuda','debt'],
};
const INC_VERBS = ['ingresé','ingrese','recibí','recibi','gané','gane','cobré','cobre','deposité','deposite','entró','entro','quincena','sueldo','salario','received','earned','got paid','deposited','salary','income'];
const EXP_VERBS = ['gasté','gaste','pagué','pague','compré','compre','spent','paid','bought','fui al','fui a','me costó','me costo','purchased'];

function detectCat(t) { for (const [c,kws] of Object.entries(CAT_KW)) if (kws.some(k=>t.includes(k))) return c; return 'otro'; }
function detectAcc(t) {
  if (['tarjeta','card','credit','debit','credito','debito'].some(k=>t.includes(k))) return 'tarjeta';
  if (['banco','bank','transfer','transferencia','deposito','deposit'].some(k=>t.includes(k))) return 'banco';
  return 'efectivo';
}

function fallbackParse(msg) {
  const t = msg.trim().toLowerCase().replace(/^\//,'');
  const CMDS = {
    'resumen':'resumen','balance':'resumen','summary':'resumen','hoy':'resumen',
    'alertas':'alertas','alerts':'alertas',
    'ayuda':'ayuda','help':'ayuda','start':'ayuda',
    'ver cuentas':'ver_cuentas','cuentas':'ver_cuentas','accounts':'ver_cuentas',
    'presupuesto':'presupuesto','budget':'presupuesto',
    'historial':'historial','history':'historial',
    'miid':'miid',
    'si':'confirmar','sí':'confirmar','yes':'confirmar','confirm':'confirmar',
    'no':'cancelar','cancel':'cancelar',
  };
  if (CMDS[t]) return { type:'comando', cmd:CMDS[t] };

  const bm = t.match(/(?:presupuesto|budget)\s+(\w+)\s+(\d+(?:[.,]\d+)?)/);
  if (bm) return { type:'comando', cmd:'set_budget', budget_cat:bm[1], budget_amount:parseFloat(bm[2].replace(',','.')) };

  const am = t.match(/(\d+(?:[.,]\d+)?)/);
  if (!am) return null;
  const amount = parseFloat(am[1].replace(',','.'));
  if (!amount || amount<=0) return null;

  const hasInc = INC_VERBS.some(v=>t.includes(v));
  const hasExp = EXP_VERBS.some(v=>t.includes(v));

  let type;
  if (hasInc && !hasExp) type = 'ingreso';
  else if (hasExp) type = 'egreso';
  else {
    const np = t.match(/\d+(?:[.,]\d+)?\s+(?:en|de|para|for|on)\s+(.+)/i);
    if (np) return { type:'egreso', amount, desc:np[1].trim(), cat:detectCat(np[1]+' '+t), account:detectAcc(t) };
    return null;
  }

  let desc = t.replace(/\d+(?:[.,]\d+)?/g,'').replace(/\b(el|la|los|las|un|una|de|del|con|al|en|por|para|a|mi|the|a|an|for|on|at|in|with|from)\b/gi,' ').replace(/\s+/g,' ').trim();
  if (!desc || desc.length<2) {
    if (t.includes('quincena')) desc = 'Quincena';
    else if (t.includes('sueldo')||t.includes('salary')) desc = 'Salary';
    else desc = type==='ingreso' ? 'Income' : 'Expense';
  }
  desc = desc.charAt(0).toUpperCase()+desc.slice(1);
  return { type, amount, desc, cat:detectCat(t), account:detectAcc(t) };
}

// ─── MESSAGE HANDLERS ─────────────────────────────────────────────────────
async function handleText(msgText, chatId) {
  const id = String(chatId);
  const msg = msgText.trim();
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();

  try {
    const allData = await loadData();
    const user = getUser(allData, id);
    async function save() { allData.users[id]=user; await saveData(allData); }

    if (msg.toLowerCase()==='/miid'||msg.toLowerCase()==='miid') {
      return MSG.miid(chatId, getLang(id, msg));
    }

    // Auto-register new user
    if (!user.registered) {
      user.registered = true;
      user.pending = null;
      await save();
      userLang[id] = detectLang(msg);
      return MSG.welcome(chatId, userLang[id]);
    }

    const monthTxs = getMonthTxs(user.transactions, month, year);
    const parsed = await parseWithAI(msg) || fallbackParse(msg);

    if (parsed?.cmd==='miid') return MSG.miid(chatId, getLang(id, msg));

    if (parsed?.cmd==='confirmar') {
      const p = pendingTx[id];
      if (p) { user.transactions.push(p); await save(); delete pendingTx[id];
        return MSG.recorded({ emoji: CAT_EMOJI[p.cat]||'📦', desc: p.desc, amount: fmt(p.amount), accEmoji: ACC_EMOJI[p.account]||'💵', account: p.account }, getLang(id, msg)); }
      return MSG.noPending(getLang(id, msg));
    }

    if (parsed?.cmd==='cancelar') {
      if (pendingTx[id]) { delete pendingTx[id]; return MSG.cancelled(getLang(id, msg)); }
      return MSG.nothingCancel(getLang(id, msg));
    }

    if (!parsed) return MSG.notUnderstood(getLang(id, msg));

    const cmd = parsed.cmd;

    if (cmd==='resumen') {
      const inc = monthTxs.filter(t=>t.type==='ingreso').reduce((s,t)=>s+t.amount,0);
      const exp = monthTxs.filter(t=>t.type==='egreso').reduce((s,t)=>s+t.amount,0);
      const bal = inc-exp;
      const sl = getLang(id, msg);
      const SM = sl==='es' ? MONTHS_ES : MONTHS_EN;
      return sl==='es'
        ? `💰 *Resumen — ${SM[month]} ${year}*\n\n▲ Ingresos: *${fmt(inc)}*\n▼ Egresos: *${fmt(exp)}*\n\n${bal>=0?'✅':'🚨'} Balance: *${fmt(bal)}*\n\n_${monthTxs.length} movimiento(s)_`
        : `💰 *Summary — ${SM[month]} ${year}*\n\n▲ Income: *${fmt(inc)}*\n▼ Expenses: *${fmt(exp)}*\n\n${bal>=0?'✅':'🚨'} Balance: *${fmt(bal)}*\n\n_${monthTxs.length} transaction(s)_`;
    }

    if (cmd==='ver_cuentas') {
      const lines = ['efectivo','banco','tarjeta'].map(acc => {
        const inc = monthTxs.filter(t=>t.type==='ingreso'&&t.account===acc).reduce((s,t)=>s+t.amount,0);
        const exp = monthTxs.filter(t=>t.type==='egreso'&&t.account===acc).reduce((s,t)=>s+t.amount,0);
        return `${ACC_EMOJI[acc]} *${acc}*\n   ▲ ${fmt(inc)}  ▼ ${fmt(exp)}\n   Balance: ${fmt(inc-exp)}`;
      });
      const al = getLang(id, msg); const AM = al==='es'?MONTHS_ES:MONTHS_EN;
      return al==='es' ? `🏦 *Cuentas — ${AM[month]}*\n\n${lines.join('\n\n')}` : `🏦 *Accounts — ${AM[month]}*\n\n${lines.join('\n\n')}`;
    }

    if (cmd==='alertas') {
      const inc = monthTxs.filter(t=>t.type==='ingreso').reduce((s,t)=>s+t.amount,0);
      const exp = monthTxs.filter(t=>t.type==='egreso').reduce((s,t)=>s+t.amount,0);
      const alerts = [];
      if (inc>0) {
        const pct = (exp/inc)*100;
        if (pct>=100) alerts.push(`🚨 Expenses exceeded income (${pct.toFixed(0)}%)`);
        else if (pct>=80) alerts.push(`⚠️ Spent ${pct.toFixed(0)}% of income`);
        else alerts.push(`✅ Healthy finances (${pct.toFixed(0)}% spent)`);
      }
      for (const [cat,limit] of Object.entries(user.budgets)) {
        const spent = monthTxs.filter(t=>t.type==='egreso'&&t.cat===cat).reduce((s,t)=>s+t.amount,0);
        const pct = (spent/limit)*100;
        const e = CAT_EMOJI[cat]||'📦';
        if (pct>=100) alerts.push(`🚨 ${e} ${cat}: EXCEEDED (${fmt(spent)})`);
        else if (pct>=80) alerts.push(`⚠️ ${e} ${cat}: ${pct.toFixed(0)}% used`);
      }
      const aal = getLang(id, msg); const AAM = aal==='es'?MONTHS_ES:MONTHS_EN;
      return aal==='es' ? `🔔 *Alertas — ${AAM[month]}*\n\n${alerts.join('\n')||'Sin alertas ✅'}` : `🔔 *Alerts — ${AAM[month]}*\n\n${alerts.join('\n')||'No alerts ✅'}`;
    }

    if (cmd==='historial') {
      const last5 = [...monthTxs].reverse().slice(0,5);
      const hl = getLang(id, msg); const HM = hl==='es'?MONTHS_ES:MONTHS_EN;
      if (!last5.length) return hl==='es' ? `📭 Sin movimientos en ${HM[month]}` : `📭 No transactions in ${HM[month]}`;
      return hl==='es'
        ? `📋 *Recientes — ${HM[month]}*\n\n${last5.map(t=>`${t.type==='ingreso'?'▲':'▼'} ${CAT_EMOJI[t.cat]||'📦'} ${t.desc} — ${fmt(t.amount)}`).join('\n')}`
        : `📋 *Recent — ${HM[month]}*\n\n${last5.map(t=>`${t.type==='ingreso'?'▲':'▼'} ${CAT_EMOJI[t.cat]||'📦'} ${t.desc} — ${fmt(t.amount)}`).join('\n')}`;
    }

    if (cmd==='presupuesto') {
      const bl = getLang(id, msg);
      if (!Object.keys(user.budgets).length) return bl==='es'
        ? `📊 *Sin presupuestos configurados.*\n\nCrea uno:\n• presupuesto comida 5000\n• budget food 500`
        : `📊 *No budgets set.*\n\nCreate one:\n• budget food 500\n• presupuesto comida 5000`;
      const lines = Object.entries(user.budgets).map(([cat,limit]) => {
        const spent = monthTxs.filter(t=>t.type==='egreso'&&t.cat===cat).reduce((s,t)=>s+t.amount,0);
        const pct = Math.min(100,(spent/limit)*100);
        const bar = '█'.repeat(Math.floor(pct/10))+'░'.repeat(10-Math.floor(pct/10));
        return `${CAT_EMOJI[cat]||'📦'} ${cat}\n   ${bar} ${pct.toFixed(0)}%\n   ${fmt(spent)} / ${fmt(limit)}`;
      });
      const BM = bl==='es'?MONTHS_ES:MONTHS_EN;
      return bl==='es' ? `📊 *Presupuestos — ${BM[month]}*\n\n${lines.join('\n\n')}` : `📊 *Budgets — ${BM[month]}*\n\n${lines.join('\n\n')}`;
    }

    if (cmd==='set_budget') {
      const sbl = getLang(id, msg);
      if (!parsed.budget_cat||!parsed.budget_amount||parsed.budget_amount<=0) return sbl==='es' ? '❌ Ejemplo: presupuesto comida 5000' : '❌ Example: budget food 500';
      user.budgets[parsed.budget_cat] = parsed.budget_amount;
      await save();
      return sbl==='es'
        ? `✅ Presupuesto guardado:\n\n${CAT_EMOJI[parsed.budget_cat]||'📦'} *${parsed.budget_cat}*: ${fmt(parsed.budget_amount)}/mes`
        : `✅ Budget set:\n\n${CAT_EMOJI[parsed.budget_cat]||'📦'} *${parsed.budget_cat}*: ${fmt(parsed.budget_amount)}/month`;
    }

    if (cmd==='ayuda') {
      const yl = getLang(id, msg);
      return yl==='es'
        ? `📖 *MisCuentas — Comandos*\n\n💰 *Consultas:*\n• resumen — Balance del mes\n• cuentas — Por cuenta\n• alertas — Alertas financieras\n• historial — Últimos movimientos\n• presupuesto — Ver límites\n\n📝 *Registrar:*\n• gasté 350 en comida\n• pagué la luz 1200 con banco\n• deposité el sueldo 28000\n\n📷 *Facturas:*\n• Envía una foto de factura\n\n📊 *Presupuestos:*\n• presupuesto comida 5000\n\n🪪 *Mi ID:* /miid`
        : `📖 *MisCuentas — Commands*\n\n💰 *Queries:*\n• summary / resumen\n• accounts / cuentas\n• alerts / alertas\n• history / historial\n• budget / presupuesto\n\n📝 *Record:*\n• spent 50 on food\n• paid rent 800 with bank\n• received salary 2000\n\n📷 *Receipts:*\n• Send a photo of any receipt\n\n📊 *Budgets:*\n• budget food 500\n• presupuesto comida 5000\n\n🪪 *My ID:* /miid`;
    }

    if (parsed.type==='ingreso'||parsed.type==='egreso') {
      const tx = {
        id: uid(), type: parsed.type,
        amount: parsed.amount,
        desc: parsed.desc||(parsed.type==='ingreso'?'Income':'Expense'),
        cat: parsed.cat||'otro', account: parsed.account||'efectivo',
        date: now.toISOString().split('T')[0], timestamp: now.toISOString()
      };
      user.transactions.push(tx);
      await save();
      const tl = getLang(id, msg);
      userLang[id] = detectLang(msg); // update lang on each transaction
      return `${tx.type==='ingreso'?'▲':'▼'} *${tx.desc}*\n${CAT_EMOJI[tx.cat]||'📦'} ${tx.cat} • ${ACC_EMOJI[tx.account]||'💵'} ${tx.account}\n💰 ${fmt(tx.amount)}`;
    }

    return MSG.notRecognized(getLang(id, msg));

  } catch (e) {
    console.error('handleText error:', e);
    return MSG.generalError(getLang(id, ''));
  }
}

async function handlePhoto(msg, chatId) {
  const id = String(chatId);
  try {
    const l = getLang(id, ''); if (!GROQ_KEY) return MSG.noGroq(l);

    const photo = await getPhoto(msg);
    if (!photo) return MSG.noPhoto(l);

    await send(chatId, MSG.analyzing(l));

    const result = await analyzeReceipt(photo.base64, photo.mimeType);
    if (!result) return MSG.photoError(l);
    if (!result.success) return MSG.photoUnreadable(l);

    const now = new Date();
    const tx = {
      id: uid(), type: 'egreso',
      amount: result.amount,
      desc: result.description||'Receipt',
      cat: result.category||'otro',
      account: 'efectivo',
      date: now.toISOString().split('T')[0],
      timestamp: now.toISOString()
    };

    pendingTx[id] = tx;

    return MSG.receipt({ desc: tx.desc, amount: fmt(tx.amount), catEmoji: CAT_EMOJI[tx.cat]||'📦', cat: tx.cat }, l);
  } catch (e) {
    console.error('handlePhoto error:', e);
    return '❌ Error processing image. Please try again.';
  }
}

// ─── BOT EVENTS ───────────────────────────────────────────────────────────
bot.on('message', async msg => {
  const chatId = msg.chat.id;
  try {
    if (msg.photo?.length > 0) {
      await send(chatId, await handlePhoto(msg, chatId));
    } else if (msg.text) {
      await send(chatId, await handleText(msg.text, chatId));
    }
  } catch (e) {
    console.error('Bot message error:', e);
    try { await send(chatId, '❌ An error occurred. Please try again.'); } catch {}
  }
});

// ─── HTTP SERVER ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

app.options('/api/login',    (_, res) => { cors(res); res.sendStatus(200); });
app.options('/api/data/:id', (_, res) => { cors(res); res.sendStatus(200); });

app.get('/',       (_, res) => res.json({ status:'ok', service:'MisCuentas Bot', uptime: Math.floor(process.uptime()) }));
app.get('/health', (_, res) => res.json({ status:'healthy', groq:!!GROQ_KEY, gemini:!!GEMINI_KEY }));

app.post('/api/login', async (req, res) => {
  try {
    cors(res);
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error:'id required' });
    const data = await loadData();
    const id = String(phone);
    if (!data.users[id]) { data.users[id] = { registered:true, transactions:[], budgets:{}, pending:null }; await saveData(data); }
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.get('/api/data/:id', async (req, res) => {
  try {
    cors(res);
    const id = decodeURIComponent(req.params.id);
    const data = await loadData();
    if (!data.users[id]) { data.users[id] = { registered:true, transactions:[], budgets:{}, pending:null }; await saveData(data); }
    const u = data.users[id];
    res.json({ transactions:u.transactions||[], budgets:u.budgets||{} });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

// Smart merge — prevents bot/web race condition
app.post('/api/data/:id', async (req, res) => {
  try {
    cors(res);
    const id = decodeURIComponent(req.params.id);
    const data = await loadData();
    if (!data.users[id]) data.users[id] = { registered:true, transactions:[], budgets:{}, pending:null };
    const u = data.users[id];
    if (req.body.transactions !== undefined) {
      const webTxs = req.body.transactions||[];
      const webIds = new Set(webTxs.map(t=>String(t.id||t.timestamp)).filter(Boolean));
      const botOnly = (u.transactions||[]).filter(t=>{ const k=String(t.id||t.timestamp||''); return k&&!webIds.has(k); });
      u.transactions = [...webTxs,...botOnly].sort((a,b)=>new Date(a.timestamp||a.date||0)-new Date(b.timestamp||b.date||0));
    }
    if (req.body.budgets!==undefined) u.budgets = req.body.budgets;
    data.users[id] = u;
    await saveData(data);
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ error:e.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`✅ MisCuentas Bot started`);
  console.log(`🌐 Port: ${PORT}`);
  console.log(`📸 Vision: ${GROQ_KEY ? 'Groq ✅' : '❌ GROQ_API_KEY missing'}`);
  console.log(`🧠 AI Parser: ${GEMINI_KEY ? 'Gemini ✅' : 'Fallback only'}`);
  console.log(`========================================\n`);
});

process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
process.on('SIGINT',  () => { bot.stopPolling(); process.exit(0); });
