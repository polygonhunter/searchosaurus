import { Keymap, setIcon, SuggestModal, type App, type TFile } from "obsidian";
import type { SearchEngine } from "../core/engine";
import { TITLE_FIELDS } from "../core/engine";
import { foldedWords } from "../core/normalize";
import { containsPhrase, matchesTag, parseQuery, type ParsedQuery } from "../core/query";
import { rankResults } from "../core/rank";
import { buildSnippet } from "../core/snippet";
import type { SearchHit } from "../core/types";
import type { SearchosaurusSettings } from "../settings";
import { FilterRow, type FilterState } from "./filter-row";
import { iconForKind } from "./icons";

/** How many candidates the phrase filter may lazily read from disk. */
const PHRASE_CANDIDATE_LIMIT = 200;

/**
 * The Searchosaurus prompt. Deliberately minimal chrome: input, a quiet
 * filter row, results — nothing else. Every power feature stays behind the
 * keyboard (progressive disclosure is the plugin's core design rule).
 */
export class SearchosaurusModal extends SuggestModal<SearchHit> {
	private readonly filterState: FilterState = { kind: null, sort: "relevance" };
	private filterRow: FilterRow;

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

		// Custom chrome between the (public) input container and result list.
		const row = createDiv();
		this.modalEl.insertBefore(row, this.resultContainerEl);
		this.filterRow = new FilterRow(row, this.filterState, () => this.refresh());
	}

	/** Re-run getSuggestions via the public input path (no private APIs). */
	private refresh(): void {
		this.inputEl.dispatchEvent(new Event("input"));
	}

	async getSuggestions(query: string): Promise<SearchHit[]> {
		const parsed = parseQuery(query);
		this.filterRow.reflectKind(parsed.kind);

		if (parsed.text.length === 0 && parsed.tags.length === 0) return [];

		// Typed operators search title-focused; otherwise all fields.
		const options = parsed.kind !== null ? { fields: [...TITLE_FIELDS] } : undefined;
		// Tag-only queries ("#project") search the tags field itself.
		const engineQuery = parsed.text.length > 0 ? parsed.text : parsed.tags.join(" ");
		let hits = this.engine.searchWithExcludes(engineQuery, parsed.excludes, options);

		hits = this.applyFilters(hits, parsed);
		let ranked = rankResults(hits, parsed.text, this.filterState.sort);
		if (parsed.phrases.length > 0) {
			ranked = await this.filterByPhrases(ranked, parsed.phrases);
		}
		return ranked.slice(0, this.getSettings().resultLimit);
	}

	private applyFilters(hits: SearchHit[], parsed: ParsedQuery): SearchHit[] {
		const kind = parsed.kind ?? this.filterState.kind;
		const pathPrefix = parsed.pathPrefix?.toLowerCase() ?? null;
		const cutoff =
			parsed.modifiedWithinDays !== null
				? Date.now() - parsed.modifiedWithinDays * 24 * 60 * 60 * 1000
				: null;
		return hits.filter((hit) => {
			if (kind !== null && hit.kind !== kind) return false;
			if (pathPrefix !== null && !hit.path.toLowerCase().startsWith(pathPrefix)) return false;
			if (cutoff !== null && hit.mtime < cutoff) return false;
			for (const tag of parsed.tags) {
				if (!matchesTag(hit.tagList ?? [], tag)) return false;
			}
			return true;
		});
	}

	/** Verify quoted phrases verbatim — lazily reading bodies of candidates. */
	private async filterByPhrases(hits: SearchHit[], phrases: string[]): Promise<SearchHit[]> {
		const kept: SearchHit[] = [];
		for (const hit of hits.slice(0, PHRASE_CANDIDATE_LIMIT)) {
			const haystacks = [hit.basename, hit.url ?? ""];
			if (hit.kind === "note") {
				const file = this.app.vault.getFileByPath(hit.path);
				if (file) haystacks.push(await this.app.vault.cachedRead(file));
			}
			if (phrases.every((p) => haystacks.some((h) => containsPhrase(h, p)))) {
				kept.push(hit);
			}
		}
		return kept;
	}

	renderSuggestion(hit: SearchHit, el: HTMLElement): void {
		el.addClass("searchosaurus-result");
		const iconEl = el.createDiv({ cls: "searchosaurus-result-icon" });
		setIcon(iconEl, iconForKind(hit.kind));
		const textEl = el.createDiv({ cls: "searchosaurus-result-text" });
		textEl.createDiv({ cls: "searchosaurus-result-title", text: hit.basename });
		const secondaryEl = textEl.createDiv({ cls: "searchosaurus-result-secondary" });
		if (hit.kind === "link") {
			secondaryEl.setText(hit.url ?? "");
		} else {
			secondaryEl.setText(parentFolder(hit.path));
			if (hit.kind === "note") void this.renderNoteSnippet(hit, secondaryEl);
		}
	}

	/** Bodies are not stored in the index — read lazily per rendered row. */
	private async renderNoteSnippet(hit: SearchHit, el: HTMLElement): Promise<void> {
		const query = parseQuery(this.inputEl.value);
		const words = foldedWords(query.text);
		if (words.length === 0) return;
		const file = this.app.vault.getFileByPath(hit.path);
		if (!file) return;
		const snippet = buildSnippet(await this.app.vault.cachedRead(file), words);
		if (snippet.text.length === 0 || snippet.ranges.length === 0) return;
		el.empty();
		el.addClass("searchosaurus-result-snippet");
		let cursor = 0;
		for (const [start, end] of snippet.ranges) {
			if (start > cursor) el.appendText(snippet.text.slice(cursor, start));
			el.createEl("mark", { text: snippet.text.slice(start, end) });
			cursor = end;
		}
		if (cursor < snippet.text.length) el.appendText(snippet.text.slice(cursor));
	}

	onChooseSuggestion(hit: SearchHit, evt: MouseEvent | KeyboardEvent): void {
		if (hit.kind === "link") {
			if (hit.url && Keymap.isModEvent(evt)) {
				window.open(hit.url);
				return;
			}
			void this.openAtLine(hit);
			return;
		}
		void this.app.workspace.openLinkText(hit.path, "", Keymap.isModEvent(evt));
	}

	/** Open the note containing the link, scrolled to the link's line. */
	private async openAtLine(hit: SearchHit): Promise<void> {
		const file = this.app.vault.getFileByPath(hit.path);
		if (!(file as TFile | null)) return;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file as TFile, {
			eState: hit.line !== undefined ? { line: hit.line } : undefined,
		});
	}
}

function parentFolder(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}
