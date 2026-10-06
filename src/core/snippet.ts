/**
 * Windowed excerpt around the first query match, with highlight ranges for
 * <mark> rendering. Works on the raw note body (read lazily per rendered
 * row); matching folds case, ß and diacritics exactly like the index does
 * (see match.ts), so umlaut hits get a real snippet too.
 */

import {
	findAllMatches,
	findFirstMatch,
	foldWithMap,
	prepareNeedles,
	stripFrontmatter,
	type FoldedText,
} from "./match";

export interface Snippet {
	text: string;
	/** [start, end) ranges within `text` to highlight. */
	ranges: Array<[number, number]>;
}

const DEFAULT_RADIUS = 80;

export function buildSnippet(
	body: string,
	queryWords: readonly string[],
	radius = DEFAULT_RADIUS,
): Snippet {
	const content = stripFrontmatter(body);
	return snippetFrom(content, foldWithMap(content), prepareNeedles(queryWords), radius);
}

/**
 * Same as buildSnippet, on content that is already frontmatter-free and
 * folded — lets callers cache the (comparatively expensive) folding per
 * file and reuse it across keystrokes. `needles` come from prepareNeedles.
 */
export function snippetFrom(
	content: string,
	folded: FoldedText,
	needles: readonly string[],
	radius = DEFAULT_RADIUS,
): Snippet {
	const match = needles.length > 0 ? findFirstMatch(folded, needles) : null;

	// No literal match (e.g. fuzzy hit): show the body's start.
	if (match === null) {
		return { text: cleanup(content.slice(0, radius * 2)), ranges: [] };
	}

	const windowStart = Math.max(0, match[0] - radius);
	const windowEnd = Math.min(content.length, match[1] + radius);
	const collapsed = cleanup(content.slice(windowStart, windowEnd));
	const text = `${windowStart > 0 ? "…" : ""}${collapsed}${windowEnd < content.length ? "…" : ""}`;
	return { text, ranges: findAllMatches(foldWithMap(text), needles) };
}

/** Collapse markdown noise and whitespace. */
function cleanup(raw: string): string {
	return raw
		.replace(/[#>*`[\]|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}
