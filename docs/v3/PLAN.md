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
referencian un entry). Tomamos eso y le sumamos: **tags**, **threading por
referencia** (responder/actualizar = nueva tarjeta linkeada) y **embeds** en
archivos de texto.

Principio que se hereda de wheel-journal y del `card.go` actual: **el dato vive
como markdown legible**. Si la app muere, abrís el archivo y lo leés.

---

## 1. La entidad Card  **[ABIERTO — a discutir]**

Forma propuesta (sujeta a discusión):

```
Card {
  id        // uuid v7 (ordena por tiempo), inmutable
  created   // timestamp, ÚNICO, define su posición en la timeline
  author    // inmutable
  body      // markdown, inmutable
  tags []   // para filtrar y armar timelines por tag
  refs []   // referencias a otras tarjetas: { type: reply|update, target: id }
}
```

**Reglas:**
- Una tarjeta **nunca** se edita ni se borra. Es inmutable de por vida.
- "Actualizar" una tarjeta = crear **otra** tarjeta con `ref:update → id`.
- "Responder/comentar" = crear **otra** tarjeta con `ref:reply → id`.
- El hilo de conversación se **reconstruye** siguiendo las `refs`. Las tarjetas
  no están anidadas; son objetos separados que se linkean.
- `created` es único → no pueden existir dos tarjetas en el mismo instante.

Puntos a resolver en esta sección:
- ¿`update` y `reply` son los únicos tipos de `ref`, o habrá más (ej. `link`
  simple sin semántica de hilo)?
- ¿Una tarjeta puede tener varias `refs` (ej. responder a dos a la vez)?
- ¿`tags` es lista libre de strings, o un set controlado?
- ¿El `author` de dónde sale en una app local single-user? (¿config del vault?)

---

## 2. Storage  **[CERRADO — Opción A]**

Un único markdown legible, append-only: **`.noteit/timeline.md`**.

Cada tarjeta es un bloque estilo wheel-journal, separado por `---`:

```
> CARD | <created-rfc3339> | author=<urlenc> | id:<uuid> | tags:a,b | refs:reply:<id>,update:<id>

<body markdown, puede tener varias líneas e imágenes>
```

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

- **Fase 1 — backend de entidades:** modelo `Card` + store `.noteit/timeline.md`
  append-only + servicio (`CreateCard`, `ListCards`). Inmutable, timestamp único.
- **Fase 2 — UI timeline:** feed + composer rápido + tags + responder/actualizar
  (nueva tarjeta linkeada) + filtro por tag.
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
