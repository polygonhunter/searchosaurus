import type { ResultKind } from "./types";

/** Extensions rendered as images by Obsidian (the OCR candidates). */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "svg", "avif"]);

/**
 * Map a file extension to its result kind. Link docs are never produced
 * here — they are emitted per-URL while extracting note content.
 */
export function kindForExtension(extension: string): Exclude<ResultKind, "link"> {
	const ext = extension.toLowerCase();
	if (ext === "md") return "note";
	if (IMAGE_EXTENSIONS.has(ext)) return "image";
	return "file";
}
