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

Cada tarjeta es un bloque **enmarcado** estilo wheel-journal: header con
`bytes:N`, body exacto, y footer con id:

```
> CARD | id:<uuid-v7> | created:<rfc3339> | type:feat | status:doing | priority:p1 | horizon:next | area:client,backend | effort:m | ref:<id>:parent | bytes:<N>
<body markdown — exactamente N bytes UTF-8; 1+ líneas, imágenes ok>
> ENDCARD <uuid-v7>
```

- **Header** = línea `> CARD | …`. Cada eje es su token `key:value` (legible,
  auto-etiquetado). `area` multi = coma-separado. Se omiten los ejes ausentes;
  `type`/`status` siempre presentes. `ref` se omite si no hay; cuando está, lleva
  el `kind`: `ref:<id>` (link neutro) o `ref:<id>:parent` (anidado). `bytes:<N>`
  es **obligatorio y siempre va último**: largo exacto del body en bytes UTF-8.
  Sin `author` — single-user.
- **Body** = exactamente `N` bytes tras el `\n` del header. Texto markdown
  arbitrario (puede contener `---`, líneas `>`, `> CARD …`, code fences) — el
  framing por longitud lo preserva tal cual, **sin escaping**.
- **Footer** = línea `> ENDCARD <id>` con el **mismo id** del header, precedida de
  un separador `\n` explícito. Confirma que el bloque se escribió completo y sirve
  de ancla de re-sync/inspección humana.

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
area, effort, ref, bytes }` — y están las **requeridas** (`id`, `created`, `type`,
`status`, `bytes`). Se validan las **keys**, NUNCA los valores (cada tarjeta trae
valores distintos), salvo `bytes` que debe ser un entero ≥ 0. Una línea `> CARD …`
que no cumpla esto NO es un header (es body opaco, o un bloque corrupto → D.5). Una
key desconocida invalida el header.

**D.2 · Header keyed y uniforme.** Todos los campos son `key:value`. Para extraer la
key se corta en el **primer `:`** (así `created:2026-…T10:30:00Z` y `ref:<id>:parent`
parsean bien aunque el valor tenga `:`). `area` es texto libre → su valor se
**percent-encodea** al escribir (y se decodea al leer) para que nunca contenga un
` | ` ni un salto de línea que parta el header.

**D.3 · Body por longitud (framing), NO por "hasta el próximo header".** El body son
**exactamente los `N` bytes** que declara `bytes:N` en el header, contados desde el
`\n` que cierra la línea del header. Esto hace al body **totalmente opaco**: puede
contener `---`, líneas `>`, `> CARD …`, `> ENDCARD …`, code fences — nada de eso se
interpreta, porque no se busca un delimitador dentro del body. **Sin escaping**
(la propuesta de escapar `>` se descartó: no es biyectiva y rompe la semántica de
blockquote en markdown). Esto **cierra el hueco "header-en-body"**: una línea de body
que parezca header es inofensiva porque jamás se escanea el body buscando headers.

**D.4 · Footer y completitud (cierra "truncado ≠ completo").** Tras los `N` bytes va
un separador `\n` explícito (serializado **siempre**, no se depende del newline final
del body) y la línea `> ENDCARD <id>`. Un bloque está **completo** solo si: header
válido (D.1) **con** `bytes:N` → leés exactamente `N` bytes → encontrás el separador
→ la línea siguiente es `> ENDCARD <id>` con el **mismo id**. Si algo de eso falta
(EOF antes de `N` bytes, sin footer, footer con otro id) el bloque está **torn**.

**D.5 · Tolerancia: solo el tail incompleto.** Un bloque torn **solo** puede ser el
**último** del archivo (append-only). Al arrancar: si el último bloque es torn, se
**trunca el archivo físicamente** hasta el final del último bloque completo **antes**
de permitir cualquier append (no se anexa nunca después de un tail roto). Corrupción
**en medio** del archivo (un bloque inválido que NO es el último) **NO** se descarta:
es **error explícito** (señal de edición/daño manual), no se arranca en silencio.

**D.6 · Escritura append-only y durable.** Crear `timeline.md`: `fsync(file)` +
**`fsync(dir)`** (para persistir la entrada de directorio). Abrir en `O_APPEND`. Cada
append: serializar el bloque entero (header `\n` + N bytes + `\n` + footer `\n`) en
**una** `Write`, **verificar que no hubo short write** (una `Write` en archivo regular
no garantiza escritura completa), `fsync(file)`, y **solo si fsync no falló** se
actualiza el índice en memoria. Si `fsync` falla, no se confirma éxito. Formato
canónico **LF**; el body se escribe/lee tal cual (**no** se normaliza CRLF al leer).

**D.7 · Unicidad por `id` v7.** No hay dos tarjetas con el mismo id. Si por edición
manual aparecieran duplicados, gana el primero y se avisa.

**D.8 · Índice en memoria.** Al arrancar se lee el archivo una vez y se arma un mapa
`id → Card`; de ahí se **derivan** backlinks e hijas (`ref kind=parent` entrantes).
Los refs/backlinks se derivan **solo de tarjetas completas**. No se persiste nada
derivado — se recalcula leyendo el store.

**D.9 · Checksum:** opcional, descartado por ahora. `bytes:N` + footer detectan
truncamiento; un checksum solo agregaría detección de corrupción *silenciosa* en
medio (bit-rot), que para un archivo local single-user no justifica el costo. Slot
reservable en el header (`sha:`) si algún día se quiere.

Cosmético (no afecta el parseo): el footer `> ENDCARD <id>` ya separa visualmente los
bloques; no hace falta un `---` extra. La autoridad del parseo es header+`bytes`+footer.

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

- **Fase 0 — limpieza: [HECHO]** sacado el modelo inline viejo. Frontend
  (commit `b052c82`): borrado `editor/cards.ts`/`cardPreview`, compositor note-only,
  CSS muerto. Backend (commit `41bc9f5`): borrados `card.go`/`cardservice.go`/
  `journal.go`/`card_test.go`, bindings regeneradas note-only, shim `backend.ts`
  eliminado. Fences `:::card` viejos quedan como texto legacy; `journal.ndjson`
  huérfano no se borra. Build verde (`go build -tags gtk3` + tsc + vite).
- **Fase 1 — backend de entidades: [HECHO]** (commit `585eda7`). `card.go`
  (modelo + framing serialize/parse con `bytes:N`+footer, torn-tail vs corrupción),
  `taxonomy.go` (diccionario data-driven 6 ejes + resolver heurístico), `cardservice.go`
  (servicio Wails SEPARADO: `CreateCard`/`ListCards(filter)`/`GetCard` con backlinks
  e hijas derivadas; append-only durable con rollback de short-write). Inmutable, id
  único. Revisado con Codex (5 fixes), build verde (go build/test/vet + tsc + vite).
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
| 2026-06-02 | Fase 0 ejecutada (frontend b052c82 + backend 41bc9f5), build verde | HECHO |
| 2026-06-02 | ~~D: framing de completitud + escape de header-en-body~~ → resuelto | OBSOLETO |
| 2026-06-02 | D: framing por `bytes:N` en header + footer `> ENDCARD <id>`, sin escaping | CERRADO |
| 2026-06-02 | D: corrupción en medio = error explícito; solo tail torn se trunca | CERRADO |
| 2026-06-02 | D: durabilidad fsync(file)+fsync(dir) al crear; write→fsync→índice por append | CERRADO |
| 2026-06-02 | Conflicto en eje de 1 valor = error duro (no crea) | CERRADO |
| 2026-06-02 | Heurística token→eje + autocompletar fuzzy; area = libre/última palabra | CERRADO |
| 2026-06-02 | Todo inmutable incl. `area` → timeline append-only puro | CERRADO |
| 2026-06-02 | CardService = servicio Wails SEPARADO (no colgado de NoteService) | CERRADO |
| 2026-06-02 | Fase 1 ejecutada (commit 585eda7); revisada Codex; build verde | HECHO |
