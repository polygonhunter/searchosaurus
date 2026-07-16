import { describe, expect, it } from "vitest";
import { SearchEngine } from "../src/core/engine";
import { rankResults } from "../src/core/rank";
import { DEFAULT_WEIGHTS, type IndexedDoc, type SearchHit } from "../src/core/types";

function doc(overrides: Partial<IndexedDoc> & { id: string }): IndexedDoc {
	return {
		kind: "note",
		basename: "",
		aliases: "",
		headings: "",
		tags: "",
		body: "",
		extractedText: "",
		url: "",
		path: overrides.id,
		mtime: 0,
		aliasList: [],
		tagList: [],
		...overrides,
	};
}

/**
 * THE acid test — the reason this plugin exists. A person's own note must
 * beat any number of notes that merely mention or link the name, through a
 * REAL engine (not mocked hits), exactly like production.
 */
function personVault(): SearchEngine {
	const engine = new SearchEngine(DEFAULT_WEIGHTS);
	engine.upsert(
		doc({
			id: "People/Mira Holt.md",
			basename: "Mira Holt",
			aliases: "Miri",
			aliasList: ["Miri"],
			body: "Product designer at Driftwood Labs.",
			mtime: 1000, // deliberately OLD — mentions are newer
		}),
	);
	for (let i = 0; i < 10; i++) {
		engine.upsert(
			doc({
				id: `Journal/entry-${i}.md`,
				basename: `entry-${i}`,
				body:
					"Talked to Mira Holt today. Mira Holt suggested changes. " +
					"Mira Holt, Mira Holt, Mira Holt everywhere in this note. " +
					"Later Mira Holt called again about Mira Holt topics.",
				mtime: 2000 + i,
			}),
		);
	}
	return engine;
}

function searchRanked(engine: SearchEngine, query: string): string[] {
	const ranked = rankResults(engine.search(query), query, "relevance");
	return ranked.map((hit) => hit.id);
}

describe("rankResults — person-note acid test", () => {
	it("full name: the person note is first despite 10 mention-heavy notes", () => {
		expect(searchRanked(personVault(), "Mira Holt")[0]).toBe("People/Mira Holt.md");
	});

	it("single word prefix: person note first", () => {
		expect(searchRanked(personVault(), "mira")[0]).toBe("People/Mira Holt.md");
	});

	it("alias: person note first", () => {
		expect(searchRanked(personVault(), "miri")[0]).toBe("People/Mira Holt.md");
	});

	it("word-prefix combo (mi ho): person note first", () => {
		expect(searchRanked(personVault(), "mi ho")[0]).toBe("People/Mira Holt.md");
	});

	it("umlaut-folded query still reaches tier 0", () => {
		const engine = new SearchEngine(DEFAULT_WEIGHTS);
		engine.upsert(doc({ id: "m.md", basename: "Max Müller" }));
		engine.upsert(
			doc({ id: "n.md", basename: "notes", body: "Max Müller Max Müller Max Müller" }),
		);
		expect(searchRanked(engine, "max muller")[0]).toBe("m.md");
	});
});

function hit(overrides: Partial<SearchHit> & { id: string }): SearchHit {
	return {
		score: 0,
		kind: "note",
		path: `${overrides.id}.md`,
		basename: overrides.id,
		mtime: 0,
		aliasList: [],
		tagList: [],
		...overrides,
	};
}

describe("rankResults — tiers and sorting", () => {
	it("exact beats prefix beats score", () => {
		const hits = [
			hit({ id: "c", score: 99, basename: "Design Handbook Notes" }),
			hit({ id: "b", score: 1, basename: "Design Handbook" }),
			hit({ id: "a", score: 1, basename: "Design" }),
		];
		const ranked = rankResults(hits, "design", "relevance");
		expect(ranked.map((h) => h.id)).toEqual(["a", "b", "c"]);
	});

	it("shorter title wins within the prefix tier", () => {
		const hits = [
			hit({ id: "long", score: 5, basename: "Design Handbook 2026 Edition" }),
			hit({ id: "short", score: 1, basename: "Design Handbook" }),
		];
		const ranked = rankResults(hits, "design h", "relevance");
		expect(ranked[0]?.id).toBe("short");
	});

	it("modified mode sorts purely by mtime", () => {
		const hits = [
			hit({ id: "exact", score: 9, basename: "x", mtime: 10 }),
			hit({ id: "newer", score: 1, basename: "other", mtime: 99 }),
		];
		const ranked = rankResults(hits, "x", "modified");
		expect(ranked.map((h) => h.id)).toEqual(["newer", "exact"]);
	});
});
