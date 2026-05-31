/* ───────────────────────── noteit · hand-written backend calls ─────────────────────────
   A few backend methods are called by FQN instead of through the generated
   bindings in ../bindings. The Wails binding generator currently can't run in
   this tree (missing go.sum entries for its CLI deps), and the generated files
   are stamped "DO NOT EDIT" — so for methods added after the last successful
   generation we call them directly by their fully-qualified name.

   $Call.ByName resolves on the Go side via bindings.Get(), which keys bound
   methods by FQN = "<packagePath>.<Type>.<Method>" (bindings.go). For this app
   the package path is the module path, so the prefix is:
       github.com/Gabosequera/noteit_app.NoteService.<Method>
   Keep these in sync by regenerating bindings once the generator works again and
   deleting this shim. */

import { Call as $Call } from "@wailsio/runtime";
import { Note } from "../bindings/github.com/Gabosequera/noteit_app/index.js";

const SVC = "github.com/Gabosequera/noteit_app.NoteService";

/**
 * SaveBody overwrites a note's whole Markdown body and returns the re-parsed Note.
 * This is the Obsidian-style raw-text save path: the editor owns the entire
 * document (prose + inline card fences) as plain text, so persistence is a single
 * whole-body write with no block diffing and no journal entry.
 */
export function SaveBody(noteID: string, body: string): Promise<Note> {
    return $Call.ByName(`${SVC}.SaveBody`, noteID, body).then((r: unknown) => Note.createFrom(r));
}
