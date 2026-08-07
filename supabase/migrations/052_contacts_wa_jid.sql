-- ============================================================
-- 052_contacts_wa_jid.sql — persist the exact inbound WhatsApp JID
-- for QR/Baileys-connected contacts.
--
-- Root cause of "bot doesn't reply" for a subset of QR contacts:
-- WhatsApp's privacy-preserving LID addressing sometimes never
-- reveals a contact's real phone number to a business number (no
-- `remoteJidAlt` is ever delivered, not even after several inbound
-- messages). Outbound QR sends reconstruct a JID from `contacts.phone`
-- via phoneToJid() — for these contacts that's a fabricated
-- `<lid-digits>@s.whatsapp.net` JID (not a real recipient), so
-- WhatsApp silently drops the send. No error surfaces anywhere; the
-- CRM shows the bot's reply as "sent".
--
-- Fix: store the exact `key.remoteJid` Baileys delivered on the most
-- recent inbound message (correct whether it's a normal
-- `<phone>@s.whatsapp.net` or a `<lid>@lid` JID — Baileys maintains
-- its own LID<->PN mapping internally and resolves either form
-- correctly for encryption/delivery) and send back to that exact
-- JID instead of reconstructing one from the (possibly wrong)
-- "phone" field.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS wa_jid text;

COMMENT ON COLUMN contacts.wa_jid IS
  'Exact WhatsApp JID (e.g. 573001234567@s.whatsapp.net or 123456789@lid) from the most recent inbound QR/Baileys message. Used to address outbound QR sends directly, bypassing phone-number reconstruction which breaks for LID-addressed contacts. Null for contacts that only ever came in via Cloud API (Meta sends are addressed by phone_number_id, not JID) or that predate this column.';
