import { describe, expect, it } from "vitest";
import { buildSnippet } from "../src/core/snippet";

describe("buildSnippet", () => {
	it("windows around the first match and highlights it", () => {
		const body = `${"x".repeat(500)} the answer is mira holt obviously ${"y".repeat(500)}`;
		const snippet = buildSnippet(body, ["mira"]);
		expect(snippet.text).toContain("mira holt");
		expect(snippet.text.length).toBeLessThan(300);
		expect(snippet.ranges.length).toBeGreaterThan(0);
		const [start, end] = snippet.ranges[0]!;
		expect(snippet.text.slice(start, end)).toBe("mira");
	});

	it("marks all query words inside the window", () => {
		const snippet = buildSnippet("mira spoke to holt about mira", ["mira", "holt"]);
		const marked = snippet.ranges.map(([s, e]) => snippet.text.slice(s, e));
		expect(marked).toContain("holt");
		expect(marked.filter((m) => m === "mira")).toHaveLength(2);
	});

	it("is case-insensitive", () => {
		const snippet = buildSnippet("Mira Holt was here", ["mira"]);
		const [start, end] = snippet.ranges[0]!;
		expect(snippet.text.slice(start, end)).toBe("Mira");
	});

	it("falls back to the body start when nothing matches literally", () => {
		const snippet = buildSnippet("Just some regular text without the term.", ["zzz"]);
		expect(snippet.text).toContain("Just some regular text");
		expect(snippet.ranges).toEqual([]);
	});

	it("collapses markdown noise", () => {
		const snippet = buildSnippet("## Heading\n> quote **mira**", ["mira"]);
		expect(snippet.text).not.toContain("#");
		expect(snippet.text).not.toContain(">");
	});

	it("adds ellipses at cut edges", () => {
		const body = `${"a".repeat(300)} mira ${"b".repeat(300)}`;
		const snippet = buildSnippet(body, ["mira"]);
		expect(snippet.text.startsWith("…")).toBe(true);
		expect(snippet.text.endsWith("…")).toBe(true);
	});

	it("merges overlapping ranges", () => {
		const snippet = buildSnippet("miramira", ["mira", "amir"]);
		for (let i = 1; i < snippet.ranges.length; i++) {
			expect(snippet.ranges[i]![0]).toBeGreaterThanOrEqual(snippet.ranges[i - 1]![1]);
		}
	});
});
