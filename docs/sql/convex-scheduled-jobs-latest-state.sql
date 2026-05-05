-- Convex _scheduled_jobs latest-state monitor.
--
-- IMPORTANT:
-- Do not count raw rows from public.documents with only `WHERE NOT deleted`.
-- Convex stores multiple versions for the same document id, so one scheduled
-- job can appear as pending, inProgress, and success in historical rows.
--
-- Usage:
--   docker exec adpilot-postgres psql -U convex -d adpilot_prod \
--     -f /path/in/container/convex-scheduled-jobs-latest-state.sql

\timing on

WITH latest AS (
  SELECT DISTINCT ON (id)
    id,
    ts,
    deleted,
    convert_from(json_value, 'UTF8')::jsonb AS j
  FROM documents
  WHERE table_id = decode('7ee519d746cd4bc3221534e5d95c5010', 'hex')
  ORDER BY id, ts DESC
)
SELECT
  j #>> '{state,type}' AS state_type,
  count(*) AS rows
FROM latest
WHERE NOT deleted
GROUP BY 1
ORDER BY count(*) DESC;

WITH latest AS (
  SELECT DISTINCT ON (id)
    id,
    ts,
    deleted,
    convert_from(json_value, 'UTF8')::jsonb AS j
  FROM documents
  WHERE table_id = decode('7ee519d746cd4bc3221534e5d95c5010', 'hex')
  ORDER BY id, ts DESC
)
SELECT
  j ->> 'udfPath' AS udf_path,
  j #>> '{state,type}' AS state_type,
  count(*) AS rows
FROM latest
WHERE NOT deleted
GROUP BY 1, 2
ORDER BY rows DESC
LIMIT 30;

WITH latest AS (
  SELECT DISTINCT ON (id)
    id,
    ts,
    deleted,
    convert_from(json_value, 'UTF8')::jsonb AS j
  FROM documents
  WHERE table_id = decode('7ee519d746cd4bc3221534e5d95c5010', 'hex')
  ORDER BY id, ts DESC
)
SELECT
  j ->> 'udfPath' AS udf_path,
  count(*) AS failed
FROM latest
WHERE NOT deleted
  AND j #>> '{state,type}' = 'failed'
GROUP BY 1
ORDER BY failed DESC
LIMIT 30;
