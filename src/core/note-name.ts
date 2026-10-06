/**
 * Turn free search text into a safe note filename (pure, unit-tested).
 * Strips characters Obsidian or the OS reject in file names or that break
 * wikilinks (\ / : * ? " < > | # ^ [ ]), collapses whitespace and drops
 * leading dots (hidden files). Returns "" when nothing usable is left.
 */
const INVALID_CHARS_RE = /[\\/:*?"<>|#^[\]]/g;
const MAX_NAME_LENGTH = 200;

export function sanitizeNoteName(raw: string): string {
	return raw
		.replace(INVALID_CHARS_RE, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.trim()
		.slice(0, MAX_NAME_LENGTH)
		.trim();
}
