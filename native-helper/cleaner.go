package main

import (
	"encoding/json"
	"strings"
)

type CleanerSummary struct {
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

type CleanerResult struct {
	Path    string
	Summary CleanerSummary
}

func interpretCleanerSummary(
	summaryData []byte,
	sourcePath string,
	resolveOutput func(string) (string, error),
) (CleanerResult, error) {
	var summary CleanerSummary
	if err := json.Unmarshal(summaryData, &summary); err != nil {
		return CleanerResult{}, err
	}

	resultPath := sourcePath
	if summary.Status == "cleaned" && strings.TrimSpace(summary.Output) != "" {
		if resolvedOutput, err := resolveOutput(summary.Output); err == nil {
			resultPath = resolvedOutput
		}
	}

	return CleanerResult{Path: resultPath, Summary: summary}, nil
}

func resolveAllowedCleanerOutput(path string) (string, error) {
	resolved, err := cleanExistingPath(path)
	if err != nil {
		return "", err
	}
	if err := ensureAllowedPDFPath(resolved); err != nil {
		return "", err
	}
	return resolved, nil
}
