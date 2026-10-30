import {
	Keymap,
	normalizePath,
	Notice,
	Platform,
	setIcon,
	SuggestModal,
	type App,
	type PaneType,
	type TFile,
	type TFolder,
} from "obsidian";
import { sanitizeNoteName } from "../core/note-name";
import type { SearchEngine } from "../core/engine";
import { operatorFields } from "../core/engine";
import { topFrecent } from "../core/frecency";
import { pushHistory } from "../core/history";
import { fold, foldedWords } from "../core/normalize";
import { matchesTag, parseQuery, type ParsedQuery } from "../core/query";
import { rankResults } from "../core/rank";
import {
	findFirstMatch,
	foldWithMap,
	frontmatterLength,
	lineAt,
	prepareNeedles,
	stripFrontmatter,
	type FoldedText,
} from "../core/match";
import { snippetFrom } from "../core/snippet";
import type { SearchHit } from "../core/types";
import type { PersistentData } from "../data";
import type { SearchosaurusSettings } from "../settings";
import { kindForExtension } from "../core/classify";
import { FilterRow, type FilterState } from "./filter-row";
import { iconForKind } from "./icons";
import { PreviewPane } from "./preview";

/** How many candidates the phrase filter may lazily read from disk. */
const PHRASE_CANDIDATE_LIMIT = 200;
/** Candidates read in parallel per phrase-filter step. */
const PHRASE_BATCH = 20;
/** How long the entrance stagger class stays on (first paint only). */
const ENTER_DURATION_MS = 450;
/** Empty-state launcher size (pins + frecent). */
const LAUNCHER_LIMIT = 12;
/** Ghost (unresolved-link) rows appended to a search at most. */
const GHOST_LIMIT = 3;
/** Modifier as the platform spells it: ⌘ on macOS/iOS, Ctrl+ elsewhere. */
const MOD = Platform.isMacOS || Platform.isIosApp ? "⌘" : "Ctrl+";
/** Rows whose snippet is built right away; the rest when scrolled into view. */
const EAGER_SNIPPET_ROWS = 12;
/** Characters of context before the match in a (single-line) row snippet. */
const ROW_SNIPPET_LEAD = 24;
/** Snippets only search the first part of a note (huge notes stay cheap). */
const SNIPPET_SCAN_CHARS = 50_000;
/** How often the indexing status line refreshes while visible. */
const STATUS_INTERVAL_MS = 500;
/** Coalesce preview renders while arrow keys auto-repeat. */
const PREVIEW_DELAY_MS = 50;
/** Matches the CSS breakpoint below which the preview pane is hidden. */
const PREVIEW_MIN_WIDTH = 701;

/** Everything the modal needs from the plugin, without importing main.ts. */
export interface ModalHost {
	engine: SearchEngine;
	settings(): SearchosaurusSettings;
	data: PersistentData;
	saveDataSoon(): void;
	/** Write data.json right away (pins: the sync merge trusts the file). */
	saveDataNow(): void;
	/** Index still loading/building — results may be incomplete. */
	isIndexing(): boolean;
	/** OCR/PDF text of an attachment (current version), if extracted. */
	extractedText(file: TFile): string | null;
	/** Files done/queued in the running indexing pass; null when idle. */
	indexProgress(): { done: number; total: number } | null;
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
	/** p: folder of the current query — target folder for "Create". */
	private createFolder: string | null = null;
	/** Position while ↑-browsing history from the empty input. */
	private historyPos: number | null = null;
	private settingQueryProgrammatically = false;
	/** hit id + query of what the preview shows/is about to show. */
	private lastPreviewKey = "";
	private wasPreviewVisible = true;
	/** Unresolved link names, folded — built once per open. */
	private ghostCandidates: Array<{ name: string; folded: string }> | null = null;
	/** Backlinks of the current drill-down target, folded. */
	private backlinkCandidates: { target: string; items: FoldedCandidate[] } | null = null;
	/** Per-open cache: folded note heads for snippets, keyed by path. */
	private readonly textCache = new Map<string, CachedText>();
	/** Lazily fills snippets of rows that scroll into view. */
	private readonly snippetObserver: IntersectionObserver;
	private readonly pendingSnippets = new WeakMap<Element, { hit: SearchHit; gen: number }>();
	/** Bumped per getSuggestions call — async work of older calls is stale. */
	private gen = 0;
	private previewTimer: number | null = null;
	/** Quiet "Indexing… n / m" line; hidden once the index is complete. */
	private readonly statusEl: HTMLElement;
	private statusTimer: number | null = null;
	private wasIndexing = false;

	private readonly modHeld = (event: KeyboardEvent) => {
		if (event.key === "Meta" || event.key === "Control") {
			this.modalEl.toggleClass("mods-held", event.type === "keydown");
		}
	};

	/** ⌘ released in another app (⌘-Tab) never sends keyup here. */
	private readonly modReleased = () => this.modalEl.removeClass("mods-held");

	/** The window the modal lives in — listeners are added and removed there. */
	private win: Window | null = null;

	constructor(
		app: App,
		private readonly host: ModalHost,
		/** Pre-filled query (editor selection, obsidian:// URI). */
		private readonly initialQuery?: string,
	) {
		super(app);
		this.modalEl.addClass("searchosaurus-modal");
		this.setPlaceholder("Search your vault…");
		this.emptyStateText = "No matches.";
		this.limit = host.settings().resultLimit;

		// Custom chrome around the (public) input and result containers:
		// input · filter row · [ results | preview ] · hint line. Insert
		// relative to the result container's REAL parent — on mobile it is
		// not a direct child of modalEl, and inserting against the wrong
		// parent throws (which killed the modal on phones).
		const resultsParent = this.resultContainerEl.parentElement ?? this.modalEl;
		const row = createDiv();
		resultsParent.insertBefore(row, this.resultContainerEl);
		this.filterRow = new FilterRow(row, this.filterState, () => this.refresh());

		this.statusEl = createDiv({ cls: "searchosaurus-status" });
		resultsParent.insertBefore(this.statusEl, this.resultContainerEl);

		const body = createDiv({ cls: "searchosaurus-body" });
		resultsParent.insertBefore(body, this.resultContainerEl);
		body.appendChild(this.resultContainerEl);
		this.preview = new PreviewPane(
			app,
			body.createDiv(),
			(empty) => this.modalEl.toggleClass("is-preview-empty", empty),
			(file) => host.extractedText(file),
		);

		// The one allowed piece of help: a single faint line, empty state only.
		this.modalEl.createDiv({
			cls: "searchosaurus-hint",
			text: `⇥ insert link · ${MOD}↵ new tab · ${MOD}C copy · ${MOD}P pin · → backlinks · ↑ history`,
		});

		// SuggestModal exposes no selection hook; the selected row is marked
		// with .is-selected, so observe class flips on the result container.
		this.selectionObserver = new MutationObserver((mutations) => {
			// Only selection flips on result rows matter — not every class
			// change inside rendered snippets/marks.
			if (mutations.some((m) => (m.target as HTMLElement).hasClass?.("suggestion-item"))) {
				this.syncSelection();
			}
		});
		this.selectionObserver.observe(this.resultContainerEl, {
			subtree: true,
			attributeFilter: ["class"],
		});

		this.snippetObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					this.snippetObserver.unobserve(entry.target);
					const pending = this.pendingSnippets.get(entry.target);
					if (pending) {
						void this.renderSnippet(pending.hit, entry.target as HTMLElement, pending.gen);
					}
				}
			},
			{ root: this.resultContainerEl, rootMargin: "200px 0px" },
		);

		this.registerKeys();
		this.inputEl.addEventListener("keydown", this.onInputKeydown, true);
		this.inputEl.addEventListener("input", () => {
			if (!this.settingQueryProgrammatically) this.historyPos = null;
		});
	}

	async onOpen(): Promise<void> {
		await super.onOpen();
		// Stagger the very first result paint only — never on keystrokes.
		this.modalEl.addClass("is-entering");
		window.setTimeout(() => this.modalEl.removeClass("is-entering"), ENTER_DURATION_MS);
		this.win = this.modalEl.win;
		this.win.addEventListener("keydown", this.modHeld);
		this.win.addEventListener("keyup", this.modHeld);
		this.win.addEventListener("blur", this.modReleased);
		this.win.addEventListener("resize", this.onResize);
		this.wasPreviewVisible = this.previewVisible();
		this.updateStatus();
		if (this.initialQuery) {
			// Pre-filled and selected: Enter searches it, typing replaces it.
			this.setQuery(this.initialQuery);
			this.inputEl.select();
		} else {
			this.refresh(); // populate the empty-state launcher immediately
		}
	}

	onClose(): void {
		this.win?.removeEventListener("keydown", this.modHeld);
		this.win?.removeEventListener("keyup", this.modHeld);
		this.win?.removeEventListener("blur", this.modReleased);
		this.win?.removeEventListener("resize", this.onResize);
		this.win = null;
		this.selectionObserver.disconnect();
		this.snippetObserver.disconnect();
		if (this.statusTimer !== null) window.clearInterval(this.statusTimer);
		this.statusTimer = null;
		this.textCache.clear();
		this.cancelPreview();
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
		// ⌘1–9 picks a row by number and opens it right here — the held ⌘
		// is the chord, not a request for a new tab.
		for (let n = 1; n <= 9; n++) {
			this.scope.register(["Mod"], String(n), () => {
				const hit = this.currentHits[n - 1];
				if (hit) this.chooseAndOpen(hit, false);
				return false;
			});
		}
		this.scope.register(["Mod"], "Enter", () => {
			const hit = this.selectedHit();
			if (hit) this.chooseAndOpen(hit, "tab");
			return false;
		});
		this.scope.register(["Mod", "Alt"], "Enter", () => {
			const hit = this.selectedHit();
			if (hit) this.chooseAndOpen(hit, "split");
			return false;
		});
	}

	/** Arrow-key layer: history from the empty input, drill-down with →/←. */
	private readonly onInputKeydown = (event: KeyboardEvent) => {
		const value = this.inputEl.value;
		const history = this.host.data.searchHistory;

		if (event.key === "ArrowUp" && !this.drilldown) {
			// Only from the top row — further down, ↑ moves the selection.
			if (
				(value === "" || this.historyPos !== null) &&
				this.selectedIndex === 0 &&
				history.length > 0
			) {
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
		// Esc inside the drill-down steps back out instead of closing —
		// same pattern as the arrow keys: handled before the modal's scope.
		if (event.key === "Escape" && this.drilldown) {
			event.preventDefault();
			event.stopPropagation();
			this.exitDrilldown();
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
		const gen = ++this.gen;
		if (this.drilldown) {
			this.emptyStateText = query.trim().length > 0 ? "No matches." : "Nothing links here yet.";
			return this.finish(this.backlinkHits(this.drilldown, query), []);
		}

		const parsed = parseQuery(query);
		this.filterRow.reflectKind(parsed.kind);
		const isEmpty = parsed.text.length === 0 && parsed.tags.length === 0;
		this.modalEl.toggleClass("is-empty-query", isEmpty);

		if (isEmpty) {
			// Empty launcher (nothing pinned/opened yet): no "No matches."
			this.emptyStateText = "";
			return this.finish(this.launcherHits(), []);
		}
		this.emptyStateText = this.host.isIndexing() ? "No matches yet — still indexing…" : "No matches.";

		const tagOnly = parsed.text.length === 0;
		// Tag-only queries ("#project", also "n #project") search the tags
		// field itself, literally; typed operators otherwise search
		// title-focused (plus OCR/PDF text for i/f); plain queries all fields.
		const options = tagOnly
			? { fields: ["tags"], fuzzy: false }
			: parsed.kind !== null
				? { fields: operatorFields(parsed.kind) }
				: undefined;
		const engineQuery = tagOnly ? parsed.tags.join(" ") : parsed.text;
		let hits = this.host.engine.searchWithExcludes(engineQuery, parsed.excludes, options);

		hits = this.applyFilters(hits, parsed);
		let ranked = rankResults(hits, parsed.text, this.filterState.sort);
		if (parsed.phrases.length > 0 || parsed.excludedPhrases.length > 0) {
			ranked = await this.filterByPhrases(ranked, parsed.phrases, parsed.excludedPhrases, gen);
			// A newer keystroke superseded this run: keep the newest results.
			if (gen !== this.gen) return this.currentHits;
		}
		let limited = ranked.slice(0, this.host.settings().resultLimit);
		limited = [...limited, ...this.ghostHits(parsed, limited)];
		// Offer "Create" only for note searches, and not while the index is
		// still building (an empty result then proves nothing).
		const name = sanitizeNoteName(parsed.text);
		this.createFolder = parsed.pathPrefix;
		const kind = parsed.kind ?? this.filterState.kind;
		if (
			limited.length === 0 &&
			name.length > 0 &&
			(kind === null || kind === "note") &&
			!this.host.isIndexing()
		) {
			limited = [this.createHit(name)];
		}
		return this.finish(limited, foldedWords(parsed.text));
	}

	private finish(hits: SearchHit[], words: string[]): SearchHit[] {
		this.currentHits = hits;
		this.currentWords = words;
		// Rows of the previous result list are gone — stop watching them.
		this.snippetObserver.disconnect();
		this.selectedIndex = 0;
		if (hits.length === 0) {
			this.cancelPreview();
			this.lastPreviewKey = "";
			this.preview.clear();
		}
		return hits;
	}

	/** Empty state: pinned first, then frecent — the launcher. */
	private launcherHits(): SearchHit[] {
		const paths = [...this.host.data.pins];
		const pinned = new Set(paths);
		// All candidates (frecency is bounded): missing files are skipped
		// below and must not use up launcher slots.
		paths.push(...topFrecent(this.host.data.frecency, Date.now(), Number.POSITIVE_INFINITY, pinned));
		const hits: SearchHit[] = [];
		for (const path of paths) {
			if (hits.length >= LAUNCHER_LIMIT) break;
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
		// Built once per drill-down; keystrokes only filter.
		if (this.backlinkCandidates?.target !== target.path) {
			this.backlinkCandidates = { target: target.path, items: this.collectBacklinks(target) };
		}
		const q = fold(query);
		const filtered =
			q.length > 0
				? this.backlinkCandidates.items.filter(
						(c) => c.foldedName.includes(q) || c.foldedPath.includes(q),
					)
				: this.backlinkCandidates.items;
		return filtered.slice(0, this.host.settings().resultLimit).map((c) => c.hit);
	}

	private collectBacklinks(target: SearchHit): FoldedCandidate[] {
		const items: FoldedCandidate[] = [];
		const resolved = this.app.metadataCache.resolvedLinks;
		for (const [source, targets] of Object.entries(resolved)) {
			if ((targets[target.path] ?? 0) === 0) continue;
			const file = this.app.vault.getFileByPath(source);
			if (!file) continue;
			items.push({
				hit: {
					id: source,
					score: 0,
					kind: "note",
					path: source,
					basename: file.basename,
					mtime: file.stat.mtime,
					aliasList: [],
					tagList: [],
				},
				foldedName: fold(file.basename),
				foldedPath: fold(source),
			});
		}
		items.sort((a, b) => b.hit.mtime - a.hit.mtime);
		return items;
	}

	/** Unresolved [[wikilinks]] matching the query — creatable ghosts. */
	private ghostHits(parsed: ParsedQuery, existing: SearchHit[]): SearchHit[] {
		const kind = parsed.kind ?? this.filterState.kind;
		if (kind !== null && kind !== "note") return [];
		// Ghosts have no tags, folder, date or body — any filter rules them out.
		if (
			parsed.tags.length > 0 ||
			parsed.pathPrefix !== null ||
			parsed.modifiedWithinDays !== null ||
			parsed.excludes.length > 0 ||
			parsed.excludedPhrases.length > 0
		) {
			return [];
		}
		const q = fold(parsed.text);
		if (q.length === 0) return [];
		const existingTitles = new Set(existing.map((h) => fold(h.basename)));
		// Unresolved names are collected and folded once per modal open.
		this.ghostCandidates ??= this.collectGhosts();
		const ghosts: SearchHit[] = [];
		for (const { name, folded } of this.ghostCandidates) {
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

	private collectGhosts(): Array<{ name: string; folded: string }> {
		const names = new Set<string>();
		for (const targets of Object.values(this.app.metadataCache.unresolvedLinks)) {
			for (const name of Object.keys(targets)) names.add(name);
		}
		return [...names].map((name) => ({ name, folded: fold(name) }));
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

	/**
	 * Verify quoted (and -"excluded") phrases verbatim — lazily reading
	 * bodies of candidates, in parallel batches, stopping once enough
	 * results are confirmed or a newer keystroke made this run stale.
	 */
	private async filterByPhrases(
		hits: SearchHit[],
		phrases: string[],
		excludedPhrases: string[],
		gen: number,
	): Promise<SearchHit[]> {
		const folded = phrases.map(fold).filter((p) => p.length > 0);
		const foldedExcluded = excludedPhrases.map(fold).filter((p) => p.length > 0);
		if (folded.length === 0 && foldedExcluded.length === 0) return hits;
		const limit = this.host.settings().resultLimit;
		const candidates = hits.slice(0, PHRASE_CANDIDATE_LIMIT);
		const kept: SearchHit[] = [];
		for (let i = 0; i < candidates.length && kept.length < limit; i += PHRASE_BATCH) {
			const batch = candidates.slice(i, i + PHRASE_BATCH);
			const verdicts = await Promise.all(
				batch.map((hit) => this.matchesPhrases(hit, folded, foldedExcluded)),
			);
			if (gen !== this.gen) return kept;
			batch.forEach((hit, k) => {
				if (verdicts[k] && kept.length < limit) kept.push(hit);
			});
		}
		return kept;
	}

	/**
	 * Every (pre-folded) phrase occurs in the title, URL, note body or
	 * OCR/PDF text — and no excluded phrase does.
	 */
	private async matchesPhrases(
		hit: SearchHit,
		foldedPhrases: readonly string[],
		foldedExcluded: readonly string[],
	): Promise<boolean> {
		const haystacks = [fold(hit.basename), fold(hit.url ?? "")];
		const found = (p: string) => haystacks.some((h) => h.includes(p));
		const verdict = () => foldedPhrases.every(found) && !foldedExcluded.some(found);
		// Exclusions must see the body too; required phrases may stop early.
		if (foldedExcluded.length === 0 && verdict()) return true;
		if (hit.kind === "link") return verdict();
		const text = hit.kind === "note" ? await this.cachedText(hit.path) : this.extractedText(hit.path);
		if (text) {
			text.phraseHaystack ??= fold(text.body);
			haystacks.push(text.phraseHaystack);
		}
		return verdict();
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
				if (this.currentWords.length > 0) {
					if (index >= 0 && index < EAGER_SNIPPET_ROWS) {
						void this.renderSnippet(hit, secondaryEl, this.gen);
					} else {
						this.pendingSnippets.set(secondaryEl, { hit, gen: this.gen });
						this.snippetObserver.observe(secondaryEl);
					}
				}
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

	/**
	 * Bodies are not stored in the index — read lazily per rendered row.
	 * Images and PDFs show where their OCR/PDF text matched.
	 */
	private async renderSnippet(hit: SearchHit, el: HTMLElement, gen: number): Promise<void> {
		const needles = prepareNeedles(this.currentWords);
		if (needles.length === 0) return;
		const text = hit.kind === "note" ? await this.cachedText(hit.path) : this.extractedText(hit.path);
		// The row was replaced by a newer search while reading — drop it.
		if (!text || gen !== this.gen || !el.isConnected) return;
		// The row is one clipped line: little context before the match, or
		// the highlight ends up hidden behind the ellipsis.
		const snippet = snippetFrom(text.content, text.folded, needles, undefined, ROW_SNIPPET_LEAD);
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

	/** Folded OCR/PDF text of an attachment, cached like note heads. */
	private extractedText(path: string): CachedText | null {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return null;
		const key = `extracted:${path}`;
		const cached = this.textCache.get(key);
		if (cached && cached.mtime === file.stat.mtime) return cached;
		const body = this.host.extractedText(file);
		if (body === null) return null;
		const content = body.slice(0, SNIPPET_SCAN_CHARS);
		const entry: CachedText = { mtime: file.stat.mtime, body, content, folded: foldWithMap(content) };
		this.textCache.set(key, entry);
		return entry;
	}

	/**
	 * Folded, frontmatter-free head of a note — read and folded once per
	 * modal open (and file version), then reused on every keystroke.
	 */
	private async cachedText(path: string): Promise<CachedText | null> {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return null;
		const cached = this.textCache.get(path);
		if (cached && cached.mtime === file.stat.mtime) return cached;
		const body = await this.app.vault.cachedRead(file);
		const content = stripFrontmatter(body).slice(0, SNIPPET_SCAN_CHARS);
		const entry: CachedText = {
			mtime: file.stat.mtime,
			body,
			content,
			folded: foldWithMap(content),
		};
		this.textCache.set(path, entry);
		return entry;
	}

	// ----------------------------------------------------------- actions

	onChooseSuggestion(hit: SearchHit, evt: MouseEvent | KeyboardEvent): void {
		this.rememberQuery();
		this.openHit(hit, Keymap.isModEvent(evt));
	}

	/** Keyboard-chord path: remember, close, open in the given pane. */
	private chooseAndOpen(hit: SearchHit, paneType: PaneType | boolean): void {
		this.rememberQuery();
		this.close();
		this.openHit(hit, paneType);
	}

	/** Open a hit; paneType false = current tab, otherwise tab/split/window. */
	private openHit(hit: SearchHit, paneType: PaneType | boolean): void {
		if (hit.create) {
			void this.createNote(hit.basename, paneType);
			return;
		}
		if (hit.ghost) {
			// openLinkText on a non-existing target creates the note (at the
			// user's default location, like clicking the unresolved link).
			this.app.workspace.openLinkText(hit.basename, "", paneType).catch((error: unknown) => {
				new Notice(`Searchosaurus: could not create “${hit.basename}” — ${errorText(error)}`);
			});
			return;
		}
		if (hit.kind === "link") {
			if (hit.url && paneType !== false) {
				window.open(hit.url);
				return;
			}
			this.reportOpenFailure(hit, this.openFileAt(hit, false, hit.line));
			return;
		}
		if (hit.kind === "note") {
			this.reportOpenFailure(hit, this.openNoteAtMatch(hit, paneType));
			return;
		}
		// By file, not link text: "#" or "^" in a name would parse as a
		// subpath (and an unresolved link text creates a note).
		this.reportOpenFailure(hit, this.openFileAt(hit, paneType, undefined));
	}

	private reportOpenFailure(hit: SearchHit, opening: Promise<void>): void {
		opening.catch((error: unknown) => {
			new Notice(`Searchosaurus: could not open “${hit.basename}” — ${errorText(error)}`);
		});
	}

	/**
	 * Create a note from the search text: in the p: folder when it exists,
	 * otherwise at the user's default new-note location. An existing file
	 * of that name is simply opened.
	 */
	private async createNote(name: string, paneType: PaneType | boolean): Promise<void> {
		try {
			const folder = this.targetFolder();
			const path = normalizePath(folder.isRoot() ? `${name}.md` : `${folder.path}/${name}.md`);
			const file =
				this.app.vault.getFileByPath(path) ?? (await this.app.vault.create(path, ""));
			await this.app.workspace.getLeaf(paneType).openFile(file);
		} catch (error) {
			new Notice(`Searchosaurus: could not create “${name}” — ${errorText(error)}`);
		}
	}

	private targetFolder(): TFolder {
		const prefix = this.createFolder?.replace(/\/+$/, "") ?? "";
		const folder = prefix.length > 0 ? this.app.vault.getFolderByPath(prefix) : null;
		if (folder) return folder;
		const source = this.app.workspace.getActiveFile()?.path ?? "";
		return this.app.fileManager.getNewFileParent(source);
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
		try {
			await navigator.clipboard.writeText(text);
			new Notice("Link copied.");
		} catch (error) {
			new Notice(`Searchosaurus: could not copy the link — ${errorText(error)}`);
		}
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
		// Immediately, not debounced: a data.json arriving by sync within
		// the delay would otherwise overwrite the pin change (pins follow
		// the file in mergePersistentData).
		this.host.saveDataNow();
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
		this.inputEl.placeholder = `Linked to “${target.basename}” — ← or Esc back`;
		this.setQuery("");
	}

	private exitDrilldown(): void {
		this.drilldown = null;
		this.backlinkCandidates = null;
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
		if (!hit || hit.ghost || hit.create || !this.previewVisible()) {
			this.cancelPreview();
			if (this.lastPreviewKey !== "") this.preview.clear();
			this.lastPreviewKey = "";
			return;
		}
		// Same row, same query: the preview is already right — no re-render.
		const key = `${hit.id}\u0000${this.currentWords.join(" ")}`;
		if (key === this.lastPreviewKey) return;
		this.lastPreviewKey = key;
		this.cancelPreview();
		const words = this.currentWords;
		this.previewTimer = window.setTimeout(() => {
			this.previewTimer = null;
			this.preview.show(hit, words).catch((error: unknown) => {
				console.error("Searchosaurus: preview failed", error);
				this.preview.clear();
			});
		}, PREVIEW_DELAY_MS);
	}

	/**
	 * Show indexing progress while the index is incomplete; poll quietly
	 * while open and stop once done (the line then disappears for good).
	 */
	private updateStatus(): void {
		const indexing = this.host.isIndexing();
		this.modalEl.toggleClass("is-indexing", indexing);
		if (!indexing) {
			this.statusEl.empty();
			if (this.statusTimer !== null) window.clearInterval(this.statusTimer);
			this.statusTimer = null;
			// Results computed against the partial index are stale now.
			if (this.wasIndexing) this.setQuery(this.inputEl.value);
			this.wasIndexing = false;
			return;
		}
		this.wasIndexing = true;
		const progress = this.host.indexProgress();
		this.statusEl.setText(
			progress && progress.total > 0
				? `Indexing… ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`
				: "Loading index…",
		);
		this.statusTimer ??= window.setInterval(() => this.updateStatus(), STATUS_INTERVAL_MS);
	}

	/**
	 * Narrow → wide while open: the preview was skipped, render it now
	 * (wide → narrow clears it). Only acts when the visibility flips.
	 */
	private readonly onResize = (): void => {
		const visible = this.previewVisible();
		if (visible === this.wasPreviewVisible) return;
		this.wasPreviewVisible = visible;
		this.syncSelection();
	};

	/** The pane is display:none on phones and narrow windows — skip renders. */
	private previewVisible(): boolean {
		return !Platform.isPhone && this.modalEl.win.innerWidth >= PREVIEW_MIN_WIDTH;
	}

	private cancelPreview(): void {
		if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
		this.previewTimer = null;
	}

	/**
	 * Open a note scrolled to the first match — Obsidian flashes the target
	 * line when eState.line is set, which is exactly the "where did I land"
	 * moment we want.
	 */
	private async openNoteAtMatch(hit: SearchHit, paneType: boolean | PaneType): Promise<void> {
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
		paneType: boolean | PaneType,
		line: number | undefined,
	): Promise<void> {
		const file = this.app.vault.getFileByPath(hit.path);
		if (!file) return;
		const leaf = this.app.workspace.getLeaf(paneType);
		await leaf.openFile(file, {
			eState: line !== undefined ? { line } : undefined,
		});
	}
}

interface FoldedCandidate {
	hit: SearchHit;
	foldedName: string;
	foldedPath: string;
}

interface CachedText {
	mtime: number;
	/** Full raw body (phrase filter, jump line). */
	body: string;
	/** Frontmatter-free head, capped at SNIPPET_SCAN_CHARS. */
	content: string;
	folded: FoldedText;
	/** fold()ed full body for phrase checks, computed on first use. */
	phraseHaystack?: string;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function parentFolder(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * 0-based line of the first match of any word — folded like the index, so
 * "muller" lands on "Müller". Prefers the body over the frontmatter.
 */
function firstMatchLine(body: string, words: readonly string[]): number | undefined {
	const needles = prepareNeedles(words);
	if (needles.length === 0) return undefined;
	const folded = foldWithMap(body);
	const match =
		findFirstMatch(folded, needles, frontmatterLength(body)) ?? findFirstMatch(folded, needles);
	return match === null ? undefined : lineAt(body, match[0]);
}
