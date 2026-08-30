-- 0003_pipeline_control.sql
--
-- The AI pipeline's on/off switch.
--
-- The worker service and the admin panel run on different hosts and cannot
-- reach each other; this row is the channel between them. The admin panel
-- writes `enabled`, the worker polls it and writes the `worker_*` columns back
-- so the panel can show what is really happening rather than what was asked for.
--
-- Additive and idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS pipeline_control (
  -- Single-row guard: the primary key may only ever hold `true`.
  id              boolean PRIMARY KEY DEFAULT true,
  enabled         boolean NOT NULL DEFAULT false,
  updated_at      timestamp NOT NULL DEFAULT now(),
  updated_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  worker_state    text,
  worker_note     text,
  worker_topic    text,
  worker_seen_at  timestamp,
  CONSTRAINT pipeline_control_single_row CHECK (id)
);

-- Seed the one row, switched OFF.
--
-- ON CONFLICT DO NOTHING, not an upsert: re-running this migration must never
-- stop a pipeline that someone has since started.
INSERT INTO pipeline_control (id, enabled)
VALUES (true, false)
ON CONFLICT (id) DO NOTHING;
