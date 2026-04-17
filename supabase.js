require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

const TIME_SLOTS = [
  '08:00','08:30','09:00','09:30','10:00','10:30','11:00','11:30',
  '14:00','14:30','15:00','15:30','16:00','16:30'
];

// ── Buscar paciente por cédula ──
async function getPatientByCedula(cedula) {
  const clean = cedula.replace(/\D/g, '');
  const { data } = await sb
    .from('pacientes')
    .select('id, nombre, apellido, cedula, tel, email, nacimiento, sexo, alergias')
    .eq('cedula', clean)
    .limit(1);
  return data?.[0] || null;
}

// ── Buscar paciente por teléfono (fallback) ──
async function getPatientByPhone(telefono) {
  const clean = telefono.replace(/\D/g, '').slice(-9);
  const { data } = await sb
    .from('pacientes')
    .select('id, nombre, apellido, cedula, tel, email, nacimiento, sexo, alergias')
    .ilike('tel', `%${clean}%`)
    .limit(1);
  return data?.[0] || null;
}

// ── Obtener ID del doctor ──
async function getDoctorId() {
  const { data } = await sb.from('doctores').select('id').limit(1).single();
  return data?.id || null;
}

// ── Horarios disponibles en un rango de fechas ──
async function getAvailableSlots(fechaInicio, fechaFin) {
  const { data: citas } = await sb
    .from('citas')
    .select('fecha, hora')
    .gte('fecha', fechaInicio)
    .lte('fecha', fechaFin);

  const slots = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(fechaInicio + 'T12:00:00');
  const end   = new Date(fechaFin   + 'T12:00:00');

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    if (d < today) continue;
    const dow = d.getDay();
    if (dow === 0 || dow === 6) continue; // sin fines de semana

    const dateStr = d.toISOString().split('T')[0];
    const booked  = (citas || []).filter(c => c.fecha === dateStr).map(c => c.hora.slice(0, 5));
    const available = TIME_SLOTS.filter(t => !booked.includes(t));

    if (available.length > 0) slots.push({ fecha: dateStr, disponibles: available });
  }
  return slots;
}

// ── Crear cita (con registro de paciente si no existe) ──
async function createAppointment({ nombre, cedula, telefono, fecha, hora, motivo }) {
  const doctorId = await getDoctorId();

  // 1. Buscar por cédula primero, luego por teléfono
  let patient = null;
  if (cedula) patient = await getPatientByCedula(cedula);
  if (!patient && telefono) patient = await getPatientByPhone(telefono);

  // 2. Si no existe, crear nuevo paciente
  if (!patient) {
    const parts = (nombre || '').trim().split(' ');
    const pNombre   = parts[0] || 'Paciente';
    const pApellido = parts.slice(1).join(' ') || '—';

    const { data: np, error: epat } = await sb
      .from('pacientes')
      .insert({
        nombre:    pNombre,
        apellido:  pApellido,
        cedula:    cedula?.replace(/\D/g, '') || null,
        tel:       telefono || null,
        estado:    'activo',
        doctor_id: doctorId
      })
      .select()
      .single();

    if (epat) throw new Error('No se pudo registrar al paciente: ' + epat.message);
    patient = np;
  }

  // 3. Crear la cita
  const { data, error } = await sb
    .from('citas')
    .insert({
      paciente_id: patient.id,
      doctor_id:   doctorId,
      fecha,
      hora,
      motivo: motivo || 'Consulta General',
      estado: 'pending'
    })
    .select()
    .single();

  if (error) throw new Error('No se pudo crear la cita: ' + error.message);
  return { cita: data, paciente: patient };
}

// ── Citas futuras de un paciente ──
async function getPatientAppointments(telefono, cedula) {
  let patient = null;
  if (cedula) patient = await getPatientByCedula(cedula);
  if (!patient && telefono) patient = await getPatientByPhone(telefono);
  if (!patient) return [];

  const today = new Date().toISOString().split('T')[0];
  const { data } = await sb
    .from('citas')
    .select('*')
    .eq('paciente_id', patient.id)
    .gte('fecha', today)
    .order('fecha', { ascending: true });

  return data || [];
}

// ── Cancelar cita ──
async function cancelAppointment(citaId) {
  const { error } = await sb.from('citas').delete().eq('id', citaId);
  if (error) throw new Error(error.message);
  return true;
}

module.exports = {
  getPatientByCedula,
  getPatientByPhone,
  getAvailableSlots,
  createAppointment,
  getPatientAppointments,
  cancelAppointment
};
