-- Optional WhatsApp number to alert when the AI gives up on a
-- conversation (handoff / reply cap / blocked fabrication) and nobody
-- else is watching the in-app notification bell. Sent as a free-form
-- WhatsApp text from the account's own connected number — only
-- delivers while that number is within Meta's 24h customer-service
-- window with the owner's phone (see notify-owner-whatsapp.ts).
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS owner_notification_phone TEXT;
