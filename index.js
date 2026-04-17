require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { getSession } = require('./sessions');
const { chat } = require('./claude');

const app = express();
app.use(express.json());

const API_TOKEN = process.env.WASENDER_API_TOKEN;
const API_BASE  = 'https://wasenderapi.com/api';

// Send WhatsApp message
async function sendWhatsApp(to, text) {
  const phone = to.replace(/\D/g, '');
  try {
    const res = await axios.post(`${API_BASE}/send-message`, { to: phone, text }, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    console.log(`✅ Sent to ${phone}`);
    return res.data;
  } catch (e) {
    console.error(`❌ Send error:`, e.response?.data || e.message);
  }
}

// Typing indicator
async function sendTyping(to) {
  const phone = to.replace(/\D/g, '');
  try {
    await axios.post(`${API_BASE}/send-presence-update`, { to: phone, presence: 'composing' }, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}` }
    });
  } catch (_) {}
}

// Webhook — receives incoming messages from WaSenderAPI
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // respond fast

  const body = req.body;
  const event = body.event || body.type || '';
  const data  = body.data || body;

  console.log('📨 Event:', event);

  // Only process incoming personal messages
  const isIncoming = event.includes('received') || event.includes('message-upsert') || event === 'message';
  if (!isIncoming) return;

  // Extract sender and message text
  const from = (data.from || data.sender || data.key?.remoteJid || '').replace('@s.whatsapp.net','').replace('@c.us','');
  const text  = data.body || data.text || data.message?.conversation || data.message?.extendedTextMessage?.text;

  if (!from || !text || typeof text !== 'string') return;

  // Ignore our own messages (bot sending)
  const botPhone = process.env.WASENDER_PHONE?.replace(/\D/g,'');
  if (from === botPhone) return;

  // Ignore group messages
  if (from.includes('-') || from.includes('@g.us')) return;

  console.log(`📱 [${from}]: ${text}`);

  try {
    await sendTyping(from);
    const session = getSession(from);
    const reply = await chat(session, text);
    await sendWhatsApp(from, reply);
  } catch (e) {
    console.error('❌ Error:', e.message);
    await sendWhatsApp(from, '⚠️ Disculpe, tuvimos un problema técnico. Por favor intente de nuevo en un momento.');
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: '✅ online',
    bot: process.env.CLINIC_NAME,
    time: new Date().toLocaleString('es-EC')
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🤖 ${process.env.CLINIC_NAME} — WhatsApp Bot`);
  console.log(`🚀 Running on port ${PORT}`);
  console.log(`📱 WhatsApp: ${process.env.WASENDER_PHONE}\n`);
});
