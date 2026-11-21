create table public.room_tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 60)
);
create unique index room_tenants_name_unique on public.room_tenants (lower(btrim(name)));
alter table public.room_tenants enable row level security;
revoke all on public.room_tenants from public, anon, authenticated, service_role;
grant select, insert on public.room_tenants to service_role;

alter table public.room_assignments
  add column tenant_id uuid references public.room_tenants(id),
  add constraint no_tenant_overlap exclude using gist (
    tenant_id with =,
    tsrange(starts_at, ends_at, '[)') with &&
  ) where (tenant_id is not null);

grant delete on public.room_assignments to service_role;
