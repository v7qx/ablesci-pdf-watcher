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
