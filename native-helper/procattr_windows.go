//go:build windows

package main

import (
	"context"
	"os/exec"
	"strconv"
	"syscall"
)

const createNoWindow = 0x08000000

func hiddenProcessAttrs() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{
		HideWindow:    true,
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | createNoWindow,
	}
}

// runHiddenCommand keeps Windows-specific process configuration out of the
// portable helper. On timeout taskkill /T terminates the whole child tree,
// including qpdf/pdfcpu processes spawned by the cleaner.
func runHiddenCommand(ctx context.Context, cmd *exec.Cmd) error {
	cmd.SysProcAttr = hiddenProcessAttrs()
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		killer := exec.Command("taskkill.exe", "/T", "/F", "/PID", strconv.Itoa(cmd.Process.Pid))
		killer.SysProcAttr = hiddenProcessAttrs()
		_ = killer.Run()
		_ = cmd.Process.Kill()
		<-done
		return ctx.Err()
	}
}
