import { Plugin } from "obsidian";
import { SearchEngine } from "./core/engine";
import { DEFAULT_WEIGHTS } from "./core/types";
import { Indexer } from "./index/indexer";
import {
	DEFAULT_SETTINGS,
	SearchosaurusSettingTab,
	type SearchosaurusSettings,
} from "./settings";
import { SearchosaurusModal } from "./ui/search-modal";

export default class SearchosaurusPlugin extends Plugin {
	settings: SearchosaurusSettings = { ...DEFAULT_SETTINGS };

	private engine: SearchEngine = new SearchEngine(DEFAULT_WEIGHTS);
	private indexer: Indexer | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.indexer = new Indexer(this.app, this.engine, DEFAULT_WEIGHTS, () => this.settings);

		this.addCommand({
			id: "open-search",
			name: "Open search",
			callback: () => {
				new SearchosaurusModal(this.app, this.engine, () => this.settings).open();
			},
		});

		this.addSettingTab(new SearchosaurusSettingTab(this.app, this));

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
		const data = (await this.loadData()) as Partial<SearchosaurusSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(data ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
