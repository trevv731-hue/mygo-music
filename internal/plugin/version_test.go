package plugin

import "testing"

// A release taken back isn't an update, numbers compare as numbers, and a commit,
// having no order, is one if it's different.
func TestIsNewer(t *testing.T) {
	for _, c := range []struct {
		latest, installed string
		want              bool
	}{
		{"v1.2.0", "v1.1.9", true},
		{"v1.10.0", "v1.9.0", true},
		{"v1.1.0", "v1.2.0", false},
		{"v1.2", "1.2.0", false},
		{"1.2.1", "v1.2", true},
		{"v1.2.0", "v1.2.0", false},
		{"abc123def456", "0123456789ab", true},
		{"v1.0.0", "0123456789ab", true},
		{"v2.0.0-beta", "v1.0.0", true},
	} {
		if got := IsNewer(c.latest, c.installed); got != c.want {
			t.Errorf("IsNewer(%q, %q) = %v", c.latest, c.installed, got)
		}
	}
}