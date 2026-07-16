/**
 * Frecency (frequency + recency) for the empty-state launcher: files you
 * open often and recently float up. Pure math — the plugin feeds open
 * events in and asks for the top list.
 */

export interface FrecencyEntry {
	/** How often the file was opened (capped). */
	count: number;
	/** Last open, epoch ms. */
	last: number;
}

const HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000; // two weeks
const MAX_COUNT = 1000;
const MAX_ENTRIES = 400;

export function bumpFrecency(map: Record<string, FrecencyEntry>, path: string, now: number): void {
	const entry = map[path];
	if (entry) {
		entry.count = Math.min(entry.count + 1, MAX_COUNT);
		entry.last = now;
	} else {
		map[path] = { count: 1, last: now };
	}
}

/** Count decayed by elapsed half-lives — old favourites fade, never snap. */
export function frecencyScore(entry: FrecencyEntry, now: number): number {
	return entry.count * Math.pow(0.5, Math.max(0, now - entry.last) / HALF_LIFE_MS);
}

export function topFrecent(
	map: Record<string, FrecencyEntry>,
	now: number,
	limit: number,
	exclude: ReadonlySet<string> = new Set(),
): string[] {
	return Object.entries(map)
		.filter(([path]) => !exclude.has(path))
		.map(([path, entry]) => [path, frecencyScore(entry, now)] as const)
		.sort((a, b) => b[1] - a[1])
		.slice(0, limit)
		.map(([path]) => path);
}

/** Keep the map bounded; drop the lowest-scoring tail. */
export function pruneFrecency(map: Record<string, FrecencyEntry>, now: number): void {
	const entries = Object.entries(map);
	if (entries.length <= MAX_ENTRIES) return;
	entries.sort((a, b) => frecencyScore(b[1], now) - frecencyScore(a[1], now));
	for (const [path] of entries.slice(MAX_ENTRIES)) delete map[path];
}

/** A rename keeps the file's history. */
export function renameFrecency(
	map: Record<string, FrecencyEntry>,
	oldPath: string,
	newPath: string,
): void {
	const entry = map[oldPath];
	if (!entry) return;
	delete map[oldPath];
	map[newPath] = entry;
}
