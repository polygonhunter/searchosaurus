import { Notice, normalizePath, requestUrl, type App } from "obsidian";
import { unzipSync } from "fflate";

/**
 * OCR runtime assets (~8 MB: tesseract worker, WASM core, deu/eng
 * traineddata). Far too big to bundle into main.js — downloaded ONCE from a
 * pinned release of this repo into <plugin>/assets/, which also syncs them
 * to other devices. Fully offline afterwards.
 */

export const ASSET_FILES = [
	"worker.min.js",
	"tesseract-core-simd-lstm.wasm.js",
	"deu.traineddata.gz",
	"eng.traineddata.gz",
] as const;

const ASSET_RELEASE_URL =
	"https://github.com/polygonhunter/searchosaurus/releases/download/ocr-assets-v1/searchosaurus-ocr-assets.zip";

/**
 * Pin before every ocr-assets release: sha256 of the zip. Empty string
 * skips verification (dev builds, where esbuild pre-copies the files).
 */
const ASSET_SHA256 = "003c3b91961e3275c83f4e1e8e8f27dc1537999e6015adf24b7a65e6ea81ef61";

export function assetDir(manifestDir: string): string {
	return normalizePath(`${manifestDir}/assets`);
}

export async function assetsPresent(app: App, manifestDir: string): Promise<boolean> {
	const dir = assetDir(manifestDir);
	for (const file of ASSET_FILES) {
		if (!(await app.vault.adapter.exists(normalizePath(`${dir}/${file}`)))) return false;
	}
	return true;
}

/** Download + unzip + verify into the plugin dir. Throws on failure. */
export async function downloadAssets(app: App, manifestDir: string): Promise<void> {
	const notice = new Notice("Searchosaurus: downloading OCR assets…", 0);
	try {
		const response = await requestUrl({ url: ASSET_RELEASE_URL, method: "GET" });
		const zipData = new Uint8Array(response.arrayBuffer);

		if (ASSET_SHA256.length > 0) {
			const digest = await crypto.subtle.digest("SHA-256", zipData);
			const hex = [...new Uint8Array(digest)]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join("");
			if (hex !== ASSET_SHA256) {
				throw new Error("OCR asset checksum mismatch");
			}
		}

		const files = unzipSync(zipData);
		const dir = assetDir(manifestDir);
		if (!(await app.vault.adapter.exists(dir))) {
			await app.vault.adapter.mkdir(dir);
		}
		for (const name of ASSET_FILES) {
			const content = files[name];
			if (!content) throw new Error(`OCR asset bundle is missing ${name}`);
			await app.vault.adapter.writeBinary(
				normalizePath(`${dir}/${name}`),
				content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer,
			);
		}
		notice.setMessage("Searchosaurus: OCR ready.");
		window.setTimeout(() => notice.hide(), 3000);
	} catch (error) {
		notice.hide();
		new Notice(
			"Searchosaurus: OCR asset download failed. Check your connection and try again from the settings.",
			8000,
		);
		throw error;
	}
}

/** Ensure assets exist, downloading if needed. Returns success. */
export async function ensureAssets(app: App, manifestDir: string): Promise<boolean> {
	if (await assetsPresent(app, manifestDir)) return true;
	try {
		await downloadAssets(app, manifestDir);
		return true;
	} catch {
		return false;
	}
}

/** app:// URL for an asset file, query-string stripped (tesseract appends). */
export function assetUrl(app: App, manifestDir: string, file: string): string {
	const resource = app.vault.adapter.getResourcePath(
		normalizePath(`${assetDir(manifestDir)}/${file}`),
	);
	return resource.split("?")[0] ?? resource;
}
