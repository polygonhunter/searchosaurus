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
		engine.upsert(doc({ id: "People/Ocean Menon.md", basename: "Ocean Menon" }));
		engine.upsert(
			doc({
				id: "log.md",
				basename: "log",
				body: "Talked to Ocean Menon about Ocean Menon's plans. Ocean Menon agreed.",
			}),
		);
		const hits = engine.search("Ocean Menon");
		expect(hits[0]?.id).toBe("People/Ocean Menon.md");
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
				basename: "Ocean Menon",
				aliases: "Oce",
				aliasList: ["Oce"],
			}),
		);
		expect(engine.search("Oce")[0]?.id).toBe("p.md");
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
		engine.upsert(doc({ id: "a.md", basename: "Ocean Menon" }));
		engine.upsert(doc({ id: "b.md", basename: "b", body: "unrelated text" }));
		const json = engine.toJSON();

		const restored = makeEngine();
		restored.load(json);
		expect(restored.size).toBe(2);
		expect(restored.search("ocean")[0]?.id).toBe("a.md");
		// the restored index must stay writable
		restored.upsert(doc({ id: "c.md", basename: "Ocean Cruise" }));
		expect(restored.search("ocean")).toHaveLength(2);
	});

	it("returns [] for empty queries", () => {
		const engine = makeEngine();
		engine.upsert(doc({ id: "a.md", basename: "a" }));
		expect(engine.search("   ")).toEqual([]);
	});
});
