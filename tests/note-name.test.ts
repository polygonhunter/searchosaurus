import { describe, expect, it } from "vitest";
import { sanitizeNoteName } from "../src/core/note-name";

describe("sanitizeNoteName", () => {
	it("keeps ordinary titles", () => {
		expect(sanitizeNoteName("Mira Holt")).toBe("Mira Holt");
		expect(sanitizeNoteName("Gespräch über Straßen")).toBe("Gespräch über Straßen");
	});

	it("removes characters that break files or links", () => {
		expect(sanitizeNoteName('a/b\\c:d*e?f"g<h>i|j#k^l[m]n')).toBe("a b c d e f g h i j k l m n");
	});

	it("collapses whitespace and strips leading dots", () => {
		expect(sanitizeNoteName("  ..hidden   name ")).toBe("hidden name");
	});

	it("returns empty when nothing is left", () => {
		expect(sanitizeNoteName(" /// ")).toBe("");
	});
});
