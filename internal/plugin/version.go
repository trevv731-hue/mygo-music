package plugin

import (
	"regexp"
	"strconv"
	"strings"
)

// pluginName is what a plugin may be called: its ID names its data folder.
var pluginName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)

// IsNewer reports whether a required or repository version is one to compare to
// what's there. Tags that are version numbers compare as such, for a release
// taken back not to read as new. Anything else has no order: a commit is just the
// latest, so one that's different is new.
func IsNewer(latest, installed string) bool {
	if latest == installed {
		return false
	}
	a, okA := versionNumbers(latest)
	b, okB := versionNumbers(installed)
	if !okA || !okB {
		return true
	}
	for i := range max(len(a), len(b)) {
		var x, y int
		if i < len(a) {
			x = a[i]
		}
		if i < len(b) {
			y = b[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// versionNumbers reads a tag such as v1.2.3, or 1.2. A tag with a label, such as
// 1.2.3-beta, isn't one: its order isn't only in its numbers.
func versionNumbers(tag string) ([]int, bool) {
	parts := strings.Split(strings.TrimPrefix(tag, "v"), ".")
	numbers := make([]int, len(parts))
	for i, part := range parts {
		n, err := strconv.Atoi(part)
		if err != nil || n < 0 {
			return nil, false
		}
		numbers[i] = n
	}
	return numbers, true
}