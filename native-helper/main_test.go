package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMarkerDownloadDirsFromBytesIncludesLegacyAndProfiles(t *testing.T) {
	legacy := filepath.Join(t.TempDir(), "legacy-downloads")
	profile4 := filepath.Join(t.TempDir(), "profile4-downloads")
	dedicated := filepath.Join(t.TempDir(), "dedicated-downloads")
	payload, err := json.Marshal(map[string]any{
		"download_dir": legacy,
		"profiles": []map[string]string{
			{
				"browser":      "Chrome",
				"profile_dir":  filepath.Join(t.TempDir(), "Profile 4"),
				"download_dir": profile4,
				"updated_at":   "2026-06-20T00:00:00",
			},
			{
				"browser":      "Chrome",
				"profile_dir":  filepath.Join(t.TempDir(), "BrowserProfile_Chrome"),
				"download_dir": dedicated,
				"updated_at":   "2026-06-20T00:00:00",
			},
			{"browser": "Chrome"},
		},
	})
	if err != nil {
		t.Fatalf("marshal marker: %v", err)
	}

	got := markerDownloadDirsFromBytes(payload)
	want := []string{
		cleanOptionalDir(legacy),
		cleanOptionalDir(profile4),
		cleanOptionalDir(dedicated),
	}
	if len(got) != len(want) {
		t.Fatalf("dir count mismatch: got %v want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("dir %d mismatch: got %q want %q; all=%v", i, got[i], want[i], got)
		}
	}
}

func TestEnsureAllowedPDFPathAllowsTempDir(t *testing.T) {
	file, err := os.CreateTemp("", "ablesci-test-*.pdf")
	if err != nil {
		t.Fatalf("create temp pdf: %v", err)
	}
	path := file.Name()
	file.Close()
	defer os.Remove(path)

	path, err = cleanExistingPath(path)
	if err != nil {
		t.Fatalf("clean temp pdf path: %v", err)
	}
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

func TestInspectPDFRejectsInvalidHeader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "not-a-pdf.pdf")
	if err := os.WriteFile(path, []byte("<html>login required</html>"), 0644); err != nil {
		t.Fatalf("write invalid pdf: %v", err)
	}
	if _, _, err := inspectPDF(path); err == nil {
		t.Fatal("expected invalid PDF header to be rejected")
	}
}

func TestHandleUploadOSSRejectsNonPDFBeforeNetwork(t *testing.T) {
	path := filepath.Join(os.TempDir(), "ablesci-upload-nonpdf.txt")
	if err := os.WriteFile(path, []byte("not pdf"), 0644); err != nil {
		t.Fatalf("write non-pdf: %v", err)
	}
	defer os.Remove(path)

	if err := handleUploadOSS(Request{Path: path, OSS: OSSFields{Host: "https://ables1.oss-cn-shanghai.aliyuncs.com/"}}); err == nil {
		t.Fatal("expected upload_oss to reject non-pdf file before network upload")
	}
}

func TestHandleDeleteFileRejectsOutsideAllowedDirs(t *testing.T) {
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("get wd: %v", err)
	}
	path := filepath.Join(dir, "ablesci-outside-delete-test.pdf")
	if err := os.WriteFile(path, []byte("%PDF-1.4\n% test\n"), 0644); err != nil {
		t.Fatalf("write outside pdf: %v", err)
	}
	defer os.Remove(path)
	if err := handleDeleteFile(Request{Path: path}); err == nil {
		t.Fatal("expected delete_file to reject path outside allowed dirs")
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("delete_file should not remove rejected file: %v", err)
	}
}

func TestRunPingPong(t *testing.T) {
	resp, err := runNativeRequest(Request{Action: "ping"})
	if err != nil {
		t.Fatalf("run ping: %v", err)
	}
	if !resp.OK || resp.Action != "pong" {
		t.Fatalf("unexpected ping response: %+v", resp)
	}
}

func TestReadRequestRejectsMalformedJSON(t *testing.T) {
	oldStdin := os.Stdin
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("create stdin pipe: %v", err)
	}
	os.Stdin = r
	payload := []byte(`{"action":`)
	if err := binary.Write(w, binary.LittleEndian, uint32(len(payload))); err != nil {
		t.Fatalf("write length: %v", err)
	}
	if _, err := w.Write(payload); err != nil {
		t.Fatalf("write payload: %v", err)
	}
	w.Close()
	_, readErr := readRequest()
	r.Close()
	os.Stdin = oldStdin
	if readErr == nil {
		t.Fatal("expected malformed native messaging JSON to be rejected")
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
		"--patterns", "patterns.json",
		"--replace",
		"--backup-suffix", ".original.pdf",
		"--summary-json", "summary.json",
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

func TestBuildCleanerArgsOmitsDefaultToolboxEngine(t *testing.T) {
	args := buildCleanerArgs(
		filepath.Join("C:", "Tools", "zotero-pdf-toolbox.exe"),
		"paper.pdf",
		"summary.json",
		map[string]string{"engine": "auto"},
		false,
		60,
	)
	want := []string{
		"clean-access",
		"--input", "paper.pdf",
		"--replace",
		"--no-backup",
		"--summary-json", "summary.json",
		"--timeout-seconds", "60",
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

func TestBuildPageCountArgsUsesToolboxDryRun(t *testing.T) {
	args := buildPageCountArgs(
		filepath.Join("C:", "Tools", "zotero-pdf-toolbox.exe"),
		"paper.pdf",
		"summary.json",
	)
	want := []string{
		"clean-access",
		"--input", "paper.pdf",
		"--dry-run",
		"--summary-json", "summary.json",
		"--timeout-seconds", "10",
	}
	if len(args) != len(want) {
		t.Fatalf("args length mismatch: got %v want %v", args, want)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("arg %d mismatch: got %q want %q; all args=%v", i, args[i], want[i], args)
		}
	}
	for _, arg := range args {
		if arg == "--replace" || arg == "--output" || arg == "-apply" || arg == "-replace" {
			t.Fatalf("page-count command must be non-mutating, got args=%v", args)
		}
	}
}

func TestBuildPageCountArgsKeepsLegacyDryRun(t *testing.T) {
	args := buildPageCountArgs(
		filepath.Join("C:", "Tools", "zotero-access-cleaner.exe"),
		"paper.pdf",
		"summary.json",
	)
	want := []string{
		"-input", "paper.pdf",
		"-summary-json", "summary.json",
		"-timeout-seconds", "10",
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

func TestAllowedTextReadPathRequiresHelperDirOrExactAllowedPath(t *testing.T) {
	helperDir := t.TempDir()
	allowed := filepath.Join(t.TempDir(), "blacklist.txt")
	if !isAllowedTextReadPath(filepath.Join(helperDir, "blacklist.txt"), helperDir, "") {
		t.Fatal("expected helper-local blacklist to be allowed")
	}
	if !isAllowedTextReadPath(allowed, helperDir, allowed) {
		t.Fatal("expected exact configured blacklist path to be allowed")
	}
	if isAllowedTextReadPath(filepath.Join(t.TempDir(), "other.txt"), helperDir, allowed) {
		t.Fatal("expected unrelated explicit txt path to be rejected")
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

func TestCountPDFPages(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pages.pdf")
	body := `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R >> endobj
4 0 obj << /Type /Page /Parent 2 0 R >> endobj
%%EOF`
	if err := os.WriteFile(path, []byte(body), 0644); err != nil {
		t.Fatalf("write pdf: %v", err)
	}
	if got := countPDFPages(path); got != 2 {
		t.Fatalf("page count got %d want 2", got)
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

func runNativeRequest(req Request) (Response, error) {
	oldStdin := os.Stdin
	oldStdout := os.Stdout

	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return Response{}, err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		stdinR.Close()
		stdinW.Close()
		return Response{}, err
	}

	payload, err := json.Marshal(req)
	if err != nil {
		return Response{}, err
	}
	var input bytes.Buffer
	if err := binary.Write(&input, binary.LittleEndian, uint32(len(payload))); err != nil {
		return Response{}, err
	}
	input.Write(payload)
	if _, err := stdinW.Write(input.Bytes()); err != nil {
		return Response{}, err
	}
	stdinW.Close()

	os.Stdin = stdinR
	os.Stdout = stdoutW
	runErr := run()
	stdoutW.Close()
	os.Stdin = oldStdin
	os.Stdout = oldStdout
	stdinR.Close()
	if runErr != nil {
		stdoutR.Close()
		return Response{}, runErr
	}
	defer stdoutR.Close()
	var size uint32
	if err := binary.Read(stdoutR, binary.LittleEndian, &size); err != nil {
		return Response{}, err
	}
	buf := make([]byte, size)
	if _, err := io.ReadFull(stdoutR, buf); err != nil {
		return Response{}, err
	}
	var resp Response
	if err := json.Unmarshal(buf, &resp); err != nil {
		return Response{}, err
	}
	return resp, nil
}
