import { PluginSettingTab, Setting, type App, type Plugin } from "obsidian";

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
}

export class SearchosaurusSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly host: SettingsHost,
	) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.host.settings;

		const save = async () => {
			await this.host.saveSettings();
			this.host.onSettingsChanged();
		};

		new Setting(containerEl)
			.setName("Hotkey")
			.setDesc(
				'Searchosaurus ships without a default hotkey. Bind "Searchosaurus: Open search" under Settings → Hotkeys — Cmd/Ctrl+F (replacing "Search current file") or Cmd/Ctrl+Shift+F work well.',
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("One folder path per line. Files under these paths are not indexed.")
			.addTextArea((text) =>
				text
					.setPlaceholder("templates/\narchive/")
					.setValue(settings.excludedFolders.join("\n"))
					.onChange(async (value) => {
						settings.excludedFolders = value
							.split("\n")
							.map((line) => line.trim())
							.filter((line) => line.length > 0);
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Result limit")
			.setDesc("Maximum number of results shown at once.")
			.addSlider((slider) =>
				slider
					.setLimits(10, 200, 10)
					.setValue(settings.resultLimit)
					.setDynamicTooltip()
					.onChange(async (value) => {
						settings.resultLimit = value;
						await save();
					}),
			);

		// OCR settings land with the OCR milestone; keeping the tab minimal
		// until the toggle can actually download assets and run.
	}
}
