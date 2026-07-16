import localforage from "localforage";
import { INDEX_SCHEMA_VERSION } from "../core/engine";
import type { FieldWeights } from "../core/types";

/** What we keep between sessions: the serialized index + what it covered. */
export interface PersistedIndex {
	schemaVersion: number;
	weightsHash: string;
	indexJson: string;
	/** path → mtime at index time; used to diff against the live vault. */
	files: Record<string, number>;
	/** notePath → ids of its link docs; needed to discard them on change. */
	links: Record<string, string[]>;
}

const KEY = "index";

export function weightsHash(weights: FieldWeights): string {
	return JSON.stringify(weights);
}

/**
 * Startup cache in IndexedDB (via localforage): machine-local, rebuildable,
 * deliberately NOT in the plugin dir — it would bloat every sync. Settings
 * stay in data.json; the OCR cache is its own (synced) file.
 */
export class IndexPersistence {
	private readonly store: LocalForage;

	constructor(appId: string) {
		this.store = localforage.createInstance({
			name: "searchosaurus",
			storeName: `vault_${appId.replace(/[^a-zA-Z0-9]/g, "_")}`,
		});
	}

	/** Returns null on miss or schema/weights mismatch (→ full rebuild). */
	async load(weights: FieldWeights): Promise<PersistedIndex | null> {
		try {
			const data = await this.store.getItem<PersistedIndex>(KEY);
			if (!data) return null;
			if (data.schemaVersion !== INDEX_SCHEMA_VERSION) return null;
			if (data.weightsHash !== weightsHash(weights)) return null;
			return data;
		} catch {
			return null; // corrupt cache is never fatal — rebuild instead
		}
	}

	async save(
		weights: FieldWeights,
		indexJson: string,
		files: Record<string, number>,
		links: Record<string, string[]>,
	): Promise<void> {
		try {
			await this.store.setItem<PersistedIndex>(KEY, {
				schemaVersion: INDEX_SCHEMA_VERSION,
				weightsHash: weightsHash(weights),
				indexJson,
				files,
				links,
			});
		} catch {
			// quota/private-mode failures only cost the next startup's speed
		}
	}

	async clear(): Promise<void> {
		try {
			await this.store.removeItem(KEY);
		} catch {
			// ignore
		}
	}
}
