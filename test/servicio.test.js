// test/servicio.test.js
// Pruebas de extremo a extremo contra Postgres real.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import pg from 'pg';
import { guardarRespuesta, purgar } from '../lib/db.js';
import { altaCentro, arrancarPostgres, arrancarServicio, consultaDePrueba, formulario } from './ayuda.js';

let bd;
let srv;
let claveA;
let claveB;

function api(clave, ruta, opciones = {}) {
  return fetch(`${srv.base}/api${ruta}`, {
    ...opciones,
    headers: { 'content-type': 'application/json', ...(clave ? { 'x-api-key': clave } : {}), ...opciones.headers }
  });
}

async function crear(clave = claveA, centro = 'centro-a', cambios = {}) {
  const r = await api(clave, '/consultas', { method: 'POST', body: JSON.stringify(consultaDePrueba(centro, cambios)) });
  assert.equal(r.status, 201);
  return r.json();
}

function ruta(enlace) {
  return enlace.replace(srv.base, '');
}

const RESPUESTA_OK = [['p0', 'si'], ['p1', 'coche'], ['p1', 'pie'], ['p2', '1']];

function contestar(enlace, pares = RESPUESTA_OK) {
  return fetch(enlace, formulario(pares));
}

// Abre todas las conexiones antes de medir: con el pool en frío, las peticiones casi no llegan a solaparse.
async function calentarPool() {
  await Promise.all(Array.from({ length: 8 }, () => srv.pools.formulario.query('SELECT pg_sleep(0.05)')));
}

// Reparte el arranque unos milisegundos: abrir cientos de conexiones de golpe hacia un servidor recién
// arrancado da ECONNREFUSED en Windows, y eso no es lo que se quiere probar.
function espera(i) {
  return new Promise((r) => setTimeout(r, i));
}

async function leer(clave = claveA, consulta = '') {
  const r = await api(clave, `/respuestas${consulta}`);
  assert.equal(r.status, 200);
  return r.json();
}

before(async () => {
  bd = await arrancarPostgres();
  srv = await arrancarServicio(bd.url);
});

after(async () => {
  await srv.parar();
  await bd.parar();
});

beforeEach(async () => {
  await srv.pool.query('TRUNCATE respuestas, enlaces, consultas, centros');
  claveA = await altaCentro(srv.pool, 'centro-a');
  claveB = await altaCentro(srv.pool, 'centro-b');
  await srv.claves.cargar();
});

describe('crear consultas', () => {
  test('devuelve un enlace distinto por persona', async () => {
    const { consulta_id, enlaces } = await crear();
    assert.match(consulta_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(enlaces.map((e) => e.ref), ['ana', 'luis']);
    assert.notEqual(enlaces[0].enlace, enlaces[1].enlace);
    for (const e of enlaces) assert.match(ruta(e.enlace), /^\/[A-Za-z0-9]{10}$/);
  });

  test('sin clave o con clave falsa no entra', async () => {
    const cuerpo = JSON.stringify(consultaDePrueba('centro-a'));
    assert.equal((await api(null, '/consultas', { method: 'POST', body: cuerpo })).status, 401);
    assert.equal((await api('falsa', '/consultas', { method: 'POST', body: cuerpo })).status, 401);
  });

  test('una clave no sirve para otro centro (copia de un programa)', async () => {
    const r = await api(claveA, '/consultas', { method: 'POST', body: JSON.stringify(consultaDePrueba('centro-b')) });
    assert.equal(r.status, 403);
    assert.equal((await srv.pool.query('SELECT count(*)::int AS n FROM consultas')).rows[0].n, 0);
  });

  test('rechaza datos no válidos', async () => {
    const opciones = [{ codigo: 'a', texto: 'A' }, { codigo: 'b', texto: 'B' }];
    const casos = {
      'plazo pasado': { plazo: new Date(Date.now() - 1000).toISOString() },
      'plazo sin zona': { plazo: '2030-01-01T10:00:00' },
      'plazo de más de 30 días': { plazo: new Date(Date.now() + 31 * 86400000).toISOString() },
      'imagen http': { imagen: 'http://ejemplo.com/a.png' },
      'imagen javascript': { imagen: 'javascript:alert(1)' },
      'imagen de pregunta http': { preguntas: [{ codigo: 'a', texto: 'A', tipo: 'casilla', imagen: 'http://ejemplo.com/a.png' }] },
      'imagen de pregunta javascript': { preguntas: [{ codigo: 'a', texto: 'A', tipo: 'casilla', imagen: 'javascript:alert(1)' }] },
      'aviso_url http': { aviso_url: 'http://ejemplo.com' },
      'sin personas': { personas: [] },
      'personas repetidas': { personas: ['ana', 'ana'] },
      'teléfono como referencia': { personas: ['+34600000000'] },
      'teléfono sin prefijo': { personas: ['600000000'] },
      'teléfono con 34': { personas: ['34600000000'] },
      'NUL en un texto': { texto: 'a\0b' },
      'emoji partido': { texto: 'aviso \ud83d' },
      'código __proto__': { preguntas: [{ codigo: '__proto__', texto: 'X', tipo: 'casilla' }] },
      'sin preguntas': { preguntas: [] },
      'tipo texto libre': { preguntas: [{ codigo: 'x', texto: 'X', tipo: 'texto' }] },
      'casilla con opciones': { preguntas: [{ codigo: 'x', texto: 'X', tipo: 'casilla', opciones }] },
      'simple con una opción': { preguntas: [{ codigo: 'x', texto: 'X', tipo: 'simple', opciones: [opciones[0]] }] },
      'opciones repetidas': { preguntas: [{ codigo: 'x', texto: 'X', tipo: 'simple', opciones: [opciones[0], opciones[0]] }] },
      'preguntas repetidas': { preguntas: [{ codigo: 'x', texto: 'X', tipo: 'casilla' }, { codigo: 'x', texto: 'Y', tipo: 'casilla' }] },
      'pregunta nula': { preguntas: [null] },
      'centro no texto': { centro_id: ['centro-a'] },
      'fecha que no existe': { plazo: '2030-11-31T10:00:00Z' },
      'NUL en una imagen': { imagen: 'https://a.es/\0' },
      'emoji partido en una imagen': { aviso_url: 'https://a.es/\ud83d' },
      'teléfono con puntos': { personas: ['600.000.000'] },
      'teléfono con guiones': { personas: ['34-600-000-000'] },
      'teléfono con tel:': { personas: ['tel:600000000'] },
    };
    for (const [nombre, cambios] of Object.entries(casos)) {
      const r = await api(claveA, '/consultas', { method: 'POST', body: JSON.stringify(consultaDePrueba('centro-a', cambios)) });
      assert.equal(r.status, 400, nombre);
    }
  });

  test('un emoji válido se guarda y se muestra', async () => {
    const { enlaces } = await crear(claveA, 'centro-a', { texto: 'Aviso 🔥 ñ' });
    assert.match(await (await fetch(enlaces[0].enlace)).text(), /Aviso 🔥 ñ/);
  });

  test('las referencias de perfil normales se aceptan', async () => {
    await crear(claveA, 'centro-a', { personas: ['cce30729-d7d8-474c-ac3a-384819062816', 'p:12'] });
  });

  test('sin clave no se lee el cuerpo', async () => {
    const r = await api(null, '/consultas', { method: 'POST', body: '{roto' });
    assert.equal(r.status, 401);
  });

  test('JSON roto no tira el servicio', async () => {
    const r = await api(claveA, '/consultas', { method: 'POST', body: '{roto' });
    assert.equal(r.status, 400);
    assert.equal((await api(claveA, '/respuestas')).status, 200);
  });
});

describe('formulario', () => {
  test('abrir el enlace muestra las preguntas y no cambia nada', async () => {
    const { enlaces, consulta_id } = await crear();
    for (let i = 0; i < 3; i++) {
      const r = await fetch(enlaces[0].enlace);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /¿Puede venir al simulacro\?/);
      assert.match(html, /type="radio" name="p0" value="si"/);
      assert.match(html, /type="checkbox" name="p1" value="coche"/);
      assert.match(html, /type="checkbox" name="p2" value="1"/);
    }
    const estado = await (await api(claveA, `/consultas/${consulta_id}/estado`)).json();
    assert.equal(estado.contestadas, 0);
  });

  test('cabeceras: sin referrer, sin scripts, fuera de buscadores', async () => {
    const { enlaces } = await crear();
    const r = await fetch(enlaces[0].enlace);
    assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(r.headers.get('x-robots-tag'), 'noindex, nofollow');
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(r.headers.get('content-security-policy'), /form-action 'self'/);
    assert.match(r.headers.get('content-security-policy'), /img-src https: 'self'/);
    assert.doesNotMatch(r.headers.get('content-security-policy'), /script-src/);
    assert.equal(r.headers.get('x-powered-by'), null);
  });

  test('el hash de la CSP coincide con el CSS servido', async () => {
    const { enlaces } = await crear();
    const r = await fetch(enlaces[0].enlace);
    const css = (await r.text()).match(/<style>([\s\S]*?)<\/style>/)[1];
    const hash = crypto.createHash('sha256').update(css).digest('base64');
    assert.ok(r.headers.get('content-security-policy').includes(`style-src 'sha256-${hash}'`));
  });

  test('una pregunta con error lo dice con texto, no solo con el color', async () => {
    const { enlaces } = await crear();
    const r = await contestar(enlaces[0].enlace, [['p0', 'si'], ['p1', 'coche']]);
    assert.equal(r.status, 422);
    const html = await r.text();
    assert.equal((html.match(/<p class="aviso-pregunta">Revise esta pregunta\.<\/p>/g) ?? []).length, 1);
    const antes = await (await fetch(enlaces[0].enlace)).text();
    assert.ok(!antes.includes('<p class="aviso-pregunta">'));
  });

  test('explica el asterisco solo si hay preguntas obligatorias', async () => {
    const conObligatoria = await crear();
    assert.ok((await (await fetch(conObligatoria.enlaces[0].enlace)).text()).includes('Las preguntas con * son obligatorias.'));
    const sinObligatoria = await crear(claveA, 'centro-a', {
      preguntas: [{ codigo: 'a', texto: '¿Viene?', tipo: 'simple', opciones: [{ codigo: 'si', texto: 'Sí' }, { codigo: 'no', texto: 'No' }] }]
    });
    assert.ok(!(await (await fetch(sinObligatoria.enlaces[0].enlace)).text()).includes('Las preguntas con *'));
  });

  test('al tocar la imagen se abre la original, sin pasar el código de la persona', async () => {
    const url = 'https://ejemplo.com/plano.png?a=1&b=2';
    const { enlaces } = await crear(claveA, 'centro-a', { imagen: url });
    const html = await (await fetch(enlaces[0].enlace)).text();
    const u = 'https://ejemplo.com/plano.png?a=1&amp;b=2';
    assert.ok(html.includes(`<a href="${u}" rel="noreferrer noopener" target="_blank"><img src="${u}" alt="Abrir la imagen original" referrerpolicy="no-referrer"></a>`));
  });

  test('la imagen de cada tipo de pregunta sale, y fuera de las opciones', async () => {
    const opciones = [{ codigo: 'si', texto: 'Sí' }, { codigo: 'no', texto: 'No' }];
    const { enlaces } = await crear(claveA, 'centro-a', {
      preguntas: [
        { codigo: 'a', texto: 'A', tipo: 'simple', imagen: 'https://ejemplo.com/a.png', opciones },
        { codigo: 'b', texto: 'B', tipo: 'multiple', imagen: 'https://ejemplo.com/b.png', opciones },
        { codigo: 'c', texto: 'C', tipo: 'casilla', imagen: 'https://ejemplo.com/c.png' }
      ]
    });
    const html = await (await fetch(enlaces[0].enlace)).text();
    for (const letra of ['a', 'b', 'c']) {
      const enlace = `<a href="https://ejemplo.com/${letra}.png"`;
      assert.ok(html.includes(enlace), letra);
      const antes = html.slice(0, html.indexOf(enlace));
      assert.ok(antes.lastIndexOf('<label') <= antes.lastIndexOf('</label>'), `${letra}: dentro de una opción`);
    }
  });

  test('la nota del plazo se lee bien', async () => {
    const { enlaces } = await crear();
    const html = await (await fetch(enlaces[0].enlace)).text();
    assert.match(html, /Las preguntas con \* son obligatorias\. Puede contestar hasta el \d{1,2} de \S+ de \d{4} a las \d{2}:\d{2}\. Solo podrá contestar una vez\./);
  });

  test('los controles del navegador siguen el modo oscuro', async () => {
    const { enlaces } = await crear();
    assert.match(await (await fetch(enlaces[0].enlace)).text(), /:root\{color-scheme:light dark;/);
  });

  test('logo y vista previa genérica, sin el texto de la consulta', async () => {
    const { enlaces } = await crear(claveA, 'centro-a', { texto: 'Texto reservado de la consulta' });
    const html = await (await fetch(enlaces[0].enlace)).text();
    const cabecera = html.slice(0, html.indexOf('</head>'));
    assert.match(html, /<img src="\/logo\.png" alt="Mission Track Neo"/);
    assert.ok(cabecera.includes(`<meta property="og:image" content="${srv.base}/vista-previa.png">`));
    assert.match(cabecera, /<meta property="og:title" content="Mission Track Neo">/);
    assert.ok(!cabecera.includes('reservado'), 'la vista previa no lleva el texto');
    assert.ok(html.includes('Texto reservado de la consulta'));
  });

  test('el logo también sale en los avisos', async () => {
    const r = await fetch(`${srv.base}/AAAAAAAAAA`);
    assert.equal(r.status, 404);
    const html = await r.text();
    assert.match(html, /<img src="\/logo\.png"/);
    assert.ok(html.includes(`${srv.base}/vista-previa.png`));
  });

  test('escapa los textos del programa', async () => {
    const malo = '<script>alert(1)</script>"\'&';
    const { enlaces } = await crear(claveA, 'centro-a', {
      texto: malo,
      aviso: malo,
      preguntas: [{ codigo: 'x', texto: malo, tipo: 'simple', opciones: [{ codigo: 'a', texto: malo }, { codigo: 'b', texto: 'B' }] }]
    });
    const html = await (await fetch(enlaces[0].enlace)).text();
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&#39;&amp;/);
  });

  test('una imagen con comillas no rompe el HTML', async () => {
    const { enlaces } = await crear(claveA, 'centro-a', { imagen: 'https://ejemplo.com/a.png?x="><script>alert(1)</script>' });
    const html = await (await fetch(enlaces[0].enlace)).text();
    assert.doesNotMatch(html, /<script>/);
  });

  test('guarda simple, múltiple y casilla, y cierra el enlace', async () => {
    const { enlaces } = await crear();
    const r = await contestar(enlaces[0].enlace);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Respuesta registrada/);

    const { respuestas } = await leer();
    assert.equal(respuestas.length, 1);
    assert.equal(respuestas[0].ref, 'ana');
    assert.equal(respuestas[0].programa_id, 'programa-1');
    assert.equal(respuestas[0].equipo_id, 'equipo-1');
    assert.deepEqual(respuestas[0].contenido, { viene: 'si', medios: ['coche', 'pie'], leido: true });

    assert.match(await (await fetch(enlaces[0].enlace)).text(), /Ya ha contestado/);
    const repetida = await contestar(enlaces[0].enlace, [['p0', 'no'], ['p2', '1']]);
    assert.match(await repetida.text(), /Ya ha contestado/);
    assert.deepEqual((await leer()).respuestas[0].contenido.viene, 'si');
    assert.equal((await leer()).respuestas.length, 1);
  });

  test('las no obligatorias pueden quedar vacías', async () => {
    const { enlaces } = await crear(claveA, 'centro-a', {
      preguntas: [
        { codigo: 's', texto: 'S', tipo: 'simple', opciones: [{ codigo: 'a', texto: 'A' }, { codigo: 'b', texto: 'B' }] },
        { codigo: 'm', texto: 'M', tipo: 'multiple', opciones: [{ codigo: 'a', texto: 'A' }, { codigo: 'b', texto: 'B' }] },
        { codigo: 'c', texto: 'C', tipo: 'casilla' }
      ]
    });
    assert.equal((await contestar(enlaces[0].enlace, [])).status, 200);
    assert.deepEqual((await leer()).respuestas[0].contenido, { s: null, m: [], c: false });
  });

  test('si falta una obligatoria, no se gasta el enlace y conserva lo marcado', async () => {
    const { enlaces } = await crear();
    const r = await contestar(enlaces[0].enlace, [['p1', 'moto']]);
    assert.equal(r.status, 422);
    const html = await r.text();
    assert.match(html, /role="alert"/);
    assert.match(html, /value="moto" checked/);
    assert.equal((await leer()).respuestas.length, 0);
    assert.equal((await contestar(enlaces[0].enlace)).status, 200);
  });

  test('rechaza códigos inventados, varias en una simple y texto metido a mano', async () => {
    const { enlaces } = await crear();
    const casos = [
      [['p0', 'inventado'], ['p2', '1']],
      [['p0', 'si'], ['p0', 'no'], ['p2', '1']],
      [['p0', 'si'], ['p1', 'coche'], ['p1', '<script>'], ['p2', '1']],
      [['p0', '`${alert(1)}`'], ['p2', '1']]
    ];
    for (const pares of casos) assert.equal((await contestar(enlaces[0].enlace, pares)).status, 422);
    assert.equal((await leer()).respuestas.length, 0);
  });

  test('campos desconocidos no llegan a Neo', async () => {
    const { enlaces } = await crear();
    await contestar(enlaces[0].enlace, [...RESPUESTA_OK, ['p99', 'texto libre'], ['__proto__', 'x']]);
    assert.deepEqual(Object.keys((await leer()).respuestas[0].contenido).sort(), ['leido', 'medios', 'viene']);
  });

  test('una casilla solo se marca con su valor', async () => {
    const { enlaces } = await crear(claveA, 'centro-a', { preguntas: [{ codigo: 'c', texto: 'C', tipo: 'casilla' }] });
    await contestar(enlaces[0].enlace, [['p0', 'inventado']]);
    assert.deepEqual((await leer()).respuestas[0].contenido, { c: false });
  });

  test('el guardado comprueba el plazo por sí mismo', async () => {
    const { enlaces, consulta_id } = await crear();
    await srv.pool.query("UPDATE consultas SET plazo = now() - interval '1 second' WHERE id = $1", [consulta_id]);
    assert.equal(await guardarRespuesta(srv.pools.formulario, ruta(enlaces[0].enlace).slice(1), 'centro-a', { x: 1 }), false);
    assert.equal((await leer()).respuestas.length, 0);
  });

  test('tras el plazo no admite respuestas', async () => {
    const { enlaces, consulta_id } = await crear();
    await srv.pool.query("UPDATE consultas SET plazo = now() - interval '1 second' WHERE id = $1", [consulta_id]);
    const abierto = await fetch(enlaces[0].enlace);
    assert.equal(abierto.status, 410);
    assert.match(await abierto.text(), /Consulta terminada/);
    assert.equal((await contestar(enlaces[0].enlace)).status, 410);
    assert.equal((await leer()).respuestas.length, 0);
  });

  test('enlaces que no existen', async () => {
    for (const camino of ['/AAAAAAAAAA', '/corto', '/con-guion', '/', '/a/b']) {
      const r = await fetch(srv.base + camino);
      assert.equal(r.status, 404, camino);
      assert.match(await r.text(), /Enlace no válido/, camino);
    }
    assert.equal((await contestar(`${srv.base}/AAAAAAAAAA`)).status, 404);
  });

  test('un POST que no es un formulario no cierra el enlace', async () => {
    const { enlaces } = await crear(claveA, 'centro-a', { preguntas: [{ codigo: 'c', texto: 'C', tipo: 'casilla' }] });
    const json = await fetch(enlaces[0].enlace, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(json.status, 415);
    const vacio = await fetch(enlaces[0].enlace, { method: 'POST' });
    assert.equal(vacio.status, 415);
    assert.equal((await leer()).respuestas.length, 0);
  });

  test('dos envíos a la vez del mismo enlace guardan una sola respuesta', async () => {
    const { enlaces } = await crear();
    await calentarPool();
    const rs = await Promise.all(Array.from({ length: 10 }, () => contestar(enlaces[0].enlace)));
    const textos = await Promise.all(rs.map((r) => r.text()));
    assert.equal(textos.filter((t) => /Respuesta registrada/.test(t)).length, 1);
    assert.equal(textos.filter((t) => /Ya ha contestado/.test(t)).length, 9);
    assert.equal((await leer()).respuestas.length, 1);
  });
});

describe('leer respuestas', () => {
  test('el orden no tiene huecos y leer desde el último no repite', async () => {
    const { enlaces } = await crear(claveA, 'centro-a', { personas: ['p1', 'p2', 'p3'] });
    for (const e of enlaces) await contestar(e.enlace);
    const todas = await leer();
    assert.deepEqual(todas.respuestas.map((r) => r.numero), [1, 2, 3]);
    assert.equal(todas.ultimo, 3);
    const nada = await leer(claveA, '?desde=3');
    assert.deepEqual(nada.respuestas, []);
    assert.equal(nada.ultimo, 3);
    for (const r of todas.respuestas) assert.equal('ultimo_numero' in r, false);
    assert.equal(nada.hay_mas, false);
  });

  test('50 por vuelta como máximo, con aviso de que hay más', async () => {
    const personas = Array.from({ length: 53 }, (_, i) => `p${i}`);
    const { enlaces } = await crear(claveA, 'centro-a', { personas });
    await Promise.all(enlaces.map((e, i) => espera(i).then(() => contestar(e.enlace))));
    const primera = await leer();
    assert.equal(primera.respuestas.length, 50);
    assert.equal(primera.hay_mas, true);
    const segunda = await leer(claveA, `?desde=${primera.ultimo}`);
    assert.equal(segunda.respuestas.length, 3);
    assert.equal(segunda.hay_mas, false);
    assert.equal((await api(claveA, '/respuestas?limite=51')).status, 400);
  });

  test('leer mientras llegan respuestas no se salta ninguna', async () => {
    const personas = Array.from({ length: 200 }, (_, i) => `p${i}`);
    const { enlaces } = await crear(claveA, 'centro-a', { personas });
    await calentarPool();
    // Retrasa al azar el final de cada guardado: es cuando una respuesta posterior podría verse antes.
    await srv.pool.query(`
      CREATE FUNCTION retraso_prueba() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN PERFORM pg_sleep(random() * 0.01); RETURN NEW; END';
      CREATE TRIGGER retraso_prueba AFTER INSERT ON respuestas FOR EACH ROW EXECUTE FUNCTION retraso_prueba();
    `);
    try {
      let terminado = false;
      const envios = Promise.all(enlaces.map((e, i) => espera(i).then(() => contestar(e.enlace)))).then((rs) => {
        terminado = true;
        return rs;
      });

      const vistas = [];
      let desde = 0;
      for (;;) {
        const acabo = terminado;
        const { respuestas, ultimo, hay_mas } = await leer(claveA, `?desde=${desde}`);
        vistas.push(...respuestas.map((r) => r.numero));
        desde = ultimo;
        if (acabo && !hay_mas) break;
      }
      for (const r of await envios) assert.equal(r.status, 200);
      assert.deepEqual(vistas, Array.from({ length: 200 }, (_, i) => i + 1));
    } finally {
      await srv.pool.query('DROP TRIGGER retraso_prueba ON respuestas; DROP FUNCTION retraso_prueba();');
    }
  });

  test('una ráfaga grande se guarda entera, y la API responde rápido mientras tanto', async () => {
    const personas = Array.from({ length: 300 }, (_, i) => `p${i}`);
    const { enlaces } = await crear(claveA, 'centro-a', { personas });
    await calentarPool();
    const envios = Promise.all(enlaces.map((e, i) => espera(i).then(() => contestar(e.enlace))));
    await espera(50);
    const inicio = Date.now();
    const otro = await api(claveB, '/respuestas');
    assert.equal(otro.status, 200);
    assert.ok(Date.now() - inicio < 1000);
    const estados = (await envios).map((r) => r.status);
    assert.deepEqual([...new Set(estados)], [200]);
    const { rows } = await srv.pool.query("SELECT count(*)::int AS n, max(numero)::int AS m FROM respuestas WHERE centro_id = 'centro-a'");
    assert.deepEqual(rows[0], { n: 300, m: 300 });
  });

  test('un cursor por delante del último número avisa', async () => {
    const { enlaces } = await crear();
    await contestar(enlaces[0].enlace);
    const r = await api(claveA, '/respuestas?desde=2');
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'desde_por_delante', ultimo: 1 });
    assert.equal((await api(claveA, '/respuestas?desde=1')).status, 200);
  });

  test('filtra por programa y por consulta, sin perder el orden', async () => {
    const a = await crear(claveA, 'centro-a', { programa_id: 'prog-a', personas: ['x'] });
    const b = await crear(claveA, 'centro-a', { programa_id: 'prog-b', personas: ['y'] });
    await contestar(a.enlaces[0].enlace);
    await contestar(b.enlaces[0].enlace);
    const dePrograma = await leer(claveA, '?programa_id=prog-b');
    assert.deepEqual(dePrograma.respuestas.map((r) => [r.numero, r.ref]), [[2, 'y']]);
    assert.equal(dePrograma.ultimo, 2);
    const deConsulta = await leer(claveA, `?consulta_id=${a.consulta_id}`);
    assert.deepEqual(deConsulta.respuestas.map((r) => r.ref), ['x']);
  });

  test('parámetros no válidos', async () => {
    for (const q of ['?desde=-1', '?desde=abc', '?desde=1.5', '?desde=', '?desde=%20', '?desde=0x10', '?desde=1e3', '?desde=2&desde=3', '?desde[]=2', '?desde=%7B%7D',
      '?limite=0', '?limite=', '?limite=1e1', '?programa_id=a%20b', '?consulta_id=1', '?programa_id=a&programa_id=b']) {
      assert.equal((await api(claveA, `/respuestas${q}`)).status, 400, q);
    }
  });

  test('un centro no ve lo de otro', async () => {
    const a = await crear();
    await contestar(a.enlaces[0].enlace);
    assert.deepEqual((await leer(claveB)).respuestas, []);
    assert.deepEqual((await leer(claveB, `?consulta_id=${a.consulta_id}`)).respuestas, []);
    assert.equal((await api(claveB, `/consultas/${a.consulta_id}/estado`)).status, 404);
  });

  test('cada centro numera por su cuenta', async () => {
    const a = await crear();
    const b = await crear(claveB, 'centro-b');
    await contestar(a.enlaces[0].enlace);
    await contestar(b.enlaces[0].enlace);
    assert.deepEqual((await leer(claveA)).respuestas.map((r) => r.numero), [1]);
    assert.deepEqual((await leer(claveB)).respuestas.map((r) => r.numero), [1]);
  });
});

describe('estado', () => {
  test('dice quién falta y nunca da enlaces', async () => {
    const { enlaces, consulta_id } = await crear();
    await contestar(enlaces[0].enlace);
    const r = await api(claveA, `/consultas/${consulta_id}/estado`);
    const texto = await r.text();
    const estado = JSON.parse(texto);
    assert.equal(estado.total, 2);
    assert.equal(estado.contestadas, 1);
    assert.equal(estado.abierta, true);
    assert.deepEqual(estado.faltan, ['luis']);
    for (const e of enlaces) assert.equal(texto.includes(ruta(e.enlace).slice(1)), false);
  });

  test('ninguna lectura devuelve códigos de enlace', async () => {
    const { enlaces } = await crear();
    await contestar(enlaces[0].enlace);
    const texto = await (await api(claveA, '/respuestas')).text();
    for (const e of enlaces) assert.equal(texto.includes(ruta(e.enlace).slice(1)), false);
  });

  test('consulta inexistente', async () => {
    assert.equal((await api(claveA, '/consultas/00000000-0000-0000-0000-000000000000/estado')).status, 404);
    assert.equal((await api(claveA, '/consultas/nada/estado')).status, 404);
  });
});

describe('borrado', () => {
  test('borra por lotes cuando se acumulan muchas', async () => {
    for (let i = 0; i < 45; i++) await crear(claveA, 'centro-a', { personas: ['x'] });
    await srv.pool.query("UPDATE consultas SET plazo = now() - interval '31 days'");
    assert.equal(await purgar(srv.pool), 45);
    assert.equal((await srv.pool.query('SELECT count(*)::int AS n FROM consultas')).rows[0].n, 0);
  });

  test('borra a los 30 días del plazo, no antes, y la numeración sigue', async () => {
    const vieja = await crear(claveA, 'centro-a', { personas: ['x'] });
    const reciente = await crear(claveA, 'centro-a', { personas: ['y'] });
    await contestar(vieja.enlaces[0].enlace);
    await contestar(reciente.enlaces[0].enlace);
    await srv.pool.query("UPDATE consultas SET plazo = now() - interval '31 days' WHERE id = $1", [vieja.consulta_id]);
    await srv.pool.query("UPDATE consultas SET plazo = now() - interval '29 days' WHERE id = $1", [reciente.consulta_id]);

    assert.equal(await purgar(srv.pool), 1);
    assert.deepEqual((await leer()).respuestas.map((r) => r.ref), ['y']);
    assert.equal((await fetch(vieja.enlaces[0].enlace)).status, 404);

    const otra = await crear(claveA, 'centro-a', { personas: ['z'] });
    await contestar(otra.enlaces[0].enlace);
    assert.deepEqual((await leer(claveA, '?desde=2')).respuestas.map((r) => r.numero), [3]);
  });
});

describe('otros', () => {
  test('health y robots', async () => {
    assert.deepEqual(await (await fetch(`${srv.base}/health`)).json(), { ok: true });
    assert.match(await (await fetch(`${srv.base}/robots.txt`)).text(), /Disallow: \//);
  });

  test('favicon: no sale como enlace no válido', async () => {
    const r = await fetch(`${srv.base}/favicon.ico`);
    assert.equal(r.status, 204);
  });

  test('imágenes: PNG, en caché y sin pasar por la ruta de enlaces', async () => {
    const firma = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    for (const ruta of ['/logo.png', '/vista-previa.png', '/icono.png', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png']) {
      const r = await fetch(`${srv.base}${ruta}`);
      assert.equal(r.status, 200, ruta);
      assert.equal(r.headers.get('content-type'), 'image/png', ruta);
      assert.match(r.headers.get('cache-control'), /public/, ruta);
      assert.deepEqual(Buffer.from(await r.arrayBuffer()).subarray(0, 4), firma, ruta);
    }
  });

  test('muchos intentos falsos no bloquean a nadie', async () => {
    const { enlaces } = await crear();
    for (let i = 0; i < 150; i++) assert.equal((await fetch(`${srv.base}/AAAAAAAAAA`)).status, 404);
    assert.equal((await fetch(enlaces[0].enlace)).status, 200);
    assert.equal((await api(claveA, '/respuestas')).status, 200);
  });

  test('una clave falsa no gasta conexiones de la BD', async () => {
    const original = srv.pools.api.query;
    let consultas = 0;
    srv.pools.api.query = function (...a) {
      consultas++;
      return original.apply(this, a);
    };
    try {
      for (let i = 0; i < 20; i++) assert.equal((await api('falsa', '/respuestas')).status, 401);
      assert.equal(consultas, 0);
    } finally {
      srv.pools.api.query = original;
    }
  });

  test('una clave nueva o renovada se aplica al recargar', async () => {
    const nueva = await altaCentro(srv.pool, 'centro-c');
    assert.equal((await api(nueva, '/respuestas')).status, 401);
    await srv.claves.cargar();
    assert.equal((await api(nueva, '/respuestas')).status, 200);
  });

  test('con la cola del formulario llena responde al momento, sin afectar a la API', async () => {
    const { enlaces } = await crear();
    Object.defineProperty(srv.pools.formulario, 'waitingCount', { configurable: true, get: () => 501 });
    try {
      assert.equal((await fetch(enlaces[0].enlace)).status, 503);
      assert.equal((await contestar(enlaces[0].enlace)).status, 503);
      assert.equal((await api(claveA, '/respuestas')).status, 200);
    } finally {
      delete srv.pools.formulario.waitingCount;
    }
    assert.equal((await fetch(enlaces[0].enlace)).status, 200);
  });

  test('los tiempos máximos caben en los 5 s de Neo y una consulta larga se corta', async () => {
    const { connectionTimeoutMillis, query_timeout } = srv.pools.api.options;
    assert.ok(connectionTimeoutMillis + query_timeout < 5000);
    const inicio = Date.now();
    await assert.rejects(srv.pool.query('SELECT pg_sleep(5)'));
    assert.ok(Date.now() - inicio < 3500);
  });

  test('un error interno no enseña detalles', async () => {
    const original = srv.pools.api.query;
    srv.pools.api.query = async () => {
      throw new Error('secreto de la base de datos');
    };
    try {
      const r = await api(claveA, '/respuestas');
      assert.equal(r.status, 500);
      assert.deepEqual(await r.json(), { error: 'error_interno' });
    } finally {
      srv.pools.api.query = original;
    }
  });

  test('sobrevive a que la BD corte todas las conexiones', async () => {
    const { enlaces } = await crear();
    await calentarPool();
    const lenta = srv.pools.formulario.query('SELECT pg_sleep(5)').catch((e) => e);
    await new Promise((r) => setTimeout(r, 100));
    const otra = new pg.Client({ connectionString: bd.url });
    await otra.connect();
    await otra.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND datname = current_database()');
    await otra.end();
    assert.ok((await lenta) instanceof Error);
    assert.equal((await fetch(`${srv.base}/health`)).status, 200);
    assert.equal((await contestar(enlaces[0].enlace)).status, 200);
    assert.equal((await leer()).respuestas.length, 1);
  });

  test('con los grupos de conexiones cerrados responde error, sin colgarse', async () => {
    const otro = await arrancarServicio(bd.url);
    await otro.claves.cargar();
    await Promise.all([otro.pools.api.end(), otro.pools.formulario.end()]);
    otro.pools.api.end = async () => {};
    otro.pools.formulario.end = async () => {};
    try {
      assert.equal((await fetch(`${otro.base}/health`)).status, 503);
      assert.equal((await fetch(`${otro.base}/api/respuestas`, { headers: { 'x-api-key': claveA } })).status, 500);
      assert.equal((await fetch(`${otro.base}/AAAAAAAAAA`)).status, 500);
    } finally {
      await otro.parar();
    }
  });
});
