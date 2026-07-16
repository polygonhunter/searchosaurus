/**
 * Windowed excerpt around the first query match, with highlight ranges for
 * <mark> rendering. Works on the raw note body (read lazily per rendered
 * row), so matching here is simple case-insensitive — the index already
 * guaranteed relevance, this is only about SHOWING the match.
 */

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
	const haystack = body.toLowerCase();
	const needles = queryWords.map((w) => w.toLowerCase()).filter((w) => w.length > 0);

	let first = -1;
	let firstLength = 0;
	for (const needle of needles) {
		const index = haystack.indexOf(needle);
		if (index !== -1 && (first === -1 || index < first)) {
			first = index;
			firstLength = needle.length;
		}
	}

	// No literal match (e.g. fuzzy/diacritic hit): show the body's start.
	if (first === -1) {
		const lead = cleanup(body.slice(0, radius * 2));
		return { text: lead.text, ranges: [] };
	}

	const windowStart = Math.max(0, first - radius);
	const windowEnd = Math.min(body.length, first + firstLength + radius);
	const raw = body.slice(windowStart, windowEnd);
	const { text, removedBefore } = cleanup(raw, windowStart > 0, windowEnd < body.length);

	const ranges: Array<[number, number]> = [];
	const windowHaystack = text.toLowerCase();
	for (const needle of needles) {
		let from = 0;
		while (true) {
			const index = windowHaystack.indexOf(needle, from);
			if (index === -1) break;
			ranges.push([index, index + needle.length]);
			from = index + needle.length;
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	void removedBefore;
	return { text, ranges: mergeOverlaps(ranges) };
}

/** Collapse markdown noise and whitespace; add ellipses at cut edges. */
function cleanup(
	raw: string,
	cutStart = false,
	cutEnd = false,
): { text: string; removedBefore: number } {
	const collapsed = raw
		.replace(/^---\n[\s\S]*?\n---\n?/, "") // frontmatter (when window starts at 0)
		.replace(/[#>*`[\]|]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	const text = `${cutStart ? "…" : ""}${collapsed}${cutEnd ? "…" : ""}`;
	return { text, removedBefore: 0 };
}

function mergeOverlaps(ranges: Array<[number, number]>): Array<[number, number]> {
	const merged: Array<[number, number]> = [];
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
