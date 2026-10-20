-- Rows from before 0008 do not record where they came from, and 0008 marked them all as invited. Viewers of a canvas that
-- is shared by link right now may have joined through the link, so they are treated as link members (#62): they keep
-- access while the link stays open and lose it when sharing is restricted. Editors and viewers of restricted canvases
-- stay invited. An invited viewer of a link-shared canvas has to be invited again if sharing is restricted later.
UPDATE "canvas_members" SET "origin" = 'link'
FROM "canvases"
WHERE "canvases"."id" = "canvas_members"."canvas_id"
  AND "canvases"."share_mode" = 'link'
  AND "canvas_members"."role" = 'viewer';
