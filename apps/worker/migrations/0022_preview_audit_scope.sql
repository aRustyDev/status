-- Store only the one-way lease hash, never the preview selector itself.
ALTER TABLE audit_events ADD COLUMN preview_scope TEXT;
