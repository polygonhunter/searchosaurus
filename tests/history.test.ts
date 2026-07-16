import { describe, expect, it } from "vitest";
import { pushHistory } from "../src/core/history";

describe("pushHistory", () => {
	it("prepends new queries", () => {
		expect(pushHistory(["b"], "a")).toEqual(["a", "b"]);
	});

	it("dedupes, moving repeats to the front", () => {
		expect(pushHistory(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
	});

	it("ignores empty/whitespace queries", () => {
		expect(pushHistory(["a"], "   ")).toEqual(["a"]);
	});

	it("caps at 50 entries", () => {
		const full = Array.from({ length: 50 }, (_, i) => `q${i}`);
		const next = pushHistory(full, "new");
		expect(next).toHaveLength(50);
		expect(next[0]).toBe("new");
		expect(next).not.toContain("q49");
	});
});
