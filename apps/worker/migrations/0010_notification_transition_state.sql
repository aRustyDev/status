-- Shared automation state is independent of the public check status during maintenance.
CREATE TABLE automation_transition_state (
  check_id TEXT PRIMARY KEY REFERENCES http_checks(id) ON DELETE CASCADE,
  check_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('up','degraded','down')),
  generation INTEGER NOT NULL DEFAULT 0
);
-- During an active window, only an observation from before the earliest matching
-- window can establish the baseline. Unknown history stays unknown until a valid sample.
WITH active_windows AS (
  SELECT h.id AS check_id, MIN(m.starts_at) AS starts_at FROM http_checks h JOIN maintenance m
    ON m.cancelled=0 AND m.starts_at<=CAST(strftime('%s','now') AS INTEGER)*1000
      AND m.ends_at>CAST(strftime('%s','now') AS INTEGER)*1000
      AND (NOT EXISTS (SELECT 1 FROM maintenance_components mc WHERE mc.maintenance_id=m.id)
        OR EXISTS (SELECT 1 FROM maintenance_components mc WHERE mc.maintenance_id=m.id AND mc.component_id=h.component_id))
  GROUP BY h.id
), baselines AS (
  SELECT h.id,h.config_version,CASE WHEN h.transition_suppressed=1 THEN NULL WHEN aw.check_id IS NULL AND NOT EXISTS (
    SELECT 1 FROM maintenance m WHERE m.cancelled=0 AND m.starts_at<=h.last_result_at AND m.ends_at>h.last_result_at
      AND (NOT EXISTS (SELECT 1 FROM maintenance_components mc WHERE mc.maintenance_id=m.id)
        OR EXISTS (SELECT 1 FROM maintenance_components mc WHERE mc.maintenance_id=m.id AND mc.component_id=h.component_id))
  ) THEN CASE WHEN h.last_effective_scheduled_at=h.last_scheduled_at THEN COALESCE(h.last_effective_status,h.last_status) ELSE h.last_status END
  ELSE (SELECT COALESCE(r.effective_status,r.status) FROM http_check_results r
    WHERE r.check_id=h.id AND r.config_version=h.config_version AND r.completed_at<=h.last_result_at
      AND (aw.check_id IS NULL OR r.completed_at<aw.starts_at)
      AND NOT EXISTS (SELECT 1 FROM maintenance m WHERE m.cancelled=0 AND m.starts_at<=r.completed_at AND m.ends_at>r.completed_at
        AND (NOT EXISTS (SELECT 1 FROM maintenance_components mc WHERE mc.maintenance_id=m.id)
          OR EXISTS (SELECT 1 FROM maintenance_components mc WHERE mc.maintenance_id=m.id AND mc.component_id=h.component_id)))
    ORDER BY r.completed_at DESC,r.scheduled_at DESC LIMIT 1) END AS status
  FROM http_checks h LEFT JOIN active_windows aw ON aw.check_id=h.id
)
INSERT INTO automation_transition_state (check_id,check_version,status)
SELECT id,config_version,status FROM baselines WHERE status IS NOT NULL;
ALTER TABLE notification_outbox ADD COLUMN transition_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_outbox ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0;
UPDATE notification_outbox SET observed_at=COALESCE((SELECT completed_at FROM http_check_results r
 WHERE r.check_id=notification_outbox.check_id AND r.config_version=notification_outbox.check_version
 AND r.scheduled_at=notification_outbox.scheduled_at),scheduled_at);
ALTER TABLE worker_action_outbox ADD COLUMN transition_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE worker_action_outbox ADD COLUMN observed_at INTEGER NOT NULL DEFAULT 0;
UPDATE worker_action_outbox SET observed_at=COALESCE((SELECT completed_at FROM http_check_results r
 WHERE r.check_id=worker_action_outbox.check_id AND r.config_version=worker_action_outbox.check_version
 AND r.scheduled_at=worker_action_outbox.scheduled_at),scheduled_at);
-- Pre-generation jobs cannot be proved current. Fail closed rather than replay
-- a stale event after an upgrade; claimed actions retain their uncertain outcome.
UPDATE notification_outbox SET state='failed',error_code='unavailable',lease_token=NULL,lease_until=NULL,
  updated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE state IN ('pending','sending');
UPDATE worker_action_outbox SET state='unavailable',updated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE state='pending';
UPDATE worker_action_outbox SET state='uncertain',updated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE state='executing';
