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
  id        // uuid v7 — ordena por tiempo, inmutable
  created   // timestamp RFC3339Nano — posición LEGIBLE en la timeline
  body      // markdown, inmutable
  tags {}   // 6 ejes controlados → ver docs/v3/taxonomy.md
  ref?      // UNA referencia (o ninguna) a otra tarjeta por id. LINK NEUTRO.
}
```

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
- **`ref` es un LINK NEUTRO, sin semántica.** Por ahora NO hay `update` ni
  `reply` con comportamiento: una `ref` solo dice "esta tarjeta apunta a aquella".
  Nada de lógica de "supersede" ni estado derivado. El campo de tipo queda
  **reservado** para sumar `reply`/`update` después sin tocar el storage.
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
- Relacionar tarjetas = crear **otra** tarjeta con una `ref` que apunta a la
  primera. Son objetos separados que se linkean; nunca anidados.
- El grafo se **reconstruye** siguiendo las `ref` (salientes) y derivando los
  backlinks (entrantes) al recorrer el store.
- `created` (+ el id v7) es único → no hay dos tarjetas en el mismo instante.

**Modelo de tags** → cerrado en `docs/v3/taxonomy.md` (6 ejes, 33 canónicos,
sinónimos, colisiones, normalización lowercase + sin acentos + sinónimo→canónico).

Pendientes menores (no bloquean Fase 1):
- Confirmar sinónimos propuestos para los nuevos `note` y `rem`.
- `horizon` ausente: ¿se materializa como `now` al escribir, o se interpreta
  `now` solo al leer/filtrar? (Propuesta: interpretar al leer; no ensuciar el
  archivo con defaults.)

---

## 2. Storage  **[CERRADO — Opción A]**

Un único markdown legible, append-only: **`.noteit/timeline.md`**.

Cada tarjeta es un bloque estilo wheel-journal, separado por `---`:

```
> CARD | id:<uuid-v7> | <created-rfc3339> | type:feat | status:doing | priority:p1 | horizon:next | area:client,backend | effort:m | ref:<id>

<body markdown, puede tener varias líneas e imágenes>
```

Cada eje es su propio token `key:value` (legible, auto-etiquetado). `area` multi =
coma-separado. Se omiten los ejes ausentes; `type`/`status` siempre presentes.
`ref` (un solo id, link neutro) se omite si no hay. Sin `author` — single-user.
(Formato exacto a confirmar cuando escribamos el parser, pero esta es la forma.)

- Append-only a nivel lógico: nunca se reescribe ni se reordena un bloque
  existente (igual que wheel: el server solo agrega al final).
- Orden en el archivo = orden de creación = la timeline.
- Reusa el patrón de parse/serialize que ya existe en `card.go`.

Alternativa descartada (por ahora): un archivo por tarjeta (`.noteit/cards/<id>.md`).
Más limpio para concurrencia pero genera muchos archivos; lo reconsideramos si el
archivo único crece demasiado.

Puntos a resolver más adelante:
- Formato EXACTO de la línea de cabecera (lo cerramos cuando escribamos el parser).
- ¿Una sola timeline global, o el archivo admite "secciones"? (ver §3).

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
