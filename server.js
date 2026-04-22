#!/usr/bin/env node
/**
 * NoteSearch - Zero-dependency fuzzy file search engine
 * Usage: node server.js [--dir /path/to/notes] [--port 3131] [--ext md,txt,js,py,sh]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Config ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const getArg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const CONFIG = {
  dir: path.resolve(getArg('--dir', process.env.NOTES_DIR || process.cwd())),
  port: parseInt(getArg('--port', '3131')),
  exts: (getArg('--ext', 'md,txt,js,ts,py,sh,bash,json,yaml,yml,env,conf,cfg,ini,toml,rb,go,rs,c,cpp,h,java,cs,php,html,css,sql,r,lua,vim,zsh,fish')).split(',').map(e => e.trim().toLowerCase()),
  maxFileSize: 1024 * 1024, // 1MB
  contextLines: 3,
  maxResults: 50,
};

// ─── Font Detection ───────────────────────────────────────────────────────────

const FONTS_DIR = path.join(__dirname, 'fonts');
const LOCAL_FONTS_CSS = path.join(FONTS_DIR, 'fonts.css');

/**
 * Returns true if local fonts have been downloaded (fonts/fonts.css exists).
 * Checked once at startup and again on each request to / so a mid-session
 * `node download-fonts.js` run is picked up without a server restart.
 */
function localFontsAvailable() {
  return fs.existsSync(LOCAL_FONTS_CSS);
}

/**
 * Build the <link> / <style> tag to inject into the HTML.
 * If local fonts exist → inline the rewritten CSS as a <style> block.
 * If not            → fall back to Google Fonts CDN with a console hint.
 */
function buildFontHtmlTag() {
  if (localFontsAvailable()) {
    const css = fs.readFileSync(LOCAL_FONTS_CSS, 'utf8');
    return `<style>\n${css}\n</style>`;
  }
  // Online fallback
  return [
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,700;1,400&family=Syne:wght@400;700;800&display=swap" rel="stylesheet">',
  ].join('\n');
}

console.log(`\n🔍 NoteSearch`);
console.log(`   Watching: ${CONFIG.dir}`);
console.log(`   Extensions: ${CONFIG.exts.join(', ')}`);
console.log(`   Fonts: ${localFontsAvailable() ? 'local (offline ready)' : 'Google Fonts CDN — run node download-fonts.js to go offline'}`);
console.log(`   http://localhost:${CONFIG.port}\n`);

// ─── File Indexer ─────────────────────────────────────────────────────────────

let INDEX = []; // Array of { filePath, relPath, fileName, ext, content, lines, mtime }
let lastIndexed = 0;

function walkDir(dir, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (['node_modules', '__pycache__', '.git', 'dist', 'build', '.next', 'venv'].includes(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (CONFIG.exts.includes(ext) || CONFIG.exts.includes(entry.name.toLowerCase())) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

function buildIndex() {
  const files = walkDir(CONFIG.dir);
  const newIndex = [];

  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > CONFIG.maxFileSize) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      const relPath = path.relative(CONFIG.dir, filePath);
      const ext = path.extname(filePath).slice(1).toLowerCase();

      newIndex.push({
        filePath,
        relPath,
        fileName: path.basename(filePath),
        dir: path.dirname(relPath),
        ext,
        content,
        contentLower: content.toLowerCase(),
        lines,
        mtime: stat.mtimeMs,
        size: stat.size,
      });
    } catch { /* skip unreadable */ }
  }

  INDEX = newIndex;
  lastIndexed = Date.now();
  console.log(`   Indexed ${INDEX.length} files`);
  return INDEX.length;
}

// Build index on start, then re-index periodically
buildIndex();
setInterval(buildIndex, 30000); // refresh every 30s

// Watch for changes
try {
  fs.watch(CONFIG.dir, { recursive: true }, (event, filename) => {
    if (filename && !filename.startsWith('.')) {
      clearTimeout(reindexTimer);
      reindexTimer = setTimeout(buildIndex, 500);
    }
  });
} catch { /* fs.watch recursive may not work on all platforms */ }
let reindexTimer;

// ─── Query Parser ─────────────────────────────────────────────────────────────

/**
 * Parse a raw query string into typed tokens.
 * `"docker run" container` → [
 *   { type: 'phrase', value: 'docker run' },
 *   { type: 'fuzzy',  value: 'container'  },
 * ]
 */
function parseQuery(raw) {
  const tokens = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[1] !== undefined) {
      // Quoted phrase → must match exactly as a substring
      tokens.push({ type: 'phrase', value: m[1] });
    } else {
      tokens.push({ type: 'fuzzy', value: m[2] });
    }
  }
  return tokens;
}

// ─── Fuzzy Search Engine ──────────────────────────────────────────────────────

/**
 * Score a single token (phrase or fuzzy) against a text string.
 * Returns { score, type, index? } or null if no match.
 */
function scoreToken(token, text) {
  const t = text.toLowerCase();
  const v = token.value.toLowerCase();

  if (token.type === 'phrase') {
    // Must be an exact substring — no fuzzy fallback
    const idx = t.indexOf(v);
    if (idx === -1) return null;
    const bonus = (idx === 0 || /\W/.test(t[idx - 1])) ? 20 : 10;
    return { score: 100 + bonus, type: 'phrase', index: idx };
  }

  // Fuzzy token — exact substring first
  const exactIdx = t.indexOf(v);
  if (exactIdx !== -1) {
    const bonus = (exactIdx === 0 || /\W/.test(t[exactIdx - 1])) ? 20 : 10;
    return { score: 100 + bonus, type: 'exact', index: exactIdx };
  }

  // Character-sequence fuzzy match
  let pi = 0, ti = 0;
  const matchIndices = [];
  while (pi < v.length && ti < t.length) {
    if (v[pi] === t[ti]) { matchIndices.push(ti); pi++; }
    ti++;
  }
  if (pi < v.length) return null;

  let score = 0, consecutiveBonus = 0;
  for (let i = 1; i < matchIndices.length; i++) {
    consecutiveBonus = matchIndices[i] === matchIndices[i - 1] + 1 ? consecutiveBonus + 5 : 0;
    score += consecutiveBonus;
  }
  score += (v.length / t.length) * 30;

  return { score, type: 'fuzzy', indices: matchIndices };
}

/**
 * Score ALL tokens against a line of text.
 * - Any phrase token that fails to match → line is disqualified entirely.
 * - Fuzzy tokens contribute to score but don't disqualify.
 * Returns combined score or null if disqualified.
 */
function scoreLineTokens(tokens, text) {
  let total = 0;
  let bestType = 'fuzzy';

  for (const token of tokens) {
    const result = scoreToken(token, text);
    if (!result) {
      if (token.type === 'phrase') return null; // hard requirement not met
      continue; // fuzzy token just didn't match this line — ok
    }
    total += result.score;
    if (result.type === 'phrase' || result.type === 'exact') bestType = result.type;
  }

  return total > 0 ? { score: total, type: bestType } : null;
}

/**
 * Extract context lines around a match in a file
 */
function getContext(lines, lineIndex, radius = CONFIG.contextLines) {
  const start = Math.max(0, lineIndex - radius);
  const end = Math.min(lines.length - 1, lineIndex + radius);
  return {
    start,
    end,
    matchLine: lineIndex,
    lines: lines.slice(start, end + 1).map((text, i) => ({
      num: start + i + 1,
      text,
      isMatch: start + i === lineIndex,
    })),
  };
}

/**
 * Find best matching lines within a file's content
 */
function searchInFile(file, tokens) {
  const matches = [];

  for (let i = 0; i < file.lines.length; i++) {
    const line = file.lines[i];
    const result = scoreLineTokens(tokens, line);
    if (result && result.score > 0) {
      matches.push({
        lineIndex: i,
        score: result.score,
        type: result.type,
        context: getContext(file.lines, i),
        lineText: line,
      });
    }
  }

  // De-dupe nearby matches (within 5 lines, keep highest score)
  const deduped = [];
  const usedLines = new Set();
  matches.sort((a, b) => b.score - a.score);

  for (const m of matches) {
    let tooClose = false;
    for (const used of usedLines) {
      if (Math.abs(m.lineIndex - used) <= 5) { tooClose = true; break; }
    }
    if (!tooClose) {
      deduped.push(m);
      usedLines.add(m.lineIndex);
    }
    if (deduped.length >= 5) break;
  }

  return deduped;
}

function search(query) {
  if (!query || query.trim().length < 1) return [];
  const tokens = parseQuery(query.trim());
  if (tokens.length === 0) return [];

  // For filename scoring, flatten tokens back to a single string
  const flatQuery = tokens.map(t => t.value).join(' ');
  const results = [];

  for (const file of INDEX) {
    // Score the filename (flat fuzzy — phrases still get exact treatment via scoreToken)
    let nameScore = 0;
    for (const token of tokens) {
      const r = scoreToken(token, file.fileName);
      if (r) nameScore += r.score;
    }

    const lineMatches = searchInFile(file, tokens);
    const bestLineScore = lineMatches.length > 0
      ? Math.max(...lineMatches.map(m => m.score))
      : 0;

    const fileScore = Math.max(nameScore * 1.5, bestLineScore);

    if (fileScore > 0 || lineMatches.length > 0) {
      results.push({
        filePath: file.filePath,
        relPath: file.relPath,
        fileName: file.fileName,
        dir: file.dir,
        ext: file.ext,
        score: fileScore,
        nameMatch: nameScore > 0,
        lineMatches,
        size: file.size,
        mtime: file.mtime,
        tokens, // pass tokens to client for highlighting
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, CONFIG.maxResults);
}

// ─── HTTP Server ───────────────────────────────────────────────────────────────

function buildHTML() {
const FONT_HTML_TAG = buildFontHtmlTag();
return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NoteSearch</title>
${FONT_HTML_TAG}
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #111118;
    --surface2: #1a1a24;
    --border: #2a2a3a;
    --accent: #7c6dfa;
    --accent2: #4fffb0;
    --accent3: #ff6b6b;
    --text: #e8e8f0;
    --muted: #5a5a7a;
    --match-bg: rgba(124, 109, 250, 0.15);
    --match-border: rgba(124, 109, 250, 0.4);
    --exact-bg: rgba(79, 255, 176, 0.1);
    --exact-border: rgba(79, 255, 176, 0.35);
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    min-height: 100vh;
    overflow-x: hidden;
  }

  /* Scanline overlay */
  body::before {
    content: '';
    position: fixed; inset: 0;
    background: repeating-linear-gradient(
      0deg,
      transparent,
      transparent 2px,
      rgba(0,0,0,0.03) 2px,
      rgba(0,0,0,0.03) 4px
    );
    pointer-events: none;
    z-index: 9999;
  }

  /* Grid background */
  body::after {
    content: '';
    position: fixed; inset: 0;
    background-image:
      linear-gradient(rgba(124,109,250,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(124,109,250,0.04) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
    z-index: 0;
  }

  #app {
    position: relative;
    z-index: 1;
    max-width: 1100px;
    margin: 0 auto;
    padding: 40px 24px 80px;
  }

  /* ── Header ── */
  header {
    display: flex;
    align-items: flex-end;
    gap: 16px;
    margin-bottom: 32px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }

  .logo {
    font-family: 'Syne', sans-serif;
    font-weight: 800;
    font-size: 28px;
    letter-spacing: -0.5px;
    background: linear-gradient(135deg, var(--accent), var(--accent2));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    line-height: 1;
  }

  .logo-tag {
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 2px;
    text-transform: uppercase;
    padding-bottom: 2px;
  }

  .header-stats {
    margin-left: auto;
    font-size: 11px;
    color: var(--muted);
    text-align: right;
    line-height: 1.6;
  }

  .header-stats .live {
    color: var(--accent2);
  }

  /* ── Search Bar ── */
  .search-wrap {
    position: relative;
    margin-bottom: 20px;
  }

  .search-wrap::before {
    content: '⌕';
    position: absolute;
    left: 16px;
    top: 50%;
    transform: translateY(-50%);
    font-size: 20px;
    color: var(--accent);
    pointer-events: none;
    z-index: 2;
  }

  #searchInput {
    width: 100%;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px 120px 16px 48px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 16px;
    color: var(--text);
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
    caret-color: var(--accent2);
  }

  #searchInput::placeholder { color: var(--muted); }

  #searchInput:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(124,109,250,0.12), 0 0 30px rgba(124,109,250,0.06);
  }

  .search-meta {
    position: absolute;
    right: 16px;
    top: 50%;
    transform: translateY(-50%);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .key-hint {
    font-size: 10px;
    color: var(--muted);
    background: var(--surface2);
    border: 1px solid var(--border);
    padding: 3px 7px;
    border-radius: 4px;
  }

  #resultCount {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
  }

  /* ── Filter Bar ── */
  .filters {
    display: flex;
    gap: 8px;
    margin-bottom: 24px;
    flex-wrap: wrap;
    align-items: center;
  }

  .filter-label {
    font-size: 11px;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 1px;
    margin-right: 4px;
  }

  .filter-btn {
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--muted);
    padding: 5px 12px;
    border-radius: 20px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .filter-btn:hover { border-color: var(--accent); color: var(--accent); }
  .filter-btn.active {
    background: rgba(124,109,250,0.15);
    border-color: var(--accent);
    color: var(--accent);
  }

  /* ── Loading ── */
  #loading {
    display: none;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    font-size: 13px;
    padding: 12px 0;
  }

  #loading.visible { display: flex; }

  .spinner {
    width: 16px; height: 16px;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  /* ── Empty State ── */
  #emptyState {
    display: none;
    text-align: center;
    padding: 60px 20px;
    color: var(--muted);
  }

  #emptyState.visible { display: block; }

  .empty-icon { font-size: 48px; margin-bottom: 16px; opacity: 0.3; }
  .empty-text { font-size: 14px; }
  .empty-sub { font-size: 12px; margin-top: 8px; opacity: 0.6; }

  /* ── Results ── */
  #results {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .result-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    transition: border-color 0.15s, transform 0.15s;
    animation: fadeSlide 0.2s ease both;
  }

  .result-card:hover {
    border-color: rgba(124,109,250,0.4);
    transform: translateX(2px);
  }

  @keyframes fadeSlide {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .result-card:nth-child(2) { animation-delay: 0.03s; }
  .result-card:nth-child(3) { animation-delay: 0.06s; }
  .result-card:nth-child(4) { animation-delay: 0.09s; }
  .result-card:nth-child(5) { animation-delay: 0.12s; }

  /* File header */
  .file-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: var(--surface2);
    border-bottom: 1px solid var(--border);
    cursor: pointer;
    user-select: none;
  }

  .file-ext {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    flex-shrink: 0;
  }

  /* Extension colors */
  .ext-js, .ext-ts, .ext-jsx, .ext-tsx { background: rgba(247,220,111,0.15); color: #f7dc6f; }
  .ext-py { background: rgba(79,195,247,0.15); color: #4fc3f7; }
  .ext-sh, .ext-bash, .ext-zsh, .ext-fish { background: rgba(102,187,106,0.15); color: #66bb6a; }
  .ext-md, .ext-txt { background: rgba(206,147,216,0.15); color: #ce93d8; }
  .ext-json, .ext-yaml, .ext-yml, .ext-toml { background: rgba(255,183,77,0.15); color: #ffb74d; }
  .ext-html, .ext-css { background: rgba(239,154,154,0.15); color: #ef9a9a; }
  .ext-sql { background: rgba(128,222,234,0.15); color: #80deea; }
  .ext-go, .ext-rs, .ext-c, .ext-cpp { background: rgba(161,196,253,0.15); color: #a1c4fd; }
  .ext-rb, .ext-php, .ext-java { background: rgba(255,138,101,0.15); color: #ff8a65; }
  .ext-default { background: rgba(255,255,255,0.07); color: var(--muted); }

  .file-path {
    flex: 1;
    min-width: 0;
  }

  .file-name {
    font-size: 14px;
    font-weight: 500;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-dir {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .file-badges {
    display: flex;
    gap: 6px;
    align-items: center;
    flex-shrink: 0;
  }

  .badge {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 3px;
    font-weight: 500;
  }

  .badge-name {
    background: rgba(124,109,250,0.15);
    color: var(--accent);
    border: 1px solid rgba(124,109,250,0.3);
  }

  .badge-count {
    background: rgba(255,255,255,0.05);
    color: var(--muted);
    border: 1px solid var(--border);
  }

  .expand-toggle {
    color: var(--muted);
    font-size: 12px;
    transition: transform 0.2s;
    flex-shrink: 0;
  }

  .result-card.expanded .expand-toggle { transform: rotate(180deg); }

  /* Snippets */
  .snippets {
    display: none;
    flex-direction: column;
    gap: 0;
  }

  .result-card.expanded .snippets { display: flex; }

  .snippet {
    border-top: 1px solid var(--border);
    padding: 0;
  }

  .snippet-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px 6px;
    font-size: 11px;
    color: var(--muted);
    background: rgba(0,0,0,0.2);
  }

  .match-type {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 3px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .match-exact { background: rgba(79,255,176,0.12); color: var(--accent2); border: 1px solid rgba(79,255,176,0.25); }
  .match-fuzzy { background: rgba(124,109,250,0.12); color: var(--accent); border: 1px solid rgba(124,109,250,0.25); }

  .code-block {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12.5px;
    line-height: 1.7;
    overflow-x: auto;
    padding: 4px 0 10px;
  }

  .code-line {
    display: flex;
    align-items: flex-start;
    padding: 1px 16px;
    gap: 0;
    transition: background 0.1s;
  }

  .code-line:hover { background: rgba(255,255,255,0.02); }

  .code-line.is-match {
    background: var(--match-bg);
    border-left: 2px solid var(--accent);
    padding-left: 14px;
  }

  .code-line.is-match.exact {
    background: var(--exact-bg);
    border-left-color: var(--accent2);
  }

  .line-num {
    color: var(--muted);
    min-width: 42px;
    text-align: right;
    margin-right: 16px;
    user-select: none;
    font-size: 11px;
    padding-top: 1px;
    flex-shrink: 0;
  }

  .line-content {
    flex: 1;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text);
    word-break: break-all;
    white-space: pre-wrap;
  }

  mark {
    background: rgba(124,109,250,0.35);
    color: var(--accent);
    border-radius: 2px;
    padding: 0 1px;
    font-style: normal;
  }

  mark.exact {
    background: rgba(79,255,176,0.25);
    color: var(--accent2);
  }

  /* Open button */
  .open-file-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin: 10px 16px 14px;
    padding: 5px 12px;
    border: 1px solid var(--border);
    border-radius: 5px;
    background: transparent;
    color: var(--muted);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .open-file-btn:hover {
    border-color: var(--accent2);
    color: var(--accent2);
    background: rgba(79,255,176,0.05);
  }

  /* Search hint */
  .search-hint {
    font-size: 11px;
    color: var(--muted);
    margin: -14px 0 20px 2px;
    line-height: 1.6;
  }

  .search-hint kbd {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 1px 5px;
    color: var(--accent2);
  }

  .search-hint code {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: var(--accent);
    background: rgba(124,109,250,0.08);
    padding: 1px 5px;
    border-radius: 3px;
  }

  /* ── File Modal ── */
  #fileModal {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 10000;
    background: rgba(0,0,0,0.75);
    backdrop-filter: blur(4px);
    align-items: center;
    justify-content: center;
    padding: 32px 24px;
  }

  #fileModal.open { display: flex; }

  .modal-box {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    width: 100%;
    max-width: 900px;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    box-shadow: 0 24px 80px rgba(0,0,0,0.6);
    animation: modalIn 0.15s ease both;
  }

  @keyframes modalIn {
    from { opacity: 0; transform: translateY(12px) scale(0.98); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }

  .modal-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: var(--surface2);
    border-bottom: 1px solid var(--border);
    border-radius: 10px 10px 0 0;
    flex-shrink: 0;
  }

  .modal-title {
    flex: 1;
    min-width: 0;
    font-size: 13px;
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .modal-badge {
    font-size: 10px;
    color: var(--muted);
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 2px 8px;
    border-radius: 4px;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .modal-close {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 5px;
    cursor: pointer;
    transition: all 0.15s;
    flex-shrink: 0;
  }

  .modal-close:hover { border-color: var(--accent3); color: var(--accent3); }

  .modal-body {
    overflow-y: auto;
    overflow-x: auto;
    flex: 1;
    padding: 8px 0 16px;
  }

  .modal-code-line {
    display: flex;
    align-items: flex-start;
    padding: 1px 20px;
    gap: 0;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12.5px;
    line-height: 1.7;
  }

  .modal-code-line:hover { background: rgba(255,255,255,0.02); }

  .modal-code-line.is-target {
    background: var(--match-bg);
    border-left: 2px solid var(--accent);
    padding-left: 18px;
  }

  .modal-line-num {
    color: var(--muted);
    min-width: 52px;
    text-align: right;
    margin-right: 20px;
    user-select: none;
    font-size: 11px;
    padding-top: 1px;
    flex-shrink: 0;
  }

  .modal-line-content {
    flex: 1;
    white-space: pre;
    color: var(--text);
    word-break: break-all;
    white-space: pre-wrap;
  }

  .modal-search {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }

  #modalSearchInput {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 4px 10px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--text);
    outline: none;
    width: 160px;
    caret-color: var(--accent2);
    transition: border-color 0.15s;
  }

  #modalSearchInput:focus { border-color: var(--accent); }
  #modalSearchInput::placeholder { color: var(--muted); }

  .modal-match-count {
    font-size: 11px;
    color: var(--muted);
    white-space: nowrap;
    min-width: 48px;
    text-align: center;
  }

  .modal-match-count.no-match { color: var(--accent3); }

  .modal-nav-btn {
    background: none;
    border: 1px solid var(--border);
    color: var(--muted);
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    padding: 2px 8px;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.15s;
    line-height: 1;
  }

  .modal-nav-btn:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
  .modal-nav-btn:disabled { opacity: 0.3; cursor: default; }

  .modal-code-line.modal-match-active {
    background: rgba(124,109,250,0.1);
    outline: 1px solid rgba(124,109,250,0.3);
    outline-offset: -1px;
  }

  /* ── Sticky top ── */
  .sticky-top {
    position: sticky;
    top: 0;
    z-index: 200;
    background: var(--bg);
    padding-top: 40px;
    margin-top: -40px;
    padding-bottom: 8px;
  }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--muted); }
</style>
</head>
<body>
<div id="app">
  <div class="sticky-top">
    <header>
      <div>
        <div class="logo">NoteSearch</div>
        <div class="logo-tag">fuzzy file explorer</div>
      </div>
      <div class="header-stats" id="headerStats">
        <div>Loading index…</div>
      </div>
    </header>

    <div class="search-wrap">
      <input
        id="searchInput"
        type="text"
        placeholder="search files, snippets, keywords…"
        autocomplete="off"
        spellcheck="false"
        autofocus
      />
      <div class="search-meta">
        <span class="key-hint">ESC clear</span>
        <span id="resultCount"></span>
      </div>
    </div>
    <div class="search-hint" id="searchHint">
      tip: wrap words in <kbd>"quotes"</kbd> for exact phrase matching &nbsp;·&nbsp; e.g. <code>"docker run" container</code>
    </div>

    <div class="filters" id="filtersBar">
      <span class="filter-label">type:</span>
      <button class="filter-btn active" data-ext="all">all</button>
    </div>
  </div>

  <div id="loading"><div class="spinner"></div>searching…</div>
  <div id="emptyState">
    <div class="empty-icon">◈</div>
    <div class="empty-text">no matches found</div>
    <div class="empty-sub">try a shorter query or different keywords</div>
  </div>
  <div id="results"></div>
</div>

<div id="fileModal">
  <div class="modal-box">
    <div class="modal-header">
      <span class="modal-title" id="modalTitle"></span>
      <span class="modal-badge" id="modalBadge"></span>
      <div class="modal-search">
        <input type="text" id="modalSearchInput" placeholder="find in file…" autocomplete="off" spellcheck="false" />
        <span class="modal-match-count" id="modalMatchCount"></span>
        <button class="modal-nav-btn" id="modalPrev" title="Previous (Shift+Enter)">↑</button>
        <button class="modal-nav-btn" id="modalNext" title="Next (Enter)">↓</button>
      </div>
      <button class="modal-close" id="modalClose">✕ close</button>
    </div>
    <div class="modal-body" id="modalBody"></div>
  </div>
</div>

<script>
const input = document.getElementById('searchInput');
const resultsEl = document.getElementById('results');
const resultCountEl = document.getElementById('resultCount');
const loadingEl = document.getElementById('loading');
const emptyEl = document.getElementById('emptyState');
const filtersBar = document.getElementById('filtersBar');
const headerStats = document.getElementById('headerStats');

let debounceTimer = null;
let lastQuery = '';
let activeExt = 'all';
let allResults = [];

// Load index stats
fetch('/api/stats').then(r => r.json()).then(s => {
  headerStats.innerHTML =
    '<div><span class="live">●</span> ' + s.fileCount + ' files indexed</div>' +
    '<div>' + s.dir + '</div>';
  buildFilterBtns(s.extensions);
});

function buildFilterBtns(exts) {
  // Remove old dynamic buttons
  const existing = filtersBar.querySelectorAll('[data-ext]:not([data-ext="all"])');
  existing.forEach(b => b.remove());
  const sorted = Object.entries(exts).sort((a,b) => b[1]-a[1]).slice(0, 12);
  for (const [ext, count] of sorted) {
    const btn = document.createElement('button');
    btn.className = 'filter-btn';
    btn.dataset.ext = ext;
    btn.textContent = '.' + ext + ' (' + count + ')';
    btn.addEventListener('click', () => setFilter(ext));
    filtersBar.appendChild(btn);
  }
}

filtersBar.addEventListener('click', e => {
  if (e.target.dataset.ext) setFilter(e.target.dataset.ext);
});

function setFilter(ext) {
  activeExt = ext;
  filtersBar.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.ext === ext);
  });
  renderResults();
}

input.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = input.value.trim();
  if (q === lastQuery) return;
  lastQuery = q;

  if (!q) {
    allResults = [];
    renderResults();
    resultCountEl.textContent = '';
    return;
  }

  loadingEl.classList.add('visible');
  debounceTimer = setTimeout(() => doSearch(q), 80);
});

input.addEventListener('keydown', e => {
  if (e.key === 'Escape') { input.value = ''; lastQuery = ''; allResults = []; renderResults(); resultCountEl.textContent = ''; }
});

async function doSearch(q) {
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    const data = await res.json();
    allResults = data.results || [];
    renderResults();
  } catch(err) {
    console.error(err);
  } finally {
    loadingEl.classList.remove('visible');
  }
}

function renderResults() {
  let filtered = allResults;
  if (activeExt !== 'all') {
    filtered = allResults.filter(r => r.ext === activeExt);
  }

  resultCountEl.textContent = filtered.length ? filtered.length + ' results' : '';
  emptyEl.classList.toggle('visible', lastQuery.length > 0 && filtered.length === 0);
  resultsEl.innerHTML = '';

  for (const r of filtered) {
    resultsEl.appendChild(buildCard(r));
  }
}

function extClass(ext) {
  const known = ['js','ts','jsx','tsx','py','sh','bash','zsh','fish','md','txt','json','yaml','yml','toml','html','css','sql','go','rs','c','cpp','rb','php','java'];
  return known.includes(ext) ? 'ext-' + ext : 'ext-default';
}

/**
 * Highlight all tokens in a line of text.
 * tokens: array of { type: 'phrase'|'fuzzy', value: string }
 * Phrase tokens → green exact mark; fuzzy tokens → purple fuzzy mark.
 */
function highlight(text, tokens) {
  if (!tokens || tokens.length === 0) return escHtml(text);

  // Build a char-level annotation array: null | 'phrase' | 'fuzzy'
  const marks = new Array(text.length).fill(null);
  const tl = text.toLowerCase();

  for (const token of tokens) {
    const v = token.value.toLowerCase();

    if (token.type === 'phrase') {
      // Exact substring — mark the whole span
      let from = 0;
      while (true) {
        const idx = tl.indexOf(v, from);
        if (idx === -1) break;
        for (let i = idx; i < idx + v.length; i++) marks[i] = 'phrase';
        from = idx + 1;
      }
    } else {
      // Fuzzy token — try exact first, then char-sequence
      const exactIdx = tl.indexOf(v);
      if (exactIdx !== -1) {
        for (let i = exactIdx; i < exactIdx + v.length; i++) marks[i] = marks[i] || 'exact';
      } else {
        let pi = 0;
        for (let i = 0; i < tl.length && pi < v.length; i++) {
          if (tl[i] === v[pi]) { marks[i] = marks[i] || 'fuzzy'; pi++; }
        }
      }
    }
  }

  // Render: walk chars and emit <mark> spans for runs of same type
  let out = '', i = 0;
  while (i < text.length) {
    const m = marks[i];
    if (!m) { out += escHtml(text[i++]); continue; }
    // Collect run of same mark type
    let j = i;
    while (j < text.length && marks[j] === m) j++;
    const cls = m === 'phrase' ? 'exact' : (m === 'exact' ? 'exact' : '');
    out += '<mark' + (cls ? ' class="' + cls + '"' : '') + '>' + escHtml(text.slice(i, j)) + '</mark>';
    i = j;
  }
  return out;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function buildCard(r) {
  const card = document.createElement('div');
  card.className = 'result-card' + (r.lineMatches.length > 0 ? ' expanded' : '');

  const hasSnippets = r.lineMatches.length > 0;

  // Header
  const header = document.createElement('div');
  header.className = 'file-header';
  header.innerHTML =
    '<span class="file-ext ' + extClass(r.ext) + '">' + (r.ext || '?') + '</span>' +
    '<div class="file-path">' +
      '<div class="file-name">' + escHtml(r.fileName) + '</div>' +
      '<div class="file-dir">' + escHtml(r.dir && r.dir !== '.' ? r.dir : '/') + '</div>' +
    '</div>' +
    '<div class="file-badges">' +
      (r.nameMatch ? '<span class="badge badge-name">filename</span>' : '') +
      (hasSnippets ? '<span class="badge badge-count">' + r.lineMatches.length + ' match' + (r.lineMatches.length > 1 ? 'es' : '') + '</span>' : '') +
    '</div>' +
    (hasSnippets ? '<span class="expand-toggle">▾</span>' : '');

  header.addEventListener('click', () => {
    if (hasSnippets) card.classList.toggle('expanded');
  });

  card.appendChild(header);

  // Snippets
  if (hasSnippets) {
    const snippetsEl = document.createElement('div');
    snippetsEl.className = 'snippets';

    for (const match of r.lineMatches) {
      const snip = document.createElement('div');
      snip.className = 'snippet';

      const meta = document.createElement('div');
      meta.className = 'snippet-meta';
      meta.innerHTML =
        '<span class="match-type ' + (match.type === 'phrase' ? 'match-exact' : match.type === 'exact' ? 'match-exact' : 'match-fuzzy') + '">' + match.type + '</span>' +
        '<span>line ' + (match.lineIndex + 1) + '</span>';
      snip.appendChild(meta);

      const codeBlock = document.createElement('div');
      codeBlock.className = 'code-block';

      for (const cl of match.context.lines) {
        const lineEl = document.createElement('div');
        lineEl.className = 'code-line' + (cl.isMatch ? (' is-match' + (match.type === 'exact' ? ' exact' : '')) : '');
        lineEl.title = 'Click to open file at line ' + cl.num;
        lineEl.style.cursor = 'pointer';
        lineEl.innerHTML =
          '<span class="line-num">' + cl.num + '</span>' +
          '<span class="line-content">' + (cl.isMatch ? highlight(cl.text, r.tokens) : escHtml(cl.text)) + '</span>';
        lineEl.addEventListener('click', e => {
          e.stopPropagation();
          openModal(r.filePath, r.fileName, cl.num);
        });
        codeBlock.appendChild(lineEl);
      }

      snip.appendChild(codeBlock);
      snippetsEl.appendChild(snip);
    }

    // Copy path button
    const openBtn = document.createElement('button');
    openBtn.className = 'open-file-btn';
    openBtn.innerHTML = '⊕ copy path';
    openBtn.addEventListener('click', e => {
      e.stopPropagation();
      navigator.clipboard.writeText(r.filePath).then(() => {
        openBtn.textContent = '✓ copied!';
        setTimeout(() => { openBtn.innerHTML = '⊕ copy path'; }, 1500);
      });
    });
    snippetsEl.appendChild(openBtn);

    card.appendChild(snippetsEl);
  }

  return card;
}

// ── File Modal ────────────────────────────────────────────────────────────────

const fileModal       = document.getElementById('fileModal');
const modalTitle      = document.getElementById('modalTitle');
const modalBadge      = document.getElementById('modalBadge');
const modalBody       = document.getElementById('modalBody');
const modalClose      = document.getElementById('modalClose');
const modalSearchInput = document.getElementById('modalSearchInput');
const modalMatchCount  = document.getElementById('modalMatchCount');
const modalPrev        = document.getElementById('modalPrev');
const modalNext        = document.getElementById('modalNext');

let modalLines    = []; // { el, text } for every rendered line
let modalMatches  = []; // indices into modalLines that match the query
let modalMatchIdx = -1;

function openModal(filePath, fileName, targetLine) {
  fetch('/api/file?path=' + encodeURIComponent(filePath))
    .then(r => r.json())
    .then(data => {
      if (data.error) return;

      modalTitle.textContent = data.relPath || fileName;
      modalBadge.textContent = 'line ' + targetLine + ' of ' + data.lines.length;
      modalBody.innerHTML = '';

      let targetEl = null;
      const frag = document.createDocumentFragment();
      modalLines = [];

      data.lines.forEach((text, i) => {
        const lineNum = i + 1;
        const isTarget = lineNum === targetLine;
        const row = document.createElement('div');
        row.className = 'modal-code-line' + (isTarget ? ' is-target' : '');
        row.innerHTML =
          '<span class="modal-line-num">' + lineNum + '</span>' +
          '<span class="modal-line-content">' + escHtml(text) + '</span>';
        if (isTarget) targetEl = row;
        modalLines.push({ el: row, text });
        frag.appendChild(row);
      });

      modalBody.appendChild(frag);
      fileModal.classList.add('open');
      document.body.style.overflow = 'hidden';

      if (targetEl) {
        requestAnimationFrame(() => {
          targetEl.scrollIntoView({ block: 'center' });
        });
      }
    })
    .catch(err => console.error('modal fetch error', err));
}

function closeModal() {
  fileModal.classList.remove('open');
  document.body.style.overflow = '';
  modalBody.innerHTML = '';
  modalSearchInput.value = '';
  modalLines = [];
  modalMatches = [];
  modalMatchIdx = -1;
  modalMatchCount.textContent = '';
  modalMatchCount.classList.remove('no-match');
  updateNavBtns();
}

function highlightModalQuery(text, query) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let out = '', i = 0;
  while (i < text.length) {
    const idx = t.indexOf(q, i);
    if (idx === -1) { out += escHtml(text.slice(i)); break; }
    out += escHtml(text.slice(i, idx));
    out += '<mark class="exact">' + escHtml(text.slice(idx, idx + query.length)) + '</mark>';
    i = idx + query.length;
  }
  return out;
}

function updateNavBtns() {
  const has = modalMatches.length > 0;
  modalPrev.disabled = !has;
  modalNext.disabled = !has;
}

function jumpToModalMatch(idx) {
  if (modalMatchIdx >= 0 && modalMatchIdx < modalMatches.length) {
    modalLines[modalMatches[modalMatchIdx]].el.classList.remove('modal-match-active');
  }
  modalMatchIdx = idx;
  const { el } = modalLines[modalMatches[idx]];
  el.classList.add('modal-match-active');
  el.scrollIntoView({ block: 'center' });
  modalMatchCount.textContent = (idx + 1) + ' / ' + modalMatches.length;
  modalMatchCount.classList.remove('no-match');
}

function findInModal(query) {
  for (const { el, text } of modalLines) {
    el.classList.remove('modal-match-active');
    el.children[1].innerHTML = escHtml(text);
  }
  modalMatches = [];
  modalMatchIdx = -1;

  if (!query) {
    modalMatchCount.textContent = '';
    modalMatchCount.classList.remove('no-match');
    updateNavBtns();
    return;
  }

  const q = query.toLowerCase();
  for (let i = 0; i < modalLines.length; i++) {
    const { el, text } = modalLines[i];
    if (text.toLowerCase().includes(q)) {
      el.children[1].innerHTML = highlightModalQuery(text, query);
      modalMatches.push(i);
    }
  }

  if (modalMatches.length > 0) {
    jumpToModalMatch(0);
  } else {
    modalMatchCount.textContent = 'no matches';
    modalMatchCount.classList.add('no-match');
    updateNavBtns();
  }
}

modalClose.addEventListener('click', closeModal);

fileModal.addEventListener('click', e => {
  if (e.target === fileModal) closeModal();
});

modalSearchInput.addEventListener('input', () => {
  findInModal(modalSearchInput.value);
});

modalSearchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && modalMatches.length > 0) {
    e.preventDefault();
    const next = e.shiftKey
      ? (modalMatchIdx - 1 + modalMatches.length) % modalMatches.length
      : (modalMatchIdx + 1) % modalMatches.length;
    jumpToModalMatch(next);
  }
  if (e.key === 'Escape') {
    e.stopPropagation();
    modalSearchInput.value = '';
    findInModal('');
  }
});

modalPrev.addEventListener('click', () => {
  if (modalMatches.length > 0)
    jumpToModalMatch((modalMatchIdx - 1 + modalMatches.length) % modalMatches.length);
});

modalNext.addEventListener('click', () => {
  if (modalMatches.length > 0)
    jumpToModalMatch((modalMatchIdx + 1) % modalMatches.length);
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && fileModal.classList.contains('open')) closeModal();
});
</script>
</body>
</html>`;
} // end buildHTML

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.port}`);

  // ── GET / → serve the HTML app
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buildHTML());
    return;
  }

  // ── GET /fonts/* → serve local font files
  if (url.pathname.startsWith('/fonts/')) {
    const fileName = path.basename(url.pathname); // prevent path traversal
    const fontPath = path.join(FONTS_DIR, fileName);
    if (!fs.existsSync(fontPath)) {
      res.writeHead(404);
      res.end('Font not found');
      return;
    }
    const ext = path.extname(fileName).slice(1).toLowerCase();
    const mimeTypes = {
      woff2: 'font/woff2',
      woff:  'font/woff',
      ttf:   'font/ttf',
      css:   'text/css',
    };
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=31536000, immutable', // fonts don't change
    });
    fs.createReadStream(fontPath).pipe(res);
    return;
  }

  // ── GET /api/stats
  if (url.pathname === '/api/stats') {
    const extCounts = {};
    for (const f of INDEX) {
      extCounts[f.ext] = (extCounts[f.ext] || 0) + 1;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({
      fileCount: INDEX.length,
      dir: CONFIG.dir,
      extensions: extCounts,
      lastIndexed,
    }));
    return;
  }

  // ── GET /api/search?q=...
  if (url.pathname === '/api/search') {
    const query = url.searchParams.get('q') || '';
    const results = search(query);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ results, count: results.length, query }));
    return;
  }

  // ── GET /api/file?path=...
  if (url.pathname === '/api/file') {
    const reqPath = url.searchParams.get('path') || '';
    const resolved = path.resolve(reqPath);
    // Only serve files that are inside CONFIG.dir and already in the index
    const inIndex = INDEX.find(f => f.filePath === resolved);
    if (!inIndex || !resolved.startsWith(CONFIG.dir)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(JSON.stringify({ lines: inIndex.lines, relPath: inIndex.relPath }));
    return;
  }

  // ── GET /api/reindex
  if (url.pathname === '/api/reindex') {
    const count = buildIndex();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, fileCount: count }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(CONFIG.port, () => {
  console.log(`✓ Ready → http://localhost:${CONFIG.port}`);
  console.log(`  Tip: node server.js --dir ~/notes --port 3131\n`);
});

process.on('SIGINT', () => { console.log('\nBye!'); process.exit(0); });
