import { normalizePath, type App } from "obsidian";
import { mergeCacheEntries } from "../core/merge-data";

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
	/** Paths dropped here since the last write — the disk merge skips them. */
	private readonly removed = new Set<string>();

	constructor(
		private readonly app: App,
		manifestDir: string,
	) {
		this.path = normalizePath(`${manifestDir}/ocr-cache.json`);
	}

	private readonly path: string;

	async load(): Promise<void> {
		// Merge instead of replace — tolerant of sync-merged files.
		this.entries = { ...(await this.readDisk()), ...this.entries };
	}

	/** Entries currently in the file; {} when missing or corrupt. */
	private async readDisk(): Promise<Record<string, OcrCacheEntry>> {
		try {
			if (!(await this.app.vault.adapter.exists(this.path))) return {};
			const raw = JSON.parse(await this.app.vault.adapter.read(this.path)) as CacheFileShape;
			return raw.entries ?? {};
		} catch {
			return {}; // Corrupt cache = cold cache. Never fatal.
		}
	}

	/**
	 * Drop entries whose file no longer exists (deleted while the plugin
	 * was not running). Returns how many were removed.
	 */
	prune(exists: (path: string) => boolean): number {
		let removed = 0;
		for (const path of Object.keys(this.entries)) {
			if (exists(path)) continue;
			delete this.entries[path];
			this.removed.add(path);
			removed += 1;
		}
		if (removed > 0) this.dirty = true;
		return removed;
	}

	get(path: string, mtime: number, size: number, langs: string): string | null {
		const entry = this.entries[path];
		if (!entry) return null;
		if (entry.mtime !== mtime || entry.size !== size || entry.langs !== langs) return null;
		return entry.text;
	}

	/** Cached text for this file version, whatever language combo. */
	peek(path: string, mtime: number, size: number): string | null {
		const entry = this.entries[path];
		if (!entry || entry.mtime !== mtime || entry.size !== size) return null;
		return entry.text;
	}

	set(path: string, entry: OcrCacheEntry): void {
		this.entries[path] = entry;
		this.removed.delete(path);
		this.dirty = true;
	}

	remove(path: string): void {
		if (path in this.entries) {
			delete this.entries[path];
			this.removed.add(path);
			this.dirty = true;
		}
	}

	rename(oldPath: string, newPath: string): void {
		const entry = this.entries[oldPath];
		if (!entry) return;
		delete this.entries[oldPath];
		this.removed.add(oldPath);
		this.entries[newPath] = entry;
		this.removed.delete(newPath);
		this.dirty = true;
	}

	async save(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		try {
			// Other devices write this file too (file-based sync): fold in
			// what they added since we loaded it instead of overwriting it.
			const written = new Set(this.removed);
			const disk = await this.readDisk();
			this.entries = mergeCacheEntries(this.entries, disk, this.removed);
			const shape: CacheFileShape = { version: 1, entries: this.entries };
			await this.app.vault.adapter.write(this.path, JSON.stringify(shape));
			for (const path of written) this.removed.delete(path);
		} catch {
			this.dirty = true; // retry on the next save
		}
	}
}
