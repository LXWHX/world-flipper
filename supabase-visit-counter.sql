-- World Flipper Museum — visit counter setup
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query → Run).
-- Then copy your project's URL + anon key into SUPABASE_URL / SUPABASE_ANON_KEY in index.html
-- (Dashboard → Project Settings → API).

-- 1) Total page views: one row we increment on every visit.
create table if not exists public.site_stats (
  id  int    primary key default 1,
  pv  bigint not null     default 0
);
insert into public.site_stats (id, pv) values (1, 0) on conflict (id) do nothing;

-- 2) Unique visitors: one row per browser (deduped by the localStorage uuid the page sends).
create table if not exists public.visitors (
  visitor_id text        primary key,
  first_seen timestamptz not null default now()
);

-- 3) The one function the site calls. Bumps PV, registers the visitor (idempotent), returns both
--    counts. SECURITY DEFINER runs it as the owner so it bypasses RLS — the tables below stay
--    locked down and nothing but this function is reachable with the anon key.
create or replace function public.record_visit(vid text)
returns table (pv bigint, uv bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.site_stats set pv = site_stats.pv + 1 where id = 1;

  if vid is not null and length(vid) between 1 and 200 then
    insert into public.visitors (visitor_id) values (vid)
    on conflict (visitor_id) do nothing;
  end if;

  return query
    select s.pv, (select count(*) from public.visitors)::bigint
    from public.site_stats s
    where s.id = 1;
end;
$$;

-- 4) Lock the tables (RLS on, no policies = no direct anon read/write) and expose ONLY the
--    function to the public anon role.
alter table public.site_stats enable row level security;
alter table public.visitors   enable row level security;

revoke all on function public.record_visit(text) from public;
grant execute on function public.record_visit(text) to anon;
