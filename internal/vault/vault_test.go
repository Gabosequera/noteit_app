package vault

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateRootRejectsHomeAndSlash(t *testing.T) {
	if _, err := ValidateRoot("/"); err == nil {
		t.Error("expected / to be rejected")
	}
	if _, err := ValidateRoot(""); err == nil {
		t.Error("expected empty root to be rejected")
	}
	if home, err := os.UserHomeDir(); err == nil {
		if _, err := ValidateRoot(home); err == nil {
			t.Error("expected home dir to be rejected")
		}
	}
}

func TestResolveExplicitOverride(t *testing.T) {
	dir := t.TempDir()
	got, err := Resolve(dir)
	if err != nil {
		t.Fatalf("resolve explicit: %v", err)
	}
	// The result is canonicalized through symlinks (macOS /var -> /private/var,
	// Linux temp dirs are usually already canonical), so compare resolved paths.
	want, _ := filepath.EvalSymlinks(dir)
	if got != want {
		t.Fatalf("resolve explicit = %q, want %q", got, want)
	}
}

func TestResolveExplicitMissingIsError(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "does-not-exist")
	if _, err := Resolve(missing); err == nil {
		t.Fatal("expected error for missing explicit vault path")
	}
}

func TestResolveExplicitFileIsError(t *testing.T) {
	f := filepath.Join(t.TempDir(), "afile")
	if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Resolve(f); err == nil {
		t.Fatal("expected error when explicit vault path is a file, not a dir")
	}
}

func TestExplicitBeatsEnv(t *testing.T) {
	explicit := t.TempDir()
	t.Setenv("NOTEIT_PROJECT", t.TempDir()) // different dir; must be ignored
	got, err := Resolve(explicit)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := filepath.EvalSymlinks(explicit)
	if got != want {
		t.Fatalf("explicit override not honored: got %q want %q", got, want)
	}
}

func TestEnvBeatsCwdWalk(t *testing.T) {
	envRoot := t.TempDir()
	t.Setenv("NOTEIT_PROJECT", envRoot)
	got, err := Discover()
	if err != nil {
		t.Fatal(err)
	}
	want, _ := filepath.EvalSymlinks(envRoot)
	if got != want {
		t.Fatalf("env root not honored: got %q want %q", got, want)
	}
}

func TestWalkUpForGit(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	deep := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := walkUpForGit(deep); got != root {
		t.Fatalf("walkUpForGit(%q) = %q, want %q", deep, got, root)
	}
}

func TestEnsureNoteitDirWritesGitignore(t *testing.T) {
	root := t.TempDir()
	if err := EnsureNoteitDir(root); err != nil {
		t.Fatalf("ensure: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(NoteitDir(root), ".gitignore"))
	if err != nil {
		t.Fatalf("read .gitignore: %v", err)
	}
	if string(data) != "*\n" {
		t.Fatalf(".gitignore = %q, want %q", string(data), "*\n")
	}
	// Idempotent: a second call must not error or clobber.
	if err := EnsureNoteitDir(root); err != nil {
		t.Fatalf("ensure (2nd): %v", err)
	}
}
