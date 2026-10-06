import { describe, expect, it } from "vitest";
import { SearchEngine } from "../src/core/engine";
import { DEFAULT_WEIGHTS, type IndexedDoc } from "../src/core/types";

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

function makeEngine(): SearchEngine {
	return new SearchEngine(DEFAULT_WEIGHTS);
}

describe("SearchEngine", () => {
	it("finds docs by body content", () => {
		const engine = makeEngine();
		engine.upsert(doc({ id: "a.md", basename: "a", body: "the quick brown fox" }));
		const hits = engine.search("quick fox");
		expect(hits.map((h) => h.id)).toEqual(["a.md"]);
	});

	it("boosts basename matches above body mentions", () => {
		const engine = makeEngine();
		engine.upsert(doc({ id: "People/Mira Holt.md", basename: "Mira Holt" }));
		engine.upsert(
			doc({
				id: "log.md",
				basename: "log",
				body: "Talked to Mira Holt about Mira Holt's plans. Mira Holt agreed.",
			}),
		);
		const hits = engine.search("Mira Holt");
		expect(hits[0]?.id).toBe("People/Mira Holt.md");
	});

	it("matches umlaut queries against folded titles and vice versa", () => {
		const engine = makeEngine();
		engine.upsert(doc({ id: "m.md", basename: "Max Müller" }));
		expect(engine.search("müller")[0]?.id).toBe("m.md");
		expect(engine.search("muller")[0]?.id).toBe("m.md");
	});

	it("matches aliases", () => {
		const engine = makeEngine();
		engine.upsert(
			doc({
				id: "p.md",
				basename: "Mira Holt",
				aliases: "Miri",
				aliasList: ["Miri"],
			}),
		);
		expect(engine.search("Miri")[0]?.id).toBe("p.md");
	});

	it("upserts without duplicating and removes cleanly", () => {
		const engine = makeEngine();
		engine.upsert(doc({ id: "a.md", basename: "alpha" }));
		engine.upsert(doc({ id: "a.md", basename: "alpha renamed" }));
		expect(engine.size).toBe(1);
		expect(engine.search("renamed")).toHaveLength(1);
		expect(engine.search("alpha")).toHaveLength(1);

		engine.remove("a.md");
		expect(engine.search("alpha")).toHaveLength(0);
		engine.remove("a.md"); // no-op, must not throw
	});

	it("returns stored fields on hits", () => {
		const engine = makeEngine();
		engine.upsert(
			doc({ id: "x.md", basename: "X", path: "sub/x.md", mtime: 42, aliasList: ["y"] }),
		);
		const hit = engine.search("x")[0];
		expect(hit?.path).toBe("sub/x.md");
		expect(hit?.mtime).toBe(42);
		expect(hit?.kind).toBe("note");
		expect(hit?.aliasList).toEqual(["y"]);
	});

	it("round-trips through toJSON/load", () => {
		const engine = makeEngine();
		engine.upsert(doc({ id: "a.md", basename: "Mira Holt" }));
		engine.upsert(doc({ id: "b.md", basename: "b", body: "unrelated text" }));
		const json = engine.toJSON();

		const restored = makeEngine();
		restored.load(json);
		expect(restored.size).toBe(2);
		expect(restored.search("mira")[0]?.id).toBe("a.md");
		// the restored index must stay writable
		restored.upsert(doc({ id: "c.md", basename: "Mira Bay" }));
		expect(restored.search("mira")).toHaveLength(2);
	});

	it("round-trips through toJSON/loadAsync", async () => {
		const engine = makeEngine();
		engine.upsert(doc({ id: "a.md", basename: "Mira Holt" }));
		const restored = makeEngine();
		await restored.loadAsync(engine.toJSON());
		expect(restored.search("mira")[0]?.id).toBe("a.md");
		restored.upsert(doc({ id: "c.md", basename: "Mira Bay" }));
		expect(restored.search("mira")).toHaveLength(2);
	});

	it("keeps short words strict but tolerates typos in longer ones", () => {
		const engine = makeEngine();
		engine.upsert(doc({ id: "text.md", basename: "text" }));
		engine.upsert(doc({ id: "kalender.md", basename: "Kalender" }));
		// 4 letters: no fuzzy — "test" must not match "text"
		expect(engine.search("test")).toHaveLength(0);
		// 8 letters: one typo is fine
		expect(engine.search("kalnder")[0]?.id).toBe("kalender.md");
	});

	it("caps fuzzy edits at two even for long words", () => {
		const engine = makeEngine();
		engine.upsert(doc({ id: "a.md", basename: "Projektplanung" }));
		// 14 letters × 0.2 would allow 3 edits; the cap keeps it at 2
		expect(engine.search("prujektplenong")).toHaveLength(0);
		expect(engine.search("projektplenong")[0]?.id).toBe("a.md");
	});

	it("returns [] for empty queries", () => {
		const engine = makeEngine();
		engine.upsert(doc({ id: "a.md", basename: "a" }));
		expect(engine.search("   ")).toEqual([]);
	});
});
