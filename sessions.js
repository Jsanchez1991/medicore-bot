const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { phone, history: [], lastActivity: Date.now() });
  }
  const s = sessions.get(phone);
  s.lastActivity = Date.now();
  return s;
}

function clearSession(phone) { sessions.delete(phone); }

// Clean sessions older than 24h every hour
setInterval(() => {
  const now = Date.now();
  for (const [phone, s] of sessions.entries()) {
    if (now - s.lastActivity > 86400000) sessions.delete(phone);
  }
}, 3600000);

module.exports = { getSession, clearSession };
