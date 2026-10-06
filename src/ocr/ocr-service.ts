import type { App } from "obsidian";
import { createWorker, OEM, type Worker } from "tesseract.js";
import { assetUrl } from "./assets";

/** Idle worker is terminated after this long (~100+ MB WASM heap). */
const IDLE_TERMINATE_MS = 60_000;

/**
 * One persistent tesseract.js worker. Created lazily on the first job,
 * terminated on unload or language change. All runtime files load from the
 * plugin's assets dir via app:// URLs — no network after the one-time
 * download.
 */
export class OcrService {
	private worker: Worker | null = null;
	private workerLangs = "";
	/** After terminate(): a worker that finishes booting late is killed. */
	private destroyed = false;
	private idleTimer: number | null = null;
	/** Recognitions in flight — never terminate under a running job. */
	private busy = 0;

	constructor(
		private readonly app: App,
		private readonly manifestDir: string,
	) {}

	async recognize(imagePathOrUrl: string, langs: string): Promise<string> {
		this.clearIdleTimer();
		this.busy += 1;
		try {
			const worker = await this.getWorker(langs);
			const result = await worker.recognize(imagePathOrUrl);
			return result.data.text.trim();
		} finally {
			this.busy -= 1;
			this.armIdleTimer();
		}
	}

	/** Free the worker after a quiet minute; the next job boots a new one. */
	private armIdleTimer(): void {
		this.clearIdleTimer();
		if (this.busy > 0 || !this.worker) return;
		this.idleTimer = window.setTimeout(() => {
			this.idleTimer = null;
			if (this.busy === 0) void this.terminate();
		}, IDLE_TERMINATE_MS);
	}

	private clearIdleTimer(): void {
		if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	/** Final shutdown: terminate and refuse to spawn new workers. */
	async destroy(): Promise<void> {
		this.destroyed = true;
		await this.terminate();
	}

	async terminate(): Promise<void> {
		this.clearIdleTimer();
		const worker = this.worker;
		this.worker = null;
		this.workerLangs = "";
		if (worker) await worker.terminate().catch(() => undefined);
	}

	private async getWorker(langs: string): Promise<Worker> {
		if (this.destroyed) throw new Error("Searchosaurus: OCR service destroyed");
		if (this.worker && this.workerLangs === langs) return this.worker;
		await this.terminate();
		const worker = await createWorker(langs.split("+"), OEM.LSTM_ONLY, {
			workerPath: assetUrl(this.app, this.manifestDir, "worker.min.js"),
			corePath: assetUrl(this.app, this.manifestDir, "tesseract-core-simd-lstm.wasm.js"),
			// tesseract appends `/${lang}.traineddata.gz` itself.
			langPath: assetUrl(this.app, this.manifestDir, "").replace(/\/$/, ""),
			gzip: true,
			cacheMethod: "none", // our own cache; keep IndexedDB out of it
		});
		if (this.destroyed) {
			// Plugin unloaded while the worker was booting — do not leak it.
			await worker.terminate().catch(() => undefined);
			throw new Error("Searchosaurus: OCR service destroyed");
		}
		this.worker = worker;
		this.workerLangs = langs;
		return worker;
	}
}
