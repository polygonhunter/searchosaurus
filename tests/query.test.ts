import { describe, expect, it } from "vitest";
import { containsPhrase, matchesTag, parseQuery } from "../src/core/query";

describe("parseQuery — kind operators", () => {
	it("parses n/f/i/l prefixes", () => {
		expect(parseQuery("n mira").kind).toBe("note");
		expect(parseQuery("f invoice").kind).toBe("file");
		expect(parseQuery("i whiteboard").kind).toBe("image");
		expect(parseQuery("l handbook").kind).toBe("link");
	});

	it("accepts d as file alias (merged document type)", () => {
		expect(parseQuery("d contract").kind).toBe("file");
	});

	it("is case-insensitive and strips the operator from text", () => {
		const parsed = parseQuery("N mira holt");
		expect(parsed.kind).toBe("note");
		expect(parsed.text).toBe("mira holt");
	});

	it("does not treat ordinary words as operators", () => {
		expect(parseQuery("note taking").kind).toBeNull();
		expect(parseQuery("if only").kind).toBeNull();
		expect(parseQuery("i").kind).toBeNull();
		expect(parseQuery("i ").kind).toBeNull();
	});
});

describe("parseQuery — filters", () => {
	it("extracts #tags folded", () => {
		const parsed = parseQuery("#Projekt mira");
		expect(parsed.tags).toEqual(["projekt"]);
		expect(parsed.text).toBe("mira");
	});

	it("supports tag-only queries", () => {
		const parsed = parseQuery("#project");
		expect(parsed.tags).toEqual(["project"]);
		expect(parsed.text).toBe("");
	});

	it("extracts -exclusions", () => {
		const parsed = parseQuery("mira -archive");
		expect(parsed.excludes).toEqual(["archive"]);
		expect(parsed.text).toBe("mira");
	});

	it("keeps a lone hyphen as text", () => {
		expect(parseQuery("a - b").excludes).toEqual([]);
	});

	it("extracts quoted phrases and feeds their words into text", () => {
		const parsed = parseQuery('"design tokens" handbook');
		expect(parsed.phrases).toEqual(["design tokens"]);
		expect(parsed.text).toBe("handbook design tokens");
	});

	it("extracts p:/path:/pfad: prefixes", () => {
		expect(parseQuery("p:People/ mira").pathPrefix).toBe("People/");
		expect(parseQuery("path:Projects/ x").pathPrefix).toBe("Projects/");
		expect(parseQuery("pfad:Archiv/ x").pathPrefix).toBe("Archiv/");
	});

	it("parses mod: aliases (German and English)", () => {
		expect(parseQuery("mira mod:heute").modifiedWithinDays).toBe(1);
		expect(parseQuery("mira mod:woche").modifiedWithinDays).toBe(7);
		expect(parseQuery("mira mod:month").modifiedWithinDays).toBe(31);
		expect(parseQuery("mira mod:jahr").modifiedWithinDays).toBe(366);
	});

	it("leaves unknown mod: values as text", () => {
		const parsed = parseQuery("mod:gestern");
		expect(parsed.modifiedWithinDays).toBeNull();
		expect(parsed.text).toBe("mod:gestern");
	});

	it("combines kind operator with filters", () => {
		const parsed = parseQuery('n #design "exact words" -old p:Projects/ mira mod:woche');
		expect(parsed.kind).toBe("note");
		expect(parsed.tags).toEqual(["design"]);
		expect(parsed.phrases).toEqual(["exact words"]);
		expect(parsed.excludes).toEqual(["old"]);
		expect(parsed.pathPrefix).toBe("Projects/");
		expect(parsed.modifiedWithinDays).toBe(7);
		expect(parsed.text).toBe("mira exact words");
	});
});

describe("containsPhrase", () => {
	it("matches verbatim after folding", () => {
		expect(containsPhrase("The Design Tokens are here", "design tokens")).toBe(true);
		expect(containsPhrase("Design of tokens", "design tokens")).toBe(false);
	});

	it("folds diacritics on both sides", () => {
		expect(containsPhrase("Müller Straße 5", "muller strasse")).toBe(true);
	});
});

describe("matchesTag", () => {
	it("matches exact and nested tags", () => {
		expect(matchesTag(["project"], "project")).toBe(true);
		expect(matchesTag(["project/design"], "project")).toBe(true);
		expect(matchesTag(["projection"], "project")).toBe(false);
	});
});
