import type { SupabaseClient } from '@supabase/supabase-js';
import type { WhatsAppConfig } from '@/types';

// ============================================================
// Resolve which whatsapp_config row an outbound send on an existing
// conversation should use, now that an account can have 1-4 numbers
// (037_whatsapp_config_multi_number.sql).
//
// Replaces the `whatsapp_config.select('*').eq('account_id', x).single()`
// pattern duplicated across send-message.ts, automations/meta-send.ts,
// and flows/meta-send.ts (4 call sites) — those all assumed exactly one
// row per account, which stopped being true once multi-number shipped.
// ============================================================

/**
 * Resolve the WhatsApp number a conversation should send through:
 * the conversation's own `whatsapp_config_id` if set (it arrived on, or
 * was started from, a specific number), otherwise the account's
 * `is_default` number. Throws a plain `Error` with a caller-safe
 * message if neither resolves to a row — callers that need a typed
 * error (e.g. `SendMessageError`) should catch and re-wrap.
 */
export async function resolveWhatsappConfigForConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<WhatsAppConfig> {
  const { data: conversation } = await db
    .from('conversations')
    .select('whatsapp_config_id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (conversation?.whatsapp_config_id) {
    const { data: config } = await db
      .from('whatsapp_config')
      .select('*')
      .eq('id', conversation.whatsapp_config_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (config) return config as WhatsAppConfig;
    // Row referenced by the conversation is gone (deleted number) —
    // fall through to the account's default rather than failing a
    // send that could still go out on another connected number.
  }

  const { data: defaultConfig } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_default', true)
    .maybeSingle();

  if (!defaultConfig) {
    throw new Error('WhatsApp not configured for this account');
  }
  return defaultConfig as WhatsAppConfig;
}

/**
 * Resolve *a* usable WhatsApp config for account-level (not per-number)
 * Meta operations — template management and diagnostics, which live at
 * the WABA level in Meta's model, not per phone number. Multiple numbers
 * under the same WABA share the same template catalog, so any row's
 * token works; prefers the account's `is_default` row, falling back to
 * any other row. Returns `null` if the account has no numbers at all.
 */
export async function resolveAnyWhatsappConfigForAccount(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsAppConfig | null> {
  const { data: defaultConfig } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .eq('is_default', true)
    .maybeSingle();
  if (defaultConfig) return defaultConfig as WhatsAppConfig;

  const { data: anyConfig } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .limit(1)
    .maybeSingle();
  return (anyConfig as WhatsAppConfig) ?? null;
}
