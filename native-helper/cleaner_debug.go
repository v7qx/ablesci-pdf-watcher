package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// maxDebugLogBytes bounds the size of optional debug/diagnostic logs such as
// ablesci_cleaner_debug.log. When a log grows past this,
// rotateLogIfTooLarge rolls it to a single ".old" generation and starts fresh,
// so disk use is bounded at ~2x this value.
const maxDebugLogBytes = 256 * 1024

func listPrefixFiles(pdfPath string) string {
	dir := filepath.Dir(pdfPath)
	ext := filepath.Ext(pdfPath)
	base := filepath.Base(pdfPath)
	baseName := strings.TrimSuffix(base, ext)

	files, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Sprintf("  (Error reading dir: %v)", err)
	}

	var matched []string
	for _, f := range files {
		if !f.IsDir() && strings.HasPrefix(strings.ToLower(f.Name()), strings.ToLower(baseName)) {
			info, err := f.Info()
			size := int64(-1)
			modTime := "unknown"
			if err == nil {
				size = info.Size()
				modTime = info.ModTime().Format("15:04:05")
			}
			matched = append(matched, fmt.Sprintf("  - %s (Size: %d bytes, ModTime: %s)", f.Name(), size, modTime))
		}
	}
	if len(matched) == 0 {
		return "  (No matching prefix files)"
	}
	return strings.Join(matched, "\n")
}

func isCleanerDebugEnabled(req Request) bool {
	if req.Extra != nil && req.Extra["debug"] == "true" {
		return true
	}
	if os.Getenv("ABLESCI_DEBUG") == "true" {
		return true
	}
	return false
}

func redactCleanerArgs(args []string) []string {
	out := make([]string, 0, len(args))
	for _, arg := range args {
		value := strings.TrimSpace(arg)
		if strings.ContainsAny(value, `/\`) || strings.EqualFold(filepath.Ext(value), ".pdf") || strings.EqualFold(filepath.Ext(value), ".json") {
			ext := strings.ToLower(filepath.Ext(value))
			if ext == "" {
				ext = ".path"
			}
			value = "<redacted" + ext + ">"
		}
		out = append(out, value)
	}
	return out
}

func redactLocalDebugText(value string) string {
	out := value
	for _, entry := range []struct{ path, replacement string }{
		{os.Getenv("USERPROFILE"), "%USERPROFILE%"},
		{os.TempDir(), "%TEMP%"},
	} {
		if strings.TrimSpace(entry.path) != "" {
			out = strings.ReplaceAll(out, entry.path, entry.replacement)
		}
	}
	return out
}

func removeDebugFileOlderThan(path string, maxAge time.Duration) {
	if maxAge <= 0 {
		return
	}
	if info, err := os.Stat(path); err == nil && time.Since(info.ModTime()) > maxAge {
		_ = os.Remove(path)
		_ = os.Remove(path + ".old")
	}
}

// rotateLogIfTooLarge keeps an append-mode debug log from growing without bound.
// When the file exceeds maxBytes it is moved to "<path>.old" (single generation)
// so the next write starts a fresh file. Best-effort: all errors are ignored.
func rotateLogIfTooLarge(path string, maxBytes int64) {
	if maxBytes <= 0 {
		return
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() <= maxBytes {
		return
	}
	_ = os.Remove(path + ".old")
	_ = os.Rename(path, path+".old")
}
