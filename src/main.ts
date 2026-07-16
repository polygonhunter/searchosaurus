import { debounce, Plugin } from "obsidian";
import { SearchEngine } from "./core/engine";
import { bumpFrecency, pruneFrecency, renameFrecency } from "./core/frecency";
import { DEFAULT_WEIGHTS } from "./core/types";
import { DEFAULT_DATA, type PersistentData } from "./data";
import { Indexer } from "./index/indexer";
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

	async onload(): Promise<void> {
		await this.loadSettings();

		this.indexer = new Indexer(this.app, this.engine, DEFAULT_WEIGHTS, () => this.settings);

		this.addCommand({
			id: "open-search",
			name: "Open search",
			callback: () => {
				new SearchosaurusModal(this.app, {
					engine: this.engine,
					settings: () => this.settings,
					data: this.data,
					saveDataSoon: () => this.saveDataSoon(),
				}).open();
			},
		});

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
			void this.indexer?.start(this);
		});
	}

	onunload(): void {
		this.indexer?.stop();
		this.indexer = null;
	}

	/** Called by the settings tab after any change. */
	onSettingsChanged(): void {
		// Exclusion/limit changes apply lazily; nothing to re-wire yet.
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
