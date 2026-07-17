-- World Flipper Museum — art votes ("Flip" / 弹弹) setup
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query → Run).
-- Reuses the same project, URL and anon key as supabase-visit-counter.sql — nothing here needs
-- new config in index.html.
--
-- Threat model, stated plainly: the anon key ships in the page, so anyone can POST vote_art with a
-- fabricated visitor id. These counts are a for-fun signal, not a poll. That's the same exposure
-- record_visit already accepts; the (visitor_id, art_key) primary key still caps one row per
-- claimed identity, so a casual visitor can't inflate anything by reloading or re-swiping.

-- 1) One row per (visitor, artwork). The composite primary key is what makes a vote changeable:
--    re-voting upserts the same row, and vote_art() below moves the count out of the old bucket
--    and into the new one in the same transaction.
--    v: 1 = like, -1 = dislike, 0 = skip. `art_key` is '<devName>:<variant>', variant being
--    '0' (base art), '1' (awakened art) or 'bust' (the 570x690 story bust that bustOnly
--    characters have instead of a full shot) — every illustration is voted on separately.
create table if not exists public.art_votes (
  visitor_id text        not null,
  art_key    text        not null,
  v          smallint    not null,
  voted_at   timestamptz not null default now(),
  primary key (visitor_id, art_key),
  constraint art_votes_v_check check (v in (1, -1, 0))
);

-- 2) Denormalized per-artwork counts (at most ~855 rows: 374 base + 373 awakened + 108 bust).
--    The Flip screen and the character detail page both read every row in one call, so this read
--    has to stay O(artworks) — a group-by over art_votes would be O(every vote ever cast) and
--    grow without bound. The two tables can't drift: only vote_art() writes either, in one
--    transaction, under a row lock on the art_stats row.
create table if not exists public.art_stats (
  art_key  text   primary key,
  likes    bigint not null default 0,
  dislikes bigint not null default 0,
  skips    bigint not null default 0
);

-- 3) Cast or change one vote. Returns that artwork's fresh counts plus the caller's own vote, so
--    the UI never needs a follow-up read. SECURITY DEFINER for the same reason as record_visit:
--    it runs as the owner and bypasses RLS, so the tables stay locked and only this function is
--    reachable with the anon key.
--    The parameter is `akey`, not `art_key`, deliberately — a parameter sharing a column's name
--    makes every unqualified reference in the body ambiguous. The OUT columns do share names with
--    art_stats columns, which is safe only because every reference below is table-qualified
--    (`s.likes`), the same way record_visit qualifies `s.pv`.
create or replace function public.vote_art(vid text, akey text, v int)
returns table (likes bigint, dislikes bigint, skips bigint, my_vote int)
language plpgsql
security definer
set search_path = public
as $$
declare
  prev int;
begin
  if vid is null or length(vid) not between 1 and 200 then
    raise exception 'bad visitor id';
  end if;
  if akey is null or length(akey) not between 1 and 120 then
    raise exception 'bad art key';
  end if;
  if v is null or v not in (1, -1, 0) then
    raise exception 'bad vote';
  end if;

  -- Make sure the row exists, then lock it, so two tabs voting on the same artwork at the same
  -- moment serialize here rather than both reading the same `prev` and double-counting.
  insert into public.art_stats (art_key) values (akey) on conflict (art_key) do nothing;
  perform 1 from public.art_stats s where s.art_key = akey for update;

  select w.v into prev
    from public.art_votes w
   where w.visitor_id = vid and w.art_key = akey;

  -- Voting the same way twice is a no-op, not a double count.
  if prev is distinct from v then
    insert into public.art_votes (visitor_id, art_key, v)
    values (vid, akey, v::smallint)
    on conflict (visitor_id, art_key) do update set v = excluded.v, voted_at = now();

    -- One statement moves the count: -1 from wherever it was (if anywhere), +1 to where it's
    -- going. `prev` null means this visitor is voting on this artwork for the first time.
    update public.art_stats s set
      likes    = s.likes    + (case when v = 1  then 1 else 0 end) - (case when prev = 1  then 1 else 0 end),
      dislikes = s.dislikes + (case when v = -1 then 1 else 0 end) - (case when prev = -1 then 1 else 0 end),
      skips    = s.skips    + (case when v = 0  then 1 else 0 end) - (case when prev = 0  then 1 else 0 end)
    where s.art_key = akey;
  end if;

  return query
    select s.likes, s.dislikes, s.skips, v
    from public.art_stats s
    where s.art_key = akey;
end;
$$;

-- 4) Every artwork's counts in one call, plus this visitor's own vote on each. ~855 rows / ~35KB,
--    fetched once per session and shared by the Flip deck and the detail page's hero pills — the
--    alternative, one request per artwork, would leave the count pill blank under the user's
--    thumb on every swipe. A null `vid` just yields null my_vote throughout.
create or replace function public.art_stats_all(vid text)
returns table (art_key text, likes bigint, dislikes bigint, skips bigint, my_vote int)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select s.art_key, s.likes, s.dislikes, s.skips, w.v::int
      from public.art_stats s
      left join public.art_votes w
        on w.art_key = s.art_key and w.visitor_id = vid;
end;
$$;

-- 5) Lock the tables (RLS on, no policies = no direct anon read/write) and expose ONLY the two
--    functions to the public anon role — same posture as record_visit.
alter table public.art_votes enable row level security;
alter table public.art_stats enable row level security;

revoke all on function public.vote_art(text, text, int) from public;
revoke all on function public.art_stats_all(text)       from public;

grant execute on function public.vote_art(text, text, int) to anon;
grant execute on function public.art_stats_all(text)       to anon;
