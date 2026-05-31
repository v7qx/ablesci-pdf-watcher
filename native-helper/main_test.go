package main

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestEnsureAllowedPDFPathAllowsTempDir(t *testing.T) {
	path := filepath.Join(os.TempDir(), "ablesci-test.pdf")
	if err := ensureAllowedPDFPath(path); err != nil {
		t.Fatalf("expected temp path to be allowed: %v", err)
	}
}

func TestEnsureAllowedPDFPathRejectsOutsideAllowedDirs(t *testing.T) {
	outside := filepath.Join(string(filepath.Separator), "ablesci-outside-test", "paper.pdf")
	if runtime.GOOS == "windows" {
		volume := filepath.VolumeName(os.TempDir())
		if volume == "" {
			volume = `C:`
		}
		outside = filepath.Join(volume+string(filepath.Separator), "ablesci-outside-test", "paper.pdf")
	}
	if err := ensureAllowedPDFPath(outside); err == nil {
		t.Fatal("expected outside path to be rejected")
	}
}
