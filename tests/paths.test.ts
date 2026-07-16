import { describe, expect, it } from "vitest";
import { isPathExcluded } from "../src/core/paths";

describe("isPathExcluded", () => {
	it("matches files inside the folder", () => {
		expect(isPathExcluded("templates/daily.md", ["templates"])).toBe(true);
		expect(isPathExcluded("templates/sub/x.md", ["templates"])).toBe(true);
	});

	it("respects folder boundaries", () => {
		expect(isPathExcluded("templates2.md", ["templates"])).toBe(false);
		expect(isPathExcluded("templates-old/x.md", ["templates"])).toBe(false);
	});

	it("tolerates trailing slashes from hand-typed entries", () => {
		expect(isPathExcluded("archive/2020.md", ["archive/"])).toBe(true);
	});

	it("matches the folder path itself", () => {
		expect(isPathExcluded("archive", ["archive"])).toBe(true);
	});

	it("ignores empty entries", () => {
		expect(isPathExcluded("anything.md", ["", "/"])).toBe(false);
	});

	it("handles nested folder exclusions", () => {
		expect(isPathExcluded("projects/archive/x.md", ["projects/archive"])).toBe(true);
		expect(isPathExcluded("projects/active/x.md", ["projects/archive"])).toBe(false);
	});
});
