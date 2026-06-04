//go:build !windows

package cards

import (
	"fmt"
	"os"
	"syscall"
)

// acquireFileLock takes an exclusive advisory lock (flock LOCK_EX) on a DEDICATED
// lock file, creating it if needed, and returns a release function. The lock file
// is never the timeline inode itself, so locking is fully decoupled from the data
// we read, truncate, and rewrite — a swapped-out or repaired timeline can never
// drop the lock mid-operation.
//
// flock is advisory and tied to the open file description: two independent opens
// of the same path (whether from two processes — GUI + MCP — or two goroutines
// each with their own fd) block one another, which is exactly the cross-process
// coordination this store needs. The call blocks until the lock is granted.
//
// INVARIANT: the lock file must not be deleted or replaced while any noteit
// process is running. flock binds to the inode, not the pathname, so if the lock
// file were unlinked/recreated mid-operation a second process would open and lock
// a DIFFERENT inode and proceed concurrently. The lock file lives inside the
// gitignored .noteit/ vault and is never touched after creation, so this holds.
func acquireFileLock(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, fmt.Errorf("flock: %w", err)
	}
	return func() {
		// Best effort: an unlock failure is non-actionable (closing the fd
		// releases the lock anyway), so we just ensure the fd is closed.
		_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
		_ = f.Close()
	}, nil
}
