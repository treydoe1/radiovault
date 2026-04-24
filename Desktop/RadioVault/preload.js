const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ffmpeg
  checkFfmpeg: () => ipcRenderer.invoke('check-ffmpeg'),

  // File dialogs
  openAudioDialog: () => ipcRenderer.invoke('open-audio-dialog'),
  openFolderDialog: () => ipcRenderer.invoke('open-folder-dialog'),
  saveAudioDialog: (defaultName) => ipcRenderer.invoke('save-audio-dialog', defaultName),

  // Audio operations
  cutAudio: (opts) => ipcRenderer.invoke('cut-audio', opts),
  getAudioInfo: (filePath) => ipcRenderer.invoke('get-audio-info', filePath),

  // Filesystem
  revealInFinder: (filePath) => ipcRenderer.invoke('reveal-in-finder', filePath),
  checkLocalPath: (p) => ipcRenderer.invoke('check-local-path', p),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),

  // RSS feeds
  refreshFeeds: () => ipcRenderer.invoke('refresh-feeds'),
  downloadEpisode: (itemId) => ipcRenderer.invoke('download-episode', itemId),
  addFeed: (url) => ipcRenderer.invoke('add-feed', url),
  removeFeed: (url) => ipcRenderer.invoke('remove-feed', url),
  getFeedList: () => ipcRenderer.invoke('get-feed-list'),
  onFeedProgress: (cb) => ipcRenderer.on('feed-progress', (_, msg) => cb(msg)),
  offFeedProgress: () => ipcRenderer.removeAllListeners('feed-progress'),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_, data) => cb(data)),
  offDownloadProgress: () => ipcRenderer.removeAllListeners('download-progress'),
  scrapeRoarArchive: (maxPages) => ipcRenderer.invoke('scrape-roar-archive', maxPages),
  batchDownload: (itemIds) => ipcRenderer.invoke('batch-download', itemIds),

  // Settings
  readSettings: () => ipcRenderer.invoke('read-settings'),
  writeSettings: (settings) => ipcRenderer.invoke('write-settings', settings),

  // DB
  readDb: () => ipcRenderer.invoke('read-db'),
  readTranscript: (itemId) => ipcRenderer.invoke('read-transcript', itemId),

  // Content item management
  addItem: (filePath, showName) => ipcRenderer.invoke('add-item', { filePath, showName }),
  removeItem: (itemId) => ipcRenderer.invoke('remove-item', itemId),
  updateItem: (itemId, updates) => ipcRenderer.invoke('update-item', { itemId, updates }),
  createClip: (clip) => ipcRenderer.invoke('create-clip', clip),

  // Collections
  getCollections: () => ipcRenderer.invoke('get-collections'),
  createCollection: (name) => ipcRenderer.invoke('create-collection', name),
  deleteCollection: (id) => ipcRenderer.invoke('delete-collection', id),
  addToCollection: (collectionId, soundbite) => ipcRenderer.invoke('add-to-collection', { collectionId, soundbite }),
  removeFromCollection: (collectionId, index) => ipcRenderer.invoke('remove-from-collection', { collectionId, index }),
  exportCollection: (collectionId) => ipcRenderer.invoke('export-collection', collectionId),

  // Auto-transcribe
  ingestSingleItem: (itemId) => ipcRenderer.invoke('ingest-single-item', itemId),

  // Cache management
  clearAudioCache: () => ipcRenderer.invoke('clear-audio-cache'),
  getCacheSize: () => ipcRenderer.invoke('get-cache-size'),
  checkFilePath: (filePath) => ipcRenderer.invoke('check-file-path', filePath),

  // Team config
  loadTeamConfig: () => ipcRenderer.invoke('load-team-config'),
  exportTeamConfig: () => ipcRenderer.invoke('export-team-config'),

  // Keychain: Anthropic
  hasAnthropicKey: () => ipcRenderer.invoke('has-anthropic-key'),
  setAnthropicKey: (value) => ipcRenderer.invoke('set-anthropic-key', value),
  clearAnthropicKey: () => ipcRenderer.invoke('clear-anthropic-key'),

  // Keychain: Groq
  hasGroqKey: () => ipcRenderer.invoke('has-groq-key'),
  setGroqKey: (value) => ipcRenderer.invoke('set-groq-key', value),
  clearGroqKey: () => ipcRenderer.invoke('clear-groq-key'),

  // Keychain: OpenAI
  hasOpenAIKey: () => ipcRenderer.invoke('has-openai-key'),
  setOpenAIKey: (value) => ipcRenderer.invoke('set-openai-key', value),
  clearOpenAIKey: () => ipcRenderer.invoke('clear-openai-key'),

  // Keychain: custom OpenAI-compatible transcription
  hasCustomTranscriptionKey: () => ipcRenderer.invoke('has-custom-transcription-key'),
  setCustomTranscriptionKey: (value) => ipcRenderer.invoke('set-custom-transcription-key', value),
  clearCustomTranscriptionKey: () => ipcRenderer.invoke('clear-custom-transcription-key'),

  // Keychain: Supabase
  hasSupabaseKey: () => ipcRenderer.invoke('has-supabase-key'),
  setSupabaseKey: (url, key) => ipcRenderer.invoke('set-supabase-key', { url, key }),
  clearSupabaseKey: () => ipcRenderer.invoke('clear-supabase-key'),
  testSupabaseConnection: () => ipcRenderer.invoke('test-supabase-connection'),
  syncSupabase: () => ipcRenderer.invoke('sync-supabase'),

  // Ingest pipeline
  runIngest: (flag) => ipcRenderer.invoke('run-ingest', flag),
  cancelIngest: () => ipcRenderer.invoke('cancel-ingest'),
  getIngestStatus: () => ipcRenderer.invoke('get-ingest-status'),
  onIngestOutput: (cb) => ipcRenderer.on('ingest-output', (_, line) => cb(line)),
  offIngestOutput: () => ipcRenderer.removeAllListeners('ingest-output'),
  onDbUpdated: (cb) => ipcRenderer.on('db-updated', (_, db) => cb(db)),
  offDbUpdated: () => ipcRenderer.removeAllListeners('db-updated'),

  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

  isElectron: true
});
