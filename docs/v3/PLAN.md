# noteit v3 — Arquitectura de tarjetas como entidad

> Documento vivo. Lo construimos **paso por paso**. Cada sección está marcada
> como **[CERRADO]** (ya lo decidimos) o **[ABIERTO]** (falta discutirlo).
> No se escribe código hasta que el bloque correspondiente esté CERRADO.

---

## 0. Contexto y objetivo  **[CERRADO]**

noteit deja de tratar las tarjetas como texto inline y pasa a tratarlas como una
**entidad de primera clase**. La app tiene **dos funciones** que conviven:

1. **Tarjetas** (lo primario): un *journal* append-only. Escribís rápido "qué
   estoy haciendo / qué está pasando" y eso queda como una tarjeta inmutable con
   su lugar determinístico en una línea de tiempo.
2. **Texto** (secundario): archivos de texto plano donde podés **embeber**
   tarjetas ya creadas. Escribir texto plano es trivial y va al final.

La referencia de modelo es `/docker/wheel-journal` (entries inmutables,
append-only, en markdown legible; "comentarios" como objetos separados que
referencian un entry). Tomamos eso y le sumamos: **tags**, **links entre tarjetas**
(una tarjeta nueva referencia a otra; backlinks visibles) y **embeds** en archivos
de texto.

Principio que se hereda de wheel-journal y del `card.go` actual: **el dato vive
como markdown legible**. Si la app muere, abrís el archivo y lo leés.

---

## 1. La entidad Card  **[CERRADO]**

Forma final:

```
Card {
  id        // uuid v7 — ordena por tiempo, inmutable. ES la identidad/"título".
  created   // timestamp RFC3339Nano — posición LEGIBLE en la timeline
  body      // markdown (1+ líneas) — el "qué". NO hay título separado.
  tags {}   // 6 ejes controlados → ver docs/v3/taxonomy.md
  ref?      // { id, kind } — UNA referencia (o ninguna) a otra tarjeta.
            //   kind=link   → link neutro (default)
            //   kind=parent → "anídame bajo esa" (esto genera el anidado)
}
```

**Sin `title`.** La tarjeta es solo `body`; su identidad/"título" es el `id`. Las
tarjetas son rápidas ("qué estoy haciendo"). Si querés usar una como
**encabezado** que agrupa a otras, no hay un campo ni un tipo especial: su `body`
ES el encabezado, y las "hijas" son tarjetas normales con `ref kind=parent`
apuntándola. El anidado lo **deriva la vista** agrupando por ese `ref` — la
tarjeta-encabezado nunca se entera (sigue inmutable), igual que los backlinks.

`tags` es un **mapa por eje** (no una lista plana), según el diccionario:
`{ type, status, priority?, horizon?, area[], effort? }`. `type` y `status`
siempre están materializados (defaults `note` / `todo`); el resto solo si se setea.

**Decisiones cerradas:**
- **Sin `author`.** La app es single-user: el dueño es implícito. Si hace falta
  mostrarlo, sale UNA vez de la config del vault, nunca por tarjeta. (Multi-autor
  queda fuera de v3.)
- **`id` = uuid v7.** Ordena por tiempo, así el id refleja la posición en la
  timeline y desempata si dos tarjetas cayeran en el mismo milisegundo.
- **`created` se mantiene aparte** del id. Razón: v7 codifica el tiempo solo a
  nivel **milisegundo** y no es legible a ojo; el archivo es markdown legible, así
  que guardamos un RFC3339(Nano) explícito como el "cuándo" semántico. Se generan
  juntos en el mismo instante → nunca se contradicen. (id = identificador + orden
  grueso; created = tiempo legible y de precisión fina.)
- **`ref` lleva un `kind`.** El primer uso concreto del slot de tipo reservado:
  `kind=link` (default, link neutro: "apunta a aquella", sin semántica de
  supersede) y `kind=parent` (estructural: "anídame bajo aquella" → genera el
  anidado en la vista). `kind=parent` es **estructural, NO** update/reply: no hay
  lógica de supersede ni estado derivado del contenido. `reply`/`update` siguen
  reservados para sumarlos después sin tocar el storage.
- **Cardinalidad de `ref`: UNA sola** por ahora. Decisión barata de revertir: la
  lógica de refs se modela **abstracta y desacoplada** (cardinalidad y tipo viven
  en UN punto), así pasar a N refs o a refs tipadas después es cambiar config, no
  reescribir. Ningún lado del código depende del otro.
- **Backlinks visibles (bidireccional).** Una tarjeta guarda solo su `ref` saliente
  (a quién apunta). Los **backlinks** (quién la apunta) se **derivan** recorriendo
  el store — no se guardan en la tarjeta apuntada (sería mutarla, y es inmutable).
  Al abrir A: ves su texto + "linkeada desde B" (entrante) y "apunta a X" (saliente).
- **Taxonomía data-driven.** Los valores/sinónimos de tags NO se hardcodean por
  eje; el normalizador lee el diccionario (`taxonomy.md`). Agregar un valor = dato.

**Reglas:**
- Una tarjeta **nunca** se edita ni se borra. Es inmutable de por vida.
- Relacionar/anidar tarjetas = crear **otra** tarjeta con una `ref` que apunta a
  la primera. Son objetos separados que se linkean; el "anidado" es solo cómo la
  vista los agrupa (`kind=parent`), no objetos físicamente anidados.
- El grafo se **reconstruye** siguiendo las `ref` (salientes) y derivando los
  backlinks/hijas (entrantes) al recorrer el store.
- `created` (+ el id v7) es único → no hay dos tarjetas en el mismo instante.

**Modelo de tags** → cerrado en `docs/v3/taxonomy.md` (6 ejes, 33 canónicos,
sinónimos, colisiones, normalización lowercase + sin acentos + sinónimo→canónico).

Pendiente menor (no bloquea Fase 1):
- Confirmar sinónimos propuestos para los nuevos `note` y `rem` (en taxonomy.md).

---

## 1·B. Entrada rápida (quick-entry)  **[CERRADO]**

Crear una tarjeta es UNA línea:

```
‹tags…› : ‹body›        —Enter→ CREA la tarjeta y la agrega a la timeline
```

- **Antes del `:`** = tags (palabras sueltas, **orden libre**).
- **Después del `:`** = el **body** (el "qué"). No hay título.
- **Enter** = **crea** la tarjeta y la agrega al final de la timeline global.
- **Shift+Enter** = salto de línea dentro del body (para body multilínea).
- Si no hay `:`, todo el texto es body (sin tags más allá de los defaults).

**Normalización (heurística pura, por token):** `lowercase` → quitar acentos →
buscar en el diccionario (`taxonomy.md`) → `(eje, canónico)`. El programa corta
las palabras y asigna cada una a su eje; no hay orden fijo.

**Autocompletar:** mientras se teclea un token, predecir/sugerir la palabra del
diccionario **más cercana** (fuzzy typeahead), para escribir libre y corto.

**Reglas de asignación:**
- Token reconocido → su eje canónico.
- **Conflicto en eje de 1 valor** (ej. `feat fix` = dos `type`) → **ERROR DURO**:
  no se crea la tarjeta, sin override posible.
- **`area` = eje libre** ("lo que sea"): es la **última palabra antes del `:`**;
  si no se reconoce, se asigna a `area` como valor libre. (area sigue siendo
  multi para sus valores canónicos del diccionario.)
- **Token desconocido** que NO es el slot de area → **aviso** ("no conozco 'X'"),
  no se manda al body, **bloquea** la creación con una noti. Si el user da
  **Enter de nuevo** (confirma) → se **quita** ese token y se crea **sin** ese tag.
- **Defaults:** `type→note`, `status→todo`. `horizon` ausente = `now` (al leer;
  no se materializa en el archivo).

**Inmutabilidad:** TODO es inmutable una vez creada la tarjeta — **incluida
`area`**. No hay edición post-creación de ningún campo. Esto mantiene el
`timeline.md` **append-only puro** (jamás se reescribe un bloque).

---

## 2. Storage  **[CERRADO — Opción A]**

Un único markdown legible, append-only: **`.noteit/timeline.md`**.

Cada tarjeta es un bloque estilo wheel-journal, separado por `---`:

```
> CARD | id:<uuid-v7> | created:<rfc3339> | type:feat | status:doing | priority:p1 | horizon:next | area:client,backend | effort:m | ref:<id>:parent
<body markdown — desde la primera línea tras el header; 1+ líneas, imágenes ok>
```

- **Header** = línea `> CARD | …`. Cada eje es su token `key:value` (legible,
  auto-etiquetado). `area` multi = coma-separado. Se omiten los ejes ausentes;
  `type`/`status` siempre presentes. `ref` se omite si no hay; cuando está, lleva
  el `kind`: `ref:<id>` (link neutro) o `ref:<id>:parent` (anidado). Sin
  `author` — single-user.
- **Body** = todo lo que sigue al header (sin línea de título). No hay título.

(Formato exacto a confirmar cuando escribamos el parser, pero esta es la forma.)

- Append-only a nivel lógico: nunca se reescribe ni se reordena un bloque
  existente (igual que wheel: el server solo agrega al final).
- Orden en el archivo = orden de creación = la timeline.
- Reusa el patrón de parse/serialize que ya existe en `card.go`.

Alternativa descartada (por ahora): un archivo por tarjeta (`.noteit/cards/<id>.md`).
Más limpio para concurrencia pero genera muchos archivos; lo reconsideramos si el
archivo único crece demasiado.

Puntos a resolver más adelante:
- ¿Una sola timeline global, o el archivo admite "secciones"? (ver §3).

---

## 2·B. Contrato de parseo/escritura (D)  **[CERRADO]**

La "letra chica" para que `timeline.md` no se corrompa ni se rompa al leer.

**D.1 · Parseo anclado al header con validación por keys.** El archivo NO se parte
por `---`; eso es markdown válido y aparecería dentro de un body. Se parte por cada
línea que empieza con `> CARD`. Pero `> CARD` **no basta**: la línea es un header
válido solo si sus tokens (separados por ` | `) son **`key:value` con `key` ∈ el
set de campos que definimos** — `{ id, created, type, status, priority, horizon,
area, effort, ref }` — y están las **requeridas** (`id`, `created`, `type`,
`status`). Se validan las **keys**, NUNCA los valores (cada tarjeta trae valores
distintos). Una línea `> CARD …` que no cumpla esto NO es un header (es body, o un
bloque corrupto → D.5). Una key desconocida invalida el header.

**D.2 · Header keyed y uniforme.** Todos los campos son `key:value`. Para extraer la
key se corta en el **primer `:`** (así `created:2026-…T10:30:00Z` y `ref:<id>:parent`
parsean bien aunque el valor tenga `:`). `area` es texto libre → su valor se
**percent-encodea** al escribir (y se decodea al leer) para que nunca contenga un
` | ` ni un salto de línea que parta el header.

**D.3 · Body** = todo lo que sigue al header hasta el próximo header válido. Sin
título (ya cerrado en §1/§2).

**D.4 · Escritura append-only.** Se abre en modo **append** (`O_APPEND`): jamás se
reabre ni reescribe un bloque viejo, solo se agrega al final. `fsync` tras escribir
para forzar el guardado a disco.

**D.5 · Tolerancia a escritura a medias.** Si se corta a la mitad de escribir la
última tarjeta (corte de luz, crash), al leer el **último bloque inválido se
descarta** en silencio en vez de explotar. Solo puede pasar al final (append-only),
así que nunca afecta tarjetas previas. *(Confirmado: "si queda mal escrito, nos
deshacemos de él".)*

**D.6 · Unicidad por `id` v7.** No hay dos tarjetas con el mismo id. Si por edición
manual aparecieran duplicados, gana el primero y se avisa.

**D.7 · Índice en memoria.** Al arrancar se lee el archivo una vez y se arma un mapa
`id → Card`; de ahí se **derivan** backlinks e hijas (`ref kind=parent` entrantes).
No se persiste nada derivado — se recalcula leyendo el store.

Cosmético (no afecta el parseo): podemos seguir escribiendo un `---` en blanco entre
bloques solo por legibilidad; el parser lo ignora (la autoridad es el header).

---

## 3. Vistas  **[ABIERTO — a discutir]**

Una sola fuente de datos (el store global), varias vistas:

1. **Timeline global** — todas las tarjetas en orden cronológico. Feed tipo
   journal con un composer rápido para escribir la tarjeta de "ahora".
2. **Timeline por tag** — filtra el global por uno o varios tags.
3. **Por archivo** — un archivo de texto y las tarjetas que ese texto embebe.

Puntos a resolver:
- ¿Cómo se ve el hilo (refs) dentro del feed? ¿Inline anidado visual, o un panel
  lateral al estilo wheel-journal (`CommentPanel`)?
- ¿El composer vive arriba o abajo del feed?
- ¿Cómo se crean tarjetas: comando (`:card`/leader), o un input siempre visible?

---

## 4. Embeds en texto  **[ABIERTO — fase final]**

Un archivo de texto guarda un token liviano que referencia una tarjeta ya creada;
el editor lo resuelve contra el store y la pinta read-only.

- Sintaxis tentativa: `!card[<uuid>]`.
- Tarjeta borrada/inexistente → se pinta un *tombstone*, no rompe.
- Borrar el embed quita la referencia, no la tarjeta (la tarjeta vive en el store).

Se detalla cuando lleguemos. Reusa el editor CodeMirror que ya existe.

---

## 5. Plan por fases  **[ABIERTO — a refinar]**

- **Fase 0 — limpieza:** sacar el modelo inline viejo (`:::card` en `card.go`,
  `parseBlocks`, `journal.go`, `SaveBody` card-aware, `cardPreview` en el editor).
  No hay data importante que migrar → se elimina, no coexiste.
- **Fase 1 — backend de entidades:** modelo `Card` + store `.noteit/timeline.md`
  append-only + servicio (`CreateCard`, `ListCards`). Inmutable, id único.
- **Fase 2 — UI timeline:** feed + composer rápido + tags + linkear (nueva tarjeta
  con `ref`) + backlinks visibles + filtro por tag.
- **Fase 3 — embeds:** token `!card[uuid]` en archivos de texto, render read-only.

Refinamos el alcance de cada fase a medida que cerramos §1–§4.

---

## Registro de decisiones

| Fecha | Decisión | Estado |
|-------|----------|--------|
| 2026-06-01 | Arquitectura B: tarjeta como entidad, no texto inline | CERRADO |
| 2026-06-01 | Storage Opción A: `.noteit/timeline.md` markdown legible | CERRADO |
| 2026-06-01 | Inmutabilidad total; update/reply = nueva tarjeta con ref | CERRADO |
| 2026-06-01 | Prioridad: tarjetas primero, texto/embeds al final | CERRADO |
| 2026-06-02 | Sin `author` por tarjeta (single-user, dueño implícito) | CERRADO |
| 2026-06-02 | `id` = uuid v7; `created` RFC3339Nano explícito aparte | CERRADO |
| 2026-06-02 | `ref` única, lógica abstracta y desacoplada | CERRADO |
| 2026-06-02 | Tags: 6 ejes controlados, data-driven (taxonomy.md) | CERRADO |
| 2026-06-02 | Nuevos type `note` (default) y `rem` | CERRADO |
| 2026-06-02 | `ref` = link NEUTRO (sin update/reply); backlinks derivados | CERRADO |
| 2026-06-02 | Sin migración: el modelo inline viejo se elimina (Fase 0) | CERRADO |
| 2026-06-02 | ~~Entrada rápida: `tags : título`, Enter → body~~ → revertido | OBSOLETO |
| 2026-06-02 | ~~Tarjeta = `title` + `body`~~ → revertido: solo `body`, id = identidad | OBSOLETO |
| 2026-06-02 | Sin `title`: tarjeta = solo `body`; el "título" es el `id` | CERRADO |
| 2026-06-02 | Entrada rápida: `tags : body`; Enter crea, Shift+Enter = newline | CERRADO |
| 2026-06-02 | Anidado = `ref kind=parent` (mismo mecanismo, no campo nuevo) | CERRADO |
| 2026-06-02 | D: parseo anclado a `> CARD` + validación por keys conocidas | CERRADO |
| 2026-06-02 | D: header 100% keyed (`created:` incluido), area percent-encoded | CERRADO |
| 2026-06-02 | D: append-only (`O_APPEND`+`fsync`); bloque final corrupto se descarta | CERRADO |
| 2026-06-02 | Conflicto en eje de 1 valor = error duro (no crea) | CERRADO |
| 2026-06-02 | Heurística token→eje + autocompletar fuzzy; area = libre/última palabra | CERRADO |
| 2026-06-02 | Todo inmutable incl. `area` → timeline append-only puro | CERRADO |
