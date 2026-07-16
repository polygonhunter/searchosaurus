import { describe, expect, it } from "vitest";
import { extractExternalLinks, labelForUrl } from "../src/core/extract-links";

describe("extractExternalLinks", () => {
	it("extracts markdown links with text", () => {
		const links = extractExternalLinks("See the [design handbook](https://handbook.example.com/design) here.");
		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe("https://handbook.example.com/design");
		expect(links[0]?.text).toBe("design handbook");
	});

	it("extracts bare URLs and trims trailing punctuation", () => {
		const links = extractExternalLinks("Check https://example.com/tokens.");
		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe("https://example.com/tokens");
	});

	it("extracts autolinks", () => {
		const links = extractExternalLinks("Ref: <https://example.com/spec>");
		expect(links).toHaveLength(1);
		expect(links[0]?.url).toBe("https://example.com/spec");
	});

	it("skips image embeds", () => {
		const links = extractExternalLinks("![logo](https://example.com/logo.png)");
		expect(links).toHaveLength(0);
	});

	it("does not double-count URLs inside markdown links", () => {
		const links = extractExternalLinks("[x](https://example.com/a) and https://example.com/b");
		expect(links.map((l) => l.url)).toEqual(["https://example.com/a", "https://example.com/b"]);
	});

	it("assigns 0-based line numbers", () => {
		const links = extractExternalLinks("first\nsecond https://example.com/x\n\nhttps://example.com/y");
		expect(links[0]?.line).toBe(1);
		expect(links[1]?.line).toBe(3);
	});

	it("returns links sorted by offset", () => {
		const links = extractExternalLinks("https://example.com/bare then [t](https://example.com/md)");
		expect(links[0]?.url).toBe("https://example.com/bare");
	});
});

describe("labelForUrl", () => {
	it("shortens to host + path", () => {
		expect(labelForUrl("https://handbook.example.com/design?ref=1")).toBe(
			"handbook.example.com/design",
		);
		expect(labelForUrl("https://example.com/")).toBe("example.com");
	});

	it("falls back to the raw string on invalid URLs", () => {
		expect(labelForUrl("https://")).toBe("https://");
	});
});
