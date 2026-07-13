package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

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

	debugEnabled := isCleanerDebugEnabled(req)
	debugFile := "<redacted.pdf>"
	if debugEnabled {
		debugFile = filepath.Base(path)
	}
	debugRequest, _ := json.MarshalIndent(map[string]string{
		"action":            req.Action,
		"file":              debugFile,
		"engine":            req.Extra["engine"],
		"timeout_seconds":   req.Extra["timeout_seconds"],
		"preserve_original": req.Extra["preserve_original"],
	}, "", "  ")
	filesBefore := "(omitted)"
	if debugEnabled {
		filesBefore = listPrefixFiles(path)
	}

	// 4. Set process timeout
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSeconds+5)*time.Second)
	defer cancel()

	// 5. Execute process
	cmd := exec.Command(cleanerPath, args...)
	cmd.Env = envWithCleanerToolDirs(cleanerPath)

	stdout := &cappedBuffer{max: 64 * 1024}
	stderr := &cappedBuffer{max: 32 * 1024}
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	runErr := runHiddenCommand(ctx, cmd)

	// 收集运行后的文件状态
	filesAfter := "(omitted)"
	if debugEnabled {
		filesAfter = listPrefixFiles(path)
	}

	// 6. Check summary JSON
	summaryData, readErr := os.ReadFile(summaryPath)
	summaryLog := ""
	if readErr == nil {
		summaryLog = string(summaryData)
		if debugEnabled {
			_ = os.WriteFile(filepath.Join(os.TempDir(), "ablesci_cleaner_summary.json"), summaryData, 0600)
		}
	} else {
		summaryLog = fmt.Sprintf("(Error reading summary file: %v)", readErr)
	}

	// 将详尽的调试日志追加写入临时文件，便于极其细致地排查
	if debugEnabled || runErr != nil || readErr != nil {
		argsLog := "(omitted)"
		stdoutLog := "(omitted)"
		stderrLog := "(omitted)"
		summaryForLog := "(omitted)"
		if debugEnabled {
			argsLog = strings.Join(redactCleanerArgs(args), " ")
			stdoutLog = redactLocalDebugText(stdout.String())
			stderrLog = redactLocalDebugText(stderr.String())
			summaryForLog = redactLocalDebugText(summaryLog)
		}
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
			string(debugRequest),
			filepath.Base(cleanerPath),
			argsLog,
			filesBefore,
			runErr,
			stdoutLog,
			stderrLog,
			filesAfter,
			summaryForLog,
		)
		debugLogPath := filepath.Join(os.TempDir(), "ablesci_cleaner_debug.log")
		removeDebugFileOlderThan(debugLogPath, 7*24*time.Hour)
		rotateLogIfTooLarge(debugLogPath, maxDebugLogBytes)
		f, _ := os.OpenFile(debugLogPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0600)
		if f != nil {
			_, _ = f.WriteString(debugLog)
			f.Close()
		}
	}

	if readErr == nil {
		if result, interpretErr := interpretCleanerSummary(summaryData, path, resolveAllowedCleanerOutput); interpretErr == nil {
			summary := result.Summary
			if preserveOriginal && summary.Status == "cleaned" {
				backupPath := strings.TrimSpace(summary.BackupPath)
				if backupPath == "" && summary.BackupCreated {
					backupPath = strings.TrimSuffix(path, filepath.Ext(path)) + ".original.pdf"
				}
				// Metadata-only update: keep the cleaned PDF above its preserved
				// .original.pdf backup when file pickers sort by modification time.
				// This does not reopen or rewrite PDF contents.
				_ = ensureCleanedFileSortsAfterBackup(result.Path, backupPath)
			}
			return writeResponse(cleanerResponse(result))
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

func ensureCleanedFileSortsAfterBackup(cleanedPath, backupPath string) error {
	cleanedPath = strings.TrimSpace(cleanedPath)
	if cleanedPath == "" {
		return errors.New("missing cleaned PDF path")
	}
	if err := ensureAllowedPDFPath(cleanedPath); err != nil {
		return err
	}
	targetTime := time.Now()
	if backupPath = strings.TrimSpace(backupPath); backupPath != "" {
		backupAllowed := ensureAllowedPDFPath(backupPath) == nil
		if backupInfo, err := os.Stat(backupPath); backupAllowed && err == nil {
			// Keep a visible margin for file pickers/filesystems that display or
			// compare modification times at whole-second precision.
			minimumTime := backupInfo.ModTime().Add(2 * time.Second)
			if targetTime.Before(minimumTime) {
				targetTime = minimumTime
			}
		}
	}
	return os.Chtimes(cleanedPath, targetTime, targetTime)
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
