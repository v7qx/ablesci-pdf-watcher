package main

import (
	"encoding/binary"
	"encoding/json"
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

func TestCleanCleanerExecutablePathAllowsKnownToolNames(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "zotero-pdf-toolbox.exe")
	if err := os.WriteFile(path, []byte("test"), 0755); err != nil {
		t.Fatalf("write cleaner exe: %v", err)
	}
	resolved, err := cleanCleanerExecutablePath(path)
	if err != nil {
		t.Fatalf("expected cleaner path to be allowed: %v", err)
	}
	if filepath.Base(resolved) != "zotero-pdf-toolbox.exe" {
		t.Fatalf("unexpected cleaner basename: %s", filepath.Base(resolved))
	}
}

func TestCleanCleanerExecutablePathRejectsUnknownToolName(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "not-cleaner.exe")
	if err := os.WriteFile(path, []byte("test"), 0755); err != nil {
		t.Fatalf("write fake exe: %v", err)
	}
	if _, err := cleanCleanerExecutablePath(path); err == nil {
		t.Fatal("expected unknown cleaner executable name to be rejected")
	}
}

func TestBuildCleanerArgsUsesToolboxContract(t *testing.T) {
	args := buildCleanerArgs(
		filepath.Join("C:", "Tools", "zotero-pdf-toolbox.exe"),
		"paper.pdf",
		"summary.json",
		map[string]string{"patterns_path": "patterns.json", "engine": "qpdf"},
		true,
		45,
	)
	want := []string{
		"clean-access",
		"--input", "paper.pdf",
		"--replace",
		"--backup-suffix", ".original.pdf",
		"--summary-json", "summary.json",
		"--patterns", "patterns.json",
		"--engine", "qpdf",
		"--timeout-seconds", "45",
	}
	if len(args) != len(want) {
		t.Fatalf("args length mismatch: got %v want %v", args, want)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("arg %d mismatch: got %q want %q; all args=%v", i, args[i], want[i], args)
		}
	}
}

func TestBuildCleanerArgsKeepsLegacyAccessCleanerFlags(t *testing.T) {
	args := buildCleanerArgs(
		filepath.Join("C:", "Tools", "zotero-access-cleaner.exe"),
		"paper.pdf",
		"summary.json",
		nil,
		false,
		60,
	)
	want := []string{
		"-input", "paper.pdf",
		"-apply",
		"-replace",
		"-no-backup",
		"-summary-json", "summary.json",
		"-timeout-seconds", "60",
	}
	if len(args) != len(want) {
		t.Fatalf("args length mismatch: got %v want %v", args, want)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("arg %d mismatch: got %q want %q; all args=%v", i, args[i], want[i], args)
		}
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
	resp := captureNativeResponse(t, func() error {
		return handleCopyPDF(Request{Path: path})
	})
	defer os.Remove(resp.Path)
	if !resp.OK {
		t.Fatalf("copy response not ok: %s", resp.Error)
	}
	if filepath.Ext(resp.Path) != ".pdf" {
		t.Fatalf("expected pdf target, got %s", resp.Path)
	}
	if filepath.Base(resp.Path) != "ablesci-copy-test.original.pdf" {
		t.Fatalf("unexpected target name: %s", filepath.Base(resp.Path))
	}
	copiedInfo, _, err := inspectPDF(resp.Path)
	if err != nil {
		t.Fatalf("inspect copied pdf: %v", err)
	}
	if copiedInfo.Size() != info.Size() {
		t.Fatalf("copy size mismatch: got %d want %d", copiedInfo.Size(), info.Size())
	}
}

func TestHandleCopyPDFCreatesCleanedCopyInTargetDir(t *testing.T) {
	srcDir := t.TempDir()
	dstDir := t.TempDir()
	src := filepath.Join(srcDir, "cleaner-output.pdf")
	if err := os.WriteFile(src, []byte("%PDF-1.4\n% cleaned\n"), 0644); err != nil {
		t.Fatalf("write source pdf: %v", err)
	}
	resp := captureNativeResponse(t, func() error {
		return handleCopyPDF(Request{
			Path:      src,
			MoveToDir: dstDir,
			Filename:  "paper.pdf",
			Extra:     map[string]string{"suffix": ".cleaned.pdf"},
		})
	})
	defer os.Remove(resp.Path)
	if !resp.OK {
		t.Fatalf("copy response not ok: %s", resp.Error)
	}
	if filepath.Dir(resp.Path) != dstDir {
		t.Fatalf("expected target dir %s, got %s", dstDir, filepath.Dir(resp.Path))
	}
	if filepath.Base(resp.Path) != "paper.cleaned.pdf" {
		t.Fatalf("unexpected target name: %s", filepath.Base(resp.Path))
	}
	if _, _, err := inspectPDF(resp.Path); err != nil {
		t.Fatalf("inspect copied pdf: %v", err)
	}
}

func captureNativeResponse(t *testing.T, fn func() error) Response {
	t.Helper()
	oldStdout := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("create stdout pipe: %v", err)
	}
	os.Stdout = w
	callErr := fn()
	closeErr := w.Close()
	os.Stdout = oldStdout
	if callErr != nil {
		r.Close()
		t.Fatalf("native call failed: %v", callErr)
	}
	if closeErr != nil {
		r.Close()
		t.Fatalf("close stdout pipe: %v", closeErr)
	}
	defer r.Close()
	var size uint32
	if err := binary.Read(r, binary.LittleEndian, &size); err != nil {
		t.Fatalf("read response size: %v", err)
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(r, buf); err != nil {
		t.Fatalf("read response body: %v", err)
	}
	var resp Response
	if err := json.Unmarshal(buf, &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return resp
}
