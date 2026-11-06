// lib/validar.js
// Comprueba lo que manda Neo al crear una consulta y lo que manda cada persona en el formulario.

import { IDIOMA_POR_DEFECTO, IDIOMAS } from './textos.js';

const RE_CODIGO = /^[A-Za-z0-9_-]{1,40}$/;
const RE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const RE_REF = /^[A-Za-z0-9_:.-]{1,100}$/;
const RE_TELEFONO = /^\d{9,15}$/;
// Exige zona horaria: «2026-11-05T18:00:00» sin ella sería una hora distinta según el servidor.
const RE_FECHA = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const TIPOS = ['simple', 'multiple', 'casilla'];
const MAX_PLAZO_DIAS = 30;
const MAX_TEXTO = 5000;
const MAX_PREGUNTAS = 50;
const MAX_OPCIONES = 50;
const MAX_PERSONAS = 2000;

// Un NUL o un emoji partido (al recortar un texto) los rechaza Postgres: mejor un 400 con el motivo.
function esTexto(v, max = MAX_TEXTO) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max && sinCaracteresRotos(v);
}

function sinCaracteresRotos(v) {
  return !v.includes('\0') && v.isWellFormed();
}

// 31 de noviembre: Date lo convertiría en silencio en 1 de diciembre.
function fechaExiste(texto) {
  const [, a, m, d] = RE_FECHA.exec(texto).map(Number);
  const f = new Date(Date.UTC(a, m - 1, d));
  return f.getUTCMonth() === m - 1 && f.getUTCDate() === d;
}

function pareceTelefono(ref) {
  return RE_TELEFONO.test(ref.replace(/^tel:/i, '').replace(/[.:_-]/g, ''));
}

function esHttps(v) {
  if (typeof v !== 'string' || v.length > 2000 || !sinCaracteresRotos(v)) return false;
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
}

function esCodigo(v) {
  return typeof v === 'string' && RE_CODIGO.test(v) && v !== '__proto__';
}

function validarPregunta(p, i, errores) {
  const donde = `preguntas[${i}]`;
  if (p === null || typeof p !== 'object' || Array.isArray(p)) {
    errores.push(`${donde}: no es un objeto`);
    return null;
  }
  if (!esCodigo(p.codigo)) errores.push(`${donde}.codigo: no válido`);
  if (!esTexto(p.texto)) errores.push(`${donde}.texto: obligatorio`);
  if (!TIPOS.includes(p.tipo)) errores.push(`${donde}.tipo: debe ser simple, multiple o casilla`);
  if (p.obligatoria !== undefined && typeof p.obligatoria !== 'boolean') errores.push(`${donde}.obligatoria: debe ser true o false`);
  if (p.imagen !== undefined && p.imagen !== null && !esHttps(p.imagen)) errores.push(`${donde}.imagen: debe ser https`);

  let opciones = [];
  if (p.tipo === 'casilla') {
    if (p.opciones !== undefined) errores.push(`${donde}.opciones: una casilla no lleva opciones`);
  } else if (TIPOS.includes(p.tipo)) {
    if (!Array.isArray(p.opciones) || p.opciones.length < 2 || p.opciones.length > MAX_OPCIONES) {
      errores.push(`${donde}.opciones: entre 2 y ${MAX_OPCIONES}`);
    } else {
      const vistos = new Set();
      p.opciones.forEach((o, j) => {
        if (!esCodigo(o?.codigo)) errores.push(`${donde}.opciones[${j}].codigo: no válido`);
        if (!esTexto(o?.texto)) errores.push(`${donde}.opciones[${j}].texto: obligatorio`);
        if (vistos.has(o?.codigo)) errores.push(`${donde}.opciones[${j}].codigo: repetido`);
        vistos.add(o?.codigo);
      });
      opciones = p.opciones.map((o) => ({ codigo: o?.codigo, texto: o?.texto }));
    }
  }

  return {
    codigo: p.codigo,
    texto: p.texto,
    tipo: p.tipo,
    obligatoria: p.obligatoria === true,
    imagen: p.imagen ?? null,
    opciones
  };
}

export function validarConsulta(cuerpo, ahora = new Date()) {
  const errores = [];
  const c = cuerpo && typeof cuerpo === 'object' && !Array.isArray(cuerpo) ? cuerpo : {};

  if (typeof c.centro_id !== 'string' || !RE_ID.test(c.centro_id)) errores.push('centro_id: no válido');
  if (typeof c.programa_id !== 'string' || !RE_ID.test(c.programa_id)) errores.push('programa_id: no válido');
  if (c.equipo_id !== undefined && c.equipo_id !== null && (typeof c.equipo_id !== 'string' || !RE_ID.test(c.equipo_id))) errores.push('equipo_id: no válido');
  if (!esTexto(c.texto)) errores.push('texto: obligatorio');
  if (c.imagen !== undefined && c.imagen !== null && !esHttps(c.imagen)) errores.push('imagen: debe ser https');
  if (c.aviso !== undefined && c.aviso !== null && !esTexto(c.aviso)) errores.push('aviso: no válido');
  if (c.aviso_url !== undefined && c.aviso_url !== null && !esHttps(c.aviso_url)) errores.push('aviso_url: debe ser https');
  if (c.idioma !== undefined && c.idioma !== null && !IDIOMAS.includes(c.idioma)) errores.push(`idioma: debe ser ${IDIOMAS.join(', ')}`);

  let plazo = null;
  if (typeof c.plazo !== 'string' || !RE_FECHA.test(c.plazo) || Number.isNaN(Date.parse(c.plazo)) || !fechaExiste(c.plazo)) {
    errores.push('plazo: fecha con zona horaria, por ejemplo 2026-11-05T18:00:00+01:00');
  } else {
    plazo = new Date(c.plazo);
    if (plazo <= ahora) errores.push('plazo: ya ha pasado');
    if (plazo - ahora > MAX_PLAZO_DIAS * 86400000) errores.push(`plazo: máximo ${MAX_PLAZO_DIAS} días`);
  }

  let preguntas = [];
  if (!Array.isArray(c.preguntas) || c.preguntas.length < 1 || c.preguntas.length > MAX_PREGUNTAS) {
    errores.push(`preguntas: entre 1 y ${MAX_PREGUNTAS}`);
  } else {
    preguntas = c.preguntas.map((p, i) => validarPregunta(p, i, errores));
    const codigos = preguntas.filter(Boolean).map((p) => p.codigo);
    if (new Set(codigos).size !== codigos.length) errores.push('preguntas: código repetido');
  }

  let personas = [];
  if (!Array.isArray(c.personas) || c.personas.length < 1 || c.personas.length > MAX_PERSONAS) {
    errores.push(`personas: entre 1 y ${MAX_PERSONAS}`);
  } else {
    personas = c.personas;
    if (personas.some((r) => typeof r !== 'string' || !RE_REF.test(r) || pareceTelefono(r))) errores.push('personas: referencia no válida (nunca un teléfono)');
    if (new Set(personas).size !== personas.length) errores.push('personas: referencia repetida');
  }

  return {
    errores,
    consulta: {
      centro_id: c.centro_id,
      programa_id: c.programa_id,
      equipo_id: c.equipo_id ?? null,
      texto: c.texto,
      imagen: c.imagen ?? null,
      aviso: c.aviso ?? null,
      aviso_url: c.aviso_url ?? null,
      idioma: c.idioma ?? IDIOMA_POR_DEFECTO,
      plazo,
      preguntas,
      personas
    }
  };
}

// Convierte el formulario en { código de pregunta: respuesta }: un código en las simples
// (null si no contesta), una lista en las múltiples y true/false en las casillas.
// Los códigos se comparan con los de la pregunta: nada escrito por quien contesta llega a Neo.
export function validarRespuesta(preguntas, campos) {
  const contenido = {};
  const errores = [];

  preguntas.forEach((p, i) => {
    const valor = campos[`p${i}`];
    if (p.tipo === 'casilla') {
      contenido[p.codigo] = valor === '1';
      if (p.obligatoria && !contenido[p.codigo]) errores.push(i);
      return;
    }
    const codigos = new Set(p.opciones.map((o) => o.codigo));
    const elegidos = [...new Set(valor === undefined ? [] : [].concat(valor))];
    if (elegidos.some((v) => !codigos.has(v))) {
      errores.push(i);
      return;
    }
    if (p.tipo === 'simple') {
      if (elegidos.length > 1) errores.push(i);
      contenido[p.codigo] = elegidos[0] ?? null;
    } else {
      contenido[p.codigo] = elegidos;
    }
    if (p.obligatoria && !elegidos.length) errores.push(i);
  });

  return { contenido, errores: [...new Set(errores)] };
}
