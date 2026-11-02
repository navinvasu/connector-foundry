-- One-off cleanup for a LOCAL dev database created before the dedupe
-- indexes (uq_operations_project_method_path, uq_canonical_tools_project_name,
-- uq_review_items_open). Repeat imports/compiles appended a full duplicate row
-- set each time (~100 tools became 1242); this collapses each group back to
-- one row. NOT a migration: production gets the indexes on an empty schema.
--
-- Run:  psql "$DATABASE_URL" -f dedupe-duplicate-tools.sql
-- (default local: psql postgres://postgres:postgres@localhost:5432/connector_foundry
--   -f projects/connector-foundry/scripts/dedupe-duplicate-tools.sql)
-- Back up first if the data matters: pg_dump "$DATABASE_URL" > /tmp/cf-backup.sql
-- Safe to re-run: with no duplicates every statement deletes zero rows.
--
-- What survives per group, and why it is safe:
--   tools: one keeper per (project_id, name) — a row already frozen into a
--     release first, else the highest status
--     (released > tested > approved > candidate), else the earliest row.
--     References are repointed to the keeper BEFORE deleting (release_tools,
--     eval_results, fix_suggestions, eval_custom_scenarios, review_items carry
--     plain tool ids with no FK), so releases and eval history stay intact.
--     The dupes' own recovery rules die with them (they were compiled
--     identical); the keeper keeps its own.
--   operations: earliest row per (project_id, http_method, path). Nothing
--     references operations, so this is a plain delete.
--   review items: earliest OPEN row per (project_id, kind, title). Answered
--     rows are history and are left alone.

BEGIN;

-- 0. How bad is it? (reported back by the counts at the end too)
CREATE TEMP TABLE dup_before AS
SELECT (SELECT COUNT(*) FROM canonical_tools) AS tools,
       (SELECT COUNT(*) FROM operations) AS operations,
       (SELECT COUNT(*) FROM review_items WHERE status = 'open') AS open_review;

-- 1. Keeper per (project_id, name).
CREATE TEMP TABLE tool_keepers AS
SELECT DISTINCT ON (project_id, name) id AS keeper_id, project_id, name
FROM canonical_tools
ORDER BY project_id, name,
  EXISTS (SELECT 1 FROM release_tools rt WHERE rt.tool_id = canonical_tools.id) DESC,
  (CASE status WHEN 'released' THEN 4 WHEN 'tested' THEN 3 WHEN 'approved' THEN 2 ELSE 1 END) DESC,
  created_at ASC, id ASC;

-- 2. Repoint every tool reference at its keeper.
-- release_tools PK is (release_id, tool_id): drop a dupe row where the keeper
-- is already frozen into the same release, repoint the rest.
DELETE FROM release_tools rt USING canonical_tools t, tool_keepers k
WHERE t.id = rt.tool_id
  AND t.project_id = k.project_id AND t.name = k.name AND t.id <> k.keeper_id
  AND EXISTS (SELECT 1 FROM release_tools x
              WHERE x.release_id = rt.release_id AND x.tool_id = k.keeper_id);
UPDATE release_tools rt SET tool_id = k.keeper_id
FROM canonical_tools t, tool_keepers k
WHERE t.id = rt.tool_id
  AND t.project_id = k.project_id AND t.name = k.name AND t.id <> k.keeper_id;

UPDATE eval_results er SET tool_id = k.keeper_id
FROM canonical_tools t, tool_keepers k
WHERE t.id = er.tool_id
  AND t.project_id = k.project_id AND t.name = k.name AND t.id <> k.keeper_id;

UPDATE fix_suggestions fs SET tool_id = k.keeper_id
FROM canonical_tools t, tool_keepers k
WHERE t.id = fs.tool_id
  AND t.project_id = k.project_id AND t.name = k.name AND t.id <> k.keeper_id;

UPDATE eval_custom_scenarios es SET tool_id = k.keeper_id
FROM canonical_tools t, tool_keepers k
WHERE t.id = es.tool_id
  AND t.project_id = k.project_id AND t.name = k.name AND t.id <> k.keeper_id;

UPDATE review_items ri SET tool_id = k.keeper_id
FROM canonical_tools t, tool_keepers k
WHERE t.id = ri.tool_id
  AND t.project_id = k.project_id AND t.name = k.name AND t.id <> k.keeper_id;

-- 3. Delete the dupe tool rows (their recovery rules go with them).
DELETE FROM canonical_tools t USING tool_keepers k
WHERE t.project_id = k.project_id AND t.name = k.name AND t.id <> k.keeper_id;

-- 4. Collapse duplicate operations (earliest import wins).
DELETE FROM operations a USING operations b
WHERE a.project_id = b.project_id
  AND a.http_method = b.http_method
  AND a.path = b.path
  AND (b.created_at, b.id) < (a.created_at, a.id);

-- 5. Collapse duplicate open review warnings (earliest wins).
DELETE FROM review_items a USING review_items b
WHERE a.project_id = b.project_id
  AND a.kind = b.kind
  AND a.title = b.title
  AND a.status = 'open' AND b.status = 'open'
  AND (b.created_at, b.id) < (a.created_at, a.id);

-- 6. Before / after.
SELECT b.tools AS tools_before, (SELECT COUNT(*) FROM canonical_tools) AS tools_after,
       b.operations AS operations_before, (SELECT COUNT(*) FROM operations) AS operations_after,
       b.open_review AS open_review_before,
       (SELECT COUNT(*) FROM review_items WHERE status = 'open') AS open_review_after
FROM dup_before b;

DROP TABLE dup_before;
DROP TABLE tool_keepers;

COMMIT;
