// scripts/alta-centro.js
// Da de alta un centro o renueva su clave. La clave solo se muestra aquí; en la BD queda su hash.
// Uso: DATABASE_URL=... node scripts/alta-centro.js <id del centro en Neo> "<nombre>"

import crypto from 'crypto';
import { hashClave } from '../lib/app.js';
import { crearEsquema, crearPools } from '../lib/db.js';

const [id, nombre] = process.argv.slice(2);
if (!id || !nombre) {
  console.error('Uso: node scripts/alta-centro.js <id del centro en Neo> "<nombre>"');
  process.exit(1);
}

const { api: pool, formulario } = crearPools();
await crearEsquema(pool);
const clave = crypto.randomBytes(32).toString('base64url');
await pool.query(
  `INSERT INTO centros (id, nombre, clave_hash) VALUES ($1, $2, $3)
   ON CONFLICT (id) DO UPDATE SET nombre = excluded.nombre, clave_hash = excluded.clave_hash`,
  [id, nombre, hashClave(clave)]
);
await Promise.all([pool.end(), formulario.end()]);
console.log(`Centro: ${id} (${nombre})\nClave (no se vuelve a mostrar): ${clave}`);
