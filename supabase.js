require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY);

// Available time slots in a day
const TIME_SLOTS = ['08:00','08:30','09:00','09:30','10:00','10:30','11:00','11:30','14:00','14:30','15:00','15:30','16:00','16:30'];

async function getAvailableSlots(fechaInicio, fechaFin) {
  // Get booked appointments in range
  const { data: citas } = await sb.from('citas').select('fecha, hora').gte('fecha', fechaInicio).lte('fecha', fechaFin);

  const slots = [];
  const start = new Date(fechaInicio + 'T12:00:00');
  const end = new Date(fechaFin + 'T12:00:00');
  const today = new Date(); today.setHours(0,0,0,0);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d < today) continue; // Skip past days
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // Skip weekends

    const dateStr = d.toISOString().split('T')[0];
    const booked = (citas || []).filter(c => c.fecha === dateStr).map(c => c.hora.slice(0,5));
    const available = TIME_SLOTS.filter(t => !booked.includes(t));

    if (available.length > 0) slots.push({ fecha: dateStr, disponibles: available });
  }
  return slots;
}

async function getPatientByPhone(telefono) {
  const clean = telefono.replace(/\D/g, '').slice(-9); // last 9 digits
  const { data } = await sb.from('pacientes').select('*').ilike('tel', `%${clean}%`).limit(1);
  return data?.[0] || null;
}

async function getDoctorId() {
  const { data } = await sb.from('doctores').select('id').limit(1).single();
  return data?.id || null;
}

async function createAppointment({ nombre, telefono, fecha, hora, motivo }) {
  const doctorId = await getDoctorId();
  let patient = await getPatientByPhone(telefono);

  if (!patient) {
    const parts = nombre.trim().split(' ');
    const { data: np } = await sb.from('pacientes').insert({
      nombre: parts[0],
      apellido: parts.slice(1).join(' ') || '—',
      tel: telefono,
      estado: 'activo',
      doctor_id: doctorId
    }).select().single();
    patient = np;
  }

  if (!patient) throw new Error('No se pudo registrar el paciente');

  const { data, error } = await sb.from('citas').insert({
    paciente_id: patient.id,
    doctor_id: doctorId,
    fecha,
    hora,
    motivo: motivo || 'Consulta General',
    estado: 'pending'
  }).select().single();

  if (error) throw new Error(error.message);
  return { cita: data, paciente: patient };
}

async function getPatientAppointments(telefono) {
  const patient = await getPatientByPhone(telefono);
  if (!patient) return [];
  const today = new Date().toISOString().split('T')[0];
  const { data } = await sb.from('citas').select('*').eq('paciente_id', patient.id).gte('fecha', today).order('fecha');
  return data || [];
}

async function cancelAppointment(citaId) {
  const { error } = await sb.from('citas').delete().eq('id', citaId);
  if (error) throw new Error(error.message);
  return true;
}

module.exports = { getAvailableSlots, getPatientByPhone, createAppointment, getPatientAppointments, cancelAppointment };
