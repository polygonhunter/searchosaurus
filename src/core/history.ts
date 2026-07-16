/** Search-query history, newest first, deduplicated, bounded. */

const MAX_HISTORY = 50;

export function pushHistory(history: readonly string[], query: string): string[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [...history];
	return [trimmed, ...history.filter((entry) => entry !== trimmed)].slice(0, MAX_HISTORY);
}
