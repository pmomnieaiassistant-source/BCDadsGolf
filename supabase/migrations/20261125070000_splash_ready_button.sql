-- What's new screen for the "Ready to build" button (shown once to everyone; each member can hide it).
-- Re-runnable. Deletes nothing.
insert into public.splashes (id, kind, title, pages) values (
  'whatsnew-0-5-3', 'whatsnew', 'Ready to build',
  '[
    {"icon": "check", "title": "Put an idea in the build queue", "body": "When the group has talked an idea through, open it and tap Ready to build. Changed your mind? Tap Take it back. You can do this until Claude starts building."},
    {"icon": "star",  "title": "Then Claude builds it",          "body": "Once Claude starts building, the idea is locked. When it is done it moves to the Features tab, and the conversation stays open there."}
  ]'::jsonb
) on conflict (id) do nothing;
