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

const STORE = "kv";
const KEY = "index";

export function weightsHash(weights: FieldWeights): string {
	return JSON.stringify(weights);
}

function asPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () =>
			reject(request.error ?? new Error("Searchosaurus: IndexedDB request failed"));
	});
}

/**
 * Startup cache in IndexedDB (a deliberately tiny hand-rolled key-value
 * wrapper — no storage library, no localStorage fallback): machine-local,
 * rebuildable, and NOT in the plugin dir — it would bloat every sync.
 * Settings stay in data.json; the OCR cache is its own (synced) file.
 */
export class IndexPersistence {
	private dbPromise: Promise<IDBDatabase> | null = null;
	private readonly dbName: string;

	constructor(appId: string) {
		this.dbName = `searchosaurus/${appId.replace(/[^a-zA-Z0-9]/g, "_")}`;
	}

	private open(): Promise<IDBDatabase> {
		if (!this.dbPromise) {
			const request = window.indexedDB.open(this.dbName, 1);
			request.onupgradeneeded = () => request.result.createObjectStore(STORE);
			this.dbPromise = asPromise(request as IDBRequest<IDBDatabase>);
		}
		return this.dbPromise;
	}

	/** Returns null on miss or schema/weights mismatch (→ full rebuild). */
	async load(weights: FieldWeights): Promise<PersistedIndex | null> {
		try {
			const db = await this.open();
			const data = (await asPromise(
				db.transaction(STORE).objectStore(STORE).get(KEY),
			)) as PersistedIndex | undefined;
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
			const payload: PersistedIndex = {
				schemaVersion: INDEX_SCHEMA_VERSION,
				weightsHash: weightsHash(weights),
				indexJson,
				files,
				links,
			};
			const db = await this.open();
			await asPromise(
				db.transaction(STORE, "readwrite").objectStore(STORE).put(payload, KEY),
			);
		} catch {
			// quota/private-mode failures only cost the next startup's speed
		}
	}

	async clear(): Promise<void> {
		try {
			const db = await this.open();
			await asPromise(db.transaction(STORE, "readwrite").objectStore(STORE).delete(KEY));
		} catch {
			// ignore
		}
	}
}
