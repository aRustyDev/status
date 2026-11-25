-- Tags belong to the component revision and are updated atomically with it.
ALTER TABLE components ADD COLUMN tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags) AND json_type(tags) = 'array');
