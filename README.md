# mt-responde

Consultas por SMS desde Neo. Un programa de Neo crea la consulta y envía por SMS un enlace único a cada persona; la persona contesta en un formulario y un programa de Neo lee las respuestas cuando el caso lo necesita. El servicio no escribe en Neo y no publica nada.

## Arrancar en local

```bash
npm install
npm test
npm run demo
```

`npm run demo` levanta un Postgres de usar y tirar en el puerto 4173 con una consulta de ejemplo, y escribe los enlaces y la clave en la consola.

## Variables de entorno

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Conexión a Postgres |
| `DATABASE_SSL` | `1` si la conexión es externa (no hace falta dentro de Render) |
| `BASE_URL` | Dirección de los enlaces del SMS, por ejemplo `https://r.missiontrack.eu` |
| `PORT` | Lo pone Render |

## Despliegue en Render

Web service Node, plan de pago `starter` (el gratuito se duerme y no llegaría a los 5 s de Neo), en Frankfurt, build `npm ci --omit=dev`, start `npm start`, health check `/health`. Postgres `basic_256mb` de 1 GB en Frankfurt (la gratuita caduca a los 30 días). `DATABASE_URL` es la dirección interna de esa BD. `r.missiontrack.eu` se añade como dominio propio con un CNAME en la zona DNS de DHAP.

## Alta de un centro

```bash
node scripts/alta-centro.js <id del centro en Neo> "<nombre>"
```

Se ejecuta en la Shell del servicio en Render, donde ya está `DATABASE_URL`. La clave se muestra una sola vez y empieza a valer en menos de 30 s; repetir el comando la renueva. Los programas la envían en la cabecera `X-API-Key`.

## API

Todas las rutas exigen `X-API-Key` y solo dan acceso a los datos de ese centro.

### `POST /api/consultas`

```json
{
  "centro_id": "<id del centro>",
  "programa_id": "<id del programa que envía>",
  "equipo_id": "<id del equipo>",
  "texto": "Convocatoria del simulacro",
  "imagen": "https://…",
  "aviso": "Texto legal",
  "aviso_url": "https://…",
  "plazo": "2026-11-05T18:00:00+01:00",
  "preguntas": [
    { "codigo": "asiste", "texto": "¿Podrá asistir?", "tipo": "simple", "obligatoria": true,
      "imagen": "https://…",
      "opciones": [{ "codigo": "si", "texto": "Sí" }, { "codigo": "no", "texto": "No" }] },
    { "codigo": "medios", "texto": "¿Qué medios aporta?", "tipo": "multiple",
      "opciones": [{ "codigo": "radio", "texto": "Radio" }, { "codigo": "coche", "texto": "Coche" }] },
    { "codigo": "leido", "texto": "He leído el aviso", "tipo": "casilla", "obligatoria": true }
  ],
  "personas": ["<referencia 1>", "<referencia 2>"]
}
```

`equipo_id`, `imagen`, `aviso`, `aviso_url` y `obligatoria` son opcionales. El plazo lleva zona horaria y no puede pasar de 30 días. Las referencias son identificadores: se rechaza lo que parezca un teléfono, incluido un identificador de 9 a 15 dígitos.

Responde `201` con `{ "consulta_id": "…", "enlaces": [{ "ref": "…", "enlace": "https://…" }] }`. Los enlaces **solo se entregan aquí**: no se pueden volver a pedir.

### `GET /api/respuestas`

Parámetros: `desde` (último número leído, 0 por defecto), `limite` (máximo 50), `programa_id` y `consulta_id` (opcionales).

```json
{
  "respuestas": [
    { "numero": 1, "consulta_id": "…", "programa_id": "…", "equipo_id": "…", "ref": "…",
      "contenido": { "asiste": "si", "medios": ["radio"], "leido": true },
      "recibida_en": "2026-11-05T10:00:00.000Z" }
  ],
  "ultimo": 1,
  "hay_mas": false
}
```

En `contenido`, una simple es un código (`null` si no contesta), una múltiple es una lista y una casilla es `true` o `false`. Los números son correlativos por centro; con filtros puede haber saltos. Para seguir leyendo, se pasa `ultimo` como `desde`. Si `desde` va por delante del último número del centro (BD restaurada, programa copiado con su resultado), responde `409` con `{ "error": "desde_por_delante", "ultimo": n }`: hay que corregir el cursor o se dejaría de ver lo nuevo.

### `GET /api/consultas/:id/estado`

Devuelve `consulta_id`, `plazo`, `abierta`, `total`, `contestadas` y `faltan` (referencias), sin enlaces.

## Reglas

- Las peticiones del formulario hacen cola en su propio grupo de conexiones, sin frenar la API. Si la cola pasa de 500 peticiones o una espera más de 15 s, la persona ve un error y puede volver a enviar; nunca queda una respuesta a medias. El ritmo real hay que medirlo en Render.
- Crear dos veces una consulta para la misma persona da dos enlaces válidos: no reintentar un envío a medias.
- Cada persona contesta una vez; al contestar, el enlace queda cerrado. Abrirlo no cuenta como respuesta.
- Solo vuelven códigos de opción que el servicio ha comprobado: nada escrito por quien contesta llega a Neo.
- Las consultas y sus respuestas se borran 30 días después del plazo.

## Programas de Neo

- El paso HTTP corta a los 5 s. Un error 4xx o 5xx no para el programa: hay que comprobar `status`.
- **Crear la consulta:** el motor reinterpreta lo que se escribe en el paso HTTP (`"1"` pasa a número, un salto de línea o `return` en un texto lo vacía, y un `$` o un acento grave lo rompen). El paso SCRIPT previo, con clave `cuerpo`, devuelve `[cuerpo]`, en una lista porque el motor no reinterpreta su contenido; `content` del paso HTTP es exactamente `${JSON.stringify($cuerpo[0])}`, en una línea, con `content_type` `application/json`.
- **Programa emisor:** no devuelve los enlaces, porque el resultado queda en `logs`.
- **Programa lector:** el último leído se saca con `Number($original) || 0`. Todas las ramas terminan en un RETURN con ese número, también si hay error; si no, se relee todo desde 0. Si el lector tiene un evento asociado, ese número también pasa a su valor.
- Un programa se para tras 3 fallos seguidos: en los lectores, subir `threshold` a mano en la BD.
- El SMS admite 160 caracteres, enlace incluido, y mejor sin acentos. Con `r.missiontrack.eu`, el enlace ocupa 36.
