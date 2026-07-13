package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
)

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
