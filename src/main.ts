import { debounce, Notice, Platform, Plugin } from "obsidian";
import { coversData, mergePersistentData } from "./core/merge-data";
import { diffSettings, snapshotSettings } from "./core/settings-diff";
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
	settings: SearchosaurusSettings = { ...DEFAULT_SETTINGS };
	data: PersistentData = structuredClone(DEFAULT_DATA);

	private engine: SearchEngine = new SearchEngine(DEFAULT_WEIGHTS);
	private indexer: Indexer | null = null;
	private pipeline: OcrPipeline | null = null;
	/** Settings as last applied — onSettingsChanged diffs against this. */
	private appliedSettings: SearchosaurusSettings = { ...DEFAULT_SETTINGS };
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
		);
		this.indexer = new Indexer(
			this.app,
			this.engine,
			DEFAULT_WEIGHTS,
			() => this.settings,
			(file, priority) => this.pipeline?.consider(file, priority),
			(path) => this.pipeline?.forget(path),
		);

		const openSearch = () => {
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
						isIndexing: () => this.indexer?.indexing ?? false,
					}).open();
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
			callback: openSearch,
		});
		// Tappable entry point — on mobile this lands in the side menu, so
		// the search is reachable without configuring anything.
		this.addRibbonIcon("search", "Searchosaurus: Open search", openSearch);

		this.addSettingTab(new SearchosaurusSettingTab(this.app, this));

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

		// Index once the workspace (and metadata cache) is ready; search is
		// usable immediately with whatever the startup cache already holds.
		this.app.workspace.onLayoutReady(() => {
			void (async () => {
				// Independent I/O (IndexedDB snapshot, ocr-cache.json): load
				// both at once. The pipeline queues consider() calls until
				// its cache is in, so nothing gets OCR'd twice.
				await Promise.all([this.pipeline?.init(this), this.indexer?.start(this)]);
				this.indexer?.healAttachments();
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
	onSettingsChanged(): void {
		const change = diffSettings(this.appliedSettings, this.settings);
		this.appliedSettings = snapshotSettings(this.settings);

		if (change.exclusions) this.reconcileSoon();
		if (change.ocrStopped) void this.pipeline?.stopOcr();
		if (change.pdfStopped) this.pipeline?.stopPdf();
		if (change.ocrStarted && Platform.isDesktop) {
			// One-time asset download, then sweep existing images/PDFs.
			void this.ensureAssetsOnce().then((ok) => {
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

	async rebuildIndex(): Promise<void> {
		await this.indexer?.rebuild();
		this.pipeline?.scanVault();
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<StoredShape> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) };
		this.data = { ...structuredClone(DEFAULT_DATA), ...(raw?.data ?? {}) };
		this.appliedSettings = snapshotSettings(this.settings);
	}

	/**
	 * data.json changed on disk (Obsidian Sync, another device). Settings
	 * follow the file; pins/frecency/history are merged so neither side's
	 * recent opens are lost. The merge is written back only if it differs
	 * from the file, so two devices converge instead of ping-ponging.
	 */
	async onExternalSettingsChange(): Promise<void> {
		const raw = (await this.loadData()) as Partial<StoredShape> | null;
		if (!raw) return;
		this.settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) };
		const remote = { ...structuredClone(DEFAULT_DATA), ...(raw.data ?? {}) };
		const merged = mergePersistentData(this.data, remote);
		// Mutate in place: open modals hold a reference to this.data.
		Object.assign(this.data, merged);
		this.onSettingsChanged();
		// Write back only if the file lacks something we have (pins/opens).
		if (!coversData(remote, merged)) this.saveDataSoon();
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ settings: this.settings, data: this.data } satisfies StoredShape);
	}

	readonly saveDataSoon = debounce(() => void this.saveSettings(), 2_000, true);
}
