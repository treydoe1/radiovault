'use strict';
/**
 * feeds.js -- RSS feed engine for RadioVault
 *
 * Replaces scanner.js. Fetches podcast RSS feeds, parses episodes,
 * downloads audio to local cache for transcription.
 */

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

// ── RSS FETCH ──────────────────────────────────────────────────────────────

/**
 * Fetch raw XML from a URL. Follows up to 5 redirects.
 * @param {string} url
 * @param {number} [maxRedirects=5]
 * @returns {Promise<string>}
 */
function fetchUrl(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) return reject(new Error('Too many redirects'));
    const transport = url.startsWith('https') ? https : http;
    transport.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchUrl(res.headers.location, maxRedirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── XML PARSING ────────────────────────────────────────────────────────────

/**
 * Extract text content of a named XML tag from a block of XML.
 * Returns the first match or fallback.
 */
function xmlText(xml, tag, fallback = '') {
  // Handle CDATA: <tag><![CDATA[content]]></tag>
  const cdataRe = new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tag}>`, 'i');
  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1].trim();

  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const match = xml.match(re);
  return match ? match[1].trim() : fallback;
}

/**
 * Extract an attribute value from the first occurrence of a tag.
 */
function xmlAttr(xml, tag, attr) {
  const re = new RegExp(`<${tag}[^>]*\\s${attr}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? match[1] : '';
}

/**
 * Split XML into an array of blocks matching a given tag.
 */
function xmlBlocks(xml, tag) {
  const re = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, 'gi');
  return xml.match(re) || [];
}

// ── FEED PARSING ───────────────────────────────────────────────────────────

/**
 * Parse an RSS/podcast feed XML string into structured data.
 * @param {string} xml - Raw RSS XML
 * @returns {{ feed: object, episodes: object[] }}
 */
function parseFeed(xml) {
  const channelMatch = xml.match(/<channel[\s>][\s\S]*<\/channel>/i);
  if (!channelMatch) throw new Error('No <channel> found in feed');
  const channel = channelMatch[0];

  const feed = {
    title:       xmlText(channel, 'title'),
    description: xmlText(channel, 'description') || xmlText(channel, 'itunes:summary'),
    image:       xmlAttr(channel, 'itunes:image', 'href') || xmlText(channel, 'url'),
    link:        xmlText(channel, 'link'),
  };

  const items = xmlBlocks(channel, 'item');
  const episodes = items.map((item) => {
    const guid = xmlText(item, 'guid') || xmlText(item, 'link') || xmlText(item, 'title');
    const pubDate = xmlText(item, 'pubDate');
    const durationRaw = xmlText(item, 'itunes:duration');

    return {
      guid,
      title:       xmlText(item, 'title'),
      description: xmlText(item, 'description') || xmlText(item, 'itunes:summary'),
      date:        pubDate ? parseRssDate(pubDate) : null,
      pubDate:     pubDate,
      duration:    parseDuration(durationRaw),
      durationRaw,
      audioUrl:    xmlAttr(item, 'enclosure', 'url'),
      audioType:   xmlAttr(item, 'enclosure', 'type'),
      audioLength: parseInt(xmlAttr(item, 'enclosure', 'length') || '0', 10),
    };
  }).filter((ep) => ep.audioUrl);

  return { feed, episodes };
}

/**
 * Parse RSS pubDate into ISO date string (YYYY-MM-DD).
 */
function parseRssDate(pubDate) {
  try {
    const d = new Date(pubDate);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * Parse iTunes duration (seconds, or HH:MM:SS / MM:SS) into seconds.
 */
function parseDuration(raw) {
  if (!raw) return null;
  const num = Number(raw);
  if (!isNaN(num) && num > 0) return Math.round(num);
  const parts = raw.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return null;
}

// ── EPISODE DISCOVERY ──────────────────────────────────────────────────────

/**
 * Generate a stable content item ID from an episode GUID.
 */
function episodeId(guid) {
  const hash = crypto.createHash('sha256').update(guid).digest('hex').slice(0, 16);
  return `radio_${hash}`;
}

/**
 * Fetch a feed and return new episodes not already in the DB.
 * @param {string} feedUrl
 * @param {Set<string>} existingIds - Set of content item IDs already in DB
 * @returns {Promise<{ feed: object, newEpisodes: object[] }>}
 */
async function discoverEpisodes(feedUrl, existingIds) {
  const xml = await fetchUrl(feedUrl);
  const { feed, episodes } = parseFeed(xml);

  const newEpisodes = episodes
    .filter((ep) => !existingIds.has(episodeId(ep.guid)))
    .map((ep) => ({
      id:           episodeId(ep.guid),
      title:        ep.title,
      show_name:    feed.title,
      content_type: 'radio_broadcast',
      media_type:   'audio',
      date:         ep.date,
      pub_date:     ep.pubDate,
      description:  ep.description,
      audio_url:    ep.audioUrl,
      file_path:    null,
      duration:     ep.duration,
      feed_url:     feedUrl,
      episode_guid: ep.guid,
      file_size:    ep.audioLength || null,
    }));

  return { feed, newEpisodes };
}

// ── AUDIO DOWNLOAD ─────────────────────────────────────────────────────────

/**
 * Download an MP3 to the local cache directory.
 * Skips if already cached. Returns the local file path.
 * @param {string} audioUrl
 * @param {string} cacheDir
 * @param {string} itemId
 * @param {function} [onProgress] - Called with { downloaded, total, percent }
 * @returns {Promise<string>} local file path
 */
function downloadEpisode(audioUrl, cacheDir, itemId, onProgress) {
  const ext = path.extname(new URL(audioUrl).pathname) || '.mp3';
  const safeName = itemId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  const outPath = path.join(cacheDir, `${safeName}${ext}`);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
    return Promise.resolve(outPath);
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const doDownload = (url, redirects = 5) => {
      if (redirects < 0) return reject(new Error('Too many redirects'));
      const transport = url.startsWith('https') ? https : http;
      transport.get(url, { timeout: 600000 }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return doDownload(res.headers.location, redirects - 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading audio`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        const tmpPath = outPath + '.tmp';
        const ws = fs.createWriteStream(tmpPath);

        res.on('data', (chunk) => {
          downloaded += chunk.length;
          ws.write(chunk);
          if (onProgress && total > 0) {
            onProgress({
              downloaded,
              total,
              percent: Math.round((downloaded / total) * 100),
            });
          }
        });

        res.on('end', () => {
          ws.end();
        });

        ws.on('finish', () => {
          // Network volumes (SMB/AFP) may need a moment after flush
          const tryRename = (retries) => {
            fs.rename(tmpPath, outPath, (err) => {
              if (err && retries > 0) {
                setTimeout(() => tryRename(retries - 1), 500);
              } else if (err) {
                reject(new Error(`Failed to save download: ${err.message}`));
              } else {
                resolve(outPath);
              }
            });
          };
          tryRename(3);
        });

        res.on('error', (err) => {
          ws.end();
          try { fs.unlinkSync(tmpPath); } catch {}
          reject(err);
        });
      }).on('error', reject);
    };

    doDownload(audioUrl);
  });
}

// ── WEBSITE SCRAPER (theroarfm.com) ────────────────────────────────────────

const ROAR_BASE = 'http://www.theroarfm.com';
const ROAR_EPISODES_PER_PAGE = 20;

// Map show image filenames to show names (from theroarfm.com)
const SHOW_IMAGE_MAP = {
  'mickey_plyler': 'Mickey Plyler Show',
  'fax':           'Fax on Sports',
  'out_of_bounds': 'Out of Bounds',
  'road_rage':     'Road Rage with Walt Deptula',
};

/**
 * Parse a single page of theroarfm.com/podcasts/ HTML into episode objects.
 */
function parseRoarPage(html) {
  const episodes = [];
  // Split into episode blocks by podcastPlayed divs
  const blocks = html.split('class="podcastPlayed"').slice(1);

  for (const block of blocks) {
    try {
      // Show name from image: /images/podcasts/mickey_plyler.jpg
      const imgMatch = block.match(/\/images\/podcasts\/([^."]+)/);
      const showKey = imgMatch ? imgMatch[1] : 'unknown';
      const showName = SHOW_IMAGE_MAP[showKey] || showKey.replace(/_/g, ' ');

      // Title + link: <a href="/podcasts/listen/17823/4226_hour_3/">4/2/26 Hour 3</a>
      const linkMatch = block.match(/<a\s+href="(\/podcasts\/listen\/(\d+)\/[^"]*)"[^>]*>([^<]+)<\/a>/);
      if (!linkMatch) continue;
      const episodePath = linkMatch[1];
      const episodeDbId = linkMatch[2];
      const title = linkMatch[3].trim();

      // Show name from the &middot; pattern: </a> &middot; Mickey Plyler Show</b>
      const showInlineMatch = block.match(/&middot;\s*([^<]+)<\/b>/);
      const showNameInline = showInlineMatch ? showInlineMatch[1].trim() : showName;

      // Date: </b> &middot; 4/2<br>
      const dateMatch = block.match(/<\/b>\s*&middot;\s*(\d+\/\d+)/);
      const dateShort = dateMatch ? dateMatch[1] : null;

      // Description: text between <br> and <audio
      const descMatch = block.match(/<br>\s*\n?\s*([^<]*?)\s*<audio/);
      const description = descMatch ? descMatch[1].replace(/"/g, '').trim() : '';

      // Audio URL: <audio ... src="https://media.cast.co.com/...">
      const audioMatch = block.match(/src="(https?:\/\/media\.cast\.co\.com\/[^"]+)"/);
      if (!audioMatch) continue;
      const audioUrl = audioMatch[1];

      // Derive full date from title (e.g. "4/2/26" from "4/2/26 Hour 3")
      const fullDateMatch = title.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})/);
      let date = null;
      if (fullDateMatch) {
        const month = fullDateMatch[1].padStart(2, '0');
        const day = fullDateMatch[2].padStart(2, '0');
        const year = '20' + fullDateMatch[3];
        date = `${year}-${month}-${day}`;
      }

      const guid = `roar_${episodeDbId}`;

      episodes.push({
        id:           episodeId(guid),
        title:        `${title} - ${showNameInline}`,
        show_name:    showNameInline,
        content_type: 'radio_broadcast',
        media_type:   'audio',
        date,
        description,
        audio_url:    audioUrl,
        file_path:    null,
        duration:     null,
        feed_url:     ROAR_BASE + '/podcasts/',
        episode_guid: guid,
        file_size:    null,
        _source:      'scrape',
      });
    } catch (_) {
      // Skip malformed blocks
    }
  }

  return episodes;
}

/**
 * Scrape theroarfm.com/podcasts/ archive.
 * Paginates through all pages (20 episodes per page).
 * @param {Set<string>} existingIds - IDs already in DB
 * @param {object} options
 * @param {number} [options.maxPages=50] - Max pages to scrape (50 = 1000 episodes)
 * @param {function} [options.onProgress] - Progress callback
 * @returns {Promise<{ newEpisodes: object[], pagesScraped: number }>}
 */
async function scrapeRoarArchive(existingIds, { maxPages = 750, onProgress } = {}) {
  const allNew = [];
  let offset = 0;
  let pagesScraped = 0;
  let consecutiveNoNew = 0;

  for (let page = 0; page < maxPages; page++) {
    const url = offset === 0
      ? `${ROAR_BASE}/podcasts/`
      : `${ROAR_BASE}/podcasts/${offset}/`;

    onProgress?.(`Scraping page ${page + 1} (offset ${offset}) -- ${allNew.length} new so far...`);

    try {
      const html = await fetchUrl(url);
      const episodes = parseRoarPage(html);

      if (episodes.length === 0) {
        consecutiveNoNew++;
        if (consecutiveNoNew >= 3) {
          onProgress?.('Reached end of archive.');
          break;
        }
        offset += ROAR_EPISODES_PER_PAGE;
        continue;
      }

      const newOnes = episodes.filter(ep => !existingIds.has(ep.id));

      if (newOnes.length === 0) {
        consecutiveNoNew++;
        if (consecutiveNoNew >= 3) {
          onProgress?.('No new episodes found for 3 pages -- stopping.');
          break;
        }
      } else {
        consecutiveNoNew = 0;
      }

      for (const ep of newOnes) {
        allNew.push(ep);
        existingIds.add(ep.id);
      }

      pagesScraped++;
      offset += ROAR_EPISODES_PER_PAGE;

      // Small delay to be respectful
      await new Promise(r => setTimeout(r, 150));
    } catch (err) {
      onProgress?.(`  Error on page ${page + 1}: ${err.message}`);
      break;
    }
  }

  return { newEpisodes: allNew, pagesScraped };
}

// ── EXPORTS ────────────────────────────────────────────────────────────────

module.exports = {
  fetchUrl,
  parseFeed,
  discoverEpisodes,
  downloadEpisode,
  episodeId,
  scrapeRoarArchive,
  parseRoarPage,
};
