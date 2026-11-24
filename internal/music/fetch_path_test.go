package music

import (
	"runtime"
	"testing"
)

// PathOf reads the path of a file: URL in the forms sources and tests write
// it. A file://C:/ URL used to lose its drive on Windows, reading a path
// relative to the working directory, so a song on disk failed to open.
func TestPathOf(t *testing.T) {
	if _, ok := PathOf("https://example.com/a.mp3"); ok {
		t.Fatal("an https URL is a file")
	}
	if runtime.GOOS != "windows" {
		for _, s := range []string{"file:///tmp/a.mp3", "file:/tmp/a.mp3"} {
			if got, ok := PathOf(s); !ok || got != "/tmp/a.mp3" {
				t.Errorf("%s is %q, %v", s, got, ok)
			}
		}
		return
	}
	for _, s := range []string{"file:///C:/Music/a.mp3", "file://C:/Music/a.mp3", "file:/C:/Music/a.mp3"} {
		if got, ok := PathOf(s); !ok || got != `C:\Music\a.mp3` {
			t.Errorf("%s is %q, %v", s, got, ok)
		}
	}
	if got, ok := PathOf("file://server/share/a.mp3"); !ok || got != `\\server\share\a.mp3` {
		t.Errorf("a server's path is %q, %v", got, ok)
	}
}