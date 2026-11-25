-- BC Dads Golf: the top toggle now says Use and Build (it used to say Create), so the guide's first page does too.
-- Safe to run more than once. Changes one word on one page of the one guide.

update public.splashes
   set pages = jsonb_set(pages, '{0,body}', to_jsonb(replace(pages->0->>'body', 'Create is where', 'Build is where')))
 where id = 'howto-v1' and pages->0->>'body' like '%Create is where%';
