// test/ayuda.js
// Postgres real (embedded-postgres) y el servicio en un puerto libre, para probar como en producción:
// los bloqueos y el orden de las respuestas no se pueden comprobar con una BD simulada.

import crypto from 'crypto';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import EmbeddedPostgres from 'embedded-postgres';
import { crearApp, hashClave } from '../lib/app.js';
import { crearClaves } from '../lib/claves.js';
import { crearEsquema, crearPools } from '../lib/db.js';

function puertoLibre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export async function arrancarPostgres(directorio) {
  const puerto = await puertoLibre();
  const clave = crypto.randomBytes(12).toString('hex');
  const dir = directorio ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mt-responde-pg-'));
  const persistente = fs.existsSync(path.join(dir, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: clave, port: puerto, persistent: !!directorio, initdbFlags: ['--encoding=UTF8', '--locale=C'], onLog: () => {}, onError: () => {} });
  if (!persistente) await pg.initialise();
  await pg.start();
  if (!persistente) await pg.createDatabase('mt');
  return {
    url: `postgres://postgres:${clave}@127.0.0.1:${puerto}/mt`,
    parar: () => pg.stop()
  };
}

export async function arrancarServicio(url) {
  const pools = crearPools(url);
  await crearEsquema(pools.api);
  const puerto = await puertoLibre();
  const base = `http://127.0.0.1:${puerto}`;
  const claves = crearClaves(pools.api);
  await claves.cargar();
  const app = crearApp({ pools, claves, baseUrl: base });
  const servidor = await new Promise((resolve) => {
    const s = app.listen(puerto, '127.0.0.1', () => resolve(s));
  });
  return {
    pool: pools.api,
    pools,
    claves,
    base,
    parar: async () => {
      await new Promise((resolve) => {
        servidor.close(resolve);
        servidor.closeAllConnections();
      });
      await Promise.allSettled([pools.api.end(), pools.formulario.end()]);
    }
  };
}

export async function altaCentro(pool, id) {
  const clave = crypto.randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO centros (id, nombre, clave_hash) VALUES ($1, $2, $3)', [id, id, hashClave(clave)]);
  return clave;
}

export function consultaDePrueba(centro, cambios = {}) {
  return {
    centro_id: centro,
    programa_id: 'programa-1',
    equipo_id: 'equipo-1',
    texto: '¿Puede venir al simulacro?',
    plazo: new Date(Date.now() + 3600 * 1000).toISOString(),
    preguntas: [
      { codigo: 'viene', texto: '¿Viene?', tipo: 'simple', obligatoria: true, opciones: [{ codigo: 'si', texto: 'Sí' }, { codigo: 'no', texto: 'No' }] },
      { codigo: 'medios', texto: '¿Con qué medios?', tipo: 'multiple', opciones: [{ codigo: 'coche', texto: 'Coche' }, { codigo: 'moto', texto: 'Moto' }, { codigo: 'pie', texto: 'A pie' }] },
      { codigo: 'leido', texto: 'He leído el aviso', tipo: 'casilla', obligatoria: true }
    ],
    personas: ['ana', 'luis'],
    ...cambios
  };
}

export function formulario(pares) {
  const datos = new URLSearchParams();
  for (const [k, v] of pares) datos.append(k, v);
  return { method: 'POST', body: datos, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' };
}
