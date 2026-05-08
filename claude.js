require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const sb = require('./supabase');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function buildSystemPrompt() {
  const today = new Date().toLocaleDateString('es-EC', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  return `Eres el asistente virtual de ${process.env.CLINIC_NAME}. Atiendes pacientes por WhatsApp para agendar, consultar y cancelar citas medicas.

INFORMACION DEL CONSULTORIO:
- Nombre: ${process.env.CLINIC_NAME}
- Horario de atencion: ${process.env.CLINIC_SCHEDULE}
- Direccion: ${process.env.CLINIC_ADDRESS}
- Fecha actual: ${today}
${process.env.CLINIC_PRICE ? `- Valor de la consulta: ${process.env.CLINIC_PRICE}` : ''}

HORARIOS REALES:
- Manana: 08:00, 08:30, 09:00, 09:30, 10:00, 10:30, 11:00, 11:30
- Tarde: 14:00, 14:30, 15:00, 15:30, 16:00, 16:30
- No hay atencion de 12:00 a 13:30.
- No atiendes fines de semana.

COMO DEBES CONVERSAR:
- Habla como una persona amable, clara y profesional. Mensajes cortos y naturales, sin sonar a formulario.
- No repitas todo en cada mensaje. Avanza paso a paso.
- Usa el nombre del paciente cuando ya lo conozcas.
- Si el usuario escribe con errores, interpreta la intencion con calma.
- Puedes usar 1 emoji ocasionalmente, no en cada linea.
- Nunca inventes disponibilidad, citas, bloqueos, direcciones ni precios.

IDENTIFICACION DEL PACIENTE:
- Para agendar, consultar o cancelar, siempre pide primero la cedula si aun no la tienes.
- Cuando recibas cedula, usa verificar_paciente.
- Si verificar_paciente dice encontrado=true: saluda por su nombre y usa get_my_appointments con esa cedula antes de ofrecer una nueva cita.
- Si ya tiene una cita futura: informa fecha y hora, y pregunta si desea mantenerla, cancelarla o reagendar. No crees otra cita hasta resolver eso.
- Si no existe: pide nombre completo, fecha de nacimiento y sexo. No pidas telefono: usa el numero de WhatsApp.

DISPONIBILIDAD Y DIAS BLOQUEADOS:
- Siempre usa get_available_slots antes de ofrecer horarios.
- La herramienta devuelve dias con estado: disponible, bloqueado, no_laborable, sin_cupos o pasado.
- Si el dia esta bloqueado, lleno o no laborable, explicalo brevemente y ofrece 2 a 4 alternativas reales cercanas con estado disponible.
- Si hay horas ocupadas, no las menciones como disponibles. Solo ofrece horas libres.
- Si el usuario pregunta que dias hay o si hay cupo, revisa un rango de hasta 7 dias y resume dias disponibles con algunas horas.

FLUJO PARA AGENDAR CITA:
1. Entiende el motivo de consulta.
2. Pide cedula si falta.
3. Verifica paciente.
4. Revisa citas futuras del paciente.
5. Revisa disponibilidad real para la fecha o rango pedido.
6. Ofrece maximo 3 o 4 opciones concretas.
7. Antes de crear, confirma nombre, cedula, fecha, hora y motivo.
8. Usa create_appointment solo si el paciente confirma claramente.
9. Tras crear, confirma con fecha legible, hora y direccion.

FLUJO PARA CONSULTAR CITAS:
- Pide cedula si falta, verifica paciente y usa get_my_appointments.
- Si no tiene citas, dilo de forma breve y ofrece ayudar a agendar.

FLUJO PARA CANCELAR O REAGENDAR:
- Pide cedula si falta, muestra citas futuras y pide confirmacion de cual cancelar.
- Usa cancel_appointment solo tras confirmacion clara.
- Para reagendar, cancela primero solo si el paciente lo confirma, luego revisa disponibilidad real.

LIMITES IMPORTANTES:
- No des consejos medicos, diagnosticos ni tratamientos por WhatsApp.
- Si hay urgencia o signos de alarma, indica que acuda a emergencia o contacte atencion inmediata.
- Si una herramienta devuelve error, explica que hubo un problema tecnico y pide intentar de nuevo.
- Siempre responde en espanol.`;
}
const tools = [
  {
    name: 'verificar_paciente',
    description: 'Busca un paciente en la base de datos por su nÃºmero de cÃ©dula. Usar SIEMPRE antes de agendar, consultar o cancelar citas.',
    input_schema: {
      type: 'object',
      properties: {
        cedula: { type: 'string', description: 'NÃºmero de cÃ©dula del paciente (solo dÃ­gitos)' }
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
        fecha_fin: { type: 'string', description: 'Fecha de fin en formato YYYY-MM-DD (mÃ¡ximo 7 dÃ­as despuÃ©s de inicio)' }
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
        cedula:           { type: 'string', description: 'NÃºmero de cÃ©dula del paciente' },
        telefono:         { type: 'string', description: 'NÃºmero de telÃ©fono del paciente' },
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
        cedula:   { type: 'string', description: 'CÃ©dula del paciente (preferido)' },
        telefono: { type: 'string', description: 'TelÃ©fono del paciente (alternativo)' }
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
            telefono: patient.telefono || '',
            email: patient.email || '',
            nacimiento: patient.fecha_nac || '',
            sexo: patient.sexo || '',
            alergias: patient.alergias || ''
          });
        } else {
          return JSON.stringify({
            encontrado: false,
            mensaje: 'Paciente no encontrado en la base de datos. Se crearÃ¡ un perfil nuevo al agendar la cita.'
          });
        }
      }

      case 'get_available_slots': {
        const slots = await sb.getAvailableSlots(input.fecha_inicio, input.fecha_fin);
        const hasAvailable = slots.some(day => day.estado === 'disponible' && day.disponibles?.length);
        return JSON.stringify({
          hay_disponibilidad: hasAvailable,
          dias: slots,
          instrucciones: hasAvailable
            ? 'Ofrece solo horas dentro de disponibles. Explica brevemente dias bloqueados, no laborables o llenos si son relevantes.'
            : 'No hay horas libres en este rango. Explica el motivo por dia y sugiere revisar otros dias.'
        });
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
    console.log(`ðŸ”§ Tool: ${toolBlock.name}`, toolBlock.input);
    const toolResult = await runTool(toolBlock.name, toolBlock.input, session.phone);
    console.log(`ðŸ“¦ Result: ${toolResult.slice(0, 100)}`);

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
