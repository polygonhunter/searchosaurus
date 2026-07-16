import { fold } from "./normalize";
import type { ResultKind } from "./types";

/**
 * Parsed search input. Every filter is optional; `text` is what remains for
 * the full-text engine after all operator tokens are consumed.
 */
export interface ParsedQuery {
	/** Leading n/f/i/l (d = f alias) operator, if any. */
	kind: ResultKind | null;
	text: string;
	/** #tag tokens (folded, '#' stripped). */
	tags: string[];
	/** p:/path:/pfad: prefix filter (verbatim, case-insensitive compare). */
	pathPrefix: string | null;
	/** "quoted" exact phrases (verbatim; fold at match time). */
	phrases: string[];
	/** -excluded words. */
	excludes: string[];
	/** mod:… recency filter in days, null = no filter. */
	modifiedWithinDays: number | null;
}

const KIND_BY_LETTER: Record<string, ResultKind> = {
	n: "note",
	f: "file",
	d: "file", // "document" — merged into file, but the muscle memory works
	i: "image",
	l: "link",
};

const MOD_ALIASES: Record<string, number> = {
	today: 1,
	heute: 1,
	week: 7,
	woche: 7,
	month: 31,
	monat: 31,
	year: 366,
	jahr: 366,
};

const PHRASE_RE = /"([^"]*)"/g;

/**
 * Parse the raw prompt input. Grammar:
 *   - leading `n `, `f `, `d `, `i `, `l ` → type operator (title-focused search)
 *   - `#tag` → tag filter (nested tags match by prefix)
 *   - `-word` → exclusion
 *   - `"exact phrase"` → phrase filter
 *   - `p:folder/` (or path:/pfad:) → path prefix filter
 *   - `mod:heute|woche|monat|jahr` (or today|week|month|year) → recency filter
 * Everything else stays in `text`.
 */
export function parseQuery(raw: string): ParsedQuery {
	const result: ParsedQuery = {
		kind: null,
		text: "",
		tags: [],
		pathPrefix: null,
		phrases: [],
		excludes: [],
		modifiedWithinDays: null,
	};

	let rest = raw;

	const kindMatch = /^([nfdil])\s+(\S[\s\S]*)$/i.exec(rest);
	if (kindMatch && kindMatch[1] && kindMatch[2] !== undefined) {
		result.kind = KIND_BY_LETTER[kindMatch[1].toLowerCase()] ?? null;
		rest = kindMatch[2];
	}

	rest = rest.replace(PHRASE_RE, (_all, phrase: string) => {
		const trimmed = phrase.trim();
		if (trimmed.length > 0) result.phrases.push(trimmed);
		return " ";
	});

	const words: string[] = [];
	for (const token of rest.split(/\s+/)) {
		if (token.length === 0) continue;
		if (token.startsWith("#") && token.length > 1) {
			result.tags.push(fold(token.slice(1)));
			continue;
		}
		if (token.startsWith("-") && token.length > 1) {
			result.excludes.push(token.slice(1));
			continue;
		}
		const colon = /^(p|path|pfad):(.+)$/i.exec(token);
		if (colon && colon[2]) {
			result.pathPrefix = colon[2];
			continue;
		}
		const mod = /^mod:(\S+)$/i.exec(token);
		if (mod && mod[1]) {
			const days = MOD_ALIASES[mod[1].toLowerCase()];
			if (days !== undefined) {
				result.modifiedWithinDays = days;
				continue;
			}
		}
		words.push(token);
	}

	// Phrase words also feed the engine query — the phrase itself is
	// verified verbatim afterwards (containsPhrase) on the candidates.
	result.text = [...words, ...result.phrases].join(" ").trim();
	return result;
}

/** Does `text` contain `phrase` verbatim after folding? */
export function containsPhrase(text: string, phrase: string): boolean {
	const foldedPhrase = fold(phrase);
	if (foldedPhrase.length === 0) return true;
	return fold(text).includes(foldedPhrase);
}

/** Does any of the (folded) stored tags match the folded query tag? */
export function matchesTag(tagList: readonly string[], foldedQueryTag: string): boolean {
	return tagList.some((tag) => {
		const foldedTag = fold(tag);
		return foldedTag === foldedQueryTag || foldedTag.startsWith(`${foldedQueryTag} `);
	});
}
