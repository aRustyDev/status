-- Email recipients are deployment-approved IDs; addresses remain in Worker configuration.
ALTER TABLE notification_channels ADD COLUMN channel_type TEXT NOT NULL DEFAULT 'webhook' CHECK (channel_type IN ('webhook','email'));
ALTER TABLE notification_channels ADD COLUMN recipient_id TEXT;
ALTER TABLE notification_channels ADD COLUMN email_fingerprint TEXT;
