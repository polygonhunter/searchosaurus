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
 * processTerm for MiniSearch: folded term(s), or null to drop the term. Runs
 * for every token of every indexed note — plain ASCII words (the vast
 * majority) skip the NFD/regex pipeline.
 *
 * MiniSearch's tokenizer only splits on whitespace and Unicode punctuation,
 * so symbol-joined tokens ("Holt|Miri" from [[Mira Holt|Miri]], "a=b",
 * "x+y") arrive whole. fold() turns the symbols into spaces — those words
 * are returned separately, or "miri" would never be found.
 */
export function processTerm(term: string): string | string[] | null {
	const lower = term.toLowerCase();
	if (PLAIN_TERM_RE.test(lower)) return lower;
	const folded = fold(term);
	if (folded.length === 0) return null;
	return folded.includes(" ") ? folded.split(" ") : folded;
}

/** Folded whitespace-split words of a query or title. */
export function foldedWords(text: string): string[] {
	const folded = fold(text);
	return folded.length > 0 ? folded.split(" ") : [];
}
