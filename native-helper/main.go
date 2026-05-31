package main

import (
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
	"strings"
	"syscall"
	"time"
)

const allowedOSSHost = "https://ables1.oss-cn-shanghai.aliyuncs.com/"

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
	OK       bool   `json:"ok"`
	Error    string `json:"error,omitempty"`
	Action   string `json:"action,omitempty"`
	Path     string `json:"path,omitempty"`
	Filename string `json:"filename,omitempty"`
	Size     int64  `json:"size,omitempty"`
	MD5      string `json:"md5,omitempty"`
	IsPDF    bool   `json:"is_pdf,omitempty"`
	Status   int    `json:"status,omitempty"`
	Body     string `json:"body,omitempty"`
	Deleted  bool   `json:"deleted,omitempty"`
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
	case "upload_oss":
		return handleUploadOSS(req)
	case "delete_file":
		return handleDeleteFile(req)
	case "notify_user":
		return handleNotifyUser(req)
	case "open_config_dir":
		return handleOpenConfigDir(req)
	case "open_local_storage":
		return handleOpenLocalStorageDir(req)
	case "read_config_file":
		return handleReadConfigFile(req)
	case "write_config_file":
		return handleWriteConfigFile(req)
	case "write_text_file":
		return handleWriteTextFile(req)
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

func handleOpenConfigDir(req Request) error {
	dir, err := resolveConfigDir(req.Dir)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	if err := ensureDefaultConfigFiles(dir); err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		if err := exec.Command("explorer.exe", dir).Start(); err != nil {
			return err
		}
		return writeResponse(Response{OK: true, Action: "open_config_dir", Path: dir})
	}
	return writeResponse(Response{OK: true, Action: "open_config_dir", Path: dir})
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

func handleReadConfigFile(req Request) error {
	path, err := resolveConfigFile(req, false)
	if err != nil {
		return err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return writeResponse(Response{OK: true, Action: "read_config_file", Path: path, Filename: filepath.Base(path), Size: int64(len(data)), Body: string(data)})
}

func handleWriteConfigFile(req Request) error {
	path, err := resolveConfigFile(req, true)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	if err := os.WriteFile(path, []byte(req.Content), 0600); err != nil {
		return err
	}
	return writeResponse(Response{OK: true, Action: "write_config_file", Path: path, Filename: filepath.Base(path), Size: int64(len(req.Content))})
}

func resolveConfigFile(req Request, forWrite bool) (string, error) {
	if strings.TrimSpace(req.ConfigPath) != "" {
		path := cleanConfigPath(req.ConfigPath)
		if path == "" {
			return "", errors.New("invalid config path")
		}
		base := filepath.Base(path)
		if !allowedConfigFilename(base) {
			return "", fmt.Errorf("unsupported config file: %s", base)
		}
		if !forWrite {
			if _, err := os.Stat(path); err != nil {
				return "", err
			}
		}
		return path, nil
	}
	filename := strings.TrimSpace(req.Filename)
	if filename == "" {
		filename = "watcher-rules.json"
	}
	filename = filepath.Base(filename)
	if !allowedConfigFilename(filename) {
		return "", fmt.Errorf("unsupported config file: %s", filename)
	}
	if forWrite {
		dir, err := resolveConfigDir(req.Dir)
		if err != nil {
			return "", err
		}
		return filepath.Join(dir, filename), nil
	}
	for _, dir := range configDirCandidates(req.Dir) {
		path := filepath.Join(dir, filename)
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("%s not found in local config dirs", filename)
}

func resolveConfigDir(dir string) (string, error) {
	for _, candidate := range configDirCandidates(dir) {
		if strings.TrimSpace(candidate) == "" {
			continue
		}
		return candidate, nil
	}
	return "", errors.New("no config dir candidate")
}

func configDirCandidates(explicitDir string) []string {
	candidates := []string{}
	if strings.TrimSpace(explicitDir) != "" {
		candidates = append(candidates, explicitDir)
	}
	if env := strings.TrimSpace(os.Getenv("ABLESCI_WATCHER_CONFIG_DIR")); env != "" {
		candidates = append(candidates, env)
	}
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		candidates = append(candidates,
			exeDir,
			filepath.Join(exeDir, "config.local"),
			filepath.Join(filepath.Dir(exeDir), "config.local"),
		)
	}
	if cwd, err := os.Getwd(); err == nil {
		candidates = append(candidates,
			filepath.Join(cwd, "config.local"),
			filepath.Join(filepath.Dir(cwd), "config.local"),
		)
	}

	seen := map[string]bool{}
	out := []string{}
	for _, candidate := range candidates {
		path := cleanConfigPath(candidate)
		if path == "" {
			continue
		}
		if seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	return out
}

func ensureDefaultConfigFiles(dir string) error {
	files := map[string]string{
		"watcher-rules.json": "{\n  \"note\": \"reserved for future local watcher rules\"\n}\n",
	}
	for name, content := range files {
		path := filepath.Join(dir, name)
		if _, err := os.Stat(path); err == nil {
			continue
		}
		if err := os.WriteFile(path, []byte(content), 0600); err != nil {
			return err
		}
	}
	return nil
}

func cleanConfigPath(path string) string {
	path = strings.Trim(path, "\" ")
	if path == "" {
		return ""
	}
	if runtime.GOOS == "windows" {
		path = strings.ReplaceAll(path, "/", `\`)
	}
	if !filepath.IsAbs(path) {
		if abs, err := filepath.Abs(path); err == nil {
			path = abs
		}
	}
	return filepath.Clean(path)
}

func allowedConfigFilename(filename string) bool {
	switch strings.ToLower(filepath.Base(filename)) {
	case "watcher-rules.json":
		return true
	default:
		return false
	}
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

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	return closeErr
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
	if isLocalOrPrivateHost(u.Hostname()) {
		return errors.New("上传存储地址不能是本机或内网地址")
	}
	normalized, err := normalizeAllowedURL(host)
	if err != nil {
		return err
	}
	allowed, err := normalizeAllowedURL(allowedOSSHost)
	if err != nil {
		return err
	}
	if normalized != allowed {
		return errors.New("上传存储地址不在允许范围，请更新插件或检查上传链路")
	}
	return nil
}

func normalizeAllowedURL(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", err
	}
	if u.Scheme != "https" {
		return "", errors.New("allowed oss host must use https")
	}
	host := strings.ToLower(u.Host)
	return "https://" + host, nil
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
