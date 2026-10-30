import { debounce, Notice, Platform, Plugin } from "obsidian";
import { coversData, mergePersistentData } from "./core/merge-data";
import { diffSettings, snapshotSettings } from "./core/settings-diff";
import { queryFromSelection } from "./core/query";
import { SearchEngine } from "./core/engine";
import { bumpFrecency, pruneFrecency, renameFrecency } from "./core/frecency";
import { DEFAULT_WEIGHTS } from "./core/types";
import { DEFAULT_DATA, type PersistentData } from "./data";
import { Indexer } from "./index/indexer";
import { ensureAssets } from "./ocr/assets";
import { OcrPipeline } from "./ocr/pipeline";
import {
	DEFAULT_SETTINGS,
	SearchosaurusSettingTab,
	type SearchosaurusSettings,
} from "./settings";
import { SearchosaurusModal } from "./ui/search-modal";

/** Shape of data.json: settings plus the small synced user state. */
interface StoredShape {
	settings: SearchosaurusSettings;
	data: PersistentData;
}

export default class SearchosaurusPlugin extends Plugin {
	settings: SearchosaurusSettings = structuredClone(DEFAULT_SETTINGS);
	data: PersistentData = structuredClone(DEFAULT_DATA);

	private engine: SearchEngine = new SearchEngine(DEFAULT_WEIGHTS);
	private indexer: Indexer | null = null;
	private pipeline: OcrPipeline | null = null;
	/** Settings as last applied — onSettingsChanged diffs against this. */
	private appliedSettings: SearchosaurusSettings = structuredClone(DEFAULT_SETTINGS);
	private settingTab: SearchosaurusSettingTab | null = null;
	/** One shared in-flight asset download, however often OCR is toggled. */
	private assetsPromise: Promise<boolean> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.pipeline = new OcrPipeline(
			this.app,
			this.engine,
			() => this.settings,
			this.manifest.dir ?? "",
			(path, mtime) => this.indexer?.markExtracted(path, mtime),
			() => this.ensureAssetsOnce(),
		);
		this.indexer = new Indexer(
			this.app,
			this.engine,
			DEFAULT_WEIGHTS,
			() => this.settings,
			(file, priority) => this.pipeline?.consider(file, priority),
			(path) => this.pipeline?.forget(path),
		);

		const openSearch = (initialQuery?: string) => {
			// Deferred: command pickers and the mobile Quick Action overlay
			// dismiss themselves right after invoking a command and would
			// sweep a synchronously opened modal away with them. Mobile
			// overlays animate, so give them a real head start there.
			window.setTimeout(() => {
				try {
					new SearchosaurusModal(this.app, {
						engine: this.engine,
						settings: () => this.settings,
						data: this.data,
						saveDataSoon: () => this.saveDataSoon(),
						saveDataNow: () => {
							this.saveDataSoon();
							this.saveDataSoon.run();
						},
						isIndexing: () => this.indexer?.indexing ?? false,
						indexProgress: () => this.indexer?.progress ?? null,
						extractedText: (file) => this.pipeline?.textFor(file) ?? null,
					}, initialQuery).open();
				} catch (error) {
					console.error("Searchosaurus: failed to open search", error);
					new Notice(
						`Searchosaurus: failed to open search — ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}, Platform.isMobile ? 150 : 0);
		};

		this.addCommand({
			id: "open-search",
			name: "Open search",
			// A short selection in the editor becomes the starting query —
			// read now, before focus moves to the modal.
			callback: () => {
				const selection = this.app.workspace.activeEditor?.editor?.getSelection();
				openSearch(queryFromSelection(selection) ?? undefined);
			},
		});
		// Tappable entry point — on mobile this lands in the side menu, so
		// the search is reachable without configuring anything.
		this.addRibbonIcon("search", "Searchosaurus: Open search", () => openSearch());
		// obsidian://searchosaurus?query=… — for launchers, scripts, links.
		this.registerObsidianProtocolHandler("searchosaurus", (params) => {
			openSearch(typeof params.query === "string" ? params.query : undefined);
		});

		this.settingTab = new SearchosaurusSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Frecency: count every open; renames keep their history.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (!file) return;
				const now = Date.now();
				bumpFrecency(this.data.frecency, file.path, now);
				pruneFrecency(this.data.frecency, now);
				this.saveDataSoon();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				renameFrecency(this.data.frecency, oldPath, file.path);
				const pinIndex = this.data.pins.indexOf(oldPath);
				if (pinIndex >= 0) this.data.pins[pinIndex] = file.path;
				this.saveDataSoon();
			}),
		);
		// Deleted files (or folders) leave the launcher's pins and history.
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				const gone = (path: string) => path === file.path || path.startsWith(`${file.path}/`);
				const pins = this.data.pins.filter((path) => !gone(path));
				const stale = Object.keys(this.data.frecency).filter(gone);
				if (pins.length === this.data.pins.length && stale.length === 0) return;
				this.data.pins = pins;
				for (const path of stale) delete this.data.frecency[path];
				this.saveDataSoon();
			}),
		);

		// Index once the workspace (and metadata cache) is ready; search is
		// usable immediately with whatever the startup cache already holds.
		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				try {
					// Independent I/O (IndexedDB snapshot, ocr-cache.json): load
					// both at once. The pipeline queues consider() calls until
					// its cache is in, so nothing gets OCR'd twice.
					await Promise.all([this.pipeline?.init(this), this.indexer?.start(this)]);
					this.indexer?.healAttachments();
				} catch (error) {
					console.error("Searchosaurus: failed to start indexing", error);
				}
			})();
		});
	}

	onunload(): void {
		// Flush pending writes first — a debounced save cancelled on unload
		// would silently lose the last opens/pins and index changes.
		this.saveDataSoon.run();
		this.reconcileSoon.cancel();
		this.indexer?.stop();
		this.indexer = null;
		void this.pipeline?.destroy();
		this.pipeline = null;
	}

	/**
	 * Called by the settings tab after any change. Only does the work the
	 * actual change requires — a slider tick must not re-scan the vault.
	 */
	onSettingsChanged(source: "local" | "sync" = "local"): void {
		const change = diffSettings(this.appliedSettings, this.settings);
		this.appliedSettings = snapshotSettings(this.settings);

		if (change.exclusions) this.reconcileSoon();
		if (change.ocrStopped) void this.pipeline?.stopOcr();
		if (change.pdfStopped) this.pipeline?.stopPdf();
		if (change.ocrStarted && Platform.isDesktop) {
			// One-time asset download, then sweep existing images/PDFs.
			void this.ensureAssetsOnce().then(async (ok) => {
				if (!ok && this.settings.ocrEnabled && source === "local") {
					// Download failed (Notice already shown): switch OCR back
					// off so the toggle tells the truth and a retry is a click.
					// Never for a synced change — saving "off" would sync back
					// and switch OCR off on every device (this one is merely
					// offline); the first OCR job of the next start retries the
					// download.
					this.settings.ocrEnabled = false;
					this.appliedSettings = snapshotSettings(this.settings);
					await this.saveSettings();
					if (this.settingTab?.containerEl.isShown()) this.settingTab.display();
				}
				if ((ok && this.settings.ocrEnabled) || change.pdfStarted) this.pipeline?.scanVault();
			});
		} else if (change.pdfStarted) {
			this.pipeline?.scanVault();
		}
	}

	private ensureAssetsOnce(): Promise<boolean> {
		this.assetsPromise ??= ensureAssets(this.app, this.manifest.dir ?? "").finally(() => {
			this.assetsPromise = null;
		});
		return this.assetsPromise;
	}

	/** Folder fields fire per keystroke — reconcile once typing settles. */
	private readonly reconcileSoon = debounce(() => this.indexer?.reconcile(), 500, true);

	/** Settings escape hatch: resolves once the vault is fully re-indexed. */
	async rebuildIndex(): Promise<void> {
		const indexer = this.indexer;
		if (!indexer) return;
		// Re-indexing hands every attachment to the pipeline again (cache
		// hit → applied, miss → queued) — no separate scanVault() needed.
		await indexer.rebuild();
		new Notice(`Searchosaurus: index rebuilt — ${indexer.indexedCount.toLocaleString()} files.`);
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<StoredShape> | null;
		// Cloned: a shallow spread would share the default arrays, and the
		// settings tab edits excludedFolders in place.
		this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(raw?.settings ?? {}) };
		this.data = { ...structuredClone(DEFAULT_DATA), ...(raw?.data ?? {}) };
		this.appliedSettings = snapshotSettings(this.settings);
	}

	/**
	 * data.json changed on disk (Obsidian Sync, another device). Settings
	 * and pins follow the file; frecency/history are merged so neither
	 * side's recent opens are lost. The merge is written back only if it differs
	 * from the file, so two devices converge instead of ping-ponging.
	 */
	async onExternalSettingsChange(): Promise<void> {
		const raw = (await this.loadData()) as Partial<StoredShape> | null;
		if (!raw) return;
		// Mutate in place: an open settings tab holds a reference to
		// this.settings — a new object would swallow its later edits.
		Object.assign(this.settings, { ...structuredClone(DEFAULT_SETTINGS), ...(raw.settings ?? {}) });
		if (this.settingTab?.containerEl.isShown()) this.settingTab.display();
		const remote = { ...structuredClone(DEFAULT_DATA), ...(raw.data ?? {}) };
		const merged = mergePersistentData(this.data, remote);
		// Mutate in place: open modals hold a reference to this.data.
		Object.assign(this.data, merged);
		this.onSettingsChanged("sync");
		// Write back only if the file lacks something we have (opens).
		if (!coversData(remote, merged)) this.saveDataSoon();
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ settings: this.settings, data: this.data } satisfies StoredShape);
	}

	readonly saveDataSoon = debounce(() => void this.saveSettings(), 2_000, true);
}
