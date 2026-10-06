import { Component, MarkdownRenderer, setIcon, type App, type TFile } from "obsidian";
import {
	excerptAround,
	findAllMatches,
	foldWithMap,
	prepareNeedles,
	stripFrontmatter,
} from "../core/match";
import type { SearchHit } from "../core/types";
import { iconForKind } from "./icons";

/** Preview body cap — enough context, never the whole 300 KB note. */
const MAX_PREVIEW_CHARS = 1800;
/** Recognized-text excerpt under an image/PDF preview. */
const MAX_EXTRACTED_PREVIEW_CHARS = 600;
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
	/** After destroy(): late show() calls must not touch the DOM. */
	private closed = false;

	constructor(
		private readonly app: App,
		private readonly el: HTMLElement,
		/** Layout hook: lets the modal give the list full width when empty. */
		private readonly onEmptyChange?: (empty: boolean) => void,
		/** OCR/PDF text of an attachment, shown under thumbnail/file facts. */
		private readonly extractedText?: (file: TFile) => string | null,
	) {
		el.addClass("searchosaurus-preview", "is-empty");
		onEmptyChange?.(true);
	}

	/** Final teardown (modal closed). */
	destroy(): void {
		this.closed = true;
		this.reset();
	}

	/** Invalidate in-flight renders and unload the current markdown. */
	private reset(): void {
		this.token += 1;
		this.component?.unload();
		this.component = null;
	}

	clear(): void {
		this.reset();
		this.el.empty();
		this.el.addClass("is-empty");
		this.onEmptyChange?.(true);
	}

	async show(hit: SearchHit, queryWords: readonly string[]): Promise<void> {
		if (this.closed) return;
		const token = ++this.token;
		const file = this.app.vault.getFileByPath(hit.path);
		if (!file) {
			this.clear();
			return;
		}

		// Build into a detached element; swap in only if still current.
		const next = createDiv();
		// Markdown gets its own component; it replaces the live one only on
		// swap-in, so a stale render never unloads what is on screen.
		let component: Component | null = null;
		switch (hit.kind) {
			case "note":
				component = await this.buildNote(next, file, queryWords, token);
				break;
			case "image":
				this.buildImage(next, file);
				this.buildExtracted(next, file, queryWords);
				break;
			case "link":
				await this.buildLink(next, hit, file);
				break;
			case "file":
				this.buildFile(next, file);
				this.buildExtracted(next, file, queryWords);
				break;
		}
		if (token !== this.token || this.closed) {
			component?.unload();
			return;
		}

		this.component?.unload();
		this.component = component;
		this.el.empty();
		this.el.removeClass("is-empty");
		this.onEmptyChange?.(false);
		while (next.firstChild) this.el.appendChild(next.firstChild);
		this.el.createDiv({ cls: "searchosaurus-preview-path", text: hit.path });
	}

	private async buildNote(
		el: HTMLElement,
		file: TFile,
		queryWords: readonly string[],
		token: number,
	): Promise<Component | null> {
		const body = await this.app.vault.cachedRead(file);
		// Superseded while reading — skip the (expensive) markdown render.
		if (token !== this.token || this.closed) return null;
		const excerpt = excerptAround(stripFrontmatter(body), queryWords, MAX_PREVIEW_CHARS);
		const contentEl = el.createDiv({ cls: "searchosaurus-preview-note markdown-rendered" });
		const component = new Component();
		component.load();
		await MarkdownRenderer.render(this.app, excerpt, contentEl, file.path, component);
		markMatches(contentEl, queryWords);
		return component;
	}

	private buildImage(el: HTMLElement, file: TFile): void {
		const wrap = el.createDiv({ cls: "searchosaurus-preview-image" });
		wrap.createEl("img", { attr: { src: this.app.vault.getResourcePath(file), alt: file.name } });
	}

	/** Recognized text around the match — explains why the file matched. */
	private buildExtracted(el: HTMLElement, file: TFile, queryWords: readonly string[]): void {
		const text = this.extractedText?.(file);
		if (!text) return;
		const excerpt = excerptAround(text, queryWords, MAX_EXTRACTED_PREVIEW_CHARS);
		const textEl = el.createDiv({ cls: "searchosaurus-preview-extracted" });
		textEl.setText(excerpt.length < text.length ? `${excerpt}…` : excerpt);
		markMatches(textEl, queryWords);
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

/** Wrap query-word occurrences in <mark> across the rendered DOM. */
function markMatches(root: HTMLElement, queryWords: readonly string[]): void {
	const needles = prepareNeedles(queryWords);
	if (needles.length === 0) return;
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
		const ranges = findAllMatches(foldWithMap(textNode.data), needles, MAX_MARKS - marks);
		// Split from the end so earlier offsets stay valid.
		for (let i = Math.min(ranges.length, MAX_MARKS - marks) - 1; i >= 0; i--) {
			const [start, end] = ranges[i] as [number, number];
			const matchNode = textNode.splitText(start);
			matchNode.splitText(end - start);
			const mark = createEl("mark", { cls: "searchosaurus-mark" });
			matchNode.replaceWith(mark);
			mark.appendChild(matchNode);
			marks += 1;
		}
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
