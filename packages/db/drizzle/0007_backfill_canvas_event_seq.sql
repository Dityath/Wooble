-- Renumber existing events so seq follows the historical order (created_at, id). Adding the identity column in 0006
-- numbered rows in physical order. The unique constraint is checked per row, so go through negative values first.
UPDATE "canvas_events" SET "seq" = -"ordered"."position"
FROM (
  SELECT "id", row_number() OVER (ORDER BY "created_at" ASC, "id" ASC) AS "position" FROM "canvas_events"
) AS "ordered"
WHERE "canvas_events"."id" = "ordered"."id";--> statement-breakpoint
UPDATE "canvas_events" SET "seq" = -"seq";--> statement-breakpoint
-- New inserts must sort after every backfilled row. On an empty table the next value is 1.
SELECT setval(
  pg_get_serial_sequence('"canvas_events"', 'seq'),
  coalesce((SELECT max("seq") FROM "canvas_events"), 1),
  (SELECT count(*) > 0 FROM "canvas_events")
);
