# NoteSearch — Desktop App

A fuzzy file search engine for your notes and code snippets, packaged as a
native desktop app with Electron.

---

## Requirements

- **Node.js** 18 or later
- **npm** 8 or later

---

## Quick Start

```bash
# 1. Install dependencies (Electron + builder)
npm install

# 2. (Optional but recommended) Download fonts for offline use
node download-fonts.js

# 3. Launch the app
npm start
```

On first launch the app reads `config.json` from the project root. If your
`notesDir` doesn't exist yet, a warning will appear in the UI — open
**Settings** to point it at your notes folder.

---

## Configuration

All settings live in `config.json` at the root of the project. You can edit
it by hand or use the in-app Settings panel (`⌘,` / `Ctrl+,`).

```json
{
  "notesDir": "~/notes",
  "extensions": ["md", "txt", "js", "py", "sh"],
  "maxResults": 50,
  "contextLines": 3,
  "maxFileSize": 1048576,
  "reindexInterval": 30000,
  "window": {
    "width": 1100,
    "height": 800,
    "rememberPosition": true
  }
}
```

| Key | Default | Description |
|-----|---------|-------------|
| `notesDir` | `~/notes` | Path to your notes folder. Supports `~`. |
| `extensions` | (long list) | File extensions to index. |
| `maxResults` | `50` | Max files returned per search. |
| `contextLines` | `3` | Lines of code shown above/below each match. |
| `maxFileSize` | `1048576` | Files larger than this (bytes) are skipped. |
| `reindexInterval` | `30000` | Polling interval in ms (fallback re-index). |
| `window.rememberPosition` | `true` | Saves window size between sessions. |

---

## Changing Your Notes Folder

Three ways to change the notes directory:

1. **Settings panel** — press `⌘,` (Mac) or `Ctrl+,` (Windows/Linux), then
   use the Browse button or type a path directly and click **Save & Re-index**.
2. **Menu** — File → Open Notes Folder…
3. **config.json** — edit `notesDir` directly and restart the app.

---

## Search Syntax

| Syntax | Behaviour |
|--------|-----------|
| `docker run` | Fuzzy match both words independently |
| `"docker run"` | Exact phrase — only lines containing `docker run` |
| `"docker run" container` | Exact phrase required + fuzzy boost for `container` |
| `"useState" "useEffect"` | Both phrases must appear on the same line |

Quoted phrases are hard requirements — lines without an exact phrase match are
excluded from results entirely.

---

## Offline Fonts

By default the app loads fonts from Google Fonts CDN. To make it work fully
offline, run the one-time downloader while you have internet access:

```bash
node download-fonts.js
```

This saves WOFF2 files into `fonts/` and writes `fonts/fonts.css` with local
paths. The app detects this automatically — no restart needed. The Settings
panel shows whether local fonts are active.

For version control, add binary font files to `.gitignore`:

```gitignore
fonts/*.woff2
fonts/*.woff
fonts/*.ttf
```

---

## File Structure

```
notesearch-electron/
├── src/
│   ├── main.js        # Electron main process (search engine, IPC, file watcher)
│   ├── preload.js     # Secure context bridge (main ↔ renderer)
│   └── index.html     # UI (renderer process)
├── fonts/             # Created by download-fonts.js
│   ├── fonts.css
│   └── *.woff2
├── config.json        # User configuration
├── download-fonts.js  # One-time font downloader
└── package.json
```

---

## Building a Distributable

```bash
# macOS (.dmg)
npm run build:mac

# Windows (.exe installer)
npm run build:win

# Linux (AppImage)
npm run build:linux
```

Output goes to the `dist/` folder. Requires `electron-builder` (installed via
`npm install`).

---

## How the Search Engine Works

Scoring works in two passes:

1. **Query parsing** — quoted terms become `phrase` tokens (exact match
   required), unquoted terms become `fuzzy` tokens.
2. **Line scoring** — each line is scored against all tokens:
   - A `phrase` token that doesn't match eliminates the line entirely.
   - `exact` substring match scores ~110–120, with a bonus at word boundaries.
   - `fuzzy` character-sequence match scores 1–40 based on consecutive runs.
   - Filename matches are weighted 1.5× over content matches.
3. Nearby duplicates within 5 lines are de-duplicated (highest score kept).
4. Up to 5 snippet matches shown per file, top 50 files overall.

---

## Live Re-indexing

- **`fs.watch`** fires within 500ms of any file change in the notes directory.
- **Polling fallback** re-indexes on the `reindexInterval` schedule regardless
  (default 30 seconds). Useful on Linux where recursive `fs.watch` has
  limited support.
- Files over `maxFileSize` are always skipped.

---

## Tips

- `"function fetchUser"` — zero in on an exact function definition
- `"git stash" apply` — must have the phrase, ranked higher if `apply` is nearby
- Click `.py` or `.sh` in the filter bar to narrow results to one language
- **open** button opens the file in your default editor
- **reveal** button shows the file in Finder / Explorer
- `ESC` clears the search box instantly
- `⌘,` / `Ctrl+,` opens Settings from anywhere
