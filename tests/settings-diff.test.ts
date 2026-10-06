import { describe, expect, it } from "vitest";
import { diffSettings, snapshotSettings, type DiffableSettings } from "../src/core/settings-diff";

const base: DiffableSettings = {
	excludedFolders: ["Templates"],
	resultLimit: 50,
	ocrEnabled: false,
	ocrLanguages: ["deu", "eng"],
	indexPdfText: true,
};

describe("diffSettings", () => {
	it("reports nothing for a result-limit change", () => {
		const change = diffSettings(base, { ...base, resultLimit: 80 });
		expect(Object.values(change).every((v) => v === false)).toBe(true);
	});

	it("detects exclusion changes, ignoring surrounding whitespace", () => {
		expect(diffSettings(base, { ...base, excludedFolders: ["Templates", "Archiv"] }).exclusions).toBe(true);
		expect(diffSettings(base, { ...base, excludedFolders: [" Templates "] }).exclusions).toBe(false);
	});

	it("starts OCR on enable and on a language change while enabled", () => {
		expect(diffSettings(base, { ...base, ocrEnabled: true }).ocrStarted).toBe(true);
		const on = { ...base, ocrEnabled: true };
		expect(diffSettings(on, { ...on, ocrLanguages: ["eng"] }).ocrStarted).toBe(true);
		expect(diffSettings(base, { ...base, ocrLanguages: ["eng"] }).ocrStarted).toBe(false);
	});

	it("stops OCR on disable", () => {
		const on = { ...base, ocrEnabled: true };
		const change = diffSettings(on, base);
		expect(change.ocrStopped).toBe(true);
		expect(change.ocrStarted).toBe(false);
	});

	it("tracks PDF toggles both ways", () => {
		const off = { ...base, indexPdfText: false };
		expect(diffSettings(off, base).pdfStarted).toBe(true);
		expect(diffSettings(base, off).pdfStopped).toBe(true);
	});

	it("snapshots copy arrays so in-place edits are still detected", () => {
		const live = { ...base, excludedFolders: ["A"] };
		const snap = snapshotSettings(live);
		live.excludedFolders.push("B");
		expect(diffSettings(snap, live).exclusions).toBe(true);
	});
});
