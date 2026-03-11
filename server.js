const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// ========== CONFIG ==========
const JSONBIN_API_KEY   = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID    = process.env.JSONBIN_BIN_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const JSONBIN_URL       = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

// ========== DATA HELPERS ==========
async function loadData() {
  try {
    const res = await fetch(`${JSONBIN_URL}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY }
    });
    const json = await res.json();
    return json.record || { transactions: [], budgets: {} };
  } catch (e) {
    return { transactions: [], budgets: {} };
  }
}

async function saveData(data) {
  try {
    await fetch(JSONBIN_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
      body: JSON.stringify(data)
    });
  } catch (e) {
    console.error('Error guardando:', e.message);
  }
}

function fmt(n) {
  return 'RD$ ' + Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 });
}

function getMonthTxs(txs, month, year) {
  return txs.filter(t => {
    const d = new Date(t.date);
    return d.getMonth() === month && d.getFullYear() === year;
  });
}

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

const CAT_EMOJIS = {
  comida:'🍽️', transporte:'🚗', servicios:'💡', salud:'🏥',
  entretenimiento:'🎬', ropa:'👕', educacion:'📚', salario:'💼',
  negocio:'🏪', inversion:'📈', prestamo:'🤝', ahorro:'💰',
  tarjeta:'💳', otro:'📦'
};

const ACCOUNT_EMOJIS = { efectivo:'💵', banco:'🏦', tarjeta:'💳' };

// ========== AI PARSER ==========
async function parseWithAI(message) {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return null;
  try {
    const prompt = `Eres un asistente financiero. Analiza mensajes en español dominicano y extrae datos. Responde SOLO con JSON valido en una sola linea, sin texto adicional, sin markdown.

Mensaje: "${message}"

Formato JSON exacto:
{"type":"ingreso o egreso o comando","amount":numero o null,"desc":"descripcion","cat":"categoria","account":"efectivo o banco o tarjeta","cmd":null,"budget_cat":null,"budget_amount":null}

Categorias: comida, transporte, servicios, salud, entretenimiento, ropa, educacion, salario, negocio, inversion, prestamo, ahorro, otro

Ejemplos:
"fui al colmado y gaste 350" = {"type":"egreso","amount":350,"desc":"Colmado","cat":"comida","account":"efectivo","cmd":null,"budget_cat":null,"budget_amount":null}
"compre zapatos con tarjeta 2500" = {"type":"egreso","amount":2500,"desc":"Zapatos","cat":"ropa","account":"tarjeta","cmd":null,"budget_cat":null,"budget_amount":null}
"pague la luz 1200 con banco" = {"type":"egreso","amount":1200,"desc":"Luz electrica","cat":"servicios","account":"banco","cmd":null,"budget_cat":null,"budget_amount":null}
"deposite el sueldo 28000" = {"type":"ingreso","amount":28000,"desc":"Salario","cat":"salario","account":"banco","cmd":null,"budget_cat":null,"budget_amount":null}
"cobre 5000 de cliente" = {"type":"ingreso","amount":5000,"desc":"Cobro","cat":"negocio","account":"efectivo","cmd":null,"budget_cat":null,"budget_amount":null}
"resumen" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"resumen","budget_cat":null,"budget_amount":null}
"ver cuentas" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"ver_cuentas","budget_cat":null,"budget_amount":null}
"alertas" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"alertas","budget_cat":null,"budget_amount":null}
"historial" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"historial","budget_cat":null,"budget_amount":null}
"presupuesto comida 5000" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"set_budget","budget_cat":"comida","budget_amount":5000}
"ayuda" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"ayuda","budget_cat":null,"budget_amount":null}

Reglas: tarjeta mencionada=account tarjeta, banco o deposite=account banco, sin mencion=account efectivo`;

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
      })
    });

    const data = await response.json();
    console.log('Gemini status:', response.status);

    if (!data.candidates || !data.candidates[0]) {
      console.error('Gemini error:', JSON.stringify(data));
      return null;
    }

    const text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/g, '').trim();
    console.log('Gemini raw:', text.substring(0, 120));

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { console.error('No JSON in Gemini response'); return null; }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log('Gemini parsed:', JSON.stringify(parsed).substring(0, 100));
    return parsed;
  } catch (e) {
    console.error('Gemini error:', e.message);
    return null;
  }
}

// ========== FALLBACK PARSER ==========
const CAT_KEYWORDS = {
  comida:          ['comida','almuerzo','desayuno','cena','restaurante','mercado','colmado','pizza','pollo'],
  transporte:      ['transporte','gasolina','taxi','uber','carro','bus','combustible'],
  servicios:       ['luz','agua','internet','telefono','claro','altice','edesur','netflix','spotify'],
  salud:           ['salud','medico','farmacia','medicina','doctor','clinica','hospital'],
  entretenimiento: ['entretenimiento','cine','fiesta','salida','bar','disco','viaje'],
  ropa:            ['ropa','zapatos','camisa','pantalon','tienda'],
  educacion:       ['escuela','universidad','libro','curso','colegio'],
  salario:         ['salario','sueldo','quincena','nomina','deposité','deposite'],
  negocio:         ['negocio','venta','cobro','cliente','factura'],
  inversion:       ['inversion','dividendo','interes','ahorro'],
};

const ACCOUNT_KEYWORDS = {
  banco:   ['banco','transfer','transferencia','deposito','cuenta'],
  tarjeta: ['tarjeta','card','credito','débito','debito'],
};

function detectCat(text) {
  const l = text.toLowerCase();
  for (const [cat, kws] of Object.entries(CAT_KEYWORDS))
    if (kws.some(k => l.includes(k))) return cat;
  return 'otro';
}

function detectAcc(text) {
  const l = text.toLowerCase();
  if (ACCOUNT_KEYWORDS.tarjeta.some(k => l.includes(k))) return 'tarjeta';
  if (ACCOUNT_KEYWORDS.banco.some(k => l.includes(k))) return 'banco';
  return 'efectivo';
}

function fallbackParse(msg) {
  const t = msg.trim().toLowerCase();
  if (['resumen','balance','hoy'].includes(t)) return { type:'comando', cmd:'resumen' };
  if (['alertas','alerta'].includes(t)) return { type:'comando', cmd:'alertas' };
  if (['ayuda','help','comandos'].includes(t)) return { type:'comando', cmd:'ayuda' };
  if (['ver cuentas','cuentas','mis cuentas'].includes(t)) return { type:'comando', cmd:'ver_cuentas' };
  if (t === 'presupuesto') return { type:'comando', cmd:'presupuesto' };
  if (t === 'historial' || t === 'lista') return { type:'comando', cmd:'historial' };

  const bm = t.match(/presupuesto\s+(\w+)\s+(\d+)/);
  if (bm) return { type:'comando', cmd:'set_budget', budget_cat: bm[1], budget_amount: parseFloat(bm[2]) };

  const inc = t.match(/(?:ingres[eé]|recibi[oó]|gané|gane|cobré|deposité|deposite)\s+(\d+(?:[.,]\d+)?)\s*(.*)?/i);
  if (inc) return { type:'ingreso', amount: parseFloat(inc[1].replace(',','.')), desc: inc[2]||'Ingreso', cat: detectCat(inc[2]||t), account: detectAcc(t) };

  const exp = t.match(/(?:gast[eé]|pagu[eé]|compr[eé])\s+(\d+(?:[.,]\d+)?)\s*(?:en\s+)?(.*)?/i);
  if (exp) return { type:'egreso', amount: parseFloat(exp[1].replace(',','.')), desc: exp[2]||'Gasto', cat: detectCat(exp[2]||t), account: detectAcc(t) };

  const num = t.match(/(\d+(?:[.,]\d+)?)\s+(?:en|de|para)\s+(.*)/i);
  if (num) return { type:'egreso', amount: parseFloat(num[1].replace(',','.')), desc: num[2]||'Gasto', cat: detectCat(num[2]||t), account: detectAcc(t) };

  return null;
}

// ========== BOT LOGIC ==========
async function handleMessage(msgText) {
  const data = await loadData();
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const monthTxs = getMonthTxs(data.transactions, month, year);

  let parsed = await parseWithAI(msgText) || fallbackParse(msgText);

  if (!parsed) {
    return `🤔 No entendí ese mensaje.\n\nEnvía *ayuda* para ver los comandos.\n\nEjemplos:\n• fui al colmado y gasté 350\n• pagué la luz 1200 con banco\n• deposité el sueldo 28000`;
  }

  const cmd = parsed.cmd;

  // ---- RESUMEN ----
  if (cmd === 'resumen' || parsed.type === 'comando' && cmd === 'resumen') {
    const inc = monthTxs.filter(t => t.type==='ingreso').reduce((s,t)=>s+t.amount,0);
    const exp = monthTxs.filter(t => t.type==='egreso').reduce((s,t)=>s+t.amount,0);
    const bal = inc - exp;
    return `💰 *Resumen — ${MONTHS[month]} ${year}*\n\n▲ Ingresos: *${fmt(inc)}*\n▼ Egresos: *${fmt(exp)}*\n\n${bal>=0?'✅':'🚨'} Balance: *${fmt(bal)}*\n\n_${monthTxs.length} movimiento(s)_\n\nEnvía *cuentas* para ver por cuenta.`;
  }

  // ---- VER CUENTAS ----
  if (cmd === 'ver_cuentas') {
    const accs = ['efectivo','banco','tarjeta'];
    const lines = accs.map(acc => {
      const inc = monthTxs.filter(t=>t.type==='ingreso'&&t.account===acc).reduce((s,t)=>s+t.amount,0);
      const exp = monthTxs.filter(t=>t.type==='egreso'&&t.account===acc).reduce((s,t)=>s+t.amount,0);
      return `${ACCOUNT_EMOJIS[acc]} *${acc.charAt(0).toUpperCase()+acc.slice(1)}*\n   ▲ ${fmt(inc)}  ▼ ${fmt(exp)}\n   Balance: ${fmt(inc-exp)}`;
    });
    return `🏦 *Cuentas — ${MONTHS[month]}*\n\n${lines.join('\n\n')}`;
  }

  // ---- ALERTAS ----
  if (cmd === 'alertas') {
    const inc = monthTxs.filter(t=>t.type==='ingreso').reduce((s,t)=>s+t.amount,0);
    const exp = monthTxs.filter(t=>t.type==='egreso').reduce((s,t)=>s+t.amount,0);
    let alerts = [];
    if (inc > 0) {
      const pct = (exp/inc)*100;
      if (pct>=100) alerts.push(`🚨 Egresos superaron ingresos (${pct.toFixed(0)}%)`);
      else if (pct>=80) alerts.push(`⚠️ Gastaste el ${pct.toFixed(0)}% de tus ingresos`);
      else alerts.push(`✅ Finanzas saludables (${pct.toFixed(0)}% gastado)`);
    }
    for (const [cat,limit] of Object.entries(data.budgets)) {
      const spent = monthTxs.filter(t=>t.type==='egreso'&&t.cat===cat).reduce((s,t)=>s+t.amount,0);
      const pct = (spent/limit)*100;
      const e = CAT_EMOJIS[cat]||'📦';
      if (pct>=100) alerts.push(`🚨 ${e} ${cat}: SUPERADO (${fmt(spent)})`);
      else if (pct>=80) alerts.push(`⚠️ ${e} ${cat}: ${pct.toFixed(0)}% usado`);
    }
    return `🔔 *Alertas — ${MONTHS[month]}*\n\n${alerts.join('\n')||'Sin alertas ✅'}`;
  }

  // ---- HISTORIAL ----
  if (cmd === 'historial') {
    const last5 = [...monthTxs].reverse().slice(0,5);
    if (!last5.length) return `📭 Sin movimientos en ${MONTHS[month]}`;
    return `📋 *Últimos movimientos*\n\n${last5.map(t=>`${t.type==='ingreso'?'▲':'▼'} ${CAT_EMOJIS[t.cat]||'📦'} ${t.desc} — ${fmt(t.amount)} ${ACCOUNT_EMOJIS[t.account]||'💵'}`).join('\n')}`;
  }

  // ---- PRESUPUESTO ----
  if (cmd === 'presupuesto') {
    if (!Object.keys(data.budgets).length) return '📊 Sin presupuestos.\n\nEnvía: *presupuesto comida 5000*';
    return `📊 *Presupuestos — ${MONTHS[month]}*\n\n${Object.entries(data.budgets).map(([cat,limit])=>{
      const spent = monthTxs.filter(t=>t.type==='egreso'&&t.cat===cat).reduce((s,t)=>s+t.amount,0);
      const pct = ((spent/limit)*100).toFixed(0);
      return `${pct>=100?'🔴':pct>=80?'🟡':'🟢'} ${CAT_EMOJIS[cat]||'📦'} ${cat}: ${fmt(spent)}/${fmt(limit)} (${pct}%)`;
    }).join('\n')}`;
  }

  // ---- SET BUDGET ----
  if (cmd === 'set_budget') {
    const cat = parsed.budget_cat;
    const limit = parsed.budget_amount;
    if (!cat || !limit) return '❌ Usa: *presupuesto comida 5000*';
    data.budgets[cat] = limit;
    await saveData(data);
    return `✅ Presupuesto configurado:\n\n${CAT_EMOJIS[cat]||'📦'} *${cat}*: ${fmt(limit)} / mes`;
  }

  // ---- AYUDA ----
  if (cmd === 'ayuda') {
    return `🤖 *MisCuentas Bot*\n\n*Registrar (natural):*\nfui al colmado y gasté 350\npagué la luz 1200 con banco\ndeposité el sueldo 28000\ncompré ropa con tarjeta 800\n\n*Consultar:*\nresumen · cuentas · alertas\nhistorial · presupuesto\n\n*Configurar:*\npresupuesto comida 5000\n\n💵 Efectivo  🏦 Banco  💳 Tarjeta`;
  }

  // ---- TRANSACTION ----
  if (parsed.type === 'ingreso' || parsed.type === 'egreso') {
    if (!parsed.amount || parsed.amount <= 0) return `🤔 No identifiqué el monto.\n\nEjemplo: *gasté 500 en comida*`;

    const account = parsed.account || 'efectivo';
    const tx = {
      id: Date.now(),
      type: parsed.type,
      amount: parsed.amount,
      desc: parsed.desc || (parsed.type==='ingreso'?'Ingreso':'Gasto'),
      cat: parsed.cat || 'otro',
      account,
      date: now.toISOString().split('T')[0],
    };
    data.transactions.push(tx);
    await saveData(data);

    const emoji = CAT_EMOJIS[tx.cat]||'📦';
    const accEmoji = ACCOUNT_EMOJIS[account]||'💵';
    const word = tx.type==='ingreso'?'Ingreso':'Egreso';

    let budgetAlert = '';
    if (tx.type==='egreso' && data.budgets[tx.cat]) {
      const limit = data.budgets[tx.cat];
      const total = getMonthTxs(data.transactions,month,year).filter(t=>t.type==='egreso'&&t.cat===tx.cat).reduce((s,t)=>s+t.amount,0);
      const pct = (total/limit)*100;
      if (pct>=100) budgetAlert=`\n\n⚠️ *Alerta:* Superaste el presupuesto de ${emoji} ${tx.cat}`;
      else if (pct>=80) budgetAlert=`\n\n⚠️ *Aviso:* Llevas el ${pct.toFixed(0)}% de ${emoji} ${tx.cat}`;
    }

    return `✅ *${word} registrado*\n\n${tx.type==='ingreso'?'▲':'▼'} ${emoji} ${tx.desc}\n💵 ${fmt(tx.amount)}\n${accEmoji} ${account.charAt(0).toUpperCase()+account.slice(1)}\n📂 ${tx.cat}\n📅 ${tx.date}${budgetAlert}`;
  }

  return `🤔 No entendí ese mensaje.\n\nEnvía *ayuda* para ver los comandos.`;
}

// ========== ROUTES ==========
app.get('/', (req, res) => res.send('✅ MisCuentas Bot v2 activo'));

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body || '';
  const reply = await handleMessage(incomingMsg);
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

app.get('/api/data', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(await loadData());
});

app.post('/api/data', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  await saveData(req.body);
  res.json({ ok: true });
});

app.options('/api/data', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 MisCuentas Bot v2 — puerto ${PORT}`));
