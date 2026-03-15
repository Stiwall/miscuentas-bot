/**
 * MisCuentas RD - Telegram Bot Server
 * Optimizado para Render.com
 * 
 * Características:
 * 1. Servidor HTTP con health check (requerido por Render)
 * 2. Validación completa de variables de entorno
 * 3. Manejo robusto de errores
 * 4. Procesamiento de imágenes de facturas con Gemini Vision
 * 5. Logging mejorado para debugging
 */

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());

// ========== CONFIG & VALIDATION ==========
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

// Validar TODAS las variables críticas
const requiredEnvVars = ['TELEGRAM_BOT_TOKEN', 'JSONBIN_API_KEY', 'JSONBIN_BIN_ID'];
const missing = requiredEnvVars.filter(v => !process.env[v]);

if (missing.length > 0) {
  console.error('❌ FALTAN VARIABLES DE ENTORNO:', missing.join(', '));
  console.error('💡 Configura estas variables en Render Dashboard > Environment');
  process.exit(1);
}

const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}`;

console.log('✅ Variables de entorno validadas');
console.log(`📦 JSONBin BIN ID: ${JSONBIN_BIN_ID.substring(0, 8)}...`);
console.log(`🤖 Gemini API: ${GEMINI_KEY ? 'Configurado' : 'No configurado (usando fallback)'}`);

// ========== TELEGRAM BOT ==========
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

bot.on('polling_error', (error) => {
  console.error('🔴 Telegram polling error:', error.message);
});

// ========== SESSION / STATE ==========
const sessions = {};      // { chatId: true }
const pinAttempts = {};   // { chatId: { attempts, lockedUntil } }
const MAX_ATTEMPTS = 3;

// Almacenamiento temporal de transacciones pendientes de confirmación
const pendingTransactions = {}; // { chatId: transactionData }

// ========== JSONBIN DATA ==========
async function loadAllData() {
  try {
    console.log('📥 Cargando datos desde JSONBin...');
    const res = await fetch(`${JSONBIN_URL}/latest`, {
      headers: { 'X-Master-Key': JSONBIN_API_KEY },
      signal: AbortSignal.timeout(10000)
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} - ${res.statusText}`);
    }
    
    const json = await res.json();
    const record = json.record || {};
    
    // Migración de datos antiguos
    if (record.transactions && !record.users) {
      console.log('📦 Migrando formato de datos antiguo...');
      return { users: {} };
    }
    
    console.log(`✅ Datos cargados: ${Object.keys(record.users || {}).length} usuarios`);
    return record.users ? record : { users: {} };
    
  } catch (e) {
    console.error('❌ loadAllData error:', e.message);
    return { users: {} };
  }
}

async function saveAllData(data) {
  try {
    console.log('💾 Guardando datos en JSONBin...');
    const res = await fetch(JSONBIN_URL, {
      method: 'PUT',
      headers: { 
        'Content-Type': 'application/json', 
        'X-Master-Key': JSONBIN_API_KEY 
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(10000)
    });
    
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} - ${res.statusText}`);
    }
    
    console.log('✅ Datos guardados correctamente');
    
  } catch (e) {
    console.error('❌ saveAllData error:', e.message);
    throw e;
  }
}

function getUser(allData, id) {
  if (!allData.users[id]) {
    allData.users[id] = { 
      pin: null, 
      transactions: [], 
      budgets: {}, 
      pending: null, 
      tempPin: null 
    };
  }
  // Ensure fields exist on older records
  const user = allData.users[id];
  if (!('pending' in user)) user.pending = null;
  if (!('tempPin' in user)) user.tempPin = null;
  if (!user.transactions) user.transactions = [];
  if (!user.budgets) user.budgets = {};
  return user;
}

// ========== HELPERS ==========
function fmt(n) {
  return 'RD$ ' + Number(n).toLocaleString('es-DO', { minimumFractionDigits: 2 });
}

function getMonthTxs(txs, month, year) {
  return txs.filter(t => {
    if (!t.date) return false;
    try {
      const d = new Date(t.date + 'T00:00:00');
      return d.getMonth() === month && d.getFullYear() === year;
    } catch {
      return false;
    }
  });
}

const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

const CAT_EMOJIS = {
  comida: '🍽️', transporte: '🚗', servicios: '💡', salud: '🏥',
  entretenimiento: '🎬', ropa: '👕', educacion: '📚', salario: '💼',
  negocio: '🏪', inversion: '📈', prestamo: '🤝', ahorro: '💰',
  tarjeta: '💳', regalo: '🎁', otro: '📦'
};

const ACC_EMOJIS = { efectivo: '💵', banco: '🏦', tarjeta: '💳' };

function isValidPin(str) { 
  return /^\d{4}$/.test(str); 
}

function send(chatId, text) {
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
}

// ========== IMAGE PROCESSING (Gemini Vision) ==========
async function processInvoiceImage(imageBase64, mimeType = 'image/jpeg') {
  if (!GEMINI_KEY) {
    console.log('⚠️ Gemini API no configurada, no se puede procesar imagen');
    return null;
  }

  try {
    console.log('🖼️ Procesando imagen de factura con Gemini Vision...');
    
    const prompt = `Analiza esta imagen de factura/recibo y extrae la información financiera.

Responde SOLO con JSON en una línea, sin markdown:
{"success":true,"amount":numero,"description":"texto","category":"categoria","store":"nombre_tienda","date":"YYYY-MM-DD","items":[{"name":"producto","price":numero}]}

Categorías disponibles: comida, transporte, servicios, salud, entretenimiento, ropa, educacion, negocio, otro

Si no puedes leer la factura o no es un recibo válido:
{"success":false,"error":"mensaje de error"}

Reglas:
- amount: monto TOTAL de la factura
- description: descripción breve del gasto (ej: "Supermercado", "Restaurante", "Gasolina")
- category: categoría más apropiada basada en los productos
- store: nombre del comercio si está visible
- date: fecha de la factura si está visible, sino usa la fecha de hoy
- items: lista de productos si son legibles

Ejemplos de respuesta:
{"success":true,"amount":1850.50,"description":"Supermercado","category":"comida","store":"La Sirena","date":"2024-01-15","items":[{"name":"Arroz","price":85},{"name":"Aceite","price":250}]}
{"success":true,"amount":3500,"description":"Gasolina","category":"transporte","store":"Shell","date":"2024-01-15","items":[]}
{"success":false,"error":"La imagen no parece ser una factura o recibo válido"}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: imageBase64
                }
              }
            ]
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 500 }
        }),
        signal: AbortSignal.timeout(30000)
      }
    );

    const data = await res.json();
    
    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      console.log('⚠️ Gemini Vision: respuesta vacía');
      return null;
    }

    const text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    
    if (!match) {
      console.log('⚠️ Gemini Vision: no se encontró JSON');
      return null;
    }

    const parsed = JSON.parse(match[0]);
    console.log(`🧾 Factura procesada: success=${parsed.success}, amount=${parsed.amount || 'N/A'}`);
    return parsed;

  } catch (e) {
    console.error('❌ Error procesando imagen:', e.message);
    return null;
  }
}

// Obtener imagen del mensaje de Telegram
async function getImageFromMessage(msg) {
  try {
    // Si hay foto en el mensaje
    if (msg.photo && msg.photo.length > 0) {
      // Obtener la foto de mayor resolución (la última)
      const photo = msg.photo[msg.photo.length - 1];
      console.log(`📷 Foto recibida: file_id=${photo.file_id.substring(0, 20)}...`);
      
      // Obtener el archivo de Telegram
      const fileLink = await bot.getFileLink(photo.file_id);
      console.log(`📥 Descargando imagen: ${fileLink.substring(0, 50)}...`);
      
      // Descargar la imagen
      const imageRes = await fetch(fileLink);
      const buffer = await imageRes.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      
      // Detectar tipo MIME
      const mimeType = fileLink.endsWith('.png') ? 'image/png' : 'image/jpeg';
      
      return { base64, mimeType };
    }
    
    return null;
  } catch (e) {
    console.error('❌ Error obteniendo imagen:', e.message);
    return null;
  }
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
"si" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"confirmar","budget_cat":null,"budget_amount":null}
"no" = {"type":"comando","amount":null,"desc":null,"cat":null,"account":null,"cmd":"cancelar","budget_cat":null,"budget_amount":null}

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
        signal: AbortSignal.timeout(15000)
      }
    );
    
    const data = await res.json();
    
    if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
      console.log('⚠️ Gemini: respuesta vacía');
      return null;
    }
    
    const text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/g, '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    
    if (!match) {
      console.log('⚠️ Gemini: no se encontró JSON');
      return null;
    }
    
    const parsed = JSON.parse(match[0]);
    console.log(`🤖 Gemini: tipo=${parsed.type}, cmd=${parsed.cmd || '-'}`);
    return parsed;
    
  } catch (e) {
    console.error('⚠️ Gemini error:', e.message);
    return null;
  }
}

// ========== FALLBACK PARSER ==========
const CAT_KEYWORDS = {
  comida: ['comida', 'almuerzo', 'desayuno', 'cena', 'restaurante', 'mercado', 'colmado', 'pizza', 'pollo', 'supermercado'],
  transporte: ['transporte', 'gasolina', 'taxi', 'uber', 'carro', 'bus', 'combustible', 'metro'],
  servicios: ['luz', 'agua', 'internet', 'telefono', 'claro', 'altice', 'edesur', 'edenorte', 'netflix', 'spotify', 'cable'],
  salud: ['salud', 'medico', 'farmacia', 'medicina', 'doctor', 'clinica', 'hospital', 'dentista'],
  entretenimiento: ['entretenimiento', 'cine', 'fiesta', 'salida', 'bar', 'disco', 'viaje', 'hotel'],
  ropa: ['ropa', 'zapatos', 'camisa', 'pantalon', 'tienda', 'calzado'],
  educacion: ['escuela', 'universidad', 'libro', 'curso', 'colegio', 'matricula', 'educacion'],
  salario: ['salario', 'sueldo', 'quincena', 'nomina', 'deposite', 'deposito'],
  negocio: ['negocio', 'venta', 'cobro', 'cliente', 'factura', 'mercancia'],
  inversion: ['inversion', 'dividendo', 'interes', 'acciones', 'bolsa'],
  ahorro: ['ahorro', 'ahorros', 'fondo'],
  prestamo: ['prestamo', 'deuda', 'cuota'],
};

const ACC_KEYWORDS = {
  tarjeta: ['tarjeta', 'card', 'credito', 'debito'],
  banco: ['banco', 'transfer', 'transferencia', 'deposito', 'cuenta corriente'],
};

function detectCat(text) {
  const l = text.toLowerCase();
  for (const [cat, kws] of Object.entries(CAT_KEYWORDS)) {
    if (kws.some(k => l.includes(k))) return cat;
  }
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

  // Commands
  const cmds = {
    'resumen': 'resumen', 'balance': 'resumen', 'hoy': 'resumen', 'cuanto tengo': 'resumen', 'mi balance': 'resumen',
    'alertas': 'alertas', 'alerta': 'alertas',
    'ayuda': 'ayuda', 'help': 'ayuda', 'comandos': 'ayuda', 'start': 'ayuda',
    'ver cuentas': 'ver_cuentas', 'cuentas': 'ver_cuentas', 'mis cuentas': 'ver_cuentas',
    'presupuesto': 'presupuesto', 'historial': 'historial', 'lista': 'historial',
    'cambiar pin': 'cambiar_pin', 'cambiarpin': 'cambiar_pin', 'nuevo pin': 'cambiar_pin',
    'miid': 'miid',
    'si': 'confirmar', 'sí': 'confirmar', 'confirmar': 'confirmar',
    'no': 'cancelar', 'cancelar': 'cancelar',
  };
  
  if (cmds[t]) return { type: 'comando', cmd: cmds[t] };

  const bm = t.match(/presupuesto\s+(\w+)\s+(\d+(?:[.,]\d+)?)/);
  if (bm) return { type: 'comando', cmd: 'set_budget', budget_cat: bm[1], budget_amount: parseFloat(bm[2].replace(',', '.')) };

  // Extract amount
  const amountMatch = t.match(/(\d+(?:[.,]\d+)?)/);
  if (!amountMatch) return null;
  
  const amount = parseFloat(amountMatch[1].replace(',', '.'));
  if (!amount || amount <= 0) return null;

  // Income triggers
  const incomeVerbs = [
    'ingresé', 'ingrese', 'ingreso', 'recibí', 'recibi', 'recibio', 'recibie',
    'gané', 'gane', 'cobré', 'cobre', 'cobro', 'deposité', 'deposite', 'deposito',
    'entró', 'entro', 'me pagaron', 'me pago', 'me depositaron',
    'quincena', 'sueldo', 'salario', 'nomina', 'nómina',
    'me cayó', 'me cayo', 'me entro', 'me entró',
  ];
  const hasIncomeVerb = incomeVerbs.some(v => t.includes(v));

  // Expense triggers
  const expenseVerbs = [
    'gasté', 'gaste', 'gasto', 'pagué', 'pague', 'pago',
    'compré', 'compre', 'compro', 'desembolsé', 'desembolse',
    'invertí', 'invertir', 'invierto', 'fui al', 'fui a',
    'me costó', 'me costo', 'salí', 'sali', 'saque', 'saqué',
  ];
  const hasExpenseVerb = expenseVerbs.some(v => t.includes(v));

  // Determine type
  let type;
  if (hasIncomeVerb && !hasExpenseVerb) {
    type = 'ingreso';
  } else if (hasExpenseVerb && !hasIncomeVerb) {
    type = 'egreso';
  } else if (hasIncomeVerb && hasExpenseVerb) {
    type = 'egreso';
  } else {
    // No verb — try pattern
    const numPat = t.match(/(\d+(?:[.,]\d+)?)\s+(?:en|de|para)\s+(.+)/i);
    if (numPat) {
      const desc = numPat[2].trim();
      return { type: 'egreso', amount, desc, cat: detectCat(desc + ' ' + t), account: detectAcc(t) };
    }
    return null;
  }

  // Build description
  let desc = t
    .replace(/\d+(?:[.,]\d+)?/g, '')
    .replace(/(?:ingresé|ingrese|recibí|recibi|recibio|gané|gane|cobré|cobre|deposité|deposite|gasté|gaste|pagué|pague|compré|compre|desembolsé|desembolse|fui\s+al|fui\s+a|me\s+costó|me\s+costo|saqué|saque)/gi, '')
    .replace(/\b(el|la|los|las|un|una|de|del|con|al|en|por|para|a|mi|mis|su|sus|lo|que|y|e|o)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!desc || desc.length < 2) {
    if (t.includes('quincena')) desc = 'Quincena';
    else if (t.includes('sueldo')) desc = 'Sueldo';
    else if (t.includes('salario')) desc = 'Salario';
    else if (t.includes('colmado')) desc = 'Colmado';
    else if (t.includes('luz')) desc = 'Luz';
    else if (t.includes('agua')) desc = 'Agua';
    else if (t.includes('gasolina')) desc = 'Gasolina';
    else desc = type === 'ingreso' ? 'Ingreso' : 'Gasto';
  }

  desc = desc.charAt(0).toUpperCase() + desc.slice(1);
  return { type, amount, desc, cat: detectCat(t), account: detectAcc(t) };
}

// ========== MESSAGE HANDLER ==========
async function handleMessage(msgText, chatId) {
  const id = String(chatId);
  const msg = msgText.trim();
  const now = new Date();
  const month = now.getMonth();
  const year = now.getFullYear();

  console.log(`📩 [${chatId}] ${msg.substring(0, 50)}...`);

  try {
    // Cargar datos
    const allData = await loadAllData();
    const user = getUser(allData, id);

    // Helper para guardar
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
        user.tempPin = msg;
        user.pending = 'awaiting_pin_confirm';
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
        user.pin = msg;
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
      user.pin = msg;
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
        sessions[id] = true;
        pinAttempts[id] = { attempts: 0 };
        user.pending = null;
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

    // ── CONFIRMAR TRANSACCIÓN PENDIENTE ──
    if (parsed?.cmd === 'confirmar') {
      const pending = pendingTransactions[id];
      if (pending) {
        user.transactions.push(pending);
        await saveUser();
        delete pendingTransactions[id];
        
        const catEmoji = CAT_EMOJIS[pending.cat] || '📦';
        const accEmoji = ACC_EMOJIS[pending.account] || '💵';
        
        return `✅ *Gasto registrado*\n\n${catEmoji} ${pending.desc}\n💰 ${fmt(pending.amount)}\n${accEmoji} ${pending.account}`;
      }
      return '❌ No hay transacción pendiente para confirmar.';
    }

    // ── CANCELAR TRANSACCIÓN PENDIENTE ──
    if (parsed?.cmd === 'cancelar') {
      if (pendingTransactions[id]) {
        delete pendingTransactions[id];
        return '❌ Transacción cancelada.';
      }
      return '❌ No hay transacción pendiente para cancelar.';
    }

    if (!parsed) {
      return `🤔 No entendí ese mensaje.\n\nEnvía *ayuda* para ver los comandos.\n\nEjemplos:\n• fui al colmado y gasté 350\n• pagué la luz 1200 con banco\n• deposité el sueldo 28000\n• 📷 Envía una foto de factura para registrarla automáticamente`;
    }

    const cmd = parsed.cmd;

    // ── RESUMEN ──
    if (cmd === 'resumen') {
      const inc = monthTxs.filter(tx => tx.type === 'ingreso').reduce((s, tx) => s + tx.amount, 0);
      const exp = monthTxs.filter(tx => tx.type === 'egreso').reduce((s, tx) => s + tx.amount, 0);
      const bal = inc - exp;
      return `💰 *Resumen — ${MONTHS[month]} ${year}*\n\n▲ Ingresos: *${fmt(inc)}*\n▼ Egresos: *${fmt(exp)}*\n\n${bal >= 0 ? '✅' : '🚨'} Balance: *${fmt(bal)}*\n\n_${monthTxs.length} movimiento(s)_`;
    }

    // ── VER CUENTAS ──
    if (cmd === 'ver_cuentas') {
      const accs = ['efectivo', 'banco', 'tarjeta'];
      const lines = accs.map(acc => {
        const inc = monthTxs.filter(tx => tx.type === 'ingreso' && tx.account === acc).reduce((s, tx) => s + tx.amount, 0);
        const exp = monthTxs.filter(tx => tx.type === 'egreso' && tx.account === acc).reduce((s, tx) => s + tx.amount, 0);
        return `${ACC_EMOJIS[acc]} *${acc.charAt(0).toUpperCase() + acc.slice(1)}*\n   ▲ ${fmt(inc)}  ▼ ${fmt(exp)}\n   Balance: ${fmt(inc - exp)}`;
      });
      return `🏦 *Cuentas — ${MONTHS[month]}*\n\n${lines.join('\n\n')}`;
    }

    // ── ALERTAS ──
    if (cmd === 'alertas') {
      const inc = monthTxs.filter(tx => tx.type === 'ingreso').reduce((s, tx) => s + tx.amount, 0);
      const exp = monthTxs.filter(tx => tx.type === 'egreso').reduce((s, tx) => s + tx.amount, 0);
      const alerts = [];
      
      if (inc > 0) {
        const pct = (exp / inc) * 100;
        if (pct >= 100) alerts.push(`🚨 Egresos superaron ingresos (${pct.toFixed(0)}%)`);
        else if (pct >= 80) alerts.push(`⚠️ Gastaste el ${pct.toFixed(0)}% de tus ingresos`);
        else alerts.push(`✅ Finanzas saludables (${pct.toFixed(0)}% gastado)`);
      }
      
      for (const [cat, limit] of Object.entries(user.budgets)) {
        const spent = monthTxs.filter(tx => tx.type === 'egreso' && tx.cat === cat).reduce((s, tx) => s + tx.amount, 0);
        const pct = (spent / limit) * 100;
        const e = CAT_EMOJIS[cat] || '📦';
        if (pct >= 100) alerts.push(`🚨 ${e} ${cat}: SUPERADO (${fmt(spent)})`);
        else if (pct >= 80) alerts.push(`⚠️ ${e} ${cat}: ${pct.toFixed(0)}% usado`);
      }
      
      return `🔔 *Alertas — ${MONTHS[month]}*\n\n${alerts.join('\n') || 'Sin alertas ✅'}`;
    }

    // ── HISTORIAL ──
    if (cmd === 'historial') {
      const last5 = [...monthTxs].reverse().slice(0, 5);
      if (!last5.length) return `📭 Sin movimientos en ${MONTHS[month]}`;
      const lines = last5.map(tx => `${tx.type === 'ingreso' ? '▲' : '▼'} ${CAT_EMOJIS[tx.cat] || '📦'} ${tx.desc} — ${fmt(tx.amount)} ${ACC_EMOJIS[tx.account] || '💵'}`);
      return `📋 *Últimos movimientos — ${MONTHS[month]}*\n\n${lines.join('\n')}`;
    }

    // ── PRESUPUESTO (ver) ──
    if (cmd === 'presupuesto') {
      if (!Object.keys(user.budgets).length) {
        return `📊 *Sin presupuestos configurados.*\n\nPara crear uno:\n• presupuesto comida 5000\n• presupuesto transporte 2000`;
      }
      const lines = Object.entries(user.budgets).map(([cat, limit]) => {
        const spent = monthTxs.filter(tx => tx.type === 'egreso' && tx.cat === cat).reduce((s, tx) => s + tx.amount, 0);
        const pct = Math.min(100, (spent / limit) * 100);
        const bar = '█'.repeat(Math.floor(pct / 10)) + '░'.repeat(10 - Math.floor(pct / 10));
        return `${CAT_EMOJIS[cat] || '📦'} ${cat}\n   ${bar} ${pct.toFixed(0)}%\n   ${fmt(spent)} / ${fmt(limit)}`;
      });
      return `📊 *Presupuestos — ${MONTHS[month]}*\n\n${lines.join('\n\n')}`;
    }

    // ── SET BUDGET ──
    if (cmd === 'set_budget') {
      const cat = parsed.budget_cat;
      const amount = parsed.budget_amount;
      
      if (!cat || !amount || amount <= 0) {
        return `❌ Formato incorrecto.\n\nEjemplo: presupuesto comida 5000`;
      }
      
      user.budgets[cat] = amount;
      await saveUser();
      return `✅ Presupuesto guardado:\n\n${CAT_EMOJIS[cat] || '📦'} *${cat}*: ${fmt(amount)}/mes`;
    }

    // ── AYUDA ──
    if (cmd === 'ayuda') {
      return `📖 *MisCuentas RD — Comandos*\n
💰 *Consultas:*
• resumen — Balance del mes
• cuentas — Por cuenta
• alertas — Alertas financieras
• historial — Últimos 5 movimientos
• presupuesto — Ver presupuestos

📝 *Registrar:*
• gasté 350 en comida
• pagué la luz 1200 con banco
• deposité el sueldo 28000

📷 *Facturas:*
• Envía una foto de factura
• El bot la analiza y registra

📊 *Presupuestos:*
• presupuesto comida 5000
• presupuesto transporte 2000

🔐 *Seguridad:*
• cambiar pin — Cambiar PIN
• miid — Ver tu Telegram ID

💡 *Tips:*
• Usa "con tarjeta" o "con banco"
• Sin mención = efectivo`;
    }

    // ── REGISTRAR TRANSACCIÓN ──
    if (parsed.type === 'ingreso' || parsed.type === 'egreso') {
      const tx = {
        type: parsed.type,
        amount: parsed.amount,
        desc: parsed.desc || (parsed.type === 'ingreso' ? 'Ingreso' : 'Gasto'),
        cat: parsed.cat || 'otro',
        account: parsed.account || 'efectivo',
        date: now.toISOString().split('T')[0],
        timestamp: now.toISOString()
      };
      
      user.transactions.push(tx);
      await saveUser();
      
      const emoji = parsed.type === 'ingreso' ? '▲' : '▼';
      const catEmoji = CAT_EMOJIS[tx.cat] || '📦';
      const accEmoji = ACC_EMOJIS[tx.account] || '💵';
      
      console.log(`✅ Transacción registrada: ${tx.type} ${tx.amount}`);
      
      return `${emoji} *${tx.desc}*\n${catEmoji} ${tx.cat} • ${accEmoji} ${tx.account}\n💰 ${fmt(tx.amount)}`;
    }

    return `🤔 Comando no reconocido.\n\nEnvía *ayuda* para ver los comandos disponibles.`;

  } catch (error) {
    console.error('❌ Error en handleMessage:', error);
    return `❌ Ocurrió un error. Intenta de nuevo.\n\nSi persista, contacta al soporte.`;
  }
}

// ========== IMAGE MESSAGE HANDLER ==========
async function handleImageMessage(msg, chatId) {
  const id = String(chatId);
  const now = new Date();

  console.log(`📷 [${chatId}] Imagen recibida`);

  try {
    // Verificar autenticación primero
    const allData = await loadAllData();
    const user = getUser(allData, id);

    // Si no está autenticado, pedir PIN
    if (!user.pin) {
      return `👋 ¡Bienvenido a *MisCuentas RD*!\n\nPara proteger tus datos, crea un *PIN de 4 dígitos*.\n\nIngresa tu PIN:`;
    }

    if (!sessions[id]) {
      return `🔐 Ingresa tu *PIN de 4 dígitos* para acceder:`;
    }

    // Verificar que Gemini está configurado
    if (!GEMINI_KEY) {
      return `❌ El procesamiento de facturas requiere configurar *GEMINI_API_KEY*.\n\nContacta al administrador.`;
    }

    // Obtener imagen
    const imageData = await getImageFromMessage(msg);
    if (!imageData) {
      return `❌ No pude obtener la imagen. Intenta de nuevo.`;
    }

    // Enviar mensaje de procesando
    await send(chatId, '🔄 *Analizando factura...*');

    // Procesar con Gemini Vision
    const result = await processInvoiceImage(imageData.base64, imageData.mimeType);

    if (!result) {
      return `❌ Error al procesar la imagen. Intenta con otra foto más clara.`;
    }

    if (!result.success) {
      return `❌ ${result.error || 'No pude leer la factura'}\n\nAsegúrate de que la imagen sea clara y muestre un recibo o factura válido.`;
    }

    // Crear transacción pendiente
    const tx = {
      type: 'egreso',
      amount: result.amount,
      desc: result.description || result.store || 'Factura',
      cat: result.category || 'otro',
      account: 'efectivo', // Default, usuario puede cambiar después
      date: result.date || now.toISOString().split('T')[0],
      timestamp: now.toISOString(),
      store: result.store || null,
      items: result.items || []
    };

    // Guardar como pendiente
    pendingTransactions[id] = tx;

    // Construir mensaje de confirmación
    let message = `🧾 *Factura detectada*\n\n`;
    message += `📍 *Comercio:* ${tx.store || tx.desc}\n`;
    message += `💰 *Monto:* ${fmt(tx.amount)}\n`;
    message += `📦 *Categoría:* ${CAT_EMOJIS[tx.cat] || '📦'} ${tx.cat}\n`;
    
    if (tx.items && tx.items.length > 0) {
      message += `\n*Productos:*\n`;
      tx.items.slice(0, 5).forEach(item => {
        message += `• ${item.name}: ${fmt(item.price)}\n`;
      });
      if (tx.items.length > 5) {
        message += `• _...y ${tx.items.length - 5} más_\n`;
      }
    }

    message += `\n✅ Responde *si* para confirmar\n❌ Responde *no* para cancelar`;
    message += `\n\n💡 Para cambiar la cuenta, escribe: *si tarjeta* o *si banco*`;

    return message;

  } catch (error) {
    console.error('❌ Error en handleImageMessage:', error);
    return `❌ Error procesando la imagen. Intenta de nuevo.`;
  }
}

// ========== TELEGRAM BOT EVENTS ==========
// Manejar mensajes de texto
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Si tiene foto, procesar como imagen
  if (msg.photo && msg.photo.length > 0) {
    try {
      // Si también tiene caption, procesar el caption después
      const response = await handleImageMessage(msg, chatId);
      await send(chatId, response);
      
      // Si hay caption, procesarlo como comando adicional
      if (msg.caption) {
        // Esperar un poco antes de procesar el caption
        setTimeout(async () => {
          try {
            const captionResponse = await handleMessage(msg.caption, chatId);
            await send(chatId, captionResponse);
          } catch (e) {
            console.error('Error procesando caption:', e);
          }
        }, 1000);
      }
    } catch (error) {
      console.error('❌ Error procesando imagen:', error);
      await send(chatId, '❌ Error procesando la imagen. Intenta de nuevo.');
    }
    return;
  }
  
  // Mensaje de texto normal
  if (text) {
    try {
      const response = await handleMessage(text, chatId);
      await send(chatId, response);
    } catch (error) {
      console.error('❌ Error procesando mensaje:', error);
      await send(chatId, '❌ Error procesando tu mensaje. Intenta de nuevo.');
    }
  }
});

// ========== HTTP SERVER FOR RENDER ==========
const PORT = process.env.PORT || 3000;

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'MisCuentas RD Bot',
    version: '2.1.0',
    features: ['text_processing', 'image_processing'],
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'healthy',
    telegram: bot.polling ? 'active' : 'inactive',
    gemini: !!GEMINI_KEY
  });
});

app.get('/ready', (req, res) => {
  res.status(200).json({ 
    status: 'ready',
    env: {
      telegram: !!TELEGRAM_TOKEN,
      jsonbin: !!JSONBIN_API_KEY && !!JSONBIN_BIN_ID,
      gemini: !!GEMINI_KEY
    }
  });
});

// ========== CORS HELPER ==========
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
app.options('/api/login',    (req, res) => { cors(res); res.sendStatus(200); });
app.options('/api/data/:id', (req, res) => { cors(res); res.sendStatus(200); });

// ========== WEB PANEL API ==========
// Login — solo Telegram ID, sin PIN
app.post('/api/login', async (req, res) => {
  try {
    cors(res);
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'id required' });
    const allData = await loadAllData();
    const id = String(phone);
    if (!allData.users[id]) {
      allData.users[id] = { registered: true, transactions: [], budgets: {}, pending: null };
      await saveAllData(allData);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get user data
app.get('/api/data/:id', async (req, res) => {
  try {
    cors(res);
    const id = decodeURIComponent(req.params.id);
    const allData = await loadAllData();
    if (!allData.users[id]) {
      allData.users[id] = { registered: true, transactions: [], budgets: {}, pending: null };
      await saveAllData(allData);
    }
    const user = allData.users[id];
    res.json({ transactions: user.transactions || [], budgets: user.budgets || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save user data
app.post('/api/data/:id', async (req, res) => {
  try {
    cors(res);
    const id = decodeURIComponent(req.params.id);
    const allData = await loadAllData();
    if (!allData.users[id]) {
      allData.users[id] = { registered: true, transactions: [], budgets: {}, pending: null };
    }
    const user = allData.users[id];
    if (req.body.transactions !== undefined) user.transactions = req.body.transactions;
    if (req.body.budgets !== undefined)      user.budgets      = req.body.budgets;
    allData.users[id] = user;
    await saveAllData(allData);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n========================================`);
  console.log(`✅ MisCuentas RD Bot iniciado`);
  console.log(`🌐 Puerto: ${PORT}`);
  console.log(`🤖 Telegram: Conectado`);
  console.log(`🧾 Procesamiento de facturas: ${GEMINI_KEY ? 'Activo' : 'Inactivo (falta GEMINI_API_KEY)'}`);
  console.log(`========================================\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Recibida señal SIGTERM, cerrando...');
  bot.stopPolling();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Recibida señal SIGINT, cerrando...');
  bot.stopPolling();
  process.exit(0);
});
