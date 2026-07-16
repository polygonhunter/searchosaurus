import { setIcon, setTooltip } from "obsidian";
import type { SortMode } from "../core/rank";
import type { ResultKind } from "../core/types";
import { iconForKind } from "./icons";

export interface FilterState {
	kind: ResultKind | null;
	sort: SortMode;
}

const KINDS: ReadonlyArray<{ kind: ResultKind; label: string }> = [
	{ kind: "note", label: "Notes" },
	{ kind: "file", label: "Files" },
	{ kind: "image", label: "Images" },
	{ kind: "link", label: "Links" },
];

/**
 * The quiet filter row under the input: four kind icons and a date-sort
 * toggle. Clicking an active kind deactivates it. A typed prefix operator
 * (`n `, `i `, …) drives the same state — `reflectKind` mirrors it here
 * without re-triggering a search.
 */
export class FilterRow {
	private readonly buttons = new Map<ResultKind, HTMLElement>();
	private sortButton: HTMLElement;
	/** Sliding indicator behind the active kind icon (segmented-control). */
	private readonly pill: HTMLElement;
	/** Kind forced by a typed operator: icons mirror it but stay passive. */
	private operatorKind: ResultKind | null = null;

	constructor(
		private readonly containerEl: HTMLElement,
		private readonly state: FilterState,
		private readonly onChange: () => void,
	) {
		containerEl.addClass("searchosaurus-filter-row");

		const kindsEl = containerEl.createDiv({ cls: "searchosaurus-filter-kinds" });
		this.pill = kindsEl.createDiv({ cls: "searchosaurus-filter-pill" });
		for (const { kind, label } of KINDS) {
			const button = kindsEl.createEl("button", { cls: "searchosaurus-filter-button" });
			setIcon(button, iconForKind(kind));
			setTooltip(button, label);
			button.addEventListener("click", () => {
				this.state.kind = this.state.kind === kind ? null : kind;
				this.render();
				this.onChange();
			});
			this.buttons.set(kind, button);
		}

		this.sortButton = containerEl.createEl("button", {
			cls: "searchosaurus-filter-button searchosaurus-sort-button",
		});
		setIcon(this.sortButton, "clock");
		setTooltip(this.sortButton, "Sort by modified date");
		this.sortButton.addEventListener("click", () => {
			this.state.sort = this.state.sort === "relevance" ? "modified" : "relevance";
			this.render();
			this.onChange();
		});

		this.render();
	}

	/** Mirror a typed prefix operator in the icon row (or clear with null). */
	reflectKind(kind: ResultKind | null): void {
		if (this.operatorKind === kind) return;
		this.operatorKind = kind;
		this.render();
	}

	private render(): void {
		const active = this.operatorKind ?? this.state.kind;
		for (const [kind, button] of this.buttons) {
			button.toggleClass("is-active", kind === active);
		}
		this.sortButton.toggleClass("is-active", this.state.sort === "modified");
		this.sortButton.setAttribute(
			"aria-pressed",
			this.state.sort === "modified" ? "true" : "false",
		);
		this.movePill(active !== null ? (this.buttons.get(active) ?? null) : null);
	}

	/** Slide the pill under the active button (after layout has settled). */
	private movePill(target: HTMLElement | null): void {
		requestAnimationFrame(() => {
			if (!target) {
				this.pill.style.opacity = "0";
				return;
			}
			this.pill.style.opacity = "1";
			this.pill.style.transform = `translateX(${target.offsetLeft}px)`;
			this.pill.style.width = `${target.offsetWidth}px`;
		});
	}
}
