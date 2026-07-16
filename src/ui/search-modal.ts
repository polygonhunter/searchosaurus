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
import { PreviewPane } from "./preview";

/** How many candidates the phrase filter may lazily read from disk. */
const PHRASE_CANDIDATE_LIMIT = 200;
/** How long the entrance stagger class stays on (first paint only). */
const ENTER_DURATION_MS = 450;

/**
 * The Searchosaurus prompt. Deliberately minimal chrome: input, a quiet
 * filter row, results, live preview — nothing else. Every power feature
 * stays behind the keyboard (progressive disclosure is the plugin's core
 * design rule).
 */
export class SearchosaurusModal extends SuggestModal<SearchHit> {
	private readonly filterState: FilterState = { kind: null, sort: "relevance" };
	private filterRow: FilterRow;
	private preview: PreviewPane;
	private selectionObserver: MutationObserver;
	/** Hits currently rendered, in DOM order — maps selection → preview. */
	private currentHits: SearchHit[] = [];
	private currentWords: string[] = [];

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

		// Custom chrome around the (public) input and result containers:
		// input · filter row · [ results | preview ].
		const row = createDiv();
		this.modalEl.insertBefore(row, this.resultContainerEl);
		this.filterRow = new FilterRow(row, this.filterState, () => this.refresh());

		const body = createDiv({ cls: "searchosaurus-body" });
		this.modalEl.insertBefore(body, this.resultContainerEl);
		body.appendChild(this.resultContainerEl);
		this.preview = new PreviewPane(app, body.createDiv());

		// SuggestModal exposes no selection hook; the selected row is marked
		// with .is-selected, so observe class flips on the result container.
		this.selectionObserver = new MutationObserver(() => this.syncPreview());
		this.selectionObserver.observe(this.resultContainerEl, {
			subtree: true,
			attributeFilter: ["class"],
		});
	}

	onOpen(): void {
		super.onOpen();
		// Stagger the very first result paint only — never on keystrokes.
		this.modalEl.addClass("is-entering");
		window.setTimeout(() => this.modalEl.removeClass("is-entering"), ENTER_DURATION_MS);
	}

	onClose(): void {
		this.selectionObserver.disconnect();
		this.preview.destroy();
		super.onClose();
	}

	/** Re-run getSuggestions via the public input path (no private APIs). */
	private refresh(): void {
		this.inputEl.dispatchEvent(new Event("input"));
	}

	private syncPreview(): void {
		const items = this.resultContainerEl.querySelectorAll(".suggestion-item");
		let selected = -1;
		items.forEach((item, index) => {
			if (item.hasClass("is-selected")) selected = index;
		});
		const hit = selected >= 0 ? this.currentHits[selected] : undefined;
		if (hit) {
			void this.preview.show(hit, this.currentWords);
		} else {
			this.preview.clear();
		}
	}

	async getSuggestions(query: string): Promise<SearchHit[]> {
		const parsed = parseQuery(query);
		this.filterRow.reflectKind(parsed.kind);

		if (parsed.text.length === 0 && parsed.tags.length === 0) {
			this.currentHits = [];
			this.preview.clear();
			return [];
		}

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
		const limited = ranked.slice(0, this.getSettings().resultLimit);
		this.currentHits = limited;
		this.currentWords = foldedWords(parsed.text);
		if (limited.length === 0) this.preview.clear();
		return limited;
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
		if (this.currentWords.length === 0) return;
		const file = this.app.vault.getFileByPath(hit.path);
		if (!file) return;
		const snippet = buildSnippet(await this.app.vault.cachedRead(file), this.currentWords);
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
			void this.openFileAt(hit, false, hit.line);
			return;
		}
		if (hit.kind === "note") {
			void this.openNoteAtMatch(hit, Keymap.isModEvent(evt));
			return;
		}
		void this.app.workspace.openLinkText(hit.path, "", Keymap.isModEvent(evt));
	}

	/**
	 * Open a note scrolled to the first match — Obsidian flashes the target
	 * line when eState.line is set, which is exactly the "where did I land"
	 * moment we want.
	 */
	private async openNoteAtMatch(hit: SearchHit, paneType: boolean | string): Promise<void> {
		let line: number | undefined;
		if (this.currentWords.length > 0) {
			const file = this.app.vault.getFileByPath(hit.path);
			if (file) {
				const body = await this.app.vault.cachedRead(file);
				line = firstMatchLine(body, this.currentWords);
			}
		}
		await this.openFileAt(hit, paneType, line);
	}

	private async openFileAt(
		hit: SearchHit,
		paneType: boolean | string,
		line: number | undefined,
	): Promise<void> {
		const file = this.app.vault.getFileByPath(hit.path);
		if (!file) return;
		const leaf = this.app.workspace.getLeaf(paneType as boolean);
		await leaf.openFile(file as TFile, {
			eState: line !== undefined ? { line } : undefined,
		});
	}
}

function parentFolder(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

/** 0-based line of the first case-insensitive occurrence of any word. */
function firstMatchLine(body: string, words: readonly string[]): number | undefined {
	const lower = body.toLowerCase();
	let first = -1;
	for (const word of words) {
		const index = lower.indexOf(word.toLowerCase());
		if (index !== -1 && (first === -1 || index < first)) first = index;
	}
	if (first === -1) return undefined;
	let line = 0;
	for (let i = 0; i < first; i++) {
		if (body.charCodeAt(i) === 10) line += 1;
	}
	return line;
}
