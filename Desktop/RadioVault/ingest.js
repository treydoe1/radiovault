'use strict';
/**
 * RadioVault -- Node.js Ingest Pipeline
 * Forked from ClipVault: RSS/audio-first instead of video files.
 * Uses taxonomy.js for configurable keyword matching.
 *
 * Flow: content_items (from feeds) -> prepare audio -> transcribe -> extract clips -> AI summary -> save
 */

const fs   = require('fs');
const path = require('path');
let supabaseClient;
let _supabaseLoadError = null;
try { supabaseClient = require('./supabase'); } catch (e) {
  supabaseClient = null;
  _supabaseLoadError = e.message;
  console.error('[RadioVault] supabase.js failed to load:', e.message);
}
const os   = require('os');
const https = require('https');
const http  = require('http');
const { execFile } = require('child_process');
const { loadTaxonomy, flattenTaxonomy } = require('./taxonomy');

const TEASER_METADATA_PATH = path.join(__dirname, 'teaser_metadata.json');
const TEASER_MIN_SCORE_DEFAULT = 0.35;
const MIN_CLIP_SEC = 15;
const DEFAULT_CANDIDATE_STEP = 2;

const STOPWORDS = new Set([
  "the","a","an","and","or","of","in","on","at","to","for",
  "with","ep","episode","podcast","ft","feat","part","pt",
  "2","1","3","4","5","s","e","talks","talk","beyond","paw",
  "right","turns","clemson","tigers","football","yeah","like",
  "just","really","kind","kinda","gonna","gotta","you",
  "know","that","this","they","them","their","have","been","from",
]);

let TEASER_MODEL = null;

// ── TEXT UTILITIES ──────────────────────────────────────────────────────────

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function tokenize(text) {
  return normalize(text).split(' ').filter(w => w && !STOPWORDS.has(w) && w.length >= 3);
}

// ── TF-IDF TEASER MODEL ────────────────────────────────────────────────────

function loadTeaserModel() {
  if (TEASER_MODEL) return TEASER_MODEL;
  try {
    if (!fs.existsSync(TEASER_METADATA_PATH)) return null;
    const metadata = JSON.parse(fs.readFileSync(TEASER_METADATA_PATH, 'utf8'));
    const texts = Array.isArray(metadata?.texts) ? metadata.texts : [];
    if (!texts.length) return null;

    const docs = [];
    const docFreq = new Map();
    for (const text of texts) {
      const tokens = tokenize(text);
      const counts = new Map();
      for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
      if (!counts.size) continue;
      docs.push(counts);
      for (const token of new Set(tokens)) docFreq.set(token, (docFreq.get(token) || 0) + 1);
    }
    if (!docs.length) return null;
    TEASER_MODEL = { docs, docFreq, docCount: docs.length };
    return TEASER_MODEL;
  } catch (_) {
    return null;
  }
}

function scoreAgainstTeasers(text) {
  const model = loadTeaserModel();
  if (!model) return 0;

  const tokens = tokenize(text);
  if (!tokens.length) return 0;

  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);

  let best = 0;
  for (const doc of model.docs) {
    let overlap = 0;
    let queryWeight = 0;
    let docWeight = 0;
    for (const [token, count] of counts) {
      const idf = Math.log(1 + (model.docCount + 1) / ((model.docFreq.get(token) || 0) + 1));
      const qWeight = count * idf;
      queryWeight += qWeight;
      if (doc.has(token)) overlap += Math.min(count, doc.get(token)) * idf;
    }
    for (const [token, count] of doc) {
      const idf = Math.log(1 + (model.docCount + 1) / ((model.docFreq.get(token) || 0) + 1));
      docWeight += count * idf;
    }
    if (!queryWeight || !docWeight) continue;
    const score = overlap / Math.sqrt(queryWeight * docWeight);
    if (score > best) best = score;
  }
  return Math.max(0, Math.min(1, best));
}

// ── CLIP EXTRACTION ─────────────────────────────────────────────────────────

function buildCandidateWindows(segments) {
  const windows = [];
  for (let i = 0; i < segments.length; i += DEFAULT_CANDIDATE_STEP) {
    let si = Math.max(0, i - 1);
    let ei = Math.min(segments.length - 1, i + 2);
    let start = segments[si].start;
    let end = segments[ei].end;

    while ((end - start) < MIN_CLIP_SEC) {
      let expanded = false;
      if (si > 0) { si--; start = segments[si].start; expanded = true; }
      if ((end - start) < MIN_CLIP_SEC && ei < segments.length - 1) {
        ei++;
        end = segments[ei].end;
        expanded = true;
      }
      if (!expanded) break;
    }
    windows.push({ si, ei, start, end });
  }
  return windows;
}

function buildKeywordCandidates(segments, itemMeta, matchedTerms, taxonomyList) {
  const candidates = [];
  for (let i = 0; i < segments.length; i++) {
    const lower = segments[i].text.toLowerCase();
    for (const { keyword, category } of taxonomyList) {
      if (!lower.includes(keyword)) continue;
      matchedTerms.add(keyword);

      let si = Math.max(0, i - 1);
      let ei = Math.min(segments.length - 1, i + 2);
      let start = segments[si].start;
      let end = segments[ei].end;

      while ((end - start) < MIN_CLIP_SEC) {
        let expanded = false;
        if (si > 0) { si--; start = segments[si].start; expanded = true; }
        if ((end - start) < MIN_CLIP_SEC && ei < segments.length - 1) {
          ei++;
          end = segments[ei].end;
          expanded = true;
        }
        if (!expanded) break;
      }

      candidates.push({
        content_item_id: itemMeta.id,
        content_title:   itemMeta.title,
        show_name:       itemMeta.show_name,
        content_type:    itemMeta.content_type,
        date:            itemMeta.date,
        keyword,
        category,
        timestamp_start: start,
        timestamp_end:   end,
        quote:           segments.slice(si, ei + 1).map(s => s.text).join(' ').trim(),
        teaser_score:    0,
        source_reason:   'keyword',
      });
    }
  }
  return candidates;
}

function inferTopic(contextText, taxonomyList) {
  const lower = contextText.toLowerCase();
  for (const { keyword, category } of taxonomyList) {
    if (lower.includes(keyword)) return { category, keyword };
  }
  return { category: 'brand', keyword: 'training_set' };
}

function extractTopics(transcriptData, itemMeta, taxonomyList, { teaserThreshold = TEASER_MIN_SCORE_DEFAULT } = {}) {
  if (!transcriptData?.segments?.length) return { clips: [], matchedTerms: new Set() };

  const clips = [];
  const matchedTerms = new Set();
  const segs = transcriptData.segments;
  const teaserLoaded = !!loadTeaserModel();
  const keywordCandidates = buildKeywordCandidates(segs, itemMeta, matchedTerms, taxonomyList);

  if (teaserLoaded) {
    const seenWindows = new Set();
    for (const candidate of keywordCandidates) {
      const windowKey = `${Math.floor(candidate.timestamp_start * 10)}|${Math.floor(candidate.timestamp_end * 10)}`;
      seenWindows.add(windowKey);
      candidate.teaser_score = Number(scoreAgainstTeasers(candidate.quote).toFixed(4));
      clips.push(candidate);
    }

    for (const { si, ei, start, end } of buildCandidateWindows(segs)) {
      const quote = segs.slice(si, ei + 1).map(s => s.text).join(' ').trim();
      const windowKey = `${Math.floor(start * 10)}|${Math.floor(end * 10)}`;
      if (seenWindows.has(windowKey)) continue;
      const teaserScore = scoreAgainstTeasers(quote);
      if (teaserScore < teaserThreshold) continue;

      const topic = inferTopic(quote, taxonomyList);
      matchedTerms.add(topic.keyword);
      clips.push({
        content_item_id: itemMeta.id,
        content_title:   itemMeta.title,
        show_name:       itemMeta.show_name,
        content_type:    itemMeta.content_type,
        date:            itemMeta.date,
        keyword:         topic.keyword,
        category:        topic.category,
        timestamp_start: start,
        timestamp_end:   end,
        quote,
        teaser_score:    Number(teaserScore.toFixed(4)),
        source_reason:   'training_set',
      });
    }
  } else {
    clips.push(...keywordCandidates);
  }

  const filtered = clips.filter((clip) => {
    if (clip.source_reason === 'keyword') return true;
    return clip.teaser_score >= teaserThreshold;
  });

  // Deduplicate by keyword + time window
  const best = {};
  for (const clip of filtered) {
    const key = `${clip.content_item_id}|${clip.keyword}|${Math.floor(clip.timestamp_start / 30)}`;
    if (!best[key] || clip.teaser_score > best[key].teaser_score) best[key] = clip;
  }
  let deduped = Object.values(best);

  // Merge overlapping clips
  deduped.sort((a, b) => a.timestamp_start - b.timestamp_start);
  const merged = [];
  for (const clip of deduped) {
    const prev = merged.length ? merged[merged.length - 1] : null;
    if (prev
        && prev.content_item_id === clip.content_item_id
        && clip.timestamp_start <= prev.timestamp_end + 5) {
      if (clip.teaser_score > prev.teaser_score) {
        merged[merged.length - 1] = clip;
      }
    } else {
      merged.push(clip);
    }
  }

  return { clips: merged, matchedTerms };
}

function updateTags(db, clips, matchedTerms, taxonomyMap) {
  if (!db.tags) db.tags = {};
  for (const term of matchedTerms) {
    if (!db.tags[term] || typeof db.tags[term] !== 'object') {
      const category = Object.entries(taxonomyMap).find(([, kws]) => kws.includes(term))?.[0] || 'general';
      db.tags[term] = { term, category, clip_count: 0, item_count: 0, first_seen: null, last_seen: null, items: [] };
    }
    const entry = db.tags[term];
    if (!entry.items) entry.items = [];
    const termClips = clips.filter(c => c.keyword === term);
    const itemIds = [...new Set(termClips.map(c => c.content_item_id))];
    entry.clip_count  += termClips.length;
    entry.items        = [...new Set([...entry.items, ...itemIds])];
    entry.item_count   = entry.items.length;
    const dates = termClips.map(c => c.date).filter(Boolean);
    if (dates.length) {
      const min = dates.reduce((a, b) => a < b ? a : b);
      const max = dates.reduce((a, b) => a > b ? a : b);
      if (!entry.first_seen || min < entry.first_seen) entry.first_seen = min;
      if (!entry.last_seen  || max > entry.last_seen)  entry.last_seen  = max;
    }
  }
}

// ── AUDIO PREPARATION ──────────────────────────────────────────────────────

function safeCacheName(itemId, ext) {
  const safe = itemId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  return `${safe}${ext}`;
}

/**
 * Prepare audio for transcription.
 * For audio files: convert to 16kHz mono MP3 if needed.
 * For video files: extract audio track.
 */
function prepareAudio(filePath, cacheDir, ffmpegPath) {
  const itemId = path.basename(filePath, path.extname(filePath));
  const outPath = path.join(cacheDir, safeCacheName(itemId, '.mp3'));
  if (!outPath.startsWith(path.resolve(cacheDir))) throw new Error('Invalid cache path');
  if (fs.existsSync(outPath)) return Promise.resolve(outPath);

  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-y', '-i', filePath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-b:a', '32k',
      outPath,
    ], { timeout: 600000 }, (err) => {
      if (err) return reject(new Error(`Audio preparation failed: ${err.message}`));
      resolve(outPath);
    });
  });
}

// ── TRANSCRIPTION ───────────────────────────────────────────────────────────

const AUDIO_MIME = {
  '.mp3': 'audio/mpeg', '.mp4': 'audio/mp4', '.m4a': 'audio/mp4',
  '.webm': 'audio/webm', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

function compressForGroq(inputPath, ffmpegPath) {
  return new Promise((resolve, reject) => {
    const tmpPath = path.join(os.tmpdir(), `radiovault_compressed_${Date.now()}.mp3`);
    execFile(ffmpegPath, [
      '-y', '-i', inputPath,
      '-ar', '16000', '-ac', '1', '-b:a', '32k',
      tmpPath,
    ], { timeout: 300000 }, (err) => {
      if (err) return reject(new Error(`ffmpeg compression failed: ${err.message}`));
      resolve(tmpPath);
    });
  });
}

/**
 * Split a long audio file into chunks for Groq API transcription.
 * Returns an array of { chunkPath, offsetSeconds }.
 */
function splitAudioChunks(inputPath, ffmpegPath, chunkDurationSec = 1200) {
  return new Promise((resolve, reject) => {
    // Get duration first
    const ffprobePath = ffmpegPath.replace('ffmpeg', 'ffprobe');
    execFile(ffprobePath, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', inputPath], (err, stdout) => {
      const totalDuration = parseFloat(stdout?.trim()) || 0;
      if (totalDuration <= 0) return reject(new Error('Could not determine audio duration'));

      const chunks = [];
      let offset = 0;
      let chunkIndex = 0;

      const processNext = () => {
        if (offset >= totalDuration) return resolve(chunks);
        const chunkPath = path.join(os.tmpdir(), `radiovault_chunk_${Date.now()}_${chunkIndex}.mp3`);
        execFile(ffmpegPath, [
          '-y', '-i', inputPath,
          '-ss', String(offset),
          '-t', String(chunkDurationSec),
          '-ar', '16000', '-ac', '1', '-b:a', '64k',
          chunkPath,
        ], { timeout: 300000 }, (chunkErr) => {
          if (chunkErr) return reject(new Error(`Chunk split failed: ${chunkErr.message}`));
          chunks.push({ chunkPath, offsetSeconds: offset });
          offset += chunkDurationSec;
          chunkIndex++;
          processNext();
        });
      };

      processNext();
    });
  });
}

const DEFAULT_ENDPOINT = 'https://api.groq.com/openai/v1/audio/transcriptions';
const DEFAULT_MODEL    = 'whisper-large-v3';
const DEFAULT_TRANSCRIPTION_TIMEOUT_MS = 10 * 60 * 1000;

// ── Local MLX Whisper ──

function resolveRuntimePath(relPath, { preferUnpacked = false } = {}) {
  const devPath = path.join(__dirname, relPath);
  const resourcesPath = process.resourcesPath || '';
  const unpackedPath = resourcesPath ? path.join(resourcesPath, 'app.asar.unpacked', relPath) : '';
  const packagedPath = resourcesPath ? path.join(resourcesPath, relPath) : '';

  if (preferUnpacked && unpackedPath && fs.existsSync(unpackedPath)) return unpackedPath;
  if (fs.existsSync(devPath)) return devPath;
  if (unpackedPath && fs.existsSync(unpackedPath)) return unpackedPath;
  if (packagedPath && fs.existsSync(packagedPath)) return packagedPath;
  return preferUnpacked && unpackedPath ? unpackedPath : devPath;
}

const MLX_TRANSCRIBE_SCRIPT = resolveRuntimePath('mlx_transcribe.py', { preferUnpacked: true });
const OPENAI_WHISPER_TRANSCRIBE_SCRIPT = resolveRuntimePath('whisper_transcribe.py', { preferUnpacked: true });
const MLX_DEFAULT_MODEL = 'mlx-community/whisper-large-v3-mlx';
const MLX_MODEL_MAP = {
  'base':   'mlx-community/whisper-base-mlx',
  'small':  'mlx-community/whisper-small-mlx',
  'medium': 'mlx-community/whisper-medium-mlx',
  'large':  'mlx-community/whisper-large-v3-mlx',
};

let _activeMLXProcess = null;

function normalizeWhisperModel(model) {
  const value = String(model || 'large').trim().toLowerCase();
  if (value === 'large-v1' || value === 'large-v2' || value === 'large-v3') return 'large';
  return value || 'large';
}

function parseTranscriptionJson(stdout) {
  const json = JSON.parse(stdout);
  const segments = (json.segments || []).map(s => ({
    start: Math.round(s.start * 10) / 10,
    end:   Math.round(s.end * 10) / 10,
    text:  (s.text || '').trim(),
  }));
  return { full_text: json.text || '', segments };
}

function compactTranscriptionError(message) {
  const text = String(message || '').trim();
  if (!text) return 'Unknown error';
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 3)
    .join(' | ')
    .slice(0, 500);
}

function transcribeWithMLX(audioPath, { model = 'large', timeoutMs = 90 * 60 * 1000, onProgress, ffmpegPath } = {}) {
  const mlxModel = MLX_MODEL_MAP[model] || MLX_DEFAULT_MODEL;
  if (!fs.existsSync(MLX_TRANSCRIBE_SCRIPT)) {
    throw new Error(`Local transcription helper not found at ${MLX_TRANSCRIBE_SCRIPT}`);
  }
  onProgress?.(`  Transcribing locally with MLX Whisper (${model})...`);
  onProgress?.('  First run downloads the model (~1.5 GB for large). This is a one-time download.');

  const spawnEnv = Object.assign({}, process.env);
  if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
    spawnEnv.PATH = path.dirname(ffmpegPath) + ':' + (spawnEnv.PATH || '');
  }

  return new Promise((resolve, reject) => {
    const proc = execFile('python3', [MLX_TRANSCRIBE_SCRIPT, audioPath, '--model', mlxModel], {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      detached: true,
      env: spawnEnv,
    }, (err, stdout, stderr) => {
      _activeMLXProcess = null;
      if (err) {
        if (err.killed || err.signal === 'SIGTERM') {
          return reject(new Error('Local transcription cancelled.'));
        }
        return reject(new Error(`Local transcription failed: ${stderr?.trim() || err.message}`));
      }
      try {
        resolve(parseTranscriptionJson(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse transcription output: ${e.message}`));
      }
    });
    _activeMLXProcess = proc;
  });
}

function transcribeWithOpenAIWhisper(audioPath, { model = 'large', timeoutMs = 4 * 60 * 60 * 1000, onProgress, ffmpegPath } = {}) {
  const whisperModel = normalizeWhisperModel(model);
  if (!fs.existsSync(OPENAI_WHISPER_TRANSCRIBE_SCRIPT)) {
    throw new Error(`OpenAI Whisper helper not found at ${OPENAI_WHISPER_TRANSCRIBE_SCRIPT}`);
  }
  onProgress?.(`  Falling back to OpenAI Whisper (${whisperModel}, CPU)...`);
  onProgress?.('  This machine cannot use MLX right now, so local transcription will run on CPU and may be slower.');

  const spawnEnv = Object.assign({}, process.env);
  if (ffmpegPath && ffmpegPath !== 'ffmpeg') {
    spawnEnv.PATH = path.dirname(ffmpegPath) + ':' + (spawnEnv.PATH || '');
  }

  return new Promise((resolve, reject) => {
    const proc = execFile('python3', [OPENAI_WHISPER_TRANSCRIBE_SCRIPT, audioPath, '--model', whisperModel], {
      timeout: timeoutMs,
      maxBuffer: 50 * 1024 * 1024,
      detached: true,
      env: spawnEnv,
    }, (err, stdout, stderr) => {
      _activeMLXProcess = null;
      if (err) {
        if (err.killed || err.signal === 'SIGTERM') {
          return reject(new Error('Local transcription cancelled.'));
        }
        return reject(new Error(`OpenAI Whisper fallback failed: ${stderr?.trim() || err.message}`));
      }
      try {
        resolve(parseTranscriptionJson(stdout));
      } catch (e) {
        reject(new Error(`Failed to parse OpenAI Whisper output: ${e.message}`));
      }
    });
    _activeMLXProcess = proc;
  });
}

function killActiveTranscription() {
  if (_activeMLXProcess) {
    const pid = _activeMLXProcess.pid;
    try { process.kill(-pid, 'SIGKILL'); }
    catch (_) { try { _activeMLXProcess.kill('SIGKILL'); } catch (_2) {} }
    _activeMLXProcess = null;
  }
}

// ── Groq / OpenAI-compatible Whisper API ──

function getProviderLabel(endpoint) {
  try {
    const host = new URL(endpoint).hostname.toLowerCase();
    if (host.includes('openai')) return 'OpenAI';
    if (host.includes('groq')) return 'Groq';
    if (host.includes('localhost') || host.includes('127.0.0.1')) return 'Local server';
    return host;
  } catch (_) { return 'Transcription provider'; }
}

async function transcribeWithWhisperAPI(audioPath, apiKey, {
  endpoint = DEFAULT_ENDPOINT,
  model = DEFAULT_MODEL,
  ffmpegPath,
  timeoutMs = DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
  onProgress,
} = {}) {
  let workPath = audioPath;
  let tmpCreated = null;
  const providerLabel = getProviderLabel(endpoint);

  let fileData = fs.readFileSync(audioPath);
  const LIMIT = 24 * 1048576;
  if (fileData.length > LIMIT) {
    if (!ffmpegPath) throw new Error(`Audio file is ${(fileData.length/1048576).toFixed(1)}MB -- exceeds 25MB API limit and no ffmpeg found.`);
    onProgress?.(`  Compressing audio for ${providerLabel} upload...`);
    workPath = await compressForGroq(audioPath, ffmpegPath);
    tmpCreated = workPath;
    fileData = fs.readFileSync(workPath);
    if (fileData.length > LIMIT) throw new Error(`Audio still ${(fileData.length/1048576).toFixed(1)}MB after compression -- use chunked transcription for long broadcasts.`);
  }

  const parsedUrl = new URL(endpoint);
  const transport = parsedUrl.protocol === 'https:' ? https : http;
  const fileName  = path.basename(workPath);
  const mime      = AUDIO_MIME[path.extname(workPath).toLowerCase()] || 'audio/mpeg';
  const boundary  = '----RadioVaultBoundary' + Date.now().toString(36);
  const CRLF      = '\r\n';
  onProgress?.(`  Uploading ${(fileData.length / 1048576).toFixed(1)} MB to ${providerLabel} (${model})...`);

  const body = Buffer.concat([
    Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="file"; filename="${fileName}"${CRLF}Content-Type: ${mime}${CRLF}${CRLF}`),
    fileData,
    Buffer.from(`${CRLF}--${boundary}${CRLF}Content-Disposition: form-data; name="model"${CRLF}${CRLF}${model}${CRLF}`),
    Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="response_format"${CRLF}${CRLF}verbose_json${CRLF}`),
    Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="timestamp_granularities[]"${CRLF}${CRLF}segment${CRLF}`),
    Buffer.from(`--${boundary}--${CRLF}`),
  ]);

  return new Promise((resolve, reject) => {
    const req = transport.request({
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || undefined,
      path:     parsedUrl.pathname + (parsedUrl.search || ''),
      method:   'POST',
      timeout:  timeoutMs,
      headers:  {
        'Authorization':  apiKey ? `Bearer ${apiKey}` : undefined,
        'Content-Type':   `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) {
            const msg = json?.error?.message || JSON.stringify(json);
            return reject(new Error(`${providerLabel} API error ${res.statusCode}: ${msg}`));
          }
          const segments = (json.segments || []).map(s => ({
            start: Math.round(s.start * 10) / 10,
            end:   Math.round(s.end   * 10) / 10,
            text:  (s.text || '').trim(),
          }));
          resolve({ full_text: json.text || '', segments });
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error(`${providerLabel} timed out after ${(timeoutMs / 60000).toFixed(0)} minutes`)); });
    req.write(body);
    req.end();
  }).finally(() => {
    if (tmpCreated) try { fs.unlinkSync(tmpCreated); } catch (_) {}
  });
}

/**
 * Chunked transcription for long broadcasts via Groq API.
 * Splits audio into 20-min segments, transcribes each, merges results.
 */
async function chunkAndTranscribe(audioPath, apiKey, { endpoint, model, ffmpegPath, onProgress } = {}) {
  onProgress?.('  Splitting long broadcast into chunks for API transcription...');
  const chunks = await splitAudioChunks(audioPath, ffmpegPath, 1200);
  onProgress?.(`  Split into ${chunks.length} chunks (20 min each)`);

  let fullText = '';
  const allSegments = [];

  for (let i = 0; i < chunks.length; i++) {
    const { chunkPath, offsetSeconds } = chunks[i];
    onProgress?.(`  Transcribing chunk ${i + 1}/${chunks.length}...`);

    try {
      const result = await transcribeWithWhisperAPI(chunkPath, apiKey, {
        endpoint, model, ffmpegPath,
        timeoutMs: DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
        onProgress,
      });

      fullText += (fullText ? ' ' : '') + result.full_text;
      for (const seg of result.segments) {
        allSegments.push({
          start: Math.round((seg.start + offsetSeconds) * 10) / 10,
          end:   Math.round((seg.end + offsetSeconds) * 10) / 10,
          text:  seg.text,
        });
      }
    } finally {
      try { fs.unlinkSync(chunkPath); } catch (_) {}
    }
  }

  return { full_text: fullText, segments: allSegments };
}

// ── AI SUMMARY ─────────────────────────────────────────────────────────────

/**
 * Generate an AI summary and key moments from a transcript using the Anthropic API.
 * Makes a direct HTTPS call -- no SDK dependency needed.
 */
async function generateAiSummary(transcriptText, itemTitle, anthropicApiKey, onProgress) {
  if (!anthropicApiKey) {
    onProgress?.('  Skipping AI summary (no Anthropic API key)');
    return null;
  }

  onProgress?.('  Generating AI summary and key moments...');

  const prompt = `You are analyzing a radio broadcast transcript from Clemson Athletics (Tiger Network).

Title: ${itemTitle}

Transcript:
${transcriptText.slice(0, 30000)}

Please provide:
1. A concise summary (2-3 sentences) of what this broadcast covers.
2. A list of key moments with their approximate timestamps. Key moments include: scoring plays, notable commentary, interviews, heated moments, game-changing plays, and any particularly compelling audio.

Respond in this exact JSON format:
{
  "summary": "...",
  "key_moments": [
    { "timestamp": 120.5, "description": "Touchdown call - 45 yard pass to the end zone" },
    { "timestamp": 3600.0, "description": "Postgame coach interview" }
  ]
}

Return ONLY the JSON, no other text.`;

  const requestBody = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(requestBody),
      },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200) {
            onProgress?.(`  AI summary warning: API error ${res.statusCode}`);
            return resolve(null);
          }
          const text = json.content?.[0]?.text || '';
          const parsed = JSON.parse(text);
          onProgress?.(`  AI summary generated (${(parsed.key_moments || []).length} key moments)`);
          resolve(parsed);
        } catch (e) {
          onProgress?.(`  AI summary warning: ${e.message}`);
          resolve(null);
        }
      });
    });
    req.on('error', (err) => {
      onProgress?.(`  AI summary warning: ${err.message}`);
      resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(requestBody);
    req.end();
  });
}

// ── DATABASE ────────────────────────────────────────────────────────────────

function loadDb(dbPath) {
  try {
    if (fs.existsSync(dbPath)) {
      const data = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
      if (data && typeof data === 'object') return data;
    }
  } catch {}
  return { content_items: {}, clips: [], tags: {}, shows: {}, home_topics: [], last_updated: null };
}

function saveDb(db, dbPath) {
  const tmp = dbPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, dbPath);
}

async function pushToSupabase(item, clips, db, onProgress) {
  if (!supabaseClient) {
    if (_supabaseLoadError) onProgress?.('  WARNING: Supabase sync unavailable -- ' + _supabaseLoadError);
    return;
  }
  if (!supabaseClient.isInitialized()) return;
  try {
    await supabaseClient.upsertContentItem(item);

    const itemClips = clips.filter(c => c.content_item_id === item.id);
    if (itemClips.length) {
      await supabaseClient.upsertClips(item.id, itemClips);
    }

    if (item.transcript) {
      const fullText = typeof item.transcript === 'string'
        ? item.transcript
        : (item.transcript.full_text || '');
      const segments = (typeof item.transcript === 'object' && item.transcript.segments) || [];
      await supabaseClient.pushTranscript(item.id, fullText, segments);
    }

    if (item.key_moments && item.key_moments.length) {
      await supabaseClient.pushKeyMoments(item.id, item.key_moments);
    }

    if (db.tags) {
      await supabaseClient.upsertTags(db.tags);
    }

    onProgress?.('  Pushed to Supabase');
  } catch (err) {
    onProgress?.(`  Supabase push warning: ${err.message}`);
  }
}

// ── PROCESS SINGLE ITEM ─────────────────────────────────────────────────────

async function processItem(item, db, taxonomyList, taxonomyMap, {
  apiKey, apiEndpoint, apiModel, ffmpegPath, cacheDir,
  onProgress, force, reclip, teaserThreshold, useLocalWhisper, localWhisperModel,
  anthropicApiKey, shouldCancel,
}) {
  if (db.content_items[item.id]?.processed_at && !force && !reclip) {
    return { updated: false, reason: 'already_processed' };
  }

  onProgress(`Processing: ${item.title}`);

  let transcriptData = null;

  if (reclip) {
    transcriptData = db.content_items[item.id]?.transcript || null;
    if (!transcriptData) {
      onProgress('  No existing transcript -- skipping');
      return { updated: false, reason: 'no_existing_transcript' };
    }
    onProgress('  Re-extracting clips from existing transcript...');
  } else {
    let audioPath = null;
    try {
      if (!item.file_path) {
        onProgress('  No file path -- download the episode first');
        return { updated: false, reason: 'no_file_path' };
      }

      if (!fs.existsSync(item.file_path)) {
        onProgress(`  File not found: ${item.file_path}`);
        return { updated: false, reason: 'missing_file' };
      }

      onProgress('  Preparing audio for transcription...');
      audioPath = await prepareAudio(item.file_path, cacheDir, ffmpegPath);
      onProgress(`  Audio ready: ${(fs.statSync(audioPath).size / 1048576).toFixed(1)} MB`);

      if (useLocalWhisper) {
        try {
          transcriptData = await transcribeWithMLX(audioPath, {
            model: localWhisperModel || 'large',
            timeoutMs: 90 * 60 * 1000,
            onProgress,
            ffmpegPath,
          });
        } catch (mlxErr) {
          if (/cancelled/i.test(String(mlxErr?.message || ''))) throw mlxErr;
          onProgress(`  MLX Whisper unavailable: ${compactTranscriptionError(mlxErr?.message)}`);
          transcriptData = await transcribeWithOpenAIWhisper(audioPath, {
            model: localWhisperModel || 'large',
            timeoutMs: 4 * 60 * 60 * 1000,
            onProgress,
            ffmpegPath,
          });
        }
      } else {
        // Check if file is too large for single API call
        const audioSize = fs.statSync(audioPath).size;
        if (audioSize > 24 * 1048576) {
          onProgress('  Long broadcast detected -- using chunked transcription...');
          transcriptData = await chunkAndTranscribe(audioPath, apiKey, {
            endpoint: apiEndpoint,
            model: apiModel,
            ffmpegPath,
            onProgress,
          });
        } else {
          onProgress(`  Transcribing with ${getProviderLabel(apiEndpoint)} (${apiModel || DEFAULT_MODEL})...`);
          transcriptData = await transcribeWithWhisperAPI(audioPath, apiKey, {
            endpoint: apiEndpoint,
            model: apiModel,
            ffmpegPath,
            timeoutMs: DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
            onProgress,
          });
        }
      }
    } catch (err) {
      // Handle rate limiting -- parse wait time and pause
      const rateLimitMatch = err.message?.match(/try again in (\d+)m(\d+)s/i);
      if (rateLimitMatch || err.message?.includes('429')) {
        let waitSec = 120; // default 2 min
        if (rateLimitMatch) {
          waitSec = parseInt(rateLimitMatch[1]) * 60 + parseInt(rateLimitMatch[2]) + 10;
        }
        onProgress(`  Rate limited -- waiting ${Math.ceil(waitSec / 60)} min before retrying...`);
        // Cancellable wait: check every 5 seconds
        for (let waited = 0; waited < waitSec; waited += 5) {
          if (shouldCancel?.()) {
            onProgress('  Cancelled during rate limit wait.');
            return { updated: false, reason: 'cancelled' };
          }
          await new Promise(r => setTimeout(r, 5000));
        }
        if (shouldCancel?.()) return { updated: false, reason: 'cancelled' };
        // Retry once
        try {
          onProgress(`  Retrying transcription...`);
          transcriptData = await transcribeWithWhisperAPI(audioPath, apiKey, {
            endpoint: apiEndpoint,
            model: apiModel,
            ffmpegPath,
            timeoutMs: DEFAULT_TRANSCRIPTION_TIMEOUT_MS,
            onProgress,
          });
        } catch (retryErr) {
          onProgress(`  Retry failed: ${retryErr.message}`);
        }
      } else {
        onProgress(`  Transcription failed: ${err.message}`);
      }
    }
  }

  const segmentCount = Array.isArray(transcriptData?.segments) ? transcriptData.segments.length : 0;
  if (!reclip && !segmentCount) {
    onProgress('  No transcript was produced -- leaving this episode unprocessed');
    return { updated: false, reason: 'no_transcript' };
  }

  // Extract clips via taxonomy keywords
  const { clips, matchedTerms } = extractTopics(transcriptData, item, taxonomyList, { teaserThreshold });
  updateTags(db, clips, matchedTerms, taxonomyMap);

  if (reclip || force) {
    db.clips = db.clips.filter(c => c.content_item_id !== item.id);
  }

  // AI summary + key moments
  let summary = null;
  let keyMoments = [];
  if (transcriptData?.full_text && !reclip && anthropicApiKey) {
    const aiResult = await generateAiSummary(transcriptData.full_text, item.title, anthropicApiKey, onProgress);
    if (aiResult) {
      summary = aiResult.summary || null;
      keyMoments = aiResult.key_moments || [];

      // Create clips from AI-detected key moments
      for (const moment of keyMoments) {
        const ts = Number(moment.timestamp) || 0;
        if (ts <= 0) continue;
        clips.push({
          content_item_id: item.id,
          content_title:   item.title,
          show_name:       item.show_name,
          content_type:    item.content_type,
          date:            item.date,
          keyword:         'key_moment',
          category:        'ai_detected',
          timestamp_start: Math.max(0, ts - 10),
          timestamp_end:   ts + 20,
          quote:           moment.description,
          teaser_score:    0.8,
          source_reason:   'ai_detected',
        });
      }
    }
  }

  // Update the item in DB
  db.content_items[item.id] = {
    ...db.content_items[item.id],
    ...item,
    transcript:   transcriptData,
    summary,
    key_moments:  keyMoments,
    clip_count:   clips.length,
    topics_found: [...matchedTerms],
    processed_at: new Date().toISOString(),
  };
  db.clips.push(...clips);
  db.last_updated = new Date().toISOString();

  // Auto-clean: only delete cached audio if NOT on shared media.
  // Shared media keeps files so the whole team can access them.
  if (transcriptData && item.file_path && !reclip) {
    const isSharedMedia = !item.file_path.includes('audio_cache');
    if (!isSharedMedia) {
      try {
        if (fs.existsSync(item.file_path)) {
          fs.unlinkSync(item.file_path);
          db.content_items[item.id].file_path = null;
          onProgress('  Cleaned up local cache (re-downloads on demand)');
        }
      } catch (_) {}
    }
  }

  onProgress(`  Done -- ${clips.length} clips, ${matchedTerms.size} topics${summary ? ', AI summary generated' : ''}`);
  return { updated: true, reason: reclip ? 'reclip' : 'processed' };
}

// ── MAIN PIPELINE ───────────────────────────────────────────────────────────

async function runIngest({ settings, dbPath, cacheDir, ffmpegPath, onProgress = () => {}, onDbUpdate, force = false, reclip = false, shouldCancel } = {}) {
  const ing = settings?.ingestion || {};
  const useLocalWhisper = ing.transcription_provider === 'local';
  const localWhisperModel = ing.local_whisper_model || 'large';
  const apiEndpoint = ing.api_endpoint || DEFAULT_ENDPOINT;
  const apiModel    = ing.api_model    || DEFAULT_MODEL;
  const apiKey      = (ing.groq_api_key || '').trim();
  const anthropicApiKey = (ing.anthropic_api_key || '').trim();
  const teaserThreshold = Number(ing.teaser_score_threshold ?? TEASER_MIN_SCORE_DEFAULT);
  const ingestCutoffDate = ing.ingest_cutoff_date || null;

  if (!reclip && !useLocalWhisper && !apiKey) throw new Error('API key not configured. Open Settings and enter your Groq key, or switch to Local Whisper.');

  fs.mkdirSync(cacheDir, { recursive: true });
  const db = loadDb(dbPath);

  const taxonomyMap = loadTaxonomy(settings);
  const taxonomyList = flattenTaxonomy(taxonomyMap);
  onProgress(`Loaded taxonomy: ${taxonomyList.length} keywords across ${Object.keys(taxonomyMap).length} categories`);

  let allItems = Object.values(db.content_items || {});

  // Apply date cutoff filter
  if (ingestCutoffDate && !reclip) {
    const before = allItems.length;
    allItems = allItems.filter(i => i.date && i.date >= ingestCutoffDate);
    const skipped = before - allItems.length;
    if (skipped > 0) onProgress(`Date filter: only processing episodes from ${ingestCutoffDate} onward (${skipped} older episodes skipped)`);
  }

  let toProcess;
  if (reclip) {
    toProcess = allItems.filter(i => i.transcript);
    onProgress(`Re-clipping ${toProcess.length} item(s) with updated taxonomy (no transcription)...`);
  } else if (force) {
    toProcess = allItems.filter(i => i.file_path);
    onProgress(`${toProcess.length} item(s) to transcribe...`);
  } else {
    toProcess = allItems.filter(i => i.file_path && !i.processed_at);
    const alreadyDone = allItems.length - toProcess.length;
    if (alreadyDone > 0) onProgress(`${alreadyDone} item(s) already processed -- skipping`);
    if (toProcess.length === 0) {
      const undownloaded = allItems.filter(i => !i.file_path).length;
      if (undownloaded > 0) {
        onProgress(`Nothing to process. ${undownloaded} episode(s) need to be downloaded first.`);
      } else {
        onProgress('Nothing new to process. Use "Force Re-process" to re-run all items.');
      }
    } else {
      onProgress(`${toProcess.length} item(s) to transcribe...`);
    }
  }

  for (let i = 0; i < toProcess.length; i++) {
    const item = toProcess[i];
    if (shouldCancel?.()) { onProgress('Ingestion cancelled.'); break; }
    onProgress(`\n[${i + 1}/${toProcess.length}] ${item.title}`);
    const result = await processItem(item, db, taxonomyList, taxonomyMap, {
      apiKey, apiEndpoint, apiModel, ffmpegPath, cacheDir,
      onProgress, force, reclip, teaserThreshold, useLocalWhisper, localWhisperModel,
      anthropicApiKey, shouldCancel,
    });
    if (!result?.updated) continue;
    saveDb(db, dbPath);
    onDbUpdate?.(db);
    await pushToSupabase(db.content_items[item.id], db.clips, db, onProgress);
  }

  const itemCount = Object.keys(db.content_items).length;
  const clipCount = db.clips.length;
  const tagCount  = Object.keys(db.tags || {}).length;
  onProgress(`Complete -- ${itemCount} items, ${clipCount} clips, ${tagCount} tags`);
  return db;
}

module.exports = { runIngest, loadDb, saveDb, killActiveTranscription };
