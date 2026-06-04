# noteit v3 — diccionario de taxonomía (tags)

6 ejes · 33 valores canónicos · pocos sinónimos esenciales por valor.

- **Guardado** = forma canónica (columna izquierda).
- **Tecleado** = canónico **o** cualquier sinónimo.
- **Normalización al parsear**: `lowercase` → quitar acentos → sinónimo→canónico.
- La taxonomía es **data-driven**: esta tabla ES la fuente. El código de tags no
  hardcodea valores por eje; lee este diccionario. Agregar/cambiar un valor o
  sinónimo es tocar datos, no lógica.

**Obligatorios (siempre materializados en la tarjeta):**
- `type`   — default `note`
- `status` — default `todo`

**Opcionales (solo se guardan si se setean):**
- `priority` · `horizon` (default lógico `now`) · `area` · `effort`

---

## Eje 1 · TYPE — qué clase de trabajo  [1 valor · default `note`]

| canónico | sinónimos |
|----------|-----------|
| `note`   | nota, general        *(default si type queda vacío)* |
| `rem`    | reminder, recordatorio, recordar, remind  *(← propuestos, a confirmar)* |
| `feat`   | feature, new, add, nuevo |
| `fix`    | bug, hotfix, arreglar |
| `refactor` | refac, cleanup, limpiar |
| `perf`   | performance, optimize |
| `docs`   | doc, readme |
| `test`   | tests, testing |
| `chore`  | build, ci, config |

## Eje 2 · STATUS — en qué estado  [1 valor · default `todo`]

| canónico | sinónimos |
|----------|-----------|
| `todo`    | pendiente, pending |
| `doing`   | wip, in-progress, haciendo |
| `blocked` | bloqueado, stuck |
| `review`  | in-review, qa, pr |
| `done`    | hecho, listo, closed, ready, solved, resuelto |

## Eje 3 · PRIORITY — urgencia  [0-1 valor]

| canónico | sinónimos |
|----------|-----------|
| `p0` | critical, urgent, urgente |
| `p1` | high, alta |
| `p2` | medium, normal |
| `p3` | low, baja |

## Eje 4 · HORIZON — cuándo aparece  [0-1 valor · default lógico `now`]

| canónico | sinónimos |
|----------|-----------|
| `now`    | ahora, current |
| `next`   | siguiente, upcoming |
| `future` | futuro, later, missing, soon |

## Eje 5 · AREA — qué parte  [0-N valores · multi]

| canónico | sinónimos |
|----------|-----------|
| `client`   | frontend, ui |
| `backend`  | server, back |
| `api`      | endpoint, rest |
| `data`     | db, database, sql |
| `infra`    | ops, deploy, devops |
| `security` | auth, sec |
| `deps`     | dependencies, package |
| `tooling`  | tools, cli, lint |

## Eje 6 · EFFORT — tamaño  [0-1 valor]

| canónico | sinónimos |
|----------|-----------|
| `xs` | trivial, tiny |
| `s`  | small, pequeño |
| `m`  | mediano |
| `l`  | large, grande |

---

## Colisiones resueltas (palabra ambigua → eje)

| palabra | resuelve a |
|---------|------------|
| trivial | `effort:xs` |
| normal  | `priority:p2` |
| testing | `type:test` |
| pending | `status:todo` |
| soon    | `horizon:future` |
| ready   | `status:done` |
| build / ci / config | `type:chore` *(el área se añade aparte: +deps, +infra)* |
