-- RadioVault Supabase Schema
-- Run this in your Supabase SQL editor to set up the tables.

-- Content items (episodes from RSS feeds)
create table if not exists content_items (
  id                text primary key,
  title             text not null default 'Untitled',
  show_name         text,
  content_type      text default 'radio_broadcast',
  media_type        text default 'audio',
  season            text,
  episode           text,
  date              text,
  description       text,
  audio_url         text,
  feed_url          text,
  episode_guid      text,
  file_size         bigint,
  duration          integer,
  clip_count        integer default 0,
  topics_found      integer default 0,
  summary           text,
  processed_at      timestamptz,
  source_folder     text,
  file_modified_at  timestamptz,
  transcript_text   text,
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);

-- Auto-update updated_at
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger content_items_updated_at
  before update on content_items
  for each row execute function update_updated_at();

-- Transcript segments
create table if not exists transcript_segments (
  id               bigint generated always as identity primary key,
  content_item_id  text not null references content_items(id) on delete cascade,
  seg_start        real not null,
  seg_end          real not null,
  text             text not null
);

create index if not exists idx_segments_item on transcript_segments(content_item_id);

-- Clips
create table if not exists clips (
  id               bigint generated always as identity primary key,
  content_item_id  text references content_items(id) on delete cascade,
  content_title    text,
  show_name        text,
  content_type     text,
  date             text,
  keyword          text,
  category         text,
  timestamp_start  real,
  timestamp_end    real,
  quote            text,
  teaser_score     real,
  source_reason    text default 'keyword',
  created_at       timestamptz default now()
);

create index if not exists idx_clips_item on clips(content_item_id);
create index if not exists idx_clips_keyword on clips(keyword);
create index if not exists idx_clips_category on clips(category);

-- Key moments (AI-detected notable moments)
create table if not exists key_moments (
  id               bigint generated always as identity primary key,
  content_item_id  text references content_items(id) on delete cascade,
  timestamp        real not null,
  description      text not null,
  created_at       timestamptz default now()
);

create index if not exists idx_moments_item on key_moments(content_item_id);

-- Tags
create table if not exists tags (
  term        text primary key,
  category    text,
  clip_count  integer default 0,
  item_count  integer default 0,
  first_seen  text,
  last_seen   text
);

-- Home topics (pinned topics for dashboard)
create table if not exists home_topics (
  id          bigint generated always as identity primary key,
  term        text not null,
  sort_order  integer default 0
);

-- Enable RLS but allow service key full access
alter table content_items enable row level security;
alter table transcript_segments enable row level security;
alter table clips enable row level security;
alter table key_moments enable row level security;
alter table tags enable row level security;
alter table home_topics enable row level security;

create policy "service_all" on content_items for all using (true) with check (true);
create policy "service_all" on transcript_segments for all using (true) with check (true);
create policy "service_all" on clips for all using (true) with check (true);
create policy "service_all" on key_moments for all using (true) with check (true);
create policy "service_all" on tags for all using (true) with check (true);
create policy "service_all" on home_topics for all using (true) with check (true);
