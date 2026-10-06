/**
 * Literal match finding on RAW text (note bodies, rendered preview text,
 * OCR output) that agrees with the index's folding: case, ß/ss and
 * diacritics are ignored, so "muller" highlights "Müller" and "strasse"
 * finds "Straße". Matches are reported in ORIGINAL text coordinates.
 * Pure — no obsidian imports, unit-tested in tests/match.test.ts.
 */

/** Combining marks left after NFD decomposition (é → e + ´). */
const COMBINING_MARK_RE = /[̀-ͯ]/g;
// eslint-disable-next-line no-control-regex -- ASCII range check, \x00 is intended
const ASCII_RE = /^[\x00-\x7f]*$/;

/** Needles shorter than this are ignored (they match everywhere). */
export const MIN_NEEDLE_LENGTH = 2;

export interface FoldedText {
	/** Folded text: lowercase, ß→ss, diacritics removed. Punctuation kept. */
	folded: string;
	/**
	 * folded index → original index; null means identity (pure ASCII).
	 * Has one extra trailing entry mapping folded.length → text.length.
	 */
	map: Int32Array | null;
	/** Length of the original text. */
	length: number;
}

/** Fold `text` while remembering where every folded char came from. */
export function foldWithMap(text: string): FoldedText {
	if (ASCII_RE.test(text)) {
		return { folded: text.toLowerCase(), map: null, length: text.length };
	}
	const out: string[] = [];
	const map: number[] = [];
	let i = 0;
	while (i < text.length) {
		const code = text.codePointAt(i) ?? 0;
		const char = String.fromCodePoint(code);
		const lower = char.toLowerCase();
		const piece =
			lower === "ß" ? "ss" : lower.normalize("NFD").replace(COMBINING_MARK_RE, "");
		for (let k = 0; k < piece.length; k++) {
			out.push(piece[k] as string);
			map.push(i);
		}
		i += char.length;
	}
	map.push(text.length);
	return { folded: out.join(""), map: Int32Array.from(map), length: text.length };
}

/** Folded index → original index. */
export function toOriginal(text: FoldedText, foldedIndex: number): number {
	if (text.map === null) return foldedIndex;
	return text.map[Math.min(foldedIndex, text.map.length - 1)] ?? text.length;
}

/** Fold query words for matching; drops too-short and duplicate needles. */
export function prepareNeedles(words: readonly string[]): string[] {
	const needles = new Set<string>();
	for (const word of words) {
		const needle = foldWithMap(word.trim()).folded;
		if (needle.length >= MIN_NEEDLE_LENGTH) needles.add(needle);
	}
	return [...needles];
}

export type Range = [start: number, end: number];

/** Earliest match of any needle at/after `from` (original coordinates). */
export function findFirstMatch(
	text: FoldedText,
	needles: readonly string[],
	from = 0,
): Range | null {
	let best = -1;
	let bestLength = 0;
	const foldedFrom = from === 0 ? 0 : toFolded(text, from);
	for (const needle of needles) {
		const index = text.folded.indexOf(needle, foldedFrom);
		if (index !== -1 && (best === -1 || index < best)) {
			best = index;
			bestLength = needle.length;
		}
	}
	if (best === -1) return null;
	return [toOriginal(text, best), toOriginal(text, best + bestLength)];
}

/** Every match of every needle, sorted and merged (original coordinates). */
export function findAllMatches(
	text: FoldedText,
	needles: readonly string[],
	limit = Number.POSITIVE_INFINITY,
): Range[] {
	const ranges: Range[] = [];
	for (const needle of needles) {
		let from = 0;
		while (ranges.length < limit) {
			const index = text.folded.indexOf(needle, from);
			if (index === -1) break;
			ranges.push([toOriginal(text, index), toOriginal(text, index + needle.length)]);
			from = index + needle.length;
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	return mergeRanges(ranges);
}

export function mergeRanges(ranges: readonly Range[]): Range[] {
	const merged: Range[] = [];
	for (const range of ranges) {
		const last = merged[merged.length - 1];
		if (last && range[0] <= last[1]) {
			last[1] = Math.max(last[1], range[1]);
		} else {
			merged.push([range[0], range[1]]);
		}
	}
	return merged;
}

/** Original index → first folded index at or after it. */
function toFolded(text: FoldedText, original: number): number {
	if (text.map === null) return original;
	// map is non-decreasing: binary search for the first entry >= original.
	let lo = 0;
	let hi = text.map.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if ((text.map[mid] ?? 0) < original) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** 0-based line number of `index` in `text`. */
export function lineAt(text: string, index: number): number {
	let line = 0;
	const end = Math.min(index, text.length);
	for (let i = 0; i < end; i++) {
		if (text.charCodeAt(i) === 10) line += 1;
	}
	return line;
}

/** YAML frontmatter at the very start, LF or CRLF line endings. */
const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/;

/** Length of the leading frontmatter block (0 when there is none). */
export function frontmatterLength(body: string): number {
	const match = FRONTMATTER_RE.exec(body);
	return match ? match[0].length : 0;
}

export function stripFrontmatter(body: string): string {
	const length = frontmatterLength(body);
	return length > 0 ? body.slice(length) : body;
}

/**
 * Window raw markdown around the first match, cut on line borders, at most
 * about `maxChars` long. Bodies that fit are returned whole.
 */
export function excerptAround(body: string, words: readonly string[], maxChars: number): string {
	if (body.length <= maxChars) return body;
	const match = findFirstMatch(foldWithMap(body), prepareNeedles(words));
	if (match === null) return body.slice(0, maxChars);
	const first = match[0];
	const start = body.lastIndexOf("\n", Math.max(0, first - maxChars / 3));
	const end = body.indexOf("\n", first + maxChars / 2);
	return body.slice(start === -1 ? 0 : start + 1, end === -1 ? body.length : end);
}
