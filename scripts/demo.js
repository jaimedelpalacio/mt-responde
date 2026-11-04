// scripts/demo.js
// Arranca el servicio en local con un Postgres de usar y tirar y una consulta de ejemplo, para verlo
// en el navegador. Solo para desarrollo: usa dependencias de desarrollo y borra los datos al parar.

import { altaCentro, arrancarPostgres } from '../test/ayuda.js';
import { crearApp } from '../lib/app.js';
import { crearClaves } from '../lib/claves.js';
import { crearEsquema, crearPools } from '../lib/db.js';

const PORT = Number(process.env.PORT || 4173);
const BASE = `http://localhost:${PORT}`;

const pg = await arrancarPostgres();
const pools = crearPools(pg.url);
await crearEsquema(pools.api);
const clave = await altaCentro(pools.api, 'centro-demo');
const claves = crearClaves(pools.api);
await claves.cargar();

const servidor = crearApp({ pools, claves, baseUrl: BASE }).listen(PORT, async () => {
  const r = await fetch(`${BASE}/api/consultas`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': clave },
    body: JSON.stringify({
      centro_id: 'centro-demo',
      programa_id: 'programa-demo',
      equipo_id: 'equipo-demo',
      texto: 'Convocatoria del simulacro de evacuación del jueves.\nConteste antes de que termine el plazo, por favor.',
      imagen: 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png',
      aviso: 'Sus respuestas se usan solo para organizar este simulacro.',
      aviso_url: 'https://missiontrack.es/',
      plazo: new Date(Date.now() + 26 * 3600 * 1000).toISOString(),
      preguntas: [
        { codigo: 'asiste', texto: '¿Podrá asistir?', tipo: 'simple', obligatoria: true, opciones: [{ codigo: 'si', texto: 'Sí' }, { codigo: 'no', texto: 'No' }, { codigo: 'quiza', texto: 'Todavía no lo sé' }] },
        { codigo: 'medios', texto: '¿Qué medios aporta?', tipo: 'multiple', opciones: [{ codigo: 'vehiculo', texto: 'Vehículo propio' }, { codigo: 'radio', texto: 'Radio portátil' }, { codigo: 'botiquin', texto: 'Botiquín' }] },
        { codigo: 'leido', texto: 'He leído las instrucciones del simulacro', tipo: 'casilla', obligatoria: true }
      ],
      personas: ['ana', 'luis', 'marta']
    })
  });
  const { consulta_id, enlaces } = await r.json();
  console.log(`Consulta ${consulta_id}`);
  for (const e of enlaces) console.log(`${e.ref}: ${e.enlace}`);
  console.log(`Clave de la API: ${clave}`);
});

async function parar() {
  servidor.close();
  await Promise.allSettled([pools.api.end(), pools.formulario.end()]);
  await pg.parar().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', parar);
process.on('SIGTERM', parar);
