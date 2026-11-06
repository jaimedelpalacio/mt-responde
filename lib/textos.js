// lib/textos.js
// Textos fijos del formulario. Los de cada consulta (texto, preguntas, opciones) los manda el programa.

export const IDIOMA_POR_DEFECTO = 'es';

// El formato de fechas no distingue «a la 1:30» de «a las 2:30».
const laUna = (fecha) => fecha.replace(/ a (las|les) 1:/, ' a la 1:');
// En catalán, los días 1 y 11 se apostrofan: «fins a l’1», «fins al 2».
const finsAl = (fecha) => (/^(1|11) /.test(fecha) ? 'fins a l’' : 'fins al ');

export const TEXTOS = {
  es: {
    locale: 'es-ES',
    titulo: 'Consulta',
    vistaPrevia: 'Consulta por SMS de Mission Track.',
    abrirImagen: 'Abrir la imagen original',
    obligatoria: 'Obligatoria',
    revisarPregunta: 'Revise esta pregunta.',
    revisarVarias: 'Revise las preguntas marcadas: falta contestar alguna o la respuesta no es válida.',
    marcarVarias: 'Puede marcar varias.',
    asterisco: 'Las preguntas con * son obligatorias.',
    plazo: (fecha) => `Puede contestar hasta el ${laUna(fecha)}. Solo podrá contestar una vez.`,
    enviar: 'Enviar respuesta',
    masInformacion: 'Más información',
    avisos: {
      guardada: ['Respuesta registrada', 'Gracias. Ya puede cerrar esta página.'],
      contestada: ['Ya ha contestado', 'Su respuesta ya estaba registrada.'],
      caducada: ['Consulta terminada', 'El plazo para contestar ha terminado.'],
      no_existe: ['Enlace no válido', 'Compruebe que el enlace del SMS está completo.'],
      limite: ['Demasiados intentos', 'Inténtelo de nuevo dentro de unos minutos.'],
      error: ['No se ha podido completar', 'Ha habido un problema. Inténtelo de nuevo dentro de unos minutos.']
    }
  },
  en: {
    locale: 'en-GB',
    titulo: 'Request',
    vistaPrevia: 'SMS request from Mission Track.',
    abrirImagen: 'Open the original image',
    obligatoria: 'Required',
    revisarPregunta: 'Please check this question.',
    revisarVarias: 'Please check the marked questions: an answer is missing or not valid.',
    marcarVarias: 'You can select more than one.',
    asterisco: 'Questions marked * are required.',
    plazo: (fecha) => `You can reply until ${fecha}. You can only reply once.`,
    enviar: 'Send reply',
    masInformacion: 'More information',
    avisos: {
      guardada: ['Reply recorded', 'Thank you. You can close this page now.'],
      contestada: ['Already answered', 'Your reply was already recorded.'],
      caducada: ['Request closed', 'The time to reply has ended.'],
      no_existe: ['Invalid link', 'Please check that the link in the SMS is complete.'],
      limite: ['Too many attempts', 'Please try again in a few minutes.'],
      error: ['Could not be completed', 'Something went wrong. Please try again in a few minutes.']
    }
  },
  ca: {
    locale: 'ca-ES',
    titulo: 'Consulta',
    vistaPrevia: 'Consulta per SMS de Mission Track.',
    abrirImagen: 'Obrir la imatge original',
    obligatoria: 'Obligatòria',
    revisarPregunta: 'Revisi aquesta pregunta.',
    revisarVarias: 'Revisi les preguntes marcades: en falta alguna per contestar o la resposta no és vàlida.',
    marcarVarias: 'En pot marcar diverses.',
    asterisco: 'Les preguntes amb * són obligatòries.',
    plazo: (fecha) => `Pot contestar ${finsAl(fecha)}${laUna(fecha)}. Només podrà contestar una vegada.`,
    enviar: 'Enviar la resposta',
    masInformacion: 'Més informació',
    avisos: {
      guardada: ['Resposta registrada', 'Gràcies. Ja pot tancar aquesta pàgina.'],
      contestada: ['Ja ha contestat', 'La seva resposta ja estava registrada.'],
      caducada: ['Consulta acabada', 'El termini per contestar ha acabat.'],
      no_existe: ['Enllaç no vàlid', 'Comprovi que l’enllaç de l’SMS és complet.'],
      limite: ['Massa intents', 'Torni-ho a provar d’aquí a uns minuts.'],
      error: ['No s’ha pogut completar', 'Hi ha hagut un problema. Torni-ho a provar d’aquí a uns minuts.']
    }
  }
};

export const IDIOMAS = Object.keys(TEXTOS);
