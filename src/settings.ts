import {
	Platform,
	PluginSettingTab,
	type Plugin,
	type SettingDefinitionItem,
} from "obsidian";

export interface SearchosaurusSettings {
	/** Path prefixes excluded from the index (and from OCR). */
	excludedFolders: string[];
	/** Maximum number of results rendered in the modal. */
	resultLimit: number;
	/** OCR is opt-in: enabling it triggers the one-time asset download. */
	ocrEnabled: boolean;
	/** Tesseract language packs, e.g. ["deu", "eng"]. */
	ocrLanguages: string[];
	/** Extract the text layer of PDFs into the index. */
	indexPdfText: boolean;
}

export const DEFAULT_SETTINGS: SearchosaurusSettings = {
	excludedFolders: [],
	resultLimit: 50,
	ocrEnabled: false,
	ocrLanguages: ["deu", "eng"],
	indexPdfText: true,
};

/** Structural host interface — avoids a settings.ts ↔ main.ts import cycle. */
export interface SettingsHost extends Plugin {
	settings: SearchosaurusSettings;
	saveSettings(): Promise<void>;
	/** Re-apply anything derived from settings (index filters, OCR state). */
	onSettingsChanged(): void;
	/** Drop the index and every cache, then re-index from scratch. */
	rebuildIndex(): Promise<void>;
}

/**
 * Declarative settings (Obsidian ≥ 1.13): definitions render through the
 * platform and show up in the settings search. Array-typed settings are
 * mapped to/from their control strings in get/setControlValue.
 */
export class SearchosaurusSettingTab extends PluginSettingTab {
	constructor(
		app: SettingsHost["app"],
		private readonly host: SettingsHost,
	) {
		super(app, host);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Hotkey",
				desc: 'Searchosaurus ships without a default hotkey. Bind "Searchosaurus: Open search" under Settings → Hotkeys — Cmd/Ctrl+F (replacing "Search current file") or Cmd/Ctrl+Shift+F work well.',
				aliases: ["keyboard", "shortcut"],
			},
			{
				name: "Excluded folders",
				desc: "One folder path per line. Files under these paths are not indexed.",
				control: {
					type: "textarea",
					key: "excludedFolders",
					placeholder: "templates/\narchive/",
					rows: 3,
				},
			},
			{
				name: "Result limit",
				desc: "Maximum number of results shown at once.",
				control: { type: "slider", key: "resultLimit", min: 10, max: 200, step: 10 },
			},
			{
				type: "group",
				heading: "Text extraction",
				items: [
					{
						name: "Search text in images (OCR)",
						desc: Platform.isDesktop
							? "Runs fully offline. Enabling downloads the recognition models (~8 MB) once from the plugin's GitHub release; images are then processed in the background and cached."
							: "OCR runs on desktop only. Results synced from a desktop device are still searchable here.",
						aliases: ["ocr", "tesseract", "image text"],
						control: {
							type: "toggle",
							key: "ocrEnabled",
							disabled: () => !Platform.isDesktop,
						},
					},
					{
						name: "OCR languages",
						desc: "Which recognition models to use for images.",
						control: {
							type: "dropdown",
							key: "ocrLanguages",
							options: {
								"deu+eng": "German + English",
								deu: "German",
								eng: "English",
							},
						},
					},
					{
						name: "Index PDF text",
						desc: "Extract the text layer of PDFs so their content is searchable.",
						control: { type: "toggle", key: "indexPdfText" },
					},
				],
			},
			{
				type: "group",
				heading: "Maintenance",
				items: [
					{
						name: "Rebuild search index",
						desc: "Drops the cached index and re-reads the whole vault. Use after bulk changes outside Obsidian or if results ever look stale.",
						action: () => void this.host.rebuildIndex(),
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const settings = this.host.settings;
		switch (key) {
			case "excludedFolders":
				return settings.excludedFolders.join("\n");
			case "ocrLanguages":
				return settings.ocrLanguages.join("+");
			default:
				return (settings as unknown as Record<string, unknown>)[key];
		}
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.host.settings;
		switch (key) {
			case "excludedFolders":
				settings.excludedFolders = String(value)
					.split("\n")
					.map((line) => line.trim())
					.filter((line) => line.length > 0);
				break;
			case "ocrLanguages":
				settings.ocrLanguages = String(value).split("+");
				break;
			case "resultLimit":
				settings.resultLimit = Number(value);
				break;
			case "ocrEnabled":
				settings.ocrEnabled = Boolean(value);
				break;
			case "indexPdfText":
				settings.indexPdfText = Boolean(value);
				break;
		}
		await this.host.saveSettings();
		this.host.onSettingsChanged();
	}
}
