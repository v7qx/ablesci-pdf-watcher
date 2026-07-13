package main

import (
	"errors"
	"testing"
)

func TestInterpretCleanerSummaryUsesResolvedCleanedOutput(t *testing.T) {
	summaryData := []byte(`{
		"schema_version": 1,
		"status": "cleaned",
		"source": "source.pdf",
		"output": "cleaned.pdf",
		"engine": "qpdf",
		"engine_version": "12.0",
		"rules_version": "2026-07-13",
		"matched": 2,
		"page_count": 12,
		"removed_calls": 3,
		"rules": ["rule-a", "rule-b"],
		"elapsed_ms": 45,
		"error_code": "",
		"error": "",
		"backup_path": "source.original.pdf",
		"backup_created": true
	}`)

	result, err := interpretCleanerSummary(
		summaryData,
		"source.pdf",
		func(path string) (string, error) {
			if path != "cleaned.pdf" {
				t.Fatalf("unexpected output path passed to resolver: %q", path)
			}
			return "resolved-cleaned.pdf", nil
		},
	)
	if err != nil {
		t.Fatalf("interpret cleaner summary: %v", err)
	}

	if result.Path != "resolved-cleaned.pdf" {
		t.Fatalf("result path got %q want resolved-cleaned.pdf", result.Path)
	}
	resp := cleanerResponse(result)
	if !resp.OK || resp.Action != "clean_pdf" || resp.Path != "resolved-cleaned.pdf" {
		t.Fatalf("unexpected response identity: %+v", resp)
	}
	if resp.CleanStatus != "cleaned" || resp.CleanOutput != "cleaned.pdf" {
		t.Fatalf("unexpected cleaner output fields: %+v", resp)
	}
	if resp.CleanMatched != 2 || resp.CleanPageCount != 12 || resp.CleanElapsedMs != 45 {
		t.Fatalf("unexpected cleaner metrics: %+v", resp)
	}
	if len(resp.CleanRules) != 2 || resp.CleanRules[0] != "rule-a" || resp.CleanRules[1] != "rule-b" {
		t.Fatalf("unexpected cleaner rules: %+v", resp.CleanRules)
	}
	if resp.CleanEngine != "qpdf" || resp.CleanBackupPath != "source.original.pdf" || !resp.CleanBackupCreated {
		t.Fatalf("unexpected cleaner metadata: %+v", resp)
	}
}

func TestInterpretCleanerSummaryFallsBackWhenOutputIsRejected(t *testing.T) {
	result, err := interpretCleanerSummary(
		[]byte(`{"status":"cleaned","output":"outside.pdf","error_code":"","error":""}`),
		"source.pdf",
		func(string) (string, error) {
			return "", errors.New("outside allowed directories")
		},
	)
	if err != nil {
		t.Fatalf("interpret cleaner summary: %v", err)
	}
	if result.Path != "source.pdf" {
		t.Fatalf("rejected output must fall back to source path, got %q", result.Path)
	}
	resp := cleanerResponse(result)
	if resp.CleanOutput != "outside.pdf" {
		t.Fatalf("response must preserve cleaner output metadata: %+v", resp)
	}
}

func TestInterpretCleanerSummaryDoesNotResolveUncleanedOutput(t *testing.T) {
	resolverCalled := false
	result, err := interpretCleanerSummary(
		[]byte(`{"status":"unchanged","output":"unexpected.pdf"}`),
		"source.pdf",
		func(string) (string, error) {
			resolverCalled = true
			return "unexpected.pdf", nil
		},
	)
	if err != nil {
		t.Fatalf("interpret cleaner summary: %v", err)
	}
	if resolverCalled {
		t.Fatal("output resolver must not run unless cleaner status is cleaned")
	}
	if result.Path != "source.pdf" {
		t.Fatalf("unchanged result path got %q want source.pdf", result.Path)
	}
}

func TestInterpretCleanerSummaryRejectsMalformedJSON(t *testing.T) {
	_, err := interpretCleanerSummary(
		[]byte(`{"status":`),
		"source.pdf",
		func(path string) (string, error) { return path, nil },
	)
	if err == nil {
		t.Fatal("expected malformed cleaner summary to be rejected")
	}
}
