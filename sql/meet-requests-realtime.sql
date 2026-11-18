-- Let the person showing a QR code hear about the scan right away.
--
-- js/meet.js subscribes to UPDATEs on the user's own meet_requests row so the
-- QR screen can flip to "Connected with ..." when the other person scans it.
-- The table was never added to the Realtime publication, so that event never
-- arrived and the QR screen sat there until it was closed by hand.
--
-- The app also polls as a fallback, so this is a speed-up rather than a
-- requirement. Safe to run more than once.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'meet_requests'
  ) then
    alter publication supabase_realtime add table public.meet_requests;
  end if;
end $$;
