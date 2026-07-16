import { Component, MarkdownRenderer, setIcon, type App, type TFile } from "obsidian";
import type { SearchHit } from "../core/types";
import { iconForKind } from "./icons";

/** Preview body cap — enough context, never the whole 300 KB note. */
const MAX_PREVIEW_CHARS = 1800;
/** Highlight at most this many matches (degenerate query protection). */
const MAX_MARKS = 40;

/**
 * The right-hand live preview: rendered note excerpt around the match,
 * image thumbnail, file facts, or link context. Follows the selection; all
 * async work is token-guarded so a fast arrow-key run never shows a stale
 * preview.
 */
export class PreviewPane {
	private component: Component | null = null;
	private token = 0;

	constructor(
		private readonly app: App,
		private readonly el: HTMLElement,
	) {
		el.addClass("searchosaurus-preview", "is-empty");
	}

	destroy(): void {
		this.token += 1;
		this.component?.unload();
		this.component = null;
	}

	clear(): void {
		this.destroy();
		this.el.empty();
		this.el.addClass("is-empty");
	}

	async show(hit: SearchHit, queryWords: readonly string[]): Promise<void> {
		const token = ++this.token;
		const file = this.app.vault.getFileByPath(hit.path);
		if (!file) {
			this.clear();
			return;
		}

		// Build into a detached element; swap in only if still current.
		const next = createDiv();
		switch (hit.kind) {
			case "note":
				await this.buildNote(next, file, queryWords);
				break;
			case "image":
				this.buildImage(next, file);
				break;
			case "link":
				await this.buildLink(next, hit, file);
				break;
			case "file":
				this.buildFile(next, file);
				break;
		}
		if (token !== this.token) return;

		this.el.empty();
		this.el.removeClass("is-empty");
		while (next.firstChild) this.el.appendChild(next.firstChild);
		this.el.createDiv({ cls: "searchosaurus-preview-path", text: hit.path });
	}

	private async buildNote(el: HTMLElement, file: TFile, queryWords: readonly string[]): Promise<void> {
		const body = await this.app.vault.cachedRead(file);
		const excerpt = excerptAround(stripFrontmatter(body), queryWords);
		const contentEl = el.createDiv({ cls: "searchosaurus-preview-note markdown-rendered" });
		this.component?.unload();
		this.component = new Component();
		this.component.load();
		await MarkdownRenderer.render(this.app, excerpt, contentEl, file.path, this.component);
		markMatches(contentEl, queryWords);
	}

	private buildImage(el: HTMLElement, file: TFile): void {
		const wrap = el.createDiv({ cls: "searchosaurus-preview-image" });
		wrap.createEl("img", { attr: { src: this.app.vault.getResourcePath(file), alt: file.name } });
	}

	private buildFile(el: HTMLElement, file: TFile): void {
		const wrap = el.createDiv({ cls: "searchosaurus-preview-file" });
		const iconEl = wrap.createDiv({ cls: "searchosaurus-preview-file-icon" });
		setIcon(iconEl, iconForKind("file"));
		wrap.createDiv({ cls: "searchosaurus-preview-file-name", text: file.name });
		wrap.createDiv({
			cls: "searchosaurus-preview-file-meta",
			text: `${formatSize(file.stat.size)} · ${new Date(file.stat.mtime).toLocaleDateString()}`,
		});
	}

	private async buildLink(el: HTMLElement, hit: SearchHit, file: TFile): Promise<void> {
		const wrap = el.createDiv({ cls: "searchosaurus-preview-link" });
		const iconEl = wrap.createDiv({ cls: "searchosaurus-preview-file-icon" });
		setIcon(iconEl, iconForKind("link"));
		wrap.createDiv({ cls: "searchosaurus-preview-file-name", text: hit.basename });
		wrap.createDiv({ cls: "searchosaurus-preview-link-url", text: hit.url ?? "" });
		// The sentence the link lives in, for context.
		if (hit.line !== undefined) {
			const body = await this.app.vault.cachedRead(file);
			const lineText = (body.split("\n")[hit.line] ?? "").trim();
			if (lineText.length > 0) {
				wrap.createDiv({ cls: "searchosaurus-preview-link-context", text: lineText });
			}
		}
	}
}

function stripFrontmatter(body: string): string {
	return body.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/** Window the raw markdown around the first query match, on line borders. */
function excerptAround(body: string, queryWords: readonly string[]): string {
	if (body.length <= MAX_PREVIEW_CHARS) return body;
	const lower = body.toLowerCase();
	let first = -1;
	for (const word of queryWords) {
		const index = lower.indexOf(word.toLowerCase());
		if (index !== -1 && (first === -1 || index < first)) first = index;
	}
	if (first === -1) return body.slice(0, MAX_PREVIEW_CHARS);
	const start = body.lastIndexOf("\n", Math.max(0, first - MAX_PREVIEW_CHARS / 3));
	const end = body.indexOf("\n", first + MAX_PREVIEW_CHARS / 2);
	return body.slice(start === -1 ? 0 : start + 1, end === -1 ? body.length : end);
}

/** Wrap query-word occurrences in <mark> across the rendered DOM. */
function markMatches(root: HTMLElement, queryWords: readonly string[]): void {
	const words = queryWords.map((w) => w.toLowerCase()).filter((w) => w.length > 1);
	if (words.length === 0) return;
	const walker = root.doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	let node = walker.nextNode();
	while (node) {
		textNodes.push(node as Text);
		node = walker.nextNode();
	}
	let marks = 0;
	for (const textNode of textNodes) {
		if (marks >= MAX_MARKS) break;
		let current = textNode;
		let guard = 0;
		while (marks < MAX_MARKS && guard++ < 20) {
			const lower = current.data.toLowerCase();
			let earliest = -1;
			let length = 0;
			for (const word of words) {
				const index = lower.indexOf(word);
				if (index !== -1 && (earliest === -1 || index < earliest)) {
					earliest = index;
					length = word.length;
				}
			}
			if (earliest === -1) break;
			const matchNode = current.splitText(earliest);
			const rest = matchNode.splitText(length);
			const mark = root.doc.createElement("mark");
			mark.className = "searchosaurus-mark";
			matchNode.replaceWith(mark);
			mark.appendChild(matchNode);
			marks += 1;
			current = rest;
		}
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
