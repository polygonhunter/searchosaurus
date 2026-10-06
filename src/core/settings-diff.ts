/**
 * Which derived work a settings change requires (pure, unit-tested).
 * Keeps onSettingsChanged from re-scanning the whole vault on every
 * slider tick or keystroke in a folder field.
 */

export interface DiffableSettings {
	excludedFolders: readonly string[];
	resultLimit: number;
	ocrEnabled: boolean;
	ocrLanguages: readonly string[];
	indexPdfText: boolean;
}

export interface SettingsChange {
	/** Excluded folders changed → reconcile the index against them. */
	exclusions: boolean;
	/** OCR got switched on, or its languages changed while on. */
	ocrStarted: boolean;
	/** OCR got switched off → drop image jobs, stop the worker. */
	ocrStopped: boolean;
	/** PDF text extraction got switched on. */
	pdfStarted: boolean;
	/** PDF text extraction got switched off → drop PDF jobs. */
	pdfStopped: boolean;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function diffSettings(prev: DiffableSettings, next: DiffableSettings): SettingsChange {
	const langsChanged = !sameList(prev.ocrLanguages, next.ocrLanguages);
	return {
		exclusions: !sameList(
			prev.excludedFolders.map((f) => f.trim()),
			next.excludedFolders.map((f) => f.trim()),
		),
		ocrStarted: next.ocrEnabled && (!prev.ocrEnabled || langsChanged),
		ocrStopped: prev.ocrEnabled && !next.ocrEnabled,
		pdfStarted: next.indexPdfText && !prev.indexPdfText,
		pdfStopped: prev.indexPdfText && !next.indexPdfText,
	};
}

/** Snapshot for the next diff — arrays are copied, not shared. */
export function snapshotSettings<T extends DiffableSettings>(settings: T): T {
	return {
		...settings,
		excludedFolders: [...settings.excludedFolders],
		ocrLanguages: [...settings.ocrLanguages],
	};
}
