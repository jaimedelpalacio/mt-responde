// lib/paginas.js
// HTML del formulario y de los avisos. Sin JavaScript: tiene que funcionar con mala cobertura.

import crypto from 'crypto';

const CSS = `
:root{--fondo:#f3f3f3;--tarjeta:#fff;--texto:#0a0a0a;--suave:#5f5f5f;--borde:#c9c9c9;--acento:#e2231a;--acento-texto:#fff;--error:#b00020;--error-fondo:#fdecee;--marcado:#fdeceb}
@media (prefers-color-scheme:dark){:root{--fondo:#1d1818;--tarjeta:#2a2424;--texto:#edecec;--suave:#b5adad;--borde:#463d3d;--acento:#ff9fa2;--acento-texto:#141010;--error:#ff9fa2;--error-fondo:#3a1f22;--marcado:#3a2626}}
*{box-sizing:border-box}
body{margin:0;background:var(--fondo);color:var(--texto);font:17px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
main{max-width:560px;margin:0 auto;padding:16px}
.tarjeta{background:var(--tarjeta);border:1px solid var(--borde);border-radius:10px;padding:16px;margin:0 0 12px}
.texto{white-space:pre-line;overflow-wrap:anywhere;margin:0}
img{display:block;max-width:100%;height:auto;border-radius:6px;margin:0 0 12px}
fieldset{min-width:0}
legend{float:left;width:100%;padding:0;font-weight:600;margin:0 0 10px;white-space:pre-line;overflow-wrap:anywhere}
legend+*{clear:both}
.ob{color:var(--error)}
label.op{display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid var(--borde);border-radius:8px;margin:0 0 8px;cursor:pointer;overflow-wrap:anywhere}
label.op:last-child{margin-bottom:0}
label.op:has(input:checked){border-color:var(--acento);background:var(--marcado)}
input[type=radio],input[type=checkbox]{width:22px;height:22px;margin:0;flex:none;accent-color:var(--acento)}
button{width:100%;padding:14px;border:0;border-radius:8px;background:var(--acento);color:var(--acento-texto);font:inherit;font-weight:600;cursor:pointer}
.nota{color:var(--suave);font-size:15px;margin:0 0 12px}
.error{background:var(--error-fondo);color:var(--error);border-color:var(--error)}
.falta{border-color:var(--error)}
.pie{color:var(--suave);font-size:14px;white-space:pre-line;overflow-wrap:anywhere;margin:12px 4px 0}
.pie a{color:inherit}
h1{font-size:21px;margin:0 0 6px}
.marca{background:#fff;border:1px solid var(--borde);border-radius:10px;padding:10px 14px;margin:0 0 12px}
.marca img{width:auto;height:32px;border-radius:0;margin:0}
`;

const HASH_CSS = crypto.createHash('sha256').update(CSS).digest('base64');

// Sin referrer: la imagen la sirve un tercero y la dirección de la página lleva el código de la persona.
export const CABECERAS_PAGINA = {
  'Content-Security-Policy': `default-src 'none'; img-src https: 'self'; style-src 'sha256-${HASH_CSS}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store'
};

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// La vista previa del SMS la pide el móvil de quien lo recibe: siempre genérica, sin el texto de la consulta.
function vistaPrevia(base) {
  return `<meta property="og:type" content="website"><meta property="og:title" content="Mission Track Neo"><meta property="og:description" content="Consulta por SMS de Mission Track."><meta property="og:image" content="${esc(base)}/vista-previa.png"><link rel="icon" href="/icono.png"><link rel="apple-touch-icon" href="/icono.png">`;
}

function documento(base, titulo, cuerpo) {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(titulo)}</title>${vistaPrevia(base)}<style>${CSS}</style></head>
<body><main><div class="marca"><img src="/logo.png" alt="Mission Track Neo" width="156" height="32"></div>${cuerpo}</main></body></html>`;
}

function imagen(url) {
  return url ? `<img src="${esc(url)}" alt="" referrerpolicy="no-referrer">` : '';
}

function fechaPlazo(plazo) {
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/Madrid' }).format(new Date(plazo));
}

function pregunta(p, i, campos, conError) {
  const nombre = `p${i}`;
  const ob = p.obligatoria ? ' <span class="ob" title="Obligatoria">*</span>' : '';
  const clase = `tarjeta${conError ? ' falta' : ''}`;

  if (p.tipo === 'casilla') {
    const marcada = campos[nombre] === '1' ? ' checked' : '';
    const req = p.obligatoria ? ' required' : '';
    return `<div class="${clase}">${imagen(p.imagen)}<label class="op"><input type="checkbox" name="${nombre}" value="1"${marcada}${req}><span class="texto">${esc(p.texto)}${ob}</span></label></div>`;
  }

  const elegidos = new Set(campos[nombre] === undefined ? [] : [].concat(campos[nombre]));
  const tipo = p.tipo === 'simple' ? 'radio' : 'checkbox';
  const req = p.tipo === 'simple' && p.obligatoria ? ' required' : '';
  const opciones = p.opciones.map((o) => {
    const marcada = elegidos.has(o.codigo) ? ' checked' : '';
    return `<label class="op"><input type="${tipo}" name="${nombre}" value="${esc(o.codigo)}"${marcada}${req}><span>${esc(o.texto)}</span></label>`;
  }).join('');
  const pista = p.tipo === 'multiple' ? '<p class="nota">Puede marcar varias.</p>' : '';
  return `<fieldset class="${clase}"><legend>${esc(p.texto)}${ob}</legend>${imagen(p.imagen)}${pista}${opciones}</fieldset>`;
}

function pie(k) {
  if (!k.aviso && !k.aviso_url) return '';
  const enlace = k.aviso_url ? ` <a href="${esc(k.aviso_url)}" rel="noreferrer noopener" target="_blank">Más información</a>` : '';
  return `<p class="pie">${esc(k.aviso)}${enlace}</p>`;
}

export function paginaFormulario(base, k, codigo, campos = {}, errores = []) {
  const aviso = errores.length
    ? '<div class="tarjeta error" role="alert">Revise las preguntas marcadas: falta contestar alguna o la respuesta no es válida.</div>'
    : '';
  const preguntas = k.preguntas.map((p, i) => pregunta(p, i, campos, errores.includes(i))).join('');
  return documento(base, 'Consulta', `${aviso}
<div class="tarjeta">${imagen(k.imagen)}<p class="texto">${esc(k.texto)}</p></div>
<form method="post" action="/${esc(codigo)}">${preguntas}
<p class="nota">Puede contestar hasta el ${esc(fechaPlazo(k.plazo))}. Solo podrá contestar una vez.</p>
<button type="submit">Enviar respuesta</button></form>${pie(k)}`);
}

export function paginaAviso(base, titulo, texto) {
  return documento(base, titulo, `<div class="tarjeta"><h1>${esc(titulo)}</h1><p class="texto">${esc(texto)}</p></div>`);
}

export const AVISOS = {
  guardada: ['Respuesta registrada', 'Gracias. Ya puede cerrar esta página.'],
  contestada: ['Ya ha contestado', 'Su respuesta ya estaba registrada.'],
  caducada: ['Consulta terminada', 'El plazo para contestar ha terminado.'],
  no_existe: ['Enlace no válido', 'Compruebe que el enlace del SMS está completo.'],
  limite: ['Demasiados intentos', 'Inténtelo de nuevo dentro de unos minutos.'],
  error: ['No se ha podido completar', 'Ha habido un problema. Inténtelo de nuevo dentro de unos minutos.']
};
