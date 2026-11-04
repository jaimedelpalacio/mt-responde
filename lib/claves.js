// lib/claves.js
// Claves de los centros en memoria: son pocas, y así una clave falsa nunca gasta una conexión a la BD
// que pueda necesitar Neo. Un alta o una renovación tarda como mucho un refresco en aplicarse.

export const REFRESCO_MS = 30 * 1000;

export function crearClaves(pool) {
  let centros = new Map();

  return {
    centro(hash) {
      return centros.get(hash) ?? null;
    },
    async cargar() {
      const { rows } = await pool.query('SELECT id, clave_hash FROM centros');
      centros = new Map(rows.map((r) => [r.clave_hash, r.id]));
    }
  };
}
