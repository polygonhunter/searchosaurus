import { Keymap, setIcon, SuggestModal, type App } from "obsidian";
import type { SearchEngine } from "../core/engine";
import type { SearchHit } from "../core/types";
import type { SearchosaurusSettings } from "../settings";
import { iconForKind } from "./icons";

/**
 * The Searchosaurus prompt. Deliberately minimal chrome: input, results,
 * nothing else — every power feature stays behind the keyboard
 * (progressive disclosure is the plugin's core design rule).
 */
export class SearchosaurusModal extends SuggestModal<SearchHit> {
	constructor(
		app: App,
		private readonly engine: SearchEngine,
		private readonly getSettings: () => SearchosaurusSettings,
	) {
		super(app);
		this.modalEl.addClass("searchosaurus-modal");
		this.setPlaceholder("Search your vault…");
		this.emptyStateText = "No matches.";
		this.limit = getSettings().resultLimit;
	}

	getSuggestions(query: string): SearchHit[] {
		const text = query.trim();
		if (text.length === 0) return [];
		// Interim ranking: raw BM25 with title boosts, mtime as tiebreak.
		// The deterministic exact/prefix title tier lands with core/rank.ts.
		return this.engine
			.search(text)
			.sort((a, b) => b.score - a.score || b.mtime - a.mtime)
			.slice(0, this.getSettings().resultLimit);
	}

	renderSuggestion(hit: SearchHit, el: HTMLElement): void {
		el.addClass("searchosaurus-result");
		const iconEl = el.createDiv({ cls: "searchosaurus-result-icon" });
		setIcon(iconEl, iconForKind(hit.kind));
		const textEl = el.createDiv({ cls: "searchosaurus-result-text" });
		textEl.createDiv({ cls: "searchosaurus-result-title", text: hit.basename });
		const secondary = hit.kind === "link" ? (hit.url ?? "") : parentFolder(hit.path);
		if (secondary.length > 0) {
			textEl.createDiv({ cls: "searchosaurus-result-secondary", text: secondary });
		}
	}

	onChooseSuggestion(hit: SearchHit, evt: MouseEvent | KeyboardEvent): void {
		if (hit.kind === "link" && hit.url && Keymap.isModEvent(evt)) {
			window.open(hit.url);
			return;
		}
		void this.app.workspace.openLinkText(hit.path, "", Keymap.isModEvent(evt));
	}
}

function parentFolder(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}
