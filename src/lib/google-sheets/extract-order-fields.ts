import type { SupabaseClient } from '@supabase/supabase-js';

import { loadAiConfig } from '@/lib/ai/config';
import { buildConversationContext } from '@/lib/ai/context';
import { generateReply } from '@/lib/ai/generate';

export interface ExtractedOrderFields {
  name?: string;
  phone?: string;
  address?: string;
  city?: string;
  department?: string;
  neighborhood?: string;
  quantity?: string;
}

const FIELD_KEYS: (keyof ExtractedOrderFields)[] = [
  'name',
  'phone',
  'address',
  'city',
  'department',
  'neighborhood',
  'quantity',
];

/**
 * Prompt for pulling shipping/order details out of a WHOLE
 * conversation transcript, not a single message — a customer closing
 * a sale by chat (see the manual "Registrar pedido" action) typically
 * spreads name/phone/address/city/department across several separate
 * messages, sometimes with corrections along the way ("no, el
 * departamento es Cundinamarca"), so the model needs the full back-
 * and-forth, not just the latest message.
 */
export function buildOrderExtractionPrompt(): string {
  return [
    'You extract order/shipping data from a WhatsApp sales conversation between a customer and a business.',
    'Read the whole conversation — the customer may have given pieces of this across several messages, and may have corrected an earlier value later on (prefer the correction).',
    'Extract these fields if present anywhere in the conversation:',
    '- "name": the customer\'s full name',
    '- "phone": a contact phone number the customer gave (may differ from their WhatsApp number)',
    '- "address": their delivery address',
    '- "city": their city',
    '- "department": their department/state',
    '- "neighborhood": their neighborhood/barrio',
    '- "quantity": how many units they want (as a plain number string, e.g. "1" or "2")',
    'Reply with ONLY a JSON object mapping each key above to the value you found as plain text, or null if that field never appears in the conversation. No prose, no markdown code fences — just the raw JSON object.',
  ].join('\n');
}

/**
 * Same defensive parsing style as the flow engine's
 * `parseFieldExtractionResponse` — invalid JSON, wrong shape, or an
 * unrecognized/non-string value is dropped rather than guessed at.
 */
export function parseOrderExtractionResponse(raw: string): ExtractedOrderFields {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

  const result: ExtractedOrderFields = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!FIELD_KEYS.includes(key as keyof ExtractedOrderFields)) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) result[key as keyof ExtractedOrderFields] = trimmed;
  }
  return result;
}

/**
 * Best-effort — returns `{}` (never throws) whenever there's no AI
 * configured, nothing to read, or the provider call/parse fails, so a
 * caller can always safely fall back to the contact record's own
 * fields (see the manual "Registrar pedido" GET endpoint).
 */
export async function extractOrderFieldsFromConversation(
  db: SupabaseClient,
  accountId: string,
  conversationId: string,
): Promise<ExtractedOrderFields> {
  try {
    const aiConfig = await loadAiConfig(db, accountId);
    if (!aiConfig) return {};

    const messages = await buildConversationContext(db, conversationId);
    if (messages.length === 0) return {};

    const { text } = await generateReply({
      config: aiConfig,
      systemPrompt: buildOrderExtractionPrompt(),
      messages,
    });
    return parseOrderExtractionResponse(text);
  } catch (err) {
    console.error('[register-order] AI field extraction failed:', err);
    return {};
  }
}
