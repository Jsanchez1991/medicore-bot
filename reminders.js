// ══════════════════════════════════════════════════════════════
// Recordatorios automáticos por WhatsApp
// Corre cada 15 minutos y envía:
//   · Recordatorio 24h antes de la cita
//   · Recordatorio 2h antes de la cita
// ══════════════════════════════════════════════════════════════
const sb = require('./supabase');

// Formatea fecha a "viernes 17 de abril"
function fmtDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('es-EC', {
    weekday: 'long', day: 'numeric', month: 'long'
  });
}

// Plantilla del mensaje
function buildMessage(type, cita) {
  const p = cita.pacientes;
  const nombre = p.nombre || 'paciente';
  const hora = (cita.hora || '').slice(0, 5);
  const fecha = fmtDate(cita.fecha);
  const clinic = process.env.CLINIC_NAME || 'nuestro consultorio';
  const address = process.env.CLINIC_ADDRESS ? `\n📍 ${process.env.CLINIC_ADDRESS}` : '';

  if (type === '24h') {
    return `Hola ${nombre} 👋, le recordamos su cita médica:

📅 *${fecha}*
🕐 *${hora}*
👩‍⚕️ ${clinic}${address}

Motivo: ${cita.motivo || 'Consulta'}

Si necesita *cancelar o reagendar*, responda a este mensaje. ¡Le esperamos!`;
  }

  // 2h
  return `⏰ Hola ${nombre}, su cita es *hoy a las ${hora}* (en ~2 horas).

👩‍⚕️ ${clinic}${address}

Por favor llegue 10 minutos antes. ¡Nos vemos pronto! 🌟`;
}

// Ejecuta un ciclo de revisión
async function runReminderCycle(sendWhatsApp) {
  const types = ['24h', '2h'];

  for (const type of types) {
    try {
      const citas = await sb.getAppointmentsNeedingReminder(type);
      if (!citas.length) continue;

      console.log(`🔔 ${citas.length} recordatorio(s) ${type} pendientes`);

      for (const cita of citas) {
        const phone = cita.pacientes?.tel;
        if (!phone) {
          console.warn(`⚠️  Cita ${cita.id} sin teléfono — salta`);
          continue;
        }

        const msg = buildMessage(type, cita);
        try {
          await sendWhatsApp(phone, msg);
          await sb.markReminderSent(cita.id, type);
          console.log(`✅ Recordatorio ${type} enviado a ${phone} (cita ${cita.id})`);
        } catch (e) {
          console.error(`❌ Error enviando recordatorio ${type} a ${phone}:`, e.message);
        }
      }
    } catch (e) {
      console.error(`❌ Error en ciclo de recordatorios ${type}:`, e.message);
    }
  }
}

// Arranca el scheduler — corre cada 15 minutos
function startReminderScheduler(sendWhatsApp) {
  const INTERVAL_MS = 15 * 60 * 1000; // 15 min

  // Primera corrida 30 seg después del arranque (dar tiempo al server)
  setTimeout(() => runReminderCycle(sendWhatsApp), 30 * 1000);

  // Luego cada 15 min
  setInterval(() => runReminderCycle(sendWhatsApp), INTERVAL_MS);

  console.log(`🔔 Reminder scheduler iniciado (revisa cada 15 min)`);
}

module.exports = { startReminderScheduler, runReminderCycle };
