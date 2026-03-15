'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeTheme } = require('electron');
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ─── Paths ────────────────────────────────────────────────────────────────────

const IS_DEV        = process.argv.includes('--dev');
const APP_ROOT      = path.join(__dirname, '..');
const CONFIG_PATH   = path.join(APP_ROOT, 'config.json');
const FONTS_DIR     = path.join(APP_ROOT, 'fonts');
const LOCAL_FONTS   = path.join(FONTS_DIR, 'fonts.css');

// ─── Config ───────────────────────────────────────────────────────────────────

function loadConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const cfg = JSON.parse(raw);

    // Resolve ~ in notesDir
    if (cfg.notesDir && cfg.notesDir.startsWith('~')) {
      cfg.notesDir = path.join(os.homedir(), cfg.notesDir.slice(1));
    }

    // Validate notesDir exists
    if (!cfg.notesDir || !fs.existsSync(cfg.notesDir)) {
      cfg.notesDirMissing = true;
    }

    return cfg;
  } catch (err) {
    console.error('Failed to load config.json:', err.message);
    return getDefaultConfig();
  }
}

function getDefaultConfig() {
  return {
    notesDir: os.homedir(),
    port: 3131,
    extensions: ['md','txt','js','ts','py','sh','bash','json','yaml','yml'],
    maxFileSize: 1048576,
    contextLines: 3,
    maxResults: 50,
    reindexInterval: 30000,
    window: { width: 1100, height: 800, rememberPosition: true },
  };
}

function saveConfig(updates) {
  try {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const merged = Object.assign({}, existing, updates);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ─── Index ────────────────────────────────────────────────────────────────────

let INDEX = [];
let reindexTimer = null;
let watcherHandle = null;
let debounceTimer = null;
let currentConfig = null;

function walkDir(dir, exts, results = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (['node_modules','__pycache__','.git','dist','build','.next','venv'].includes(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(fullPath, exts, results);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      if (exts.includes(ext)) results.push(fullPath);
    }
  }
  return results;
}

function buildIndex(cfg) {
  if (!cfg.notesDir || cfg.notesDirMissing) return 0;
  const files = walkDir(cfg.notesDir, cfg.extensions);
  const next = [];

  for (const filePath of files) {
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > cfg.maxFileSize) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      const lines   = content.split('\n');
      const relPath = path.relative(cfg.notesDir, filePath);
      const ext     = path.extname(filePath).slice(1).toLowerCase();
      next.push({
        filePath, relPath,
        fileName: path.basename(filePath),
        dir: path.dirname(relPath),
        ext, content,
        contentLower: content.toLowerCase(),
        lines, size: stat.size, mtime: stat.mtimeMs,
      });
    } catch { /* skip */ }
  }

  INDEX = next;
  console.log(`[index] ${INDEX.length} files from ${cfg.notesDir}`);
  return INDEX.length;
}

function startWatcher(cfg) {
  if (watcherHandle) { try { watcherHandle.close(); } catch {} }
  if (!cfg.notesDir || cfg.notesDirMissing) return;

  try {
    watcherHandle = fs.watch(cfg.notesDir, { recursive: true }, (event, filename) => {
      if (filename && !filename.startsWith('.')) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          buildIndex(cfg);
          mainWindow?.webContents.send('index-updated', { count: INDEX.length });
        }, 500);
      }
    });
  } catch { /* non-fatal — polling fallback covers it */ }

  clearInterval(reindexTimer);
  reindexTimer = setInterval(() => {
    buildIndex(cfg);
    mainWindow?.webContents.send('index-updated', { count: INDEX.length });
  }, cfg.reindexInterval || 30000);
}

// ─── Search ───────────────────────────────────────────────────────────────────

function parseQuery(raw) {
  const tokens = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    tokens.push(m[1] !== undefined
      ? { type: 'phrase', value: m[1] }
      : { type: 'fuzzy',  value: m[2] });
  }
  return tokens;
}

function scoreToken(token, text) {
  const t = text.toLowerCase();
  const v = token.value.toLowerCase();

  if (token.type === 'phrase') {
    const idx = t.indexOf(v);
    if (idx === -1) return null;
    const bonus = (idx === 0 || /\W/.test(t[idx - 1])) ? 20 : 10;
    return { score: 100 + bonus, type: 'phrase', index: idx };
  }

  const exactIdx = t.indexOf(v);
  if (exactIdx !== -1) {
    const bonus = (exactIdx === 0 || /\W/.test(t[exactIdx - 1])) ? 20 : 10;
    return { score: 100 + bonus, type: 'exact', index: exactIdx };
  }

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

function scoreLineTokens(tokens, text) {
  let total = 0, bestType = 'fuzzy';
  for (const token of tokens) {
    const result = scoreToken(token, text);
    if (!result) {
      if (token.type === 'phrase') return null;
      continue;
    }
    total += result.score;
    if (result.type === 'phrase' || result.type === 'exact') bestType = result.type;
  }
  return total > 0 ? { score: total, type: bestType } : null;
}

function getContext(lines, lineIndex, radius) {
  const r     = radius || 3;
  const start = Math.max(0, lineIndex - r);
  const end   = Math.min(lines.length - 1, lineIndex + r);
  return {
    start, end, matchLine: lineIndex,
    lines: lines.slice(start, end + 1).map((text, i) => ({
      num: start + i + 1, text, isMatch: start + i === lineIndex,
    })),
  };
}

function searchInFile(file, tokens, contextLines) {
  const matches = [];
  for (let i = 0; i < file.lines.length; i++) {
    const result = scoreLineTokens(tokens, file.lines[i]);
    if (result && result.score > 0) {
      matches.push({ lineIndex: i, score: result.score, type: result.type,
        context: getContext(file.lines, i, contextLines), lineText: file.lines[i] });
    }
  }
  const deduped = [];
  const usedLines = new Set();
  matches.sort((a, b) => b.score - a.score);
  for (const m of matches) {
    let tooClose = false;
    for (const used of usedLines) {
      if (Math.abs(m.lineIndex - used) <= 5) { tooClose = true; break; }
    }
    if (!tooClose) { deduped.push(m); usedLines.add(m.lineIndex); }
    if (deduped.length >= 5) break;
  }
  return deduped;
}

function search(query, cfg) {
  if (!query || query.trim().length < 1) return [];
  const tokens = parseQuery(query.trim());
  if (tokens.length === 0) return [];
  const results = [];

  for (const file of INDEX) {
    let nameScore = 0;
    for (const token of tokens) {
      const r = scoreToken(token, file.fileName);
      if (r) nameScore += r.score;
    }
    const lineMatches   = searchInFile(file, tokens, cfg.contextLines);
    const bestLineScore = lineMatches.length > 0 ? Math.max(...lineMatches.map(m => m.score)) : 0;
    const fileScore     = Math.max(nameScore * 1.5, bestLineScore);

    if (fileScore > 0 || lineMatches.length > 0) {
      results.push({
        filePath: file.filePath, relPath: file.relPath,
        fileName: file.fileName, dir: file.dir, ext: file.ext,
        score: fileScore, nameMatch: nameScore > 0,
        lineMatches, size: file.size, mtime: file.mtime, tokens,
      });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, cfg.maxResults || 50);
}

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow(cfg) {
  const win = new BrowserWindow({
    width:  cfg.window?.width  || 1100,
    height: cfg.window?.height || 800,
    minWidth:  700,
    minHeight: 500,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0f',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    if (IS_DEV) win.webContents.openDevTools({ mode: 'detach' });
  });

  // Save window size on close
  win.on('close', () => {
    if (cfg.window?.rememberPosition) {
      const [width, height] = win.getSize();
      saveConfig({ window: { ...cfg.window, width, height } });
    }
  });

  return win;
}

function buildAppMenu(cfg) {
  const template = [
    {
      label: 'NoteSearch',
      submenu: [
        { label: 'About NoteSearch', role: 'about' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('open-settings') },
        { type: 'separator' },
        { label: 'Quit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open Notes Folder…', accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const result = await dialog.showOpenDialog(mainWindow, {
              properties: ['openDirectory'],
              title: 'Select Notes Folder',
              defaultPath: cfg.notesDir || os.homedir(),
            });
            if (!result.canceled && result.filePaths[0]) {
              const newDir = result.filePaths[0];
              saveConfig({ notesDir: newDir });
              currentConfig = loadConfig();
              buildIndex(currentConfig);
              startWatcher(currentConfig);
              mainWindow?.webContents.send('config-changed', {
                config: getSafeConfig(currentConfig),
                indexCount: INDEX.length,
              });
            }
          },
        },
        { label: 'Reveal Notes Folder in Finder', accelerator: 'CmdOrCtrl+Shift+O',
          click: () => { if (cfg.notesDir) shell.openPath(cfg.notesDir); }
        },
        { type: 'separator' },
        { label: 'Edit config.json', click: () => shell.openPath(CONFIG_PATH) },
        { type: 'separator' },
        { label: 'Re-index Now', accelerator: 'CmdOrCtrl+R',
          click: () => {
            buildIndex(currentConfig);
            mainWindow?.webContents.send('index-updated', { count: INDEX.length });
          }
        },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' }, { role: 'forceReload' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(IS_DEV ? [{ type: 'separator' }, { role: 'toggleDevTools' }] : []),
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Strip sensitive/internal fields before sending config to renderer
function getSafeConfig(cfg) {
  return {
    notesDir: cfg.notesDir,
    notesDirMissing: cfg.notesDirMissing || false,
    extensions: cfg.extensions,
    maxFileSize: cfg.maxFileSize,
    contextLines: cfg.contextLines,
    maxResults: cfg.maxResults,
    reindexInterval: cfg.reindexInterval,
    window: cfg.window,
    localFonts: fs.existsSync(LOCAL_FONTS),
  };
}

// ─── IPC Handlers ─────────────────────────────────────────────────────────────

function registerIpc() {
  // Renderer asks for initial config + stats
  ipcMain.handle('get-config', () => {
    return { config: getSafeConfig(currentConfig), indexCount: INDEX.length };
  });

  // Renderer performs a search
  ipcMain.handle('search', (_, query) => {
    return search(query, currentConfig);
  });

  // Renderer wants to change the notes directory via dialog
  ipcMain.handle('pick-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Notes Folder',
      defaultPath: currentConfig.notesDir || os.homedir(),
    });
    if (result.canceled) return null;
    return result.filePaths[0];
  });

  // Renderer saves updated config
  ipcMain.handle('save-config', (_, updates) => {
    const result = saveConfig(updates);
    if (result.ok) {
      currentConfig = loadConfig();
      buildIndex(currentConfig);
      startWatcher(currentConfig);
      mainWindow?.webContents.send('config-changed', {
        config: getSafeConfig(currentConfig),
        indexCount: INDEX.length,
      });
    }
    return result;
  });

  // Open a file in the default system editor
  ipcMain.handle('open-file', (_, filePath) => {
    shell.openPath(filePath);
  });

  // Reveal a file in Finder/Explorer
  ipcMain.handle('reveal-file', (_, filePath) => {
    shell.showItemInFolder(filePath);
  });

  // Trigger manual re-index
  ipcMain.handle('reindex', () => {
    buildIndex(currentConfig);
    return { count: INDEX.length };
  });

  // Get extension stats for filter bar
  ipcMain.handle('get-stats', () => {
    const extCounts = {};
    for (const f of INDEX) extCounts[f.ext] = (extCounts[f.ext] || 0) + 1;
    return {
      fileCount: INDEX.length,
      notesDir: currentConfig.notesDir,
      extensions: extCounts,
      localFonts: fs.existsSync(LOCAL_FONTS),
    };
  });
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  currentConfig = loadConfig();
  registerIpc();

  mainWindow = createWindow(currentConfig);
  buildAppMenu(currentConfig);

  // Build index after window is ready
  mainWindow.once('ready-to-show', () => {
    buildIndex(currentConfig);
    startWatcher(currentConfig);
    // Push initial stats to renderer once it's loaded
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('index-updated', { count: INDEX.length });
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow(currentConfig);
    } else {
      mainWindow?.show();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  clearInterval(reindexTimer);
  clearTimeout(debounceTimer);
  try { watcherHandle?.close(); } catch {}
});
