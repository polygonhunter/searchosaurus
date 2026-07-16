import type { FrecencyEntry } from "./core/frecency";

/**
 * Small, synced per-user state (lives in data.json next to the settings —
 * deliberately NOT in the machine-local index cache).
 */
export interface PersistentData {
	/** Pinned paths, in pin order — shown first in the empty state. */
	pins: string[];
	/** Recent search queries, newest first (↑ in the empty input). */
	searchHistory: string[];
	/** path → open stats for the frecency launcher. */
	frecency: Record<string, FrecencyEntry>;
}

export const DEFAULT_DATA: PersistentData = {
	pins: [],
	searchHistory: [],
	frecency: {},
};
