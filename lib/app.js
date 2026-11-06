// lib/app.js
// Rutas del servicio: API para los programas de Neo y formulario público.

import crypto from 'crypto';
import express from 'express';
import fs from 'fs';
import { crearConsulta, guardarRespuesta } from './db.js';
import { CABECERAS_PAGINA, paginaAviso, paginaFormulario } from './paginas.js';
import { IDIOMA_POR_DEFECTO, IDIOMAS } from './textos.js';
import { validarConsulta, validarRespuesta } from './validar.js';

const ALFABETO = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
// Unos 59 bits, y deja 124 caracteres de texto en el SMS con r.missiontrack.eu. Con esto no hace falta
// limitar intentos: a mil peticiones por segundo, acertar uno de 2.000 enlaces vivos costaría miles de años.
const LARGO_CODIGO = 10;
const RE_CODIGO_ENLACE = new RegExp(`^[A-Za-z0-9]{${LARGO_CODIGO}}$`);
const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RE_ID = /^[A-Za-z0-9_-]{1,100}$/;
const RE_ENTERO = /^\d+$/;
const LIMITE_LECTURA = 50;
const MAX_COLA_FORMULARIO = 500; // Con más, mejor decir «inténtelo luego» que acumular peticiones hasta agotar la memoria.
// Los dos nombres de apple-touch-icon los pide el iPhone sin mirar la página.
const IMAGENES = {
  '/logo.png': 'logo.png',
  '/vista-previa.png': 'vista-previa.png',
  '/icono.png': 'icono.png',
  '/apple-touch-icon.png': 'icono.png',
  '/apple-touch-icon-precomposed.png': 'icono.png'
};

export function generarCodigo() {
  let codigo = '';
  for (let i = 0; i < LARGO_CODIGO; i++) codigo += ALFABETO[crypto.randomInt(ALFABETO.length)];
  return codigo;
}

export function hashClave(clave) {
  return crypto.createHash('sha256').update(clave).digest('hex');
}

// Express 4 no recoge los errores de las rutas async.
const seguro = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function entero(valor, porDefecto) {
  if (valor === undefined) return porDefecto;
  if (typeof valor !== 'string' || !RE_ENTERO.test(valor)) return null;
  const n = Number(valor);
  return Number.isSafeInteger(n) ? n : null;
}

export function crearApp({ pools, claves, baseUrl }) {
  const pool = pools.api;
  const app = express();
  app.disable('x-powered-by');
  const base = String(baseUrl).replace(/\/+$/, '');

  app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow: /\n'));
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  for (const [rutaImagen, fichero] of Object.entries(IMAGENES)) {
    const imagen = fs.readFileSync(new URL(`../public/${fichero}`, import.meta.url));
    app.get(rutaImagen, (req, res) => res.set('Cache-Control', 'public, max-age=604800').type('png').send(imagen));
  }

  app.get('/health', seguro(async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  }));

  // ========================= API PARA NEO =========================
  const api = express.Router();

  // La clave se comprueba antes de leer el cuerpo: sin clave no se procesa nada.
  api.use((req, res, next) => {
    const clave = req.get('x-api-key');
    req.centroId = clave ? claves.centro(hashClave(clave)) : null;
    if (!req.centroId) return res.status(401).json({ error: 'clave_no_valida' });
    next();
  });
  api.use(express.json({ limit: '1mb' }));

  api.post('/consultas', seguro(async (req, res) => {
    const { errores, consulta } = validarConsulta(req.body);
    if (errores.length) return res.status(400).json({ error: 'datos_no_validos', detalle: errores });
    // Una copia del programa en otro centro se lleva la clave del original: que falle, no que se mezclen.
    if (consulta.centro_id !== req.centroId) return res.status(403).json({ error: 'clave_de_otro_centro' });

    const codigos = consulta.personas.map(() => generarCodigo());
    const id = await crearConsulta(pool, consulta, codigos);

    // Los enlaces solo se entregan aquí: con la clave no se pueden volver a pedir.
    res.status(201).json({
      consulta_id: id,
      enlaces: consulta.personas.map((ref, i) => ({ ref, enlace: `${base}/${codigos[i]}` }))
    });
  }));

  api.get('/respuestas', seguro(async (req, res) => {
    const desde = entero(req.query.desde, 0);
    const pedido = entero(req.query.limite, LIMITE_LECTURA);
    const { programa_id: programa, consulta_id: consulta } = req.query;
    if (desde === null) return res.status(400).json({ error: 'desde_no_valido' });
    if (pedido === null || pedido < 1 || pedido > LIMITE_LECTURA) return res.status(400).json({ error: 'limite_no_valido' });
    if (programa !== undefined && (typeof programa !== 'string' || !RE_ID.test(programa))) return res.status(400).json({ error: 'programa_no_valido' });
    if (consulta !== undefined && (typeof consulta !== 'string' || !RE_UUID.test(consulta))) return res.status(400).json({ error: 'consulta_no_valida' });

    // Siempre devuelve al menos una fila, con el último número del centro.
    const { rows } = await pool.query(
      `SELECT c.ultimo_numero, x.*
         FROM centros c
         LEFT JOIN LATERAL (
           SELECT r.numero, r.consulta_id, k.programa_id, k.equipo_id, r.ref, r.contenido, r.recibida_en
             FROM respuestas r JOIN consultas k ON k.id = r.consulta_id
            WHERE r.centro_id = c.id AND r.numero > $2
              AND ($3::text IS NULL OR k.programa_id = $3)
              AND ($4::uuid IS NULL OR r.consulta_id = $4)
            ORDER BY r.numero
            LIMIT $5
         ) x ON true
        WHERE c.id = $1
        ORDER BY x.numero`,
      [req.centroId, desde, programa ?? null, consulta ?? null, pedido + 1]
    );
    // Centro borrado con su clave aún en memoria, hasta el siguiente refresco.
    if (!rows.length) return res.status(401).json({ error: 'clave_no_valida' });
    // Un cursor por delante (BD restaurada, programa copiado con su resultado) no vería nada sin avisar.
    if (desde > Number(rows[0].ultimo_numero)) return res.status(409).json({ error: 'desde_por_delante', ultimo: Number(rows[0].ultimo_numero) });
    const filas = rows.filter((r) => r.numero !== null);
    const pagina = filas.slice(0, pedido).map(({ ultimo_numero, ...r }) => ({ ...r, numero: Number(r.numero) }));
    res.json({
      respuestas: pagina,
      ultimo: pagina.length ? pagina[pagina.length - 1].numero : desde,
      hay_mas: filas.length > pedido
    });
  }));

  api.get('/consultas/:id/estado', seguro(async (req, res) => {
    if (!RE_UUID.test(req.params.id)) return res.status(404).json({ error: 'no_existe' });
    const { rows } = await pool.query(
      `SELECT k.plazo, k.plazo > now() AS abierta, count(*)::int AS total, count(e.respondido_en)::int AS contestadas,
              coalesce(array_agg(e.ref ORDER BY e.ref) FILTER (WHERE e.respondido_en IS NULL), '{}') AS faltan
         FROM consultas k JOIN enlaces e ON e.consulta_id = k.id
        WHERE k.id = $1 AND k.centro_id = $2
        GROUP BY k.id`,
      [req.params.id, req.centroId]
    );
    if (!rows.length) return res.status(404).json({ error: 'no_existe' });
    res.json({ consulta_id: req.params.id, ...rows[0] });
  }));

  api.use((req, res) => res.status(404).json({ error: 'no_existe' }));
  app.use('/api', api);

  // ========================= FORMULARIO =========================
  // Sin consulta conocida no hay idioma elegido por el programa: se usa el del navegador.
  // Si un fallo llega al manejador de errores con la consulta ya cargada, res.locals conserva el suyo.
  function idiomaNavegador(req) {
    return req.acceptsLanguages(IDIOMAS) || IDIOMA_POR_DEFECTO;
  }

  function pagina(req, res, estado, clave, idioma = res.locals.idioma ?? idiomaNavegador(req)) {
    res.status(estado).set(CABECERAS_PAGINA).type('html').send(paginaAviso(base, idioma, clave));
  }

  function paginaCerrado(req, res, k) {
    if (k.respondido_en) return pagina(req, res, 200, 'contestada', k.idioma);
    return pagina(req, res, 410, 'caducada', k.idioma);
  }

  async function cargarConsulta(codigo) {
    const { rows } = await pools.formulario.query(
      `SELECT e.respondido_en, k.centro_id, k.texto, k.imagen, k.aviso, k.aviso_url, k.preguntas, k.plazo, k.idioma, k.plazo <= now() AS caducada
         FROM enlaces e JOIN consultas k ON k.id = e.consulta_id
        WHERE e.codigo = $1`,
      [codigo]
    );
    return rows[0] ?? null;
  }

  function codigoValido(req, res, next) {
    if (!RE_CODIGO_ENLACE.test(req.params.codigo)) return pagina(req, res, 404, 'no_existe');
    if (pools.formulario.waitingCount > MAX_COLA_FORMULARIO) return pagina(req, res, 503, 'error');
    next();
  }

  // Abrir el enlace no cambia nada: los antivirus y las vistas previas también lo abren.
  app.get('/:codigo', codigoValido, seguro(async (req, res) => {
    const k = await cargarConsulta(req.params.codigo);
    if (!k) return pagina(req, res, 404, 'no_existe');
    if (k.respondido_en || k.caducada) return paginaCerrado(req, res, k);
    res.set(CABECERAS_PAGINA).type('html').send(paginaFormulario(base, k, req.params.codigo));
  }));

  app.post('/:codigo', codigoValido, express.urlencoded({ extended: false, limit: '100kb', parameterLimit: 3000 }), seguro(async (req, res) => {
    if (!req.is('application/x-www-form-urlencoded')) return pagina(req, res, 415, 'error');
    const k = await cargarConsulta(req.params.codigo);
    if (!k) return pagina(req, res, 404, 'no_existe');
    if (k.respondido_en || k.caducada) return paginaCerrado(req, res, k);

    res.locals.idioma = k.idioma;
    const campos = req.body ?? {};
    const { contenido, errores } = validarRespuesta(k.preguntas, campos);
    if (errores.length) {
      return res.status(422).set(CABECERAS_PAGINA).type('html').send(paginaFormulario(base, k, req.params.codigo, campos, errores));
    }

    if (await guardarRespuesta(pools.formulario, req.params.codigo, k.centro_id, contenido)) return pagina(req, res, 200, 'guardada', k.idioma);
    // Otro envío o el plazo se han adelantado entre la lectura y el guardado.
    paginaCerrado(req, res, await cargarConsulta(req.params.codigo));
  }));

  app.use((req, res) => pagina(req, res, 404, 'no_existe'));

  // Sin texto de las peticiones en los logs: podrían llevar códigos de enlace.
  app.use((err, req, res, next) => {
    console.error('[error]', req.method, err?.code || err?.name || 'desconocido', err?.status || '');
    if (res.headersSent) return next(err);
    const estado = err?.status && err.status < 500 ? err.status : 500;
    if (req.path.startsWith('/api/')) return res.status(estado).json({ error: estado < 500 ? 'peticion_no_valida' : 'error_interno' });
    pagina(req, res, estado, 'error');
  });

  return app;
}
