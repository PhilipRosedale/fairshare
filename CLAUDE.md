# FairShare (Union)

Project rules are shared with Cursor and live in `.cursor/rules/`. Follow them:

@.cursor/rules/sql-changes.mdc
@.cursor/rules/capacitor-ios-workflow.mdc
@.cursor/rules/capacitor-android-workflow.mdc
@.cursor/rules/www-is-build-output.mdc
@.cursor/rules/push-notifications-doc.mdc

## Notes for Claude Code

- This Mac uses zsh, not PowerShell. Ignore the PowerShell-specific notes above
  (`.ps1` scripts, dollar-quoting), but still prefer `supabase db query --linked -f <file>`.
- SQL: apply every new or changed `sql/*.sql` file yourself with the command above
  as soon as it is written, then confirm it succeeded.
- App changes: after the last edit in a turn that touches anything shipped in the
  app (HTML, CSS, JS, images, or native iOS/Android code), run `npm run cap:sync`
  yourself and confirm it succeeded. Prefix it with
  `LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8`: the agent shell has no locale set and
  CocoaPods crashes with "Unicode Normalization not appropriate for ASCII-8BIT".
- Edge Functions: deploy changed functions with `supabase functions deploy <name>`.
