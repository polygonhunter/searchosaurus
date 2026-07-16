import { describe, expect, it } from "vitest";
import {
	bumpFrecency,
	frecencyScore,
	pruneFrecency,
	renameFrecency,
	topFrecent,
	type FrecencyEntry,
} from "../src/core/frecency";

const DAY = 24 * 60 * 60 * 1000;

describe("frecency", () => {
	it("bumps counts and updates last-open", () => {
		const map: Record<string, FrecencyEntry> = {};
		bumpFrecency(map, "a.md", 1000);
		bumpFrecency(map, "a.md", 2000);
		expect(map["a.md"]).toEqual({ count: 2, last: 2000 });
	});

	it("decays by half every two weeks", () => {
		const entry: FrecencyEntry = { count: 8, last: 0 };
		expect(frecencyScore(entry, 0)).toBe(8);
		expect(frecencyScore(entry, 14 * DAY)).toBeCloseTo(4);
		expect(frecencyScore(entry, 28 * DAY)).toBeCloseTo(2);
	});

	it("ranks frequent-and-recent above merely frequent", () => {
		const now = 100 * DAY;
		const map: Record<string, FrecencyEntry> = {
			"old-favourite.md": { count: 50, last: now - 90 * DAY },
			"current-project.md": { count: 10, last: now - DAY },
		};
		expect(topFrecent(map, now, 2)[0]).toBe("current-project.md");
	});

	it("excludes given paths (pins are listed separately)", () => {
		const map: Record<string, FrecencyEntry> = {
			"a.md": { count: 5, last: 0 },
			"b.md": { count: 1, last: 0 },
		};
		expect(topFrecent(map, 0, 5, new Set(["a.md"]))).toEqual(["b.md"]);
	});

	it("prunes the lowest-scoring tail past the cap", () => {
		const map: Record<string, FrecencyEntry> = {};
		for (let i = 0; i < 450; i++) {
			map[`note-${i}.md`] = { count: i + 1, last: 0 };
		}
		pruneFrecency(map, 0);
		expect(Object.keys(map).length).toBe(400);
		expect(map["note-449.md"]).toBeDefined(); // highest kept
		expect(map["note-0.md"]).toBeUndefined(); // lowest dropped
	});

	it("carries history across renames", () => {
		const map: Record<string, FrecencyEntry> = { "old.md": { count: 3, last: 7 } };
		renameFrecency(map, "old.md", "new.md");
		expect(map["new.md"]).toEqual({ count: 3, last: 7 });
		expect(map["old.md"]).toBeUndefined();
	});
});
