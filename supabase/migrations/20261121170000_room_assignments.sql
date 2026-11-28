create extension if not exists btree_gist with schema extensions;

create table public.room_assignments (
  wix_event_id text primary key,
  room text not null check (room in ('mandibula', 'maxilla')),
  starts_at timestamp without time zone not null,
  ends_at timestamp without time zone not null,
  check (starts_at < ends_at),
  constraint no_room_overlap exclude using gist (
    room with =,
    tsrange(starts_at, ends_at, '[)') with &&
  )
);

alter table public.room_assignments enable row level security;
revoke all on public.room_assignments from public, anon, authenticated, service_role;
grant select, insert, update on public.room_assignments to service_role;
