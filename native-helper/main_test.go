package main

import (
	"io"
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

func TestValidateOSSHostAllowsAliyunPublicEndpoints(t *testing.T) {
	hosts := []string{
		"https://ables1.oss-cn-shanghai.aliyuncs.com/",
		"https://ables2.oss-cn-beijing.aliyuncs.com",
		"https://bucket-name.oss-accelerate.aliyuncs.com/",
	}
	for _, host := range hosts {
		if err := validateOSSHost(host); err != nil {
			t.Fatalf("expected %s to be allowed: %v", host, err)
		}
	}
}

func TestValidateOSSHostRejectsUnsafeEndpoints(t *testing.T) {
	hosts := []string{
		"http://ables1.oss-cn-shanghai.aliyuncs.com/",
		"https://localhost/",
		"https://127.0.0.1/",
		"https://ables1.oss-cn-shanghai-internal.aliyuncs.com/",
		"https://ables1.oss-cn-shanghai.aliyuncs.com/?token=1",
		"https://user:pass@ables1.oss-cn-shanghai.aliyuncs.com/",
		"https://example.com/",
		"https://evil.aliyuncs.com/",
	}
	for _, host := range hosts {
		if err := validateOSSHost(host); err == nil {
			t.Fatalf("expected %s to be rejected", host)
		}
	}
}

func TestHandleCopyPDFCreatesOriginalCopy(t *testing.T) {
	src := filepath.Join(os.TempDir(), "ablesci-copy-test.pdf")
	if err := os.WriteFile(src, []byte("%PDF-1.4\n% test\n"), 0644); err != nil {
		t.Fatalf("write source pdf: %v", err)
	}
	defer os.Remove(src)

	path, err := cleanExistingPath(src)
	if err != nil {
		t.Fatalf("clean path: %v", err)
	}
	info, _, err := inspectPDF(path)
	if err != nil {
		t.Fatalf("inspect source pdf: %v", err)
	}
	ext := filepath.Ext(path)
	base := path[:len(path)-len(ext)]
	target := uniquePath(base + ".original.pdf")
	in, err := os.Open(path)
	if err != nil {
		t.Fatalf("open source: %v", err)
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		t.Fatalf("create target: %v", err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		t.Fatalf("copy target: %v", err)
	}
	if err := out.Close(); err != nil {
		t.Fatalf("close target: %v", err)
	}
	defer os.Remove(target)
	copiedInfo, _, err := inspectPDF(target)
	if err != nil {
		t.Fatalf("inspect copied pdf: %v", err)
	}
	if copiedInfo.Size() != info.Size() {
		t.Fatalf("copy size mismatch: got %d want %d", copiedInfo.Size(), info.Size())
	}
}
