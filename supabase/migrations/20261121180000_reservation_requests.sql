alter table public.room_assignments
  add column request_id uuid unique,
  add column staff_schedule_id text,
  add constraint no_staff_overlap exclude using gist (
    staff_schedule_id with =,
    tsrange(starts_at, ends_at, '[)') with &&
  ) where (staff_schedule_id is not null);
