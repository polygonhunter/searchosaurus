import { debounce, Notice, Platform, loadPdfJs, type App, type Plugin, type TFile } from "obsidian";
import { kindForExtension } from "../core/classify";
import type { SearchEngine } from "../core/engine";
import { idleScheduler, OcrQueue } from "../core/ocr-queue";
import { isPathExcluded } from "../core/paths";
import type { SearchosaurusSettings } from "../settings";
import { attachmentDoc } from "../index/content";
import { assetsPresent } from "./assets";
import { OcrCache } from "./ocr-cache";
// Type-only: tesseract.js must not be evaluated at plugin load — it is
// desktop-only and was a mobile load-failure suspect. Loaded lazily below.
import type { OcrService } from "./ocr-service";

function kindForPath(path: string): ReturnType<typeof kindForExtension> {
	const dot = path.lastIndexOf(".");
	return kindForExtension(dot === -1 ? "" : path.slice(dot + 1));
}

/** Hard cap per file — extracted text is a low-weight helper field. */
const MAX_EXTRACTED_CHARS = 20_000;
const MAX_PDF_PAGES = 100;
/** Larger PDFs are skipped (read fully into memory by pdf.js). */
const MAX_PDF_BYTES_DESKTOP = 50 * 1024 * 1024;
const MAX_PDF_BYTES_MOBILE = 20 * 1024 * 1024;
/** Write ocr-cache.json at most this often while jobs keep finishing… */
const CACHE_SAVE_DEBOUNCE_MS = 30_000;
/** …but force a write every N finished jobs, so a crash loses little. */
const CACHE_FLUSH_EVERY = 25;

/**
 * Background text extraction: images through tesseract, PDFs through
 * Obsidian's bundled pdf.js. Runs in idle time, one file at a time, and
 * every result lands in the synced ocr-cache.json — so no file is ever
 * recognized twice, on any device.
 */
export class OcrPipeline {
	private readonly queue = new OcrQueue(idleScheduler(window));
	private readonly cache: OcrCache;
	private service: OcrService | null = null;
	private missingAssetsWarned = false;
	/** Set by destroy(): late async work must not touch engine/cache. */
	private destroyed = false;
	/** Finished jobs since the last forced cache write. */
	private unsavedJobs = 0;

	constructor(
		private readonly app: App,
		private readonly engine: SearchEngine,
		private readonly getSettings: () => SearchosaurusSettings,
		private readonly manifestDir: string,
		/** Extracted text for this file version landed in the index. */
		private readonly onApplied: (path: string, mtime: number) => void,
	) {
		this.cache = new OcrCache(app, manifestDir);
	}

	/** Instantiate tesseract on first use only (desktop recognition path). */
	private async getService(): Promise<OcrService> {
		if (!this.service) {
			const { OcrService: Service } = await import("./ocr-service");
			if (this.destroyed) throw new Error("Searchosaurus: OCR pipeline destroyed");
			this.service ??= new Service(this.app, this.manifestDir);
		}
		return this.service;
	}

	async init(plugin: Plugin): Promise<void> {
		await this.cache.load();
		if (this.destroyed) return;
		// Only the device that actually runs OCR prunes entries of missing
		// files: a phone with selective sync (no images) must never wipe
		// the shared cache for everyone else.
		const settings = this.getSettings();
		if (settings.ocrEnabled && Platform.isDesktop) {
			this.cache.prune((path) => this.app.vault.getFileByPath(path) !== null);
		}
		plugin.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.cache.remove(file.path);
				this.queue.drop(file.path);
				this.saveCacheSoon();
			}),
		);
		plugin.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.cache.rename(oldPath, file.path);
				this.queue.drop(oldPath);
				this.saveCacheSoon();
			}),
		);
	}

	async destroy(): Promise<void> {
		this.destroyed = true;
		this.saveCacheSoon.cancel();
		this.queue.clear();
		await this.service?.destroy();
		this.service = null;
		await this.cache.save();
	}

	/** The path left the index (excluded/deleted): drop its pending job. */
	forget(path: string): void {
		this.queue.drop(path);
	}

	/** OCR switched off: drop queued image jobs and stop the worker. */
	async stopOcr(): Promise<void> {
		this.queue.dropWhere((path) => kindForPath(path) === "image");
		const service = this.service;
		this.service = null;
		await service?.destroy();
	}

	/** PDF extraction switched off: drop queued PDF jobs. */
	stopPdf(): void {
		this.queue.dropWhere((path) => path.toLowerCase().endsWith(".pdf"));
	}

	/** Enqueue every eligible attachment (used when OCR gets switched on). */
	scanVault(priority: "high" | "low" = "low"): void {
		const excluded = this.getSettings().excludedFolders;
		for (const file of this.app.vault.getFiles()) {
			if (isPathExcluded(file.path, excluded)) continue;
			this.consider(file, priority);
		}
	}

	/**
	 * Called by the indexer for every attachment it (re)indexes. Cache
	 * first, on every platform — a synced ocr-cache.json makes OCR text
	 * searchable on mobile too. Only a cache miss is gated by the settings
	 * (and by desktop-only recognition for images).
	 */
	consider(file: TFile, priority: "high" | "low"): void {
		const settings = this.getSettings();
		const kind = kindForExtension(file.extension);
		if (kind === "image") {
			const langs = settings.ocrLanguages.join("+");
			if (this.applyCached(file, langs)) return;
			if (!settings.ocrEnabled || !Platform.isDesktop) return;
			this.queueImage(file, langs, priority);
			return;
		}
		if (kind === "file" && file.extension.toLowerCase() === "pdf") {
			// PDFs are language-independent — keyed with a fixed marker.
			if (this.applyCached(file, "pdf")) return;
			if (!settings.indexPdfText) return;
			this.queuePdf(file, priority);
		}
	}

	/** Apply a cache hit for the file's current mtime/size; true on hit. */
	private applyCached(file: TFile, langs: string): boolean {
		const cached = this.cache.get(file.path, file.stat.mtime, file.stat.size, langs);
		if (cached === null) return false;
		this.apply(file, cached);
		return true;
	}

	private queueImage(file: TFile, langs: string, priority: "high" | "low"): void {
		this.queue.push(
			file.path,
			async () => {
				if (!(await this.assetsReady()) || !this.isCurrent(file)) return;
				const version = { mtime: file.stat.mtime, size: file.stat.size };
				const url = this.app.vault.getResourcePath(file);
				const service = await this.getService();
				const text = await service.recognize(url, langs);
				this.store(file, version, langs, text);
			},
			priority,
		);
	}

	private queuePdf(file: TFile, priority: "high" | "low"): void {
		this.queue.push(
			file.path,
			async () => {
				if (!this.isCurrent(file)) return;
				const version = { mtime: file.stat.mtime, size: file.stat.size };
				const text = await this.extractPdfText(file);
				if (text === null) return; // transient failure: do not cache
				this.store(file, version, "pdf", text);
			},
			priority,
		);
	}

	/** Still the live file at its path (not deleted/replaced), not unloaded. */
	private isCurrent(file: TFile): boolean {
		return !this.destroyed && this.app.vault.getFileByPath(file.path) === file;
	}

	/**
	 * Cache + apply a finished extraction — unless the file vanished, or it
	 * changed while we were reading it: then the text belongs to an older
	 * version, so re-queue instead of caching it under the new mtime.
	 */
	private store(
		file: TFile,
		version: { mtime: number; size: number },
		langs: string,
		text: string,
	): void {
		if (!this.isCurrent(file)) return;
		if (file.stat.mtime !== version.mtime || file.stat.size !== version.size) {
			// The job's key is released right after this run — retry then.
			window.setTimeout(() => this.consider(file, "high"), 0);
			return;
		}
		const capped = text.slice(0, MAX_EXTRACTED_CHARS);
		this.cache.set(file.path, { ...version, langs, text: capped });
		this.apply(file, capped);
		// One write per batch, not one full JSON rewrite per job (that was
		// O(n²) bytes over a large first OCR run).
		this.saveCacheSoon();
		if (++this.unsavedJobs >= CACHE_FLUSH_EVERY) this.saveCacheSoon.run();
	}

	private readonly saveCacheSoon = debounce(
		() => {
			this.unsavedJobs = 0;
			void this.cache.save();
		},
		CACHE_SAVE_DEBOUNCE_MS,
		true,
	);

	/**
	 * Text layer of a PDF via Obsidian's bundled pdf.js. Returns null on a
	 * transient failure (not cached → retried on a later start), "" for
	 * PDFs that simply have no extractable text (scans, encrypted, too big).
	 */
	private async extractPdfText(file: TFile): Promise<string | null> {
		const maxBytes = Platform.isMobile ? MAX_PDF_BYTES_MOBILE : MAX_PDF_BYTES_DESKTOP;
		if (file.stat.size > maxBytes) return "";
		let task: { destroy(): Promise<void> | void } | null = null;
		try {
			const pdfjs = (await loadPdfJs()) as {
				getDocument(options: { data: ArrayBuffer }): {
					promise: Promise<{
						numPages: number;
						getPage(n: number): Promise<{
							getTextContent(): Promise<{ items: Array<{ str?: string }> }>;
							cleanup?(): void;
						}>;
					}>;
					destroy(): Promise<void> | void;
				};
			};
			const data = await this.app.vault.readBinary(file);
			if (this.destroyed) return null;
			const loading = pdfjs.getDocument({ data });
			task = loading;
			const doc = await loading.promise;
			const parts: string[] = [];
			let length = 0;
			const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
			for (let n = 1; n <= pages && length < MAX_EXTRACTED_CHARS && !this.destroyed; n++) {
				const page = await doc.getPage(n);
				const content = await page.getTextContent();
				const pageText = content.items
					.map((item) => item.str ?? "")
					.join(" ")
					.trim();
				page.cleanup?.();
				parts.push(pageText);
				length += pageText.length;
			}
			return parts.join("\n").trim();
		} catch (error) {
			// Encrypted PDFs fail the same way every time — cache as empty.
			if (error instanceof Error && error.name === "PasswordException") return "";
			return null;
		} finally {
			// Frees the pdf.js worker-side document (memory leak otherwise).
			await Promise.resolve(task?.destroy()).catch(() => undefined);
		}
	}

	/** Push extracted text into the index and schedule persistence. */
	private apply(file: TFile, text: string): void {
		this.engine.upsert(attachmentDoc(file, text.slice(0, MAX_EXTRACTED_CHARS)));
		this.onApplied(file.path, file.stat.mtime);
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
