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
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const createNoWindow = 0x08000000

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
	OK             bool     `json:"ok"`
	Error          string   `json:"error,omitempty"`
	Action         string   `json:"action,omitempty"`
	Path           string   `json:"path,omitempty"`
	Filename       string   `json:"filename,omitempty"`
	Size           int64    `json:"size,omitempty"`
	MD5            string   `json:"md5,omitempty"`
	IsPDF          bool     `json:"is_pdf,omitempty"`
	Status         int      `json:"status,omitempty"`
	Body           string   `json:"body,omitempty"`
	Deleted        bool     `json:"deleted,omitempty"`
	CleanStatus    string   `json:"clean_status,omitempty"`
	CleanOutput    string   `json:"clean_output,omitempty"`
	CleanErrorCode string   `json:"clean_error_code,omitempty"`
	CleanMatched   int      `json:"clean_matched,omitempty"`
	CleanRules     []string `json:"clean_rules,omitempty"`
	CleanEngine    string   `json:"clean_engine,omitempty"`
	CleanElapsedMs int64    `json:"clean_elapsed_ms,omitempty"`
	CleanBackupPath    string   `json:"clean_backup_path,omitempty"`
	CleanBackupCreated bool     `json:"clean_backup_created,omitempty"`
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
		fmt.Println("问：开始菜单里的快捷方式可以删除吗？")
		fmt.Println("答：可以。它仅用于支持“右下角消息通知”功能。如果您不需要弹窗提醒，")
		fmt.Println("    可以随时删除该快捷方式或文件夹，完全不会影响插件的下载和上传功能。")
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
	case "clean_pdf":
		return handleCleanPDF(req)
	case "upload_oss":
		return handleUploadOSS(req)
	case "delete_file":
		return handleDeleteFile(req)
	case "copy_pdf":
		return handleCopyPDF(req)
	case "notify_user":
		return handleNotifyUser(req)
	case "open_local_storage":
		return handleOpenLocalStorageDir(req)
	case "write_text_file":
		return handleWriteTextFile(req)
	case "read_text_file":
		return handleReadTextFile(req)
	default:
		return fmt.Errorf("unknown action: %s", req.Action)
	}
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
	return writeResponse(Response{
		OK: true, Action: "stat_pdf", Path: path, Filename: info.Name(), Size: info.Size(), MD5: md5sum, IsPDF: true,
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

	if _, _, err := inspectPDF(path); err != nil {
		return fmt.Errorf("refuse to delete file that is not a valid PDF: %w", err)
	}

	if err := os.Remove(path); err != nil {
		return err
	}

	return writeResponse(Response{OK: true, Action: "delete_file", Path: path, Deleted: true})
}

func handleCopyPDF(req Request) error {
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

func handleNotifyUser(req Request) error {
	brand := "Ablesci PDF Watcher"
	title := limitText(firstNonEmpty(req.Title, brand), 80)
	message := limitText(firstNonEmpty(req.Message, "需要人工处理。"), 240)
	if runtime.GOOS == "windows" {
		// Escape single quotes for PowerShell single-quoted strings (double them)
		escapedTitle := strings.ReplaceAll(title, "'", "''")
		escapedMsg := strings.ReplaceAll(message, "'", "''")

		// Set AppUserModelID so Windows Notification Center shows the brand name
		// instead of "Windows PowerShell". Must be called before any WinForms objects are created.
		setAppID := `$setAppIDSrc = @"` + "\r\n" +
			`using System;` + "\r\n" +
			`using System.Runtime.InteropServices;` + "\r\n" +
			`public class AblesciNotify {` + "\r\n" +
			`    [DllImport("shell32.dll", SetLastError=true)]` + "\r\n" +
			`    public static extern void SetCurrentProcessExplicitAppUserModelID(` + "\r\n" +
			`        [MarshalAs(UnmanagedType.LPWStr)] string AppID);` + "\r\n" +
			`}` + "\r\n" +
			`"@` + "\r\n" +
			`Add-Type -TypeDefinition $setAppIDSrc;` +
			`[AblesciNotify]::SetCurrentProcessExplicitAppUserModelID("AblesciPDFWatcher")`

		// Build script with diagnostic log header
		logStart := `try { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') START $title" | Out-File -Append "$env:TEMP\ablesci_notify.log" -Encoding UTF8 } catch {}`
		logEnd := `try { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') END $title" | Out-File -Append "$env:TEMP\ablesci_notify.log" -Encoding UTF8 } catch {}`

		// Windows Toast Notification. Windows still reserves the source icon area;
		// without a custom shortcut icon it uses the default app icon.
		// Sound is handled by the Toast XML <audio> element; do NOT call SystemSounds.Play() to avoid double beep.
		toastNotify := `$escTitle = [System.Security.SecurityElement]::Escape($title); ` +
			`$escMsg = [System.Security.SecurityElement]::Escape($msg); ` +
			`$appID = "AblesciPDFWatcher"; ` +
			`$toastXml = [string]::Format('<toast duration="short"><visual><binding template="ToastGeneric"><text>{0}</text><text>{1}</text></binding></visual><audio src="ms-winsoundevent:Notification.Default"/></toast>', $escTitle, $escMsg); ` +
			`$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]; ` +
			`$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]; ` +
			`$xml = New-Object Windows.Data.Xml.Dom.XmlDocument; ` +
			`$xml.LoadXml($toastXml); ` +
			`$toast = New-Object Windows.UI.Notifications.ToastNotification($xml); ` +
			`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appID).Show($toast)`

		scriptBody := logStart + "; " + setAppID + "; " + toastNotify + "; " + logEnd
		fullScript := "$title = '" + escapedTitle + "'; $msg = '" + escapedMsg + "'; $brand = '" + brand + "';\n" + scriptBody

		tmpFile, err := os.CreateTemp("", "ablesci_notify_*.ps1")
		if err != nil {
			return fmt.Errorf("notify: create temp script: %w", err)
		}
		tmpPath := tmpFile.Name()
		// Write UTF-8 BOM so Windows PowerShell can parse the script correctly
		tmpFile.Write([]byte{0xEF, 0xBB, 0xBF})
		if _, err := tmpFile.WriteString(fullScript); err != nil {
			tmpFile.Close()
			os.Remove(tmpPath)
			return fmt.Errorf("notify: write temp script: %w", err)
		}
		tmpFile.Close()

		// Launch PowerShell directly (no cmd /c start /min intermediate).
		// HideWindow + createNoWindow ensures no console or taskbar flash.
		// PowerShell exits after ToastNotificationManager.Show(), which is fire-and-forget.
		cmd := exec.Command("powershell.exe",
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy", "Bypass",
			"-STA",
			"-WindowStyle", "Hidden",
			"-File", tmpPath)
		cmd.SysProcAttr = &syscall.SysProcAttr{
			HideWindow:    true,
			CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow,
		}
		cmd.Stdin = strings.NewReader("")
		cmd.Stdout = io.Discard
		cmd.Stderr = io.Discard

		if err := cmd.Run(); err != nil {
			os.Remove(tmpPath)
			return fmt.Errorf("notify: launch: %w", err)
		}

		// Clean up temp script immediately after PowerShell completes
		os.Remove(tmpPath)

		return writeResponse(Response{OK: true, Action: "notify_user"})
	}
	fmt.Fprint(os.Stderr, "\a")
	return writeResponse(Response{OK: true, Action: "notify_user"})
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
	if p == "" {
		exe, err := os.Executable()
		if err != nil {
			return err
		}
		resolved = filepath.Clean(filepath.Join(filepath.Dir(exe), "blacklist.txt"))
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

	// 自动创建黑名单文件（如果不存在）。空路径使用 Helper 本地目录，显式路径使用用户配置的位置。
	if _, err := os.Stat(resolved); os.IsNotExist(err) {
		if err := os.MkdirAll(filepath.Dir(resolved), 0755); err != nil {
			return err
		}
		template := `# 示例求助人 ID 黑名单文件
# 每行一个用户 ID，也可在 ID 后使用 # 或 // 添加拉黑备注说明
# 
AAAAAAA # 示例用户，拉黑原因备注，例如：2026-06-04 临时测试使用
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

func handleWriteTextFile(req Request) error {
	filename := sanitizeReportFilename(req.Filename)
	if filename == "" {
		return errors.New("missing report filename")
	}
	dir, err := reportDir(req.Dir)
	if err != nil {
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
	return filepath.Clean(dir)
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
		cleanerPath = filepath.Join(filepath.Dir(exePath), "zotero-access-cleaner.exe")
	}

	// Verify cleaner exists
	if _, err := os.Stat(cleanerPath); err != nil {
		return fmt.Errorf("去水印工具未找到，请在设置中配置正确的绝对路径。错误: %w", err)
	}

	// 2. Create temp file for summary JSON
	tmpFile, err := os.CreateTemp("", "cleaner_summary_*.json")
	if err != nil {
		return fmt.Errorf("failed to create temporary summary file: %w", err)
	}
	summaryPath := tmpFile.Name()
	tmpFile.Close()
	defer os.Remove(summaryPath)

	// 3. Prepare arguments
	preserveOriginal := req.Extra["preserve_original"] == "true"
	args := []string{
		"-input", path,
		"-apply",
		"-replace",
	}
	if preserveOriginal {
		args = append(args, "-preserve-original-on-cleaned")
	} else {
		args = append(args, "-no-backup")
	}
	args = append(args, "-summary-json", summaryPath)

	if patternsPath := req.Extra["patterns_path"]; patternsPath != "" {
		args = append(args, "-patterns", patternsPath)
	}
	if engine := req.Extra["engine"]; engine != "" {
		args = append(args, "-engine", engine)
	}
	if timeoutStr := req.Extra["timeout_seconds"]; timeoutStr != "" {
		args = append(args, "-timeout-seconds", timeoutStr)
	}

	// 4. Set process timeout
	timeoutSeconds := 60
	if timeoutStr := req.Extra["timeout_seconds"]; timeoutStr != "" {
		if val, err := strconv.Atoi(timeoutStr); err == nil && val > 0 {
			timeoutSeconds = val
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds+5)*time.Second)
	defer cancel()

	// 5. Execute process
	cmd := exec.CommandContext(ctx, cleanerPath, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow,
	}

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	runErr := cmd.Run()

	// 6. Check summary JSON
	summaryData, readErr := os.ReadFile(summaryPath)
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
