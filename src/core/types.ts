/**
 * Shared pure types for the search core. No `obsidian` imports anywhere
 * under src/core/ — everything here is unit-tested directly.
 */

/** The four result families Searchosaurus distinguishes. */
export type ResultKind = "note" | "file" | "image" | "link";

/** Per-field relevance boosts used by the MiniSearch engine. */
export interface FieldWeights {
	basename: number;
	aliases: number;
	headings: number;
	tags: number;
	url: number;
	body: number;
	extractedText: number;
}

/**
 * Title fields dominate on purpose: the person's own note must always be
 * able to beat notes that merely mention the name (see core/rank.ts for the
 * deterministic tier on top of these).
 */
export const DEFAULT_WEIGHTS: FieldWeights = {
	basename: 5,
	aliases: 4,
	headings: 2.5,
	tags: 2,
	url: 1.5,
	body: 1,
	extractedText: 0.8,
};

/**
 * One document in the index. Notes/files/images use their vault path as id;
 * link docs (external URLs found inside a note) use `${notePath}::L${offset}`
 * so a note and its links can be replaced independently.
 */
export interface IndexedDoc {
	id: string;
	kind: ResultKind;
	/** Filename without extension; for link docs: the link's display text. */
	basename: string;
	/** Frontmatter aliases, space-joined (notes only). */
	aliases: string;
	/** Heading texts, space-joined (notes only). */
	headings: string;
	/** Tags without '#', space-joined (notes only). */
	tags: string;
	/** Note body. Indexed but NOT stored — snippets are read lazily. */
	body: string;
	/** OCR / PDF-extracted text (images and files only). */
	extractedText: string;
	/** External URL (link docs only). */
	url: string;
	// --- stored-only fields (returned with every hit) ---
	path: string;
	mtime: number;
	/** Alias list kept verbatim for exact/prefix tier checks in rank.ts. */
	aliasList: string[];
	/** Tag list kept verbatim (no '#') for post-search #tag filtering. */
	tagList: string[];
	/** Line number of the link inside its note (link docs only). */
	line?: number;
}

/** A search hit: MiniSearch score + the stored fields of the matched doc. */
export interface SearchHit {
	id: string;
	score: number;
	kind: ResultKind;
	path: string;
	basename: string;
	mtime: number;
	aliasList: string[];
	tagList: string[];
	url?: string;
	line?: number;
	/** Unresolved [[wikilink]] target — choosing it creates the note. */
	ghost?: boolean;
	/** Synthetic "create this note" row shown when nothing matches. */
	create?: boolean;
}
