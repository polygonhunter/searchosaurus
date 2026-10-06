import { describe, expect, it } from "vitest";
import { coversData, mergePersistentData } from "../src/core/merge-data";

describe("mergePersistentData", () => {
	it("takes pins from the file, so an unpin elsewhere sticks", () => {
		const merged = mergePersistentData(
			{ pins: ["a", "b"], searchHistory: [], frecency: {} },
			{ pins: ["c", "a"], searchHistory: [], frecency: {} },
		);
		expect(merged.pins).toEqual(["c", "a"]);
	});

	it("does not write an unpinned path back (no ping-pong)", () => {
		const remote = { pins: ["b"], searchHistory: [], frecency: {} };
		const merged = mergePersistentData({ pins: ["a", "b"], searchHistory: [], frecency: {} }, remote);
		expect(coversData(remote, merged)).toBe(true);
	});

	it("keeps the higher count and later open per path", () => {
		const merged = mergePersistentData(
			{ pins: [], searchHistory: [], frecency: { x: { count: 5, last: 100 }, y: { count: 1, last: 1 } } },
			{ pins: [], searchHistory: [], frecency: { x: { count: 2, last: 300 }, z: { count: 3, last: 3 } } },
		);
		expect(merged.frecency).toEqual({
			x: { count: 5, last: 300 },
			y: { count: 1, last: 1 },
			z: { count: 3, last: 3 },
		});
	});

	it("merges history without duplicates, local first, bounded", () => {
		const remote = Array.from({ length: 60 }, (_, i) => `r${i}`);
		const merged = mergePersistentData(
			{ pins: [], searchHistory: ["l1", "r0"], frecency: {} },
			{ pins: [], searchHistory: remote, frecency: {} },
		);
		expect(merged.searchHistory.slice(0, 3)).toEqual(["l1", "r0", "r1"]);
		expect(merged.searchHistory).toHaveLength(50);
	});

	it("does not mutate its inputs", () => {
		const local = { pins: ["a"], searchHistory: [], frecency: { x: { count: 1, last: 1 } } };
		mergePersistentData(local, { pins: ["b"], searchHistory: [], frecency: { x: { count: 9, last: 9 } } });
		expect(local).toEqual({ pins: ["a"], searchHistory: [], frecency: { x: { count: 1, last: 1 } } });
	});
});

describe("coversData", () => {
	it("ignores order but notices missing pins and newer opens", () => {
		const a = { pins: ["a", "b"], searchHistory: [], frecency: { x: { count: 2, last: 5 } } };
		expect(coversData(a, { pins: ["b", "a"], searchHistory: [], frecency: {} })).toBe(true);
		expect(coversData(a, { pins: ["c"], searchHistory: [], frecency: {} })).toBe(false);
		expect(coversData(a, { pins: [], searchHistory: [], frecency: { x: { count: 2, last: 6 } } })).toBe(false);
	});
});
