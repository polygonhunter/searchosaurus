import { normalizePath, type App } from "obsidian";

export interface OcrCacheEntry {
	mtime: number;
	size: number;
	/** Language combo the text was recognized with, e.g. "deu+eng". */
	langs: string;
	text: string;
}

interface CacheFileShape {
	version: number;
	entries: Record<string, OcrCacheEntry>;
}

/**
 * Extracted-text cache as one JSON file in the plugin dir — deliberately
 * synced, so a second device never re-runs OCR. Merge-tolerant on load
 * (sync conflicts at worst cost one redundant recognition, never data).
 */
export class OcrCache {
	private entries: Record<string, OcrCacheEntry> = {};
	private dirty = false;

	constructor(
		private readonly app: App,
		manifestDir: string,
	) {
		this.path = normalizePath(`${manifestDir}/ocr-cache.json`);
	}

	private readonly path: string;

	async load(): Promise<void> {
		try {
			if (!(await this.app.vault.adapter.exists(this.path))) return;
			const raw = JSON.parse(await this.app.vault.adapter.read(this.path)) as CacheFileShape;
			// Merge instead of replace — tolerant of sync-merged files.
			this.entries = { ...raw.entries, ...this.entries };
		} catch {
			// Corrupt cache = cold cache. Never fatal.
		}
	}

	get(path: string, mtime: number, size: number, langs: string): string | null {
		const entry = this.entries[path];
		if (!entry) return null;
		if (entry.mtime !== mtime || entry.size !== size || entry.langs !== langs) return null;
		return entry.text;
	}

	set(path: string, entry: OcrCacheEntry): void {
		this.entries[path] = entry;
		this.dirty = true;
	}

	remove(path: string): void {
		if (path in this.entries) {
			delete this.entries[path];
			this.dirty = true;
		}
	}

	rename(oldPath: string, newPath: string): void {
		const entry = this.entries[oldPath];
		if (!entry) return;
		delete this.entries[oldPath];
		this.entries[newPath] = entry;
		this.dirty = true;
	}

	async save(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		try {
			const shape: CacheFileShape = { version: 1, entries: this.entries };
			await this.app.vault.adapter.write(this.path, JSON.stringify(shape));
		} catch {
			this.dirty = true; // retry on the next save
		}
	}
}
