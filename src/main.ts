import { debounce, Notice, Platform, Plugin } from "obsidian";
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

	async onload(): Promise<void> {
		await this.loadSettings();

		this.pipeline = new OcrPipeline(
			this.app,
			this.engine,
			() => this.settings,
			this.manifest.dir ?? "",
			() => this.indexer?.persistSoon(),
		);
		this.indexer = new Indexer(
			this.app,
			this.engine,
			DEFAULT_WEIGHTS,
			() => this.settings,
			(file, priority) => this.pipeline?.consider(file, priority),
		);

		const openSearch = () => {
			// Deferred a tick: command pickers and the mobile Quick Action
			// overlay dismiss themselves right after invoking a command and
			// would sweep a synchronously opened modal away with them.
			window.setTimeout(() => {
				try {
					new SearchosaurusModal(this.app, {
						engine: this.engine,
						settings: () => this.settings,
						data: this.data,
						saveDataSoon: () => this.saveDataSoon(),
					}).open();
				} catch (error) {
					console.error("Searchosaurus: failed to open search", error);
					new Notice(
						`Searchosaurus: failed to open search — ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}, 0);
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
				await this.pipeline?.init(this);
				await this.indexer?.start(this);
			})();
		});
	}

	onunload(): void {
		this.indexer?.stop();
		this.indexer = null;
		void this.pipeline?.destroy();
		this.pipeline = null;
	}

	/** Called by the settings tab after any change. */
	onSettingsChanged(): void {
		if (this.settings.ocrEnabled && Platform.isDesktop) {
			// One-time asset download, then sweep existing images/PDFs.
			void ensureAssets(this.app, this.manifest.dir ?? "").then((ok) => {
				if (ok) this.pipeline?.scanVault();
			});
		} else if (this.settings.indexPdfText) {
			this.pipeline?.scanVault();
		}
	}

	async rebuildIndex(): Promise<void> {
		await this.indexer?.rebuild();
		this.pipeline?.scanVault();
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Partial<StoredShape> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(raw?.settings ?? {}) };
		this.data = { ...structuredClone(DEFAULT_DATA), ...(raw?.data ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ settings: this.settings, data: this.data } satisfies StoredShape);
	}

	readonly saveDataSoon = debounce(() => void this.saveSettings(), 2_000, true);
}
