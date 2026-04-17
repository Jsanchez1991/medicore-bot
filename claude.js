require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const sb = require('./supabase');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt() {
  return `Eres el asistente virtual del ${process.env.CLINIC_NAME}. Tu función es ayudar a los pacientes a agendar, consultar y cancelar citas médicas por WhatsApp.

INFORMACIÓN DEL CONSULTORIO:
- Nombre: ${process.env.CLINIC_NAME}
- Horario de atención: ${process.env.CLINIC_SCHEDULE}
- Dirección: ${process.env.CLINIC_ADDRESS}
${process.env.CLINIC_PRICE ? `- Valor de la consulta: ${process.env.CLINIC_PRICE}` : ''}

HORARIOS DISPONIBLES (los únicos que existen — NO hay atención de 12:00 a 13:30):
- Mañana: 08:00, 08:30, 09:00, 09:30, 10:00, 10:30, 11:00, 11:30
- Tarde:   14:00, 14:30, 15:00, 15:30, 16:00, 16:30

FLUJO OBLIGATORIO PARA AGENDAR CITA:
1. Saluda amablemente en el primer mensaje
2. Pregunta el motivo de la consulta
3. SIEMPRE pide el número de cédula antes de proceder — usa verificar_paciente para buscar al paciente
4. Si el paciente existe: saluda por su nombre y confirma sus datos
5. Si NO existe: pide en este orden — nombre completo, fecha de nacimiento (dd/mm/aaaa) y sexo (Masculino/Femenino). El teléfono ya lo tienes del WhatsApp
6. Usa get_available_slots para el día o rango que el paciente mencione — NUNCA inventes ni asumas horarios
7. Si el horario pedido NO está disponible (ej: 12:00 no existe, o ya está ocupado): explica amablemente e indica los horarios más cercanos disponibles del resultado. NUNCA te rindas ni digas que no hay disponibilidad sin mostrar alternativas
8. Ofrece máximo 3-4 opciones concretas del resultado real
9. Confirma: nombre, fecha, hora y motivo antes de crear la cita
10. Crea la cita con create_appointment SOLO cuando el paciente confirme explícitamente
11. Tras crear, da resumen con fecha legible, hora y dirección del consultorio

FLUJO PARA CONSULTAR CITAS:
- Pide la cédula → usa verificar_paciente → luego get_my_appointments

FLUJO PARA CANCELAR CITA:
- Pide la cédula → muestra las citas → confirma cuál cancelar → usa cancel_appointment

MANEJO DE HORARIOS NO DISPONIBLES:
- Si el paciente pide las 12:00 → "No atendemos en ese horario (pausa de almuerzo). El horario más cercano disponible es las 11:30 o las 14:00. ¿Cuál prefieres?"
- Si pide un día festivo o fin de semana → "Solo atendemos de lunes a viernes. ¿Qué día de la semana te viene bien?"
- Si no hay cupos en la fecha → muestra cupos de los días siguientes

TONO: Cálido, profesional, conciso. Usa emojis con moderación (📅 ✅ 👩‍⚕️ 📍).
IDIOMA: Siempre en español.
FECHAS: Usa formato legible (viernes 17 de abril, no 2026-04-17).
NUNCA digas "llame al consultorio" por un problema de horario — siempre ofrece alternativas primero.`;
}

const tools = [
  {
    name: 'verificar_paciente',
    description: 'Busca un paciente en la base de datos por su número de cédula. Usar SIEMPRE antes de agendar, consultar o cancelar citas.',
    input_schema: {
      type: 'object',
      properties: {
        cedula: { type: 'string', description: 'Número de cédula del paciente (solo dígitos)' }
      },
      required: ['cedula']
    }
  },
  {
    name: 'get_available_slots',
    description: 'Obtiene los horarios disponibles para citas en un rango de fechas. Usar SIEMPRE antes de ofrecer horarios al paciente.',
    input_schema: {
      type: 'object',
      properties: {
        fecha_inicio: { type: 'string', description: 'Fecha de inicio en formato YYYY-MM-DD' },
        fecha_fin: { type: 'string', description: 'Fecha de fin en formato YYYY-MM-DD (máximo 7 días después de inicio)' }
      },
      required: ['fecha_inicio', 'fecha_fin']
    }
  },
  {
    name: 'create_appointment',
    description: 'Crea una cita en el sistema. Usar SOLO cuando el paciente haya confirmado todos los datos.',
    input_schema: {
      type: 'object',
      properties: {
        nombre:           { type: 'string', description: 'Nombre completo del paciente' },
        cedula:           { type: 'string', description: 'Número de cédula del paciente' },
        telefono:         { type: 'string', description: 'Número de teléfono del paciente' },
        fecha_nacimiento: { type: 'string', description: 'Fecha de nacimiento en formato YYYY-MM-DD (solo para pacientes nuevos)' },
        sexo:             { type: 'string', description: 'Sexo del paciente: Masculino o Femenino (solo para pacientes nuevos)' },
        fecha:            { type: 'string', description: 'Fecha de la cita en formato YYYY-MM-DD' },
        hora:             { type: 'string', description: 'Hora en formato HH:MM (ej: 09:00)' },
        motivo:           { type: 'string', description: 'Motivo de la consulta' }
      },
      required: ['nombre', 'telefono', 'fecha', 'hora', 'motivo']
    }
  },
  {
    name: 'get_my_appointments',
    description: 'Consulta las citas futuras del paciente.',
    input_schema: {
      type: 'object',
      properties: {
        cedula:   { type: 'string', description: 'Cédula del paciente (preferido)' },
        telefono: { type: 'string', description: 'Teléfono del paciente (alternativo)' }
      }
    }
  },
  {
    name: 'cancel_appointment',
    description: 'Cancela una cita existente por su ID.',
    input_schema: {
      type: 'object',
      properties: {
        cita_id: { type: 'string', description: 'ID de la cita a cancelar' }
      },
      required: ['cita_id']
    }
  }
];

async function runTool(name, input, phone) {
  try {
    switch (name) {
      case 'verificar_paciente': {
        const patient = await sb.getPatientByCedula(input.cedula);
        if (patient) {
          return JSON.stringify({
            encontrado: true,
            id: patient.id,
            nombre: patient.nombre,
            apellido: patient.apellido,
            cedula: patient.cedula,
            telefono: patient.tel || '',
            email: patient.email || '',
            nacimiento: patient.nacimiento || '',
            sexo: patient.sexo || '',
            alergias: patient.alergias || ''
          });
        } else {
          return JSON.stringify({
            encontrado: false,
            mensaje: 'Paciente no encontrado en la base de datos. Se creará un perfil nuevo al agendar la cita.'
          });
        }
      }

      case 'get_available_slots': {
        const slots = await sb.getAvailableSlots(input.fecha_inicio, input.fecha_fin);
        return JSON.stringify(slots.length ? slots : { mensaje: 'No hay horarios disponibles en ese período. Prueba otras fechas.' });
      }

      case 'create_appointment': {
        const result = await sb.createAppointment({
          ...input,
          cedula:           input.cedula           || null,
          fecha_nacimiento: input.fecha_nacimiento || null,
          sexo:             input.sexo             || null,
          telefono:         input.telefono         || phone
        });
        return JSON.stringify({ exito: true, cita_id: result.cita?.id, paciente: result.paciente?.nombre });
      }

      case 'get_my_appointments': {
        const appts = await sb.getPatientAppointments(input.telefono || phone, input.cedula);
        return JSON.stringify(appts.length ? appts : { mensaje: 'No tiene citas programadas.' });
      }

      case 'cancel_appointment': {
        await sb.cancelAppointment(input.cita_id);
        return JSON.stringify({ exito: true });
      }

      default:
        return JSON.stringify({ error: 'Herramienta no encontrada' });
    }
  } catch (e) {
    console.error(`Tool ${name} error:`, e.message);
    return JSON.stringify({ error: e.message });
  }
}

async function chat(session, userMessage) {
  // Add user message
  session.history.push({ role: 'user', content: userMessage });
  // Keep last 20 messages
  if (session.history.length > 20) session.history = session.history.slice(-20);

  let response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: buildSystemPrompt(),
    tools,
    messages: session.history
  });

  // Tool use loop
  while (response.stop_reason === 'tool_use') {
    const toolBlock = response.content.find(b => b.type === 'tool_use');
    console.log(`🔧 Tool: ${toolBlock.name}`, toolBlock.input);
    const toolResult = await runTool(toolBlock.name, toolBlock.input, session.phone);
    console.log(`📦 Result: ${toolResult.slice(0, 100)}`);

    session.history.push({ role: 'assistant', content: response.content });
    session.history.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolBlock.id, content: toolResult }]
    });

    response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools,
      messages: session.history
    });
  }

  const text = response.content.find(b => b.type === 'text')?.text
    || 'Disculpe, hubo un inconveniente. Por favor intente de nuevo.';

  session.history.push({ role: 'assistant', content: response.content });
  return text;
}

module.exports = { chat };
