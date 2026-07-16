import { describe, expect, it } from "vitest";
import { fold, foldedWords, processTerm } from "../src/core/normalize";

describe("fold", () => {
	it("lowercases and trims", () => {
		expect(fold("  Ocean Menon  ")).toBe("ocean menon");
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
		expect(foldedWords("Ocean  Menon")).toEqual(["ocean", "menon"]);
	});

	it("returns [] for empty/punctuation-only input", () => {
		expect(foldedWords(" … ")).toEqual([]);
	});
});
