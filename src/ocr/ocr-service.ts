import type { App } from "obsidian";
import { createWorker, OEM, type Worker } from "tesseract.js";
import { assetUrl } from "./assets";

/**
 * One persistent tesseract.js worker. Created lazily on the first job,
 * terminated on unload or language change. All runtime files load from the
 * plugin's assets dir via app:// URLs — no network after the one-time
 * download.
 */
export class OcrService {
	private worker: Worker | null = null;
	private workerLangs = "";

	constructor(
		private readonly app: App,
		private readonly manifestDir: string,
	) {}

	async recognize(imagePathOrUrl: string, langs: string): Promise<string> {
		const worker = await this.getWorker(langs);
		const result = await worker.recognize(imagePathOrUrl);
		return result.data.text.trim();
	}

	async terminate(): Promise<void> {
		const worker = this.worker;
		this.worker = null;
		this.workerLangs = "";
		if (worker) await worker.terminate().catch(() => undefined);
	}

	private async getWorker(langs: string): Promise<Worker> {
		if (this.worker && this.workerLangs === langs) return this.worker;
		await this.terminate();
		this.worker = await createWorker(langs.split("+"), OEM.LSTM_ONLY, {
			workerPath: assetUrl(this.app, this.manifestDir, "worker.min.js"),
			corePath: assetUrl(this.app, this.manifestDir, "tesseract-core-simd-lstm.wasm.js"),
			// tesseract appends `/${lang}.traineddata.gz` itself.
			langPath: assetUrl(this.app, this.manifestDir, "").replace(/\/$/, ""),
			gzip: true,
			cacheMethod: "none", // our own cache; keep IndexedDB out of it
		});
		this.workerLangs = langs;
		return this.worker;
	}
}
