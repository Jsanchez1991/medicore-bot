require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { getSession } = require('./sessions');
const { chat } = require('./claude');

const app = express();
app.use(express.json());

const API_TOKEN = process.env.WASENDER_API_TOKEN;
const API_BASE  = 'https://wasenderapi.com/api';
const BOT_PHONE = (process.env.WASENDER_PHONE || '').replace(/\D/g, '');

// ── Send WhatsApp message ──
async function sendWhatsApp(to, text) {
  const phone = to.replace(/\D/g, '');
  try {
    await axios.post(`${API_BASE}/send-message`, { to: phone, text }, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    console.log(`✅ Sent to ${phone}: ${text.slice(0,60)}...`);
  } catch (e) {
    console.error(`❌ Send error:`, e.response?.data || e.message);
  }
}

// ── Typing indicator ──
async function sendTyping(to) {
  try {
    await axios.post(`${API_BASE}/send-presence-update`,
      { to: to.replace(/\D/g, ''), presence: 'composing' },
      { headers: { 'Authorization': `Bearer ${API_TOKEN}` }, timeout: 5000 }
    );
  } catch (_) {}
}

// ── Extract phone + text from WaSenderAPI payload ──
// WaSenderAPI uses Spanish field names: evento, datos, mensajes, llave, messageBody
function parseMessage(body) {
  // WaSenderAPI uses "evento" (Spanish) as the event key
  const event = (body.evento || body.event || body.type || '').toLowerCase();

  console.log('📨 Event:', event);

  // Skip test and non-message events
  if (event.includes('test')) return null;

  // Only process upsert events (avoid double-processing recibidos + upsert)
  if (!event.includes('upsert') && !event.includes('recibidos') && !event.includes('received')) return null;
  if (event.includes('recibidos') || event.includes('received')) return null; // only upsert

  // WaSenderAPI data is under "datos" (Spanish for "data")
  const data = body.datos || body.data || body;

  // Message is under "mensajes" (can be object or array)
  const msgs = data.mensajes || data.messages;
  if (!msgs) return null;

  // Handle both array and single object
  const msg = Array.isArray(msgs) ? msgs[0] : msgs;
  if (!msg) return null;

  // "llave" = "key" in Spanish
  const key = msg.llave || msg.key || {};

  // Ignore own messages
  if (key.fromMe === true || key.fromMe === 'true' || key.fromMe === 'falso' === false) {
    if (key.fromMe) return null;
  }

  // Get clean phone number — "cleanedSenderPn" is already clean
  const from = (
    msg.cleanedSenderPn ||
    (msg.senderPn || '').replace('@s.whatsapp.net', '') ||
    (key.senderPn || '').replace('@s.whatsapp.net', '') ||
    ''
  ).replace(/\D/g, '');

  if (!from || from === BOT_PHONE) return null;

  // "messageBody" is a flattened convenience field WaSenderAPI provides
  // "conversación" = "conversation" in Spanish
  const text = msg.messageBody ||
    msg.mensaje?.conversación ||
    msg.mensaje?.conversation ||
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    null;

  if (!text || typeof text !== 'string' || text.trim() === '') return null;

  console.log(`📱 [${from}]: ${text}`);
  return { from, text };
}

// ── Webhook endpoint ──
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // respond immediately

  const parsed = parseMessage(req.body);
  if (!parsed) {
    console.log('⏭️  Skipped (not a message or own message)');
    return;
  }

  const { from, text } = parsed;
  console.log(`📱 [${from}]: ${text}`);

  try {
    await sendTyping(from);
    const session = getSession(from);
    const reply   = await chat(session, text);
    await sendWhatsApp(from, reply);
  } catch (e) {
    console.error('❌ Error processing:', e.message);
    await sendWhatsApp(from, '⚠️ Disculpe, tuvimos un problema técnico. Por favor intente de nuevo.');
  }
});

// ── Health check ──
app.get('/', (req, res) => {
  res.json({
    status: '✅ online',
    bot: process.env.CLINIC_NAME,
    phone: BOT_PHONE,
    time: new Date().toLocaleString('es-EC')
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 ${process.env.CLINIC_NAME} — WhatsApp Bot`);
  console.log(`🚀 Port: ${PORT}`);
  console.log(`📱 Phone: ${BOT_PHONE}\n`);
});
