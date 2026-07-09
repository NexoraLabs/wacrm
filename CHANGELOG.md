# Changelog

User-visible changes in `wacrm`. Self-hosters: when pulling an update,
check this file for any **migration required** notes and apply the
matching SQL files from `supabase/migrations/` against your Supabase
project before restarting the app.

Versions follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Pre-1.0, `MINOR` bumps cover new modules; `PATCH` bumps cover bug fixes
and polish.

## [0.15.1] — 2026-07-09

### Fixed

- **The AI invented a price when answering before any deal existed.**
  `resolveProductPromptContext` only loaded a product's pricing/`ai_prompt`
  through the conversation's deal (`deals.product_id`) — but a deal is
  normally only created once the customer commits to buying (e.g. a
  keyword automation on "quiero pedirlo"). Every earlier message,
  including the very first pricing question, got no product context
  at all, so the model guessed — confirmed in production, where a
  customer asked "Precio por favor" and got a fabricated "$29.99"
  instead of the real price. Now falls back to the account's sole
  product when there's no deal-linked one yet (the common
  single-product setup); stays `null` — same as before — when there
  are 0 or 2+ products with no deal, since it's genuinely ambiguous
  which applies (`src/lib/ai/product-context.ts`).

### Added

- **Model picker dropdown in Settings → AI Agents → Setup.** The
  Model field was free text — you had to know the exact slug for
  your provider. Now each provider (OpenAI, Anthropic, OpenRouter)
  shows a shortlist of common models, with a "Custom — type your
  own…" option that reveals a text input for anything not listed
  (essential for OpenRouter, which proxies 100+ models across every
  vendor — Llama, Gemini, Mistral, DeepSeek, and more, none of which
  can be fully enumerated). Switching provider swaps in that
  provider's default model; picking Custom preserves whatever was
  already typed instead of blanking the field
  (`src/lib/ai/model-options.ts`, `src/components/settings/ai-config.tsx`).

## [0.14.5] — 2026-07-09

### Fixed

- **AI auto-reply stood down for the entire account whenever ANY
  active `keyword_match`/`new_message_received` automation existed —
  not just when one actually applied to the message.** Once a flow
  run ends (e.g. after "Ver precio" or "Cómo funciona"), the AI
  auto-reply is the only safety net left for follow-up questions. An
  account with even one narrow keyword automation (e.g. matching only
  "quiero pedirlo") had that safety net permanently disabled for
  *every* message, since the check only asked "does one exist" rather
  than "does one match this text." Now checks real relevance via the
  same keyword-matching logic Automations itself uses
  (`triggerMatches`, exported from `src/lib/automations/engine.ts` and
  reused by `src/lib/ai/auto-reply.ts`); `new_message_received`
  automations still always stand it down (they fire on every
  message), matching prior behavior.

## [0.14.4] — 2026-07-09

### Fixed

- **A fast follow-up message sent during a flow's welcome sequence
  could vanish with zero reply.** A customer who typed a second
  message (e.g. a pricing question) while the first webhook call was
  still mid-advance (welcome → tag → video → menu, all sent in one
  synchronous pass) could have that second inbound read a
  not-yet-persisted `current_node_key` — landing on a node type (e.g.
  `start`) that none of the reprompt branches know how to handle, so
  nothing was sent back at all. The AI-answer intercept added in
  0.14.3 was scoped to only `send_buttons`/`send_list`; widened it to
  every node type except `collect_input` (which already captures any
  text as an answer on its own), so this and any other
  unexpected-current-node case now gets an AI-generated reply instead
  of silence (`src/lib/flows/engine.ts`). The underlying race itself
  (overlapping webhook deliveries for the same contact aren't
  serialized) is still open — this closes the customer-visible
  symptom, not the root cause.

## [0.14.3] — 2026-07-09

### Fixed

- **AI auto-reply's per-conversation cap could silently go dark
  forever.** The cheap early-out check (`ai_reply_count >= cap`) in
  `dispatchInboundToAiReply` returned with no signal to anyone —
  unlike the atomic-claim path just below it, which does mark the
  conversation `ai_autoreply_disabled` and notify the owner. A contact
  who kept messaging past the cap got permanently ignored with nobody
  aware. Both paths now behave the same way
  (`src/lib/ai/auto-reply.ts`).

### Added

- **Flows answer off-menu questions with AI instead of just
  reprompting.** A customer who types a free-form question while a
  flow is waiting on a button/list tap (initial menu, or any other
  `send_buttons`/`send_list` node) now gets an AI-generated answer
  (same path as the `ai_reply` node) instead of the menu being resent
  as an "unrecognized reply." Falls back to the existing
  reprompt/handoff policy only when no AI is configured or it
  produces nothing usable. Doesn't touch `current_node_key` or
  `reprompt_count`, so the menu's buttons stay valid right after
  (`src/lib/flows/engine.ts`).

## [0.14.2] — 2026-07-09

### Fixed

- **A flow's reprompt could crash the whole dispatcher and go
  completely silent.** Re-sending a button/list menu after an
  unmatched reply (`send_buttons`/`send_list` fallback) wasn't wrapped
  in a try/catch, unlike the equivalent `collect_input` branch — a
  failed Meta send there threw out of `dispatchInboundToFlows`
  entirely, which the webhook reads as "no flow consumed this
  message" and hands off to the (often-disabled) AI auto-reply
  fallback instead of logging the real error. Customer got no reply at
  all with nothing to explain why (`src/lib/flows/engine.ts`).

### Added

- **`flows.keyword_media_triggers`.** Lets a flow react to a phrase
  (e.g. "cómo es", "ver el producto") by sending one or more media
  messages no matter where an active run currently sits — mid
  button-menu, mid AI Q&A loop, anywhere. A plain `keyword_match`
  Automation can't do this reliably: content-level automation triggers
  are suppressed whenever a flow run consumes the inbound. **Migration
  required:** apply `supabase/migrations/043_flows_keyword_media_triggers.sql`
  (`src/lib/flows/engine.ts`, `src/lib/flows/types.ts`).

## [0.14.1] — 2026-07-08

### Fixed

- **AI auto-reply could go silently dark mid-sale.** When the model
  handed off (couldn't answer confidently) or the per-conversation
  reply cap was reached, the conversation flipped to
  `ai_autoreply_disabled` with no signal to anyone — a customer
  actively trying to buy could sit unanswered indefinitely. Both paths
  now also notify the account owner via the in-app bell
  (`src/lib/ai/auto-reply.ts`) so a human knows to step in.

## [0.14.0] — 2026-07-08

Fills three gaps in Automations needed to build a full sales flow
(guided conversation in Flows + side-effects in Automations): sending
media, alerting a teammate, and reminding a customer who's gone quiet.

### Added

- **`send_media` automation step.** Automations could previously only
  send text/templates — never an image, video, document, or voice
  note. New step mirrors the Flows `send_media` node's upload UI and
  reuses the same `flow-media` bucket.
- **`notify_admin` automation step.** Alerts a specific teammate via
  the in-app notification bell (Notifications page) without touching
  WhatsApp or reassigning the conversation — distinct from
  `assign_conversation`, which does both. **Migration required:**
  apply `supabase/migrations/042_automation_gaps.sql` — widens
  `notifications.type` to allow `'automation_alert'`.
- **`no_reply_since_last_message` condition subject.** Lets a "remind
  them if they went quiet" automation (Send message → Wait → this
  condition → Send message again) check whether the customer actually
  replied during the wait, instead of blindly re-sending regardless.

## [0.13.0] — 2026-07-08

Adds a "typing…" bubble on the customer's WhatsApp while an AI reply is
being generated, so they see something is coming instead of silence for
the few seconds the LLM call takes.

### Added

- **WhatsApp typing indicator during AI generation.** New
  `sendTypingIndicator` (`src/lib/whatsapp/meta-api.ts`) calls Meta's
  read-receipt-plus-typing-indicator endpoint; a shared
  `showTypingIndicator` helper (`src/lib/whatsapp/typing-indicator.ts`,
  best-effort — never throws) is now called right before generation
  starts in all three AI-reply call sites: the Flows `ai_reply` node,
  the Automations `ai_reply` step, and standalone auto-reply. Meta
  auto-dismisses the bubble once the reply lands or after 25s.

## [0.12.0] — 2026-07-08

Adds an **AI reply** node type to Flows — a guided flow can now
generate a WhatsApp message on the fly with the account's AI assistant
instead of only sending fixed text, at any point in the conversation.

### Added

- **AI reply flow node.** New `ai_reply` node type
  (`src/lib/flows/types.ts`, `engine.ts`) reuses the exact same working
  pattern as Automations' existing `ai_reply` step: loads the account's
  AI config (Settings → AI Assistant), builds conversation history +
  knowledge-base + product-catalog context, generates a reply, and
  sends it via WhatsApp, then auto-advances to the next node. Verified
  end-to-end against a real WhatsApp send. **Migration required:**
  apply `supabase/migrations/041_flows_ai_reply_node.sql` — widens the
  `flow_nodes.node_type` CHECK constraint to allow `'ai_reply'`.

### Fixed

- **Flows builder: "Add node" menu crashed on open.** Both the list
  view and canvas view's add-node dropdown rendered a category label
  outside a `<Menu.Group>`, which the underlying menu primitive
  requires — clicking "Add node" threw a runtime error instead of
  showing the menu, for every node type, not just the new one. Fixed
  in `flow-builder.tsx` and `flow-canvas.tsx`.

## [0.11.0] — 2026-07-08

Adds SaaS membership billing — charge every account a flat monthly fee
to keep using wacrm, collected through **Wompi** (Colombian payment
gateway).

### Added

- **Wompi subscription billing (Settings → Billing).** New
  `account_subscriptions` table (one row per account, following the
  same per-account config-table pattern as `ai_configs`/
  `whatsapp_config`). Card tokenization happens directly in the
  browser against Wompi's public API — raw card data never touches
  our server. `POST /api/billing/subscribe` (admin-only) creates a
  Wompi payment source and charges the first period;
  `POST /api/wompi/webhook` verifies Wompi's event checksum and
  updates status from `transaction.updated` events; `GET
  /api/billing/cron` (reuses `AUTOMATION_CRON_SECRET`) charges the
  stored payment source again for each renewal. **Migration required:**
  apply `supabase/migrations/040_billing.sql` — adds
  `account_subscriptions` and grandfathers every existing account in
  as `active` so nobody who already signed up gets locked out.
- **Access gating ships OFF by default.** Set
  `BILLING_ENFORCEMENT_ENABLED=true` (see `.env`) once you've verified
  a real subscription end-to-end in Wompi sandbox — until then, every
  page and route works exactly as before regardless of subscription
  status. See `src/lib/billing/gate.ts` and the subscription check in
  `src/middleware.ts`.

## [0.10.1] — 2026-07-08

### Fixed

- **Automations list: activation toggle showed a generic error instead
  of the real reason.** Flipping the quick-toggle on an automation with
  an incomplete step (e.g. an "Add tag" step with no tag selected) got
  rejected by the server-side activation validator and rolled back, but
  the toast just said "Cannot keep automation active with invalid
  configuration" — indistinguishable from a real bug. Now surfaces the
  first concrete validation issue (e.g. `tag is required at
  steps[1].tag_id`), matching the error handling already used by the
  automation builder's own save button.

## [0.10.0] — 2026-07-07

Adds in-app support for building **AUTHENTICATION-category** message
templates — previously the only category you had to leave wacrm to
create, redirected to Meta's own Template Manager + "Sync from Meta".

### Added

- **AUTHENTICATION template builder (Settings → Templates).** Meta
  generates the actual body/footer wording for this category from a
  couple of flags rather than accepting free text, so the dialog swaps
  out the usual header/body/footer/buttons fields for: OTP button type
  (Copy Code, or One-Tap/Zero-Tap Android autofill with the app's
  package name + signature hash), an "add security recommendation"
  toggle, and an optional 1-90 minute code-expiration footer — with a
  live preview of the Meta-generated text. Editing and resubmitting
  work the same as other categories. **Migration required:** apply
  `supabase/migrations/039_message_templates_authentication.sql` —
  adds `add_security_recommendation` and `code_expiration_minutes` to
  `message_templates`.

## [0.9.1] — 2026-07-07

### Fixed

- **Video and document template headers couldn't actually be submitted.**
  Meta requires a Resumable-Upload `header_handle` for *any* media
  header at template-creation time, not just images — but the handle
  derivation helper was image-only, so a VIDEO or DOCUMENT header saved
  via a pasted URL would reach Meta with no handle and get rejected.
  Generalized `ensureImageHeaderHandle` (now `ensureHeaderHandle`) to
  cover all three: image (JPEG/PNG, ≤5 MB), video (MP4/3GPP, ≤16 MB),
  document (PDF, ≤100 MB) — the same limits the template builder's UI
  already advertised. No migration required; no UI changes — the
  existing "paste a public link" field for video/document headers now
  actually works.

## [0.9.0] — 2026-07-07

Adds a **product catalog** UI. The data model and API
(`033_products.sql`, `034_product_specifications.sql`) existed only as
grounding for the AI assistant, with no way to manage products short of
calling the API directly.

### Added

- **Products (Settings → Products).** Add, edit, and delete catalog
  entries — name, SKU, price/currency, description, supplier info,
  image URLs, availability, structured specifications (key/value), and
  a per-product AI instruction layered on top of the account-wide
  system prompt. Feeds the AI assistant's replies and appears in the
  Settings overview with a live count. Not required for the CRM to
  work — the assistant just has less to quote from without it. No
  migration required (033/034 already shipped the schema).

### Fixed

- **Delete-product dialog briefly showed `"undefined" will be
  removed...`** during its closing animation, once the confirmed row
  had already been cleared from state. Guarded the description on the
  row still being set.

## [0.8.1] — 2026-07-07

### Fixed

- **Template resubmit could shadow a teammate's template with the same
  name.** The upsert behind "Submit for review" targeted
  `UNIQUE(user_id, name, language)` — a leftover from before multi-user
  accounts (0.3.0) — instead of the account. Two teammates could each
  end up with their own row named e.g. `order_confirmation`, and a
  resubmit by one could silently duplicate rather than update the
  other's. **Migration required:** apply
  `supabase/migrations/038_message_templates_account_scoped_unique.sql`
  — moves the unique constraint from `(user_id, name, language)` to
  `(account_id, name, language)`. Fails loudly with a copy-pasteable
  query if an account already has duplicate rows, same pattern as
  013/014.
- **`rejection_reason` wasn't being cleared on resubmit.** A dead
  ternary (`submissionError ? null : null`) meant the field was always
  written as `null` regardless of outcome — functionally the same as
  the intended "always clear," but written in a way that read as
  broken conditional logic. Simplified to a direct `null` assignment.

## [0.8.0] — 2026-07-07

Adds support for connecting several WhatsApp Business numbers to a
single account, so businesses running more than one line (e.g. "Sales"
and "Support") no longer have to split them across separate accounts.

### Added

- **Multi-number WhatsApp (up to 4 per account).** Settings →
  WhatsApp moves from a single connection form to a list of cards — add,
  remove, or mark a number as **default**. Every number connects
  through Meta's official Cloud API only (no QR / unofficial protocol).
  Each conversation is anchored to the exact number it arrived on;
  sends with no prior conversation (fresh broadcasts, templates to new
  contacts) go out through whichever number is marked default.
  **Migration required:** apply
  `supabase/migrations/037_whatsapp_config_multi_number.sql` — it drops
  the old one-number-per-account constraint, adds `label` and
  `is_default` to `whatsapp_config`, and adds `whatsapp_config_id` to
  `conversations`.

## [0.7.1] — 2026-07-07

### Added

- **Per-conversation AI/human toggle.** A switch in the chat header
  turns the AI auto-reply bot on or off for that one conversation,
  independent of the account-wide setting in Settings → AI Assistant
  (the switch only appears when the account has auto-reply enabled at
  all). A badge on each message now distinguishes bot replies from
  messages sent by a human agent. No migration required — uses the
  existing `conversations.ai_autoreply_disabled` column from
  `029_ai_reply.sql`.

## [0.7.0] — 2026-07-02

Promotes the AI assistant to a first-class **AI Agents** section in the
sidebar — it's no longer tucked inside Settings.

### Added

- **AI Agents (sidebar).** A dedicated `/agents` area with two tabs:
  - **Playground** — a test chat to message your agent and see its
    grounded, multi-turn replies (and where it would hand off to a human)
    *before* it ever answers a real customer. Runs the exact same path as
    the auto-reply bot (knowledge-base retrieval + your provider), and
    works even before you flip the master switch on, so you can try, then
    enable. Backed by `POST /api/ai/playground`.
  - **Setup** — the provider/key, business context, knowledge base, and
    auto-reply controls (moved here from Settings → AI Assistant).

### Changed

- The AI configuration moved out of **Settings → AI Assistant** into the
  new **AI Agents** section. No data change — same account config, new
  home. No migration required.

## [0.6.0] — 2026-07-02

Adds an **AI knowledge base** so the assistant (0.5.0) can answer from
your own content instead of handing off. Paste FAQs, policies, or
product details under **Settings → AI Assistant → Knowledge base**; the
relevant excerpts are retrieved into every draft and auto-reply.

### Added

- **Knowledge base with hybrid retrieval.** Lexical Postgres full-text
  search works for every account with no extra credentials. Optional
  **semantic search** (pgvector, OpenAI `text-embedding-3-small`) turns
  on when you add an **embeddings key** — semantic-primary, topped up
  with lexical to fill the result set. Anthropic-only accounts (Anthropic
  has no embeddings API) keep the lexical path with zero extra setup.
- **Knowledge base manager** in Settings — add/edit/delete documents and
  a **Reindex** action to backfill embeddings after adding a key. Both
  drafts and the auto-reply bot are grounded in the retrieved excerpts,
  and the prompt still instructs the model to hand off (auto-reply) or
  say it will follow up (draft) when the KB doesn't cover the question.
  **Migration required:** apply `supabase/migrations/030_ai_knowledge.sql`
  (enables `pgvector`; adds `ai_knowledge_documents` + `ai_knowledge_chunks`
  and an `embeddings_api_key` column on `ai_configs`).

## [0.5.0] — 2026-07-02

Adds the **AI reply assistant** — bring-your-own-key. Each account
pastes its own OpenAI or Anthropic key under **Settings → AI
Assistant**; wacrm calls the provider directly with that key, so
there's no per-seat AI fee and your conversation data never leaves
your own infrastructure for a wacrm-run service. The key is stored
AES-256-GCM-encrypted at rest (same as WhatsApp tokens) and never
returned to the client after saving.

### Added

- **AI-drafted replies in the inbox.** A ✨ button in the composer
  (agent+) reads the recent conversation and drops a suggested reply
  into the box for the agent to edit and send. Read-only server-side —
  `POST /api/ai/draft` never sends or stores anything. Respects your
  business context / persona from the settings prompt.
- **AI auto-reply bot.** When enabled, inbound messages that no
  deterministic Flow consumed and that have no agent assigned get an
  automatic LLM reply. Bounded by a per-conversation cap
  (`auto_reply_max_per_conversation`, default 3) and a clean human
  handoff: when the model can't confidently help — or the customer
  asks for a person — it stays silent and leaves the message for a
  human, and won't auto-reply on that thread again until re-enabled.
  Flows always win over the bot.
- **Settings → AI Assistant** (admin+ to edit): pick provider + model,
  paste your key, add business context/tone, toggle the assistant and
  auto-reply, set the per-conversation cap, and **Test key** against
  the provider before saving.
- Providers: OpenAI (Chat Completions) and Anthropic (Messages) behind
  one interface; model is a free-text field with sensible defaults, so
  you can point it at any current model your key can access.
  **Migration required:** apply
  `supabase/migrations/029_ai_reply.sql` (adds `ai_configs` +
  per-conversation auto-reply columns on `conversations`).

## [0.4.0] — 2026-07-01

Completes the public API (#245): **outbound event webhooks** so
automations can *react* to activity instead of polling.

### Added

- **Outbound event webhooks (`/api/v1/webhooks`).** Register an HTTPS
  endpoint (scope `webhooks:manage`) to be POSTed to when an event
  happens in your account — `message.received`, `message.status_updated`,
  or `conversation.created`. Manage endpoints with
  `GET/POST /api/v1/webhooks` and `GET/PATCH/DELETE /api/v1/webhooks/{id}`.
  Each delivery is signed with an `X-Wacrm-Signature`
  (HMAC-SHA256 over `timestamp.body`) so receivers can verify
  authenticity and reject replays; the signing secret is returned once
  at creation and stored encrypted. Delivery is best-effort — an
  endpoint that fails repeatedly is auto-disabled after a threshold of
  consecutive failures. See `docs/public-api.md`.
  **Migration required:** apply
  `supabase/migrations/028_webhook_endpoints.sql`.
  ([#245](https://github.com/ArnasDon/wacrm/issues/245))

## [0.3.0] — 2026-07-01

Multi-user accounts ship. Every wacrm install is multi-tenant on the
database side: a single user's signup creates a fresh "account", and
every row is scoped to that account rather than to the user directly.
This release also opens the user-visible **Members** surface — invite
teammates by link, manage their roles, transfer ownership — to all
users. The `'account_sharing'` beta gate that hid it during
development is removed (mirrors the Flows soft-GA in 0.2.0). Existing
self-hosted instances keep working: every existing user is backfilled
as the sole owner of their own account and sees identical data, and a
solo owner who never invites anyone sees the same single-user app they
always did.

### Added

- **Public REST API (`/api/v1`) — groundwork.** A scoped, revocable
  **API key** system so you can drive wacrm from your own scripts and
  automations. Create keys under **Settings → API keys** (admin+),
  grant only the scopes each integration needs, and authenticate with
  `Authorization: Bearer <key>`. Keys are account-scoped and stored
  hashed (plaintext shown once). This release ships the auth layer,
  scopes, per-key rate limiting, the management UI, and a
  `GET /api/v1/me` probe to verify a key. See
  `docs/public-api.md`. **Migration required:** apply
  `supabase/migrations/026_api_keys.sql`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))
- **Public REST API — data endpoints.** Built on the key auth above,
  so external automations can read and drive the CRM:
  - `POST /api/v1/messages` — send a text / template / media message to
    a phone number; finds-or-creates the contact + conversation
    (`messages:send`).
  - `GET/POST /api/v1/contacts`, `GET/PATCH /api/v1/contacts/{id}` —
    list (search + tag filter), create (find-or-create by phone), read,
    and update contacts, including tags (`contacts:read` /
    `contacts:write`).
  - `GET /api/v1/conversations`, `GET /api/v1/conversations/{id}`, and
    `GET /api/v1/conversations/{id}/messages` — browse conversations and
    their message history with delivery status (`conversations:read` /
    `messages:read`).
  - `POST /api/v1/broadcasts` + `GET /api/v1/broadcasts/{id}` — launch a
    template broadcast to a recipient list and poll its progress
    (`broadcasts:send`).
  All list endpoints share one cursor-pagination contract
  (`{ data, meta: { next_cursor } }`). No migration required — the
  scopes already existed and the tables are unchanged. Outbound event
  webhooks (react to inbound messages) are the remaining roadmap item.
  See `docs/public-api.md`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))

### Changed

- **Tenancy moves from per-user to per-account.** RLS on every
  domain table (contacts, conversations, messages, broadcasts,
  automations, flows, pipelines, templates, tags, …) now checks
  account membership via a new SECURITY DEFINER helper
  `is_account_member(account_id, min_role)` instead of
  `auth.uid() = user_id`. The `user_id` columns stay on every row
  for assignment / audit but no longer enforce isolation.
- **WhatsApp config is one-per-account, not one-per-user.** The
  `whatsapp_config.UNIQUE(user_id)` constraint is replaced by
  `UNIQUE(account_id)`.
- **`flow_runs` idempotency key swaps to `(account_id, contact_id)`**
  so two accounts sharing a contact phone number can each run their
  own flows independently.
- **The signup trigger (`handle_new_user`) now also creates a
  personal account** and links the new profile to it as `owner`.

### Changed

- **Flow-media storage is now account-scoped.** Migration 016
  pathed uploaded files under `auth.uid()/...`, which orphaned
  flow media when a teammate left a shared account. New uploads
  go under `account-<account_id>/...` and any account member
  with the right role can edit them. Legacy paths remain
  writable by the original uploader for backward compatibility.
- **Webhook contact lookup now pre-filters in SQL.** Previously
  pulled every contact in an account just to JS-filter to one
  row by phone — fine when account = one user, painful when
  account = team. Pre-filter by phone suffix on the database
  side; re-apply `phonesMatch` on the (typically 0-2 row)
  candidate set.

### Migration required

- `supabase/migrations/020_account_sharing_followups.sql` —
  composite partial indexes on `automations(account_id,
  trigger_type) WHERE is_active` and `flows(account_id) WHERE
  status='active'` for the engine dispatch hot path; updated
  `flow-media` storage RLS to allow account-member writes under
  the new path convention. Idempotent.

- **Role-aware UI gating across the app.** The inbox composer's
  send button + textarea, the "New broadcast / automation / flow"
  buttons, the "Add pipeline / deal" buttons, and the "Add /
  Import contact" buttons are now disabled-with-tooltip for
  viewers (and for agents on settings-class actions). Choice:
  show-but-disable rather than hide, so the UI never feels
  silently broken to a teammate looking at a feature they don't
  yet have permission for.
- **Sidebar surfaces the active account** above the user info
  whenever the account name differs from your own — i.e. once
  you've renamed the account or joined a shared one. A default
  solo account is named after you, so the strip stays hidden to
  avoid duplicating your name in the footer.
- **Members is open to all users.** The `account_sharing` beta
  flag that hid the Settings → Members tab and the sidebar
  account strip during development is gone; the multi-user
  surface is now part of the standard app. (Same soft-GA move as
  Flows in 0.2.0.)

### Fixed

- **Inbound WhatsApp messages now land in the shared inbox.** The
  webhook + automations + flows engines used to route inbound
  events by `user_id`, which after the 017 migration only matched
  the WhatsApp config owner's automations / flows — teammates'
  rules never fired. PR 8 of the multi-user series flips every
  lookup to `account_id` so any member of the account sees the
  inbound message and any teammate's automation or flow can react
  to it. Also fixes incipient NOT NULL violations on
  `automation_logs`, `automation_pending_executions`, `flow_runs`,
  and `deals` — those tables gained `account_id NOT NULL` in 017
  but the engines hadn't yet been updated to populate it.

### Added

- **Duplicate phone numbers are now prevented across contacts.** A
  phone number can no longer become more than one contact in the same
  account. Adding a contact whose number already exists is blocked
  with a link to the existing record (and a softer warning for
  near-matches that share their last 8 digits); CSV import de-dupes
  within the file and against existing contacts, reporting
  "X imported, Y duplicates skipped". The rule is enforced by a
  database unique index on the normalized number, so the WhatsApp
  webhook, the form, import, and any future path all agree. Existing
  duplicates are merged into the oldest contact on upgrade (their
  conversations, deals, notes, and tags are re-pointed, nothing is
  lost). Closes #212.
- **Configurable default deal currency.** Each account can now pick
  its default currency under **Settings → Deals** (admin+); the app
  previously hardcoded USD throughout. New deals default to it, and
  pipeline-stage totals, the dashboard "Open Deals Value" card, the
  pipeline-value donut, and automation-created deals all use it.
  Existing deals keep the currency they were saved with — totals are
  shown in the account default with no exchange-rate conversion (one
  currency per account). Full guide:
  [Default currency](https://wacrm.tech/docs/settings#deals).
- **Members tab in Settings.** The user-facing surface for the
  multi-user APIs below, available to everyone (no beta flag). From
  Settings → **Members** an admin or owner can: see who's on the
  account with their role and join date, invite teammates by
  generating a one-time share link (pick the role + optional
  expiry), revoke pending invites, change a member's role, remove a
  member, and — as owner — transfer ownership. Recipients accept via
  a public `/join/[token]` page. Full guide:
  [Members docs](https://wacrm.tech/docs/members).
- **Account & member management API** — server-side endpoints
  backing the Members tab. All routes are role-gated and
  return Supabase-RLS-scoped data.
  - `GET /api/account` — caller's account + role. Any member.
  - `PATCH /api/account` — rename the account. Admin+.
  - `GET /api/account/members` — list members. Email visible to
    admin+ only; agents/viewers see name + avatar + role +
    joined date.
  - `PATCH /api/account/members/[userId]` — change a member's
    role. Admin+. Owner promotion/demotion goes through the
    transfer endpoint instead.
  - `DELETE /api/account/members/[userId]` — remove a member.
    Admin+. The removed user keeps their login and is moved to a
    freshly-created personal account (mirror of the signup flow).
  - `POST /api/account/transfer-ownership` — owner only. Atomic
    swap with the named member.
- **Invitation API + redeem flow** — the no-email, link-only
  invite path that powers the Members tab's "Invite member" button
  and the `/join/[token]` accept page.
  - `GET /api/account/invitations` — list outstanding (admin+).
  - `POST /api/account/invitations` — create an invite, returns
    the plaintext token + share URL **exactly once** (we store
    only the SHA-256 hash on the row). Body
    `{ role, expiresInDays?, label? }`. Admin+.
  - `DELETE /api/account/invitations/[id]` — revoke (admin+).
  - `GET /api/invitations/[token]/peek` — public, per-IP
    rate-limited. Returns `{ ok, account_name, role, expires_at }`
    or `{ ok: false, reason }` so the join page can render
    "You're being invited to <Account> as <Role>".
  - `POST /api/invitations/[token]/redeem` — authenticated.
    Atomically moves the caller's profile to the inviter's
    account and cleans up the orphan personal account. Refuses
    with 409 if the caller's current account already contains
    domain data (no silent data loss).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/017_account_sharing.sql` — introduces the
  `accounts` and `account_invitations` tables plus an
  `account_role_enum` type; adds `account_id` to every
  user-scoped table and backfills it; rewrites every RLS policy;
  replaces the new-user trigger. Idempotent. **No data loss** —
  every existing user is mapped to a freshly-created account
  with role `owner` and every existing row of theirs is linked
  to that account.
- `supabase/migrations/018_account_member_rpcs.sql` — adds three
  `SECURITY DEFINER` RPCs (`set_member_role`,
  `remove_account_member`, `transfer_account_ownership`) that
  back the member-management API. They self-check the caller's
  role and raise SQLSTATE `42501` / `22023` on forbidden / bad
  input so the API layer can map cleanly to 403 / 400.
  Idempotent.
- `supabase/migrations/019_invitation_rpcs.sql` — adds two
  `SECURITY DEFINER` RPCs: `peek_invitation` (anonymous read by
  token hash, returns a fixed-shape JSON envelope) and
  `redeem_invitation` (authenticated atomic move + orphan
  cleanup, with a domain-data safety check). Both bypass the
  RLS that would otherwise block their reads/writes. Idempotent.
- `supabase/migrations/021_account_default_currency.sql` — adds
  `accounts.default_currency` (`TEXT NOT NULL DEFAULT 'USD'`, with a
  3-letter-code `CHECK`) backing the configurable default currency.
  Idempotent; existing accounts backfill to `USD`. **Apply before
  deploying** — the app now reads this column when loading the
  account, so an un-migrated database breaks account loading.
- `supabase/migrations/022_contact_phone_dedup.sql` — adds the
  generated `contacts.phone_normalized` column, **merges existing
  duplicate contacts into the oldest** (re-pointing conversations,
  deals, notes, tags, custom values, and broadcast recipients — no
  data loss), then adds a `UNIQUE (account_id, phone_normalized)`
  index. Idempotent. **Apply before deploying** — CSV import reads
  `phone_normalized`, and the index is what enforces de-duplication
  for every write path. The one-shot merge runs inside the migration.

## [0.2.2] — 2026-05-29

Flow nodes can now send media. Closes the most-requested gap from user
feedback after the v0.2.0 Flows launch — flows were text-only and
couldn't deliver an invoice, receipt, product photo, or short demo
video mid-conversation.

### Added

- **`send_media` flow node.** Send an image (PNG / JPEG / WebP), video
  (MP4 / 3GP), or document (PDF, Word, Excel, PowerPoint, TXT) to the
  customer from any point in a flow. Pick a file in the builder, it
  uploads to the new `flow-media` Supabase Storage bucket, and Meta
  fetches the public URL at send time. Optional caption (1024 char cap,
  supports `{{vars.X}}` interpolation); documents also take an optional
  filename shown in the recipient's chat. Auto-advances after send —
  same suspend semantics as `send_message`.
  ([#156](https://github.com/ArnasDon/wacrm/pull/156))

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/016_flow_media.sql` — does two things:
  1. Adds `'send_media'` to the `flow_nodes.node_type` CHECK
     constraint. Without this the `send_media` node fails to save with
     a constraint violation.
  2. Creates the public `flow-media` Supabase Storage bucket (16 MB
     file-size cap, image / video / document MIME allowlist) plus
     per-user RLS policies (path prefix = `auth.uid()`). Without this
     the builder's file picker fails on upload. Same shape as the
     `avatars` bucket from migration 008 — the bucket is **public** so
     Meta can fetch the URL without credentials.

The migration is idempotent and safe to re-run.

## [0.2.1] — 2026-05-26

Bug-fix release. Plugs a silent inbound-message drop that triggered
when two users on the same instance saved the same WhatsApp
`phone_number_id`.

### Fixed

- **Inbound WhatsApp messages no longer silently disappear** when two
  users have claimed the same `phone_number_id`. Previously the
  webhook used `.single()` to look up the owning config, which errors
  `PGRST116` for both 0 rows *and* ≥2 rows — the second user's save
  put the DB into the ≥2-row state and every inbound message was
  dropped while the log misleadingly reported *"No config found for
  phone_number_id"*. Three layers of fix: `POST /api/whatsapp/config`
  now returns **409** when another user has already claimed the
  number, the webhook lookup distinguishes 0 rows from ≥2 rows and
  logs the conflicting `user_id`s, and a new DB constraint
  (`UNIQUE(phone_number_id)`) prevents the bad state at the storage
  layer. Reported in
  [#136](https://github.com/ArnasDon/wacrm/issues/136), fixed in
  [#143](https://github.com/ArnasDon/wacrm/pull/143).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/013_whatsapp_config_phone_number_id_unique.sql`
  — adds `UNIQUE(phone_number_id)` to `whatsapp_config`. **Fails
  loudly with a copy-pasteable resolution hint** if duplicate rows
  already exist; auto-deduping would destroy encrypted tokens, so
  the operator picks which row keeps the number. To check first:

  ```sql
  SELECT phone_number_id, array_agg(user_id) AS owners, count(*) AS n
  FROM whatsapp_config
  GROUP BY phone_number_id
  HAVING count(*) > 1;
  ```

  If that returns rows, `DELETE` the duplicate row(s) you want to
  drop, then re-run the migration.

### Note on multi-user setups

wacrm is intentionally **single-tenant per WhatsApp number**. RLS on
`conversations`/`messages` is `auth.uid() = user_id`, so a second
user physically cannot read messages routed to a different owner —
two users sharing one number was never supported. If you need
multiple humans handling the same inbox, run them under one shared
account.

_(Superseded by 0.3.0's multi-user accounts, below: RLS moved from
`user_id` to `account_id`, so teammates on the same account now do
share one inbox/number by design. This note describes the single-user
model as it stood at 0.2.1, before that change.)_

## [0.2.0] — 2026-05-22

The **Flows** release. Adds a no-code, branching, button-driven WhatsApp
conversation engine that runs alongside Automations. Also ships a
5-theme color picker in Settings and opens Flows to all users.

### Added

#### Flows — branching chatbot conversations

- **Module + schema.** New `flows`, `flow_nodes`, `flow_runs`,
  `flow_run_events` tables with partial unique indexes that enforce
  one active run per contact. Widened `messages.content_type` CHECK
  to accept `'interactive'`; added `interactive_reply_id` column so
  the inbox can render button/list taps.
  ([#112](https://github.com/ArnasDon/wacrm/pull/112))
- **Runner engine.** `dispatchInboundToFlows` parses every inbound
  webhook, decides whether the message is a reply on an active run
  or a fresh trigger, advances the state machine, and reports back
  to the webhook so consumed messages don't also fire automations.
  Idempotent on Meta's `message_id`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))
- **No-code builder UI** at `/flows`. Linear-list editor with
  per-node config forms, live validator, draft/active/archived
  status, and a 5-route REST API (`GET/POST /api/flows`,
  `GET/PUT/DELETE /api/flows/[id]`, `POST /api/flows/[id]/activate`,
  `GET /api/flows/[id]/runs`, `GET /api/flows/templates`).
  ([#115](https://github.com/ArnasDon/wacrm/pull/115))
- **Templates + v1.5 node types.** Three starter templates
  (Welcome menu, FAQ bot, Lead capture) cloneable from the New-flow
  dialog. Three new node types: `collect_input` (capture customer
  text into a variable), `condition` (branch on var / tag / contact
  field), `set_tag` (add or remove a tag). `{{vars.X}}` interpolation
  in send_message + collect_input prompts. Per-flow run-history
  viewer at `/flows/[id]/runs`.
  ([#117](https://github.com/ArnasDon/wacrm/pull/117))
- **Stale-run sweep cron** at `GET /api/flows/cron` — marks runs
  past their configured timeout (default 24h) as `timed_out` so
  abandoned conversations free up the contact for new triggers.
  Reuses `AUTOMATION_CRON_SECRET`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))

#### Color themes

- **5 color themes** (Violet default, Emerald, Cobalt, Amber, Rose)
  selectable from a new **Appearance** tab in Settings. CSS variables
  scoped under `html[data-theme="..."]`, applied at runtime via
  `dataset.theme`, persisted to `localStorage`. Inline boot script in
  `layout.tsx` replays the choice before first paint so there's no
  flash of the default.
  ([#132](https://github.com/ArnasDon/wacrm/pull/132))
- **Theme tokenization sweep** — every previously hard-coded
  `violet-*` Tailwind class replaced with `primary` tokens across
  ~49 files. Picking a non-violet theme now themes the whole app,
  not just the chrome.
  ([#133](https://github.com/ArnasDon/wacrm/pull/133))

### Changed

#### Flows — soft-GA

- **Flows is now available to every authenticated user.** The
  per-account beta gate is gone; the sidebar entry + page header
  carry a small "Beta" chip as the only remaining signal.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))
- **Editor UX**:
  - Internal `node_key` + per-button/row `reply_id` identifiers
    hidden behind a per-node "Show advanced" disclosure.
    ([#118](https://github.com/ArnasDon/wacrm/pull/118))
  - `send_list` nodes can have multiple sections.
    ([#119](https://github.com/ArnasDon/wacrm/pull/119))
  - Collapsed node cards show a 1-line content preview per node
    type (text excerpt, button titles, condition summary, etc.).
    ([#120](https://github.com/ArnasDon/wacrm/pull/120))
  - Validation issues are clickable: jump to + flash the offending
    node.
    ([#121](https://github.com/ArnasDon/wacrm/pull/121))
  - Unsaved-changes "● Edited" indicator + `beforeunload` reload
    guard.
    ([#122](https://github.com/ArnasDon/wacrm/pull/122))
  - New-flow dialog actually widens to fit the 3 template cards
    (was capped at 384px by a baked-in `sm:max-w-sm` from shadcn).
    ([#129](https://github.com/ArnasDon/wacrm/pull/129),
    [#131](https://github.com/ArnasDon/wacrm/pull/131))
  - Validation panel pinned to the viewport bottom so
    activate-readiness follows the user as they scroll through nodes.
    ([#130](https://github.com/ArnasDon/wacrm/pull/130))

#### Engine reliability

- **Atomic `execution_count` increment** via SECURITY DEFINER RPC —
  prevents lost counts when two webhooks start runs concurrently.
  Mirrors the automations engine pattern.
  ([#124](https://github.com/ArnasDon/wacrm/pull/124))
- **Preload all flow_nodes once per dispatch** — one SELECT per
  inbound instead of one per advance-loop iteration. A 5-node
  auto-advance chain now costs 1 round trip, not 5.
  ([#125](https://github.com/ArnasDon/wacrm/pull/125))
- **Wasted re-read dropped** after reprompt reset; `loadActiveRun`
  switched to defensive `.limit(1)` so a migration glitch producing
  duplicates can't crash dispatch.
  ([#126](https://github.com/ArnasDon/wacrm/pull/126))

### Security

- **PII redacted from `reply_received` event payload** — customer
  text is no longer persisted to `flow_run_events.payload`; only
  the length is. A `collect_input` prompt asking "what's your card
  number?" used to leave the PAN sitting in the events table.
  ([#123](https://github.com/ArnasDon/wacrm/pull/123))
- **Constant-time cron-secret compare** on `/api/flows/cron`
  (`crypto.timingSafeEqual`) to close a theoretical
  timing-side-channel on the `x-cron-secret` header check.
  ([#127](https://github.com/ArnasDon/wacrm/pull/127))

### Fixed

- **`/flows` no longer spuriously redirects to `/dashboard`** when
  navigating in. Root cause: `useAuth` flipped `loading: false`
  before the profile fetch resolved. `use-auth` now exposes a
  separate `profileLoading` boolean.
  ([#128](https://github.com/ArnasDon/wacrm/pull/128))

### Migration required

Apply, in order, against your Supabase project:

1. `supabase/migrations/010_flows.sql` — Flows core tables, indexes,
   RLS policies, and the `messages` schema widening.
2. `supabase/migrations/011_profile_beta_features.sql` — adds the
   `profiles.beta_features` column. Surviving for future betas;
   Flows no longer reads it.
3. `supabase/migrations/012_flows_increment_counter.sql` — atomic
   counter RPC. Without this the engine still runs but
   `flows.execution_count` is racy.

Each migration is idempotent — safe to re-run if you're not sure
whether you applied a previous one.

### Removed

- **`src/lib/flows/feature-flag.ts`** + its tests. Flows is open to
  all users; the `profiles.beta_features` column itself survives
  for future beta gates.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))

---

## [0.1.1] — 2026-05-19

### Added

- Chat actions in the inbox: emoji reactions, reply-with-quote, and
  copy-text on individual messages. Hover on desktop, long-press on
  touch. Outbound reactions and replies forward to WhatsApp via the
  Cloud API; inbound reactions and swipe-replies from customers
  arrive through the webhook and appear in real time.

### Migration required

- Apply `supabase/migrations/009_message_actions.sql` to your
  Supabase project. It adds `messages.reply_to_message_id` and the
  new `message_reactions` table (with RLS and realtime). The
  migration is idempotent — safe to re-run.

### Changed

- The webhook no longer stores inbound customer reactions as fake
  text messages. They are written to `message_reactions` instead,
  so any custom queries that counted reactions as messages will
  need updating.

---

## [0.1.0]

Initial template release. Core CRM: inbox, contacts, pipelines,
broadcasts, automations (with a Wait-step cron drain), WhatsApp
Cloud API integration, Supabase auth + RLS.
