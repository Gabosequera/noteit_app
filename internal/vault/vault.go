// Package vault resolves and prepares the on-disk noteit vault (.noteit/) for a
// project. It is the ONE place project-root discovery lives: storage packages
// (internal/cards) receive an explicit, already-resolved path and never guess,
// and every front-end (the Wails app, the MCP server) shares this resolution so
// they can never disagree about which vault they operate on.
package vault

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Resolve resolves the project root that owns the .noteit/ vault.
//
// Precedence (highest first):
//  1. explicit — an override such as a `--vault` CLI flag.
//  2. $NOTEIT_PROJECT — environment override.
//  3. the nearest ancestor of $CWD containing a .git entry.
//  4. $CWD itself.
//
// The result is made absolute, canonicalized through symlinks when it exists,
// and validated (never "/" or the user's home directory). An explicit or
// environment override that does not point at an existing directory is a hard
// error, so a mis-typed vault path fails loudly instead of silently scattering a
// new .noteit/ somewhere unexpected.
func Resolve(explicit string) (string, error) {
	if v := strings.TrimSpace(explicit); v != "" {
		return resolveOverride(v, "vault path")
	}
	if v := strings.TrimSpace(os.Getenv("NOTEIT_PROJECT")); v != "" {
		return resolveOverride(v, "NOTEIT_PROJECT")
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("getwd: %w", err)
	}
	if gitRoot := walkUpForGit(cwd); gitRoot != "" {
		return ValidateRoot(canonical(gitRoot))
	}
	return ValidateRoot(canonical(cwd))
}

// Discover is Resolve with no explicit override (env -> .git walk -> cwd).
func Discover() (string, error) { return Resolve("") }

// resolveOverride turns a user-supplied path (flag or env) into a validated,
// canonical absolute directory, failing clearly if it is missing or not a dir.
func resolveOverride(p, label string) (string, error) {
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", fmt.Errorf("%s invalid: %w", label, err)
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("%s %q: %w", label, abs, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%s %q is not a directory", label, abs)
	}
	return ValidateRoot(canonical(abs))
}

// canonical resolves symlinks best-effort so two paths to the same directory
// (and a swapped-out symlink) resolve to one stable identity. If the path cannot
// be evaluated (e.g. it does not exist yet) the cleaned absolute path is kept.
func canonical(dir string) string {
	if resolved, err := filepath.EvalSymlinks(dir); err == nil {
		return resolved
	}
	return filepath.Clean(dir)
}

// walkUpForGit returns the nearest ancestor (including start) containing a .git
// entry, or "" if none is found before the filesystem root.
func walkUpForGit(start string) string {
	dir := start
	for {
		if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return ""
		}
		dir = parent
	}
}

// ValidateRoot refuses roots that would scatter a .noteit/ somewhere meaningless:
// the filesystem root and the user's home directory. The home check compares
// CANONICAL paths on both sides, so a symlinked $HOME cannot slip through by
// resolving to a different string than the candidate (which Resolve canonicalizes).
func ValidateRoot(dir string) (string, error) {
	cleaned := filepath.Clean(dir)
	if cleaned == "" || cleaned == "." {
		return "", errors.New("refusing to use an empty/relative project path; set NOTEIT_PROJECT or run inside a project")
	}
	// Any filesystem root is its own parent: "/" on Unix, "C:\\" on Windows.
	if filepath.Dir(cleaned) == cleaned {
		return "", errors.New("refusing to use filesystem root as project; set NOTEIT_PROJECT or run inside a project")
	}
	if home, err := os.UserHomeDir(); err == nil && canonical(cleaned) == canonical(home) {
		return "", errors.New("refusing to use home directory as project; set NOTEIT_PROJECT or run inside a project")
	}
	return dir, nil
}

// ── path helpers ─────────────────────────────────────────────────────────────

// NoteitDir is <root>/.noteit.
func NoteitDir(root string) string { return filepath.Join(root, ".noteit") }

// NotesDir is <root>/.noteit/notes (one file per text note).
func NotesDir(root string) string { return filepath.Join(NoteitDir(root), "notes") }

// TimelinePath is <root>/.noteit/timeline.md (the append-only card log).
func TimelinePath(root string) string { return filepath.Join(NoteitDir(root), "timeline.md") }

// LockPath is <root>/.noteit/timeline.lock (the dedicated interprocess lock file
// guarding all timeline reads/repairs/appends — see internal/cards locking).
func LockPath(root string) string { return filepath.Join(NoteitDir(root), "timeline.lock") }

// EnsureNoteitDir creates .noteit/ and, the first time, writes a private-by-
// default .gitignore ("*") so the vault is never committed unless the user opts
// in. It is safe to call repeatedly and from multiple services.
func EnsureNoteitDir(root string) error {
	dir := NoteitDir(root)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("mkdir .noteit: %w", err)
	}
	gitignore := filepath.Join(dir, ".gitignore")
	if _, err := os.Stat(gitignore); errors.Is(err, os.ErrNotExist) {
		if err := os.WriteFile(gitignore, []byte("*\n"), 0o644); err != nil {
			return fmt.Errorf("write .gitignore: %w", err)
		}
	}
	return nil
}
