/**
 * Flow runner.
 *
 * The single entry point `dispatchInboundToFlows` is called by the
 * WhatsApp webhook on every inbound message *for an account that has
 * opted into the Flows beta*. It decides whether the message belongs
 * to an active conversation flow (advance it) or matches the entry
 * trigger of an active flow (start a new run) — and reports back to
 * the webhook so the webhook knows whether to also fire automations.
 *
 * Architecture in a sentence: the runner walks the customer through
 * a DB-stored node graph, suspending only at nodes that need
 * customer input. Each tap or text reply wakes it back up.
 *
 * What lives here vs elsewhere:
 *   - Pure decision logic (which button matched, where to advance to,
 *     when to fallback) — here.
 *   - DB shape (table reads/writes) — here.
 *   - Meta API calls — `meta-send.ts` (engineSendInteractive*).
 *   - Policy resolution (reprompt vs handoff vs end) — `fallback.ts`.
 *   - Type definitions — `types.ts`.
 *
 * Concurrency model:
 *   - Idempotency on `meta_message_id`: the runner refuses to advance
 *     an active run twice for the same Meta message — protects against
 *     Meta's retries.
 *   - Optimistic UPDATE with `current_node_key` precondition: two
 *     simultaneous taps for the same run collide at the DB layer; the
 *     second is a no-op.
 *   - Partial unique index `idx_one_active_run_per_contact`: two
 *     simultaneous starts for the same contact collide; the second
 *     INSERT raises 23505 and the runner catches & exits.
 */

import { supabaseAdmin } from "./admin-client";
import {
  engineSendInteractiveButtons,
  engineSendInteractiveList,
  engineSendMedia,
  engineSendText,
} from "./meta-send";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { loadAiConfig } from "@/lib/ai/config";
import { buildConversationContext } from "@/lib/ai/context";
import { buildSystemPrompt } from "@/lib/ai/defaults";
import { generateReply } from "@/lib/ai/generate";
import { retrieveKnowledge } from "@/lib/ai/knowledge";
import { resolveProductPromptContext } from "@/lib/ai/product-context";
import { latestUserMessage } from "@/lib/ai/query";
import { showTypingIndicator } from "@/lib/whatsapp/typing-indicator";
import { resolveWhatsappConfigForConversation } from "@/lib/whatsapp/resolve-config";
import { exportOrderRow } from "@/lib/google-sheets/export-order";
import {
  type AiReplyNodeConfig,
  type CollectInputNodeConfig,
  type ConditionNodeConfig,
  type DispatchInboundInput,
  type DispatchInboundResult,
  type ExportOrderNodeConfig,
  type FlowKeywordMediaTrigger,
  type FlowNodeRow,
  type FlowRow,
  type FlowRunRow,
  type ParsedInbound,
  type SendButtonsNodeConfig,
  type SendListNodeConfig,
  type SendMediaNodeConfig,
  type SendMessageNodeConfig,
  type SetTagNodeConfig,
  type StartNodeConfig,
  type KeywordTriggerConfig,
} from "./types";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a Supabase / Meta mock.
// ============================================================

/**
 * Given a node + the customer's reply_id, return the next_node_key
 * to advance to, or `null` if no option matches.
 */
export function matchReplyId(
  node: { node_type: string; config: Record<string, unknown> },
  reply_id: string,
): string | null {
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    const hit = cfg.buttons?.find((b) => b.reply_id === reply_id);
    return hit?.next_node_key ?? null;
  }
  if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      const hit = section.rows?.find((r) => r.reply_id === reply_id);
      if (hit) return hit.next_node_key;
    }
    return null;
  }
  return null;
}

/**
 * Scans every node in a flow (not just the current one) for a button or
 * list row with this `reply_id`, and returns what it points to. Used
 * for a tap on a button from a menu the run has already moved past —
 * unlike `matchReplyId`, which only checks the run's current node.
 */
export function findNodeKeyByReplyId(
  nodes: Map<string, { node_type: string; config: Record<string, unknown> }>,
  replyId: string,
): string | null {
  for (const node of nodes.values()) {
    const hit = matchReplyId(node, replyId);
    if (hit) return hit;
  }
  return null;
}

/**
 * Text counterpart to `findNodeKeyByReplyId`, for QR conversations —
 * Baileys has no real button tap, so the equivalent "stale menu tap" is
 * the customer typing a number (or the option's title) after the run
 * that sent that numbered menu has already ended. `matchTextReplyToMenu`
 * already refuses to match anything that isn't a real position/title
 * hit, so trying every send_buttons/send_list node in the flow and
 * taking the first match is safe — nothing here is a guess.
 */
export function findNodeKeyByText(
  nodes: Map<string, { node_type: string; config: Record<string, unknown> }>,
  text: string,
): string | null {
  for (const node of nodes.values()) {
    if (node.node_type !== "send_buttons" && node.node_type !== "send_list") {
      continue;
    }
    const hit = matchTextReplyToMenu(node, text, false);
    if (hit) return hit;
  }
  return null;
}

/**
 * QR-provider counterpart to `matchReplyId`. Baileys has no interactive
 * tap — `engineSendInteractiveButtons`/`List` (meta-send.ts) render the
 * options as a numbered text menu instead, so the customer's reply
 * arrives as plain text. Matches either the option's position number
 * ("1", "2", ...) or its title text (case/accent-insensitive, exact or
 * substring), same normalization style as automations' keyword match.
 */
export function matchTextReplyToMenu(
  node: { node_type: string; config: Record<string, unknown> },
  text: string,
  /** Skip the substring fallback below — set false when there's no
   *  active run pinning this text to a just-sent menu (see
   *  `findNodeKeyByText`), where a genuine sentence that happens to
   *  contain a button's title (e.g. "cómo funciona esto?") would
   *  otherwise be misread as a menu reply instead of a real question. */
  allowPartial = true,
): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const options: Array<{ title: string; next_node_key: string }> = [];
  if (node.node_type === "send_buttons") {
    const cfg = node.config as unknown as SendButtonsNodeConfig;
    for (const b of cfg.buttons ?? []) {
      options.push({ title: b.title, next_node_key: b.next_node_key });
    }
  } else if (node.node_type === "send_list") {
    const cfg = node.config as unknown as SendListNodeConfig;
    for (const section of cfg.sections ?? []) {
      for (const r of section.rows ?? []) {
        options.push({ title: r.title, next_node_key: r.next_node_key });
      }
    }
  } else {
    return null;
  }

  const asPosition = Number(trimmed);
  if (
    Number.isInteger(asPosition) &&
    asPosition >= 1 &&
    asPosition <= options.length
  ) {
    return options[asPosition - 1].next_node_key;
  }

  const normalize = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .trim();
  const needle = normalize(trimmed);
  const exact = options.find((o) => normalize(o.title) === needle);
  if (exact) return exact.next_node_key;
  if (!allowPartial) return null;
  const partial = options.find(
    (o) =>
      normalize(o.title).includes(needle) ||
      needle.includes(normalize(o.title)),
  );
  return partial?.next_node_key ?? null;
}

/**
 * Case-insensitive contains/exact match against a list of keywords.
 * Used by the trigger evaluator. Stable enough that the v3 builder
 * UI can preview matches by passing canned strings.
 */
export function matchesKeywordTrigger(
  text: string,
  cfg: KeywordTriggerConfig,
): boolean {
  if (!text || !cfg.keywords?.length) return false;
  const matchType = cfg.match_type ?? "contains";
  const haystack = cfg.case_sensitive ? text : text.toLowerCase();
  for (const raw of cfg.keywords) {
    if (!raw) continue;
    const needle = cfg.case_sensitive ? raw : raw.toLowerCase();
    if (matchType === "exact" ? haystack === needle : haystack.includes(needle)) {
      return true;
    }
  }
  return false;
}

/** Nodes that advance to a next_node_key without waiting for input. */
export function isAutoAdvancing(node_type: string): boolean {
  return (
    node_type === "start" ||
    node_type === "send_message" ||
    node_type === "send_media" ||
    node_type === "condition" ||
    node_type === "set_tag" ||
    node_type === "export_order"
  );
}

/** Nodes that send a prompt and suspend awaiting a customer reply. */
export function isSuspending(node_type: string): boolean {
  return (
    node_type === "send_buttons" ||
    node_type === "send_list" ||
    node_type === "collect_input"
  );
}

/** Nodes that end the run. */
export function isTerminal(node_type: string): boolean {
  return node_type === "handoff" || node_type === "end";
}

/**
 * Evaluate a `condition` node's predicate against the current run
 * state. Exported pure for unit testing — the engine wraps it with a
 * DB lookup for `tag` / `contact_field` subjects.
 */
export function evaluateConditionPredicate(args: {
  operator: ConditionNodeConfig["operator"];
  /**
   * Resolved value of the subject. `undefined` means the subject is
   * absent (no var with that key / no such tag / contact field is
   * null). Pure function: caller does the DB lookup.
   */
  subjectValue: string | undefined;
  /** The configured comparison value, when applicable. */
  configValue: string | undefined;
}): boolean {
  switch (args.operator) {
    case "present":
      return args.subjectValue !== undefined && args.subjectValue !== "";
    case "absent":
      return args.subjectValue === undefined || args.subjectValue === "";
    case "equals":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue === (args.configValue ?? "");
    case "contains":
      if (args.subjectValue === undefined) return false;
      return args.subjectValue.includes(args.configValue ?? "");
  }
}

/** One still-unanswered `collect_input` node in a checkout-style chain. */
export interface PendingCollectInputField {
  node_key: string;
  var_key: string;
  prompt_text: string;
}

/**
 * Walks forward from `startNode` through contiguous `collect_input`
 * nodes (following `next_node_key`), collecting the ones that don't
 * already have a value in `vars` — i.e. the fields a multi-field reply
 * starting at `startNode` could plausibly answer in one shot. Stops at
 * the first non-`collect_input` node (e.g. `export_order`), a node
 * that already has a value, or a dangling/missing next node. Capped
 * defensively like the advance loop's own cycle guard.
 */
export function collectPendingInputFields(
  nodes: Map<string, FlowNodeRow>,
  startNode: FlowNodeRow,
  vars: Record<string, unknown>,
): PendingCollectInputField[] {
  const fields: PendingCollectInputField[] = [];
  const seen = new Set<string>();
  let node: FlowNodeRow | null = startNode;
  for (let i = 0; i < 32 && node; i += 1) {
    if (node.node_type !== "collect_input" || seen.has(node.node_key)) break;
    seen.add(node.node_key);
    const cfg = node.config as unknown as CollectInputNodeConfig;
    const existing = vars[cfg.var_key];
    if (typeof existing === "string" && existing.trim().length > 0) break;
    fields.push({
      node_key: node.node_key,
      var_key: cfg.var_key,
      prompt_text: cfg.prompt_text,
    });
    node = cfg.next_node_key ? nodes.get(cfg.next_node_key) ?? null : null;
  }
  return fields;
}

/**
 * Cheap gate so a normal one-word reply ("1", "Bogotá") never spends
 * an AI call — only messages that plausibly cram in more than one
 * answer (long, or visibly itemized) are worth extracting from.
 */
export function looksLikeMultiFieldReply(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 15) return false;
  if (/[,;\n]/.test(trimmed)) return true;
  return trimmed.split(/\s+/).filter(Boolean).length >= 5;
}

/**
 * Free fast-path: does this read like a question rather than an
 * answer to whatever `collect_input` field is currently being asked?
 * Without this, a reply like "¿cuánto tarda el envío?" gets captured
 * verbatim as the field's value (e.g. saved as the shipping address)
 * instead of being answered — the capture branch otherwise accepts
 * any non-empty text unconditionally. Only covers the formal case (a
 * "?" or a leading interrogative word) — colloquial phrasing without
 * either ("Y el envío es gratis o lo cobran") slips through this and
 * is caught downstream by `classifyCollectInputReply` instead, since
 * a regex can't reasonably cover every way of asking something.
 */
const QUESTION_STARTERS =
  /^(qu[eé]|c[oó]mo|cu[aá]l|cu[aá]les|cu[aá]ndo|cu[aá]nto|cu[aá]nta|cu[aá]ntos|cu[aá]ntas|d[oó]nde|por qu[eé])\b/i;

export function looksLikeAQuestion(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.includes("?")) return true;
  return QUESTION_STARTERS.test(trimmed);
}

/**
 * Cheap gate for `classifyCollectInputReply` — a one-or-two-word reply
 * ("1", "Bogotá", "La esmeralda") is never worth an AI round trip, it's
 * always a plain field value. Only longer, sentence-like replies (the
 * ones `looksLikeAQuestion` can't reliably parse) get classified.
 */
export function looksWorthClassifying(text: string): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length >= 3;
}

/** Builds the extraction-only system prompt handed to the model. */
export function buildFieldExtractionPrompt(
  fields: PendingCollectInputField[],
): string {
  const fieldList = fields
    .map((f) => `- "${f.var_key}": ${f.prompt_text}`)
    .join("\n");
  return [
    "You extract structured order/shipping data from a single WhatsApp customer message.",
    "The customer may have answered several of the pending questions below in one message, or only one, or none.",
    "Pending fields (key: what it asks for):",
    fieldList,
    "",
    "Reply with ONLY a JSON object mapping each key above to the value you found as plain text, or null if that field isn't present in the message. No prose, no markdown code fences — just the raw JSON object.",
  ].join("\n");
}

/**
 * Parses the model's extraction response into a clean partial vars
 * object. Anything that isn't valid JSON, isn't a plain object, has an
 * unrecognized key, or isn't a non-empty string value is dropped
 * rather than guessed at — a bad extraction should fall back to the
 * normal single-field capture, never write garbage into vars.
 */
export function parseFieldExtractionResponse(
  raw: string,
  fields: PendingCollectInputField[],
): Record<string, string> {
  const validKeys = new Set(fields.map((f) => f.var_key));
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!validKeys.has(key) || typeof value !== "string") continue;
    const trimmedValue = value.trim();
    if (trimmedValue.length > 0) result[key] = trimmedValue;
  }
  return result;
}

// ============================================================
// DB I/O — wrapped in tiny helpers so the dispatch flow stays
// readable. Errors surface as thrown — the entry point catches.
// ============================================================

type AdminClient = ReturnType<typeof supabaseAdmin>;

async function loadActiveRunForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<FlowRunRow | null> {
  // The partial unique index `idx_one_active_run_per_contact` was
  // rebuilt in migration 017 over `(account_id, contact_id)` — so
  // "two active runs for one contact in one account" is impossible
  // by design. But a future migration glitch or manual SQL could
  // create one, and .maybeSingle() throws on >1 row — which would
  // kill dispatch for that contact's webhook entirely. .limit(1) is
  // forgiving: pick the newest, let the cron sweep clean up the
  // stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForContact error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
): Promise<FlowRow | null> {
  // Only text messages can match an entry trigger. Interactive replies
  // are responses to existing prompts; they never start a new flow.
  if (message.kind !== "text") return null;

  // Pull all active flows for this account. Active set is bounded
  // (the builder discourages double-trigger overlap; partial index
  // makes the lookup index-supported).
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;

  const typed = flows as FlowRow[];
  for (const flow of typed) {
    if (flow.trigger_type === "keyword") {
      if (matchesKeywordTrigger(
        message.text,
        flow.trigger_config as KeywordTriggerConfig,
      )) {
        return flow;
      }
    } else if (flow.trigger_type === "first_inbound_message" && isFirstInbound) {
      return flow;
    }
    // 'manual' triggers do not auto-start from inbound messages.
  }
  return null;
}

/**
 * Most recent flow the contact has ever run (any status — active,
 * completed, abandoned), regardless of which flow it was. Used to
 * resolve a stale button tap: the button's `reply_id` only makes sense
 * in the context of whatever flow actually sent it, and a contact
 * realistically only has one flow's menu on screen at a time.
 */
async function findMostRecentFlowIdForContact(
  db: AdminClient,
  accountId: string,
  contactId: string,
): Promise<string | null> {
  const { data } = await db
    .from("flow_runs")
    .select("flow_id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { flow_id: string } | null)?.flow_id ?? null;
}

/**
 * Like `findEntryFlow`'s keyword branch, but callable while a DIFFERENT
 * flow's run is already active for the contact — used by
 * `handleReplyForActiveRun` so a customer who never taps a button (just
 * free-types "quiero pedirlo" etc.) can still reach a keyword-triggered
 * flow. Without this, their run would sit at its current node forever
 * (only interactive taps advance send_buttons/send_list nodes) and
 * `findEntryFlow` would never run for them, since it's only checked
 * when there's NO active run.
 */
async function findActiveKeywordFlow(
  db: AdminClient,
  accountId: string,
  text: string,
): Promise<FlowRow | null> {
  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", accountId)
    .eq("status", "active")
    .eq("trigger_type", "keyword")
    .order("created_at", { ascending: true });
  if (error || !flows) return null;
  for (const flow of flows as FlowRow[]) {
    if (matchesKeywordTrigger(text, flow.trigger_config as KeywordTriggerConfig)) {
      return flow;
    }
  }
  return null;
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================

async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveButtons({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    buttons: cfg.buttons.map((b) => ({ id: b.reply_id, title: b.title })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  const { whatsapp_message_id } = await engineSendInteractiveList({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: cfg.text,
    buttonLabel: cfg.button_label,
    headerText: cfg.header_text,
    footerText: cfg.footer_text,
    sections: cfg.sections.map((s) => ({
      title: s.title,
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: r.title,
        description: r.description,
      })),
    })),
  });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
    whatsapp_message_id,
  });
  const { data: msg } = await db
    .from("messages")
    .select("id")
    .eq("message_id", whatsapp_message_id)
    .maybeSingle();
  await db
    .from("flow_runs")
    .update({
      last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
    })
    .eq("id", run.id);
  return { outcome: "advanced", node_key: node.node_key };
}

async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    updated_at: new Date().toISOString(),
  };
  if (cfg.assign_to) convUpdate.assigned_agent_id = cfg.assign_to;
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update(convUpdate)
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: cfg.assign_to ?? null,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a Supabase mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  let subjectValue: string | undefined;
  if (cfg.subject === "var") {
    const v = run.vars[cfg.subject_key];
    subjectValue = typeof v === "string" ? v : v === undefined ? undefined : String(v);
  } else if (cfg.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", cfg.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    subjectValue = (count ?? 0) > 0 ? cfg.subject_key : undefined;
  } else {
    const ALLOWED = ["name", "email", "phone", "company"] as const;
    type AllowedField = (typeof ALLOWED)[number];
    if (!ALLOWED.includes(cfg.subject_key as AllowedField)) {
      throw new Error(`unsupported contact_field: ${cfg.subject_key}`);
    }
    const { data } = await db
      .from("contacts")
      .select(cfg.subject_key)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const raw = (data as Record<string, unknown> | null)?.[cfg.subject_key];
    subjectValue = typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  return evaluateConditionPredicate({
    operator: cfg.operator,
    subjectValue,
    configValue: cfg.value,
  });
}

/**
 * Tiny `{{vars.foo}}` interpolation. Used by send_message + collect_input
 * prompt text so a captured `name` can show up in the next prompt
 * ("Thanks {{vars.name}}, what's your email?"). Missing vars render as
 * empty string — the same behavior as the automations engine.
 */
function interpolateVars(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

async function endRun(
  db: AdminClient,
  runId: string,
  status: "completed" | "handed_off" | "timed_out" | "failed",
  reason: string,
): Promise<void> {
  await db
    .from("flow_runs")
    .update({
      status,
      ended_at: new Date().toISOString(),
      end_reason: reason,
    })
    .eq("id", runId);
}

// ============================================================
// The synchronous advance loop. Walks through auto-advance nodes
// until it hits one that suspends (send_buttons/send_list) or
// terminates (handoff/end). Each suspending node persists the
// new current_node_key before returning.
// ============================================================

/**
 * Shared AI-answer generation, used by the `ai_reply` node and by the
 * "free text at a button menu" intercept in handleReplyForActiveRun.
 * Returns null (rather than throwing) when there's no AI configured or
 * the model produced nothing usable — callers decide what "no answer"
 * means for them (fail the run vs. fall through to the reprompt policy).
 */
async function generateAiAnswer(
  db: AdminClient,
  run: FlowRunRow,
  metaMessageId: string,
  extraPrompt?: string,
): Promise<{ whatsapp_message_id: string } | null> {
  await showTypingIndicator(db, {
    accountId: run.account_id,
    conversationId: run.conversation_id!,
    metaMessageId,
  });

  const aiConfig = await loadAiConfig(db, run.account_id);
  if (!aiConfig) return null;

  const messages = await buildConversationContext(db, run.conversation_id!);
  const knowledge = await retrieveKnowledge(
    db,
    run.account_id,
    aiConfig,
    latestUserMessage(messages),
  );
  const productContext = await resolveProductPromptContext(
    db,
    run.account_id,
    run.conversation_id!,
  );
  const extraInstruction = [productContext, extraPrompt]
    .filter((s): s is string => Boolean(s && s.trim()))
    .join("\n\n");

  const systemPrompt = buildSystemPrompt({
    userPrompt: aiConfig.systemPrompt,
    // Not "auto_reply" — that mode teaches the model the HANDOFF_SENTINEL
    // protocol, which has no listener here; a flow has its own explicit
    // `handoff` node type for that job.
    mode: "draft",
    knowledge,
    extraInstruction,
  });
  const { text } = await generateReply({ config: aiConfig, systemPrompt, messages });
  if (!text.trim()) return null;

  const { whatsapp_message_id } = await engineSendText({
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    text,
  });
  return { whatsapp_message_id };
}

/**
 * When a customer answers a `collect_input` prompt with what looks
 * like several pieces of shipping/order info at once (e.g. "1, Calle
 * 123 #45-67, Bogotá, Cundinamarca, Chapinero" instead of one field
 * per message), try to split it across the pending fields in this
 * checkout chain rather than filing the whole blob under the current
 * field and re-asking for the rest. Best-effort: no AI configured, a
 * short/plain reply, or any provider failure all just return `{}` —
 * the caller's existing single-field capture is the safe fallback.
 */
async function tryExtractMultipleFields(
  db: AdminClient,
  run: FlowRunRow,
  currentNode: FlowNodeRow,
  nodes: Map<string, FlowNodeRow>,
  messageText: string,
): Promise<Record<string, string>> {
  const pending = collectPendingInputFields(nodes, currentNode, run.vars);
  // Only the current field pending (nothing downstream to split into),
  // or the message doesn't look information-dense — skip the AI call.
  if (pending.length < 2 || !looksLikeMultiFieldReply(messageText)) return {};

  const aiConfig = await loadAiConfig(db, run.account_id);
  if (!aiConfig) return {};

  try {
    const { text } = await generateReply({
      config: aiConfig,
      systemPrompt: buildFieldExtractionPrompt(pending),
      messages: [{ role: "user", content: messageText }],
    });
    return parseFieldExtractionResponse(text, pending);
  } catch (err) {
    console.error(
      "[flows] multi-field extraction failed (falling back to single-field capture):",
      err instanceof Error ? err.message : err,
    );
    return {};
  }
}

/**
 * AI classification for the cases `looksLikeAQuestion`'s regex can't
 * catch — colloquial phrasing with no "?" and no interrogative opener
 * ("Y el envío es gratis o lo cobran"). Asks the model whether the
 * reply actually answers the field's prompt or is something else
 * entirely. Defaults to `true` (treat as a real answer, same as
 * pre-fix behavior) whenever there's no AI configured or the call/
 * parse fails — a missed classification should never block a
 * legitimate answer from being captured.
 */
async function classifyCollectInputReply(
  db: AdminClient,
  accountId: string,
  promptText: string,
  messageText: string,
): Promise<boolean> {
  const aiConfig = await loadAiConfig(db, accountId);
  if (!aiConfig) return true;

  try {
    const { text } = await generateReply({
      config: aiConfig,
      systemPrompt:
        "You classify a single WhatsApp reply sent during a checkout " +
        `flow. The customer was just asked: "${promptText}". Decide ` +
        "whether their reply actually answers that (a piece of data — " +
        "a quantity, an address, a place name, etc.) or is something " +
        "else entirely (a question of their own, a comment, small " +
        'talk). Reply with ONLY a JSON object: {"is_answer": true} or ' +
        '{"is_answer": false}. No prose, no markdown code fences.',
      messages: [{ role: "user", content: messageText }],
    });
    const cleaned = text
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    const parsed = JSON.parse(cleaned) as { is_answer?: unknown };
    return typeof parsed.is_answer === "boolean" ? parsed.is_answer : true;
  } catch (err) {
    console.error(
      "[flows] collect_input reply classification failed (defaulting to 'is an answer'):",
      err instanceof Error ? err.message : err,
    );
    return true;
  }
}

async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
  /** The inbound message that triggered this advance — used to show a
   *  "typing…" bubble on the customer's WhatsApp before an ai_reply
   *  node's (slower) generation call. */
  metaMessageId: string,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const { whatsapp_message_id } = await engineSendMedia({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars)
            : undefined,
          filename: cfg.filename,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "collect_input") {
      const cfg = node.config as unknown as CollectInputNodeConfig;
      // Already has a value — most likely the multi-field extractor
      // (see tryExtractMultipleFields) pulled it out of an earlier
      // message in this same chain. Don't re-ask, just move on.
      const existing = run.vars[cfg.var_key];
      if (typeof existing === "string" && existing.trim().length > 0) {
        currentKey = cfg.next_node_key;
        continue;
      }
      // Send the prompt and suspend. Customer's next TEXT reply will
      // wake us up via handleReplyForActiveRun's collect_input branch.
      try {
        const { whatsapp_message_id } = await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "collect_input",
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "collect_input_prompt_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "collect_input_prompt_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await db
            .from("contact_tags")
            .upsert(
              { contact_id: run.contact_id!, tag_id: cfg.tag_id },
              { onConflict: "contact_id,tag_id" },
            );
        } else {
          await db
            .from("contact_tags")
            .delete()
            .eq("contact_id", run.contact_id!)
            .eq("tag_id", cfg.tag_id);
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "export_order") {
      const cfg = node.config as unknown as ExportOrderNodeConfig;
      try {
        await exportOrderRow(db, run, cfg);
      } catch (err) {
        // Non-fatal — log + advance. A missing sheet connection, a
        // lapsed membership, or a Google API hiccup shouldn't strand
        // the customer mid-flow. The customer still gets their order
        // confirmed downstream, so the owner needs an explicit alert —
        // otherwise a real, paid order can vanish with nothing but a
        // buried flow_run_events row to show for it.
        const detail = err instanceof Error ? err.message : String(err);
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "export_order_failed",
          detail,
        });
        try {
          await db.from("notifications").insert({
            account_id: run.account_id,
            user_id: run.user_id,
            type: "automation_alert",
            conversation_id: run.conversation_id,
            contact_id: run.contact_id,
            actor_user_id: null,
            title: "⚠️ Un pedido no se pudo registrar en Google Sheets",
            body: `El bot confirmó el pedido al cliente, pero la exportación a la hoja falló: ${detail}. Revisa este pedido manualmente.`,
          });
        } catch (notifyErr) {
          console.error(
            "[flows] failed to notify owner of export_order_failed:",
            notifyErr,
          );
        }
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "ai_reply") {
      const cfg = node.config as unknown as AiReplyNodeConfig;
      try {
        const result = await generateAiAnswer(
          db,
          run,
          metaMessageId,
          interpolateVars(cfg.prompt, run.vars),
        );
        if (!result) {
          throw new Error(
            "AI assistant is not set up for this account, or generated an empty reply",
          );
        }
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "ai_reply",
          whatsapp_message_id: result.whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "ai_reply_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", "ai_reply_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      await sendButtonsAndSuspend(db, run, node);
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      await sendListAndSuspend(db, run, node);
      const advanced = await advanceCurrentNodeKey(
        db,
        run.id,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
async function advanceCurrentNodeKey(
  db: AdminClient,
  runId: string,
  expectedOldKey: string | null,
  newKey: string,
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", runId)
    .eq("status", "active");
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// A crashed request could leave a run locked forever — treat a claim
// older than this as abandoned and safe to steal.
const RUN_LOCK_STALE_MS = 30_000;
// How long a second, concurrent reply waits for the first to finish
// before giving up — covers a customer double-tapping two different
// buttons a second or two apart.
const RUN_LOCK_MAX_WAIT_MS = 8_000;
const RUN_LOCK_POLL_MS = 400;

/**
 * Claims exclusive processing rights for one flow run via the same
 * conditional-UPDATE idiom as `advanceCurrentNodeKey` — succeeds only
 * if nobody else currently holds the lock (or the last claim is stale).
 */
async function tryClaimRun(db: AdminClient, runId: string): Promise<boolean> {
  const staleThreshold = new Date(Date.now() - RUN_LOCK_STALE_MS).toISOString();
  const { data, error } = await db
    .from("flow_runs")
    .update({ locked_at: new Date().toISOString() })
    .eq("id", runId)
    .or(`locked_at.is.null,locked_at.lt.${staleThreshold}`)
    .select("id");
  if (error) {
    console.error("[flows] tryClaimRun error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

async function releaseRunLock(db: AdminClient, runId: string): Promise<void> {
  const { error } = await db
    .from("flow_runs")
    .update({ locked_at: null })
    .eq("id", runId);
  if (error) console.error("[flows] releaseRunLock error:", error.message);
}

/**
 * Two customer replies landing within a second or two of each other
 * (e.g. a double-tap on two different interactive buttons) used to
 * both advance the same run concurrently — each sending its own
 * messages before either committed, only caught (too late, after
 * already sending duplicates) by `advanceCurrentNodeKey`'s optimistic
 * check. Polling for this run's lock instead serializes the two: the
 * second reply waits for the first to fully finish and release, then
 * the caller re-reads the run fresh so it sees wherever the first
 * reply actually left it, rather than racing from stale state.
 */
async function claimRunWithWait(db: AdminClient, runId: string): Promise<boolean> {
  const deadline = Date.now() + RUN_LOCK_MAX_WAIT_MS;
  for (;;) {
    if (await tryClaimRun(db, runId)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, RUN_LOCK_POLL_MS));
  }
}

// ============================================================
// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean },
): Promise<DispatchInboundResult> {
  const db = supabaseAdmin();
  try {
    const activeRun = await loadActiveRunForContact(
      db,
      input.accountId,
      input.contactId,
    );

    // Idempotency — only matters if there's already a run for this
    // contact. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }

      const claimed = await claimRunWithWait(db, activeRun.id);
      if (!claimed) {
        await logEvent(db, activeRun.id, "error", activeRun.current_node_key ?? "start", {
          reason: "run_busy_reply_skipped",
        });
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "run_busy_skipped",
        };
      }
      try {
        // Re-read fresh — the run may have advanced while this reply
        // waited for the lock (e.g. a prior reply that raced in first).
        const freshRun = await loadActiveRunForContact(
          db,
          input.accountId,
          input.contactId,
        );
        if (!freshRun) {
          return { consumed: true, flow_run_id: activeRun.id, outcome: "no_match" };
        }
        // One SELECT for the whole flow's nodes — advance loop is now
        // in-memory. See loadAllNodes.
        const nodes = await loadAllNodes(db, freshRun.flow_id);
        return await handleReplyForActiveRun(db, freshRun, input.message, nodes);
      } finally {
        await releaseRunLock(db, activeRun.id);
      }
    }

    // A reply to an OLDER menu the contact already moved past (e.g.
    // their run ended on a different branch, like Limpiavidrios
    // Magnético's price step) — WhatsApp keeps a send_buttons message's
    // buttons tappable indefinitely (Cloud API: a real button tap,
    // `interactive_reply`; QR: no real tap exists, so the equivalent is
    // typing the option's number/title as plain text — see
    // `matchTextReplyToMenu`'s doc comment). Either way this is a normal
    // thing for a customer to do, and we already know exactly what that
    // option is supposed to show — no need to route it through the AI
    // as an ambiguous message (live-tested for the interactive case:
    // mostly handed off instead of answering — see commit history) or,
    // worse for QR, let a bare "2" get misread as "I want 2 units" by
    // the general auto-reply. Re-serve the option's own branch
    // deterministically instead.
    const recentFlowId = await findMostRecentFlowIdForContact(
      db,
      input.accountId,
      input.contactId,
    );
    if (recentFlowId) {
      const nodes = await loadAllNodes(db, recentFlowId);
      const targetNodeKey =
        input.message.kind === "interactive_reply"
          ? findNodeKeyByReplyId(nodes, input.message.reply_id)
          : findNodeKeyByText(nodes, input.message.text);
      if (targetNodeKey) {
        const { data: flowRow } = await db
          .from("flows")
          .select("*")
          .eq("id", recentFlowId)
          .maybeSingle();
        if (flowRow) {
          return startRunAtNode(
            db,
            flowRow as FlowRow,
            input,
            nodes,
            targetNodeKey,
          );
        }
      }
    }

    // No active run (e.g. the flow already completed an order) — a
    // keyword media trigger should still fire so "ver el producto" /
    // "fotos" etc. send photos instead of silently falling through to
    // the AI auto-reply, which has no way to actually send media and
    // used to just claim it couldn't. Checked across every active
    // flow's configured triggers, not just the one the contact last ran.
    const mediaTriggerResult = await checkKeywordMediaTriggerNoActiveRun(
      db,
      input,
    );
    if (mediaTriggerResult) return mediaTriggerResult;

    // No active run → look for a flow whose entry trigger matches.
    const flow = await findEntryFlow(
      db,
      input.accountId,
      input.message,
      input.isFirstInboundMessage,
    );
    if (!flow || !flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = await loadAllNodes(db, flow.id);
    return startNewRun(db, flow, input, nodes);
  } catch (err) {
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

/** Lowercase + strip diacritics so "Cómo es?" matches a "como es" keyword. */
function normalizeForKeywordMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function matchKeywordMediaTrigger(
  triggers: FlowKeywordMediaTrigger[],
  text: string,
): FlowKeywordMediaTrigger | null {
  const haystack = normalizeForKeywordMatch(text);
  if (!haystack) return null;
  for (const trigger of triggers) {
    const hit = trigger.keywords.some((k) =>
      haystack.includes(normalizeForKeywordMatch(k)),
    );
    if (hit) return trigger;
  }
  return null;
}

/**
 * Same keyword→media match as inside an active run, but for the case
 * where the contact has no run at all (flow completed, or never
 * started one). Sends against the conversation directly since there's
 * no flow_run to log events against.
 */
async function checkKeywordMediaTriggerNoActiveRun(
  db: AdminClient,
  input: DispatchInboundInput,
): Promise<DispatchInboundResult | null> {
  if (input.message.kind !== "text") return null;

  const { data: flows, error } = await db
    .from("flows")
    .select("*")
    .eq("account_id", input.accountId)
    .eq("status", "active");
  if (error || !flows) return null;

  for (const flow of flows as FlowRow[]) {
    if (!flow.keyword_media_triggers?.length) continue;
    const trigger = matchKeywordMediaTrigger(
      flow.keyword_media_triggers,
      input.message.text,
    );
    if (!trigger) continue;

    for (const item of trigger.media) {
      try {
        await engineSendMedia({
          accountId: input.accountId,
          userId: input.userId,
          conversationId: input.conversationId,
          contactId: input.contactId,
          kind: item.media_type,
          link: item.media_url,
          caption: item.caption,
        });
      } catch (err) {
        console.error(
          "[flows] keyword_media_trigger (no active run) send failed:",
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { consumed: true, outcome: "media_trigger_fired" };
  }
  return null;
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  const flow = await loadFlow(db, run.flow_id);

  // Phrase-triggered media (e.g. "cómo es", "ver el producto") fires
  // regardless of what the run is currently waiting for — a customer
  // mid button-menu or mid AI Q&A can ask to see photos without it
  // being read as an unmatched reply. Doesn't touch current_node_key
  // or reprompt_count, so whatever the flow expects next is unchanged.
  if (message.kind === "text" && flow?.keyword_media_triggers?.length) {
    const trigger = matchKeywordMediaTrigger(
      flow.keyword_media_triggers,
      message.text,
    );
    if (trigger) {
      for (const item of trigger.media) {
        try {
          const { whatsapp_message_id } = await engineSendMedia({
            accountId: run.account_id,
            userId: run.user_id,
            conversationId: run.conversation_id!,
            contactId: run.contact_id!,
            kind: item.media_type,
            link: item.media_url,
            caption: item.caption,
          });
          await logEvent(db, run.id, "message_sent", run.current_node_key, {
            node_type: "keyword_media_trigger",
            media_type: item.media_type,
            whatsapp_message_id,
          });
        } catch (err) {
          await logEvent(db, run.id, "error", run.current_node_key, {
            reason: "keyword_media_trigger_send_failed",
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return {
        consumed: true,
        flow_run_id: run.id,
        outcome: "media_trigger_fired",
      };
    }
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. Text reply on a collect_input node — capture into vars.
  //
  // Everything else falls through to the fallback policy below.
  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (
    message.kind === "text" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list")
  ) {
    // Cloud-API conversations only ever produce a real interactive_reply
    // for these node types — free text here means the customer typed
    // instead of tapping, which still falls through to the off-menu AI
    // answer below like it always has. QR conversations have no tap at
    // all (see matchTextReplyToMenu's doc comment), so text IS the
    // reply — but only attempt this on a QR conversation specifically,
    // resolved fresh rather than trusted from message.kind alone.
    const config = await resolveWhatsappConfigForConversation(
      db,
      run.account_id,
      run.conversation_id!,
    ).catch(() => null);
    if (config?.provider === "qr") {
      matched = matchTextReplyToMenu(currentNode, message.text);
    }
  } else if (
    message.kind === "text" &&
    currentNode.node_type === "collect_input"
  ) {
    const cfg = currentNode.config as unknown as CollectInputNodeConfig;
    const captured = message.text.trim();
    // Free fast-path first (a "?" or a formal interrogative opener);
    // only spend an AI call on the ambiguous middle ground — colloquial
    // phrasing the regex can't parse, but too long to be a trustworthy
    // one-or-two-word field value either.
    const isOffTopic =
      captured.length > 0 &&
      (looksLikeAQuestion(captured) ||
        (looksWorthClassifying(captured) &&
          !(await classifyCollectInputReply(
            db,
            run.account_id,
            cfg.prompt_text,
            captured,
          ))));
    if (isOffTopic) {
      let aiResult: { whatsapp_message_id: string } | null = null;
      try {
        aiResult = await generateAiAnswer(
          db,
          run,
          message.meta_message_id,
          "El cliente está a mitad de dar sus datos de envío y en vez de " +
            "responder hizo una pregunta. Respóndela breve (máximo 3 " +
            "líneas) usando el contexto del producto y el historial, y " +
            "termina recordándole que todavía necesitas esto: " +
            `"${cfg.prompt_text}"`,
        );
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "question_during_collect_input_answer_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      if (aiResult) {
        await logEvent(db, run.id, "message_sent", currentNode.node_key, {
          node_type: "off_menu_ai_answer",
          whatsapp_message_id: aiResult.whatsapp_message_id,
        });
        return {
          consumed: true,
          flow_run_id: run.id,
          outcome: "off_menu_answered",
        };
      }
      // AI answer failed (no assistant configured, etc.) — fall through
      // to the normal capture below rather than leaving the customer
      // with no reply at all.
    }
    if (captured.length > 0 && cfg.var_key) {
      // Try splitting the reply across the rest of this checkout
      // chain first (e.g. quantity + address + city in one message).
      // Falls back to {} silently for a plain single-field answer.
      const extracted = await tryExtractMultipleFields(
        db,
        run,
        currentNode,
        nodes,
        captured,
      );
      const newVars = { ...run.vars, ...extracted };
      // The current field always gets a value — the extractor's guess
      // if it found one, otherwise the raw reply, same as before.
      const currentExtracted = newVars[cfg.var_key];
      if (!(typeof currentExtracted === "string" && currentExtracted.trim())) {
        newVars[cfg.var_key] = captured;
      }
      // Persist captured value(s) + reset reprompt count atomically.
      const { error: capErr } = await db
        .from("flow_runs")
        .update({
          vars: newVars,
          reprompt_count: 0,
        })
        .eq("id", run.id);
      if (!capErr) {
        // Mirror the UPDATE in-memory so downstream interpolation in
        // the advance loop sees the captured var without us having to
        // re-SELECT the whole row.
        run.vars = newVars;
        run.reprompt_count = 0;
        await logEvent(db, run.id, "node_entered", currentNode.node_key, {
          captured_key: cfg.var_key,
          captured_length: captured.length,
          extracted_keys: Object.keys(extracted),
        });
        matched = cfg.next_node_key;
      }
    }
  }

  if (matched) {
    // Reset reprompt count on a successful match. Skip the write when
    // already 0 — the collect_input capture branch above already
    // zeroed it, and interactive-reply matches against a fresh run
    // (post-prior-reset) are also already 0. The previous re-read of
    // the whole row was needed only because we weren't mirroring the
    // capture UPDATE into the in-memory `run`; now that we do, the
    // local copy is the source of truth.
    if (run.reprompt_count !== 0) {
      const { error } = await db
        .from("flow_runs")
        .update({ reprompt_count: 0 })
        .eq("id", run.id);
      if (!error) run.reprompt_count = 0;
    }
    const outcome = await advanceFromNodeKey(
      db,
      run,
      matched,
      nodes,
      message.meta_message_id,
    );
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // A customer typing a free-form question that doesn't match whatever
  // the run is currently waiting for shouldn't just get a menu resent
  // (or, worse, nothing at all) — try answering it with AI first, same
  // generation path as the ai_reply node. Doesn't touch current_node_key
  // or reprompt_count, so whatever the flow expects next is unaffected.
  //
  // Covers every node type except collect_input: that one already
  // captures ANY non-empty text as the answer in the "matched" branch
  // above, so it only reaches here on an empty-string edge case that
  // isn't a real question. Also covers node types that should never be
  // "current" for a suspended run (e.g. `start`) — a fast second inbound
  // sent while the first webhook call is still mid-advance can read a
  // not-yet-updated current_node_key, and previously landed here with
  // silence: none of the reprompt branches below know how to handle an
  // unexpected node type, so nothing got sent at all.
  if (message.kind === "text" && currentNode.node_type !== "collect_input") {
    // Before answering with AI, check whether the free text is actually
    // the trigger phrase for a different keyword-triggered flow (e.g.
    // "quiero pedirlo" for a checkout flow) — a customer who only ever
    // types instead of tapping buttons would otherwise never leave this
    // run, so that flow could never start for them. Ending this run and
    // handing off to the matched flow beats an AI answer that ignores
    // the customer's actual intent.
    const keywordFlow = await findActiveKeywordFlow(
      db,
      run.account_id,
      message.text,
    );
    if (keywordFlow?.entry_node_id) {
      await endRun(db, run.id, "completed", "superseded_by_keyword_trigger");
      const newFlowNodes = await loadAllNodes(db, keywordFlow.id);
      return await startNewRun(
        db,
        keywordFlow,
        {
          accountId: run.account_id,
          userId: run.user_id,
          contactId: run.contact_id!,
          conversationId: run.conversation_id!,
          message,
        },
        newFlowNodes,
      );
    }
    let aiResult: { whatsapp_message_id: string } | null = null;
    try {
      aiResult = await generateAiAnswer(
        db,
        run,
        message.meta_message_id,
        "Responde breve (máximo 3 líneas) la pregunta del cliente usando el " +
          "contexto del producto y el historial. No repitas el menú de " +
          "opciones — el cliente ya lo tiene en pantalla.",
      );
    } catch (err) {
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "off_menu_ai_answer_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    if (aiResult) {
      await logEvent(db, run.id, "message_sent", currentNode.node_key, {
        node_type: "off_menu_ai_answer",
        whatsapp_message_id: aiResult.whatsapp_message_id,
      });
      return {
        consumed: true,
        flow_run_id: run.id,
        outcome: "off_menu_answered",
      };
    }
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(flow?.fallback_policy);
  const newReprompts = run.reprompt_count + 1;
  await db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id);

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  if (action.type === "reprompt") {
    // Re-send the same prompt. Same node, no current_node_key change.
    // Every branch here must catch its own send failure — an uncaught
    // throw would propagate out of dispatchInboundToFlows entirely,
    // which its caller (the webhook) reads as "no flow consumed this
    // message" and hands off to the AI auto-reply fallback instead of
    // logging the real error. That fallback is a separate opt-in
    // feature and often off, so the customer would see no reply at
    // all with no record of why.
    if (currentNode.node_type === "send_buttons") {
      try {
        await sendButtonsAndSuspend(db, run, currentNode);
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (currentNode.node_type === "send_list") {
      try {
        await sendListAndSuspend(db, run, currentNode);
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    } else if (currentNode.node_type === "collect_input") {
      // Customer typed something we couldn't accept (empty after trim,
      // or var_key missing — rare). Re-send the prompt so they try again.
      const cfg = currentNode.config as unknown as CollectInputNodeConfig;
      try {
        await engineSendText({
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.prompt_text, run.vars),
        });
      } catch (err) {
        await logEvent(db, run.id, "error", currentNode.node_key, {
          reason: "reprompt_send_failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") {
    if (run.conversation_id) {
      await db
        .from("conversations")
        .update({ status: "pending", updated_at: new Date().toISOString() })
        .eq("id", run.conversation_id);
    }
    await logEvent(db, run.id, "handoff", run.current_node_key, {
      reason: "fallback_exhausted",
    });
    await endRun(db, run.id, "handed_off", "fallback_exhausted");
    return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
  }
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

async function startNewRun(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
  /** Defaults to the flow's real entry node. Overridden by
   *  `startRunAtNode` below to drop straight into a specific branch
   *  instead of the flow's normal beginning. */
  startNodeKey: string | null = flow.entry_node_id,
): Promise<DispatchInboundResult> {
  if (!startNodeKey) return { consumed: false, outcome: "no_match" };
  // INSERT — partial unique index `idx_one_active_run_per_contact`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_contact` is over (account_id,
      // contact_id) WHERE status='active', so two accounts sharing
      // a contact phone number each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: startNodeKey,
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  await logEvent(db, run.id, "started", startNodeKey, {
    flow_id: flow.id,
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  // Run the advance loop starting from the given node.
  const outcome = await advanceFromNodeKey(
    db,
    run,
    startNodeKey,
    nodes,
    input.message.meta_message_id,
  );
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}

/**
 * A stale button tap resolved to a specific branch (see the
 * `findNodeKeyByReplyId` call site) — start a fresh run of that flow,
 * but dropped directly into that branch's target node instead of the
 * flow's normal entry point. Thin wrapper so the call site reads as
 * "start here", not "start... but also here's an override".
 */
function startRunAtNode(
  db: AdminClient,
  flow: FlowRow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
  startNodeKey: string,
): Promise<DispatchInboundResult> {
  return startNewRun(db, flow, input, nodes, startNodeKey);
}
