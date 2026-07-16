import { fold, foldedWords } from "./normalize";
import type { SearchHit } from "./types";

export type SortMode = "relevance" | "modified";

/**
 * The plugin's reason to exist: BM25 with field boosts alone cannot
 * guarantee that a person's own note beats notes that merely mention the
 * name (Omnisearch #289). So relevance mode layers deterministic tiers on
 * top of the engine score:
 *
 *   tier 0 — the folded query IS the title (or an alias)
 *   tier 1 — the title/alias starts with the query, or every query word
 *            prefix-matches a title word in order ("mi ho" → "Mira Holt")
 *   tier 2 — everything else, by BM25 score
 */
export function rankResults(
	hits: readonly SearchHit[],
	queryText: string,
	sortMode: SortMode,
): SearchHit[] {
	if (sortMode === "modified") {
		return [...hits].sort((a, b) => b.mtime - a.mtime);
	}

	const q = fold(queryText);
	const qWords = foldedWords(queryText);

	const tierOf = (hit: SearchHit): number => {
		if (q.length === 0) return 2;
		const title = fold(hit.basename);
		if (title === q) return 0;
		const aliases = hit.aliasList.map(fold);
		if (aliases.includes(q)) return 0;
		if (title.startsWith(q)) return 1;
		if (aliases.some((alias) => alias.startsWith(q))) return 1;
		if (qWords.length > 1 && wordsPrefixMatchInOrder(qWords, title.split(" "))) return 1;
		return 2;
	};

	const tiers = new Map<SearchHit, number>();
	for (const hit of hits) tiers.set(hit, tierOf(hit));

	return [...hits].sort((a, b) => {
		const tierA = tiers.get(a) ?? 2;
		const tierB = tiers.get(b) ?? 2;
		if (tierA !== tierB) return tierA - tierB;
		if (tierA < 2) {
			// Within a title tier the shortest title is the most exact match.
			return a.basename.length - b.basename.length || b.mtime - a.mtime;
		}
		return b.score - a.score || b.mtime - a.mtime;
	});
}

/** Every query word prefix-matches a distinct title word, left to right. */
function wordsPrefixMatchInOrder(queryWords: readonly string[], titleWords: readonly string[]): boolean {
	let position = 0;
	for (const queryWord of queryWords) {
		let matched = false;
		while (position < titleWords.length) {
			const titleWord = titleWords[position];
			position += 1;
			if (titleWord !== undefined && titleWord.startsWith(queryWord)) {
				matched = true;
				break;
			}
		}
		if (!matched) return false;
	}
	return true;
}
