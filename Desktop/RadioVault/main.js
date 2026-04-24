const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
let keytar;
try { keytar = require('keytar'); } catch (_) { keytar = null; }
const supabaseClient = require('./supabase');
const feeds = require('./feeds');
let autoUpdater;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) { autoUpdater = null; }

// ─── User data paths (writable -- __dirname inside asar is read-only) ───────
if (process.env.RADIOVAULT_USER_DATA_PATH) {
  app.setPath('userData', path.resolve(process.env.RADIOVAULT_USER_DATA_PATH));
}
const USER_DATA_PATH  = app.getPath('userData');
if (!fs.existsSync(USER_DATA_PATH)) fs.mkdirSync(USER_DATA_PATH, { recursive: true });
const SETTINGS_PATH   = path.join(USER_DATA_PATH, 'settings.json');
const DB_PATH_DEFAULT = path.join(USER_DATA_PATH, 'vault_db.json');

// Seed vault_db.json from bundle on first run
const _bundledDb = path.join(__dirname, 'vault_db.json');
if (!fs.existsSync(DB_PATH_DEFAULT) && fs.existsSync(_bundledDb)) {
  try { fs.copyFileSync(_bundledDb, DB_PATH_DEFAULT); } catch (_) {}
}

function getSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch { return {}; }
}

function sanitizeIngestionConfig(ingestion) {
  if (!ingestion || typeof ingestion !== 'object') return {};
  const { groq_api_key, anthropic_api_key, ...safeIngestion } = ingestion;
  return safeIngestion;
}

function expandHome(p) {
  return p ? p.replace(/^~/, os.homedir()) : p;
}

function getWorkspacePaths() {
  const settings = getSettings();
  const root = settings.sync_path ? expandHome(settings.sync_path) : USER_DATA_PATH;
  const dbPath = settings.sync_path ? path.join(root, 'vault_db.json') : DB_PATH_DEFAULT;

  // Use shared media path for audio if configured, otherwise local cache
  const sharedMedia = settings.shared_media_path ? expandHome(settings.shared_media_path) : null;
  const audioCacheDir = sharedMedia || path.join(root, 'audio_cache');

  for (const dir of [root, audioCacheDir]) {
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      // Shared drive might not be mounted -- fall back to local
      if (dir === sharedMedia) {
        console.log(`[RadioVault] Shared media path not available (${dir}), using local cache`);
        return {
          root,
          dbPath,
          audioCacheDir: path.join(root, 'audio_cache'),
          usingSharedMedia: false,
          sharedMediaPath: sharedMedia,
        };
      }
    }
  }
  if (!fs.existsSync(dbPath)) {
    if (fs.existsSync(_bundledDb)) fs.copyFileSync(_bundledDb, dbPath);
    else atomicWriteJson(dbPath, { content_items: {}, clips: [], tags: {}, shows: {}, home_topics: [], last_updated: null });
  }
  return {
    root,
    dbPath,
    audioCacheDir,
    usingSharedMedia: !!sharedMedia,
    sharedMediaPath: sharedMedia,
  };
}

function getDbPath() {
  return getWorkspacePaths().dbPath;
}

function isPathInside(targetPath, parentPath) {
  if (!targetPath || !parentPath) return false;
  try {
    const relative = path.relative(path.resolve(parentPath), path.resolve(targetPath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  } catch (_) {
    return false;
  }
}

function atomicWriteJson(filePath, value) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
}

async function atomicWriteJsonAsync(filePath, value) {
  const tmpPath = filePath + '.tmp';
  await fs.promises.writeFile(tmpPath, JSON.stringify(value, null, 2), 'utf8');
  await fs.promises.rename(tmpPath, filePath);
}

const EMPTY_DB = { content_items: {}, clips: [], tags: {}, shows: {}, home_topics: [], last_updated: null };

function safeReadJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[RadioVault] Failed to parse ${filePath}:`, err.message);
    return fallback;
  }
}

const PACKAGE_META     = require('./package.json');
const APP_VERSION      = PACKAGE_META.version;
const KEYCHAIN_SERVICE = 'radiovault';
const ANTHROPIC_KEY_ACCOUNT   = 'anthropic_api_key';
const GROQ_KEY_ACCOUNT        = 'groq_api_key';
const SUPABASE_URL_ACCOUNT    = 'supabase_url';
const SUPABASE_KEY_ACCOUNT    = 'supabase_service_key';

// ─── Supabase initialization ────────────────────────────────────────────────
async function initSupabase() {
  if (supabaseClient.isInitialized()) return true;
  if (!keytar) return false;
  try {
    const url = await keytar.getPassword(KEYCHAIN_SERVICE, SUPABASE_URL_ACCOUNT);
    const key = await keytar.getPassword(KEYCHAIN_SERVICE, SUPABASE_KEY_ACCOUNT);
    if (url && key) {
      supabaseClient.init(url, key);
      console.log('[RadioVault] Supabase client initialized');
      return true;
    }
  } catch (_) {}
  return false;
}

async function fetchRemoteDB() {
  if (await initSupabase()) {
    try {
      const db = await supabaseClient.fetchFullDb();
      console.log('[RadioVault] Loaded DB from Supabase');
      return db;
    } catch (err) {
      console.error('[RadioVault] Supabase fetch failed:', err.message);
    }
  }
  return null;
}

function serializeForRenderer(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

let mainWindow;
let cachedDb = null;
const TRANSCRIPT_SYNC_RETRY_MS = 12 * 60 * 60 * 1000;

// ─── DB merge ───────────────────────────────────────────────────────────────
function mergeDbForRenderer(networkDb, localDb) {
  if (!networkDb || typeof networkDb !== 'object') return localDb || networkDb;
  if (!localDb || typeof localDb !== 'object') return networkDb;

  const mergedItems = { ...(networkDb.content_items || {}) };
  const localItems = localDb.content_items || {};

  for (const [id, localItem] of Object.entries(localItems)) {
    const networkItem = mergedItems[id];
    if (!networkItem) {
      mergedItems[id] = localItem;
      continue;
    }
    const merged = { ...networkItem };
    if (localItem.file_path) merged.file_path = localItem.file_path;
    if (localItem.transcript && !merged.transcript) merged.transcript = localItem.transcript;
    if (localItem.summary && !merged.summary) merged.summary = localItem.summary;
    if (localItem.key_moments && !merged.key_moments) merged.key_moments = localItem.key_moments;
    if (localItem.topics_found && Array.isArray(localItem.topics_found)) merged.topics_found = localItem.topics_found;
    if (localItem.transcript_sync_checked_at) merged.transcript_sync_checked_at = localItem.transcript_sync_checked_at;
    if (localItem.transcript_sync_state) merged.transcript_sync_state = localItem.transcript_sync_state;
    mergedItems[id] = merged;
  }

  const mergedClips = [...(networkDb.clips || [])];
  const seenClipKeys = new Set(mergedClips.map(clipMergeKey));
  for (const clip of (localDb.clips || [])) {
    const key = clipMergeKey(clip);
    if (!seenClipKeys.has(key)) {
      seenClipKeys.add(key);
      mergedClips.push(clip);
    }
  }

  return {
    ...networkDb,
    content_items: mergedItems,
    clips: mergedClips,
    tags: (networkDb.tags && Object.keys(networkDb.tags).length) ? networkDb.tags : (localDb.tags || {}),
    shows: (networkDb.shows && Object.keys(networkDb.shows).length) ? networkDb.shows : (localDb.shows || {}),
    home_topics: (networkDb.home_topics && networkDb.home_topics.length) ? networkDb.home_topics : (localDb.home_topics || []),
  };
}

function clipMergeKey(clip) {
  return [
    clip?.content_item_id || '',
    Number(clip?.timestamp_start || 0),
    Number(clip?.timestamp_end || 0),
    String(clip?.quote || '')
  ].join('||');
}

// ─── Derive shows from content items ────────────────────────────────────────
function deriveShows(contentItems) {
  const shows = {};
  for (const item of Object.values(contentItems || {})) {
    const name = item.show_name;
    if (!name) continue;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!shows[slug]) {
      shows[slug] = { name, content_type: item.content_type || 'radio_broadcast', item_count: 0 };
    }
    shows[slug].item_count++;
  }
  return shows;
}

// ─── Path probing ───────────────────────────────────────────────────────────
const TEST_BIN_PATH = '/bin/test';

function probePathWithTest(targetPath, testFlag = '-e', timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (!targetPath || !path.isAbsolute(targetPath)) return resolve(false);
    execFile(TEST_BIN_PATH, [testFlag, targetPath], { timeout: timeoutMs }, (err) => {
      resolve(!err);
    });
  });
}

function probeLocalPath(filePath, timeoutMs = 1200) {
  return new Promise((resolve) => {
    if (!filePath || !path.isAbsolute(filePath)) return resolve(false);
    try {
      resolve(fs.existsSync(filePath));
    } catch (_) {
      probePathWithTest(filePath, '-e', timeoutMs).then(resolve).catch(() => resolve(false));
    }
  });
}

// ─── Find ffmpeg binary ─────────────────────────────────────────────────────
function findFfmpeg() {
  try {
    const ffmpegStatic = require('ffmpeg-static');
    if (ffmpegStatic && fs.existsSync(ffmpegStatic)) return ffmpegStatic;
  } catch (_) {}
  const candidates = [
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/usr/bin/ffmpeg',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'ffmpeg';
}

const FFMPEG_PATH = findFfmpeg();

function formatWriteLimitError(err, contextLabel = 'This operation') {
  const message = String(err?.message || '');
  const signal = String(err?.signal || '');
  const numericCode = typeof err?.code === 'number' ? err.code : NaN;
  const stringCode = typeof err?.code === 'string' ? err.code : '';
  const hitLimit = signal === 'SIGXFSZ'
    || numericCode === 153
    || stringCode === 'EFBIG'
    || /SIGXFSZ|EFBIG|file too large|file size limit/i.test(message);
  if (!hitLimit) return null;
  return `${contextLabel} hit a file-size/write limit. Try a normal local folder like Desktop or Movies.`;
}

// ─── Inject DB into renderer ────────────────────────────────────────────────
// Background-fetch all transcript segments for processed items that lack local
// transcripts. This makes search work on fresh installs after team config sync.
async function hydrateTranscripts(db, dbPath) {
  if (!supabaseClient || !supabaseClient.isInitialized()) return;
  const nowMs = Date.now();
  const candidates = Object.entries(db.content_items || {}).filter(([, item]) => {
    if (!item?.processed_at) return false;
    if (item.transcript?.segments?.length) return false;
    if (!item.transcript_sync_checked_at) return true;
    const lastCheckedMs = Date.parse(item.transcript_sync_checked_at);
    return Number.isNaN(lastCheckedMs) || (nowMs - lastCheckedMs) >= TRANSCRIPT_SYNC_RETRY_MS;
  });
  if (!candidates.length) return;
  console.log(`[RadioVault] Checking cloud transcripts for ${candidates.length} items...`);
  const sendStatus = (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.executeJavaScript(
        `document.getElementById('status-left').textContent = ${JSON.stringify(msg)};`
      ).catch(() => {});
    }
  };
  sendStatus(`Checking cloud transcripts: 0/${candidates.length}...`);
  let checked = 0;
  let hydrated = 0;
  let missing = 0;
  let changed = false;
  for (const [id] of candidates) {
    try {
      const [itemData, segments, keyMoments] = await Promise.all([
        supabaseClient.fetchContentItem(id),
        supabaseClient.fetchTranscriptSegments(id),
        supabaseClient.fetchKeyMoments(id),
      ]);
      db.content_items[id].transcript_sync_checked_at = new Date().toISOString();
      if (segments && segments.length) {
        db.content_items[id].transcript = {
          full_text: itemData?.transcript_text || '',
          segments,
        };
        if (keyMoments && keyMoments.length) db.content_items[id].key_moments = keyMoments;
        if (itemData?.summary && !db.content_items[id].summary) db.content_items[id].summary = itemData.summary;
        db.content_items[id].transcript_sync_state = 'hydrated';
        hydrated++;
      } else {
        db.content_items[id].transcript_sync_state = 'missing';
        missing++;
      }
      changed = true;
    } catch (err) {
      console.error(`[RadioVault] Hydrate error for ${id}:`, err.message);
    }
    checked++;
    sendStatus(`Checking cloud transcripts: ${checked}/${candidates.length}...${hydrated ? ` (${hydrated} synced)` : ''}`);
  }
  if (changed) {
    await atomicWriteJsonAsync(dbPath, db);
  }
  if (hydrated) {
    injectDbIntoRenderer(db);
    console.log(`[RadioVault] Hydrated ${hydrated}/${candidates.length} transcripts`);
  }
  if (hydrated) {
    sendStatus(
      missing
        ? `${hydrated} transcripts synced, ${missing} still unavailable`
        : `${hydrated} transcripts synced -- search ready`
    );
  } else {
    sendStatus('Checked cloud transcripts -- none available to sync right now');
  }
}

function getTranscriptParts(item) {
  if (!item?.transcript || typeof item.transcript !== 'object') {
    return { fullText: typeof item?.transcript === 'string' ? item.transcript : '', segments: [] };
  }
  return {
    fullText: item.transcript.full_text || '',
    segments: Array.isArray(item.transcript.segments) ? item.transcript.segments : [],
  };
}

// Strip full transcript objects to keep the payload small. Transcripts are
// fetched on demand via read-transcript IPC when opening an episode.
function lightweightDb(db) {
  const lite = { ...db, content_items: {} };
  for (const [id, item] of Object.entries(db.content_items || {})) {
    const { transcript, ...rest } = item;
    // Keep transcript segments for search, but drop full_text (the big string)
    if (transcript?.segments) {
      rest.transcript = { segments: transcript.segments };
    }
    lite.content_items[id] = rest;
  }
  return lite;
}

function injectDbIntoRenderer(db) {
  cachedDb = db;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const serializedDb = serializeForRenderer(lightweightDb(db));
  mainWindow.webContents.executeJavaScript(`
    (function() {
      try {
        window.DB = ${serializedDb};
        if (typeof renderSidebar === 'function') renderSidebar();
        if (typeof renderContent === 'function') renderContent();
        if (typeof updateStats === 'function') updateStats();
      } catch(e) { console.error('[RadioVault] DB inject error:', e); }
    })();
  `).catch(() => {});
}

// ─── Background Supabase sync ──────────────────────────────────────────────
async function syncRemoteInBackground() {
  try {
    const remoteDb = await fetchRemoteDB();
    if (!remoteDb) return;

    const dbPath = getDbPath();
    const merged = mergeDbForRenderer(remoteDb, cachedDb);

    // Skip re-render if data hasn't changed
    const remoteItemCount = Object.keys(merged.content_items || {}).length;
    const cachedItemCount = Object.keys((cachedDb || {}).content_items || {}).length;
    const remoteClipCount = (merged.clips || []).length;
    const cachedClipCount = ((cachedDb || {}).clips || []).length;
    const changed = remoteItemCount !== cachedItemCount || remoteClipCount !== cachedClipCount;

    await atomicWriteJsonAsync(dbPath, merged);

    if (changed) {
      injectDbIntoRenderer(merged);
      console.log(`[RadioVault] Background sync complete -- re-rendered (${remoteItemCount} items, ${remoteClipCount} clips)`);
    } else {
      cachedDb = merged;
      console.log('[RadioVault] Background sync complete -- no changes, skipped re-render');
    }

    // Hydrate transcripts in background so search works
    hydrateTranscripts(merged, dbPath).catch(() => {});
  } catch (err) {
    console.error('[RadioVault] Background sync failed:', err.message);
  }
}

// ─── Create window ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'RadioVault',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // Show onboarding until a team config has been loaded (Supabase configured)
  let startPage = 'onboarding.html';
  try {
    const s = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    if (s._setup_complete && s.team_name) startPage = 'app.html';
  } catch (_) {}
  mainWindow.loadFile(startPage);

  // Fullscreen header padding
  mainWindow.on('enter-full-screen', () => {
    mainWindow.webContents.executeJavaScript(
      "document.documentElement.classList.add('is-fullscreen')"
    ).catch(() => {});
  });
  mainWindow.on('leave-full-screen', () => {
    mainWindow.webContents.executeJavaScript(
      "document.documentElement.classList.remove('is-fullscreen')"
    ).catch(() => {});
  });

  // After page loads: inject DB immediately from cache or disk, then sync in background
  mainWindow.webContents.on('did-finish-load', async () => {
    const currentURL = mainWindow.webContents.getURL();
    const isAppPage = currentURL.includes('app.html');

    // Fast path: inject cached or local DB immediately
    if (cachedDb) {
      if (isAppPage) injectDbIntoRenderer(cachedDb);
    } else {
      try {
        const dbPath = getDbPath();
        const raw = await fs.promises.readFile(dbPath, 'utf8');
        const localDb = JSON.parse(raw);
        if (isAppPage) injectDbIntoRenderer(localDb);
      } catch (_) {}
    }

    // Background sync -- don't block navigation
    syncRemoteInBackground().catch(() => {});
  });
}

app.whenReady().then(() => {
  createWindow();
  checkForUpdates();
});

// ─── Auto-updates ──────────────────────────────────────────────────────────
function checkForUpdates() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', (info) => {
    console.log(`[RadioVault] Update available: v${info.version}`);
    safeSend('feed-progress', `Update v${info.version} downloading...`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[RadioVault] Update downloaded: v${info.version}`);
    dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Update Ready',
      message: `RadioVault v${info.version} is ready. Restart now to update.`,
      buttons: ['Restart', 'Later'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) autoUpdater.quitAndInstall();
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[RadioVault] Auto-update error:', err.message);
  });

  autoUpdater.checkForUpdates().catch(() => {});
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ─── IPC: Check if ffmpeg is available ──────────────────────────────────────
ipcMain.handle('check-ffmpeg', async () => {
  return new Promise((resolve) => {
    execFile(FFMPEG_PATH, ['-version'], (err, stdout) => {
      if (err) {
        resolve({ available: false, error: err.message });
      } else {
        resolve({ available: true, version: stdout.split('\n')[0] });
      }
    });
  });
});

// ─── IPC: File dialogs ──────────────────────────────────────────────────────
ipcMain.handle('open-folder-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Folder',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('open-audio-dialog', async () => {
  const result = await dialog.showOpenDialog({
    title: 'Import Audio',
    defaultPath: app.getPath('home'),
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'aiff', 'flac', 'aac', 'm4a', 'ogg'] }
    ],
    properties: ['openFile', 'multiSelections']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths.map(fp => ({
    path: fp,
    name: path.basename(fp),
    size: fs.statSync(fp).size
  }));
});

ipcMain.handle('save-audio-dialog', async (event, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Audio Clip',
    defaultPath: path.join(app.getPath('desktop'), defaultName),
    filters: [{ name: 'MP3 Audio', extensions: ['mp3'] }]
  });
  if (result.canceled) return null;
  return result.filePath;
});

// ─── IPC: Cut audio with ffmpeg ─────────────────────────────────────────────
ipcMain.handle('cut-audio', async (event, { inputPath, startTime, endTime, outputPath }) => {
  return new Promise((resolve) => {
    const clipDuration = Math.max(0, Number(endTime) - Number(startTime));
    const ext = path.extname(outputPath).toLowerCase();
    const codecArgs = ext === '.wav' ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'libmp3lame', '-b:a', '192k'];
    const args = [
      '-y',
      '-ss', String(startTime),
      '-i', inputPath,
      '-t', String(clipDuration),
      ...codecArgs,
      outputPath
    ];

    console.log(`[ffmpeg] Cutting audio: ${startTime}s -> ${endTime}s`);
    const startMs = Date.now();

    execFile(FFMPEG_PATH, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
      if (err) {
        resolve({ success: false, error: formatWriteLimitError(err, 'Clip export') || (err.message + '\n' + stderr) });
      } else {
        const stats = fs.statSync(outputPath);
        resolve({ success: true, outputPath, fileSize: stats.size, elapsed });
      }
    });
  });
});

// ─── IPC: Get audio info ────────────────────────────────────────────────────
ipcMain.handle('get-audio-info', async (event, filePath) => {
  const ffprobePath = FFMPEG_PATH.replace('ffmpeg', 'ffprobe');
  return new Promise((resolve) => {
    execFile(ffprobePath, [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
    ], (err, stdout) => {
      if (err) resolve(null);
      else {
        try { resolve(JSON.parse(stdout)); }
        catch (_) { resolve(null); }
      }
    });
  });
});

// ─── IPC: Reveal in Finder ─────────────────────────────────────────────────
ipcMain.handle('reveal-in-finder', async (event, filePath) => {
  shell.showItemInFolder(filePath);
});

ipcMain.handle('open-external-url', async (event, url) => {
  if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
    shell.openExternal(url);
    return { success: true };
  }
  return { success: false, error: 'Invalid URL' };
});

// ─── IPC: Settings ──────────────────────────────────────────────────────────
ipcMain.handle('read-settings', async () => {
  try {
    const raw = await fs.promises.readFile(SETTINGS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('[Settings] Read error:', e.message);
    return null;
  }
});

ipcMain.handle('write-settings', async (event, settings) => {
  try {
    await fs.promises.writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
    return { success: true };
  } catch (e) {
    console.error('[Settings] Write error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('read-db', async () => {
  if (cachedDb) return cachedDb;
  try {
    const dbPath = getDbPath();
    const raw = await fs.promises.readFile(dbPath, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
});

// ─── IPC: Keychain (Anthropic) ──────────────────────────────────────────────
ipcMain.handle('has-anthropic-key', async () => {
  if (!keytar) return null;
  try { return !!(await keytar.getPassword(KEYCHAIN_SERVICE, ANTHROPIC_KEY_ACCOUNT)); } catch { return null; }
});

ipcMain.handle('set-anthropic-key', async (event, value) => {
  if (!keytar) return false;
  try { await keytar.setPassword(KEYCHAIN_SERVICE, ANTHROPIC_KEY_ACCOUNT, value); return true; } catch { return false; }
});

ipcMain.handle('clear-anthropic-key', async () => {
  if (!keytar) return false;
  try { return await keytar.deletePassword(KEYCHAIN_SERVICE, ANTHROPIC_KEY_ACCOUNT); } catch { return false; }
});

// ─── IPC: Keychain (Groq) ──────────────────────────────────────────────────
ipcMain.handle('has-groq-key', async () => {
  if (!keytar) return null;
  try { return !!(await keytar.getPassword(KEYCHAIN_SERVICE, GROQ_KEY_ACCOUNT)); } catch { return null; }
});

ipcMain.handle('set-groq-key', async (event, value) => {
  if (!keytar) return false;
  try { await keytar.setPassword(KEYCHAIN_SERVICE, GROQ_KEY_ACCOUNT, value); return true; } catch { return false; }
});

ipcMain.handle('clear-groq-key', async () => {
  if (!keytar) return false;
  try { return await keytar.deletePassword(KEYCHAIN_SERVICE, GROQ_KEY_ACCOUNT); } catch { return false; }
});

// ─── IPC: Keychain (Supabase) ───────────────────────────────────────────────
ipcMain.handle('has-supabase-key', async () => {
  if (!keytar) return null;
  try {
    const url = await keytar.getPassword(KEYCHAIN_SERVICE, SUPABASE_URL_ACCOUNT);
    const key = await keytar.getPassword(KEYCHAIN_SERVICE, SUPABASE_KEY_ACCOUNT);
    return !!(url && key);
  } catch { return null; }
});

ipcMain.handle('set-supabase-key', async (event, { url, key }) => {
  if (!keytar) return false;
  try {
    await keytar.setPassword(KEYCHAIN_SERVICE, SUPABASE_URL_ACCOUNT, url);
    await keytar.setPassword(KEYCHAIN_SERVICE, SUPABASE_KEY_ACCOUNT, key);
    supabaseClient.init(url, key);
    return true;
  } catch { return false; }
});

ipcMain.handle('clear-supabase-key', async () => {
  if (!keytar) return false;
  try {
    await keytar.deletePassword(KEYCHAIN_SERVICE, SUPABASE_URL_ACCOUNT);
    await keytar.deletePassword(KEYCHAIN_SERVICE, SUPABASE_KEY_ACCOUNT);
    return true;
  } catch { return false; }
});

// ─── IPC: Team config ─────────────────────────────────────────────────────
ipcMain.handle('load-team-config', async () => {
  try {
    const result = await dialog.showOpenDialog({
      title: 'Import Team Config',
      defaultPath: app.getPath('home'),
      filters: [{ name: 'Team Config', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return { ok: false, msg: 'Cancelled' };

    const raw = fs.readFileSync(result.filePaths[0], 'utf8');
    const config = JSON.parse(raw);

    if (!config.team_name) return { ok: false, msg: 'Missing team_name in config file.' };
    if (!config.supabase_url || !config.supabase_service_key) {
      return { ok: false, msg: 'Missing supabase_url or supabase_service_key in config file.' };
    }
    if (!keytar) return { ok: false, msg: 'Keychain not available.' };

    await keytar.setPassword(KEYCHAIN_SERVICE, SUPABASE_URL_ACCOUNT, config.supabase_url);
    await keytar.setPassword(KEYCHAIN_SERVICE, SUPABASE_KEY_ACCOUNT, config.supabase_service_key);
    supabaseClient.init(config.supabase_url, config.supabase_service_key);

    const settingsData = getSettings();
    settingsData.team_name = config.team_name;
    settingsData._setup_complete = true;
    if (config.feed_urls && config.feed_urls.length) settingsData.feed_urls = config.feed_urls;
    if (config.ingestion) settingsData.ingestion = { ...(settingsData.ingestion || {}), ...sanitizeIngestionConfig(config.ingestion) };
    if (config.shared_media_path) settingsData.shared_media_path = config.shared_media_path;
    await atomicWriteJsonAsync(SETTINGS_PATH, settingsData);

    try { await supabaseClient.testConnection(); }
    catch (e) { return { ok: false, msg: 'Credentials saved but connection failed: ' + e.message }; }

    // Auto-sync from Supabase to pull team data
    try {
      const networkDB = await supabaseClient.fetchFullDb();
      if (networkDB) {
        const dbPath = getDbPath();
        let localDb = null;
        try { localDb = JSON.parse(await fs.promises.readFile(dbPath, 'utf8')); } catch (_) {}
        const mergedDb = mergeDbForRenderer(networkDB, localDb);
        mergedDb.shows = deriveShows(mergedDb.content_items);
        await atomicWriteJsonAsync(dbPath, mergedDb);
        injectDbIntoRenderer(mergedDb);
        // Hydrate transcripts in background so search works immediately
        hydrateTranscripts(mergedDb, dbPath).catch(() => {});
      }
    } catch (_) {}

    const loaded = ['supabase'];
    if (config.feed_urls?.length) loaded.push(`${config.feed_urls.length} feeds`);
    const skippedPersonalKeys = !!(config.groq_api_key || config.anthropic_api_key || config.ingestion?.groq_api_key || config.ingestion?.anthropic_api_key);
    return {
      ok: true,
      msg: 'Team "' + config.team_name + '" configured. Loaded: ' + loaded.join(', ') + '. Synced from cloud.'
        + (skippedPersonalKeys ? ' Personal API keys were not imported; add your own in Settings.' : '')
    };
  } catch (e) {
    return { ok: false, msg: 'Error: ' + e.message };
  }
});

ipcMain.handle('export-team-config', async () => {
  try {
    if (!keytar) return { ok: false, msg: 'Keychain not available.' };
    const settingsData = getSettings();
    const url = await keytar.getPassword(KEYCHAIN_SERVICE, SUPABASE_URL_ACCOUNT);
    const key = await keytar.getPassword(KEYCHAIN_SERVICE, SUPABASE_KEY_ACCOUNT);

    if (!url || !key) return { ok: false, msg: 'No Supabase credentials to export.' };

    const config = {
      team_name: settingsData.team_name || 'My Team',
      supabase_url: url,
      supabase_service_key: key,
      feed_urls: settingsData.feed_urls || [],
      ingestion: sanitizeIngestionConfig(settingsData.ingestion),
      shared_media_path: settingsData.shared_media_path || null,
    };

    const savePath = await dialog.showSaveDialog({
      title: 'Export Team Config',
      defaultPath: path.join(app.getPath('desktop'), 'radiovault-team.json'),
      filters: [{ name: 'Team Config', extensions: ['json'] }]
    });
    if (savePath.canceled) return { ok: false, msg: 'Cancelled' };

    await fs.promises.writeFile(savePath.filePath, JSON.stringify(config, null, 2), 'utf8');
    return { ok: true, msg: 'Team config exported to ' + path.basename(savePath.filePath) };
  } catch (e) {
    return { ok: false, msg: 'Error: ' + e.message };
  }
});

ipcMain.handle('test-supabase-connection', async () => {
  try {
    if (!supabaseClient.isInitialized()) {
      const ok = await initSupabase();
      if (!ok) return { ok: false, msg: 'Supabase credentials not configured. Add your Supabase URL and service key in Settings.' };
    }
    await supabaseClient.testConnection();
    return { ok: true, msg: 'Connected to Supabase' };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
});

ipcMain.handle('sync-supabase', async () => {
  try {
    if (!supabaseClient.isInitialized()) {
      const ok = await initSupabase();
      if (!ok) return { ok: false, msg: 'Supabase not configured' };
    }
    const networkDB = await supabaseClient.fetchFullDb();
    if (!networkDB) return { ok: false, msg: 'No data returned from Supabase' };

    let localDb = cachedDb;
    if (!localDb) {
      try {
        localDb = JSON.parse(await fs.promises.readFile(getDbPath(), 'utf8'));
      } catch (_) {}
    }

    const mergedDb = mergeDbForRenderer(networkDB, localDb);
    await atomicWriteJsonAsync(getDbPath(), mergedDb);
    injectDbIntoRenderer(mergedDb);

    // Push local data to Supabase (batch upsert for speed)
    let pushMsg = '';
    try {
      const localItems = Object.values((localDb?.content_items) || (mergedDb.content_items || {}));
      const toPush = localItems.filter(item => !networkDB.content_items?.[item.id]);
      let pushedItems = 0;
      let pushedTranscriptSets = 0;
      let pushedKeyMomentSets = 0;

      // Batch upsert content items in chunks of 100
      for (let i = 0; i < toPush.length; i += 100) {
        const batch = toPush.slice(i, i + 100).map(item => ({
          id: item.id,
          title: item.title || 'Untitled',
          show_name: item.show_name || null,
          content_type: item.content_type || 'radio_broadcast',
          media_type: item.media_type || 'audio',
          season: item.season || null,
          episode: item.episode || null,
          date: item.date || null,
          description: item.description || null,
          audio_url: item.audio_url || null,
          feed_url: item.feed_url || null,
          episode_guid: item.episode_guid || null,
          file_size: item.file_size || null,
          duration: item.duration ? parseInt(item.duration, 10) : null,
          clip_count: item.clip_count || 0,
          topics_found: Array.isArray(item.topics_found) ? item.topics_found.length : (item.topics_found || 0),
          summary: item.summary || null,
          processed_at: item.processed_at || null,
          transcript_text: item.transcript ? (typeof item.transcript === 'string' ? item.transcript : (item.transcript.full_text || null)) : null,
        }));
        await supabaseClient.getClient().from('content_items').upsert(batch, { onConflict: 'id' });
        pushedItems += batch.length;
        safeSend('feed-progress', `Syncing: pushed ${pushedItems}/${toPush.length} episodes...`);
      }

      const transcriptBackfillItems = localItems.filter(item => {
        if (!item?.processed_at) return false;
        const { fullText, segments } = getTranscriptParts(item);
        return !!(item.summary || segments.length || (item.key_moments && item.key_moments.length) || fullText);
      });

      for (let i = 0; i < transcriptBackfillItems.length; i++) {
        const item = transcriptBackfillItems[i];
        const { fullText, segments } = getTranscriptParts(item);
        safeSend('feed-progress', `Syncing: backfilling transcripts ${i + 1}/${transcriptBackfillItems.length}...`);
        await supabaseClient.upsertContentItem(item);
        if (segments.length) {
          await supabaseClient.pushTranscript(item.id, fullText, segments);
          pushedTranscriptSets++;
        }
        if (item.key_moments && item.key_moments.length) {
          await supabaseClient.pushKeyMoments(item.id, item.key_moments);
          pushedKeyMomentSets++;
        }
      }

      const localClips = mergedDb.clips || [];
      const remoteClipCount = (networkDB.clips || []).length;
      if (localClips.length > remoteClipCount) {
        await supabaseClient.getClient().from('clips').delete().neq('id', 0);
        for (let i = 0; i < localClips.length; i += 100) {
          const batch = localClips.slice(i, i + 100).map(c => ({
            content_item_id: c.content_item_id || null,
            content_title: c.content_title || null,
            show_name: c.show_name || null,
            content_type: c.content_type || null,
            date: c.date || null,
            keyword: c.keyword || null,
            category: c.category || null,
            timestamp_start: c.timestamp_start ?? null,
            timestamp_end: c.timestamp_end ?? null,
            quote: c.quote || null,
            teaser_score: c.teaser_score ?? null,
            source_reason: c.source_reason || 'keyword',
          }));
          await supabaseClient.getClient().from('clips').insert(batch);
        }
      }

      if (mergedDb.tags && Object.keys(mergedDb.tags).length) {
        await supabaseClient.upsertTags(mergedDb.tags);
      }

      if (pushedItems > 0) pushMsg = ` | Pushed ${pushedItems} items`;
      if (pushedTranscriptSets > 0) pushMsg += `${pushMsg ? ',' : ' |'} ${pushedTranscriptSets} transcript sets`;
      if (pushedKeyMomentSets > 0) pushMsg += `${pushMsg ? ',' : ' |'} ${pushedKeyMomentSets} key-moment sets`;
      if (localClips.length > remoteClipCount) pushMsg += `, ${localClips.length} clips`;
    } catch (pushErr) {
      pushMsg = ` | Push warning: ${pushErr.message}`;
    }


    const itemCount = Object.keys(mergedDb.content_items || {}).length;
    const clipCount = (mergedDb.clips || []).length;
    return { ok: true, msg: `Synced ${itemCount} items and ${clipCount} clips${pushMsg}` };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
});

// ─── IPC: RSS feed management ───────────────────────────────────────────────
ipcMain.handle('refresh-feeds', async () => {
  try {
    const settings = getSettings();
    const feedUrls = settings.feed_urls || [];
    if (!feedUrls.length) {
      return { success: false, error: 'No feeds configured. Add an RSS feed URL in Settings.' };
    }

    const dbPath = getDbPath();
    let db = safeReadJson(dbPath, EMPTY_DB);

    const existingIds = new Set(Object.keys(db.content_items || {}));
    let totalNew = 0;
    const feedResults = [];

    for (const feedUrl of feedUrls) {
      try {
        mainWindow?.webContents.send('feed-progress', `Fetching ${feedUrl}...`);
        const { feed, newEpisodes } = await feeds.discoverEpisodes(feedUrl, existingIds);

        for (const ep of newEpisodes) {
          db.content_items[ep.id] = { ...(db.content_items[ep.id] || {}), ...ep };
          existingIds.add(ep.id);
        }

        totalNew += newEpisodes.length;
        feedResults.push({ url: feedUrl, title: feed.title, newCount: newEpisodes.length });
        mainWindow?.webContents.send('feed-progress', `${feed.title}: ${newEpisodes.length} new episode(s)`);
      } catch (err) {
        feedResults.push({ url: feedUrl, error: err.message });
        mainWindow?.webContents.send('feed-progress', `Error fetching ${feedUrl}: ${err.message}`);
      }
    }

    db.shows = deriveShows(db.content_items);
    db.last_updated = new Date().toISOString();
    await atomicWriteJsonAsync(dbPath, db);
    injectDbIntoRenderer(db);

    return { success: true, totalNew, feeds: feedResults, totalItems: Object.keys(db.content_items).length };
  } catch (err) {
    console.error('[RadioVault] Feed refresh error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('download-episode', async (event, itemId) => {
  try {
    const dbPath = getDbPath();
    const db = safeReadJson(dbPath, EMPTY_DB);
    const item = db.content_items?.[itemId];
    if (!item) return { success: false, error: 'Episode not found' };
    if (!item.audio_url) return { success: false, error: 'No audio URL for this episode' };

    if (item.file_path && fs.existsSync(item.file_path)) {
      return { success: true, filePath: item.file_path, cached: true };
    }

    const workspace = getWorkspacePaths();
    safeSend('download-progress', { itemId, percent: 0, status: 'downloading' });

    const localPath = await feeds.downloadEpisode(item.audio_url, workspace.audioCacheDir, itemId, (progress) => {
      safeSend('download-progress', { itemId, ...progress, status: 'downloading' });
    });

    db.content_items[itemId].file_path = localPath;
    db.content_items[itemId].file_size = fs.statSync(localPath).size;
    await atomicWriteJsonAsync(dbPath, db);
    injectDbIntoRenderer(db);

    safeSend('download-progress', { itemId, percent: 100, status: 'complete' });
    return { success: true, filePath: localPath };
  } catch (err) {
    safeSend('download-progress', { itemId, status: 'error', error: err.message });
    return { success: false, error: err.message };
  }
});

function safeSend(channel, data) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  } catch (_) {}
}

ipcMain.handle('batch-download', async (event, itemIds) => {
  if (!Array.isArray(itemIds) || itemIds.length === 0) {
    return { success: false, error: 'No items to download' };
  }
  if (itemIds.length > 5000) {
    return { success: false, error: `Too many items (${itemIds.length}). Filter to a smaller set first.` };
  }

  const dbPath = getDbPath();
  const workspace = getWorkspacePaths();
  const db = safeReadJson(dbPath, EMPTY_DB);
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < itemIds.length; i++) {
    const itemId = itemIds[i];
    const item = db.content_items?.[itemId];
    if (!item || !item.audio_url) { skipped++; continue; }
    if (item.file_path && fs.existsSync(item.file_path)) { skipped++; continue; }

    safeSend('download-progress', {
      itemId, batch: true, current: i + 1, total: itemIds.length, percent: 0, status: 'downloading',
    });

    try {
      const localPath = await feeds.downloadEpisode(item.audio_url, workspace.audioCacheDir, itemId, (progress) => {
        safeSend('download-progress', {
          itemId, batch: true, current: i + 1, total: itemIds.length, percent: progress.percent, status: 'downloading',
        });
      });

      db.content_items[itemId].file_path = localPath;
      db.content_items[itemId].file_size = fs.statSync(localPath).size;
      downloaded++;

      // Save to disk every 10 downloads (not every single one)
      if (downloaded % 10 === 0) await atomicWriteJsonAsync(dbPath, db);

      await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      if (err.message && err.message.includes('403')) {
        safeSend('download-progress', {
          itemId, batch: true, current: i + 1, total: itemIds.length, status: 'downloading',
          error: 'Rate limited -- waiting 30s...',
        });
        await new Promise(r => setTimeout(r, 30000));
        // Retry once
        try {
          const retryPath = await feeds.downloadEpisode(item.audio_url, workspace.audioCacheDir, itemId);
          db.content_items[itemId].file_path = retryPath;
          db.content_items[itemId].file_size = fs.statSync(retryPath).size;
          downloaded++;
          await new Promise(r => setTimeout(r, 3000));
          continue;
        } catch (_) {}
        failed++;
      } else {
        failed++;
      }
      safeSend('download-progress', {
        itemId, batch: true, current: i + 1, total: itemIds.length, status: 'error', error: err.message,
      });
    }
  }

  // Final save
  await atomicWriteJsonAsync(dbPath, db);
  injectDbIntoRenderer(db);

  return { success: true, downloaded, skipped, failed, total: itemIds.length };
});

ipcMain.handle('add-feed', async (event, url) => {
  try {
    // Validate by fetching
    const xml = await feeds.fetchUrl(url);
    const { feed } = feeds.parseFeed(xml);

    const settings = getSettings();
    if (!settings.feed_urls) settings.feed_urls = [];
    if (!settings.feed_urls.includes(url)) {
      settings.feed_urls.push(url);
      await atomicWriteJsonAsync(SETTINGS_PATH, settings);
    }

    return { success: true, feed };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('remove-feed', async (event, url) => {
  const settings = getSettings();
  settings.feed_urls = (settings.feed_urls || []).filter(u => u !== url);
  await atomicWriteJsonAsync(SETTINGS_PATH, settings);
  return { success: true };
});

ipcMain.handle('get-feed-list', async () => {
  const settings = getSettings();
  return settings.feed_urls || [];
});

// ─── IPC: Scrape The Roar archive ───────────────────────────────────────────
ipcMain.handle('scrape-roar-archive', async (event, maxPages) => {
  try {
    const dbPath = getDbPath();
    let db = safeReadJson(dbPath, EMPTY_DB);

    const existingIds = new Set(Object.keys(db.content_items || {}));

    const { newEpisodes, pagesScraped } = await feeds.scrapeRoarArchive(existingIds, {
      maxPages: maxPages || 750,
      onProgress: (msg) => {
        try { mainWindow?.webContents.send('feed-progress', msg); } catch (_) {}
      },
    });

    for (const ep of newEpisodes) {
      db.content_items[ep.id] = { ...(db.content_items[ep.id] || {}), ...ep };
    }

    db.shows = deriveShows(db.content_items);
    db.last_updated = new Date().toISOString();
    await atomicWriteJsonAsync(dbPath, db);
    injectDbIntoRenderer(db);

    return {
      success: true,
      newCount: newEpisodes.length,
      pagesScraped,
      totalItems: Object.keys(db.content_items).length,
    };
  } catch (err) {
    console.error('[RadioVault] Scrape error:', err.message);
    return { success: false, error: err.message };
  }
});

// ─── IPC: Manually add a local audio file ──────────────────────────────────
ipcMain.handle('add-item', async (event, arg) => {
  try {
    const filePath = typeof arg === 'string' ? arg : arg.filePath;
    const showNameOverride = typeof arg === 'object' ? arg.showName : null;
    const filename = path.basename(filePath);
    const stats = fs.statSync(filePath);
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
    const id = `radio_local_${hash}`;

    const dateMatch = filename.match(/(\d{8})/);
    let date = null;
    if (dateMatch) {
      const d = dateMatch[1];
      date = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    }

    const item = {
      id,
      title: path.basename(filename, path.extname(filename)).replace(/[_-]+/g, ' '),
      show_name: showNameOverride || 'Local Import',
      content_type: 'radio_broadcast',
      media_type: 'audio',
      date,
      file_path: filePath,
      file_size: stats.size,
      duration: null,
      transcript: null,
      clip_count: 0,
      topics_found: [],
      processed_at: null,
      file_modified_at: stats.mtime.toISOString(),
    };

    const dbPath = getDbPath();
    const db = safeReadJson(dbPath, EMPTY_DB);
    db.content_items[id] = item;
    db.shows = deriveShows(db.content_items);
    db.last_updated = new Date().toISOString();
    await atomicWriteJsonAsync(dbPath, db);
    injectDbIntoRenderer(db);

    return { success: true, item };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── IPC: Remove a content item ─────────────────────────────────────────────
ipcMain.handle('remove-item', async (event, itemId) => {
  try {
    const dbPath = getDbPath();
    const db = safeReadJson(dbPath, EMPTY_DB);

    if (!db.content_items[itemId]) return { success: false, error: 'Item not found' };

    delete db.content_items[itemId];
    db.clips = (db.clips || []).filter(c => c.content_item_id !== itemId);
    db.shows = deriveShows(db.content_items);
    db.last_updated = new Date().toISOString();
    await atomicWriteJsonAsync(dbPath, db);
    injectDbIntoRenderer(db);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── IPC: Update a content item's metadata ─────────────────────────────────
ipcMain.handle('update-item', async (event, { itemId, updates }) => {
  try {
    const dbPath = getDbPath();
    const db = safeReadJson(dbPath, EMPTY_DB);
    if (!db.content_items[itemId]) return { success: false, error: 'Item not found' };

    const allowed = ['title', 'show_name', 'content_type', 'season', 'episode'];
    for (const key of allowed) {
      if (key in updates) db.content_items[itemId][key] = updates[key];
    }

    for (const clip of (db.clips || [])) {
      if (clip.content_item_id !== itemId) continue;
      if ('title' in updates)        clip.content_title = updates.title;
      if ('show_name' in updates)    clip.show_name     = updates.show_name;
      if ('content_type' in updates) clip.content_type   = updates.content_type;
    }

    db.shows = deriveShows(db.content_items);
    db.last_updated = new Date().toISOString();
    await atomicWriteJsonAsync(dbPath, db);
    injectDbIntoRenderer(db);

    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── IPC: Create a manual clip (highlight-to-clip) ──────────────────────────
ipcMain.handle('create-clip', async (event, clip) => {
  try {
    const dbPath = getDbPath();
    const db = safeReadJson(dbPath, EMPTY_DB);

    const newClip = {
      content_item_id: clip.content_item_id,
      content_title:   clip.content_title || '',
      show_name:       clip.show_name || '',
      content_type:    clip.content_type || 'radio_broadcast',
      date:            clip.date || null,
      keyword:         clip.keyword || 'manual',
      category:        clip.category || 'manual',
      timestamp_start: clip.timestamp_start,
      timestamp_end:   clip.timestamp_end,
      quote:           clip.quote || '',
      teaser_score:    0,
      source_reason:   'manual',
    };

    if (!db.clips) db.clips = [];
    db.clips.push(newClip);

    // Update item clip count
    if (db.content_items[clip.content_item_id]) {
      const itemClips = db.clips.filter(c => c.content_item_id === clip.content_item_id);
      db.content_items[clip.content_item_id].clip_count = itemClips.length;
    }

    db.last_updated = new Date().toISOString();
    await atomicWriteJsonAsync(dbPath, db);
    injectDbIntoRenderer(db);

    return { success: true, clip: newClip };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// ─── IPC: Collections ───────────────────────────────────────────────────────
ipcMain.handle('get-collections', async () => {
  const dbPath = getDbPath();
  try {
    const db = safeReadJson(dbPath, EMPTY_DB);
    return db.collections || {};
  } catch (_) { return {}; }
});

ipcMain.handle('create-collection', async (event, name) => {
  const dbPath = getDbPath();
  const db = safeReadJson(dbPath, EMPTY_DB);
  if (!db.collections) db.collections = {};
  const id = 'col_' + Date.now().toString(36);
  db.collections[id] = { name, created_at: new Date().toISOString(), items: [] };
  await atomicWriteJsonAsync(dbPath, db);
  injectDbIntoRenderer(db);
  return { success: true, id };
});

ipcMain.handle('delete-collection', async (event, id) => {
  const dbPath = getDbPath();
  const db = safeReadJson(dbPath, EMPTY_DB);
  if (db.collections?.[id]) delete db.collections[id];
  await atomicWriteJsonAsync(dbPath, db);
  injectDbIntoRenderer(db);
  return { success: true };
});

ipcMain.handle('add-to-collection', async (event, { collectionId, soundbite }) => {
  const dbPath = getDbPath();
  const db = safeReadJson(dbPath, EMPTY_DB);
  if (!db.collections?.[collectionId]) return { success: false, error: 'Collection not found' };
  db.collections[collectionId].items.push({
    content_item_id: soundbite.content_item_id,
    title: soundbite.title,
    show_name: soundbite.show_name,
    date: soundbite.date,
    timestamp_start: soundbite.timestamp_start,
    timestamp_end: soundbite.timestamp_end,
    quote: soundbite.quote,
    added_at: new Date().toISOString(),
  });
  await atomicWriteJsonAsync(dbPath, db);
  injectDbIntoRenderer(db);
  return { success: true };
});

ipcMain.handle('remove-from-collection', async (event, { collectionId, index }) => {
  const dbPath = getDbPath();
  const db = safeReadJson(dbPath, EMPTY_DB);
  if (!db.collections?.[collectionId]) return { success: false };
  db.collections[collectionId].items.splice(index, 1);
  await atomicWriteJsonAsync(dbPath, db);
  injectDbIntoRenderer(db);
  return { success: true };
});

ipcMain.handle('export-collection', async (event, collectionId) => {
  const dbPath = getDbPath();
  const db = safeReadJson(dbPath, EMPTY_DB);
  const collection = db.collections?.[collectionId];
  if (!collection) return { success: false, error: 'Collection not found' };
  if (!collection.items.length) return { success: false, error: 'Collection is empty' };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose export folder for "' + collection.name + '"',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return { success: false, canceled: true };
  const outDir = result.filePaths[0];

  let exported = 0;
  let failed = 0;
  for (let i = 0; i < collection.items.length; i++) {
    const sb = collection.items[i];
    const item = db.content_items[sb.content_item_id];
    if (!item?.file_path || !fs.existsSync(item.file_path)) { failed++; continue; }

    const safeName = `${String(i + 1).padStart(3, '0')}_${(sb.quote || 'clip').slice(0, 40).replace(/[^a-zA-Z0-9 ]/g, '').trim().replace(/\s+/g, '_')}.mp3`;
    const outPath = path.join(outDir, safeName);
    const dur = Math.max(0, sb.timestamp_end - sb.timestamp_start);

    try {
      await new Promise((resolve, reject) => {
        execFile(FFMPEG_PATH, [
          '-y', '-ss', String(sb.timestamp_start), '-i', item.file_path,
          '-t', String(dur), '-c:a', 'libmp3lame', '-b:a', '192k', outPath
        ], { maxBuffer: 10 * 1024 * 1024 }, (err) => err ? reject(err) : resolve());
      });
      exported++;
    } catch (_) { failed++; }

    safeSend('download-progress', { batch: true, current: i + 1, total: collection.items.length, status: 'exporting' });
  }

  shell.openPath(outDir);
  return { success: true, exported, failed };
});

// ─── IPC: Auto-transcribe a single item ─────────────────────────────────────
ipcMain.handle('ingest-single-item', async (event, itemId) => {
  if (_ingestRunning) return { status: 'busy', msg: 'Ingestion already running' };

  const dbPath = getDbPath();
  const db = safeReadJson(dbPath, EMPTY_DB);
  const item = db.content_items?.[itemId];
  if (!item) return { status: 'error', msg: 'Item not found' };
  if (!item.file_path) return { status: 'error', msg: 'Not downloaded yet' };
  if (item.processed_at) return { status: 'already_done' };

  _ingestRunning = true;
  const sleepBlockId = powerSaveBlocker.start('prevent-app-suspension');

  try {
    const { runIngest } = require('./ingest');
    const settings = getSettings();
    const workspace = getWorkspacePaths();

    let groqApiKey = '';
    let anthropicApiKey = '';
    try {
      if (keytar) {
        groqApiKey = (await keytar.getPassword(KEYCHAIN_SERVICE, GROQ_KEY_ACCOUNT)) || '';
        anthropicApiKey = (await keytar.getPassword(KEYCHAIN_SERVICE, ANTHROPIC_KEY_ACCOUNT)) || '';
      }
    } catch (_) {}
    settings.ingestion = settings.ingestion || {};
    settings.ingestion.groq_api_key = groqApiKey;
    settings.ingestion.anthropic_api_key = anthropicApiKey;

    // Mark only this item as needing processing
    db.content_items[itemId].processed_at = null;
    await atomicWriteJsonAsync(dbPath, db);

    await runIngest({
      settings,
      dbPath: workspace.dbPath,
      cacheDir: workspace.audioCacheDir,
      ffmpegPath: FFMPEG_PATH,
      onProgress: (line) => safeSend('ingest-output', line),
      onDbUpdate: (updatedDb) => { try { safeSend('db-updated', updatedDb); } catch (_) {} },
      force: false,
      reclip: false,
      shouldCancel: () => false,
    });

    return { status: 'done' };
  } catch (err) {
    return { status: 'error', msg: err.message };
  } finally {
    powerSaveBlocker.stop(sleepBlockId);
    _ingestRunning = false;
  }
});

// ─── IPC: Ingest pipeline (transcribe + extract clips) ─────────────────────
let _ingestRunning = false;
let _cancelIngest  = false;
let _ingestLogLines = [];
let _ingestSession = {
  running: false,
  flag: '',
  startedAt: null,
  finishedAt: null,
  lastResult: null,
  cancelRequested: false,
};

function updateIngestSession(patch) {
  _ingestSession = { ..._ingestSession, ...patch };
}

function sendIngestLine(line) {
  _ingestLogLines.push(String(line));
  if (_ingestLogLines.length > 500) _ingestLogLines = _ingestLogLines.slice(-500);
  try { mainWindow?.webContents.send('ingest-output', line); } catch (_) {}
}

ipcMain.handle('get-ingest-status', async () => ({
  ..._ingestSession,
  logLines: _ingestLogLines,
}));

ipcMain.handle('run-ingest', async (event, flag) => {
  if (_ingestRunning) return { status: 'already_running' };
  _ingestRunning = true;
  _cancelIngest  = false;
  _ingestLogLines = [];
  const sleepBlockId = powerSaveBlocker.start('prevent-app-suspension');
  updateIngestSession({
    running: true,
    flag: flag || '',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    lastResult: null,
    cancelRequested: false,
  });

  try {
    const { runIngest, killActiveTranscription } = require('./ingest');
    const settings = getSettings();
    const workspace = getWorkspacePaths();

    // Pull API keys from Keychain
    let groqApiKey = '';
    let anthropicApiKey = '';
    try {
      if (keytar) {
        groqApiKey = (await keytar.getPassword(KEYCHAIN_SERVICE, GROQ_KEY_ACCOUNT)) || '';
        anthropicApiKey = (await keytar.getPassword(KEYCHAIN_SERVICE, ANTHROPIC_KEY_ACCOUNT)) || '';
      }
    } catch (_) {}
    settings.ingestion = settings.ingestion || {};
    settings.ingestion.groq_api_key = groqApiKey;
    settings.ingestion.anthropic_api_key = anthropicApiKey;

    const force = flag === '--force';
    const reclip = flag === '--reclip';

    await runIngest({
      settings,
      dbPath:       workspace.dbPath,
      cacheDir:     workspace.audioCacheDir,
      ffmpegPath:   FFMPEG_PATH,
      onProgress:   sendIngestLine,
      onDbUpdate:   (db) => {
        try { mainWindow?.webContents.send('db-updated', db); } catch (_) {}
      },
      force,
      reclip,
      shouldCancel: () => _cancelIngest,
    });

    sendIngestLine('\n--- Ingestion complete ---');
    updateIngestSession({
      running: false,
      finishedAt: new Date().toISOString(),
      lastResult: 'done',
      cancelRequested: false,
    });
    return { status: 'done' };
  } catch (err) {
    sendIngestLine(`Error: ${err.message}`);
    updateIngestSession({
      running: false,
      finishedAt: new Date().toISOString(),
      lastResult: `error:${err.message}`,
      cancelRequested: false,
    });
    return { status: 'error', error: err.message };
  } finally {
    powerSaveBlocker.stop(sleepBlockId);
    _ingestRunning = false;
    _cancelIngest  = false;
    if (_ingestSession.running) {
      updateIngestSession({
        running: false,
        finishedAt: new Date().toISOString(),
        lastResult: _ingestSession.cancelRequested ? 'cancelled' : _ingestSession.lastResult,
      });
    }
  }
});

ipcMain.handle('cancel-ingest', async () => {
  if (_ingestRunning) {
    _cancelIngest = true;
    updateIngestSession({ cancelRequested: true });
    try { const { killActiveTranscription } = require('./ingest'); killActiveTranscription(); } catch (_) {}
    sendIngestLine('Cancellation requested -- stopping transcription...');
    return { success: true };
  }
  return { success: false };
});

// ─── IPC: Check local path ─────────────────────────────────────────────────
ipcMain.handle('check-local-path', async (event, p) => {
  try { return fs.existsSync(p.replace(/^~/, os.homedir())); }
  catch (_) { return false; }
});

// ─── IPC: Read transcript ──────────────────────────────────────────────────
ipcMain.handle('read-transcript', async (event, itemId) => {
  function extractText(transcript) {
    if (!transcript) return null;
    if (typeof transcript === 'string') return transcript;
    if (typeof transcript === 'object' && transcript.full_text) return transcript.full_text;
    return null;
  }

  try {
    const dbPath = getDbPath();
    const db = safeReadJson(dbPath, EMPTY_DB);
    const item = db.content_items?.[itemId];
    const text = extractText(item?.transcript);
    if (text) return text;
  } catch (_) {}

  if (supabaseClient.isInitialized()) {
    try {
      const [itemData, segments, keyMoments] = await Promise.all([
        supabaseClient.fetchContentItem(itemId),
        supabaseClient.fetchTranscriptSegments(itemId),
        supabaseClient.fetchKeyMoments(itemId),
      ]);
      if (itemData?.transcript_text || (segments && segments.length)) {
        const transcript = {
          full_text: itemData?.transcript_text || '',
          segments: segments || [],
        };
        try {
          const dbPath = getDbPath();
          const db = safeReadJson(dbPath, EMPTY_DB);
          if (db.content_items?.[itemId]) {
            db.content_items[itemId].transcript = transcript;
            if (keyMoments && keyMoments.length) db.content_items[itemId].key_moments = keyMoments;
            if (itemData?.summary) db.content_items[itemId].summary = itemData.summary;
            await atomicWriteJsonAsync(dbPath, db);
          }
        } catch (_) {}
        return { transcript, key_moments: keyMoments || [], summary: itemData?.summary || null };
      }
    } catch (err) {
      console.error('[RadioVault] Supabase transcript fetch error:', err.message);
    }
  }
  return null;
});

ipcMain.handle('check-file-path', async (event, filePath) => {
  if (!filePath) return false;
  return fs.existsSync(filePath);
});

// ─── IPC: Cache management ──────────────────────────────────────────────────
ipcMain.handle('get-cache-size', async () => {
  try {
    const workspace = getWorkspacePaths();
    const cacheDir = workspace.audioCacheDir;
    if (!fs.existsSync(cacheDir)) {
      return {
        size: 0,
        files: 0,
        shared: workspace.usingSharedMedia,
        path: cacheDir,
      };
    }
    const files = fs.readdirSync(cacheDir).filter(f => !f.startsWith('.'));
    let totalSize = 0;
    for (const f of files) {
      try { totalSize += fs.statSync(path.join(cacheDir, f)).size; } catch (_) {}
    }
    return {
      size: totalSize,
      files: files.length,
      shared: workspace.usingSharedMedia,
      path: cacheDir,
    };
  } catch (_) {
    return { size: 0, files: 0, shared: false, path: null };
  }
});

ipcMain.handle('clear-audio-cache', async () => {
  try {
    const workspace = getWorkspacePaths();
    const cacheDir = workspace.audioCacheDir;
    if (workspace.usingSharedMedia) {
      return {
        success: false,
        error: `Shared Media Path is active (${cacheDir}). Clearing it here would delete team-shared audio. Disable Shared Media Path first if you need local cache cleanup.`,
      };
    }
    if (!fs.existsSync(cacheDir)) return { success: true, freed: 0 };

    const dbPath = getDbPath();
    const db = safeReadJson(dbPath, EMPTY_DB);

    let freed = 0;
    const files = fs.readdirSync(cacheDir).filter(f => !f.startsWith('.'));
    for (const f of files) {
      const fp = path.join(cacheDir, f);
      try {
        freed += fs.statSync(fp).size;
        fs.unlinkSync(fp);
      } catch (_) {}
    }

    // Clear file_path references in DB for cached files
    for (const item of Object.values(db.content_items || {})) {
      if (item.file_path && isPathInside(item.file_path, cacheDir)) {
        item.file_path = null;
      }
    }
    await atomicWriteJsonAsync(dbPath, db);
    injectDbIntoRenderer(db);

    return { success: true, freed };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ─── IPC: App version ───────────────────────────────────────────────────────
ipcMain.handle('get-app-version', async () => APP_VERSION);

ipcMain.handle('check-for-updates', async () => {
  if (!autoUpdater || !app.isPackaged) return { status: 'dev', msg: 'Updates disabled in dev mode' };
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result?.updateInfo?.version !== APP_VERSION) {
      return { status: 'available', version: result.updateInfo.version };
    }
    return { status: 'up-to-date', msg: `v${APP_VERSION} is the latest` };
  } catch (err) {
    return { status: 'error', msg: err.message };
  }
});

// ─── External link safety ───────────────────────────────────────────────────
app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (url && /^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
});
