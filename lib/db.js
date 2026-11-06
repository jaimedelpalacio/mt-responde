// lib/db.js
// Conexión a Postgres, esquema y operaciones de escritura.
//
// Cada escritura es una sola sentencia: así ningún bloqueo se mantiene durante un viaje de red,
// y una conexión cortada a mitad no puede dejar nada a medias.

import pg from 'pg';

const ESQUEMA = `
CREATE TABLE IF NOT EXISTS centros (
  id            text PRIMARY KEY,
  nombre        text NOT NULL,
  clave_hash    text NOT NULL UNIQUE,
  ultimo_numero bigint NOT NULL DEFAULT 0,
  creado_en     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS consultas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  centro_id   text NOT NULL REFERENCES centros(id),
  programa_id text NOT NULL,
  equipo_id   text,
  texto       text NOT NULL,
  imagen      text,
  aviso       text,
  aviso_url   text,
  preguntas   jsonb NOT NULL,
  plazo       timestamptz NOT NULL,
  creada_en   timestamptz NOT NULL DEFAULT now()
);
-- Solo si falta: un ALTER, aunque no haga nada, pide el bloqueo exclusivo de la tabla en cada arranque.
-- Antes del índice: si no, dos arranques a la vez se interbloquean.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'consultas' AND column_name = 'idioma'
  ) THEN
    ALTER TABLE consultas ADD COLUMN idioma text NOT NULL DEFAULT 'es';
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS consultas_plazo_idx ON consultas (plazo);

CREATE TABLE IF NOT EXISTS enlaces (
  codigo        text PRIMARY KEY,
  consulta_id   uuid NOT NULL REFERENCES consultas(id) ON DELETE CASCADE,
  ref           text NOT NULL,
  respondido_en timestamptz,
  UNIQUE (consulta_id, ref)
);

CREATE TABLE IF NOT EXISTS respuestas (
  centro_id   text NOT NULL REFERENCES centros(id),
  numero      bigint NOT NULL,
  consulta_id uuid NOT NULL REFERENCES consultas(id) ON DELETE CASCADE,
  ref         text NOT NULL,
  contenido   jsonb NOT NULL,
  recibida_en timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (centro_id, numero),
  UNIQUE (consulta_id, ref)
);
`;

// Las respuestas se borran 30 días después del plazo de su consulta.
const DIAS_RETENCION = 30;

function nuevoPool(url, max, esperaMs) {
  if (!url) throw new Error('Falta DATABASE_URL');
  const pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.DATABASE_SSL === '1' ? { rejectUnauthorized: false } : undefined,
    max,
    keepAlive: true,
    connectionTimeoutMillis: esperaMs,
    statement_timeout: 3000,
    query_timeout: 3200
  });
  // Sin esto, una conexión libre que se corta (reinicio de la BD) tira el proceso.
  pool.on('error', (e) => console.error('[pg]', e.code || e.name));
  return pool;
}

// Dos grupos de conexiones: una convocatoria con cientos de respuestas a la vez hace cola en el del
// formulario, sin frenar a Neo. Cada llamada de la API hace una sola consulta: espera más consulta
// suman 4 s, por debajo de los 5 s que aguanta un paso HTTP de los programas.
export function crearPools(url = process.env.DATABASE_URL) {
  return { api: nuevoPool(url, 3, 800), formulario: nuevoPool(url, 8, 15000) };
}

export async function crearEsquema(pool) {
  await pool.query(ESQUEMA);
}

export async function crearConsulta(pool, k, codigos) {
  const { rows } = await pool.query(
    `WITH nueva AS (
       INSERT INTO consultas (centro_id, programa_id, equipo_id, texto, imagen, aviso, aviso_url, preguntas, plazo, idioma)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $12)
       RETURNING id
     ), e AS (
       INSERT INTO enlaces (codigo, consulta_id, ref)
       SELECT t.codigo, nueva.id, t.ref FROM nueva, unnest($10::text[], $11::text[]) AS t(codigo, ref)
     )
     SELECT id FROM nueva`,
    [k.centro_id, k.programa_id, k.equipo_id, k.texto, k.imagen, k.aviso, k.aviso_url,
      JSON.stringify(k.preguntas), k.plazo, codigos, k.personas, k.idioma]
  );
  return rows[0].id;
}

// Guarda la respuesta y cierra el enlace; devuelve false si el enlace ya estaba cerrado o fuera de plazo.
//
// El número sale de la fila del centro: ese bloqueo dura hasta el final de la sentencia, así que las
// respuestas de un centro se hacen visibles en el mismo orden en que se numeran. Con una secuencia,
// la 11 podría verse antes que la 10, y Neo, que lee desde la última, nunca vería la 10.
export async function guardarRespuesta(pool, codigo, centroId, contenido) {
  const { rowCount } = await pool.query(
    `WITH e AS (
       UPDATE enlaces SET respondido_en = now()
        WHERE codigo = $1
          AND respondido_en IS NULL
          AND EXISTS (SELECT 1 FROM consultas k WHERE k.id = enlaces.consulta_id AND k.plazo > now())
       RETURNING consulta_id, ref
     ), n AS (
       UPDATE centros SET ultimo_numero = ultimo_numero + 1
        WHERE id = $2 AND EXISTS (SELECT 1 FROM e)
       RETURNING ultimo_numero
     )
     INSERT INTO respuestas (centro_id, numero, consulta_id, ref, contenido)
     SELECT $2, n.ultimo_numero, e.consulta_id, e.ref, $3::jsonb FROM e, n`,
    [codigo, centroId, JSON.stringify(contenido)]
  );
  return rowCount === 1;
}

// Por lotes: si se acumulan muchas, una sola sentencia superaría el tiempo máximo y no borraría nada.
export async function purgar(pool) {
  let total = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM consultas WHERE id IN (
         SELECT id FROM consultas WHERE plazo < now() - make_interval(days => $1) ORDER BY plazo LIMIT 20
       )`,
      [DIAS_RETENCION]
    );
    total += rowCount;
    if (rowCount < 20) return total;
  }
}
