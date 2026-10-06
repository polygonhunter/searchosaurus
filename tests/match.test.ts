import { describe, expect, it } from "vitest";
import {
	excerptAround,
	findAllMatches,
	findFirstMatch,
	foldWithMap,
	frontmatterLength,
	lineAt,
	prepareNeedles,
	stripFrontmatter,
} from "../src/core/match";

const slice = (text: string, range: readonly [number, number] | null) =>
	range ? text.slice(range[0], range[1]) : null;

describe("foldWithMap", () => {
	it("folds umlauts, ß and accents with an index map", () => {
		const text = "Straße Café Müller";
		const folded = foldWithMap(text);
		expect(folded.folded).toBe("strasse cafe muller");
		expect(folded.map).not.toBeNull();
	});

	it("uses the identity fast path for ASCII", () => {
		const folded = foldWithMap("Hello World");
		expect(folded.folded).toBe("hello world");
		expect(folded.map).toBeNull();
	});
});

describe("findFirstMatch / findAllMatches", () => {
	it("matches folded needles and reports original coordinates", () => {
		const text = "Gespräch mit Herrn Müller über die Straße";
		const folded = foldWithMap(text);
		expect(slice(text, findFirstMatch(folded, prepareNeedles(["muller"])))).toBe("Müller");
		expect(slice(text, findFirstMatch(folded, prepareNeedles(["strasse"])))).toBe("Straße");
		expect(slice(text, findFirstMatch(folded, prepareNeedles(["Straße"])))).toBe("Straße");
	});

	it("handles accents: cafe finds Café", () => {
		const text = "Treffen im Café um 9";
		expect(slice(text, findFirstMatch(foldWithMap(text), prepareNeedles(["cafe"])))).toBe("Café");
	});

	it("handles decomposed (NFD) input", () => {
		const text = "Müller";
		expect(slice(text, findFirstMatch(foldWithMap(text), ["muller"]))).toBe(text);
	});

	it("finds all matches sorted and merged", () => {
		const text = "Müller trifft müller";
		const ranges = findAllMatches(foldWithMap(text), prepareNeedles(["muller"]));
		expect(ranges.map((r) => text.slice(r[0], r[1]))).toEqual(["Müller", "müller"]);
	});

	it("respects a start offset", () => {
		const text = "alpha beta alpha";
		expect(findFirstMatch(foldWithMap(text), ["alpha"], 1)).toEqual([11, 16]);
	});

	it("ignores needles shorter than two characters", () => {
		expect(prepareNeedles(["a", "", " ", "ab"])).toEqual(["ab"]);
	});
});

describe("frontmatter", () => {
	it("strips LF frontmatter", () => {
		expect(stripFrontmatter("---\ntags: x\n---\nBody")).toBe("Body");
	});

	it("strips CRLF frontmatter", () => {
		const body = "---\r\ntags: x\r\n---\r\nBody";
		expect(stripFrontmatter(body)).toBe("Body");
		expect(frontmatterLength(body)).toBe(body.length - 4);
	});

	it("strips frontmatter at end of file", () => {
		expect(stripFrontmatter("---\na: 1\n---")).toBe("");
	});

	it("leaves bodies without frontmatter alone", () => {
		expect(stripFrontmatter("No --- here")).toBe("No --- here");
	});
});

describe("lineAt / excerptAround", () => {
	it("counts lines up to an index", () => {
		const text = "a\nb\nc Müller";
		expect(lineAt(text, text.indexOf("Müller"))).toBe(2);
	});

	it("windows long bodies around an umlaut match", () => {
		const body = `${"x\n".repeat(2000)}Hier steht Müller.\n${"y\n".repeat(2000)}`;
		const excerpt = excerptAround(body, ["muller"], 300);
		expect(excerpt).toContain("Müller");
		expect(excerpt.length).toBeLessThan(400);
	});

	it("returns short bodies whole", () => {
		expect(excerptAround("short", ["x"], 300)).toBe("short");
	});
});
