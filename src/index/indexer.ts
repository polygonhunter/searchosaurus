import { debounce, TFile, type App, type Plugin } from "obsidian";
import type { SearchEngine } from "../core/engine";
import { isPathExcluded } from "../core/paths";
import type { SearchosaurusSettings } from "../settings";
import { extractDocs } from "./content";
import { IndexPersistence } from "./persistence";
import type { FieldWeights } from "../core/types";

/** Files (re)indexed per chunk before yielding back to the UI thread. */
const CHUNK_SIZE = 20;
/** Snapshot after this much quiet… */
const SAVE_DEBOUNCE_MS = 60_000;
/** …but never let changes sit unsaved longer than this. */
const SAVE_MAX_WAIT_MS = 5 * 60_000;
/** Checkpoint the initial build every N files (crash/quit safety). */
const CHECKPOINT_EVERY = 2_000;

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
	/** attachmentPath → mtime whose extracted text is in the index. */
	private readonly extracted = new Map<string, number>();
	private readonly queue: string[] = [];
	private readonly queued = new Set<string>();
	private processing = false;
	private stopped = false;
	/** False during the initial build — extraction jobs queue at low prio. */
	private initialBuildDone = false;
	/** Index changed since the last snapshot. */
	private dirty = false;
	/** When the oldest unsaved change happened (max-wait anchor). */
	private dirtySince: number | null = null;

	/** True while the initial build/diff still has queued work. */
	get busy(): boolean {
		return this.queue.length > 0 || this.processing;
	}

	constructor(
		private readonly app: App,
		private readonly engine: SearchEngine,
		private readonly weights: FieldWeights,
		private readonly getSettings: () => SearchosaurusSettings,
		/** Attachment hook: the OCR/PDF pipeline decides what to extract. */
		private readonly onAttachment?: (file: TFile, priority: "high" | "low") => void,
		/** A path left the index (deleted/excluded): drop pending extraction. */
		private readonly onForget?: (path: string) => void,
	) {
		// appId is undocumented but stable — used to key the per-vault cache.
		const appId = (app as unknown as { appId?: string }).appId ?? "default";
		this.persistence = new IndexPersistence(appId);
	}

	/** Load cache, diff against the vault, wire events. Call onLayoutReady. */
	async start(plugin: Plugin): Promise<void> {
		const persisted = await this.persistence.load(this.weights);
		// Unloaded while IndexedDB was loading: do not wire events anymore.
		if (this.stopped) return;
		if (persisted) {
			try {
				this.engine.load(persisted.indexJson);
				for (const [path, mtime] of Object.entries(persisted.files)) {
					this.indexedFiles.set(path, mtime);
				}
				for (const [path, ids] of Object.entries(persisted.links)) {
					this.linkDocs.set(path, ids);
				}
				for (const [path, mtime] of Object.entries(persisted.extracted ?? {})) {
					this.extracted.set(path, mtime);
				}
			} catch {
				this.engine.clear();
				this.indexedFiles.clear();
				this.linkDocs.clear();
				this.extracted.clear();
			}
		}
		this.registerEvents(plugin);
		// Window hidden / app backgrounded (mobile may be killed next).
		plugin.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "hidden") this.flush();
		});
		this.reconcile();
	}

	/**
	 * Self-heal: unchanged attachments whose OCR/PDF text never made it into
	 * the snapshot (e.g. restart mid initial build) are offered to the
	 * pipeline again — a cache hit is a cheap apply, a miss a low-prio job.
	 * Call once the pipeline has loaded its cache.
	 */
	healAttachments(): void {
		if (this.stopped) return;
		for (const file of this.app.vault.getFiles()) {
			if (file.extension === "md" || this.queued.has(file.path)) continue;
			const indexedMtime = this.indexedFiles.get(file.path);
			if (indexedMtime !== file.stat.mtime) continue; // queued/re-indexed anyway
			if (this.extracted.get(file.path) === file.stat.mtime) continue;
			this.onAttachment?.(file, "low");
		}
	}

	/** The pipeline put extracted text for this file version into the index. */
	markExtracted(path: string, mtime: number): void {
		this.extracted.set(path, mtime);
		this.saveSoon();
	}

	/** Stop processing and flush a pending snapshot instead of dropping it. */
	stop(): void {
		this.stopped = true;
		this.saveDebounced.cancel();
		this.flush();
	}

	/** Wipe everything and re-index from scratch (settings escape hatch). */
	async rebuild(): Promise<void> {
		this.queue.length = 0;
		this.queued.clear();
		this.engine.clear();
		this.indexedFiles.clear();
		this.linkDocs.clear();
		this.extracted.clear();
		await this.persistence.clear();
		this.reconcile();
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

	/**
	 * Bring the index in line with vault + settings: queue every new/stale
	 * file, drop deleted ones, and drop files that are now excluded (so a
	 * newly excluded folder vanishes from results right away).
	 */
	reconcile(): void {
		if (this.stopped) return;
		const seen = new Set<string>();
		for (const file of this.app.vault.getFiles()) {
			seen.add(file.path);
			if (this.isExcluded(file.path)) {
				if (this.indexedFiles.has(file.path) || this.queued.has(file.path)) {
					this.forget(file.path);
				}
				continue;
			}
			if (this.indexedFiles.get(file.path) !== file.stat.mtime) {
				this.enqueue(file.path);
			}
		}
		for (const path of [...this.indexedFiles.keys()]) {
			if (!seen.has(path)) this.forget(path);
		}
	}

	private isExcluded(path: string): boolean {
		return isPathExcluded(path, this.getSettings().excludedFolders);
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
		this.extracted.delete(path);
		if (this.queued.delete(path)) {
			const index = this.queue.indexOf(path);
			if (index >= 0) this.queue.splice(index, 1);
		}
		this.onForget?.(path);
		this.saveSoon();
	}

	private async processQueue(): Promise<void> {
		if (this.processing) return;
		this.processing = true;
		try {
			let sinceYield = 0;
			let sinceCheckpoint = 0;
			while (this.queue.length > 0 && !this.stopped) {
				const path = this.queue.shift();
				if (path === undefined) break;
				this.queued.delete(path);
				await this.indexPath(path);
				if (!this.initialBuildDone && ++sinceCheckpoint >= CHECKPOINT_EVERY) {
					sinceCheckpoint = 0;
					this.flush();
				}
				if (++sinceYield >= CHUNK_SIZE) {
					sinceYield = 0;
					await new Promise((resolve) => window.setTimeout(resolve, 0));
				}
			}
		} finally {
			this.processing = false;
		}
		const firstBuild = !this.initialBuildDone;
		this.initialBuildDone = true;
		if (this.stopped || !this.dirty) return;
		if (firstBuild) {
			// The initial build is the expensive one — persist it right away.
			this.saveDebounced.cancel();
			this.flush();
		} else {
			this.saveSoon();
		}
	}

	private async indexPath(path: string): Promise<void> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;
		try {
			const docs = await extractDocs(this.app, file);
			// Deleted/renamed while reading: the event handlers own it now.
			if (this.stopped || this.app.vault.getFileByPath(path) !== file) return;
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
			this.dirty = true;
			if (docs[0] && docs[0].kind !== "note") {
				// The doc was just replaced without text; the pipeline re-applies.
				this.extracted.delete(file.path);
				this.onAttachment?.(file, this.initialBuildDone ? "high" : "low");
			}
		} catch (error) {
			console.error(`Searchosaurus: failed to index ${path}`, error);
		}
	}

	/**
	 * Mark the index dirty and schedule a snapshot. Serializing a large
	 * index is real main-thread work, so it waits for a quiet minute —
	 * with a max-wait so steady editing still gets persisted.
	 */
	private saveSoon(): void {
		this.dirty = true;
		const now = Date.now();
		this.dirtySince ??= now;
		if (now - this.dirtySince >= SAVE_MAX_WAIT_MS) {
			this.saveDebounced.cancel();
			this.flush();
			return;
		}
		this.saveDebounced();
	}

	private readonly saveDebounced = debounce(() => this.flush(), SAVE_DEBOUNCE_MS, true);

	/** Write the snapshot now, if anything changed since the last one. */
	private flush(): void {
		if (!this.dirty) return;
		this.dirty = false;
		this.dirtySince = null;
		void this.persistence.save(
			this.weights,
			this.engine.toJSON(),
			Object.fromEntries(this.indexedFiles),
			Object.fromEntries(this.linkDocs),
			Object.fromEntries(this.extracted),
		);
	}
}
