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
      return `🪪 Your Telegram ID:\n\n\`${chatId}\`\n\nUse it to log in to the web panel.`;
    }

    // Auto-register new user
    if (!user.registered) {
      user.registered = true;
      user.pending = null;
      await save();
      return `👋 *Welcome to MisCuentas!*\n\n🎉 Start tracking your finances now.\n\nYour ID: \`${chatId}\`\n\nSend *help* for all commands.`;
    }

    const monthTxs = getMonthTxs(user.transactions, month, year);
    const parsed = await parseWithAI(msg) || fallbackParse(msg);

    if (parsed?.cmd==='miid') return `🪪 Your Telegram ID:\n\n\`${chatId}\``;

    if (parsed?.cmd==='confirmar') {
      const p = pendingTx[id];
      if (p) { user.transactions.push(p); await save(); delete pendingTx[id]; return `✅ *Recorded*\n\n${CAT_EMOJI[p.cat]||'📦'} ${p.desc}\n💰 ${fmt(p.amount)}\n${ACC_EMOJI[p.account]||'💵'} ${p.account}`; }
      return '❌ No pending transaction.';
    }

    if (parsed?.cmd==='cancelar') {
      if (pendingTx[id]) { delete pendingTx[id]; return '❌ Cancelled.'; }
      return '❌ Nothing to cancel.';
    }

    if (!parsed) return `🤔 I didn't understand that.\n\nSend *help* to see commands.\n\nExamples:\n• spent 50 on food\n• paid rent 800 with bank\n• received salary 2000\n• 📷 Send a receipt photo`;

    const cmd = parsed.cmd;

    if (cmd==='resumen') {
      const inc = monthTxs.filter(t=>t.type==='ingreso').reduce((s,t)=>s+t.amount,0);
      const exp = monthTxs.filter(t=>t.type==='egreso').reduce((s,t)=>s+t.amount,0);
      const bal = inc-exp;
      return `💰 *Summary — ${MONTHS[month]} ${year}*\n\n▲ Income: *${fmt(inc)}*\n▼ Expenses: *${fmt(exp)}*\n\n${bal>=0?'✅':'🚨'} Balance: *${fmt(bal)}*\n\n_${monthTxs.length} transaction(s)_`;
    }

    if (cmd==='ver_cuentas') {
      const lines = ['efectivo','banco','tarjeta'].map(acc => {
        const inc = monthTxs.filter(t=>t.type==='ingreso'&&t.account===acc).reduce((s,t)=>s+t.amount,0);
        const exp = monthTxs.filter(t=>t.type==='egreso'&&t.account===acc).reduce((s,t)=>s+t.amount,0);
        return `${ACC_EMOJI[acc]} *${acc}*\n   ▲ ${fmt(inc)}  ▼ ${fmt(exp)}\n   Balance: ${fmt(inc-exp)}`;
      });
      return `🏦 *Accounts — ${MONTHS[month]}*\n\n${lines.join('\n\n')}`;
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
      return `🔔 *Alerts — ${MONTHS[month]}*\n\n${alerts.join('\n')||'No alerts ✅'}`;
    }

    if (cmd==='historial') {
      const last5 = [...monthTxs].reverse().slice(0,5);
      if (!last5.length) return `📭 No transactions in ${MONTHS[month]}`;
      return `📋 *Recent — ${MONTHS[month]}*\n\n${last5.map(t=>`${t.type==='ingreso'?'▲':'▼'} ${CAT_EMOJI[t.cat]||'📦'} ${t.desc} — ${fmt(t.amount)}`).join('\n')}`;
    }

    if (cmd==='presupuesto') {
      if (!Object.keys(user.budgets).length) return `📊 *No budgets set.*\n\nCreate one:\n• budget food 500\n• presupuesto comida 5000`;
      const lines = Object.entries(user.budgets).map(([cat,limit]) => {
        const spent = monthTxs.filter(t=>t.type==='egreso'&&t.cat===cat).reduce((s,t)=>s+t.amount,0);
        const pct = Math.min(100,(spent/limit)*100);
        const bar = '█'.repeat(Math.floor(pct/10))+'░'.repeat(10-Math.floor(pct/10));
        return `${CAT_EMOJI[cat]||'📦'} ${cat}\n   ${bar} ${pct.toFixed(0)}%\n   ${fmt(spent)} / ${fmt(limit)}`;
      });
      return `📊 *Budgets — ${MONTHS[month]}*\n\n${lines.join('\n\n')}`;
    }

    if (cmd==='set_budget') {
      if (!parsed.budget_cat||!parsed.budget_amount||parsed.budget_amount<=0) return '❌ Example: budget food 500';
      user.budgets[parsed.budget_cat] = parsed.budget_amount;
      await save();
      return `✅ Budget set:\n\n${CAT_EMOJI[parsed.budget_cat]||'📦'} *${parsed.budget_cat}*: ${fmt(parsed.budget_amount)}/month`;
    }

    if (cmd==='ayuda') {
      return `📖 *MisCuentas — Commands*\n
💰 *Queries:*
• summary / resumen
• accounts / cuentas
• alerts / alertas
• history / historial
• budget / presupuesto

📝 *Record:*
• spent 50 on food
• paid electricity 120 with bank
• received salary 2000

📷 *Receipts:*
• Send a photo of any receipt

📊 *Budgets:*
• budget food 500
• presupuesto comida 5000

🪪 *My ID:* /miid`;
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
      return `${tx.type==='ingreso'?'▲':'▼'} *${tx.desc}*\n${CAT_EMOJI[tx.cat]||'📦'} ${tx.cat} • ${ACC_EMOJI[tx.account]||'💵'} ${tx.account}\n💰 ${fmt(tx.amount)}`;
    }

    return `🤔 Command not recognized. Send *help* for all commands.`;

  } catch (e) {
    console.error('handleText error:', e);
    return '❌ An error occurred. Please try again.';
  }
}

async function handlePhoto(msg, chatId) {
  const id = String(chatId);
  try {
    if (!GROQ_KEY) return '❌ Receipt processing is not configured.';

    const photo = await getPhoto(msg);
    if (!photo) return '❌ Could not get the image. Please try again.';

    await send(chatId, '🔄 *Analyzing receipt...*');

    const result = await analyzeReceipt(photo.base64, photo.mimeType);
    if (!result) return '❌ Could not analyze the image. Try a clearer photo.';
    if (!result.success) return '❌ Could not read the receipt. Make sure it is clear and shows a valid receipt.';

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

    return `🧾 *Receipt detected*\n\n📍 ${tx.desc}\n💰 ${fmt(tx.amount)}\n${CAT_EMOJI[tx.cat]||'📦'} ${tx.cat}\n\n✅ Reply *yes* to confirm\n❌ Reply *no* to cancel\n\n💡 To change account: *yes bank* or *yes card*`;
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
