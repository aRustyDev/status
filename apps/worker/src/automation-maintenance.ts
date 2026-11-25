/** SQL predicates use `h` for the check and `o` for the queued job. */
const affectsCheck = `(NOT EXISTS (SELECT 1 FROM maintenance_components mc WHERE mc.maintenance_id=m.id)
  OR EXISTS (SELECT 1 FROM maintenance_components mc WHERE mc.maintenance_id=m.id AND mc.component_id=h.component_id))`
export const outsideMaintenance = `(NOT EXISTS (SELECT 1 FROM maintenance m WHERE m.cancelled=0 AND m.starts_at<=? AND m.ends_at>? AND ${affectsCheck}))`
// A queued pre-window job waits for a fresh observation after every overlapping window.
export const maintenanceBarrier = `(NOT EXISTS (SELECT 1 FROM maintenance m WHERE m.cancelled=0 AND m.starts_at<=? AND m.ends_at>o.observed_at AND ${affectsCheck}
  AND (m.ends_at>? OR h.last_result_at IS NULL OR h.last_result_at<m.ends_at)))`
export const overlappedMaintenance = `(EXISTS (SELECT 1 FROM maintenance m WHERE m.cancelled=0 AND m.starts_at<=? AND m.ends_at>o.observed_at AND ${affectsCheck}))`
// If an already-scheduled window starts while the final D1 read is in flight,
// defer rather than send using the time sampled before that read.
export const nextMaintenanceStart = `(SELECT MIN(m.starts_at) FROM maintenance m WHERE m.cancelled=0 AND m.starts_at>? AND m.ends_at>o.observed_at AND ${affectsCheck})`
export const currentCheckStatus = `(CASE WHEN h.last_effective_scheduled_at=h.last_scheduled_at THEN COALESCE(h.last_effective_status,h.last_status) ELSE h.last_status END)`
