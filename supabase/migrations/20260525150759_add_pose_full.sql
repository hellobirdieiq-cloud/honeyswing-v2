ALTER TABLE swings ADD COLUMN IF NOT EXISTS pose_full JSONB;
ALTER TABLE swings ALTER COLUMN pose_full SET STORAGE EXTERNAL;
COMMENT ON COLUMN swings.pose_full IS 'RTMW 133-keypoint per-frame array. Excluded from default SELECTs. Approx 200-360 KB per swing.';

ALTER TABLE swings ADD COLUMN IF NOT EXISTS pose_source TEXT;
COMMENT ON COLUMN swings.pose_source IS 'Pose-model identity tag for this swing, e.g. ''rtmw-l-2d-v1''. NULL = pre-RTMW (BlazePose 3D) OR a post-migration row whose fire-and-forget pose_full write failed. Used by future depth/3D pose workstreams to query which preserved-video swings are eligible for re-extraction.';

-- DOWN
-- ALTER TABLE swings DROP COLUMN IF EXISTS pose_source;
-- ALTER TABLE swings DROP COLUMN IF EXISTS pose_full;
