const express    = require('express');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

// ========== CONFIG ==========
const JSONBIN_API_KEY  = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID   = process.env.JSONBIN_BIN_ID;
const GEMINI_KEY       = process.env.GEMINI_API_KEY;
const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const JSONBIN_URL      = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

if (!TELEGRAM_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN no configurado');
  process.exit(1);
}

// ========== TELEGRAM BOT ==========
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

// ========== SESSION / STATE ==========
// sessions and pinAttempts stay in-memory (security: reset on restart is fine)
const sessions    = {};   // { chatId: true }
const pinAttempts = {};   // { chatId: { attempts, lockedUntil } }
const MAX_ATTEMPTS = 3;

// pending and tempPin are persisted inside user record so they survive restarts
// user.pending  = 'awaiting_new_pin' | 'awaiting_pin_confirm' | 'awaiting_login_pin' | ...
// user.tempPin  = '1234'

// ========== JSONBIN DATA ==========
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

function getUser(allData, id) {
  if (!allData.users[id]) {
    allData.users[id] = { pin: null, transactions: [], budgets: {}, pending: null, tempPin: null };
  }
  // Ensure fields exist on older records
  if (!('pending' in allData.users[id])) allData.users[id].pending = null;
  if (!('tempPin' in allData.users[id])) allData.users[id].tempPin = null;
  return allData.users[id];
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

function isValidPin(str) { return /^\d{4}$/.test(str); }

// Send with Markdown
function send(chatId, text) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
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
  const t = msg.trim().toLowerCase().replace(/^\//, '');

  // ── Commands ──
  const cmds = {
    'resumen':'resumen','balance':'resumen','hoy':'resumen','cuanto tengo':'resumen','mi balance':'resumen',
    'alertas':'alertas','alerta':'alertas',
    'ayuda':'ayuda','help':'ayuda','comandos':'ayuda','start':'ayuda',
    'ver cuentas':'ver_cuentas','cuentas':'ver_cuentas','mis cuentas':'ver_cuentas',
    'presupuesto':'presupuesto','historial':'historial','lista':'historial',
    'cambiar pin':'cambiar_pin','cambiarpin':'cambiar_pin','nuevo pin':'cambiar_pin',
    'miid':'miid',
  };
  if (cmds[t]) return { type: 'comando', cmd: cmds[t] };

  const bm = t.match(/presupuesto\s+(\w+)\s+(\d+(?:[.,]\d+)?)/);
  if (bm) return { type: 'comando', cmd: 'set_budget', budget_cat: bm[1], budget_amount: parseFloat(bm[2].replace(',', '.')) };

  // ── Extract amount from anywhere in the message ──
  const amountMatch = t.match(/(\d+(?:[.,]\d+)?)/);
  if (!amountMatch) return null;
  const amount = parseFloat(amountMatch[1].replace(',', '.'));
  if (!amount || amount <= 0) return null;

  // ── INCOME triggers (verb anywhere in message) ──
  const incomeVerbs = [
    'ingresé','ingrese','ingreso',
    'recibí','recibi','recibio','recibie',
    'gané','gane',
    'cobré','cobre','cobro',
    'deposité','deposite','deposito',
    'entró','entro',
    'me pagaron','me pago','me depositaron',
    'quincena','sueldo','salario','nomina','nómina',
    'me cayó','me cayo','me entro','me entró',
  ];
  const hasIncomeVerb = incomeVerbs.some(v => t.includes(v));

  // ── EXPENSE triggers ──
  const expenseVerbs = [
    'gasté','gaste','gasto',
    'pagué','pague','pago',
    'compré','compre','compro',
    'desembolsé','desembolse',
    'invertí','invertir','invierto',
    'fui al','fui a','me costó','me costo',
    'salí','sali','saque','saqué',
  ];
  const hasExpenseVerb = expenseVerbs.some(v => t.includes(v));

  // ── Determine type ──
  let type;
  if (hasIncomeVerb && !hasExpenseVerb) {
    type = 'ingreso';
  } else if (hasExpenseVerb && !hasIncomeVerb) {
    type = 'egreso';
  } else if (hasIncomeVerb && hasExpenseVerb) {
    // Both — expense verbs win (e.g. "gasté lo que cobré")
    type = 'egreso';
  } else {
    // No verb — try pattern: number + en/de/para = expense
    const numPat = t.match(/(\d+(?:[.,]\d+)?)\s+(?:en|de|para)\s+(.+)/i);
    if (numPat) {
      const desc = numPat[2].trim();
      return { type: 'egreso', amount, desc, cat: detectCat(desc+' '+t), account: detectAcc(t) };
    }
    return null;
  }

  // ── Build description: remove amount and verb words, keep the rest ──
  let desc = t
    .replace(/\d+(?:[.,]\d+)?/g, '')           // remove numbers
    .replace(/(?:ingresé|ingrese|recibí|recibi|recibio|gané|gane|cobré|cobre|deposité|deposite|gasté|gaste|pagué|pague|compré|compre|desembolsé|desembolse|fui\s+al|fui\s+a|me\s+costó|me\s+costo|saqué|saque)/gi, '')
    .replace(/\b(el|la|los|las|un|una|de|del|con|al|en|por|para|a|mi|mis|su|sus|lo|que|y|e|o)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!desc || desc.length < 2) {
    // Fallback desc from known keywords
    if (t.includes('quincena')) desc = 'Quincena';
    else if (t.includes('sueldo')) desc = 'Sueldo';
    else if (t.includes('salario')) desc = 'Salario';
    else if (t.includes('colmado')) desc = 'Colmado';
    else if (t.includes('luz')) desc = 'Luz';
    else if (t.includes('agua')) desc = 'Agua';
    else if (t.includes('gasolina')) desc = 'Gasolina';
    else desc = type === 'ingreso' ? 'Ingreso' : 'Gasto';
  }

  // Capitalize first letter
  desc = desc.charAt(0).toUpperCase() + desc.slice(1);

  return { type, amount, desc, cat: detectCat(t), account: detectAcc(t) };
}

// ========== MESSAGE HANDLER ==========
async function handleMessage(msgText, chatId) {
  try {
    const allData = await loadAllData();
    const id      = String(chatId);
    const user    = getUser(allData, id);
    const now     = new Date();
    const month   = now.getMonth();
    const year    = now.getFullYear();
    const msg     = msgText.trim();

    // Helper to save user state (pending/tempPin changes)
    async function saveUser() {
      allData.users[id] = user;
      await saveAllData(allData);
    }

    // ── /miid — always available ──
    if (msg.toLowerCase() === '/miid' || msg.toLowerCase() === 'miid') {
      return `🪪 Tu Telegram ID es:\n\n\`${chatId}\`\n\nÚsalo para iniciar sesión en el panel web.`;
    }

    // ── New user: create PIN ──
    if (!user.pin) {
      if (user.pending === 'awaiting_new_pin') {
        if (!isValidPin(msg)) return '❌ El PIN debe ser exactamente *4 dígitos numéricos*.\n\nEjemplo: `1234`\n\nIngresa tu nuevo PIN:';
        user.tempPin  = msg;
        user.pending  = 'awaiting_pin_confirm';
        await saveUser();
        return '🔒 Confirma tu PIN ingresándolo de nuevo:';
      }
      if (user.pending === 'awaiting_pin_confirm') {
        if (msg !== user.tempPin) {
          user.pending = 'awaiting_new_pin';
          user.tempPin = null;
          await saveUser();
          return '❌ Los PINs no coinciden. Inténtalo de nuevo.\n\nIngresa un PIN de *4 dígitos*:';
        }
        user.pin     = msg;
        user.pending = null;
        user.tempPin = null;
        await saveUser();
        sessions[id] = true;
        return `✅ *¡PIN creado exitosamente!*\n\n🎉 Bienvenido a *MisCuentas RD*\n\nYa puedes registrar tus gastos e ingresos.\n\nTu ID de Telegram es: \`${chatId}\`\nGuárdalo para el panel web.\n\nEnvía *ayuda* para ver todos los comandos.`;
      }
      // First message ever
      user.pending = 'awaiting_new_pin';
      user.tempPin = null;
      await saveUser();
      return `👋 ¡Bienvenido a *MisCuentas RD*!\n\nPara proteger tus datos, crea un *PIN de 4 dígitos*.\n\nEste PIN es tuyo y privado.\n\nIngresa tu PIN:`;
    }

    // ── PIN change flow ──
    if (user.pending === 'awaiting_change_pin_new') {
      if (!isValidPin(msg)) return '❌ El PIN debe ser exactamente *4 dígitos numéricos*.\n\nIngresa tu nuevo PIN:';
      user.tempPin = msg;
      user.pending = 'awaiting_change_pin_confirm';
      await saveUser();
      return '🔒 Confirma el nuevo PIN:';
    }
    if (user.pending === 'awaiting_change_pin_confirm') {
      if (msg !== user.tempPin) {
        user.pending = 'awaiting_change_pin_new';
        user.tempPin = null;
        await saveUser();
        return '❌ Los PINs no coinciden.\n\nIngresa el nuevo PIN de nuevo:';
      }
      user.pin     = msg;
      user.pending = null;
      user.tempPin = null;
      await saveUser();
      sessions[id] = true;
      return '✅ *PIN actualizado correctamente.*';
    }

    // ── Authentication ──
    if (!sessions[id]) {
      const att = pinAttempts[id] || { attempts: 0 };
      if (att.lockedUntil && new Date() < att.lockedUntil) {
        const mins = Math.ceil((att.lockedUntil - new Date()) / 60000);
        return `🔒 Demasiados intentos fallidos. Espera *${mins} minuto(s)*.`;
      }
      if (user.pending !== 'awaiting_login_pin') {
        user.pending = 'awaiting_login_pin';
        await saveUser();
        return `🔐 Ingresa tu *PIN de 4 dígitos* para acceder:`;
      }
      if (msg === user.pin) {
        sessions[id]    = true;
        pinAttempts[id] = { attempts: 0 };
        user.pending    = null;
        await saveUser();
        return `✅ *Acceso concedido*\n\n¡Hola! Estás dentro de MisCuentas RD.\n\nEnvía *ayuda* para ver los comandos.`;
      } else {
        att.attempts = (att.attempts || 0) + 1;
        if (att.attempts >= MAX_ATTEMPTS) {
          att.lockedUntil = new Date(Date.now() + 5 * 60 * 1000);
          pinAttempts[id] = att;
          return `🚨 *3 intentos fallidos.* Bloqueado por *5 minutos*.\n\nEscribe *resetpin* si olvidaste tu PIN.`;
        }
        pinAttempts[id] = att;
        const left = MAX_ATTEMPTS - att.attempts;
        return `❌ PIN incorrecto. Te quedan *${left} intento(s)*.\n\nIngresa tu PIN:`;
      }
    }

    // ── Authenticated commands ──
    const t = msg.toLowerCase().trim();
    if (t === 'resetpin' || t === '/resetpin') {
      user.pending = 'awaiting_change_pin_new';
      user.tempPin = null;
      await saveUser();
      return `🔑 *Cambiar PIN*\n\nIngresa tu nuevo PIN de *4 dígitos*:`;
    }

    const monthTxs = getMonthTxs(user.transactions, month, year);
    let parsed = await parseWithAI(msg) || fallbackParse(msg);

    if (parsed?.cmd === 'cambiar_pin') {
      user.pending = 'awaiting_change_pin_new';
      user.tempPin = null;
      await saveUser();
      return `🔑 *Cambiar PIN*\n\nIngresa tu nuevo PIN de *4 dígitos*:`;
    }

    if (parsed?.cmd === 'miid') {
      return `🪪 Tu Telegram ID es:\n\n\`${chatId}\``;
    }

    if (!parsed) {
      return `🤔 No entendí ese mensaje.\n\nEnvía *ayuda* para ver los comandos.\n\nEjemplos:\n• fui al colmado y gasté 350\n• pagué la luz 1200 con banco\n• deposité el sueldo 28000`;
    }

    const cmd = parsed.cmd;

    if (cmd === 'resumen') {
      const inc = monthTxs.filter(t => t.type==='ingreso').reduce((s,t)=>s+t.amount,0);
      const exp = monthTxs.filter(t => t.type==='egreso').reduce((s,t)=>s+t.amount,0);
      const bal = inc - exp;
      return `💰 *Resumen — ${MONTHS[month]} ${year}*\n\n▲ Ingresos: *${fmt(inc)}*\n▼ Egresos: *${fmt(exp)}*\n\n${bal>=0?'✅':'🚨'} Balance: *${fmt(bal)}*\n\n_${monthTxs.length} movimiento(s)_`;
    }

    if (cmd === 'ver_cuentas') {
      const accs = ['efectivo','banco','tarjeta'];
      const lines = accs.map(acc => {
        const inc = monthTxs.filter(t=>t.type==='ingreso'&&t.account===acc).reduce((s,t)=>s+t.amount,0);
        const exp = monthTxs.filter(t=>t.type==='egreso'&&t.account===acc).reduce((s,t)=>s+t.amount,0);
        return `${ACC_EMOJIS[acc]} *${acc.charAt(0).toUpperCase()+acc.slice(1)}*\n   ▲ ${fmt(inc)}  ▼ ${fmt(exp)}\n   Balance: ${fmt(inc-exp)}`;
      });
      return `🏦 *Cuentas — ${MONTHS[month]}*\n\n${lines.join('\n\n')}`;
    }

    if (cmd === 'alertas') {
      const inc = monthTxs.filter(t=>t.type==='ingreso').reduce((s,t)=>s+t.amount,0);
      const exp = monthTxs.filter(t=>t.type==='egreso').reduce((s,t)=>s+t.amount,0);
      const alerts = [];
      if (inc > 0) {
        const pct = (exp/inc)*100;
        if (pct>=100) alerts.push(`🚨 Egresos superaron ingresos (${pct.toFixed(0)}%)`);
        else if (pct>=80) alerts.push(`⚠️ Gastaste el ${pct.toFixed(0)}% de tus ingresos`);
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
      const lines = last5.map(t=>`${t.type==='ingreso'?'▲':'▼'} ${CAT_EMOJIS[t.cat]||'📦'} ${t.desc} — ${fmt(t.amount)} ${ACC_EMOJIS[t.account]||'💵'}`);
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
      await saveUser();
      return `✅ Presupuesto configurado:\n\n${CAT_EMOJIS[cat]||'📦'} *${cat}*: ${fmt(limit)} / mes`;
    }

    if (cmd === 'ayuda') {
      return `🤖 *MisCuentas RD*\n\n*Registrar (lenguaje natural):*\nfui al colmado y gasté 350\npagué la luz 1200 con banco\ndeposité el sueldo 28000\ncompré ropa con tarjeta 800\n\n*Consultar:*\n/resumen — balance del mes\n/cuentas — ver por cuenta\n/alertas — ver alertas\n/historial — últimos movimientos\n/presupuesto — ver límites\n\n*Configurar:*\npresupuesto comida 5000\ncambiar pin\n\n*Mi ID:*\n/miid — ver tu Telegram ID\n\n💵 Efectivo  🏦 Banco  💳 Tarjeta`;
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
      await saveUser();

      const emoji    = CAT_EMOJIS[tx.cat]||'📦';
      const accEmoji = ACC_EMOJIS[account]||'💵';
      const word     = tx.type==='ingreso'?'Ingreso':'Egreso';
      const sign     = tx.type==='ingreso'?'▲':'▼';

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

// ========== PHOTO / INVOICE PARSER ==========
async function parseInvoicePhoto(fileId) {
  try {
    const fileInfo = await bot.getFile(fileId);
    const fileUrl  = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fileInfo.file_path}`;

    const imgRes = await fetch(fileUrl, { signal: AbortSignal.timeout(15000) });
    if (!imgRes.ok) throw new Error('No pude descargar la imagen');
    const buffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    const ext  = fileInfo.file_path.split('.').pop().toLowerCase();
    const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg' : 'image/png';

    const prompt = `Eres un asistente financiero dominicano. Analiza esta factura o recibo e identifica el monto total, el negocio/servicio y la categoría. Responde SOLO JSON en una línea sin markdown: {"type":"egreso","amount":numero,"desc":"nombre negocio o servicio","cat":"categoria","account":"efectivo"} Categorías válidas: comida, transporte, servicios, salud, entretenimiento, ropa, educacion, negocio, otro. Si no puedes leer la factura responde: {"error":"no_legible"}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [
            { text: prompt },
            { inline_data: { mime_type: mime, data: base64 } }
          ]}],
          generationConfig: { temperature: 0.1, maxOutputTokens: 200 }
        }),
        signal: AbortSignal.timeout(20000)
      }
    );

    const data = await res.json();
    console.log('Gemini photo response:', JSON.stringify(data).substring(0, 400));
    
    // Handle safety blocks or errors
    if (data.error) {
      console.error('Gemini API error:', data.error.message);
      return null;
    }
    if (data.candidates?.[0]?.finishReason === 'SAFETY') {
      console.log('Gemini blocked for safety');
      return { error: 'no_legible' };
    }
    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      console.log('No text in response, full:', JSON.stringify(data).substring(0, 300));
      return null;
    }
    
    const text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/g, '').trim();
    console.log('Gemini photo text:', text);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('parseInvoicePhoto error:', e.message);
    return null;
  }
}

// ========== TELEGRAM LISTENER ==========
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // ── Handle photos ──
  if (msg.photo || msg.document?.mime_type?.startsWith('image/')) {
    try {
      const allData = await loadAllData();
      const id   = String(chatId);
      const user = getUser(allData, id);

      if (!user.pin)    return await send(chatId, '❌ Primero debes crear tu PIN. Envía cualquier mensaje para empezar.');
      if (!sessions[id]) return await send(chatId, '🔐 Debes iniciar sesión primero. Envía tu PIN de 4 dígitos:');

      await send(chatId, '🔍 Analizando tu factura...');

      const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document.file_id;
      const parsed = await parseInvoicePhoto(fileId);

      if (!parsed)                      return await send(chatId, '❌ No pude analizar la imagen. Intenta con una foto más clara.');
      if (parsed.error === 'no_legible') return await send(chatId, '🤔 No pude leer la factura. Asegúrate de que esté bien iluminada y sea legible.');

      const now   = new Date();
      const month = now.getMonth();
      const year  = now.getFullYear();

      const tx = {
        id: Date.now(), type: 'egreso',
        amount:  parsed.amount,
        desc:    parsed.desc    || 'Factura',
        cat:     parsed.cat     || 'otro',
        account: parsed.account || 'efectivo',
        date:    now.toISOString().split('T')[0],
      };

      user.transactions.push(tx);
      allData.users[id] = user;
      await saveAllData(allData);

      const emoji    = CAT_EMOJIS[tx.cat]     || '📦';
      const accEmoji = ACC_EMOJIS[tx.account] || '💵';

      let budgetAlert = '';
      if (user.budgets[tx.cat]) {
        const limit = user.budgets[tx.cat];
        const total = getMonthTxs(user.transactions, month, year)
          .filter(t => t.type === 'egreso' && t.cat === tx.cat).reduce((s, t) => s + t.amount, 0);
        const pct = (total / limit) * 100;
        if (pct >= 100) budgetAlert = `\n\n⚠️ *Alerta:* Superaste el presupuesto de ${emoji} ${tx.cat}`;
        else if (pct >= 80) budgetAlert = `\n\n⚠️ *Aviso:* Llevas el ${pct.toFixed(0)}% del presupuesto de ${emoji} ${tx.cat}`;
      }

      return await send(chatId, `✅ *Factura registrada*\n\n▼ ${emoji} ${tx.desc}\n💵 ${fmt(tx.amount)}\n${accEmoji} ${tx.account.charAt(0).toUpperCase()+tx.account.slice(1)}\n📂 ${tx.cat}\n📅 ${tx.date}${budgetAlert}\n\n_Si el monto no es correcto, puedes corregirlo manualmente._`);

    } catch (e) {
      console.error('Photo handler error:', e.message);
      try { await bot.sendMessage(chatId, '❌ Error procesando la imagen. Intenta de nuevo.'); } catch(_) {}
    }
    return;
  }

  // ── Handle text ──
  const text = msg.text || '';
  if (!text) return;
  try {
    const reply = await handleMessage(text, chatId);
    await send(chatId, reply);
  } catch (e) {
    console.error('Bot message error:', e.message);
    try { await bot.sendMessage(chatId, '❌ Error interno. Intenta de nuevo.'); } catch(_) {}
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

// ========== EXPRESS ROUTES ==========
app.get('/',       (req, res) => res.send('✅ MisCuentas Bot v5 — Telegram + Multi-usuario'));
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// CORS helper
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

app.options('/api/login',       (req, res) => { cors(res); res.sendStatus(200); });
app.options('/api/data/:id',    (req, res) => { cors(res); res.sendStatus(200); });

// Login from web panel
app.post('/api/login', async (req, res) => {
  try {
    cors(res);
    const { phone, pin } = req.body; // phone = telegram ID from web
    if (!phone || !pin) return res.status(400).json({ error: 'id and pin required' });
    const allData = await loadAllData();
    const user = allData.users[String(phone)];
    if (!user || !user.pin) return res.status(404).json({ error: 'user_not_found' });
    if (user.pin !== pin)   return res.status(401).json({ error: 'invalid_pin' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get user data
app.get('/api/data/:id', async (req, res) => {
  try {
    cors(res);
    const id  = decodeURIComponent(req.params.id);
    const pin = req.query.pin;
    if (!pin) return res.status(401).json({ error: 'pin required' });
    const allData = await loadAllData();
    const user = allData.users[id];
    if (!user || !user.pin) return res.status(404).json({ error: 'user_not_found' });
    if (user.pin !== pin)   return res.status(401).json({ error: 'invalid_pin' });
    res.json({ transactions: user.transactions, budgets: user.budgets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save user data
app.post('/api/data/:id', async (req, res) => {
  try {
    cors(res);
    const id  = decodeURIComponent(req.params.id);
    const pin = req.query.pin;
    if (!pin) return res.status(401).json({ error: 'pin required' });
    const allData = await loadAllData();
    const user = allData.users[id];
    if (!user || !user.pin) return res.status(404).json({ error: 'user_not_found' });
    if (user.pin !== pin)   return res.status(401).json({ error: 'invalid_pin' });
    if (req.body.transactions !== undefined) user.transactions = req.body.transactions;
    if (req.body.budgets !== undefined)      user.budgets      = req.body.budgets;
    allData.users[id] = user;
    await saveAllData(allData);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🤖 MisCuentas Bot v5 Telegram — puerto ${PORT}`));
