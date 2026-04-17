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

// ── Extract phone + text from ANY WaSenderAPI payload format ──
function parseMessage(body) {
  const event = (body.event || body.type || '').toLowerCase();
  const data   = body.data || body;

  // Log full payload for debugging
  console.log('📨 RAW:', JSON.stringify(body, null, 2));

  // Skip test events
  if (event === 'webhook.test' || event === 'test') return null;

  // ── Format 1: Baileys style (messages.upsert / message-upsert)
  if (data.messages && Array.isArray(data.messages)) {
    const msg = data.messages[0];
    if (!msg) return null;
    if (msg.key?.fromMe) return null; // ignore our own
    const jid  = msg.key?.remoteJid || '';
    const from = jid.replace('@s.whatsapp.net','').replace('@c.us','');
    if (jid.includes('@g.us') || from.includes('-')) return null; // ignore groups
    const text = msg.message?.conversation
               || msg.message?.extendedTextMessage?.text
               || msg.message?.imageMessage?.caption
               || null;
    if (!text) return null;
    return { from, text };
  }

  // ── Format 2: Simple flat format (webhook-personal-message-received)
  if (data.from || data.sender || data.phoneNumber) {
    const from = (data.from || data.sender || data.phoneNumber || '')
      .replace('@s.whatsapp.net','').replace('@c.us','').replace(/\D/g,'');
    if (!from) return null;
    if (from === BOT_PHONE) return null; // ignore own
    if (from.includes('-')) return null; // ignore groups
    const text = data.body || data.text || data.message || null;
    if (!text || typeof text !== 'string') return null;
    return { from, text };
  }

  // ── Format 3: Nested message object
  if (data.message) {
    const msg  = data.message;
    const from = (msg.from || msg.sender || '').replace(/\D/g,'');
    if (!from || from === BOT_PHONE) return null;
    const text = msg.body || msg.text || msg.content || null;
    if (!text || typeof text !== 'string') return null;
    return { from, text };
  }

  return null;
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
