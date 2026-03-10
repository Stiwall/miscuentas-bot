const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.json());

// ========== JSONBIN CONFIG ==========
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID  = process.env.JSONBIN_BIN_ID;
const JSONBIN_URL     = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

// ========== DATA HELPERS ==========
async function loadData() {
  try {
    const res = await fetch(`${JSONBIN_URL}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY }
    });
    const json = await res.json();
    return json.record || { transactions: [], budgets: {} };
  } catch (e) {
    console.error('Error cargando datos:', e.message);
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
    console.error('Error guardando datos:', e.message);
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

const CAT_KEYWORDS = {
  comida:         ['comida','almuerzo','desayuno','cena','restaurante','mercado','supermercado','colmado','pizza','pollo'],
  transporte:     ['transporte','gasolina','taxi','uber','carro','bus','metro','combustible'],
  servicios:      ['luz','agua','internet','telefono','teléfono','claro','altice','edesur','edenorte','netflix','spotify'],
  salud:          ['salud','medico','médico','farmacia','medicina','doctor','clinica','clínica','hospital'],
  entretenimiento:['entretenimiento','cine','fiesta','salida','bar','disco','juego','viaje'],
  ropa:           ['ropa','zapatos','camisa','pantalon','pantalón','zapato','tienda'],
  educacion:      ['educacion','educación','escuela','universidad','libro','curso','colegio'],
  salario:        ['salario','sueldo','pago','quincena','nomina','nómina'],
  negocio:        ['negocio','venta','cobro','cliente','factura'],
  inversion:      ['inversion','inversión','dividendo','interés','interes','ahorro'],
};

function detectCategory(text) {
  const lower = text.toLowerCase();
  for (const [cat, keywords] of Object.entries(CAT_KEYWORDS)) {
    if (keywords.some(k => lower.includes(k))) return cat;
  }
  return 'otro';
}

const CAT_EMOJIS = {
  comida:'🍽️', transporte:'🚗', servicios:'💡', salud:'🏥',
  entretenimiento:'🎬', ropa:'👕', educacion:'📚', salario:'💼',
  negocio:'🏪', inversion:'📈', otro:'📦', otro_inc:'💰', otro_exp:'📦'
};

// ========== MESSAGE PARSER ==========
function parseMessage(msg) {
  const text = msg.trim().toLowerCase();

  // Commands
  if (text === 'resumen' || text === 'balance' || text === 'hoy') return { cmd: 'resumen' };
  if (text === 'alertas' || text === 'alerta') return { cmd: 'alertas' };
  if (text === 'ayuda' || text === 'help' || text === 'comandos') return { cmd: 'ayuda' };
  if (text.startsWith('presupuesto') && text.includes(' ')) return { cmd: 'set_budget', text };
  if (text === 'presupuesto') return { cmd: 'ver_presupuesto' };
  if (text === 'historial' || text === 'lista') return { cmd: 'historial' };

  // INGRESO patterns
  // "ingresé 15000 salario" / "recibí 5000 de negocio" / "gané 3000"
  const incPatterns = [
    /(?:ingres[eé]|recibi[oó]|recebi|gané|gane|cobré|cobre|entró|entro)\s+(\d+(?:[.,]\d+)?)\s*(.*)?/i,
    /(\d+(?:[.,]\d+)?)\s+(?:de\s+)?(?:ingreso|entrada|income)\s*(.*)?/i,
  ];

  for (const pattern of incPatterns) {
    const m = text.match(pattern);
    if (m) {
      const amount = parseFloat(m[1].replace(',', '.'));
      const desc = (m[2] || '').trim() || 'Ingreso';
      const cat = detectCategory(desc || text);
      return { cmd: 'add', type: 'ingreso', amount, desc: desc || 'Ingreso', cat };
    }
  }

  // EGRESO patterns
  // "gasté 500 en comida" / "pagué 1200 luz" / "compré 800 ropa"
  const expPatterns = [
    /(?:gast[eé]|pagu[eé]|compr[eé]|pagué|pague|gasté|gaste|desembolsé)\s+(\d+(?:[.,]\d+)?)\s*(?:en\s+)?(.*)?/i,
    /(\d+(?:[.,]\d+)?)\s+(?:en|de|para)\s+(.*)/i,
  ];

  for (const pattern of expPatterns) {
    const m = text.match(pattern);
    if (m) {
      const amount = parseFloat(m[1].replace(',', '.'));
      const desc = (m[2] || '').trim() || 'Gasto';
      const cat = detectCategory(desc || text);
      return { cmd: 'add', type: 'egreso', amount, desc: desc || 'Gasto', cat };
    }
  }

  return { cmd: 'unknown', text: msg };
}

// ========== BOT LOGIC ==========
async function handleMessage(msgText) {
  const data = await loadData();
  const parsed = parseMessage(msgText);
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();
  const monthTxs = getMonthTxs(data.transactions, month, year);

  switch (parsed.cmd) {

    case 'add': {
      const tx = {
        id: Date.now(),
        type: parsed.type,
        amount: parsed.amount,
        desc: parsed.desc,
        cat: parsed.cat,
        date: now.toISOString().split('T')[0],
      };
      data.transactions.push(tx);
      await saveData(data);

      const emoji = CAT_EMOJIS[parsed.cat] || '📦';
      const sign = parsed.type === 'ingreso' ? '▲' : '▼';
      const word = parsed.type === 'ingreso' ? 'Ingreso' : 'Egreso';

      // Check budget alert
      let budgetAlert = '';
      if (parsed.type === 'egreso' && data.budgets[parsed.cat]) {
        const limit = data.budgets[parsed.cat];
        const totalCat = getMonthTxs(data.transactions, month, year)
          .filter(t => t.type === 'egreso' && t.cat === parsed.cat)
          .reduce((s, t) => s + t.amount, 0);
        const pct = (totalCat / limit) * 100;
        if (pct >= 100) budgetAlert = `\n\n⚠️ *Alerta:* Superaste el presupuesto de ${emoji} ${parsed.cat} (${fmt(totalCat)} / ${fmt(limit)})`;
        else if (pct >= 80) budgetAlert = `\n\n⚠️ *Aviso:* Llevas el ${pct.toFixed(0)}% del presupuesto de ${emoji} ${parsed.cat}`;
      }

      return `✅ *${word} registrado*\n\n${sign} ${emoji} ${parsed.desc}\n💵 ${fmt(parsed.amount)}\n📂 ${parsed.cat}\n📅 ${tx.date}${budgetAlert}`;
    }

    case 'resumen': {
      const inc = monthTxs.filter(t => t.type === 'ingreso').reduce((s, t) => s + t.amount, 0);
      const exp = monthTxs.filter(t => t.type === 'egreso').reduce((s, t) => s + t.amount, 0);
      const bal = inc - exp;
      const balEmoji = bal >= 0 ? '✅' : '🚨';
      return `💰 *Resumen — ${MONTHS[month]} ${year}*\n\n▲ Ingresos: *${fmt(inc)}*\n▼ Egresos: *${fmt(exp)}*\n\n${balEmoji} Balance: *${fmt(bal)}*\n\n_${monthTxs.length} movimiento(s) este mes_`;
    }

    case 'alertas': {
      const inc = monthTxs.filter(t => t.type === 'ingreso').reduce((s, t) => s + t.amount, 0);
      const exp = monthTxs.filter(t => t.type === 'egreso').reduce((s, t) => s + t.amount, 0);
      let alerts = [];

      if (inc > 0) {
        const pct = (exp / inc) * 100;
        if (pct >= 100) alerts.push(`🚨 Egresos superaron ingresos (${pct.toFixed(0)}%)`);
        else if (pct >= 80) alerts.push(`⚠️ Gastaste el ${pct.toFixed(0)}% de tus ingresos`);
        else alerts.push(`✅ Finanzas saludables (${pct.toFixed(0)}% gastado)`);
      }

      for (const [cat, limit] of Object.entries(data.budgets)) {
        const spent = monthTxs.filter(t => t.type === 'egreso' && t.cat === cat).reduce((s, t) => s + t.amount, 0);
        const pct = (spent / limit) * 100;
        const emoji = CAT_EMOJIS[cat] || '📦';
        if (pct >= 100) alerts.push(`🚨 ${emoji} ${cat}: ${fmt(spent)} / ${fmt(limit)} (SUPERADO)`);
        else if (pct >= 80) alerts.push(`⚠️ ${emoji} ${cat}: ${pct.toFixed(0)}% usado`);
      }

      return `🔔 *Alertas — ${MONTHS[month]}*\n\n${alerts.join('\n') || 'Sin alertas activas ✅'}`;
    }

    case 'historial': {
      const last5 = [...monthTxs].reverse().slice(0, 5);
      if (!last5.length) return `📭 No hay movimientos en ${MONTHS[month]}`;
      const lines = last5.map(t => {
        const emoji = CAT_EMOJIS[t.cat] || '📦';
        const sign = t.type === 'ingreso' ? '▲' : '▼';
        return `${sign} ${emoji} ${t.desc} — ${fmt(t.amount)}`;
      });
      return `📋 *Últimos movimientos*\n\n${lines.join('\n')}`;
    }

    case 'ver_presupuesto': {
      if (!Object.keys(data.budgets).length) return '📊 No tienes presupuestos configurados.\n\nEnvía: *presupuesto comida 5000* para configurar uno.';
      const lines = Object.entries(data.budgets).map(([cat, limit]) => {
        const spent = monthTxs.filter(t => t.type === 'egreso' && t.cat === cat).reduce((s, t) => s + t.amount, 0);
        const pct = limit > 0 ? ((spent / limit) * 100).toFixed(0) : 0;
        const emoji = CAT_EMOJIS[cat] || '📦';
        const bar = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢';
        return `${bar} ${emoji} ${cat}: ${fmt(spent)} / ${fmt(limit)} (${pct}%)`;
      });
      return `📊 *Presupuestos — ${MONTHS[month]}*\n\n${lines.join('\n')}`;
    }

    case 'set_budget': {
      // "presupuesto comida 5000"
      const m = parsed.text.match(/presupuesto\s+(\w+)\s+(\d+(?:[.,]\d+)?)/i);
      if (!m) return '❌ Formato incorrecto.\n\nUsa: *presupuesto [categoría] [monto]*\nEjemplo: *presupuesto comida 5000*';
      const cat = m[1].toLowerCase();
      const limit = parseFloat(m[2].replace(',', '.'));
      data.budgets[cat] = limit;
      await saveData(data);
      return `✅ Presupuesto configurado:\n\n${CAT_EMOJIS[cat] || '📦'} *${cat}*: ${fmt(limit)} / mes`;
    }

    case 'ayuda':
      return `🤖 *MisCuentas Bot — Comandos*\n\n*Registrar:*\ngasté 500 en comida\ningresé 15000 salario\npagué 1200 luz\n\n*Consultar:*\nresumen — balance del mes\nalertas — ver alertas\nhistorial — últimos 5 mov.\npresupuesto — ver límites\n\n*Configurar:*\npresupuesto comida 5000\n\n_Moneda: Pesos Dominicanos (RD$)_`;

    default:
      return `🤔 No entendí ese mensaje.\n\nEnvía *ayuda* para ver los comandos disponibles.\n\nEjemplos:\n• gasté 500 en comida\n• ingresé 15000 salario\n• resumen`;
  }
}

// ========== ROUTES ==========
app.get('/', (req, res) => res.send('✅ MisCuentas Bot activo'));

app.post('/webhook', async (req, res) => {
  const incomingMsg = req.body.Body || '';
  const reply = await handleMessage(incomingMsg);
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(reply);
  res.type('text/xml').send(twiml.toString());
});

// API para la app — leer datos
app.get('/api/data', async (req, res) => {
  const data = await loadData();
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(data);
});

// API para la app — guardar datos
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
app.listen(PORT, () => console.log(`🤖 MisCuentas Bot corriendo en puerto ${PORT}`));
