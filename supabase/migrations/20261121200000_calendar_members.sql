create table public.calendar_members (
  email text primary key check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  name text not null check (char_length(btrim(name)) between 1 and 60),
  role text not null check (role in ('therapist', 'rental-manager'))
);

alter table public.calendar_members enable row level security;
revoke all on public.calendar_members from public, anon, authenticated, service_role;
grant select, insert, delete on public.calendar_members to service_role;
