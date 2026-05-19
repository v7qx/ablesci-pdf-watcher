package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestEnsureAllowedPDFPathAllowsTempDir(t *testing.T) {
	path := filepath.Join(os.TempDir(), "ablesci-test.pdf")
	if err := ensureAllowedPDFPath(path, ""); err != nil {
		t.Fatalf("expected temp path to be allowed: %v", err)
	}
}

func TestEnsureAllowedPDFPathAllowsMoveToDir(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "paper.pdf")
	if err := ensureAllowedPDFPath(path, dir); err != nil {
		t.Fatalf("expected move_to_dir path to be allowed: %v", err)
	}
}

func TestEnsureAllowedPDFPathRejectsOutsideAllowedDirs(t *testing.T) {
	allowed := filepath.Join(t.TempDir(), "allowed")
	outside := filepath.Join(string(filepath.Separator), "ablesci-outside-test", "paper.pdf")
	if runtime.GOOS == "windows" {
		volume := filepath.VolumeName(os.TempDir())
		if volume == "" {
			volume = `C:`
		}
		outside = filepath.Join(volume+string(filepath.Separator), "ablesci-outside-test", "paper.pdf")
	}
	if err := ensureAllowedPDFPath(outside, allowed); err == nil {
		t.Fatal("expected outside path to be rejected")
	}
}
