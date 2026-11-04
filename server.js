// server.js
// mt-responde: consultas por SMS de Neo. Neo crea la consulta y envía los enlaces; aquí se contesta
// y se guardan las respuestas, que Neo lee cuando el caso lo necesita.

import { crearApp } from './lib/app.js';
import { crearClaves, REFRESCO_MS } from './lib/claves.js';
import { crearEsquema, crearPools, purgar } from './lib/db.js';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL;
const UNA_HORA = 60 * 60 * 1000;

if (!BASE_URL) throw new Error('Falta BASE_URL');

const pools = crearPools();

async function purgarConAviso() {
  try {
    const borradas = await purgar(pools.api);
    if (borradas) console.log(`[purga] ${borradas} consultas borradas`);
  } catch (e) {
    console.error('[purga]', e.code || e.name);
  }
}

const claves = crearClaves(pools.api);

await crearEsquema(pools.api);
await claves.cargar();
await purgarConAviso();
setInterval(purgarConAviso, UNA_HORA).unref();
// Si falla un refresco, siguen valiendo las claves que ya había.
setInterval(() => claves.cargar().catch((e) => console.error('[claves]', e.code || e.name)), REFRESCO_MS).unref();

const servidor = crearApp({ pools, claves, baseUrl: BASE_URL }).listen(PORT, () => {
  console.log(`mt-responde escuchando en el puerto ${PORT}`);
});

// Por encima de lo que el proxy de Render mantiene abierta una conexión: si Node la cierra antes, salen 502.
servidor.keepAliveTimeout = 120 * 1000;
servidor.headersTimeout = 125 * 1000;

process.on('SIGTERM', () => {
  servidor.close(() => Promise.allSettled([pools.api.end(), pools.formulario.end()]).finally(() => process.exit(0)));
  // close() no corta las conexiones keep-alive: sin esto, una petición en curso alarga el apagado 120 s.
  setInterval(() => servidor.closeIdleConnections(), 500).unref();
});
