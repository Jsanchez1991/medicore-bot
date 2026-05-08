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

function normalizeSexo(value) {
  const clean = (value || '').toString().trim().toLowerCase();
  if (!clean) return null;
  if (clean === 'm' || clean.startsWith('masc')) return 'M';
  if (clean === 'f' || clean.startsWith('fem')) return 'F';
  return null;
}

const TIME_SLOTS = [
  '08:00','08:30','09:00','09:30','10:00','10:30','11:00','11:30',
  '14:00','14:30','15:00','15:30','16:00','16:30'
];

const CONFIGURED_DOCTOR_ID = process.env.DOCTOR_ID || process.env.BOT_DOCTOR_ID;
const CONFIGURED_DOCTOR_USER_ID = process.env.DOCTOR_USER_ID || process.env.BOT_DOCTOR_USER_ID;
const CONFIGURED_DOCTOR_EMAIL = process.env.DOCTOR_EMAIL || process.env.BOT_DOCTOR_EMAIL;
let cachedDoctorId = null;

async function getDoctorId() {
  if (cachedDoctorId) return cachedDoctorId;

  if (CONFIGURED_DOCTOR_ID) {
    const { data, error } = await sb
      .from('doctores')
      .select('id')
      .or(`id.eq.${CONFIGURED_DOCTOR_ID},user_id.eq.${CONFIGURED_DOCTOR_ID}`)
      .single();

    if (error) throw new Error('No se pudo encontrar el doctor configurado: ' + error.message);
    if (!data?.id) throw new Error('No existe un doctor con el DOCTOR_ID configurado.');

    cachedDoctorId = data.id;
    return cachedDoctorId;
  }

  if (CONFIGURED_DOCTOR_USER_ID) {
    const { data, error } = await sb
      .from('doctores')
      .select('id')
      .eq('user_id', CONFIGURED_DOCTOR_USER_ID)
      .single();

    if (error) throw new Error('No se pudo encontrar el doctor por user_id: ' + error.message);
    if (!data?.id) throw new Error('No existe un doctor con el DOCTOR_USER_ID configurado.');

    cachedDoctorId = data.id;
    return cachedDoctorId;
  }

  if (CONFIGURED_DOCTOR_EMAIL) {
    const { data, error } = await sb
      .from('doctores')
      .select('id')
      .eq('email', CONFIGURED_DOCTOR_EMAIL)
      .single();

    if (error) throw new Error('No se pudo encontrar el doctor configurado: ' + error.message);
    if (!data?.id) throw new Error('No existe un doctor con el email configurado.');

    cachedDoctorId = data.id;
    return cachedDoctorId;
  }

  throw new Error('Falta configurar DOCTOR_ID o DOCTOR_EMAIL para aislar esta instancia del bot.');
}

// ── Buscar paciente por cédula ──
async function getPatientByCedula(cedula) {
  const doctorId = await getDoctorId();
  const clean = cedula.replace(/\D/g, '');
  if (!clean) return null;

  // Creamos un patrón ilike para tolerar guiones o espacios (ej: %1%3%1%...)
  const pattern = '%' + clean.split('').join('%') + '%';

  const { data } = await sb
    .from('pacientes')
    .select('id, nombre, apellido, cedula, telefono, fecha_nac, email, sexo, alergias')
    .eq('doctor_id', doctorId)
    .ilike('cedula', pattern);

  if (!data || data.length === 0) return null;

  // Filtro estricto en JS para evitar falsos positivos
  const exactPatient = data.find(p => p.cedula && p.cedula.replace(/\D/g, '') === clean);
  return exactPatient || data[0]; // Retorna el exacto o el más cercano
}

// ── Buscar paciente por teléfono (fallback) ──
async function getPatientByPhone(telefono) {
  const doctorId = await getDoctorId();
  const clean = telefono.replace(/\D/g, '').slice(-9);
  const { data } = await sb
    .from('pacientes')
    .select('id, nombre, apellido, cedula, telefono, fecha_nac, email, sexo, alergias')
    .eq('doctor_id', doctorId)
    .ilike('telefono', `%${clean}%`)
    .limit(1);
  return data?.[0] || null;
}

// ── Horarios disponibles en un rango de fechas ──
async function getAvailableSlots(fechaInicio, fechaFin) {
  const doctorId = await getDoctorId();
  const { data: citas } = await sb
    .from('citas')
    .select('fecha, hora, estado')
    .eq('doctor_id', doctorId)
    .gte('fecha', fechaInicio)
    .lte('fecha', fechaFin)
    .neq('estado', 'cancelled');

  const { data: bloqueos } = await sb
    .from('dias_bloqueados')
    .select('fecha')
    .eq('doctor_id', doctorId)
    .gte('fecha', fechaInicio)
    .lte('fecha', fechaFin);

  const blockedDates = (bloqueos || []).map(b => b.fecha);

  const slots = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = new Date(fechaInicio + 'T12:00:00');
  const end   = new Date(fechaFin   + 'T12:00:00');

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    if (d < today) {
      slots.push({ fecha: dateStr, estado: 'pasado', disponibles: [] });
      continue;
    }

    const dow = d.getDay();
    if (dow === 0 || dow === 6) {
      slots.push({ fecha: dateStr, estado: 'no_laborable', motivo: 'fin_de_semana', disponibles: [] });
      continue;
    }

    if (blockedDates.includes(dateStr)) {
      slots.push({ fecha: dateStr, estado: 'bloqueado', disponibles: [] });
      continue;
    }

    const booked = (citas || []).filter(c => c.fecha === dateStr).map(c => c.hora.slice(0, 5));
    const available = TIME_SLOTS.filter(t => !booked.includes(t));

    slots.push({
      fecha: dateStr,
      estado: available.length > 0 ? 'disponible' : 'sin_cupos',
      ocupados: booked,
      disponibles: available
    });
  }
  return slots;
}

async function validateAppointmentSlot(doctorId, fecha, hora) {
  const cleanHora = (hora || '').slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) {
    throw new Error('La fecha de la cita no tiene un formato valido.');
  }
  if (!TIME_SLOTS.includes(cleanHora)) {
    throw new Error('Ese horario no esta dentro de los horarios de atencion.');
  }

  const date = new Date(fecha + 'T12:00:00');
  const dow = date.getDay();
  if (dow === 0 || dow === 6) {
    throw new Error('Solo se pueden agendar citas de lunes a viernes.');
  }

  const { data: blocked } = await sb
    .from('dias_bloqueados')
    .select('id')
    .eq('doctor_id', doctorId)
    .eq('fecha', fecha)
    .limit(1);

  if (blocked?.length) {
    throw new Error('Ese dia esta bloqueado en la agenda.');
  }

  const { data: existing } = await sb
    .from('citas')
    .select('id')
    .eq('doctor_id', doctorId)
    .eq('fecha', fecha)
    .eq('hora', cleanHora)
    .neq('estado', 'cancelled')
    .limit(1);

  if (existing?.length) {
    throw new Error('Ese horario ya no esta disponible.');
  }
}

// ── Crear cita (con registro de paciente si no existe) ──
async function createAppointment({ nombre, cedula, telefono, fecha_nacimiento, sexo, fecha, hora, motivo }) {
  const doctorId = await getDoctorId();
  await validateAppointmentSlot(doctorId, fecha, hora);
  const cleanHora = (hora || '').slice(0, 5);

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
        telefono:  telefono || null,
        fecha_nac: parseFecha(fecha_nacimiento),
        sexo:      normalizeSexo(sexo),
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
      hora: cleanHora,
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
    .eq('doctor_id', await getDoctorId())
    .eq('paciente_id', patient.id)
    .gte('fecha', today)
    .neq('estado', 'cancelled')
    .order('fecha', { ascending: true });

  return data || [];
}

// ── Cancelar cita ──
async function cancelAppointment(citaId) {
  const { error } = await sb
    .from('citas')
    .update({ estado: 'cancelled' })
    .eq('doctor_id', await getDoctorId())
    .eq('id', citaId);
  if (error) throw new Error(error.message);
  return true;
}

// ── Citas que necesitan recordatorio (24h o 2h antes) ──
// Devuelve citas con datos del paciente ya incluidos (join)
async function getAppointmentsNeedingReminder(type /* '24h' | '2h' */) {
  const doctorId = await getDoctorId();
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
      pacientes!inner ( id, nombre, apellido, telefono, cedula )
    `)
    .eq('doctor_id', doctorId)
    .gte('fecha', fromDate)
    .lte('fecha', toDate)
    .eq(flagCol, false)
    .neq('estado', 'cancelled');

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
  await sb
    .from('citas')
    .update({ [col]: true })
    .eq('doctor_id', await getDoctorId())
    .eq('id', citaId);
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
