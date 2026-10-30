import { describe, expect, it } from "vitest";
import { isOcrImage, kindForExtension } from "../src/core/classify";

describe("kindForExtension", () => {
	it("maps markdown to note", () => {
		expect(kindForExtension("md")).toBe("note");
	});

	it("maps image extensions to image, case-insensitively", () => {
		for (const ext of ["png", "jpg", "jpeg", "webp", "gif", "bmp", "PNG", "JPG"]) {
			expect(kindForExtension(ext)).toBe("image");
		}
	});

	it("maps everything else to file", () => {
		for (const ext of ["pdf", "docx", "xlsx", "canvas", "mp3", "zip"]) {
			expect(kindForExtension(ext)).toBe("file");
		}
	});
});

describe("isOcrImage", () => {
	it("accepts formats tesseract can decode, case-insensitively", () => {
		for (const ext of ["png", "jpg", "jpeg", "webp", "bmp", "PNG"]) {
			expect(isOcrImage(ext)).toBe(true);
		}
	});

	it("rejects images tesseract cannot read", () => {
		for (const ext of ["svg", "gif", "avif"]) {
			expect(isOcrImage(ext)).toBe(false);
		}
	});
});
