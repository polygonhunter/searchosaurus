import { Keymap, Notice, setIcon, SuggestModal, type App, type TFile } from "obsidian";
import type { SearchEngine } from "../core/engine";
import { TITLE_FIELDS } from "../core/engine";
import { topFrecent } from "../core/frecency";
import { pushHistory } from "../core/history";
import { fold, foldedWords } from "../core/normalize";
import { containsPhrase, matchesTag, parseQuery, type ParsedQuery } from "../core/query";
import { rankResults } from "../core/rank";
import { buildSnippet } from "../core/snippet";
import type { SearchHit } from "../core/types";
import type { PersistentData } from "../data";
import type { SearchosaurusSettings } from "../settings";
import { kindForExtension } from "../core/classify";
import { FilterRow, type FilterState } from "./filter-row";
import { iconForKind } from "./icons";
import { PreviewPane } from "./preview";

/** How many candidates the phrase filter may lazily read from disk. */
const PHRASE_CANDIDATE_LIMIT = 200;
/** How long the entrance stagger class stays on (first paint only). */
const ENTER_DURATION_MS = 450;
/** Empty-state launcher size (pins + frecent). */
const LAUNCHER_LIMIT = 12;
/** Ghost (unresolved-link) rows appended to a search at most. */
const GHOST_LIMIT = 3;

/** Everything the modal needs from the plugin, without importing main.ts. */
export interface ModalHost {
	engine: SearchEngine;
	settings(): SearchosaurusSettings;
	data: PersistentData;
	saveDataSoon(): void;
}

/**
 * The Searchosaurus prompt. Deliberately minimal chrome: input, a quiet
 * filter row, results, live preview — nothing else. Every power feature
 * stays behind the keyboard (progressive disclosure is the plugin's core
 * design rule): ⇥ inserts a link, ⌘C copies one, ⌘P pins, ⌘1–9 opens
 * directly (numbers appear only while ⌘ is held), → drills into
 * backlinks, ↑ recalls past searches from the empty input.
 */
export class SearchosaurusModal extends SuggestModal<SearchHit> {
	private readonly filterState: FilterState = { kind: null, sort: "relevance" };
	private filterRow: FilterRow;
	private preview: PreviewPane;
	private selectionObserver: MutationObserver;
	/** Hits currently rendered, in DOM order — maps selection → preview. */
	private currentHits: SearchHit[] = [];
	private currentWords: string[] = [];
	private selectedIndex = 0;
	/** Backlink drill-down target (→ on a note), null = normal search. */
	private drilldown: SearchHit | null = null;
	private savedQuery = "";
	/** Position while ↑-browsing history from the empty input. */
	private historyPos: number | null = null;
	private settingQueryProgrammatically = false;

	private readonly modHeld = (event: KeyboardEvent) => {
		if (event.key === "Meta" || event.key === "Control") {
			this.modalEl.toggleClass("mods-held", event.type === "keydown");
		}
	};

	constructor(
		app: App,
		private readonly host: ModalHost,
	) {
		super(app);
		this.modalEl.addClass("searchosaurus-modal");
		this.setPlaceholder("Search your vault…");
		this.emptyStateText = "No matches.";
		this.limit = host.settings().resultLimit;

		// Custom chrome around the (public) input and result containers:
		// input · filter row · [ results | preview ] · hint line.
		const row = createDiv();
		this.modalEl.insertBefore(row, this.resultContainerEl);
		this.filterRow = new FilterRow(row, this.filterState, () => this.refresh());

		const body = createDiv({ cls: "searchosaurus-body" });
		this.modalEl.insertBefore(body, this.resultContainerEl);
		body.appendChild(this.resultContainerEl);
		this.preview = new PreviewPane(app, body.createDiv());

		// The one allowed piece of help: a single faint line, empty state only.
		this.modalEl.createDiv({
			cls: "searchosaurus-hint",
			text: "⇥ insert link · ⌘↵ new tab · ⌘C copy · ⌘P pin · → backlinks · ↑ history",
		});

		// SuggestModal exposes no selection hook; the selected row is marked
		// with .is-selected, so observe class flips on the result container.
		this.selectionObserver = new MutationObserver(() => this.syncSelection());
		this.selectionObserver.observe(this.resultContainerEl, {
			subtree: true,
			attributeFilter: ["class"],
		});

		this.registerKeys();
		this.inputEl.addEventListener("keydown", this.onInputKeydown, true);
		this.inputEl.addEventListener("input", () => {
			if (!this.settingQueryProgrammatically) this.historyPos = null;
		});
	}

	onOpen(): void {
		super.onOpen();
		// Stagger the very first result paint only — never on keystrokes.
		this.modalEl.addClass("is-entering");
		window.setTimeout(() => this.modalEl.removeClass("is-entering"), ENTER_DURATION_MS);
		activeWindow.addEventListener("keydown", this.modHeld);
		activeWindow.addEventListener("keyup", this.modHeld);
		this.refresh(); // populate the empty-state launcher immediately
	}

	onClose(): void {
		activeWindow.removeEventListener("keydown", this.modHeld);
		activeWindow.removeEventListener("keyup", this.modHeld);
		this.selectionObserver.disconnect();
		this.preview.destroy();
		super.onClose();
	}

	// ------------------------------------------------------------ keys

	private registerKeys(): void {
		this.scope.register([], "Tab", (event) => {
			event.preventDefault();
			const hit = this.selectedHit();
			if (hit && !hit.ghost && !hit.create) this.insertLink(hit);
			return false;
		});
		this.scope.register(["Mod"], "c", () => {
			// Respect a text selection in the input — default copy then.
			if (this.inputEl.selectionStart !== this.inputEl.selectionEnd) return true;
			const hit = this.selectedHit();
			if (hit && !hit.ghost && !hit.create) void this.copyLink(hit);
			return false;
		});
		this.scope.register(["Mod"], "p", () => {
			const hit = this.selectedHit();
			if (hit && !hit.ghost && !hit.create) this.togglePin(hit);
			return false;
		});
		for (let n = 1; n <= 9; n++) {
			this.scope.register(["Mod"], String(n), (event) => {
				const hit = this.currentHits[n - 1];
				if (hit) {
					this.rememberQuery();
					this.close();
					this.onChooseSuggestion(hit, event);
				}
				return false;
			});
		}
	}

	/** Arrow-key layer: history from the empty input, drill-down with →/←. */
	private readonly onInputKeydown = (event: KeyboardEvent) => {
		const value = this.inputEl.value;
		const history = this.host.data.searchHistory;

		if (event.key === "ArrowUp" && !this.drilldown) {
			if ((value === "" || this.historyPos !== null) && history.length > 0) {
				event.preventDefault();
				event.stopPropagation();
				this.historyPos =
					this.historyPos === null ? 0 : Math.min(this.historyPos + 1, history.length - 1);
				this.setQuery(history[this.historyPos] ?? "");
			}
			return;
		}
		if (event.key === "ArrowDown" && this.historyPos !== null) {
			event.preventDefault();
			event.stopPropagation();
			this.historyPos = this.historyPos <= 0 ? null : this.historyPos - 1;
			this.setQuery(this.historyPos === null ? "" : (history[this.historyPos] ?? ""));
			return;
		}
		if (event.key === "ArrowRight" && !this.drilldown) {
			const caretAtEnd =
				this.inputEl.selectionStart === value.length &&
				this.inputEl.selectionEnd === value.length;
			const hit = this.selectedHit();
			if (caretAtEnd && hit && hit.kind === "note" && !hit.ghost && !hit.create) {
				event.preventDefault();
				event.stopPropagation();
				this.enterDrilldown(hit);
			}
			return;
		}
		if (event.key === "ArrowLeft" && this.drilldown && value === "") {
			event.preventDefault();
			event.stopPropagation();
			this.exitDrilldown();
		}
	};

	// ------------------------------------------------------- suggestions

	async getSuggestions(query: string): Promise<SearchHit[]> {
		if (this.drilldown) {
			return this.finish(this.backlinkHits(this.drilldown, query), []);
		}

		const parsed = parseQuery(query);
		this.filterRow.reflectKind(parsed.kind);
		const isEmpty = parsed.text.length === 0 && parsed.tags.length === 0;
		this.modalEl.toggleClass("is-empty-query", isEmpty);

		if (isEmpty) {
			return this.finish(this.launcherHits(), []);
		}

		// Typed operators search title-focused; otherwise all fields.
		const options = parsed.kind !== null ? { fields: [...TITLE_FIELDS] } : undefined;
		// Tag-only queries ("#project") search the tags field itself.
		const engineQuery = parsed.text.length > 0 ? parsed.text : parsed.tags.join(" ");
		let hits = this.host.engine.searchWithExcludes(engineQuery, parsed.excludes, options);

		hits = this.applyFilters(hits, parsed);
		let ranked = rankResults(hits, parsed.text, this.filterState.sort);
		if (parsed.phrases.length > 0) {
			ranked = await this.filterByPhrases(ranked, parsed.phrases);
		}
		let limited = ranked.slice(0, this.host.settings().resultLimit);
		limited = [...limited, ...this.ghostHits(parsed, limited)];
		if (limited.length === 0 && parsed.text.length > 0) {
			limited = [this.createHit(parsed.text)];
		}
		return this.finish(limited, foldedWords(parsed.text));
	}

	private finish(hits: SearchHit[], words: string[]): SearchHit[] {
		this.currentHits = hits;
		this.currentWords = words;
		this.selectedIndex = 0;
		if (hits.length === 0) this.preview.clear();
		return hits;
	}

	/** Empty state: pinned first, then frecent — the launcher. */
	private launcherHits(): SearchHit[] {
		const paths = [...this.host.data.pins];
		const pinned = new Set(paths);
		paths.push(...topFrecent(this.host.data.frecency, Date.now(), LAUNCHER_LIMIT, pinned));
		const hits: SearchHit[] = [];
		for (const path of paths.slice(0, LAUNCHER_LIMIT)) {
			const file = this.app.vault.getFileByPath(path);
			if (!file) continue;
			hits.push({
				id: path,
				score: 0,
				kind: kindForExtension(file.extension),
				path,
				basename: file.basename,
				mtime: file.stat.mtime,
				aliasList: [],
				tagList: [],
			});
		}
		return hits;
	}

	/** Notes linking to the drill-down target, newest first. */
	private backlinkHits(target: SearchHit, query: string): SearchHit[] {
		const hits: SearchHit[] = [];
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const [source, targets] of Object.entries(resolved)) {
			if ((targets[target.path] ?? 0) === 0) continue;
			const file = this.app.vault.getFileByPath(source);
			if (!file) continue;
			hits.push({
				id: source,
				score: 0,
				kind: "note",
				path: source,
				basename: file.basename,
				mtime: file.stat.mtime,
				aliasList: [],
				tagList: [],
			});
		}
		const q = fold(query);
		const filtered =
			q.length > 0
				? hits.filter((h) => fold(h.basename).includes(q) || fold(h.path).includes(q))
				: hits;
		filtered.sort((a, b) => b.mtime - a.mtime);
		return filtered.slice(0, this.host.settings().resultLimit);
	}

	/** Unresolved [[wikilinks]] matching the query — creatable ghosts. */
	private ghostHits(parsed: ParsedQuery, existing: SearchHit[]): SearchHit[] {
		if (parsed.kind !== null && parsed.kind !== "note") return [];
		const q = fold(parsed.text);
		if (q.length === 0) return [];
		const existingTitles = new Set(existing.map((h) => fold(h.basename)));
		const names = new Set<string>();
		for (const targets of Object.values(this.app.metadataCache.unresolvedLinks)) {
			for (const name of Object.keys(targets)) names.add(name);
		}
		const ghosts: SearchHit[] = [];
		for (const name of names) {
			const folded = fold(name);
			if (!folded.includes(q) || existingTitles.has(folded)) continue;
			ghosts.push({
				id: `ghost:${name}`,
				score: 0,
				kind: "note",
				path: "",
				basename: name,
				mtime: 0,
				aliasList: [],
				tagList: [],
				ghost: true,
			});
			if (ghosts.length >= GHOST_LIMIT) break;
		}
		return ghosts;
	}

	private createHit(text: string): SearchHit {
		return {
			id: `create:${text}`,
			score: 0,
			kind: "note",
			path: "",
			basename: text,
			mtime: 0,
			aliasList: [],
			tagList: [],
			create: true,
		};
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

	// --------------------------------------------------------- rendering

	renderSuggestion(hit: SearchHit, el: HTMLElement): void {
		el.addClass("searchosaurus-result");
		const index = this.currentHits.indexOf(hit);

		const iconEl = el.createDiv({ cls: "searchosaurus-result-icon" });
		setIcon(iconEl, hit.create ? "plus" : hit.ghost ? "file-plus" : iconForKind(hit.kind));

		const textEl = el.createDiv({ cls: "searchosaurus-result-text" });
		if (hit.create) {
			el.addClass("is-create");
			textEl.createDiv({ cls: "searchosaurus-result-title", text: `Create “${hit.basename}”` });
		} else {
			textEl.createDiv({ cls: "searchosaurus-result-title", text: hit.basename });
			const secondaryEl = textEl.createDiv({ cls: "searchosaurus-result-secondary" });
			if (hit.ghost) {
				el.addClass("is-ghost");
				secondaryEl.setText("not created yet");
			} else if (hit.kind === "link") {
				secondaryEl.setText(hit.url ?? "");
			} else {
				secondaryEl.setText(parentFolder(hit.path));
				if (hit.kind === "note") void this.renderNoteSnippet(hit, secondaryEl);
			}
		}

		if (this.host.data.pins.includes(hit.path) && hit.path.length > 0) {
			el.addClass("is-pinned");
			el.createDiv({ cls: "searchosaurus-pin-dot" });
		}
		if (index >= 0 && index < 9) {
			el.createDiv({ cls: "searchosaurus-result-index", text: String(index + 1) });
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

	// ----------------------------------------------------------- actions

	onChooseSuggestion(hit: SearchHit, evt: MouseEvent | KeyboardEvent): void {
		this.rememberQuery();
		if (hit.ghost || hit.create) {
			// openLinkText on a non-existing target creates the note.
			void this.app.workspace.openLinkText(hit.basename, "", false);
			return;
		}
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

	/** ⇥ — drop a link to the selected result at the cursor and be done. */
	private insertLink(hit: SearchHit): void {
		const editorInfo = this.app.workspace.activeEditor;
		const editor = editorInfo?.editor;
		if (!editor) {
			new Notice("Searchosaurus: no active editor to insert into.");
			return;
		}
		const text = this.linkTextFor(hit, editorInfo?.file?.path ?? "");
		if (text === null) return;
		this.rememberQuery();
		this.close();
		editor.replaceSelection(text);
		editor.focus();
	}

	private async copyLink(hit: SearchHit): Promise<void> {
		const text = this.linkTextFor(hit, "");
		if (text === null) return;
		await navigator.clipboard.writeText(text);
		new Notice("Link copied.");
	}

	private linkTextFor(hit: SearchHit, sourcePath: string): string | null {
		if (hit.kind === "link") {
			if (!hit.url) return null;
			return hit.basename && hit.basename !== hit.url
				? `[${hit.basename}](${hit.url})`
				: hit.url;
		}
		const file = this.app.vault.getFileByPath(hit.path);
		if (!file) return null;
		return this.app.fileManager.generateMarkdownLink(file, sourcePath);
	}

	private togglePin(hit: SearchHit): void {
		if (hit.path.length === 0) return;
		const pins = this.host.data.pins;
		const index = pins.indexOf(hit.path);
		if (index >= 0) {
			pins.splice(index, 1);
		} else {
			pins.unshift(hit.path);
		}
		this.host.saveDataSoon();
		this.refresh();
	}

	private rememberQuery(): void {
		if (this.drilldown) return;
		this.host.data.searchHistory = pushHistory(
			this.host.data.searchHistory,
			this.inputEl.value,
		);
		this.host.saveDataSoon();
	}

	// -------------------------------------------------------- drill-down

	private enterDrilldown(target: SearchHit): void {
		this.drilldown = target;
		this.savedQuery = this.inputEl.value;
		this.modalEl.addClass("is-drilldown");
		this.inputEl.placeholder = `Linked to “${target.basename}” — ← back`;
		this.setQuery("");
	}

	private exitDrilldown(): void {
		this.drilldown = null;
		this.modalEl.removeClass("is-drilldown");
		this.inputEl.placeholder = "Search your vault…";
		this.setQuery(this.savedQuery);
	}

	// ----------------------------------------------------------- helpers

	private selectedHit(): SearchHit | undefined {
		return this.currentHits[this.selectedIndex] ?? this.currentHits[0];
	}

	/** Re-run getSuggestions via the public input path (no private APIs). */
	private refresh(): void {
		this.inputEl.dispatchEvent(new Event("input"));
	}

	private setQuery(value: string): void {
		this.settingQueryProgrammatically = true;
		this.inputEl.value = value;
		this.refresh();
		this.settingQueryProgrammatically = false;
	}

	private syncSelection(): void {
		const items = this.resultContainerEl.querySelectorAll(".suggestion-item");
		let selected = -1;
		items.forEach((item, index) => {
			if (item.hasClass("is-selected")) selected = index;
		});
		if (selected >= 0) this.selectedIndex = selected;
		const hit = selected >= 0 ? this.currentHits[selected] : undefined;
		if (hit && !hit.ghost && !hit.create) {
			void this.preview.show(hit, this.currentWords);
		} else {
			this.preview.clear();
		}
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
