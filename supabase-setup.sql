-- RouteRate account tables. Run this once in Supabase Dashboard > SQL Editor.
-- Row Level Security limits every read/write to the signed-in user's own rows.
create table if not exists public.routerate_devices (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null default 'Device',
  lat double precision,
  lng double precision,
  accuracy_m integer,
  tracking boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint routerate_device_latitude check (lat is null or lat between -90 and 90),
  constraint routerate_device_longitude check (lng is null or lng between -180 and 180)
);
alter table public.routerate_devices enable row level security;
drop policy if exists "Users manage their own RouteRate devices" on public.routerate_devices;
create policy "Users manage their own RouteRate devices" on public.routerate_devices
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists routerate_devices_user_updated on public.routerate_devices(user_id, updated_at desc);

create table if not exists public.routerate_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_ref text,
  home_postcode text,
  pickup_postcode text not null,
  delivery_postcode text not null,
  stops text[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.routerate_jobs enable row level security;
drop policy if exists "Users manage their own RouteRate jobs" on public.routerate_jobs;
create policy "Users manage their own RouteRate jobs" on public.routerate_jobs
  for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create index if not exists routerate_jobs_user_created on public.routerate_jobs(user_id, created_at desc);

-- Enable location updates to reach other signed-in devices through Realtime.
do $$ begin
  alter publication supabase_realtime add table public.routerate_devices;
exception when duplicate_object then null;
end $$;
