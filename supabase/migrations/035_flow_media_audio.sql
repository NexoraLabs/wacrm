-- ============================================================
-- 035_flow_media_audio.sql
--
-- Adds audio (voice note) support to the `flow-media` bucket, matching
-- what `chat-media` (023_chat_media.sql) already allows and what
-- `sendMediaMessage` (src/lib/whatsapp/meta-api.ts) already sends —
-- the Flows engine could send audio via Meta's API all along, it was
-- only the builder's `send_media` node that never offered it as a
-- media type.
--
-- Same Meta-accepted outbound audio set as chat-media: audio/ogg
-- (Opus), audio/mpeg, audio/aac, audio/mp4, audio/amr.
--
-- Uses the full ON CONFLICT DO UPDATE (not `||` append) so re-running
-- this migration doesn't duplicate entries in allowed_mime_types.
--
-- Idempotent — safe to re-run.
-- ============================================================

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'flow-media',
  'flow-media',
  TRUE,
  16777216, -- 16 MB (Meta video cap; documents/images/audio fit under this)
  ARRAY[
    -- Images
    'image/png', 'image/jpeg', 'image/webp',
    -- Videos
    'video/mp4', 'video/3gpp',
    -- Documents
    'application/pdf',
    'application/vnd.ms-powerpoint',
    'application/msword',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    -- Audio (voice notes) — only Meta-accepted outbound types.
    'audio/ogg',
    'audio/mpeg',
    'audio/aac',
    'audio/mp4',
    'audio/amr'
  ]
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;
