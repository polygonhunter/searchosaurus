import { Notice, Platform, loadPdfJs, type App, type Plugin, type TFile } from "obsidian";
import { kindForExtension } from "../core/classify";
import type { SearchEngine } from "../core/engine";
import { idleScheduler, OcrQueue } from "../core/ocr-queue";
import type { SearchosaurusSettings } from "../settings";
import { attachmentDoc } from "../index/content";
import { assetsPresent } from "./assets";
import { OcrCache } from "./ocr-cache";
import { OcrService } from "./ocr-service";

/** Hard cap per file — extracted text is a low-weight helper field. */
const MAX_EXTRACTED_CHARS = 20_000;
const MAX_PDF_PAGES = 100;

/**
 * Background text extraction: images through tesseract, PDFs through
 * Obsidian's bundled pdf.js. Runs in idle time, one file at a time, and
 * every result lands in the synced ocr-cache.json — so no file is ever
 * recognized twice, on any device.
 */
export class OcrPipeline {
	private readonly queue = new OcrQueue(idleScheduler(window));
	private readonly cache: OcrCache;
	private readonly service: OcrService;
	private missingAssetsWarned = false;

	constructor(
		private readonly app: App,
		private readonly engine: SearchEngine,
		private readonly getSettings: () => SearchosaurusSettings,
		private readonly manifestDir: string,
		private readonly persistSoon: () => void,
	) {
		this.cache = new OcrCache(app, manifestDir);
		this.service = new OcrService(app, manifestDir);
	}

	async init(plugin: Plugin): Promise<void> {
		await this.cache.load();
		plugin.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.cache.remove(file.path);
				this.queue.drop(file.path);
			}),
		);
		plugin.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.cache.rename(oldPath, file.path);
				this.queue.drop(oldPath);
			}),
		);
	}

	async destroy(): Promise<void> {
		this.queue.clear();
		await this.service.terminate();
		await this.cache.save();
	}

	/** Enqueue every eligible attachment (used when OCR gets switched on). */
	scanVault(priority: "high" | "low" = "low"): void {
		const excluded = this.getSettings().excludedFolders;
		for (const file of this.app.vault.getFiles()) {
			if (excluded.some((folder) => file.path.startsWith(folder))) continue;
			this.consider(file, priority);
		}
	}

	/** Called by the indexer for every attachment it (re)indexes. */
	consider(file: TFile, priority: "high" | "low"): void {
		const settings = this.getSettings();
		const kind = kindForExtension(file.extension);
		if (kind === "image") {
			if (!settings.ocrEnabled || !Platform.isDesktop) return;
			this.considerImage(file, settings.ocrLanguages.join("+"), priority);
			return;
		}
		if (kind === "file" && file.extension.toLowerCase() === "pdf" && settings.indexPdfText) {
			this.considerPdf(file, priority);
		}
	}

	private considerImage(file: TFile, langs: string, priority: "high" | "low"): void {
		const cached = this.cache.get(file.path, file.stat.mtime, file.stat.size, langs);
		if (cached !== null) {
			this.apply(file, cached);
			return;
		}
		this.queue.push(
			file.path,
			async () => {
				if (!(await this.assetsReady())) return;
				const url = this.app.vault.getResourcePath(file);
				const text = await this.service.recognize(url, langs);
				this.cache.set(file.path, {
					mtime: file.stat.mtime,
					size: file.stat.size,
					langs,
					text,
				});
				this.apply(file, text);
				await this.cache.save();
			},
			priority,
		);
	}

	private considerPdf(file: TFile, priority: "high" | "low"): void {
		// PDFs are language-independent — keyed with a fixed marker.
		const cached = this.cache.get(file.path, file.stat.mtime, file.stat.size, "pdf");
		if (cached !== null) {
			this.apply(file, cached);
			return;
		}
		this.queue.push(
			file.path,
			async () => {
				const text = await this.extractPdfText(file);
				this.cache.set(file.path, {
					mtime: file.stat.mtime,
					size: file.stat.size,
					langs: "pdf",
					text,
				});
				this.apply(file, text);
				await this.cache.save();
			},
			priority,
		);
	}

	private async extractPdfText(file: TFile): Promise<string> {
		try {
			const pdfjs = (await loadPdfJs()) as {
				getDocument(options: { data: ArrayBuffer }): {
					promise: Promise<{
						numPages: number;
						getPage(n: number): Promise<{
							getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
						}>;
					}>;
				};
			};
			const data = await this.app.vault.readBinary(file);
			const doc = await pdfjs.getDocument({ data }).promise;
			const parts: string[] = [];
			let length = 0;
			const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
			for (let n = 1; n <= pages && length < MAX_EXTRACTED_CHARS; n++) {
				const page = await doc.getPage(n);
				const content = await page.getTextContent();
				const pageText = content.items
					.map((item) => item.str ?? "")
					.join(" ")
					.trim();
				parts.push(pageText);
				length += pageText.length;
			}
			return parts.join("\n").trim();
		} catch {
			return ""; // scanned/encrypted PDFs: silently nothing (v1)
		}
	}

	/** Push extracted text into the index and schedule persistence. */
	private apply(file: TFile, text: string): void {
		this.engine.upsert(attachmentDoc(file, text.slice(0, MAX_EXTRACTED_CHARS)));
		this.persistSoon();
	}

	private async assetsReady(): Promise<boolean> {
		const present = await assetsPresent(this.app, this.manifestDir);
		if (!present && !this.missingAssetsWarned) {
			this.missingAssetsWarned = true;
			new Notice(
				"Searchosaurus: OCR is enabled but its assets are missing — re-run the download from the settings tab.",
				8000,
			);
		}
		return present;
	}
}
