-- Offerings get up to six photos instead of one.
--
-- photo_urls holds them in order; photo_url stays as the first (the cover),
-- so markers, message cards and older app builds keep working unchanged.
--
-- Apply this, then sql/offerings-schema.sql again:
--   supabase db query --linked -f sql/offering-photos-migration.sql
--   supabase db query --linked -f sql/offerings-schema.sql

alter table public.offerings add column if not exists photo_urls text[];
update public.offerings
   set photo_urls = case when photo_url is null then '{}'::text[] else array[photo_url] end
 where photo_urls is null;
alter table public.offerings alter column photo_urls set default '{}';
alter table public.offerings alter column photo_urls set not null;
alter table public.offerings drop constraint if exists offerings_photo_urls_check;
alter table public.offerings add constraint offerings_photo_urls_check
  check (cardinality(photo_urls) <= 6);

-- Both functions change shape (a new argument, a new column), so the schema
-- file can't replace them in place.
drop function if exists public.save_offering(uuid, text, text, text, double precision, double precision, boolean, text, numeric, uuid, text, boolean, uuid[], timestamptz, text[]);
drop function if exists public.offerings_near(double precision, double precision, double precision, text[]);
