<p align="center">
  <img src="icons/searchosaurus.svg" alt="Searchosaurus" width="200">
</p>

<h1 align="center">Searchosaurus</h1>

<p align="center"><b>The note you meant. First.</b></p>

Searchosaurus is Spotlight for your vault. Press a hotkey, type a few letters, and the right note is already at the top — not buried under thirty notes that merely *mention* it. It searches notes, files, images and even the links you saved inside your notes, previews everything live, and with OCR turned on, the text inside your screenshots and PDFs becomes searchable too. Entirely offline.

I built Searchosaurus because Obsidian's built-in search kept failing me at the simplest task: I search for a person who has their own note, and instead of that note I get every journal entry that ever linked to them. A search should know that an exact title match *is* the answer. So Searchosaurus ranks deterministically — exact title or alias first, title prefixes second, everything else by relevance — and wraps it in a clean, quiet glass panel that shows nothing but your results.

Searchosaurus is the third plugin in the -osaurus family, next to [**Linkosaurus**](https://github.com/polygonhunter/linkosaurus) and [**Scalosaurus**](https://github.com/polygonhunter/scalosaurus). If something feels off or you have an idea, [open an issue on GitHub](https://github.com/polygonhunter/searchosaurus/issues); I read everything.

## What it looks like

Say your vault has a note `People/Mira Holt.md` (alias `Miri`) plus a dozen journal entries linking to her:

| You type | Searchosaurus shows first |
|----------|---------------------------|
| `mira holt` | The note **Mira Holt** — not the mentions |
| `miri` | **Mira Holt** (alias match) |
| `mi ho` | **Mira Holt** (word-prefix match) |
| `n design` | Only **notes** with "design" in the title |
| `i rechnung` | Only **images** — including OCR-found text |
| `l handbook` | Only saved **links**, searched by text and URL |
| `#project mira` | Notes tagged `#project` matching "mira" |
| `"design tokens"` | Only results containing that exact phrase |
| `p:People/ mira mod:woche` | Scoped to a folder, modified this week |

## Highlights

- **Title-first ranking** — an exact title or alias match is pinned to the top, always. Deterministic, not just "boosted".
- **Live preview** — the selected result renders beside the list: note excerpt with highlights, image thumbnail, PDF facts, link context. Find the right note without opening anything.
- **Four quiet filters** — notes, files, images, links; click the icons or type `n `, `f `, `i `, `l ` in front of your query.
- **Offline OCR** *(opt-in)* — text inside images and PDFs becomes findable. German + English models, downloaded once, no cloud ever.
- **A launcher when empty** — open it without typing and your pinned and frequently used notes are already there.
- **Radically clean** — a search field and results. Everything else lives on the keyboard, invisible until you use it.

## The keyboard layer

| Key | Does |
|-----|------|
| `↵` | Open (scrolled to the match) |
| `⌘↵` / `⌘⌥↵` | Open in new tab / split |
| `⇥` | Insert a link to the result at your cursor |
| `⌘C` | Copy a link to the result |
| `⌘P` | Pin / unpin (pinned notes lead the launcher) |
| `⌘1–9` | Open a result directly — numbers appear while ⌘ is held |
| `→` / `←` | Drill into the notes linking here / back |
| `↑` | Recall recent searches (empty input) |

Unresolved `[[wikilinks]]` show up as quiet ghost rows — choosing one creates the note. A search with no matches offers to create the note instead of showing nothing.

## Setup

Searchosaurus ships without a default hotkey. Bind **“Searchosaurus: Open search”** under *Settings → Hotkeys* — `Cmd/Ctrl+F` (replacing “Search current file”) or `Cmd/Ctrl+Shift+F` work well.

To search text inside images, enable **OCR** in the plugin settings: the recognition models (~8 MB) download once from this repository's releases, then everything runs locally. Extracted text is cached and synced, so other devices never re-run the work.

### On your phone

Searchosaurus works on mobile too (OCR results synced from desktop included). To make it *the* search there:

1. *Settings → Mobile → Configure Quick Action* → **Searchosaurus: Open search** — the swipe-down gesture now opens Searchosaurus instead of the built-in search.
2. Optionally disable the **Search** core plugin — the default search button disappears entirely.
3. The Searchosaurus icon in the side menu (ribbon) works out of the box, and you can add the command to the mobile toolbar as well.

## Privacy & network use

Searchosaurus works entirely offline. It makes exactly **one** kind of network request, and only if you opt in: when you enable OCR in the settings, it downloads the recognition models once (a ~4 MB zip from [this repository's releases](https://github.com/polygonhunter/searchosaurus/releases/tag/ocr-assets-v1), verified against a pinned SHA-256 checksum). After that, everything — indexing, search, OCR — runs locally. No telemetry, no analytics, and nothing from your vault ever leaves your device.

For transparency about what the automated scans see: the bundled tesseract.js library contains `fetch`/base64 code paths used to load its own worker and WASM core **from your local plugin folder**, and the clipboard is only touched when you press `⌘C` to copy a link to a result.

## Roadmap

- Per-note sub-matches (VS Code style)
- Related notes
- Office document text extraction (docx, xlsx)
- OCR for scanned PDFs

## Development

```bash
npm install
npm run fetch-ocr-assets   # once, for OCR in the dev vault
npm run dev                # watch build into test-vault/ (pjeby/hot-reload)
npm run test               # vitest over src/core
npm run build              # type-check + production bundle
```

## License

MIT © polygonhunter
