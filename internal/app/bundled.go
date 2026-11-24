package app

import (
	"embed"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
)

// NetEase build: the NetEase Cloud Music plugin ships in the binary, as the
// files under bundled/netease, and is put in the plugins directory on first
// run. Its README is copied beside it.
//
// defaultSourceID is the source the app opens on, and the one it ships with.
const defaultSourceID = "netease"

// bundled are the plugins shipped in the app, under bundled/<id>, which go
// into the plugins directory the first time the app opens without them.
//
//go:embed bundled/netease
var bundled embed.FS

// installBundledPlugins puts the app's own plugins in dir where they aren't
// installed yet, and leaves those that are as they are: a plugin there may be
// newer than the app's, as one updated from its repository.
func installBundledPlugins(dir string) {
	entries, err := bundled.ReadDir("bundled")
	if err != nil {
		log.Printf("bundled plugins: %v", err)
		return
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		id := e.Name()
		target := filepath.Join(dir, id)
		if _, err := os.Stat(filepath.Join(target, "plugin.json")); err == nil {
			continue
		}
		if err := writeBundledPlugin(id, target); err != nil {
			log.Printf("bundled plugin %s: %v", id, err)
		}
	}
}

// writeBundledPlugin writes the files of bundled/<id> into target, which it
// makes, keeping the folders the plugin has.
func writeBundledPlugin(id, target string) error {
	root := path.Join("bundled", id)
	return fs.WalkDir(bundled, root, func(name string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(filepath.FromSlash(root), filepath.FromSlash(name))
		if err != nil {
			return err
		}
		dst := filepath.Join(target, rel)
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		b, err := bundled.ReadFile(name)
		if err != nil {
			return err
		}
		return os.WriteFile(dst, b, 0o644)
	})
}
