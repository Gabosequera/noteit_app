//go:build linux

package main

import "os"

// WebKitGTK on Linux hands the webview a broken rendering surface on some
// setups — notably NVIDIA's proprietary driver under a native Wayland session.
// The viewport reports garbage dimensions (innerWidth = INT_MIN, body width =
// Infinity) and the page layout collapses. Routing through XWayland and
// disabling the DMABUF / accelerated-compositing paths gives WebKitGTK a
// surface it can size correctly. These are set before GTK/WebKit initialize.
// setIfUnset is used so a user can still override any of them from the shell.
func init() {
	setIfUnset("GDK_BACKEND", "x11")
	setIfUnset("WEBKIT_DISABLE_DMABUF_RENDERER", "1")
	setIfUnset("WEBKIT_DISABLE_COMPOSITING_MODE", "1")
}

func setIfUnset(key, value string) {
	if _, ok := os.LookupEnv(key); !ok {
		_ = os.Setenv(key, value)
	}
}
