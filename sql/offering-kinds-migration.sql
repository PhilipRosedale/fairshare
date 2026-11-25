-- Offerings can be several kinds at once (Lend and Sell, say).
--
-- Adds offerings.kinds (kind stays as the main one), fills it from each
-- existing row, and drops the two functions whose signature or result
-- changes, so sql/offerings-schema.sql can recreate them. Apply in order:
--   supabase db query --linked -f sql/offering-kinds-migration.sql
--   supabase db query --linked -f sql/offerings-schema.sql

alter table public.offerings add column if not exists kinds text[];
update public.offerings set kinds = array[kind] where kinds is null;
alter table public.offerings alter column kinds set not null;
alter table public.offerings drop constraint if exists offerings_kinds_check;
alter table public.offerings add constraint offerings_kinds_check
  check (cardinality(kinds) between 1 and 4 and kinds <@ array['lend', 'sell', 'do', 'gather']);

drop function if exists public.save_offering(uuid, text, text, text, double precision, double precision, boolean, text, numeric, uuid, text, boolean, uuid[], timestamptz);
drop function if exists public.offerings_near(double precision, double precision, double precision, text[]);
