<div align="center">
  <img src="icons/searchosaurus.svg" width="112" alt="Searchosaurus logo">
  <h1>Searchosaurus</h1>
  <p><strong>Spotlight-style search for Obsidian — the note you meant comes first.</strong></p>
  <p>Sister plugin of <a href="https://github.com/polygonhunter/linkosaurus"><strong>Linkosaurus</strong></a> and <a href="https://github.com/polygonhunter/scalosaurus"><strong>Scalosaurus</strong></a>.</p>
</div>

---

Obsidian's built-in search treats the note *about* a person the same as thirty
notes that merely link to them. Searchosaurus doesn't: an exact or prefix
title/alias match is always pinned to the top — deterministically, not just
boosted.

## Highlights

- **Title-first ranking** — search a person, get their note, not their mentions.
- **Type filters** — notes, files, images, links; as quiet icons or typed prefixes: `n ocean`, `f ocean`, `i ocean`, `l ocean`.
- **Offline OCR** *(opt-in)* — text inside images and PDFs becomes searchable. German + English, no cloud.
- **Radically clean** — a search field, results, nothing else. Every power feature lives on the keyboard.

## Setup

Searchosaurus ships without a default hotkey. Bind **“Searchosaurus: Open
search”** under *Settings → Hotkeys* — `Cmd/Ctrl+F` (replacing “Search current
file”) or `Cmd/Ctrl+Shift+F` work well.

## Status

Early development — milestone 1 (index + basic modal) of 6.

### Roadmap

- Spotlight-style UI with live preview panel
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

MIT © Maximilian Rarbach
