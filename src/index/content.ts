import { getAllTags, parseFrontMatterAliases, type App, type TFile } from "obsidian";
import { kindForExtension } from "../core/classify";
import { extractExternalLinks, labelForUrl } from "../core/extract-links";
import type { IndexedDoc } from "../core/types";

/** Cap what a single note contributes to the index (pathological files). */
const MAX_BODY_LENGTH = 300_000;
/** Cap link docs per note (paste-dump protection). */
const MAX_LINKS_PER_NOTE = 200;

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
		tagList: [],
	};
}

/**
 * Build the index doc(s) for one vault file. Notes get their metadata-cache
 * fields plus one link doc per external URL; attachments start as
 * basename-only docs (extractedText is filled in later by the OCR/PDF
 * pipeline).
 */
export async function extractDocs(app: App, file: TFile): Promise<IndexedDoc[]> {
	const doc = emptyDoc(file);
	if (doc.kind !== "note") return [doc];

	const cache = app.metadataCache.getFileCache(file);
	const aliases = parseFrontMatterAliases(cache?.frontmatter) ?? [];
	doc.aliasList = aliases;
	doc.aliases = aliases.join(" ");
	doc.headings = (cache?.headings ?? []).map((h) => h.heading).join(" ");
	doc.tagList = (cache ? (getAllTags(cache) ?? []) : []).map((t) => t.replace(/^#/, ""));
	doc.tags = doc.tagList.join(" ");
	const body = (await app.vault.cachedRead(file)).slice(0, MAX_BODY_LENGTH);
	doc.body = body;

	const docs: IndexedDoc[] = [doc];
	for (const link of extractExternalLinks(body).slice(0, MAX_LINKS_PER_NOTE)) {
		docs.push({
			...emptyDoc(file),
			id: `${file.path}::L${link.offset}`,
			kind: "link",
			basename: link.text.length > 0 ? link.text : labelForUrl(link.url),
			url: link.url,
			line: link.line,
		});
	}
	return docs;
}
