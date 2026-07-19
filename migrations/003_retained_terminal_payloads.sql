ALTER TABLE jobs DROP CONSTRAINT jobs_result_state;

ALTER TABLE jobs ADD CONSTRAINT jobs_result_state CHECK (
  (status = 'succeeded' AND (result IS NOT NULL OR deleted_at IS NOT NULL))
  OR status <> 'succeeded'
);

CREATE INDEX jobs_retention_idx ON jobs(result_expires_at)
WHERE result_expires_at IS NOT NULL;
