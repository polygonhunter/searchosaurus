import { debounce, TFile, type App, type Plugin } from "obsidian";
import type { SearchEngine } from "../core/engine";
import type { SearchosaurusSettings } from "../settings";
import { extractDocs } from "./content";
import { IndexPersistence } from "./persistence";
import type { FieldWeights } from "../core/types";

/** Files (re)indexed per chunk before yielding back to the UI thread. */
const CHUNK_SIZE = 20;

/**
 * Owns the index lifecycle: cached-startup load, mtime diff, chunked build,
 * and incremental updates from vault/metadataCache events. The engine stays
 * pure; this class is the only place that talks to the vault.
 */
export class Indexer {
	private readonly persistence: IndexPersistence;
	/** path → mtime of everything currently in the index. */
	private readonly indexedFiles = new Map<string, number>();
	/** notePath → ids of its link docs (discarded when the note changes). */
	private readonly linkDocs = new Map<string, string[]>();
	private readonly queue: string[] = [];
	private readonly queued = new Set<string>();
	private processing = false;
	private stopped = false;

	/** True while the initial build/diff still has queued work. */
	get busy(): boolean {
		return this.queue.length > 0 || this.processing;
	}

	constructor(
		private readonly app: App,
		private readonly engine: SearchEngine,
		private readonly weights: FieldWeights,
		private readonly getSettings: () => SearchosaurusSettings,
	) {
		// appId is undocumented but stable — used to key the per-vault cache.
		const appId = (app as unknown as { appId?: string }).appId ?? "default";
		this.persistence = new IndexPersistence(appId);
	}

	/** Load cache, diff against the vault, wire events. Call onLayoutReady. */
	async start(plugin: Plugin): Promise<void> {
		const persisted = await this.persistence.load(this.weights);
		if (persisted) {
			try {
				this.engine.load(persisted.indexJson);
				for (const [path, mtime] of Object.entries(persisted.files)) {
					this.indexedFiles.set(path, mtime);
				}
				for (const [path, ids] of Object.entries(persisted.links)) {
					this.linkDocs.set(path, ids);
				}
			} catch {
				this.engine.clear();
				this.indexedFiles.clear();
				this.linkDocs.clear();
			}
		}
		this.registerEvents(plugin);
		this.diffVault();
	}

	stop(): void {
		this.stopped = true;
		this.saveSoon.cancel();
	}

	/** Wipe everything and re-index from scratch (settings escape hatch). */
	async rebuild(): Promise<void> {
		this.queue.length = 0;
		this.queued.clear();
		this.engine.clear();
		this.indexedFiles.clear();
		this.linkDocs.clear();
		await this.persistence.clear();
		this.diffVault();
	}

	private registerEvents(plugin: Plugin): void {
		// Markdown: 'changed' fires once Obsidian has re-parsed the cache —
		// the right moment to pick up headings/aliases/tags along with body.
		plugin.registerEvent(
			this.app.metadataCache.on("changed", (file) => {
				if (file instanceof TFile) this.enqueue(file.path);
			}),
		);
		// Attachments have no metadata cache; watch the vault directly.
		plugin.registerEvent(
			this.app.vault.on("create", (file) => {
				if (file instanceof TFile && file.extension !== "md") this.enqueue(file.path);
			}),
		);
		plugin.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (file instanceof TFile && file.extension !== "md") this.enqueue(file.path);
			}),
		);
		plugin.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (file instanceof TFile) this.forget(file.path);
			}),
		);
		plugin.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.forget(oldPath);
				if (file instanceof TFile) this.enqueue(file.path);
			}),
		);
	}

	/** Queue every new/stale file; drop deleted ones from the index. */
	private diffVault(): void {
		const seen = new Set<string>();
		for (const file of this.app.vault.getFiles()) {
			seen.add(file.path);
			if (this.isExcluded(file.path)) continue;
			if (this.indexedFiles.get(file.path) !== file.stat.mtime) {
				this.enqueue(file.path);
			}
		}
		for (const path of [...this.indexedFiles.keys()]) {
			if (!seen.has(path)) this.forget(path);
		}
	}

	private isExcluded(path: string): boolean {
		return this.getSettings().excludedFolders.some((folder) => path.startsWith(folder));
	}

	private enqueue(path: string): void {
		if (this.isExcluded(path) || this.queued.has(path)) return;
		this.queued.add(path);
		this.queue.push(path);
		void this.processQueue();
	}

	private forget(path: string): void {
		this.engine.remove(path);
		for (const id of this.linkDocs.get(path) ?? []) this.engine.remove(id);
		this.linkDocs.delete(path);
		this.indexedFiles.delete(path);
		this.queued.delete(path);
		this.saveSoon();
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			let sinceYield = 0;
			while (this.queue.length > 0 && !this.stopped) {
				const path = this.queue.shift();
				if (path === undefined) break;
				this.queued.delete(path);
				await this.indexPath(path);
				if (++sinceYield >= CHUNK_SIZE) {
					sinceYield = 0;
					await new Promise((resolve) => setTimeout(resolve, 0));
				}
			}
		} finally {
			this.processing = false;
		}
		if (!this.stopped) this.saveSoon();
	}

	private async indexPath(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		try {
			const docs = await extractDocs(this.app, file);
			const newLinkIds = new Set(
				docs.filter((doc) => doc.kind === "link").map((doc) => doc.id),
			);
			// Drop link docs of URLs that no longer exist in the note.
			for (const id of this.linkDocs.get(file.path) ?? []) {
				if (!newLinkIds.has(id)) this.engine.remove(id);
			}
			for (const doc of docs) {
				this.engine.upsert(doc);
			}
			this.linkDocs.set(file.path, [...newLinkIds]);
			this.indexedFiles.set(file.path, file.stat.mtime);
		} catch (error) {
			console.error(`Searchosaurus: failed to index ${path}`, error);
		}
	}

	/** Persisting is cheap but not free — debounce behind quiet periods. */
	private readonly saveSoon = debounce(
		() => {
			void this.persistence.save(
				this.weights,
				this.engine.toJSON(),
				Object.fromEntries(this.indexedFiles),
				Object.fromEntries(this.linkDocs),
			);
		},
		10_000,
		true,
	);
}
