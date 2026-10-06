import { describe, expect, it } from "vitest";
import { fold, foldedWords, processTerm } from "../src/core/normalize";

describe("fold", () => {
	it("lowercases and trims", () => {
		expect(fold("  Mira Holt  ")).toBe("mira holt");
	});

	it("folds German umlauts and ß", () => {
		expect(fold("Müller")).toBe("muller");
		expect(fold("Straße")).toBe("strasse");
		expect(fold("Ärger Öl Übung")).toBe("arger ol ubung");
	});

	it("folds other diacritics", () => {
		expect(fold("Café Zoë")).toBe("cafe zoe");
	});

	it("strips punctuation but keeps digits", () => {
		expect(fold("Meeting (2026-07-16)!")).toBe("meeting 2026 07 16");
	});

	it("collapses whitespace", () => {
		expect(fold("a\t b\n  c")).toBe("a b c");
	});
});

describe("processTerm", () => {
	it("returns folded terms", () => {
		expect(processTerm("Müller")).toBe("muller");
	});

	it("drops terms that fold to nothing", () => {
		expect(processTerm("!!!")).toBeNull();
		expect(processTerm("")).toBeNull();
	});
});

describe("foldedWords", () => {
	it("splits folded text into words", () => {
		expect(foldedWords("Mira  Holt")).toEqual(["mira", "holt"]);
	});

	it("returns [] for empty/punctuation-only input", () => {
		expect(foldedWords(" … ")).toEqual([]);
	});
});

describe("processTerm fast path", () => {
	it("agrees with fold() for plain and non-plain terms", () => {
		for (const term of ["Hello", "abc123", "Müller", "Straße", "café", "C++", "---", "ÄÖÜ", "x"]) {
			const folded = fold(term);
			expect(processTerm(term)).toBe(folded.length > 0 ? folded : null);
		}
	});
});
