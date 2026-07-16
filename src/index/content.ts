import { getAllTags, parseFrontMatterAliases, type App, type TFile } from "obsidian";
import { kindForExtension } from "../core/classify";
import type { IndexedDoc } from "../core/types";

/** Cap what a single note contributes to the index (pathological files). */
const MAX_BODY_LENGTH = 300_000;

function emptyDoc(file: TFile): IndexedDoc {
	return {
		id: file.path,
		kind: kindForExtension(file.extension),
		basename: file.basename,
		aliases: "",
		headings: "",
		tags: "",
		body: "",
		extractedText: "",
		url: "",
		path: file.path,
		mtime: file.stat.mtime,
		aliasList: [],
	};
}

/**
 * Build the index doc(s) for one vault file. Notes get their metadata-cache
 * fields; attachments start as basename-only docs (extractedText is filled
 * in later by the OCR/PDF pipeline). Link docs join in the links milestone.
 */
export async function extractDocs(app: App, file: TFile): Promise<IndexedDoc[]> {
	const doc = emptyDoc(file);
	if (doc.kind !== "note") return [doc];

	const cache = app.metadataCache.getFileCache(file);
	const aliases = parseFrontMatterAliases(cache?.frontmatter) ?? [];
	doc.aliasList = aliases;
	doc.aliases = aliases.join(" ");
	doc.headings = (cache?.headings ?? []).map((h) => h.heading).join(" ");
	doc.tags = (cache ? (getAllTags(cache) ?? []) : []).map((t) => t.replace(/^#/, "")).join(" ");
	doc.body = (await app.vault.cachedRead(file)).slice(0, MAX_BODY_LENGTH);
	return [doc];
}
