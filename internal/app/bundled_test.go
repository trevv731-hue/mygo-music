package app

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// A bundled plugin is written into the plugins directory where it isn't
// installed yet; one that is installed, and may be newer, is left as it is.
func TestInstallBundledPlugins(t *testing.T) {
	dir := t.TempDir()
	installBundledPlugins(dir)
	manifest := filepath.Join(dir, defaultSourceID, "plugin.json")
	b, err := os.ReadFile(manifest)
	if err != nil {
		t.Fatalf("no bundled manifest: %v", err)
	}
	var m struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(b, &m); err != nil || m.ID != defaultSourceID {
		t.Fatalf("bundled manifest is %q, %v", b, err)
	}
	if _, err := os.Stat(filepath.Join(dir, defaultSourceID, "index.js")); err != nil {
		t.Fatalf("no bundled source: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, defaultSourceID, "README.md")); err != nil {
		t.Fatalf("no bundled readme: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, defaultSourceID, "locales", "zh-CN.json")); err != nil {
		t.Fatalf("no bundled Chinese: %v", err)
	}

	// What's installed is the listener's, and may be newer than the app's.
	installed := []byte(`{"id":"netease","name":"Installed"}`)
	if err := os.WriteFile(manifest, installed, 0o644); err != nil {
		t.Fatal(err)
	}
	installBundledPlugins(dir)
	got, err := os.ReadFile(manifest)
	if err != nil || string(got) != string(installed) {
		t.Fatalf("manifest is %q, %v after a second install", got, err)
	}
}

// The bundled plugin's Chinese covers every text it shows: what plugin.json
// names it and its settings and sidebar, and each text index.js asks the app to
// translate, or English shows among the Chinese.
func TestBundledPluginHasChinese(t *testing.T) {
	zh := map[string]string{}
	b, err := bundled.ReadFile("bundled/netease/locales/zh-CN.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &zh); err != nil {
		t.Fatal(err)
	}
	b, err = bundled.ReadFile("bundled/netease/plugin.json")
	if err != nil {
		t.Fatal(err)
	}
	var m struct {
		Name     string `json:"name"`
		Settings []struct {
			Label   string `json:"label"`
			Help    string `json:"help"`
			Options []struct {
				Label string `json:"label"`
			} `json:"options"`
		} `json:"settings"`
		Navigation []struct {
			Title string `json:"title"`
		} `json:"navigation"`
	}
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	texts := []string{m.Name}
	for _, s := range m.Settings {
		texts = append(texts, s.Label, s.Help)
		for _, o := range s.Options {
			texts = append(texts, o.Label)
		}
	}
	for _, n := range m.Navigation {
		texts = append(texts, n.Title)
	}
	b, err = bundled.ReadFile("bundled/netease/index.js")
	if err != nil {
		t.Fatal(err)
	}
	for _, match := range regexp.MustCompile(`(?:^|[^\w$])t\("([^"]*)"\)`).FindAllStringSubmatch(string(b), -1) {
		texts = append(texts, match[1])
	}
	for _, text := range texts {
		if text != "" && zh[text] == "" {
			t.Errorf("no Chinese for %q", text)
		}
	}
}
