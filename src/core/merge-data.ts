import type { FrecencyEntry } from "./frecency";
import { MAX_HISTORY } from "./history";

/** Structural copy of PersistentData (src/data.ts) — keeps core pure. */
export interface MergeableData {
	pins: string[];
	searchHistory: string[];
	frecency: Record<string, FrecencyEntry>;
}

/**
 * Merge the synced data.json (remote) into this device's state (local)
 * without losing either side's recent work (pure, unit-tested):
 *   - pins: follow the file. Pins change only by an explicit pin/unpin,
 *     which is saved right away — a union would make every unpin bounce
 *     back from any other running device (it writes its pin back).
 *   - frecency: per path the higher count and the later last-open
 *   - search history: local first, remote entries appended, bounded
 */
export function mergePersistentData(local: MergeableData, remote: MergeableData): MergeableData {
	const pins = [...remote.pins];

	const frecency: Record<string, FrecencyEntry> = {};
	for (const source of [local.frecency, remote.frecency]) {
		for (const [path, entry] of Object.entries(source)) {
			const current = frecency[path];
			frecency[path] = current
				? { count: Math.max(current.count, entry.count), last: Math.max(current.last, entry.last) }
				: { count: entry.count, last: entry.last };
		}
	}

	const history = [...local.searchHistory];
	for (const query of remote.searchHistory) if (!history.includes(query)) history.push(query);

	return { pins, searchHistory: history.slice(0, MAX_HISTORY), frecency };
}

/**
 * True when `b` carries nothing that `a` lacks, ignoring order — used to
 * decide whether a merge must be written back (order-only differences
 * between devices must not trigger endless save ping-pong).
 */
export function coversData(a: MergeableData, b: MergeableData): boolean {
	const pins = new Set(a.pins);
	if (b.pins.some((pin) => !pins.has(pin))) return false;
	for (const [path, entry] of Object.entries(b.frecency)) {
		const own = a.frecency[path];
		if (!own || own.count < entry.count || own.last < entry.last) return false;
	}
	return true;
}
