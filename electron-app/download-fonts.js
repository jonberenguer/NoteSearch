#!/usr/bin/env node
/**
 * download-fonts.js
 * Downloads JetBrains Mono and Syne from Google Fonts as local WOFF2 files.
 * Run once: node download-fonts.js
 * After this, server.js serves fonts from ./fonts/ with no internet required.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const FONTS_DIR = path.join(__dirname, 'fonts');

// ─── Font definitions ─────────────────────────────────────────────────────────
// Each entry: { file, url }
// URLs are the stable Google Fonts static CDN paths for WOFF2 files.
// These are the same files the browser downloads when you use the @import URL.

const FONTS = [
  // ── JetBrains Mono ──
  {
    file: 'jetbrains-mono-300.woff2',
    url: 'https://fonts.gstatic.com/s/jetbrainsmono/v18/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKxjOlCRk_iFG7bT.woff2',
    desc: 'JetBrains Mono Light 300',
  },
  {
    file: 'jetbrains-mono-400.woff2',
    url: 'https://fonts.gstatic.com/s/jetbrainsmono/v18/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKxjOlCRk_iFG7bT.woff2',
    desc: 'JetBrains Mono Regular 400',
  },
  {
    file: 'jetbrains-mono-500.woff2',
    url: 'https://fonts.gstatic.com/s/jetbrainsmono/v18/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKxjOlCRk_iFG7bT.woff2',
    desc: 'JetBrains Mono Medium 500',
  },
  {
    file: 'jetbrains-mono-700.woff2',
    url: 'https://fonts.gstatic.com/s/jetbrainsmono/v18/tDbY2o-flEEny0FZhsfKu5WU4zr3E_BX0PnT8RD8yKxjOlCRk_iFG7bT.woff2',
    desc: 'JetBrains Mono Bold 700',
  },
  {
    file: 'jetbrains-mono-400italic.woff2',
    url: 'https://fonts.gstatic.com/s/jetbrainsmono/v18/tDbX2o-flEEny0FZhsfKu5WU4Jr6JQJHlQ0-6L7iBto.woff2',
    desc: 'JetBrains Mono Italic 400',
  },
  // ── Syne ──
  {
    file: 'syne-400.woff2',
    url: 'https://fonts.gstatic.com/s/syne/v22/8vIS7w4qzmVxsWxjBZRjr0FKM_04uQ.woff2',
    desc: 'Syne Regular 400',
  },
  {
    file: 'syne-700.woff2',
    url: 'https://fonts.gstatic.com/s/syne/v22/8vIS7w4qzmVxsWxjBZRjr0FKM_04uQ.woff2',
    desc: 'Syne Bold 700',
  },
  {
    file: 'syne-800.woff2',
    url: 'https://fonts.gstatic.com/s/syne/v22/8vIS7w4qzmVxsWxjBZRjr0FKM_04uQ.woff2',
    desc: 'Syne ExtraBold 800',
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fetchGoogleFontsCss(url) {
  return new Promise((resolve, reject) => {
    // Spoof a modern browser UA so Google returns WOFF2 (not TTF/EOT)
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
    };
    https.get(url, options, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchGoogleFontsCss(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadBinary(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadBinary(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', reject);
  });
}

function parseWoff2Urls(css) {
  // Extract all url(...) references that are WOFF2
  const re = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/g;
  const urls = new Set();
  let m;
  while ((m = re.exec(css)) !== null) urls.add(m[1]);
  return [...urls];
}

function extractFontFaces(css) {
  // Pull each @font-face block out of the CSS
  const blocks = [];
  const re = /@font-face\s*\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(css)) !== null) blocks.push(m[1]);
  return blocks;
}

function buildLocalFontFaces(css, urlToFile) {
  // Rewrite the Google Fonts CSS, replacing remote gstatic URLs with /fonts/<file>
  let local = css;
  for (const [remoteUrl, fileName] of Object.entries(urlToFile)) {
    local = local.split(remoteUrl).join('/fonts/' + fileName);
  }
  // Remove the unicode-range lines — not needed for local serving
  // Keep them actually, they help the browser load only what's needed
  return local;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n📦 NoteSearch Font Downloader');
  console.log('─'.repeat(40));

  // 1. Create fonts directory
  if (!fs.existsSync(FONTS_DIR)) {
    fs.mkdirSync(FONTS_DIR, { recursive: true });
    console.log('  Created fonts/ directory');
  }

  // 2. Fetch the CSS from Google Fonts (this tells us the exact WOFF2 URLs)
  console.log('\n  Fetching font manifest from Google Fonts…');
  const googleFontsUrl =
    'https://fonts.googleapis.com/css2' +
    '?family=JetBrains+Mono:ital,wght@0,300;0,400;0,500;0,700;1,400' +
    '&family=Syne:wght@400;700;800' +
    '&display=swap';

  let css;
  try {
    css = await fetchGoogleFontsCss(googleFontsUrl);
  } catch (err) {
    console.error('\n  ✗ Could not reach Google Fonts:', err.message);
    console.error('  Make sure you have internet access and try again.\n');
    process.exit(1);
  }

  // 3. Parse all WOFF2 URLs from the CSS
  const woff2Urls = parseWoff2Urls(css);
  if (woff2Urls.length === 0) {
    console.error('  ✗ No WOFF2 URLs found in Google Fonts response.');
    console.error('  The API response format may have changed. CSS preview:');
    console.error(css.slice(0, 400));
    process.exit(1);
  }

  console.log(`  Found ${woff2Urls.length} WOFF2 files to download\n`);

  // 4. Build a url → local filename map
  //    Google uses content-hashed filenames; we'll name them by index for clarity
  //    but derive the name from the CSS @font-face context (family + weight + style)
  const urlToFile = {};
  const fontFaceBlocks = extractFontFaces(css);

  // Match each URL to its @font-face block to derive a clean filename
  for (const block of fontFaceBlocks) {
    const urlMatch = block.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+\.woff2)\)/);
    if (!urlMatch) continue;
    const url = urlMatch[1];
    if (urlToFile[url]) continue; // already mapped

    const familyMatch = block.match(/font-family:\s*['"]?([^'";]+)['"]?/i);
    const weightMatch = block.match(/font-weight:\s*(\d+)/i);
    const styleMatch  = block.match(/font-style:\s*(italic|normal)/i);

    const family = (familyMatch?.[1] || 'font').replace(/\s+/g, '-').toLowerCase();
    const weight = weightMatch?.[1] || '400';
    const style  = styleMatch?.[1] === 'italic' ? 'italic' : '';

    const fileName = `${family}-${weight}${style ? '-' + style : ''}.woff2`;
    urlToFile[url] = fileName;
  }

  // Fallback: any URLs not yet mapped get a numeric name
  let idx = 1;
  for (const url of woff2Urls) {
    if (!urlToFile[url]) urlToFile[url] = `font-${idx++}.woff2`;
  }

  // 5. Download each WOFF2 file
  let downloaded = 0, skipped = 0, failed = 0;

  for (const [url, fileName] of Object.entries(urlToFile)) {
    const destPath = path.join(FONTS_DIR, fileName);

    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      console.log(`  ↩  ${fileName} (already exists)`);
      skipped++;
      continue;
    }

    process.stdout.write(`  ↓  ${fileName}…`);
    try {
      await downloadBinary(url, destPath);
      const size = Math.round(fs.statSync(destPath).size / 1024);
      console.log(` ${size}KB ✓`);
      downloaded++;
    } catch (err) {
      console.log(` ✗ (${err.message})`);
      // Clean up partial file
      try { fs.unlinkSync(destPath); } catch {}
      failed++;
    }
  }

  // 6. Write the rewritten CSS as fonts/fonts.css for server.js to serve
  const localCss = buildLocalFontFaces(css, urlToFile);
  const cssPath = path.join(FONTS_DIR, 'fonts.css');
  fs.writeFileSync(cssPath, localCss, 'utf8');
  console.log(`\n  ✓ Wrote fonts/fonts.css`);

  // 7. Summary
  console.log('\n' + '─'.repeat(40));
  if (failed > 0) {
    console.log(`  ⚠  ${downloaded} downloaded, ${skipped} skipped, ${failed} failed`);
    console.log('  Some fonts are missing — run again when online to retry.\n');
    process.exit(1);
  } else {
    console.log(`  ✓ ${downloaded} downloaded, ${skipped} already cached`);
    console.log('  All fonts saved to fonts/');
    console.log('  NoteSearch will now serve fonts offline automatically.\n');
  }
}

main().catch(err => {
  console.error('\nUnexpected error:', err);
  process.exit(1);
});
