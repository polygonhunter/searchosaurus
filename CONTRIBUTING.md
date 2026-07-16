# Contributing to Searchosaurus

Thanks for your interest! Issues and pull requests are welcome.

## Bugs & ideas

Open an [issue](https://github.com/polygonhunter/searchosaurus/issues) — a short description, your Obsidian version, and (for search-ranking issues) an anonymized example of the query and the expected top result help a lot.

## Development setup

```bash
npm install
npm run fetch-ocr-assets   # once, if you want OCR in the dev vault
npm run dev                # watch build into test-vault/ (pjeby/hot-reload)
npm run test               # vitest over src/core
npm run build              # type-check + production bundle
```

Open `test-vault/` in Obsidian to try your changes live (the [hot-reload](https://github.com/pjeby/hot-reload) plugin picks up dev builds automatically).

## Ground rules

- Everything under `src/core/` stays pure (no `obsidian` imports) and unit-tested — search logic changes need a test.
- The UI follows one principle: **radically clean**. New features should live on the keyboard, not add visible chrome. If a change adds a button, badge, or footer, it probably needs rethinking.
- Only public Obsidian APIs — no private internals.
- Keep examples and fixtures fictional (no real names, vaults, or URLs).
