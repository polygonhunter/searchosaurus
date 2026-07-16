import MiniSearch, { type Options, type SearchOptions } from "minisearch";
import { processTerm } from "./normalize";
import type { FieldWeights, IndexedDoc, SearchHit } from "./types";

/** Bump when the doc schema or normalization changes → forces a rebuild. */
export const INDEX_SCHEMA_VERSION = 1;

const INDEX_FIELDS = [
	"basename",
	"aliases",
	"headings",
	"tags",
	"body",
	"extractedText",
	"url",
] as const;

const STORE_FIELDS = ["path", "kind", "mtime", "basename", "aliasList", "url", "line"] as const;

/** Title-focused subset used by the n/f/i/l prefix operators. */
export const TITLE_FIELDS: readonly string[] = ["basename", "aliases", "url"];

function miniSearchOptions(weights: FieldWeights): Options<IndexedDoc> {
	return {
		idField: "id",
		fields: [...INDEX_FIELDS],
		storeFields: [...STORE_FIELDS],
		processTerm,
		searchOptions: {
			prefix: (term) => term.length >= 2,
			fuzzy: (term) => (term.length >= 4 ? 0.2 : false),
			combineWith: "AND",
			boost: { ...weights },
		},
	};
}

/**
 * Thin wrapper around MiniSearch: upsert/discard semantics, typed hits, and
 * stable JSON serialization for the startup cache. Pure — the Obsidian side
 * (index/) feeds it docs, the UI reads hits.
 */
export class SearchEngine {
	private mini: MiniSearch<IndexedDoc>;

	constructor(private readonly weights: FieldWeights) {
		this.mini = new MiniSearch(miniSearchOptions(weights));
	}

	/** Add or replace — MiniSearch's replace() throws on unknown ids. */
	upsert(doc: IndexedDoc): void {
		if (this.mini.has(doc.id)) {
			this.mini.replace(doc);
		} else {
			this.mini.add(doc);
		}
	}

	/** Remove by id; no-op when absent. discard() is v7's cheap removal. */
	remove(id: string): void {
		if (this.mini.has(id)) this.mini.discard(id);
	}

	has(id: string): boolean {
		return this.mini.has(id);
	}

	get size(): number {
		return this.mini.documentCount;
	}

	search(query: string, options?: SearchOptions): SearchHit[] {
		if (query.trim().length === 0) return [];
		return this.mini.search(query, options) as unknown as SearchHit[];
	}

	toJSON(): string {
		return JSON.stringify(this.mini.toJSON());
	}

	/** Replace the whole index from a serialized snapshot. */
	load(json: string): void {
		this.mini = MiniSearch.loadJSON(json, miniSearchOptions(this.weights));
	}

	/** Drop everything (rebuild path). */
	clear(): void {
		this.mini = new MiniSearch(miniSearchOptions(this.weights));
	}
}
