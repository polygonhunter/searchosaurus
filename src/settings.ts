import {
	AbstractInputSuggest,
	Platform,
	PluginSettingTab,
	Setting,
	type App,
	type Plugin,
	type TFolder,
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

/** Vault-folder autocomplete for a plain text/search input. */
class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private readonly textInputEl: HTMLInputElement,
	) {
		super(app, textInputEl);
	}

	protected getSuggestions(query: string): TFolder[] {
		const needle = query.toLowerCase();
		return this.app.vault
			.getAllFolders(false)
			.filter((folder) => folder.path.toLowerCase().includes(needle))
			.slice(0, 20);
	}

	renderSuggestion(folder: TFolder, el: HTMLElement): void {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder): void {
		this.setValue(folder.path);
		// Notify the owning component's onChange (it listens for input).
		this.textInputEl.dispatchEvent(new Event("input"));
		this.close();
	}
}

/**
 * Imperative settings tab — deliberately NOT the 1.13 declarative API, so
 * one code path serves every app version from minAppVersion up. The folder
 * picker is hand-rolled on AbstractInputSuggest (available since 1.4).
 */
export class SearchosaurusSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly host: SettingsHost,
	) {
		super(app, host);
	}

	private async persist(): Promise<void> {
		await this.host.saveSettings();
		this.host.onSettingsChanged();
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const settings = this.host.settings;

		new Setting(containerEl)
			.setName("Hotkey")
			.setDesc(
				'Searchosaurus ships without a default hotkey. Bind "Searchosaurus: Open search" under Settings → Hotkeys — Cmd/Ctrl+F (replacing "Search current file") or Cmd/Ctrl+Shift+F work well.',
			);

		new Setting(containerEl)
			.setName("Result limit")
			.setDesc("Maximum number of results shown at once.")
			.addSlider((slider) =>
				slider
					.setLimits(10, 200, 10)
					.setValue(settings.resultLimit)
					.onChange(async (value) => {
						settings.resultLimit = value;
						await this.persist();
					}),
			);

		new Setting(containerEl).setName("Excluded folders").setHeading();

		settings.excludedFolders.forEach((folderPath, index) => {
			new Setting(containerEl)
				.addSearch((search) => {
					search.setPlaceholder("Choose a folder…").setValue(folderPath);
					new FolderSuggest(this.app, search.inputEl);
					search.onChange(async (value) => {
						settings.excludedFolders[index] = value.trim();
						await this.persist();
					});
				})
				.addExtraButton((button) =>
					button
						.setIcon("x")
						.setTooltip("Remove")
						.onClick(async () => {
							settings.excludedFolders.splice(index, 1);
							await this.persist();
							this.display();
						}),
				);
		});

		new Setting(containerEl)
			.setDesc(
				settings.excludedFolders.length === 0
					? "No folders excluded — the whole vault is indexed."
					: "",
			)
			.addButton((button) =>
				button.setButtonText("Exclude folder").onClick(() => {
					settings.excludedFolders.push("");
					this.display();
				}),
			);

		new Setting(containerEl).setName("Text extraction").setHeading();

		new Setting(containerEl)
			.setName("Search text in images (OCR)")
			.setDesc(
				Platform.isDesktop
					? "Runs fully offline. Enabling downloads the recognition models (~8 MB) once from the plugin's GitHub release; images are then processed in the background and cached."
					: "OCR runs on desktop only. Results synced from a desktop device are still searchable here.",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(settings.ocrEnabled)
					.setDisabled(!Platform.isDesktop)
					.onChange(async (value) => {
						settings.ocrEnabled = value;
						await this.persist();
					}),
			);

		new Setting(containerEl)
			.setName("OCR languages")
			.setDesc("Which recognition models to use for images.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("deu+eng", "German + English")
					.addOption("deu", "German")
					.addOption("eng", "English")
					.setValue(settings.ocrLanguages.join("+"))
					.onChange(async (value) => {
						settings.ocrLanguages = value.split("+");
						await this.persist();
					}),
			);

		new Setting(containerEl)
			.setName("Index PDF text")
			.setDesc("Extract the text layer of PDFs so their content is searchable.")
			.addToggle((toggle) =>
				toggle.setValue(settings.indexPdfText).onChange(async (value) => {
					settings.indexPdfText = value;
					await this.persist();
				}),
			);

		new Setting(containerEl).setName("Maintenance").setHeading();

		new Setting(containerEl)
			.setName("Rebuild search index")
			.setDesc(
				"Drops the cached index and re-reads the whole vault. Use after bulk changes outside Obsidian or if results ever look stale.",
			)
			.addButton((button) =>
				button.setButtonText("Rebuild").onClick(async () => {
					button.setDisabled(true).setButtonText("Rebuilding…");
					await this.host.rebuildIndex();
					button.setDisabled(false).setButtonText("Rebuild");
				}),
			);
	}
}
