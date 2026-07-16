import type { ResultKind } from "../core/types";

/** Lucide icon per result kind (rendered via Obsidian's setIcon). */
export function iconForKind(kind: ResultKind): string {
	switch (kind) {
		case "note":
			return "file-text";
		case "file":
			return "paperclip";
		case "image":
			return "image";
		case "link":
			return "link";
	}
}
