<p align="center">
  <img src="icons/searchosaurus.svg" alt="Searchosaurus" width="200">
</p>

<h1 align="center">Searchosaurus</h1>

<p align="center"><b>The note you meant. First.</b></p>

Searchosaurus is Spotlight for your vault. Press a hotkey, type a few letters, and the right note is already at the top — not buried under thirty notes that merely *mention* it. It searches notes, files, images and even the links you saved inside your notes, and with OCR turned on, the text inside your screenshots and PDFs becomes searchable too. Entirely offline.

I built Searchosaurus because Obsidian's built-in search kept failing me at the simplest task: I search for a person who has their own note, and instead of that note I get every journal entry that ever linked to them. A search should know that an exact title match *is* the answer. So Searchosaurus ranks deterministically — exact title or alias first, title prefixes second, everything else by relevance — and wraps it in a clean, quiet panel that shows nothing but your results.

Searchosaurus is the third plugin in the -osaurus family, next to [**Linkosaurus**](https://github.com/polygonhunter/linkosaurus) and [**Scalosaurus**](https://github.com/polygonhunter/scalosaurus). If something feels off or you have an idea, [open an issue on GitHub](https://github.com/polygonhunter/searchosaurus/issues); I read everything.

## What it looks like

Say your vault has a note `People/Mira Holt.md` (alias `Miri`) plus a dozen journal entries linking to her:

| You type | Searchosaurus shows first |
|----------|---------------------------|
| `mira holt` | The note **Mira Holt** — not the mentions |
| `miri` | **Mira Holt** (alias match) |
| `mi ho` | **Mira Holt** (word-prefix match) |
| `n design` | Only **notes** with "design" in the title |
| `i whiteboard` | Only **images** — including OCR-found text |
| `l handbook` | Only saved **links**, searched by text and URL |
| `#project mira` | Notes tagged `#project` matching "mira" |
| `"design tokens"` | Only results containing that exact phrase |

## Highlights

- **Title-first ranking** — an exact title or alias match is pinned to the top, always. Deterministic, not just "boosted".
- **Four quiet filters** — notes, files, images, links; click the icons or just type `n `, `f `, `i `, `l ` in front of your query.
- **Offline OCR** *(opt-in)* — text inside images and PDFs becomes findable. German + English models, downloaded once, no cloud ever.
- **Radically clean** — a search field and results. Every power feature lives on the keyboard, invisible until you use it.

## Setup

Searchosaurus ships without a default hotkey. Bind **“Searchosaurus: Open search”** under *Settings → Hotkeys* — `Cmd/Ctrl+F` (replacing “Search current file”) or `Cmd/Ctrl+Shift+F` work well.

## Status

Early development.

### Roadmap

- Spotlight-style panel with live preview
- Quick actions, pins, backlink drill-down, frecency launcher
- Per-note sub-matches (VS Code style)
- Office document text extraction, OCR for scanned PDFs

## Development

```bash
npm install
npm run dev     # watch build into test-vault/ (pjeby/hot-reload)
npm run test    # vitest over src/core
npm run build   # type-check + production bundle
```

## License

MIT © polygonhunter
