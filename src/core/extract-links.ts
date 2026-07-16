/**
 * External-URL extraction from markdown. Each URL becomes its own link doc
 * in the index (searchable by display text and URL), so "where did I save
 * that link again?" is a first-class query.
 */

export interface ExtractedLink {
	url: string;
	/** Display text of the link; "" for bare/auto links. */
	text: string;
	/** Character offset of the link within the note (stable doc-id part). */
	offset: number;
	/** 0-based line number, for jump-to-location. */
	line: number;
}

/** `[text](https://…)` — group 1 is the image `!`, kept to skip embeds. */
const MD_LINK_RE = /(!?)\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
/** `<https://…>` autolinks. */
const AUTOLINK_RE = /<(https?:\/\/[^>\s]+)>/g;
/** Bare URLs; trailing punctuation is trimmed afterwards. */
const BARE_URL_RE = /https?:\/\/[^\s<>"'\])}]+/g;

export function extractExternalLinks(markdown: string): ExtractedLink[] {
	const links: ExtractedLink[] = [];
	/** [start, end) ranges already consumed by a structured link form. */
	const taken: Array<[number, number]> = [];

	for (const match of markdown.matchAll(MD_LINK_RE)) {
		const [full, bang, text, url] = match;
		const offset = match.index;
		taken.push([offset, offset + full.length]);
		if (bang === "!") continue; // image embed, not a link
		if (url === undefined) continue;
		links.push({ url, text: (text ?? "").trim(), offset, line: 0 });
	}

	for (const match of markdown.matchAll(AUTOLINK_RE)) {
		const offset = match.index;
		if (isTaken(taken, offset)) continue;
		taken.push([offset, offset + match[0].length]);
		if (match[1] === undefined) continue;
		links.push({ url: match[1], text: "", offset, line: 0 });
	}

	for (const match of markdown.matchAll(BARE_URL_RE)) {
		const offset = match.index;
		if (isTaken(taken, offset)) continue;
		const url = match[0].replace(/[.,;:!?]+$/, "");
		links.push({ url, text: "", offset, line: 0 });
	}

	links.sort((a, b) => a.offset - b.offset);
	assignLines(markdown, links);
	return links;
}

function isTaken(taken: ReadonlyArray<[number, number]>, offset: number): boolean {
	return taken.some(([start, end]) => offset >= start && offset < end);
}

/** Single pass over the text; links are sorted by offset. */
function assignLines(markdown: string, links: ExtractedLink[]): void {
	let line = 0;
	let scanned = 0;
	for (const link of links) {
		for (let i = scanned; i < link.offset; i++) {
			if (markdown.charCodeAt(i) === 10) line += 1;
		}
		scanned = link.offset;
		link.line = line;
	}
}

/** Compact label for a bare URL: host + trimmed path. */
export function labelForUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const path = parsed.pathname === "/" ? "" : parsed.pathname;
		return `${parsed.hostname}${path}`;
	} catch {
		return url;
	}
}
