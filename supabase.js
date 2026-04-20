require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

// Convierte dd/mm/aaaa o dd-mm-aaaa → YYYY-MM-DD (acepta también YYYY-MM-DD directo)
function parseFecha(str) {
  if (!str) return null;
  // Ya está en formato ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  // dd/mm/aaaa o dd-mm-aaaa
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
  return null;
}

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
async function createAppointment({ nombre, cedula, telefono, fecha_nacimiento, sexo, fecha, hora, motivo }) {
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
        fecha_nac: parseFecha(fecha_nacimiento),
        sexo:      sexo || null,
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

// ── Citas que necesitan recordatorio (24h o 2h antes) ──
// Devuelve citas con datos del paciente ya incluidos (join)
async function getAppointmentsNeedingReminder(type /* '24h' | '2h' */) {
  const now = new Date();
  let from, to, flagCol;

  if (type === '24h') {
    // Ventana: desde 24h hasta 23h antes (1 hora de tolerancia)
    from = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    to   = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    flagCol = 'recordatorio_24h_enviado';
  } else {
    // Ventana: desde 2h hasta 1h antes
    from = new Date(now.getTime() +     60 * 60 * 1000);
    to   = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    flagCol = 'recordatorio_2h_enviado';
  }

  const fromDate = from.toISOString().split('T')[0];
  const toDate   = to.toISOString().split('T')[0];

  const { data, error } = await sb
    .from('citas')
    .select(`
      id, fecha, hora, motivo, estado,
      ${flagCol},
      pacientes!inner ( id, nombre, apellido, tel, cedula )
    `)
    .gte('fecha', fromDate)
    .lte('fecha', toDate)
    .eq(flagCol, false)
    .neq('estado', 'cancelada');

  if (error) { console.error('Error cargando recordatorios:', error); return []; }

  // Filtrar con precisión comparando la fecha+hora exacta
  return (data || []).filter(c => {
    const [h, m] = (c.hora || '00:00').slice(0, 5).split(':').map(Number);
    const when = new Date(c.fecha + 'T00:00:00');
    when.setHours(h, m, 0, 0);
    return when >= from && when <= to;
  });
}

async function markReminderSent(citaId, type) {
  const col = type === '24h' ? 'recordatorio_24h_enviado' : 'recordatorio_2h_enviado';
  await sb.from('citas').update({ [col]: true }).eq('id', citaId);
}

module.exports = {
  getPatientByCedula,
  getPatientByPhone,
  getAvailableSlots,
  createAppointment,
  getPatientAppointments,
  cancelAppointment,
  getAppointmentsNeedingReminder,
  markReminderSent
};
