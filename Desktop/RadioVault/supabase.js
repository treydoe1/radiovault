/**
 * supabase.js -- Supabase client wrapper for RadioVault
 *
 * Provides all database operations the Electron app needs.
 * Initialized lazily with URL + service key (from Keychain).
 * Adapted from PodClip: episodes -> content_items, glossary -> tags.
 */

const { createClient } = require('@supabase/supabase-js');

let _client = null;
let _url = null;
let _key = null;

// ── Init / teardown ─────────────────────────────────────────────────────────

function init(url, key) {
  _url = url;
  _key = key;
  _client = createClient(url, key);
}

function isInitialized() {
  return !!_client;
}

function getClient() {
  if (!_client) throw new Error('Supabase not initialized -- call init(url, key) first');
  return _client;
}

// ── Content Items ──────────────────────────────────────────────────────────

async function fetchContentItems() {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await getClient()
      .from('content_items')
      .select('id, title, show_name, content_type, media_type, season, episode, date, description, audio_url, feed_url, episode_guid, file_size, duration, clip_count, topics_found, summary, processed_at, source_folder, file_modified_at, updated_at')
      .order('date', { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function fetchContentItem(id) {
  const { data, error } = await getClient()
    .from('content_items')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
}

async function fetchContentItemsSince(since) {
  const { data, error } = await getClient()
    .from('content_items')
    .select('id, title, show_name, content_type, media_type, season, episode, date, description, audio_url, feed_url, episode_guid, file_size, duration, clip_count, topics_found, summary, processed_at, source_folder, file_modified_at, updated_at')
    .gt('updated_at', since)
    .order('updated_at', { ascending: true });
  if (error) throw error;
  return data;
}

async function upsertContentItem(item) {
  const row = {
    id:               item.id,
    title:            item.title || 'Untitled',
    show_name:        item.show_name || null,
    content_type:     item.content_type || 'radio_broadcast',
    media_type:       item.media_type || 'audio',
    season:           item.season || null,
    episode:          item.episode || null,
    date:             item.date || null,
    description:      item.description || null,
    audio_url:        item.audio_url || null,
    feed_url:         item.feed_url || null,
    episode_guid:     item.episode_guid || null,
    file_size:        item.file_size || null,
    duration:         item.duration ? parseInt(item.duration, 10) : null,
    clip_count:       item.clip_count || 0,
    topics_found:     Array.isArray(item.topics_found) ? item.topics_found.length : (item.topics_found || 0),
    summary:          item.summary || null,
    processed_at:     item.processed_at || null,
    source_folder:    item.source_folder || null,
    file_modified_at: item.file_modified_at || null,
  };

  if (item.transcript) {
    row.transcript_text = typeof item.transcript === 'string'
      ? item.transcript
      : (item.transcript.full_text || null);
  }

  const { data, error } = await getClient()
    .from('content_items')
    .upsert(row, { onConflict: 'id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ── Transcript segments ─────────────────────────────────────────────────────

async function fetchTranscriptSegments(itemId) {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  while (true) {
    const { data, error } = await getClient()
      .from('transcript_segments')
      .select('seg_start, seg_end, text')
      .eq('content_item_id', itemId)
      .order('seg_start', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all.map(s => ({ start: s.seg_start, end: s.seg_end, text: s.text }));
}

async function pushTranscriptSegments(itemId, segments) {
  const sb = getClient();
  await sb.from('transcript_segments').delete().eq('content_item_id', itemId);
  if (!segments || !segments.length) return;

  const rows = segments.map(s => ({
    content_item_id: itemId,
    seg_start: s.start,
    seg_end:   s.end,
    text:      s.text,
  }));

  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    const { error } = await sb.from('transcript_segments').insert(batch);
    if (error) throw error;
  }
}

async function pushTranscript(itemId, fullText, segments) {
  const { error } = await getClient()
    .from('content_items')
    .update({ transcript_text: fullText })
    .eq('id', itemId);
  if (error) throw error;
  await pushTranscriptSegments(itemId, segments);
}

// ── Key Moments ─────────────────────────────────────────────────────────────

async function fetchKeyMoments(itemId) {
  const { data, error } = await getClient()
    .from('key_moments')
    .select('timestamp, description')
    .eq('content_item_id', itemId)
    .order('timestamp', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function pushKeyMoments(itemId, moments) {
  const sb = getClient();
  await sb.from('key_moments').delete().eq('content_item_id', itemId);
  if (!moments || !moments.length) return;
  const rows = moments.map(m => ({
    content_item_id: itemId,
    timestamp: m.timestamp,
    description: m.description,
  }));
  const { error } = await sb.from('key_moments').insert(rows);
  if (error) throw error;
}

// ── Clips ───────────────────────────────────────────────────────────────────

async function fetchClips(filters) {
  const pageSize = 1000;
  let all = [];
  let from = 0;
  while (true) {
    let query = getClient()
      .from('clips')
      .select('*')
      .order('date', { ascending: false })
      .range(from, from + pageSize - 1);

    if (filters?.keyword) query = query.eq('keyword', filters.keyword);
    if (filters?.category) query = query.eq('category', filters.category);
    if (filters?.content_item_id) query = query.eq('content_item_id', filters.content_item_id);

    const { data, error } = await query;
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function upsertClips(itemId, clips) {
  const sb = getClient();

  // Fetch existing clips for rollback if insert fails
  const { data: existing } = await sb.from('clips').select('*').eq('content_item_id', itemId);

  await sb.from('clips').delete().eq('content_item_id', itemId);
  if (!clips || !clips.length) return;

  const rows = clips.map(c => ({
    content_item_id:  c.content_item_id || itemId,
    content_title:    c.content_title || null,
    show_name:        c.show_name || null,
    content_type:     c.content_type || null,
    date:             c.date || null,
    keyword:          c.keyword || null,
    category:         c.category || null,
    timestamp_start:  c.timestamp_start ?? null,
    timestamp_end:    c.timestamp_end ?? null,
    quote:            c.quote || null,
    teaser_score:     c.teaser_score ?? null,
  }));

  try {
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const { error } = await sb.from('clips').insert(batch);
      if (error) throw error;
    }
  } catch (err) {
    // Rollback: restore original clips so remote data isn't lost
    if (existing && existing.length) {
      try { await sb.from('clips').insert(existing); } catch (_) {}
    }
    throw err;
  }
}

// ── Tags (replaces glossary) ───────────────────────────────────────────────

async function fetchTags() {
  const { data, error } = await getClient()
    .from('tags')
    .select('term, category, clip_count, item_count, first_seen, last_seen');
  if (error) throw error;
  const map = {};
  for (const row of (data || [])) {
    map[row.term] = {
      term: row.term,
      category: row.category || 'general',
      clip_count: row.clip_count || 0,
      item_count: row.item_count || 0,
      first_seen: row.first_seen || null,
      last_seen: row.last_seen || null,
    };
  }
  return map;
}

async function upsertTags(tagsMap) {
  const rows = Object.entries(tagsMap).map(([term, value]) => {
    if (typeof value === 'object' && value !== null) {
      return {
        term,
        category: value.category || null,
        clip_count: value.clip_count || 0,
        item_count: value.item_count || 0,
        first_seen: value.first_seen || null,
        last_seen: value.last_seen || null,
      };
    }
    return { term, clip_count: typeof value === 'number' ? value : 1 };
  });

  if (!rows.length) return;

  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const { error } = await getClient()
      .from('tags')
      .upsert(batch, { onConflict: 'term' });
    if (error) throw error;
  }
}

// ── Home topics ─────────────────────────────────────────────────────────────

async function fetchHomeTopics() {
  const { data, error } = await getClient()
    .from('home_topics')
    .select('term, sort_order')
    .order('sort_order', { ascending: true });
  if (error) throw error;
  return (data || []).map(r => r.term);
}

async function upsertHomeTopics(terms) {
  const sb = getClient();
  await sb.from('home_topics').delete().neq('id', 0);
  if (!terms || !terms.length) return;
  const rows = terms.map((term, i) => ({ term, sort_order: i }));
  const { error } = await sb.from('home_topics').insert(rows);
  if (error) throw error;
}

// ── Health check ────────────────────────────────────────────────────────────

async function testConnection() {
  const { error } = await getClient()
    .from('content_items')
    .select('id')
    .limit(1);
  if (error) throw error;
  return true;
}

// ── Assemble into vault_db shape ────────────────────────────────────────────

async function fetchFullDb() {
  const [itemRows, clipRows, tagsMap, homeTopics] = await Promise.all([
    fetchContentItems(),
    fetchClips(),
    fetchTags(),
    fetchHomeTopics(),
  ]);

  const content_items = {};
  for (const row of itemRows) {
    content_items[row.id] = {
      id:               row.id,
      title:            row.title,
      show_name:        row.show_name,
      content_type:     row.content_type,
      media_type:       row.media_type || 'audio',
      season:           row.season,
      episode:          row.episode,
      date:             row.date,
      description:      row.description || null,
      audio_url:        row.audio_url || null,
      feed_url:         row.feed_url || null,
      episode_guid:     row.episode_guid || null,
      file_size:        row.file_size,
      duration:         row.duration ? String(row.duration) : null,
      clip_count:       row.clip_count,
      topics_found:     row.topics_found || 0,
      summary:          row.summary || null,
      processed_at:     row.processed_at,
      source_folder:    row.source_folder,
      file_modified_at: row.file_modified_at,
    };
  }

  return {
    content_items,
    clips: clipRows,
    tags: tagsMap,
    shows: {},
    home_topics: homeTopics,
    last_updated: new Date().toISOString(),
  };
}

module.exports = {
  init,
  isInitialized,
  getClient,
  fetchContentItems,
  fetchContentItem,
  fetchContentItemsSince,
  upsertContentItem,
  fetchTranscriptSegments,
  pushTranscriptSegments,
  pushTranscript,
  fetchClips,
  upsertClips,
  fetchKeyMoments,
  pushKeyMoments,
  fetchTags,
  upsertTags,
  fetchHomeTopics,
  upsertHomeTopics,
  testConnection,
  fetchFullDb,
};
