package main

func cleanerResponse(result CleanerResult) Response {
	summary := result.Summary
	return Response{
		OK:                 true,
		Action:             "clean_pdf",
		Path:               result.Path,
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
	}
}
