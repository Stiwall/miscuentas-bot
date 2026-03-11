const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// ========== CONFIG ==========
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID  = process.env.JSONBIN_BIN_ID;
const GEMINI_KEY      = process.env.GEMINI_API_KEY;
const JSONBIN_URL     = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

// ========== DATA ==========
async function loadData() {
  try {
    const res = await fetch(`${JSONBIN_URL}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    return json.record || { transactions: [], budgets: {} };
  } catch (e) {
    console.error('loadData error:', e.message);
    return { transactions: [], budgets: {} };
  }
}

async function saveData(data) {
  try {
    const res = await fetch(JSONBIN_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    console.error('saveData error:', e.message);
  }
}

// ========== HELPERS ==========
function fmt(n) {
  return 'RD$ ' + Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 });
}

function getMonthTxs(txs, month, year) {
  return txs.filter(t => {
    const d = new Date(t.date + 'T00:00:00');
    return d.getMonth() === month && d.getFullYear() === year;
  });
}

const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

const CAT_EMOJIS = {
  comida:'🍽️', transporte:'🚗', servicios:'💡', salud:'🏥',
  entretenimiento:'🎬', ropa:'👕', educacion:'📚', salario:'💼',
  negocio:'🏪', inversion:'📈', prestamo:'🤝', ahorro:'💰',
  tarjeta:'💳', regalo:'🎁', otro:'📦'
};

const ACC_EMOJIS = { efectivo:'💵', banco:'🏦', tarjeta:'💳' };

// ========== AI PARSER (Gemini) ==========
async function parseWithAI(message) {
  if (!GEMINI_KEY) return null;
  try {
    const prompt = `Eres un asistente financiero. Analiza mensajes en español dominicano. Responde SOLO JSON en una linea, sin markdown.

Mensaje: "${message}"

Formato: {"type":"ingreso|egreso|comando","amount":numero_o_null,"desc":"texto","cat":"categoria","account":"efectivo|banco|tarjeta","cmd":null,"budget_cat":null,"budget_amount":null}

Categorias: comida, transporte, servicios, salud, entretenimiento, ropa, educacion, salario, negocio, inversion, prestamo, ahorro, otro

Ejemplos:
"fui al colmado y gaste 350" = {"type":"egreso","amount":350,"desc":"Colmado","cat":"comida","account":"efectivo","cmd":null,"budget_cat":null,"budget_amount":null}
"compre zapatos con tarjeta 2500" = {"type":"egreso","amount":2500,"desc":"Zapatos","cat":"ropa","account":"tarjeta","cmd":null,"budget_cat":null,"budget_amount":null}
"pague la luz 1200 con banco" = {"type":"egreso","amount":1200,"desc":"Luz","cat":"servicios","account":"banco","cmd":null,"budget_cat":null,"budget_amount":null}
"deposite el sueldo 28000" = {"type":"ingreso","amount":28000,"desc":"Salario","cat":"salario","account":"banco","cmd":null,"budget_cat":null,"budget_amount":null}
"resumen" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"resumen","budget_cat":null,"budget_amount":null}
"ver cuentas" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"ver_cuentas","budget_cat":null,"budget_amount":null}
"alertas" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"alertas","budget_cat":null,"budget_amount":null}
"historial" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"historial","budget_cat":null,"budget_amount":null}
"presupuesto comida 5000" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"set_budget","budget_cat":"comida","budget_amount":5000}
"ayuda" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"ayuda","budget_cat":null,"budget_amount":null}

Reglas: tarjeta=account tarjeta, banco/deposite=account banco, sin mencion=account efectivo`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
        }),
        signal: AbortSignal.timeout(10000)
      }
    );

    const data = await res.json();
    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      console.error('Gemini bad response:', JSON.stringify(data).substring(0, 200));
      return null;
    }

    const text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;

    return JSON.parse(match[0]);
  } catch (e) {
    console.error('Gemini error:', e.message);
    return null;
  }
}

// ========== FALLBACK PARSER ==========
const CAT_KEYWORDS = {
  comida:          ['comida','almuerzo','desayuno','cena','restaurante','mercado','colmado','pizza','pollo','supermercado'],
  transporte:      ['transporte','gasolina','taxi','uber','carro','bus','combustible','metro'],
  servicios:       ['luz','agua','internet','telefono','claro','altice','edesur','edenorte','netflix','spotify','cable'],
  salud:           ['salud','medico','farmacia','medicina','doctor','clinica','hospital','dentista'],
  entretenimiento: ['entretenimiento','cine','fiesta','salida','bar','disco','viaje','hotel'],
  ropa:            ['ropa','zapatos','camisa','pantalon','tienda','ropa','calzado'],
  educacion:       ['escuela','universidad','libro','curso','colegio','matricula','educacion'],
  salario:         ['salario','sueldo','quincena','nomina','deposite','deposito'],
  negocio:         ['negocio','venta','cobro','cliente','factura','mercancia'],
  inversion:       ['inversion','dividendo','interes','acciones','bolsa'],
  ahorro:          ['ahorro','ahorros','fondo'],
  prestamo:        ['prestamo','deuda','cuota','banco personal'],
};

const ACC_KEYWORDS = {
  tarjeta: ['tarjeta','card','credito','debito'],
  banco:   ['banco','transfer','transferencia','deposito','cuenta corriente'],
};

function detectCat(text) {
  const l = text.toLowerCase();
  for (const [cat, kws] of Object.entries(CAT_KEYWORDS))
    if (kws.some(k => l.includes(k))) return cat;
  return 'otro';
}

function detectAcc(text) {
  const l = text.toLowerCase();
  if (ACC_KEYWORDS.tarjeta.some(k => l.includes(k))) return 'tarjeta';
  if (ACC_KEYWORDS.banco.some(k => l.includes(k))) return 'banco';
  return 'efectivo';
}

function fallbackParse(msg) {
  const t = msg.trim().toLowerCase();

  // Commands
  const cmds = {
    'resumen': 'resumen', 'balance': 'resumen', 'hoy': 'resumen', 'cuanto tengo': 'resumen',
    'alertas': 'alertas', 'alerta': 'alertas',
    'ayuda': 'ayuda', 'help': 'ayuda', 'comandos': 'ayuda',
    'ver cuentas': 'ver_cuentas', 'cuentas': 'ver_cuentas', 'mis cuentas': 'ver_cuentas',
    'presupuesto': 'presupuesto', 'historial': 'historial', 'lista': 'historial',
  };
  if (cmds[t]) return { type: 'comando', cmd: cmds[t] };

  // Set budget
  const bm = t.match(/presupuesto\s+(\w+)\s+(\d+(?:[.,]\d+)?)/);
  if (bm) return { type: 'comando', cmd: 'set_budget', budget_cat: bm[1], budget_amount: parseFloat(bm[2].replace(',', '.')) };

  // Income patterns
  const incPat = t.match(/(?:ingres[eé]|recibi[oó]|gané|gane|cobré|cobre|deposité|deposite|entró|entro)\s+(\d+(?:[.,]\d+)?)\s*(.*)?/i);
  if (incPat) {
    const amount = parseFloat(incPat[1].replace(',', '.'));
    const desc = incPat[2]?.trim() || 'Ingreso';
    return { type: 'ingreso', amount, desc, cat: detectCat(desc + ' ' + t), account: detectAcc(t) };
  }

  // Expense patterns
  const expPat = t.match(/(?:gast[eé]|pagu[eé]|compr[eé]|desembolsé|desembolse)\s+(\d+(?:[.,]\d+)?)\s*(?:en\s+|de\s+)?(.*)?/i);
  if (expPat) {
    const amount = parseFloat(expPat[1].replace(',', '.'));
    const desc = expPat[2]?.trim() || 'Gasto';
    return { type: 'egreso', amount, desc, cat: detectCat(desc + ' ' + t), account: detectAcc(t) };
  }

  // Pattern: number + "en/de/para" + description
  const numPat = t.match(/(\d+(?:[.,]\d+)?)\s+(?:en|de|para)\s+(.+)/i);
  if (numPat) {
    const amount = parseFloat(numPat[1].replace(',', '.'));
    const desc = numPat[2].trim();
    return { type: 'egreso', amount, desc, cat: detectCat(desc + ' ' + t), account: detectAcc(t) };
  }

  return null;
}

// ========== BOT HANDLER ==========
async function handleMessage(msgText) {
  try {
    const data = await loadData();
    const now  = new Date();
    const month = now.getMonth();
    const year  = now.getFullYear();
    const monthTxs = getMonthTxs(data.transactions, month, year);

    // Parse message: try AI first, fallback to regex
    let parsed = await parseWithAI(msgText) || fallbackParse(msgText);

    if (!parsed) {
      return `🤔 No entendí ese mensaje.\n\nEnvía *ayuda* para ver los comandos.\n\nEjemplos:\n• fui al colmado y gasté 350\n• pagué la luz 1200 con banco\n• deposité el sueldo 28000`;
    }

    const cmd = parsed.cmd;

    // ---- RESUMEN ----
    if (cmd === 'resumen') {
      const inc = monthTxs.filter(t => t.type === 'ingreso').reduce((s, t) => s + t.amount, 0);
      const exp = monthTxs.filter(t => t.type === 'egreso').reduce((s, t) => s + t.amount, 0);
      const bal = inc - exp;
      return `💰 *Resumen — ${MONTHS[month]} ${year}*\n\n▲ Ingresos: *${fmt(inc)}*\n▼ Egresos: *${fmt(exp)}*\n\n${bal >= 0 ? '✅' : '🚨'} Balance: *${fmt(bal)}*\n\n_${monthTxs.length} movimiento(s)_\n\nEnvía *cuentas* para ver por cuenta.`;
    }

    // ---- VER CUENTAS ----
    if (cmd === 'ver_cuentas') {
      const accs = ['efectivo', 'banco', 'tarjeta'];
      const lines = accs.map(acc => {
        const inc = monthTxs.filter(t => t.type === 'ingreso' && t.account === acc).reduce((s, t) => s + t.amount, 0);
        const exp = monthTxs.filter(t => t.type === 'egreso'  && t.account === acc).reduce((s, t) => s + t.amount, 0);
        return `${ACC_EMOJIS[acc]} *${acc.charAt(0).toUpperCase() + acc.slice(1)}*\n   ▲ ${fmt(inc)}  ▼ ${fmt(exp)}\n   Balance: ${fmt(inc - exp)}`;
      });
      return `🏦 *Cuentas — ${MONTHS[month]}*\n\n${lines.join('\n\n')}`;
    }

    // ---- ALERTAS ----
    if (cmd === 'alertas') {
      const inc = monthTxs.filter(t => t.type === 'ingreso').reduce((s, t) => s + t.amount, 0);
      const exp = monthTxs.filter(t => t.type === 'egreso').reduce((s, t) => s + t.amount, 0);
      const alerts = [];
      if (inc > 0) {
        const pct = (exp / inc) * 100;
        if (pct >= 100) alerts.push(`🚨 Egresos superaron ingresos (${pct.toFixed(0)}%)`);
        else if (pct >= 80) alerts.push(`⚠️ Gastaste el ${pct.toFixed(0)}% de tus ingresos`);
        else alerts.push(`✅ Finanzas saludables (${pct.toFixed(0)}% gastado)`);
      }
      for (const [cat, limit] of Object.entries(data.budgets)) {
        const spent = monthTxs.filter(t => t.type === 'egreso' && t.cat === cat).reduce((s, t) => s + t.amount, 0);
        const pct = (spent / limit) * 100;
        const e = CAT_EMOJIS[cat] || '📦';
        if (pct >= 100) alerts.push(`🚨 ${e} ${cat}: SUPERADO (${fmt(spent)})`);
        else if (pct >= 80) alerts.push(`⚠️ ${e} ${cat}: ${pct.toFixed(0)}% usado`);
      }
      return `🔔 *Alertas — ${MONTHS[month]}*\n\n${alerts.join('\n') || 'Sin alertas ✅'}`;
    }

    // ---- HISTORIAL ----
    if (cmd === 'historial') {
      const last5 = [...monthTxs].reverse().slice(0, 5);
      if (!last5.length) return `📭 Sin movimientos en ${MONTHS[month]}`;
      const lines = last5.map(t => {
        const e = CAT_EMOJIS[t.cat] || '📦';
        const ae = ACC_EMOJIS[t.account] || '💵';
        return `${t.type === 'ingreso' ? '▲' : '▼'} ${e} ${t.desc} — ${fmt(t.amount)} ${ae}`;
      });
      return `📋 *Últimos movimientos — ${MONTHS[month]}*\n\n${lines.join('\n')}`;
    }

    // ---- PRESUPUESTO ----
    if (cmd === 'presupuesto') {
      if (!Object.keys(data.budgets).length) return '📊 Sin presupuestos configurados.\n\nEnvía: *presupuesto comida 5000*';
      const lines = Object.entries(data.budgets).map(([cat, limit]) => {
        const spent = monthTxs.filter(t => t.type === 'egreso' && t.cat === cat).reduce((s, t) => s + t.amount, 0);
        const pct = ((spent / limit) * 100).toFixed(0);
        const dot = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢';
        return `${dot} ${CAT_EMOJIS[cat] || '📦'} ${cat}: ${fmt(spent)} / ${fmt(limit)} (${pct}%)`;
      });
      return `📊 *Presupuestos — ${MONTHS[month]}*\n\n${lines.join('\n')}`;
    }

    // ---- SET BUDGET ----
    if (cmd === 'set_budget') {
      const cat   = parsed.budget_cat;
      const limit = parsed.budget_amount;
      if (!cat || !limit || limit <= 0) return '❌ Formato incorrecto.\n\nUsa: *presupuesto comida 5000*';
      data.budgets[cat] = limit;
      await saveData(data);
      return `✅ Presupuesto configurado:\n\n${CAT_EMOJIS[cat] || '📦'} *${cat}*: ${fmt(limit)} / mes`;
    }

    // ---- AYUDA ----
    if (cmd === 'ayuda') {
      return `🤖 *MisCuentas Bot*\n\n*Registrar (lenguaje natural):*\nfui al colmado y gasté 350\npagué la luz 1200 con banco\ndeposité el sueldo 28000\ncompré ropa con tarjeta 800\n\n*Consultar:*\nresumen — balance del mes\ncuentas — ver por cuenta\nalertas — ver alertas\nhistorial — últimos movimientos\npresupuesto — ver límites\n\n*Configurar:*\npresupuesto comida 5000\n\n💵 Efectivo  🏦 Banco  💳 Tarjeta`;
    }

    // ---- TRANSACTION ----
    if (parsed.type === 'ingreso' || parsed.type === 'egreso') {
      if (!parsed.amount || parsed.amount <= 0) {
        return `🤔 No identifiqué el monto.\n\nEjemplo: *gasté 500 en comida*`;
      }

      const account = parsed.account || 'efectivo';
      const tx = {
        id:      Date.now(),
        type:    parsed.type,
        amount:  parsed.amount,
        desc:    parsed.desc || (parsed.type === 'ingreso' ? 'Ingreso' : 'Gasto'),
        cat:     parsed.cat  || 'otro',
        account,
        date:    now.toISOString().split('T')[0],
      };

      data.transactions.push(tx);
      await saveData(data);

      const emoji  = CAT_EMOJIS[tx.cat] || '📦';
      const accEmoji = ACC_EMOJIS[account] || '💵';
      const word   = tx.type === 'ingreso' ? 'Ingreso' : 'Egreso';
      const sign   = tx.type === 'ingreso' ? '▲' : '▼';

      let budgetAlert = '';
      if (tx.type === 'egreso' && data.budgets[tx.cat]) {
        const limit = data.budgets[tx.cat];
        const total = getMonthTxs(data.transactions, month, year)
          .filter(t => t.type === 'egreso' && t.cat === tx.cat)
          .reduce((s, t) => s + t.amount, 0);
        const pct = (total / limit) * 100;
        if (pct >= 100) budgetAlert = `\n\n⚠️ *Alerta:* Superaste el presupuesto de ${emoji} ${tx.cat}`;
        else if (pct >= 80) budgetAlert = `\n\n⚠️ *Aviso:* Llevas el ${pct.toFixed(0)}% del presupuesto de ${emoji} ${tx.cat}`;
      }

      return `✅ *${word} registrado*\n\n${sign} ${emoji} ${tx.desc}\n💵 ${fmt(tx.amount)}\n${accEmoji} ${account.charAt(0).toUpperCase() + account.slice(1)}\n📂 ${tx.cat}\n📅 ${tx.date}${budgetAlert}`;
    }

    return `🤔 No entendí ese mensaje.\n\nEnvía *ayuda* para ver los comandos.`;

  } catch (e) {
    console.error('handleMessage error:', e.message);
    return '❌ Ocurrió un error interno. Intenta de nuevo.';
  }
}

// ========== ROUTES ==========
app.get('/', (req, res) => res.send('✅ MisCuentas Bot activo'));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.post('/webhook', async (req, res) => {
  try {
    const msg   = (req.body.Body || '').trim();
    const reply = await handleMessage(msg);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.type('text/xml').send(twiml.toString());
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.status(500).send('Error');
  }
});

app.options('/api/data', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(200);
});

app.get('/api/data', async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const data = await loadData();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/data', async (req, res) => {
  try {
    res.setHeader('Access-Control-Allow-Origin', '*');
    await saveData(req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 MisCuentas Bot v3 — puerto ${PORT}`));
