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

// ========== SESSION STORE (in-memory, never expires) ==========
// { phone: true }
const sessions = {};

// ========== PIN ATTEMPT TRACKING ==========
// { phone: { attempts: 0, lockedUntil: null } }
const pinAttempts = {};
const MAX_ATTEMPTS = 3;

// ========== PENDING STATE ==========
// Tracks what we're waiting for from each user
const pending = {};
const tempPin = {};

// ========== DATA ==========
// Root structure: { users: { "+18091234567": { pin: "1234", transactions: [], budgets: {} } } }

async function loadAllData() {
  try {
    const res = await fetch(`${JSONBIN_URL}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY },
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const record = json.record || {};
    if (record.transactions && !record.users) return { users: {} };
    return record.users ? record : { users: {} };
  } catch (e) {
    console.error('loadAllData error:', e.message);
    return { users: {} };
  }
}

async function saveAllData(data) {
  try {
    const res = await fetch(JSONBIN_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Master-Key': JSONBIN_API_KEY },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
  } catch (e) {
    console.error('saveAllData error:', e.message);
  }
}

function getUser(allData, phone) {
  if (!allData.users[phone]) {
    allData.users[phone] = { pin: null, transactions: [], budgets: {} };
  }
  return allData.users[phone];
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

function isValidPin(str) {
  return /^\d{4}$/.test(str);
}

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
"cambiar pin" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"cambiar_pin","budget_cat":null,"budget_amount":null}

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
    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) return null;
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
  ropa:            ['ropa','zapatos','camisa','pantalon','tienda','calzado'],
  educacion:       ['escuela','universidad','libro','curso','colegio','matricula','educacion'],
  salario:         ['salario','sueldo','quincena','nomina','deposite','deposito'],
  negocio:         ['negocio','venta','cobro','cliente','factura','mercancia'],
  inversion:       ['inversion','dividendo','interes','acciones','bolsa'],
  ahorro:          ['ahorro','ahorros','fondo'],
  prestamo:        ['prestamo','deuda','cuota'],
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
  const cmds = {
    'resumen':'resumen','balance':'resumen','hoy':'resumen','cuanto tengo':'resumen',
    'alertas':'alertas','alerta':'alertas',
    'ayuda':'ayuda','help':'ayuda','comandos':'ayuda',
    'ver cuentas':'ver_cuentas','cuentas':'ver_cuentas','mis cuentas':'ver_cuentas',
    'presupuesto':'presupuesto','historial':'historial','lista':'historial',
    'cambiar pin':'cambiar_pin','cambiarpin':'cambiar_pin','nuevo pin':'cambiar_pin',
  };
  if (cmds[t]) return { type: 'comando', cmd: cmds[t] };

  const bm = t.match(/presupuesto\s+(\w+)\s+(\d+(?:[.,]\d+)?)/);
  if (bm) return { type: 'comando', cmd: 'set_budget', budget_cat: bm[1], budget_amount: parseFloat(bm[2].replace(',', '.')) };

  const incPat = t.match(/(?:ingres[eé]|recibi[oó]|gané|gane|cobré|cobre|deposité|deposite|entró|entro)\s+(\d+(?:[.,]\d+)?)\s*(.*)?/i);
  if (incPat) {
    const amount = parseFloat(incPat[1].replace(',', '.'));
    const desc = incPat[2]?.trim() || 'Ingreso';
    return { type: 'ingreso', amount, desc, cat: detectCat(desc+' '+t), account: detectAcc(t) };
  }

  const expPat = t.match(/(?:gast[eé]|pagu[eé]|compr[eé]|desembolsé|desembolse)\s+(\d+(?:[.,]\d+)?)\s*(?:en\s+|de\s+)?(.*)?/i);
  if (expPat) {
    const amount = parseFloat(expPat[1].replace(',', '.'));
    const desc = expPat[2]?.trim() || 'Gasto';
    return { type: 'egreso', amount, desc, cat: detectCat(desc+' '+t), account: detectAcc(t) };
  }

  const numPat = t.match(/(\d+(?:[.,]\d+)?)\s+(?:en|de|para)\s+(.+)/i);
  if (numPat) {
    const amount = parseFloat(numPat[1].replace(',', '.'));
    const desc = numPat[2].trim();
    return { type: 'egreso', amount, desc, cat: detectCat(desc+' '+t), account: detectAcc(t) };
  }

  return null;
}

// ========== BOT HANDLER ==========
async function handleMessage(msgText, phone) {
  try {
    const allData = await loadAllData();
    const user    = getUser(allData, phone);
    const now     = new Date();
    const month   = now.getMonth();
    const year    = now.getFullYear();
    const msg     = msgText.trim();

    // ── New user: no PIN set ──
    if (!user.pin) {
      if (pending[phone] === 'awaiting_new_pin') {
        if (!isValidPin(msg)) return '❌ El PIN debe ser exactamente *4 dígitos numéricos*.\n\nEjemplo: 1234\n\nIngresa tu nuevo PIN:';
        tempPin[phone] = msg;
        pending[phone] = 'awaiting_pin_confirm';
        return '🔒 Confirma tu PIN ingresándolo de nuevo:';
      }
      if (pending[phone] === 'awaiting_pin_confirm') {
        if (msg !== tempPin[phone]) {
          pending[phone] = 'awaiting_new_pin';
          delete tempPin[phone];
          return '❌ Los PINs no coinciden. Inténtalo de nuevo.\n\nIngresa un PIN de *4 dígitos*:';
        }
        user.pin = msg;
        allData.users[phone] = user;
        await saveAllData(allData);
        sessions[phone] = true;
        delete pending[phone];
        delete tempPin[phone];
        return `✅ *¡PIN creado exitosamente!*\n\n🎉 Bienvenido a *MisCuentas RD*\n\nYa puedes registrar tus gastos e ingresos.\n\nEnvía *ayuda* para ver todos los comandos.`;
      }
      pending[phone] = 'awaiting_new_pin';
      return `👋 ¡Bienvenido a *MisCuentas RD*!\n\nPara proteger tus datos, crea un *PIN de 4 dígitos*.\n\nEste PIN es tuyo y privado. Recuérdalo bien.\n\nIngresa tu PIN:`;
    }

    // ── PIN change flow ──
    if (pending[phone] === 'awaiting_change_pin_new') {
      if (!isValidPin(msg)) return '❌ El PIN debe ser exactamente *4 dígitos numéricos*.\n\nIngresa tu nuevo PIN:';
      tempPin[phone] = msg;
      pending[phone] = 'awaiting_change_pin_confirm';
      return '🔒 Confirma el nuevo PIN:';
    }
    if (pending[phone] === 'awaiting_change_pin_confirm') {
      if (msg !== tempPin[phone]) {
        pending[phone] = 'awaiting_change_pin_new';
        delete tempPin[phone];
        return '❌ Los PINs no coinciden.\n\nIngresa el nuevo PIN de nuevo:';
      }
      user.pin = msg;
      allData.users[phone] = user;
      await saveAllData(allData);
      sessions[phone] = true;
      delete pending[phone];
      delete tempPin[phone];
      return '✅ *PIN actualizado correctamente.*\n\nUsa el nuevo PIN la próxima vez que inicies sesión.';
    }

    // ── Authentication ──
    if (!sessions[phone]) {
      const att = pinAttempts[phone] || { attempts: 0 };
      if (att.lockedUntil && new Date() < att.lockedUntil) {
        const mins = Math.ceil((att.lockedUntil - new Date()) / 60000);
        return `🔒 Demasiados intentos fallidos. Espera *${mins} minuto(s)* e intenta de nuevo.`;
      }
      if (pending[phone] !== 'awaiting_login_pin') {
        pending[phone] = 'awaiting_login_pin';
        return `🔐 ¡Hola! Ingresa tu *PIN de 4 dígitos* para acceder a MisCuentas:`;
      }
      if (msg === user.pin) {
        sessions[phone] = true;
        pinAttempts[phone] = { attempts: 0 };
        delete pending[phone];
        return `✅ *Acceso concedido*\n\n¡Hola! Estás dentro de MisCuentas RD.\n\nEnvía *ayuda* para ver los comandos.`;
      } else {
        att.attempts = (att.attempts || 0) + 1;
        if (att.attempts >= MAX_ATTEMPTS) {
          att.lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
          pinAttempts[phone] = att;
          return `🚨 *3 intentos fallidos.* Cuenta bloqueada por *5 minutos*.\n\nSi olvidaste tu PIN, escribe *resetpin* para crear uno nuevo (borrará tu PIN actual).`;
        }
        pinAttempts[phone] = att;
        const left = MAX_ATTEMPTS - att.attempts;
        return `❌ PIN incorrecto. Te quedan *${left} intento(s)*.\n\nIngresa tu PIN:`;
      }
    }

    // ── Reset PIN (authenticated) ──
    if (msg.toLowerCase() === 'resetpin' || msg.toLowerCase() === 'reset pin') {
      pending[phone] = 'awaiting_change_pin_new';
      return `🔑 *Cambiar PIN*\n\nIngresa tu nuevo PIN de *4 dígitos*:`;
    }

    const monthTxs = getMonthTxs(user.transactions, month, year);
    let parsed = await parseWithAI(msg) || fallbackParse(msg);

    if (parsed?.cmd === 'cambiar_pin') {
      pending[phone] = 'awaiting_change_pin_new';
      return `🔑 *Cambiar PIN*\n\nIngresa tu nuevo PIN de *4 dígitos*:`;
    }

    if (!parsed) {
      return `🤔 No entendí ese mensaje.\n\nEnvía *ayuda* para ver los comandos.\n\nEjemplos:\n• fui al colmado y gasté 350\n• pagué la luz 1200 con banco\n• deposité el sueldo 28000`;
    }

    const cmd = parsed.cmd;

    if (cmd === 'resumen') {
      const inc = monthTxs.filter(t => t.type === 'ingreso').reduce((s,t) => s+t.amount, 0);
      const exp = monthTxs.filter(t => t.type === 'egreso').reduce((s,t) => s+t.amount, 0);
      const bal = inc - exp;
      return `💰 *Resumen — ${MONTHS[month]} ${year}*\n\n▲ Ingresos: *${fmt(inc)}*\n▼ Egresos: *${fmt(exp)}*\n\n${bal >= 0 ? '✅' : '🚨'} Balance: *${fmt(bal)}*\n\n_${monthTxs.length} movimiento(s)_`;
    }

    if (cmd === 'ver_cuentas') {
      const accs = ['efectivo','banco','tarjeta'];
      const lines = accs.map(acc => {
        const inc = monthTxs.filter(t => t.type==='ingreso' && t.account===acc).reduce((s,t)=>s+t.amount,0);
        const exp = monthTxs.filter(t => t.type==='egreso'  && t.account===acc).reduce((s,t)=>s+t.amount,0);
        return `${ACC_EMOJIS[acc]} *${acc.charAt(0).toUpperCase()+acc.slice(1)}*\n   ▲ ${fmt(inc)}  ▼ ${fmt(exp)}\n   Balance: ${fmt(inc-exp)}`;
      });
      return `🏦 *Cuentas — ${MONTHS[month]}*\n\n${lines.join('\n\n')}`;
    }

    if (cmd === 'alertas') {
      const inc = monthTxs.filter(t => t.type==='ingreso').reduce((s,t)=>s+t.amount,0);
      const exp = monthTxs.filter(t => t.type==='egreso').reduce((s,t)=>s+t.amount,0);
      const alerts = [];
      if (inc > 0) {
        const pct = (exp/inc)*100;
        if (pct >= 100) alerts.push(`🚨 Egresos superaron ingresos (${pct.toFixed(0)}%)`);
        else if (pct >= 80) alerts.push(`⚠️ Gastaste el ${pct.toFixed(0)}% de tus ingresos`);
        else alerts.push(`✅ Finanzas saludables (${pct.toFixed(0)}% gastado)`);
      }
      for (const [cat, limit] of Object.entries(user.budgets)) {
        const spent = monthTxs.filter(t=>t.type==='egreso'&&t.cat===cat).reduce((s,t)=>s+t.amount,0);
        const pct = (spent/limit)*100;
        const e = CAT_EMOJIS[cat]||'📦';
        if (pct>=100) alerts.push(`🚨 ${e} ${cat}: SUPERADO (${fmt(spent)})`);
        else if (pct>=80) alerts.push(`⚠️ ${e} ${cat}: ${pct.toFixed(0)}% usado`);
      }
      return `🔔 *Alertas — ${MONTHS[month]}*\n\n${alerts.join('\n')||'Sin alertas ✅'}`;
    }

    if (cmd === 'historial') {
      const last5 = [...monthTxs].reverse().slice(0,5);
      if (!last5.length) return `📭 Sin movimientos en ${MONTHS[month]}`;
      const lines = last5.map(t => `${t.type==='ingreso'?'▲':'▼'} ${CAT_EMOJIS[t.cat]||'📦'} ${t.desc} — ${fmt(t.amount)} ${ACC_EMOJIS[t.account]||'💵'}`);
      return `📋 *Últimos movimientos — ${MONTHS[month]}*\n\n${lines.join('\n')}`;
    }

    if (cmd === 'presupuesto') {
      if (!Object.keys(user.budgets).length) return '📊 Sin presupuestos configurados.\n\nEnvía: *presupuesto comida 5000*';
      const lines = Object.entries(user.budgets).map(([cat, limit]) => {
        const spent = monthTxs.filter(t=>t.type==='egreso'&&t.cat===cat).reduce((s,t)=>s+t.amount,0);
        const pct = ((spent/limit)*100).toFixed(0);
        const dot = pct>=100?'🔴':pct>=80?'🟡':'🟢';
        return `${dot} ${CAT_EMOJIS[cat]||'📦'} ${cat}: ${fmt(spent)} / ${fmt(limit)} (${pct}%)`;
      });
      return `📊 *Presupuestos — ${MONTHS[month]}*\n\n${lines.join('\n')}`;
    }

    if (cmd === 'set_budget') {
      const cat = parsed.budget_cat, limit = parsed.budget_amount;
      if (!cat||!limit||limit<=0) return '❌ Formato incorrecto.\n\nUsa: *presupuesto comida 5000*';
      user.budgets[cat] = limit;
      allData.users[phone] = user;
      await saveAllData(allData);
      return `✅ Presupuesto configurado:\n\n${CAT_EMOJIS[cat]||'📦'} *${cat}*: ${fmt(limit)} / mes`;
    }

    if (cmd === 'ayuda') {
      return `🤖 *MisCuentas Bot*\n\n*Registrar (lenguaje natural):*\nfui al colmado y gasté 350\npagué la luz 1200 con banco\ndeposité el sueldo 28000\ncompré ropa con tarjeta 800\n\n*Consultar:*\nresumen — balance del mes\ncuentas — ver por cuenta\nalertas — ver alertas\nhistorial — últimos movimientos\npresupuesto — ver límites\n\n*Configurar:*\npresupuesto comida 5000\ncambiar pin — cambiar tu PIN\n\n💵 Efectivo  🏦 Banco  💳 Tarjeta`;
    }

    if (parsed.type === 'ingreso' || parsed.type === 'egreso') {
      if (!parsed.amount || parsed.amount <= 0) return `🤔 No identifiqué el monto.\n\nEjemplo: *gasté 500 en comida*`;
      const account = parsed.account || 'efectivo';
      const tx = {
        id: Date.now(), type: parsed.type, amount: parsed.amount,
        desc: parsed.desc || (parsed.type==='ingreso'?'Ingreso':'Gasto'),
        cat: parsed.cat || 'otro', account,
        date: now.toISOString().split('T')[0],
      };
      user.transactions.push(tx);
      allData.users[phone] = user;
      await saveAllData(allData);

      const emoji = CAT_EMOJIS[tx.cat]||'📦';
      const accEmoji = ACC_EMOJIS[account]||'💵';
      const word = tx.type==='ingreso'?'Ingreso':'Egreso';
      const sign = tx.type==='ingreso'?'▲':'▼';

      let budgetAlert = '';
      if (tx.type==='egreso' && user.budgets[tx.cat]) {
        const limit = user.budgets[tx.cat];
        const total = getMonthTxs(user.transactions, month, year)
          .filter(t=>t.type==='egreso'&&t.cat===tx.cat).reduce((s,t)=>s+t.amount,0);
        const pct = (total/limit)*100;
        if (pct>=100) budgetAlert=`\n\n⚠️ *Alerta:* Superaste el presupuesto de ${emoji} ${tx.cat}`;
        else if (pct>=80) budgetAlert=`\n\n⚠️ *Aviso:* Llevas el ${pct.toFixed(0)}% del presupuesto de ${emoji} ${tx.cat}`;
      }
      return `✅ *${word} registrado*\n\n${sign} ${emoji} ${tx.desc}\n💵 ${fmt(tx.amount)}\n${accEmoji} ${account.charAt(0).toUpperCase()+account.slice(1)}\n📂 ${tx.cat}\n📅 ${tx.date}${budgetAlert}`;
    }

    return `🤔 No entendí ese mensaje.\n\nEnvía *ayuda* para ver los comandos.`;

  } catch (e) {
    console.error('handleMessage error:', e.message);
    return '❌ Ocurrió un error interno. Intenta de nuevo.';
  }
}

// ========== ROUTES ==========
app.get('/', (req, res) => res.send('✅ MisCuentas Bot v4 — Multi-usuario activo'));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.post('/webhook', async (req, res) => {
  try {
    const msg   = (req.body.Body || '').trim();
    const phone = (req.body.From || '').replace('whatsapp:', '');
    if (!phone) return res.status(400).send('No phone');
    const reply = await handleMessage(msg, phone);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.type('text/xml').send(twiml.toString());
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.status(500).send('Error');
  }
});

// CORS helper
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

app.options('/api/login',         (req, res) => { cors(res); res.sendStatus(200); });
app.options('/api/data/:phone',   (req, res) => { cors(res); res.sendStatus(200); });

// Login (verify PIN from web)
app.post('/api/login', async (req, res) => {
  try {
    cors(res);
    const { phone, pin } = req.body;
    if (!phone || !pin) return res.status(400).json({ error: 'phone and pin required' });
    const allData = await loadAllData();
    const user = allData.users[phone];
    if (!user || !user.pin) return res.status(404).json({ error: 'user_not_found' });
    if (user.pin !== pin)   return res.status(401).json({ error: 'invalid_pin' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get user data
app.get('/api/data/:phone', async (req, res) => {
  try {
    cors(res);
    const phone = decodeURIComponent(req.params.phone);
    const { pin } = req.query;
    if (!pin) return res.status(401).json({ error: 'pin required' });
    const allData = await loadAllData();
    const user = allData.users[phone];
    if (!user || !user.pin) return res.status(404).json({ error: 'user_not_found' });
    if (user.pin !== pin)   return res.status(401).json({ error: 'invalid_pin' });
    res.json({ transactions: user.transactions, budgets: user.budgets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save user data
app.post('/api/data/:phone', async (req, res) => {
  try {
    cors(res);
    const phone = decodeURIComponent(req.params.phone);
    const { pin } = req.query;
    if (!pin) return res.status(401).json({ error: 'pin required' });
    const allData = await loadAllData();
    const user = allData.users[phone];
    if (!user || !user.pin) return res.status(404).json({ error: 'user_not_found' });
    if (user.pin !== pin)   return res.status(401).json({ error: 'invalid_pin' });
    if (req.body.transactions !== undefined) user.transactions = req.body.transactions;
    if (req.body.budgets !== undefined)      user.budgets      = req.body.budgets;
    allData.users[phone] = user;
    await saveAllData(allData);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 MisCuentas Bot v4 Multi-Usuario — puerto ${PORT}`));
