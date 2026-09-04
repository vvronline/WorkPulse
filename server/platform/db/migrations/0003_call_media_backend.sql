ALTER TABLE call_logs
  ADD COLUMN IF NOT EXISTS media_backend VARCHAR(10) NOT NULL DEFAULT 'p2p';

DO $$
BEGIN
  ALTER TABLE call_logs
    ADD CONSTRAINT call_logs_media_backend_check
    CHECK (media_backend IN ('p2p', 'livekit'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
