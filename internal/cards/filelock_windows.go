//go:build windows

package cards

import (
	"fmt"
	"os"

	"golang.org/x/sys/windows"
)

// acquireFileLock takes an exclusive lock on a DEDICATED lock file via LockFileEx
// and returns a release function. It mirrors the Unix flock implementation: a
// blocking, whole-file exclusive lock on a file that is never the timeline inode,
// so the GUI and the MCP server are serialized the same way on every platform.
//
// INVARIANT (all platforms): the lock file must not be deleted or replaced while
// any noteit process is running. Windows byte-range locks, like Unix flock, bind
// to the open handle's file, so removing the lock file out from under a live
// process would let another process lock a different file and proceed concurrently.
func acquireFileLock(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open lock file: %w", err)
	}
	h := windows.Handle(f.Fd())
	// Exclusive, blocking lock over the maximum byte range (0..0xFFFFFFFFFFFFFFFF).
	if err := windows.LockFileEx(h, windows.LOCKFILE_EXCLUSIVE_LOCK, 0,
		^uint32(0), ^uint32(0), &windows.Overlapped{}); err != nil {
		f.Close()
		return nil, fmt.Errorf("LockFileEx: %w", err)
	}
	return func() {
		_ = windows.UnlockFileEx(h, 0, ^uint32(0), ^uint32(0), &windows.Overlapped{})
		_ = f.Close()
	}, nil
}
