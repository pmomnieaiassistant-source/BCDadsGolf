# BC Dads Golf

A golf scoring app that the group designs in the open. **Create** is where ideas are posted and discussed; **Use** is the scoring app, which starts blank and grows as ideas get built. See `CLAUDE.md` for how ideas become features.

## One-time setup

1. **Set the codes.** Open `supabase/schema.sql` and change `CHANGE-ME-INVITE` (the code you give the dads) and `CHANGE-ME-ADMIN` (your own code, which makes you the admin).
2. **Run the database setup.** In Supabase, open SQL Editor, New query, paste the whole of `supabase/schema.sql`, and press Run.
3. **Turn on anonymous sign-ins.** Supabase, Authentication, Sign In / Providers, switch on "Allow anonymous sign-ins". Members join with the group code and a display name instead of an email.
4. **Publish the site.** GitHub repo, Settings, Pages, deploy from the `main` branch, root folder.
5. **Join as admin.** Open the site, enter your admin code and your name. Share the invite code with everyone else.

## Not built yet

- The AI layer (summaries, open questions, "what we would implement" specs). It needs a small Supabase function that holds the Anthropic API key.
- The Use side (the scoring app itself).
