package main

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const createNoWindow = 0x08000000

// maxDebugLogBytes bounds the size of optional debug/diagnostic logs such as
// ablesci_cleaner_debug.log. When a log grows past this,
// rotateLogIfTooLarge rolls it to a single ".old" generation and starts fresh,
// so disk use is bounded at ~2x this value.
const maxDebugLogBytes = 256 * 1024

type Request struct {
	Action     string            `json:"action"`
	Path       string            `json:"path"`
	ConfigPath string            `json:"config_path,omitempty"`
	MoveToDir  string            `json:"move_to_dir,omitempty"`
	Delete     bool              `json:"delete,omitempty"`
	Title      string            `json:"title,omitempty"`
	Message    string            `json:"message,omitempty"`
	Content    string            `json:"content,omitempty"`
	Filename   string            `json:"filename,omitempty"`
	Dir        string            `json:"dir,omitempty"`
	CSRFParam  string            `json:"csrf_param,omitempty"`
	CSRFToken  string            `json:"csrf_token,omitempty"`
	AssistID   string            `json:"assist_id,omitempty"`
	OSS        OSSFields         `json:"oss,omitempty"`
	Extra      map[string]string `json:"extra,omitempty"`
}

type OSSFields struct {
	Host      string `json:"host"`
	Key       string `json:"key"`
	Policy    string `json:"policy"`
	AccessID  string `json:"accessid"`
	Signature string `json:"signature"`
	Callback  string `json:"callback"`
	AssistID  string `json:"assist_id"`
	UserID    string `json:"user_id"`
	Filename  string `json:"filename"`
	Dir       string `json:"dir"`
	RandName  string `json:"randFilename"`
	RawKey    string `json:"raw_key"`
}

type Response struct {
	OK                 bool     `json:"ok"`
	Error              string   `json:"error,omitempty"`
	Action             string   `json:"action,omitempty"`
	Path               string   `json:"path,omitempty"`
	Filename           string   `json:"filename,omitempty"`
	Size               int64    `json:"size,omitempty"`
	PageCount          int      `json:"page_count,omitempty"`
	MD5                string   `json:"md5,omitempty"`
	IsPDF              bool     `json:"is_pdf,omitempty"`
	Status             int      `json:"status,omitempty"`
	Body               string   `json:"body,omitempty"`
	Deleted            bool     `json:"deleted,omitempty"`
	CleanStatus        string   `json:"clean_status,omitempty"`
	CleanOutput        string   `json:"clean_output,omitempty"`
	CleanErrorCode     string   `json:"clean_error_code,omitempty"`
	CleanMatched       int      `json:"clean_matched,omitempty"`
	CleanRules         []string `json:"clean_rules,omitempty"`
	CleanEngine        string   `json:"clean_engine,omitempty"`
	CleanElapsedMs     int64    `json:"clean_elapsed_ms,omitempty"`
	CleanPageCount     int      `json:"clean_page_count,omitempty"`
	CleanBackupPath    string   `json:"clean_backup_path,omitempty"`
	CleanBackupCreated bool     `json:"clean_backup_created,omitempty"`
	Text               string   `json:"text,omitempty"`
	TextSource         string   `json:"text_source,omitempty"`
	DocumentTitle      string   `json:"document_title,omitempty"`
}

func isTerminal() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}

func main() {
	if isTerminal() {
		fmt.Println("============================================================")
		fmt.Println(" Ablesci PDF Watcher - 本地助手")
		fmt.Println("============================================================")
		fmt.Println()
		fmt.Println("本程序由浏览器插件在后台自动运行，平时不需要手动双击打开。")
		fmt.Println()
		fmt.Println("【常见问题】")
		fmt.Println("问：旧版本开始菜单里的快捷方式可以删除吗？")
		fmt.Println("答：可以。当前版本提醒统一使用浏览器通知，不再需要 Helper 快捷方式。")
		fmt.Println("    删除历史快捷方式或文件夹不会影响插件的下载和上传功能。")
		fmt.Println()
		fmt.Println("【当前允许读取 / 上传 PDF 的目录】")
		for _, dir := range allowedPDFDirs() {
			fmt.Println(" - " + dir)
		}
		fmt.Println("如果自定义了浏览器下载目录，请重新运行 native-host\\install_host.ps1 刷新白名单。")
		fmt.Println()
		fmt.Println("请按回车键退出本程序...")
		var input string
		fmt.Scanln(&input)
		return
	}

	if err := run(); err != nil {
		writeResponse(Response{OK: false, Error: err.Error()})
		fmt.Fprintln(os.Stderr, "error:", err)
	}
}

func run() error {
	req, err := readRequest()
	if err != nil {
		return err
	}

	switch req.Action {
	case "ping":
		return writeResponse(Response{OK: true, Action: "pong"})
	case "stat_pdf":
		return handleStatPDF(req)
	case "extract_first_page_text":
		return handleExtractFirstPageText(req)
	case "clean_pdf":
		return handleCleanPDF(req)
	case "upload_oss":
		return handleUploadOSS(req)
	case "delete_file":
		return handleDeleteFile(req)
	case "copy_pdf":
		return handleCopyPDF(req)
	case "open_local_storage":
		return handleOpenLocalStorageDir(req)
	case "write_text_file":
		return handleWriteTextFile(req)
	case "append_text_file":
		return handleAppendTextFile(req)
	case "read_text_file":
		return handleReadTextFile(req)
	default:
		return fmt.Errorf("unknown action: %s", req.Action)
	}
}

func resolveCleanerPath(raw string) string {
	if raw != "" {
		p, _ := cleanCleanerExecutablePath(raw)
		return p
	}
	exePath, err := os.Executable()
	if err != nil {
		return ""
	}
	dir := filepath.Dir(exePath)
	for _, name := range []string{"zotero-pdf-toolbox.exe", "zotero-access-cleaner.exe"} {
		if p, err := cleanCleanerExecutablePath(filepath.Join(dir, name)); err == nil {
			return p
		}
	}
	return ""
}

func findPDFToText(cleanerPath string) string {
	candidates := []string{}
	if cleanerPath != "" {
		dir := filepath.Dir(cleanerPath)
		candidates = append(candidates,
			filepath.Join(dir, "tools", "poppler", "poppler-24.08.0", "Library", "bin", "pdftotext.exe"),
			filepath.Join(dir, "tools", "poppler", "Library", "bin", "pdftotext.exe"),
			filepath.Join(dir, "poppler", "Library", "bin", "pdftotext.exe"),
			filepath.Join(dir, "poppler", "bin", "pdftotext.exe"),
			filepath.Join(dir, "pdftotext.exe"),
		)
	}
	for _, candidate := range candidates {
		if fileExists(candidate) {
			return candidate
		}
	}
	if path, err := exec.LookPath("pdftotext"); err == nil {
		return path
	}
	return ""
}

func extractPDFInfoTitle(pdfToTextPath, pdfPath string) string {
	tool := filepath.Join(filepath.Dir(pdfToTextPath), "pdfinfo.exe")
	if !fileExists(tool) {
		if path, err := exec.LookPath("pdfinfo"); err == nil {
			tool = path
		} else {
			return ""
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, tool, "-enc", "UTF-8", pdfPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow}
	stdout := &cappedBuffer{max: 16 * 1024}
	cmd.Stdout = stdout
	if err := cmd.Run(); err != nil {
		return ""
	}
	for _, line := range strings.Split(stdout.String(), "\n") {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(line)), "title:") {
			return strings.TrimSpace(strings.SplitN(line, ":", 2)[1])
		}
	}
	return ""
}

type cappedBuffer struct {
	buf bytes.Buffer
	max int
}

func (w *cappedBuffer) Write(p []byte) (int, error) {
	originalLen := len(p)
	remaining := w.max - w.buf.Len()
	if remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		_, _ = w.buf.Write(p)
	}
	return originalLen, nil
}

func (w *cappedBuffer) String() string { return w.buf.String() }

func handleExtractFirstPageText(req Request) error {
	path, err := cleanExistingPath(req.Path)
	if err != nil {
		return err
	}
	if err := ensureAllowedPDFPath(path); err != nil {
		return err
	}
	if _, _, err := inspectPDF(path); err != nil {
		return err
	}
	tool := findPDFToText(resolveCleanerPath(req.Extra["cleaner_path"]))
	if tool == "" {
		return errors.New("pdftotext not found")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, tool, "-f", "1", "-l", "1", "-layout", "-enc", "UTF-8", path, "-")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow}
	stdout := &cappedBuffer{max: 64 * 1024}
	stderr := &cappedBuffer{max: 8 * 1024}
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	if err := cmd.Run(); err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return errors.New("pdftotext timeout")
		}
		return fmt.Errorf("pdftotext failed: %s", strings.TrimSpace(stderr.String()))
	}
	text := strings.TrimSpace(stdout.String())
	documentTitle := extractPDFInfoTitle(tool, path)
	return writeResponse(Response{OK: true, Action: "extract_first_page_text", Text: text, TextSource: "pdftotext_first_page", DocumentTitle: documentTitle})
}

func readRequest() (Request, error) {
	var n uint32
	if err := binary.Read(os.Stdin, binary.LittleEndian, &n); err != nil {
		return Request{}, fmt.Errorf("read native message length failed: %w", err)
	}
	if n == 0 || n > 64*1024*1024 {
		return Request{}, fmt.Errorf("invalid native message length: %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(os.Stdin, buf); err != nil {
		return Request{}, fmt.Errorf("read native message failed: %w", err)
	}
	var req Request
	if err := json.Unmarshal(buf, &req); err != nil {
		return Request{}, fmt.Errorf("decode native message failed: %w", err)
	}
	return req, nil
}

func writeResponse(resp Response) error {
	payload, err := json.Marshal(resp)
	if err != nil {
		return err
	}
	if len(payload) > 1024*1024 {
		payload = []byte(`{"ok":false,"error":"native response too large"}`)
	}
	var lenBuf [4]byte
	binary.LittleEndian.PutUint32(lenBuf[:], uint32(len(payload)))
	if _, err := os.Stdout.Write(lenBuf[:]); err != nil {
		return err
	}
	_, err = os.Stdout.Write(payload)
	return err
}

func handleStatPDF(req Request) error {
	path, err := cleanExistingPath(req.Path)
	if err != nil {
		return err
	}
	if err := ensureAllowedPDFPath(path); err != nil {
		return err
	}
	info, md5sum, err := inspectPDF(path)
	if err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Ext(path), ".pdf") {
		path, err = addPDFExtension(path)
		if err != nil {
			return err
		}
		info, err = os.Stat(path)
		if err != nil {
			return err
		}
	}

	cleanerPath := req.Extra["cleaner_path"]
	if cleanerPath == "" {
		if exePath, err := os.Executable(); err == nil {
			dir := filepath.Dir(exePath)
			if p, err := cleanCleanerExecutablePath(filepath.Join(dir, "zotero-pdf-toolbox.exe")); err == nil {
				cleanerPath = p
			} else if p, err := cleanCleanerExecutablePath(filepath.Join(dir, "zotero-access-cleaner.exe")); err == nil {
				cleanerPath = p
			}
		}
	} else {
		cleanerPath, _ = cleanCleanerExecutablePath(cleanerPath)
	}

	pageCount := 0
	if cleanerPath != "" {
		pageCount = countPagesWithToolbox(cleanerPath, path)
	}
	if pageCount == 0 {
		pageCount = countPDFPages(path)
	}

	return writeResponse(Response{
		OK: true, Action: "stat_pdf", Path: path, Filename: info.Name(), Size: info.Size(), PageCount: pageCount, MD5: md5sum, IsPDF: true,
	})
}

func isPDFPath(path string) bool {
	return strings.EqualFold(filepath.Ext(path), ".pdf")
}

func handleDeleteFile(req Request) error {
	path, err := cleanExistingPath(req.Path)
	if err != nil {
		return err
	}

	if !isPDFPath(path) {
		return errors.New("refuse to delete non-pdf file")
	}
	if err := ensureAllowedPDFPath(path); err != nil {
		return err
	}

	if _, _, err := inspectPDF(path); err != nil {
		return fmt.Errorf("refuse to delete file that is not a valid PDF: %w", err)
	}

	if err := os.Remove(path); err != nil {
		return err
	}

	return writeResponse(Response{OK: true, Action: "delete_file", Path: path, Deleted: true})
}

func handleCopyPDF(req Request) error {
	// 调试日志：确认是否被拉起复制文件
	if isCleanerDebugEnabled(req) {
		debugLogPath := filepath.Join(os.TempDir(), "ablesci_cleaner_debug.log")
		rotateLogIfTooLarge(debugLogPath, maxDebugLogBytes)
		copyLog := fmt.Sprintf("CopyPDF Called: Path=%s Suffix=%s MoveToDir=%s Filename=%s\n", req.Path, req.Extra["suffix"], req.MoveToDir, req.Filename)
		f, _ := os.OpenFile(debugLogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if f != nil {
			_, _ = f.WriteString(copyLog)
			f.Close()
		}
	}

	path, err := cleanExistingPath(req.Path)
	if err != nil {
		return err
	}
	if err := ensureAllowedPDFPath(path); err != nil {
		return err
	}
	info, _, err := inspectPDF(path)
	if err != nil {
		return fmt.Errorf("refuse to copy file that is not a valid PDF: %w", err)
	}

	suffix := strings.TrimSpace(req.Extra["suffix"])
	if suffix == "" {
		suffix = ".original.pdf"
	}
	if !isSafeCopyPDFSuffix(suffix) {
		return fmt.Errorf("invalid copy_pdf suffix: %s", suffix)
	}

	ext := filepath.Ext(path)
	sourceBaseName := filepath.Base(path)
	if req.Filename != "" {
		sourceBaseName = filepath.Base(req.Filename)
	}
	sourceBaseName = strings.TrimSuffix(sourceBaseName, filepath.Ext(sourceBaseName))
	if sourceBaseName == "" || sourceBaseName == "." || sourceBaseName == string(filepath.Separator) {
		sourceBaseName = strings.TrimSuffix(filepath.Base(path), ext)
	}
	targetDir := filepath.Dir(path)
	if strings.TrimSpace(req.MoveToDir) != "" {
		resolvedDir, dirErr := filepath.Abs(filepath.Clean(req.MoveToDir))
		if dirErr != nil {
			return dirErr
		}
		dirInfo, statErr := os.Stat(resolvedDir)
		if statErr != nil {
			return statErr
		}
		if !dirInfo.IsDir() {
			return fmt.Errorf("copy_pdf target is not a directory: %s", resolvedDir)
		}
		targetDir = resolvedDir
	}
	base := filepath.Join(targetDir, sourceBaseName)
	if base == "" {
		base = strings.TrimSuffix(path, ext)
	}
	target := uniquePath(base + suffix)
	src, err := os.Open(path)
	if err != nil {
		return err
	}
	defer src.Close()
	dst, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err != nil {
		return err
	}
	copied, copyErr := io.Copy(dst, src)
	closeErr := dst.Close()
	if copyErr != nil {
		_ = os.Remove(target)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(target)
		return closeErr
	}
	if copied != info.Size() {
		_ = os.Remove(target)
		return fmt.Errorf("copy size mismatch: expected %d, copied %d", info.Size(), copied)
	}
	if _, _, err := inspectPDF(target); err != nil {
		_ = os.Remove(target)
		return fmt.Errorf("copied file is not a valid PDF: %w", err)
	}
	return writeResponse(Response{OK: true, Action: "copy_pdf", Path: target, Filename: filepath.Base(target), Size: copied})
}

func isSafeCopyPDFSuffix(suffix string) bool {
	if !strings.HasPrefix(suffix, ".") || !strings.HasSuffix(strings.ToLower(suffix), ".pdf") {
		return false
	}
	if strings.ContainsAny(suffix, `/\:`) {
		return false
	}
	if strings.Contains(suffix, "..") {
		return false
	}
	for _, r := range suffix {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '.' || r == '_' || r == '-' {
			continue
		}
		return false
	}
	return true
}

func handleOpenLocalStorageDir(req Request) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	targetDir := filepath.Dir(exe)
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		if err := exec.Command("explorer.exe", targetDir).Start(); err != nil {
			return err
		}
	}
	return writeResponse(Response{OK: true, Action: "open_local_storage", Path: targetDir})
}

func handleReadTextFile(req Request) error {
	p := strings.Trim(req.Path, "\" ")
	var resolved string
	helperDir, err := nativeHelperDir()
	if err != nil {
		return err
	}
	if p == "" {
		resolved = filepath.Clean(filepath.Join(helperDir, "blacklist.txt"))
	} else {
		abs, err := filepath.Abs(p)
		if err != nil {
			return err
		}
		resolved = filepath.Clean(abs)
	}

	// 仅允许读取 .txt 文件以防任意读取敏感系统文件
	if !strings.HasSuffix(strings.ToLower(resolved), ".txt") {
		return errors.New("refuse to read non-txt file")
	}
	if p != "" && !isAllowedTextReadPath(resolved, helperDir, req.Extra["allowed_path"]) {
		return errors.New("text file path is outside allowed helper/configured path")
	}

	// Auto-create only the Helper's own default blacklist file (empty request
	// path → helperDir/blacklist.txt). For an explicit, caller-supplied path we do
	// NOT create the file — auto-creating at an arbitrary path is effectively a
	// fixed-content write to any location, so it must already exist.
	if _, statErr := os.Stat(resolved); os.IsNotExist(statErr) {
		if p != "" {
			return fmt.Errorf("text file does not exist: %s", filepath.Base(resolved))
		}
		if err := os.MkdirAll(filepath.Dir(resolved), 0755); err != nil {
			return err
		}
		template := `# 求助人 ID 黑名单：每行一个用户 ID，可在 ID 后用 # 或 // 添加备注。
# 示例（去掉行首 # 即生效）：
# AAAAAAA  不再应助此人
`
		if err := os.WriteFile(resolved, []byte(template), 0644); err != nil {
			return err
		}
	}

	content, err := os.ReadFile(resolved)
	if err != nil {
		return err
	}
	return writeResponse(Response{
		OK:     true,
		Action: "read_text_file",
		Path:   resolved,
		Body:   string(content),
	})
}

func nativeHelperDir() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Clean(filepath.Dir(exe)), nil
}

func isAllowedTextReadPath(path string, helperDir string, allowedPath string) bool {
	if isPathInsideDir(path, helperDir) {
		return true
	}
	allowed := strings.Trim(allowedPath, "\" ")
	if allowed == "" {
		return false
	}
	abs, err := filepath.Abs(allowed)
	if err != nil {
		return false
	}
	return sameFilePath(filepath.Clean(path), filepath.Clean(abs))
}

// allowedTextDirs returns directories the Helper itself trusts for report/text
// files, independent of any request-supplied path: the Helper install dir plus
// the PDF dirs (Downloads tree, OS temp, and the install-marker download dir).
func allowedTextDirs() []string {
	dirs := []string{}
	if helperDir, err := nativeHelperDir(); err == nil && helperDir != "" {
		dirs = append(dirs, helperDir)
	}
	dirs = append(dirs, allowedPDFDirs()...)
	seen := map[string]bool{}
	out := []string{}
	for _, dir := range dirs {
		cleaned := cleanOptionalDir(dir)
		if cleaned == "" || seen[strings.ToLower(cleaned)] {
			continue
		}
		seen[strings.ToLower(cleaned)] = true
		out = append(out, cleaned)
	}
	return out
}

func isInsideAllowedTextDir(path string) bool {
	for _, dir := range allowedTextDirs() {
		if isPathInsideDir(path, dir) {
			return true
		}
	}
	return false
}

// sensitiveSystemDirs lists locations where dropping a text file is a
// persistence/landing risk (autostart) or a protected system area. Used to deny
// custom report dirs pointing at these even though they are absolute paths.
func sensitiveSystemDirs() []string {
	if runtime.GOOS != "windows" {
		return nil
	}
	dirs := []string{}
	add := func(p string) {
		if strings.TrimSpace(p) != "" {
			dirs = append(dirs, filepath.Clean(p))
		}
	}
	if v := os.Getenv("SystemRoot"); v != "" {
		add(v)
	} else {
		add(os.Getenv("windir"))
	}
	add(os.Getenv("ProgramFiles"))
	add(os.Getenv("ProgramFiles(x86)"))
	add(os.Getenv("ProgramData"))
	if v := os.Getenv("AppData"); v != "" {
		add(filepath.Join(v, `Microsoft\Windows\Start Menu\Programs\Startup`))
	}
	return dirs
}

func isSensitiveSystemDir(path string) bool {
	for _, dir := range sensitiveSystemDirs() {
		if isPathInsideDir(path, dir) {
			return true
		}
	}
	return false
}

// ensureAllowedTextWriteDir applies defense-in-depth to report/text writes:
// Helper-known dirs are always allowed; any other absolute dir is also allowed
// (users may configure a custom report dir) EXCEPT sensitive system locations
// such as the autostart folder or Windows/Program Files, which are refused.
func ensureAllowedTextWriteDir(dir string) error {
	if isInsideAllowedTextDir(dir) {
		return nil
	}
	if isSensitiveSystemDir(dir) {
		return errors.New("refuse to write text file into a sensitive system directory")
	}
	return nil
}

func handleWriteTextFile(req Request) error {
	filename := sanitizeReportFilename(req.Filename)
	if filename == "" {
		return errors.New("missing report filename")
	}
	dir, err := reportDir(req.Dir)
	if err != nil {
		return err
	}
	if err := ensureAllowedTextWriteDir(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	path := filepath.Join(dir, filename)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(req.Content), 0644); err != nil {
		return err
	}
	return writeResponse(Response{OK: true, Action: "write_text_file", Path: path, Filename: filename, Size: int64(len(req.Content))})
}

func handleAppendTextFile(req Request) error {
	filename := sanitizeReportFilename(req.Filename)
	if filename == "" {
		return errors.New("missing report filename")
	}
	dir, err := reportDir(req.Dir)
	if err != nil {
		return err
	}
	if err := ensureAllowedTextWriteDir(dir); err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	path := filepath.Join(dir, filename)
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
	if err != nil {
		return err
	}
	defer file.Close()
	n, err := file.WriteString(req.Content)
	if err != nil {
		return err
	}
	return writeResponse(Response{OK: true, Action: "append_text_file", Path: path, Filename: filename, Size: int64(n)})
}

func handleUploadOSS(req Request) error {
	path, err := cleanExistingPath(req.Path)
	if err != nil {
		return err
	}
	if err := ensureAllowedPDFPath(path); err != nil {
		return err
	}
	info, _, err := inspectPDF(path)
	if err != nil {
		return err
	}
	oss := req.OSS
	if oss.Host == "" {
		return errors.New("missing oss.host")
	}
	if err := validateOSSHost(oss.Host); err != nil {
		return err
	}

	key := oss.Key
	if key == "" && (oss.Dir != "" || oss.RandName != "") {
		key = oss.Dir + oss.RandName
	}
	if key == "" {
		return errors.New("missing oss key")
	}
	filename := oss.Filename
	if filename == "" {
		filename = info.Name()
	}
	assistID := firstNonEmpty(oss.AssistID, req.AssistID)

	pr, pw := io.Pipe()
	writer := multipart.NewWriter(pw)
	go func() {
		err := writeMultipartUpload(writer, path, filename, req, oss, key, assistID)
		if closeErr := writer.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			_ = pw.CloseWithError(err)
			return
		}
		_ = pw.Close()
	}()

	client := &http.Client{
		Timeout: 180 * time.Second,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if err := validateOSSHost(req.URL.String()); err != nil {
				return errors.New("上传存储重定向地址不在允许范围，请更新插件或检查上传链路")
			}
			return nil
		},
	}
	httpReq, err := http.NewRequest("POST", oss.Host, pr)
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", writer.FormDataContentType())
	httpReq.Header.Set("User-Agent", "AblesciPdfUploaderNativeHelper/0.10")

	resp, err := client.Do(httpReq)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return writeResponse(Response{OK: false, Action: "upload_oss", Status: resp.StatusCode, Body: string(respBody), Error: fmt.Sprintf("oss upload failed: http %d", resp.StatusCode)})
	}
	deleted := false
	if req.Delete {
		if !isPDFPath(path) {
			return errors.New("refuse to delete non-pdf file after upload")
		}

		if _, _, err := inspectPDF(path); err != nil {
			return fmt.Errorf("refuse to delete file that is not a valid PDF after upload: %w", err)
		}

		if err := os.Remove(path); err != nil {
			return err
		}
		deleted = true
	}
	return writeResponse(Response{OK: true, Action: "upload_oss", Status: resp.StatusCode, Body: string(respBody), Path: path, Filename: filename, Size: info.Size(), Deleted: deleted})
}

func writeMultipartUpload(w *multipart.Writer, path, filename string, req Request, oss OSSFields, key, assistID string) error {
	if err := addFormField(w, req.CSRFParam, req.CSRFToken); err != nil {
		return err
	}
	fields := [][2]string{
		{"assist_id", assistID},
		{"key", key},
		{"policy", oss.Policy},
		{"OSSAccessKeyId", oss.AccessID},
		{"success_action_status", "200"},
		{"callback", oss.Callback},
		{"signature", oss.Signature},
		{"x:filename", filename},
		{"x:assist_id", assistID},
		{"x:user_id", oss.UserID},
	}
	for _, field := range fields {
		if err := addFormField(w, field[0], field[1]); err != nil {
			return err
		}
	}
	for k, v := range req.Extra {
		if err := addFormField(w, k, v); err != nil {
			return err
		}
	}

	fw, err := w.CreateFormFile("file", filename)
	if err != nil {
		return err
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(fw, file)
	return err
}

func cleanExistingPath(p string) (string, error) {
	if p == "" {
		return "", errors.New("missing path")
	}
	p = strings.Trim(p, "\" ")
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)
	resolved, err := resolveExistingPath(abs)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(resolved)
	if err != nil {
		return "", err
	}
	if st.IsDir() {
		return "", errors.New("path is a directory")
	}
	return resolved, nil
}

func ensureAllowedPDFPath(path string) error {
	allowed := allowedPDFDirs()
	for _, dir := range allowed {
		if isPathInsideDir(path, dir) {
			return nil
		}
	}
	return errors.New("pdf path is outside allowed download/temp directories")
}

func allowedPDFDirs() []string {
	dirs := []string{}
	if home, err := os.UserHomeDir(); err == nil && home != "" {
		dirs = append(dirs, filepath.Join(home, "Downloads"))
	}
	if temp := os.TempDir(); temp != "" {
		dirs = append(dirs, temp)
	}
	// The browser may be configured with custom download directories per profile.
	// The installer records them in the marker so uploads from those dirs are not
	// rejected. Falls back to Downloads/temp when no marker dir is set.
	dirs = append(dirs, markerDownloadDirs()...)
	seen := map[string]bool{}
	out := []string{}
	for _, dir := range dirs {
		cleaned := cleanOptionalDir(dir)
		if cleaned == "" || seen[strings.ToLower(cleaned)] {
			continue
		}
		seen[strings.ToLower(cleaned)] = true
		out = append(out, cleaned)
	}
	return out
}

// installMarkerFileName must match $MarkerFileName in native-host/install_host.ps1.
const installMarkerFileName = ".ablesci_pdf_watcher.install.json"

type installMarkerProfile struct {
	Browser     string `json:"browser"`
	ProfileDir  string `json:"profile_dir"`
	DownloadDir string `json:"download_dir"`
	UpdatedAt   string `json:"updated_at"`
}

// markerDownloadDirs reads download directories recorded by the installer in the
// Helper's install marker (next to the exe). It supports the legacy top-level
// download_dir plus the profile-scoped profiles[].download_dir list.
func markerDownloadDirs() []string {
	helperDir, err := nativeHelperDir()
	if err != nil {
		return nil
	}
	data, err := os.ReadFile(filepath.Join(helperDir, installMarkerFileName))
	if err != nil {
		return nil
	}
	return markerDownloadDirsFromBytes(data)
}

func markerDownloadDirsFromBytes(data []byte) []string {
	var marker struct {
		DownloadDir string                 `json:"download_dir"`
		Profiles    []installMarkerProfile `json:"profiles"`
	}
	if err := json.Unmarshal(data, &marker); err != nil {
		return nil
	}
	dirs := []string{}
	if dir := cleanOptionalDir(marker.DownloadDir); dir != "" {
		dirs = append(dirs, dir)
	}
	for _, profile := range marker.Profiles {
		if dir := cleanOptionalDir(profile.DownloadDir); dir != "" {
			dirs = append(dirs, dir)
		}
	}
	return dirs
}

func cleanOptionalDir(dir string) string {
	dir = strings.Trim(dir, "\" ")
	if dir == "" {
		return ""
	}
	if runtime.GOOS == "windows" {
		dir = strings.ReplaceAll(dir, "/", `\`)
	}
	if !filepath.IsAbs(dir) {
		return ""
	}
	cleaned := filepath.Clean(dir)
	if resolved, err := filepath.EvalSymlinks(cleaned); err == nil {
		return filepath.Clean(resolved)
	}
	if _, err := os.Stat(cleaned); err == nil {
		return cleaned
	}
	return cleaned
}

func isPathInsideDir(path string, dir string) bool {
	path = filepath.Clean(path)
	dir = filepath.Clean(dir)
	rel, err := filepath.Rel(dir, path)
	if err != nil {
		return false
	}
	if rel == "." {
		return true
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return false
	}
	if runtime.GOOS == "windows" {
		return !strings.HasPrefix(rel, `..\`)
	}
	return true
}

func resolveExistingPath(p string) (string, error) {
	resolved, err := filepath.EvalSymlinks(p)
	if err == nil {
		return filepath.Clean(resolved), nil
	}
	if _, statErr := os.Stat(p); statErr != nil {
		return "", err
	}
	return filepath.Clean(p), nil
}

func inspectPDF(path string) (os.FileInfo, string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, "", err
	}
	if info.Size() <= 0 {
		return nil, "", errors.New("empty pdf file")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, "", err
	}
	defer f.Close()

	head := make([]byte, 5)
	if _, err := io.ReadFull(f, head); err != nil {
		return nil, "", err
	}
	if string(head) != "%PDF-" {
		return nil, "", errors.New("file header is not %PDF-; likely html/login/error page")
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, "", err
	}
	h := md5.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, "", err
	}
	return info, hex.EncodeToString(h.Sum(nil)), nil
}

func countPDFPages(path string) int {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return 0
	}
	re := regexp.MustCompile(`/Type\s*/Page\b`)
	return len(re.FindAll(data, -1))
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}

func countPagesWithToolbox(cleanerPath, pdfPath string) int {
	tmpFile, err := os.CreateTemp("", "cleaner_summary_*.json")
	if err != nil {
		return 0
	}
	summaryPath := tmpFile.Name()
	tmpFile.Close()
	defer os.Remove(summaryPath)

	args := buildPageCountArgs(cleanerPath, pdfPath, summaryPath)

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, cleanerPath, args...)
	cmd.Env = envWithCleanerToolDirs(cleanerPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow,
	}

	_ = cmd.Run()

	summaryData, err := os.ReadFile(summaryPath)
	if err != nil {
		return 0
	}

	type Summary struct {
		PageCount int `json:"page_count"`
	}
	var summary Summary
	if err := json.Unmarshal(summaryData, &summary); err == nil {
		return summary.PageCount
	}
	return 0
}

func buildPageCountArgs(cleanerPath, pdfPath, summaryPath string) []string {
	base := filepath.Base(cleanerPath)
	if strings.EqualFold(base, "zotero-pdf-toolbox.exe") {
		return []string{
			"clean-access",
			"--input", pdfPath,
			"--dry-run",
			"--summary-json", summaryPath,
			"--timeout-seconds", "10",
		}
	}
	// Legacy zotero-access-cleaner.exe: default is dry-run (apply=false) if we don't pass "-apply".
	return []string{
		"-input", pdfPath,
		"-summary-json", summaryPath,
		"-timeout-seconds", "10",
	}
}

func addPDFExtension(src string) (string, error) {
	ext := filepath.Ext(src)
	base := strings.TrimSuffix(src, ext)
	if base == "" {
		base = src
	}
	dst := uniquePath(base + ".pdf")
	if sameFilePath(src, dst) {
		return src, nil
	}
	if err := os.Rename(src, dst); err != nil {
		return "", err
	}
	return dst, nil
}

func reportDir(dir string) (string, error) {
	dir = strings.Trim(dir, "\" ")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(home, "Downloads", "ablesci-watcher-reports")
	}
	if runtime.GOOS == "windows" {
		dir = strings.ReplaceAll(dir, "/", `\`)
	}
	if !filepath.IsAbs(dir) {
		return "", errors.New("report dir must be an absolute path")
	}
	return filepath.Clean(dir), nil
}

func sanitizeReportFilename(name string) string {
	name = strings.TrimSpace(name)
	name = strings.ReplaceAll(name, "\x00", "")
	if runtime.GOOS == "windows" {
		name = strings.ReplaceAll(name, "/", `\`)
	}
	name = filepath.Clean(name)
	if name == "." || filepath.IsAbs(name) {
		return ""
	}
	parts := strings.Split(name, string(os.PathSeparator))
	if len(parts) > 2 {
		return ""
	}
	for i, part := range parts {
		if part == "" || part == "." || part == ".." {
			return ""
		}
		if i == 0 && len(parts) == 2 && !safeReportDirName(part) {
			return ""
		}
	}
	ext := strings.ToLower(filepath.Ext(parts[len(parts)-1]))
	if ext != ".csv" && ext != ".md" && ext != ".txt" && ext != ".json" && ext != ".jsonl" {
		return ""
	}
	if parts[len(parts)-1] == ext {
		return ""
	}
	return name
}

func safeReportDirName(name string) bool {
	if name == "" || len(name) > 32 {
		return false
	}
	for _, r := range name {
		if (r >= '0' && r <= '9') || (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || r == '-' || r == '_' {
			continue
		}
		return false
	}
	return true
}

func limitText(value string, max int) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "\x00", ""))
	runes := []rune(value)
	if len(runes) <= max {
		return value
	}
	return string(runes[:max])
}

func uniquePath(p string) string {
	if _, err := os.Stat(p); os.IsNotExist(err) {
		return p
	}
	ext := filepath.Ext(p)
	stem := strings.TrimSuffix(p, ext)
	for i := 1; i < 1000; i++ {
		candidate := fmt.Sprintf("%s (%d)%s", stem, i, ext)
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
	return fmt.Sprintf("%s-%d%s", stem, time.Now().UnixNano(), ext)
}

func sameFilePath(a, b string) bool {
	aa, _ := filepath.Abs(a)
	bb, _ := filepath.Abs(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(aa, bb)
	}
	return aa == bb
}

func validateOSSHost(host string) error {
	u, err := url.Parse(host)
	if err != nil {
		return err
	}
	if u.Scheme != "https" {
		return errors.New("上传存储地址必须使用 HTTPS")
	}
	if u.User != nil {
		return errors.New("上传存储地址不能包含账号信息")
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return errors.New("上传存储地址不能包含查询参数或片段")
	}
	if isLocalOrPrivateHost(u.Hostname()) {
		return errors.New("上传存储地址不能是本机或内网地址")
	}
	if !isAllowedAliyunOSSEndpoint(u.Hostname()) {
		return errors.New("上传存储地址不是允许的阿里云 OSS 公网地址，请检查上传链路")
	}
	return nil
}

func isAllowedAliyunOSSEndpoint(host string) bool {
	h := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if h == "" || strings.Contains(h, "_") {
		return false
	}
	if strings.Contains(h, ".oss-internal.") ||
		strings.Contains(h, "-internal.aliyuncs.com") ||
		strings.Contains(h, ".vpc100-oss-") {
		return false
	}
	labels := strings.Split(h, ".")
	if len(labels) < 4 {
		return false
	}
	if labels[len(labels)-2] != "aliyuncs" || labels[len(labels)-1] != "com" {
		return false
	}
	endpoint := labels[len(labels)-3]
	if endpoint == "oss" {
		return true
	}
	return strings.HasPrefix(endpoint, "oss-") && !strings.Contains(endpoint, "internal")
}

func isLocalOrPrivateHost(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "localhost" || h == "" {
		return true
	}
	ip := net.ParseIP(h)
	if ip == nil {
		return false
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified()
}

func addFormField(w *multipart.Writer, k, v string) error {
	if k == "" || v == "" {
		return nil
	}
	return w.WriteField(k, v)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func handleCleanPDF(req Request) error {
	path, err := cleanExistingPath(req.Path)
	if err != nil {
		return err
	}
	if err := ensureAllowedPDFPath(path); err != nil {
		return err
	}

	// 1. Resolve cleaner path
	cleanerPath := req.Extra["cleaner_path"]
	if cleanerPath == "" {
		exePath, err := os.Executable()
		if err != nil {
			return err
		}
		dir := filepath.Dir(exePath)
		toolboxPath := filepath.Join(dir, "zotero-pdf-toolbox.exe")
		if fileExists(toolboxPath) {
			cleanerPath = toolboxPath
		} else {
			cleanerPath = filepath.Join(dir, "zotero-access-cleaner.exe")
		}
	}
	cleanerPath, err = cleanCleanerExecutablePath(cleanerPath)
	if err != nil {
		return err
	}

	// 2. Create temp file for summary JSON
	tmpFile, err := os.CreateTemp("", "cleaner_summary_*.json")
	if err != nil {
		return fmt.Errorf("failed to create temporary summary file: %w", err)
	}
	summaryPath := tmpFile.Name()
	tmpFile.Close()
	defer os.Remove(summaryPath)

	preserveOriginal := req.Extra["preserve_original"] == "true"
	timeoutSeconds := 60
	if timeoutStr := req.Extra["timeout_seconds"]; timeoutStr != "" {
		if val, err := strconv.Atoi(timeoutStr); err == nil && val > 0 {
			timeoutSeconds = val
		}
	}
	args := buildCleanerArgs(cleanerPath, path, summaryPath, req.Extra, preserveOriginal, timeoutSeconds)

	// 临时调试日志：收集运行前的文件状态与请求载荷
	reqJSON, _ := json.MarshalIndent(req, "", "  ")
	filesBefore := listPrefixFiles(path)

	// 4. Set process timeout
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds+5)*time.Second)
	defer cancel()

	// 5. Execute process
	cmd := exec.CommandContext(ctx, cleanerPath, args...)
	cmd.Env = envWithCleanerToolDirs(cleanerPath)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow,
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()

	// 收集运行后的文件状态
	filesAfter := listPrefixFiles(path)

	// 6. Check summary JSON
	summaryData, readErr := os.ReadFile(summaryPath)
	summaryLog := ""
	if readErr == nil {
		summaryLog = string(summaryData)
		if isCleanerDebugEnabled(req) || runErr != nil {
			_ = os.WriteFile(filepath.Join(os.TempDir(), "ablesci_cleaner_summary.json"), summaryData, 0644)
		}
	} else {
		summaryLog = fmt.Sprintf("(Error reading summary file: %v)", readErr)
	}

	// 将详尽的调试日志追加写入临时文件，便于极其细致地排查
	if isCleanerDebugEnabled(req) || runErr != nil || readErr != nil {
		debugLog := fmt.Sprintf("\n--- [NEW TEST] %s ---\n"+
			"Request Payload:\n%s\n\n"+
			"Executable:\n%s\n\n"+
			"Args:\n%v\n\n"+
			"Files BEFORE clean:\n%s\n\n"+
			"Process Run Error:\n%v\n\n"+
			"Process Stdout:\n%s\n\n"+
			"Process Stderr:\n%s\n\n"+
			"Files AFTER clean:\n%s\n\n"+
			"Summary Content:\n%s\n",
			time.Now().Format("2006-01-02 15:04:05"),
			string(reqJSON),
			cleanerPath,
			args,
			filesBefore,
			runErr,
			stdout.String(),
			stderr.String(),
			filesAfter,
			summaryLog,
		)
		debugLogPath := filepath.Join(os.TempDir(), "ablesci_cleaner_debug.log")
		rotateLogIfTooLarge(debugLogPath, maxDebugLogBytes)
		f, _ := os.OpenFile(debugLogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
		if f != nil {
			_, _ = f.WriteString(debugLog)
			f.Close()
		}
	}

	if readErr == nil {
		// Parse summary
		type Summary struct {
			SchemaVersion int      `json:"schema_version"`
			Status        string   `json:"status"`
			Source        string   `json:"source"`
			Output        string   `json:"output"`
			Engine        string   `json:"engine"`
			EngineVersion string   `json:"engine_version"`
			RulesVersion  string   `json:"rules_version"`
			Matched       int      `json:"matched"`
			PageCount     int      `json:"page_count"`
			RemovedCalls  int      `json:"removed_calls"`
			Rules         []string `json:"rules"`
			ElapsedMs     int64    `json:"elapsed_ms"`
			ErrorCode     string   `json:"error_code"`
			Error         string   `json:"error"`
			BackupPath    string   `json:"backup_path"`
			BackupCreated bool     `json:"backup_created"`
		}
		var summary Summary
		if json.Unmarshal(summaryData, &summary) == nil {
			resultPath := path
			if summary.Status == "cleaned" && strings.TrimSpace(summary.Output) != "" {
				if resolvedOutput, outputErr := cleanExistingPath(summary.Output); outputErr == nil {
					if allowedErr := ensureAllowedPDFPath(resolvedOutput); allowedErr == nil {
						resultPath = resolvedOutput
					}
				}
			}
			return writeResponse(Response{
				OK:                 true,
				Action:             "clean_pdf",
				Path:               resultPath,
				CleanStatus:        summary.Status,
				CleanOutput:        summary.Output,
				CleanErrorCode:     summary.ErrorCode,
				CleanMatched:       summary.Matched,
				CleanRules:         summary.Rules,
				CleanEngine:        summary.Engine,
				CleanElapsedMs:     summary.ElapsedMs,
				CleanPageCount:     summary.PageCount,
				CleanBackupPath:    summary.BackupPath,
				CleanBackupCreated: summary.BackupCreated,
				Error:              summary.Error,
			})
		}
	}

	// If reading/parsing summary failed, handle error or timeout
	status := "error"
	var errMsg string
	if ctx.Err() == context.DeadlineExceeded {
		status = "timeout"
		errMsg = "去水印进程运行超时"
	} else {
		if runErr != nil {
			errMsg = fmt.Sprintf("去水印子进程执行错误: %v, stderr: %s", runErr, stderr.String())
		} else {
			errMsg = "去水印执行未生成摘要数据"
		}
	}

	return writeResponse(Response{
		OK:          true,
		Action:      "clean_pdf",
		Path:        path,
		CleanStatus: status,
		CleanErrorCode: func() string {
			if status == "timeout" {
				return "engine_timeout"
			}
			return "engine_failed"
		}(),
		Error: errMsg,
	})
}

func envWithCleanerToolDirs(cleanerPath string) []string {
	env := os.Environ()
	cleanerDir := filepath.Dir(cleanerPath)
	if cleanerDir == "." || cleanerDir == "" {
		return env
	}

	extraDirs := []string{
		cleanerDir,
		filepath.Join(cleanerDir, "bin"),
		filepath.Join(cleanerDir, "qpdf"),
		filepath.Join(cleanerDir, "qpdf", "bin"),
		filepath.Join(cleanerDir, "tools", "poppler", "poppler-24.08.0", "Library", "bin"),
		filepath.Join(cleanerDir, "tools", "mupdf", "mupdf-1.24.0-windows"),
	}
	pathValue := strings.Join(extraDirs, string(os.PathListSeparator))
	pathKey := "PATH"
	found := false
	for i, item := range env {
		key, value, ok := strings.Cut(item, "=")
		if ok && strings.EqualFold(key, pathKey) {
			env[i] = key + "=" + pathValue + string(os.PathListSeparator) + value
			found = true
			break
		}
	}
	if !found {
		env = append(env, pathKey+"="+pathValue)
	}
	return env
}

func cleanCleanerExecutablePath(p string) (string, error) {
	p = strings.Trim(p, "\" ")
	if p == "" {
		return "", errors.New("missing cleaner path")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return "", err
	}
	abs = filepath.Clean(abs)
	resolved, err := resolveExistingPath(abs)
	if err != nil {
		return "", fmt.Errorf("去水印工具未找到，请在设置中配置正确的绝对路径。错误: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return "", fmt.Errorf("去水印工具未找到，请在设置中配置正确的绝对路径。错误: %w", err)
	}
	if info.IsDir() {
		return "", errors.New("去水印工具路径不能是目录")
	}

	base := strings.ToLower(filepath.Base(resolved))
	if base != "zotero-access-cleaner.exe" && base != "zotero-pdf-toolbox.exe" {
		return "", fmt.Errorf("去水印工具文件名不受支持：%s", filepath.Base(resolved))
	}
	if runtime.GOOS == "windows" && !strings.EqualFold(filepath.Ext(resolved), ".exe") {
		return "", errors.New("去水印工具必须是 .exe 可执行文件")
	}
	return resolved, nil
}

func buildCleanerArgs(cleanerPath, inputPath, summaryPath string, extra map[string]string, preserveOriginal bool, timeoutSeconds int) []string {
	patternsPath := ""
	engine := ""
	if extra != nil {
		patternsPath = strings.TrimSpace(extra["patterns_path"])
		engine = strings.TrimSpace(extra["engine"])
	}
	timeoutArg := strconv.Itoa(timeoutSeconds)

	if strings.EqualFold(filepath.Base(cleanerPath), "zotero-pdf-toolbox.exe") {
		args := []string{
			"clean-access",
			"--input", inputPath,
		}
		if patternsPath != "" {
			args = append(args, "--patterns", patternsPath)
		}
		args = append(args,
			"--replace",
		)
		if preserveOriginal {
			args = append(args, "--backup-suffix", ".original.pdf")
		} else {
			args = append(args, "--no-backup")
		}
		args = append(args, "--summary-json", summaryPath)
		if engine != "" && !strings.EqualFold(engine, "auto") {
			args = append(args, "--engine", engine)
		}
		args = append(args, "--timeout-seconds", timeoutArg)
		return args
	}

	args := []string{
		"-input", inputPath,
		"-apply",
		"-replace",
	}
	if preserveOriginal {
		args = append(args, "-preserve-original-on-cleaned")
	} else {
		args = append(args, "-no-backup")
	}
	args = append(args, "-summary-json", summaryPath)
	if patternsPath != "" {
		args = append(args, "-patterns", patternsPath)
	}
	if engine != "" {
		args = append(args, "-engine", engine)
	}
	args = append(args, "-timeout-seconds", timeoutArg)
	return args
}

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
