/**
 * Text normalization shared by EVERY comparison layer: MiniSearch's
 * processTerm (index + query time) and the title-tier checks in rank.ts.
 * If these ever diverge, umlaut titles silently stop hitting tier 0.
 */

/** Strips combining marks left over after NFD decomposition (é → e). */
const COMBINING_MARKS_RE = /[̀-ͯ]/g;

/** Anything that is neither letter, digit nor whitespace. */
const PUNCTUATION_RE = /[^\p{L}\p{N}\s]/gu;

/**
 * Fold a term or title for matching: lowercase, ß→ss, diacritics removed,
 * punctuation stripped, whitespace collapsed. Returns "" for empty input —
 * callers feeding MiniSearch's processTerm map "" to null themselves.
 */
export function fold(text: string): string {
	return text
		.toLowerCase()
		.replace(/ß/g, "ss")
		.normalize("NFD")
		.replace(COMBINING_MARKS_RE, "")
		.replace(PUNCTUATION_RE, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Already-folded shape: nothing for fold() to do after lowercasing. */
const PLAIN_TERM_RE = /^[a-z0-9]+$/;

/**
 * processTerm for MiniSearch: folded term, or null to drop the term. Runs
 * for every token of every indexed note — plain ASCII words (the vast
 * majority) skip the NFD/regex pipeline.
 */
export function processTerm(term: string): string | null {
	const lower = term.toLowerCase();
	if (PLAIN_TERM_RE.test(lower)) return lower;
	const folded = fold(term);
	return folded.length > 0 ? folded : null;
}

/** Folded whitespace-split words of a query or title. */
export function foldedWords(text: string): string[] {
	const folded = fold(text);
	return folded.length > 0 ? folded.split(" ") : [];
}
