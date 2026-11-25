-- BC Dads Golf: new wording for the how-it-works guide.
-- The last page no longer names anyone, and says how ideas really become features:
-- the group talks it through, it goes in the build queue, and Claude builds it.
-- Safe to run more than once. Only changes the text of the one guide, and nobody has seen it yet
-- (the splash screen ships in the same release), so nobody's "Don't show again" choice is affected.

update public.splashes set pages = '[
  {"icon": "flag",    "title": "Welcome",              "body": "BC Dads Golf is built by the group, for the group. Use is where our golf scoring will live. Create is where we decide what it becomes."},
  {"icon": "ideas",   "title": "Share an idea",        "body": "Tap \"What should the app do?\" to post an idea. Add photos or a poll. Everyone can like it, comment, and reply to each other."},
  {"icon": "reply",   "title": "Talk it through",      "body": "Swipe right on a comment to reply. Double-tap to like. Swipe in from the left edge to go back, and pull down on the feed to refresh."},
  {"icon": "sparkle", "title": "The assistant helps",  "body": "It sums up each idea and asks the questions that still need an answer, until the idea is clear enough to build."},
  {"icon": "star",    "title": "From idea to feature", "body": "1. The group talks an idea through.\n2. When it is ready, it goes in the build queue.\n3. Claude builds it, and it lands on the Features tab with a link back to the conversation."}
]'::jsonb
where id = 'howto-v1';
