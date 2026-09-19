# PLAN — Managed AI key ("use it without your own key"), metered and capped

Status: proposed (2026-09-17). Scope: a SECOND way to pay for AI beside
Bring-Your-Own-Key — an operator-owned key, pinned to one cheap model, with a
hard monthly volume cap per plan and a price that is set so the merchant always
pays more than the provider bills us. BYO stays, unchanged, and stays the
cheaper option for a heavy shop.

Related records: [PRICING_AND_LIMITS.md](../reference/PRICING_AND_LIMITS.md)
(the limit review that assumed AI is free for us — this plan is what makes half
of that assumption conditional), [SHOPIFY_COMPLIANCE_AUDIT.md](../app-store/SHOPIFY_COMPLIANCE_AUDIT.md)
§B4 (the audit finding that forced BYO in the first place, and the second,
unused option it explicitly allows), [AI_PROVIDER_BALANCE_FEASIBILITY.md](../reference/AI_PROVIDER_BALANCE_FEASIBILITY.md)
(why "how much credit is left" cannot be answered per provider — our own meter
answers it for both modes).

---

## 0. Why

Today an AI feature cannot be tried at all without first opening an account at
Anthropic, OpenAI, Google, xAI, DeepSeek or HuggingFace, creating a key, adding
a payment method and pasting the key into Settings. That is the app's first
screen after install, and it is four decisions and a credit card BEFORE the
first generated sentence. Most merchants evaluating a €9.90 app will not do it;
some of them do not even know what an API key is. The Free tier exists as an
evaluation hook (PRICING_AND_LIMITS §Befund 1) and cannot currently be
evaluated.

BYO was not chosen for that experience — it was chosen as the *cheapest fix* for
a compliance finding (§B4 below) and then rationalised into a pricing strategy
("AI costs us nothing, so languages are unlimited"). The strategy half is worth
keeping. The onboarding half is an acquisition blocker.

The ask is therefore not "replace BYO" but "**offer both, per plan, and make
the managed one profitable by construction**".

---

## 1. What exists today — the chokepoints this plan needs

| What | Where | Matters because |
|---|---|---|
| Key material is read from `AISettings` only | [shared.ts](../../app/routes/api-ai-handlers/shared.ts) `createAIService` | ONE factory — and 16 further `new AIService(...)` sites bypass it, plus 8 that reach it through `TranslationService` (below) |
| `initializeProvider()` throws `MissingAIKeyError` when the key is empty | [ai.service.ts](../../src/services/ai.service.ts) L271–316 | the structural guarantee §B4 bought — it must SURVIVE this plan |
| Pre-flight gate `getMissingPreferredKey` / `noAiKeyResponse` (409 `NO_AI_KEY`) | shared.ts L172–216 | 5 call sites; becomes the natural home of the mode/budget decision |
| Every provider call funnels through `executeAIRequest` → `_executeAIRequestInner` | ai.service.ts L1943–2150 | the ONE place a meter can sit. **NOT `askAI`** (L1778): `replayRequest` (L1914, task recovery) calls `executeAIRequest` directly, past the queue, the prompt log and anything `askAI` would carry |
| `estimateTokens` = `prompt.length/4 + 8192` | ai.service.ts L1764 | an estimate for the RATE limiter, never a cost — it charges a flat 8192 output tokens for every call, an order of magnitude above a typical completion (**assumed** until §4 measures it) |
| Provider responses are reduced to a string | `_executeAIRequestInner` L1970–2150 | all 11 provider calls live here, and every one **discards the `usage` object its SDK returns** |
| Rate limits are per PROVIDER and process-global, overwritten from ONE shop's `AISettings` | [ai-queue.service.ts](../../src/services/ai-queue.service.ts) L100–200, single caller [unified-content.actions.ts](../../app/actions/unified-content.actions.ts) L105 | with a SHARED key this becomes a cross-tenant lever: shop A raises the limit for everybody (§9) |
| `ImageOperationCounter` + `consumeImageOperations` | [imageOperations.server.ts](../../app/utils/imageOperations.server.ts) | the quota pattern to mirror: atomic conditional increment, UTC month, usage-not-entitlement, no cron |
| `trialConsumedAt` on `AISettings` | [schema.prisma](../../prisma/schema.prisma) L142–150 | the precedent for a once-per-shop grant, including its stated residual (uninstall+redact resets it) |
| Plan is derived from the Shopify-verified subscription by NAME, then PRICE | [billing.server.ts](../../app/services/billing.server.ts) `getPlanFromSubscription` | the mode must be encoded in the subscription, not in a column a client can write |

**The construction sites, counted properly.** `new AIService(...)` appears 17
times outside tests — but one of them IS the factory (`shared.ts`), so 16
bypass it: `direct-translation-ai.server.ts`, `theme-content-api.server.ts`,
`alt-text.action.ts` (×2), `sub-resources.action.ts` (×2),
`templates-translate-field.action.ts` (×2), `templates-generate.action.ts`,
`templates-translate-all.action.ts`, `unified-content.actions.ts` (×2),
`action-context.ts`, `app.seo.performance.tsx`, `translation.service.ts`,
`ai-queue.service.ts`.

That count still understates the work, because `translation.service.ts` only
forwards a config its OWN callers assemble — 8 further sites, one of which is
the important one: **[stale-translation-sync.server.ts](../../app/services/translations/stale-translation-sync.server.ts)
L1981 builds a full six-key config for the detached auto-retranslation**, an AI
run with no merchant in front of it (§9a). The rest are
`translation.action.ts` (×4), `alt-text.action.ts` (×2) and
`action-context.ts`. The honest inventory is "**10 modules assemble an
`AIServiceConfig` literal**" (`grep "huggingfaceApiKey:"`), not "17 call `new
AIService`" — and the resolver has to replace all ten.

A second key source added at only some of them is how a merchant gets two
different answers from two buttons — the exact shape of the `sendImagesToAI`
bug this repo already fixed once. **One resolver, every site** (§5) is
therefore not tidiness, it is the whole correctness argument.

**What is NOT a hole:** no AI inference happens outside `AIService` — only
`ai.service.ts` imports the four SDKs. `api.ai-models.tsx` does call three
provider APIs directly and decrypts merchant keys to do it, but that is model
LISTING, not inference: no tokens, no completion, nothing to meter. It needs an
explicit carve-out in §5's isolation test, not a rewrite.

---

## 2. The compliance question, answered

§B4 of the compliance audit is usually quoted as "an operator key is
forbidden". It does not say that. It names **two** acceptable fixes and the app
implemented the first:

> **Fix (eines der beiden, plus Disclosure):** 1. BYO-Key erzwingen … **oder**
> 2. explizites, geloggtes In-App-Consent-Gate vor jedem KI-Call.

So the managed mode is buildable, and it is buildable only WITH option 2. What
that costs, concretely, and all of it is a hard requirement of this plan:

1. **Explicit, logged, versioned consent** before the first managed call —
   never a pre-ticked box, never bundled into the plan purchase. Stored as
   `aiProcessingConsentAt` + `aiProcessingConsentVersion` on `AISettings`, and
   re-asked when the version changes (which it does the day a managed
   sub-processor changes). It names **both** providers — the default and the
   failover (§3a rule 6) — from the first managed call, because a
   sub-processor that first appears during an outage is not one anybody
   consented to.
2. **Disclosure**: [privacy.tsx](../../app/routes/privacy.tsx) §4.1 (L109–116)
   says content is processed *"only using your own API key"* and that the app
   *"does not provide a shared or operator-owned API key"* — **three
   sentences**, not one, all of them false on the day this ships. They are
   rewritten in the same commit, naming the managed sub-processor, the purpose,
   the no-training commitment and the transfer basis. A privacy page that
   contradicts the product is a review rejection on its own. The audit record
   needs the same treatment:
   [SHOPIFY_COMPLIANCE_AUDIT.md](../app-store/SHOPIFY_COMPLIANCE_AUDIT.md)
   L152–160 marks B4 "BEHOBEN (Ansatz A)" and states categorically that *no*
   code path sends merchant content through an operator account. B4 is not
   re-opened by this plan — it moves from fix 1 to fix 2 — but the document has
   to say so, or the next reader trusts a guarantee the code no longer makes.
3. **No training, no retention** — the managed provider must contractually
   default to no-training on API traffic. This disqualifies HuggingFace
   Inference (no such guarantee, §B4 says so) and free-tier Google.
4. **Data residency** is a merchant question, not only ours: DeepSeek processes
   in China. For an EU-facing app that is an answer the merchant must be able
   to read before consenting, and the simplest correct move is to exclude it
   as the managed default (§3).
5. **The env-var no-go stays.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `GOOGLE_API_KEY`, `GROK_API_KEY`, `DEEPSEEK_API_KEY`, `HUGGINGFACE_API_KEY`
   are named in §B4 as variables that must never be set, because the code no
   longer reads them. This plan does NOT revive them. The managed credential
   lives under its own names (`MANAGED_AI_*`, §5) and is read by exactly ONE
   module, which is also the module that enforces consent and budget. A key
   that can only be obtained together with its gate cannot be obtained past it.
   Residual to clear in the same change: `.env.development.template` and
   `.env.production.template` still list four of the six forbidden names
   (empty) — an invitation B4 asked to remove.

6. **Two more things must be settled before a line is written, and the plan
   was wrong to treat §B4 as settling them.** (a) That audit is *this app's own
   reading* of PPA §6.1 / the API Terms, written to justify BYO — and the code
   says the opposite even more flatly: `api-ai-handlers/shared.ts` states
   "Shopify PPA/API Terms forbid processing merchant content via a
   shared/operator key". One of those two will be quoted at a reviewer. Cite
   Shopify's own text, and rewrite that comment in the same commit.
   (b) **The AI provider's terms.** Checked 2026-09-18, and the answer is
   good — but it turns on a distinction the product has to keep visible.
   OpenAI's Business Terms grant the right to "integrate the Services into
   Customer Applications and to make Customer Applications available to End
   Users" while prohibiting "resell[ing] or leas[ing] access to their Account
   or any End User Account"; Google's API Terms likewise forbid *sublicensing
   an API for use by third parties* while the ordinary build-an-app case is
   what the whole developer programme is for. Managed mode is the permitted
   side: a merchant never receives API access, a key, or a model endpoint —
   they get app features, and the budget is our internal cost control.

   The rule that follows is about PRESENTATION, not only architecture: the
   offer is "a plan whose AI is included, with a fair-use volume", never "X
   tokens for €Y". Selling a metered token quantity is what makes an
   application look like resold API access, and it is also the unit §7 already
   refuses for a second reason (a "call" is not stable in this codebase). Two
   things stay owed before launch: the operator account must be a business/paid
   tier whose no-training default applies, and we are contractually the
   responsible party for end-user behaviour — which means the existing
   `sanitizePromptInput` layer and the usage-policy wording in the merchant
   terms are compliance obligations here, not hygiene.

Also load-bearing: `initializeProvider()` keeps throwing when it gets no key.
The managed key is INJECTED into the config by the resolver; `ai.service.ts`
never learns that `process.env` exists. That keeps §B4's structural guarantee
("there is no code path that sends merchant content through an operator
account") true in the only form that matters — *unless the resolver decided so,
with consent recorded and budget available*.

---

## 3. Which provider, which model

Requirements, in order: no-training default, acceptable data-protection story
for EU merchants, cheapest token price that still writes usable multilingual
marketing copy, vision capability (the app's alt-text and image-aware
generation paths), and a stable model id.

Prices below are public list prices looked up on 2026-09-17 (USD per 1M
tokens). By this repo's own standard that is a **bare claim, not a
measurement** — there is no probe route to re-check it in one click, the way
`api.translation-probe.tsx` re-checks a platform fact. Treat them as dated
inputs to the guard in §7, owned by the monthly ops re-check in §13, and note
that two of the four candidates are not in this repo's model config at all.

| Candidate | in / out | Vision | No-training default | Verdict |
|---|---|---|---|---|
| **OpenAI `gpt-5-nano`** | 0.05 / 0.40 | yes | yes (API default) | **DEFAULT** — cheapest by far, pending the quality bake-off |
| **Anthropic `claude-haiku-4-5`** | 1.00 / 5.00 | yes | yes | **FAILOVER** (owner's decision, 2026-09-19) — 200K context, ~14× the blended cost of nano |
| Google Gemini 3.1 Flash-Lite | 0.25 / 1.50 | yes | paid tier only | not chosen; note 2.5 Flash-Lite retires 2026-10-16 |
| DeepSeek `deepseek-flash` | 0.15 / 0.60 off-peak | no | unclear | excluded: residency (§2.4), no vision, peak/off-peak pricing |
| HuggingFace | — | no | **no** | excluded by §B4 |

**Two models, two PROVIDERS — and the second one is the whole point.** A pinned
model with no alternative means one provider's outage is our outage, and §13
named that with no answer. `claude-haiku-4-5` is the failover: different
company, different network, different status page, vision on both sides, and
no-training by default on API traffic for both. It is deliberately not a second
OpenAI model — a second model behind the same endpoint fails with the endpoint.

Everything difficult about this follows from ONE number: Haiku is **~14× nano**
blended (1500-in/700-out: $0.000355 vs $0.005). §3a is that number's
consequences. Two smaller facts belong here: Haiku's context window is **200K**,
i.e. SMALLER than the default's — irrelevant at this app's prompt sizes
(`CHUNK_THRESHOLD_CHARS` caps a batch around 10K tokens) but the reason an
input-too-long failure must never trigger a failover (§3a); and the id is
`claude-haiku-4-5` with **no date suffix**, while this repo's `CURATED_MODELS`
still carries `claude-3-5-haiku-20241022`, a previous generation.

Three further decisions follow from the table:

- **Both models are PINNED and the merchant chooses neither.** Provider and
  model selection stay a BYO privilege. Cost control a customer can switch off
  is not cost control — and a "choose your model" dropdown over our key is an
  invitation to select Opus. The failover is automatic and is the ONLY way the
  second model is ever reached. Note also that `gpt-5-nano` is not in
  [ai-models.config.ts](../../app/config/ai-models.config.ts) at all
  (`DEFAULT_MODELS.openai` is `gpt-4o-mini`) — the pinned candidate joins the
  repo's vocabulary in the same commit.
- **Model ids in the repo are already stale**, and more of them than the two
  defaults: `DEFAULT_MODELS` carries `deepseek-chat` and
  `gemini-2.0-flash-lite`, and `CURATED_MODELS` adds `gemini-1.5-pro/flash`,
  `gpt-4-turbo`, `o3-mini`, `grok-2-vision-1212` and a `claude-opus-4-0-…` id
  that is not valid in either the alias or the dated form
  ([ai-models.config.ts](../../app/config/ai-models.config.ts)). Harmless for
  BYO (the merchant picks from a live listing), an outage for managed mode. A
  model id we DEPEND on gets a startup check (§9.6); the rest is a separate
  tidy-up, named here so it is not discovered as a managed-mode incident. The
  retirement dates quoted in this section are external facts, re-checkable but
  not verifiable from the repo.
- **Quality is measured before the choice is final** (Phase 0, §11): the same
  prompts this app really sends — a product description, a 5-field batch
  translation into 3 locales, an alt text, an SEO title under a character cap —
  run against nano, Flash-Lite and Haiku, judged side by side. A managed
  default that writes worse copy than the app's reputation implies costs more
  than it saves. Cheapest-that-is-good-enough, not cheapest. The bake-off now
  answers two questions rather than one: which model is the DEFAULT, and
  whether the FAILOVER holds the same output contract — the prompts expect
  parseable, length-capped answers, and a fallback that writes beautifully but
  ignores a 60-character SEO cap fails saves during an outage, which is the
  worst moment to discover it.

---

## 3a. Failover — what a 14× price difference does to every rule

The failover exists so an OpenAI outage is not a ContentPilot outage. Left
naive, it turns one company's bad afternoon into our bad month. Eight rules,
each with the failure it prevents.

**1. A failover must never shrink what the merchant bought.** The budget is
debited at the **DEFAULT model's price**, whichever model actually ran; we
absorb the difference. Anything else means a merchant watching their volume
evaporate at 14× speed because of an outage they did not cause and cannot see —
punishing the customer for our supplier. This is the rule the other seven exist
to make affordable.

**2. Therefore the ledger carries two numbers, not one.** `costMicros` is what
we really paid (priced per model, so a Haiku call is priced as Haiku);
`billedMicros` is what the merchant's budget was charged (always at default
prices). They are equal in normal operation and diverge exactly during a
failover, which also makes the gap the metric that says what failover cost us.
The §7 margin guard reads `costMicros` — a guard that read the billed figure
would be blind to the only event that can break it.

**3. A global failover budget, because "we absorb it" is otherwise unbounded.**
Worked: if every managed shop ran on Haiku for one full day, that day costs
~14/30 ≈ **47 % of the whole month's provider budget**. Affordable once, not
repeatedly. So `MANAGED_AI_FAILOVER_BUDGET_MICROS` (a share of the month's
managed spend, ~25 % to start) with an alert at half of it, and on exhaustion
managed mode answers `managedUnavailable` (§5) rather than spending without a
ceiling. Degrading to "temporarily unavailable" during a long outage is honest;
an unbounded invoice is not.

**4. What triggers a failover is a SHORT list, and the exclusions are where
the money is.** Fail over on: a connection error, a timeout, a 5xx, a
model-not-found (the retired-id case §3 names), and a 401 on OUR key — that one
alerts loudly, because it is our misconfiguration, not the merchant's problem.
Fail over on a 429 **only after the queue's own retries are exhausted**; doing
it on the first 429 converts an ordinary throttle, which the queue is built to
absorb, into a 14× cost event. **Never** fail over on `isInputTooLongError`
(the fallback's context is smaller — it is guaranteed to fail too), on a
content-policy refusal, or on a malformed-request 400: the second provider
returns the same answer and we have paid twice for one failure. The app already
owns these predicates (`isAuthError`, `isInputTooLongError`) — the failover
reuses them rather than growing a second vocabulary.

**5. A circuit breaker, not a per-call retry.** Per-call failover means every
single call pays the primary's failure first, for the whole outage. So: after
N consecutive qualifying failures inside a window, managed traffic routes to
the fallback for M minutes, then ONE probe call decides whether to come back.
This is sound precisely because production runs a single instance
([RAILWAY-SETUP.md](../../RAILWAY-SETUP.md) §0) — and it is a **fifth
process-local state**, so it joins that document's table when it is built. On a
second instance, two breakers would trip and recover independently.

**6. Consent names BOTH providers from day one.** A sub-processor that first
appears during an outage must not be how a merchant learns their content went
somewhere new — and an outage is the worst possible moment to ask. So §2's
consent text, the privacy page and the settings copy list OpenAI *and*
Anthropic from the first managed call, whether or not the fallback ever runs.

**7. The failover is a quality UPGRADE, and that is its own trap.** Haiku 4.5
is the stronger model, so a failover never degrades output and needs no quality
gate. The trap is the opposite direction: output during an outage may read
*better*, which is an argument someone will make for promoting the fallback to
default. It costs 14×; if quality is the reason to move, that is a pricing
decision (§7), not an ops one.

**8. Which model wrote a text is recorded, not inferred.** `Task.aiModel`
already stores it, so support can answer "why does this one read differently"
without guessing, and the failover shows up in the task log rather than only in
our own metrics.

Startup validation (§9.6) covers both credentials and both ids. A MISSING
fallback does not refuse to start managed mode — running on one provider is
what we do today — but it is logged and alerted as "no failover configured",
because the silent version of that state is how an outage becomes a surprise.

---

## 4. Phase 1 — the meter (ships first, alone, and is useful without any of the rest)

Nothing about pricing can be decided honestly until the app knows what one
operation actually costs. It does not know today: `estimateTokens` exists for
the rate limiter and over-counts output by roughly 10×, and the real `usage`
objects the SDKs return are discarded.

**4.1 Capture real usage at the one chokepoint.** `_executeAIRequestInner`
returns `{ text, usage }` instead of `string`, and the CHARGE is taken in
`executeAIRequest` — deliberately not in `askAI`, which `replayRequest` skips
(§1). Two shapes need care rather than a table row:

- **Gemini reads `usageMetadata` at THREE sites**, because the branch obtains
  its `response` three times (vision, vision-fallback, text-only), and the
  vision fallback makes **two provider calls inside one invocation**. A single
  `{text, usage}` cannot express two billed calls — the failed first one has to
  be added, or it is spend the meter never sees.
- **HuggingFace** declares `usage` on its chat-completion output too, so the
  gap is not the SDK but whether the routed provider fills it. Treat a missing
  field as the estimate case, never as zero.

| Provider | Field |
|---|---|
| Anthropic | `message.usage.input_tokens` / `output_tokens` |
| OpenAI, Grok, DeepSeek | `completion.usage.prompt_tokens` / `completion_tokens` |
| Gemini | `response.usageMetadata.promptTokenCount` / `candidatesTokenCount` |
| HuggingFace | `response.usage` when present, else estimate |
| (any branch) | absent or partial → estimate, flagged |

`usage.source` is `"provider"` or `"estimate"`. **An estimate rounds UP** — it
is the direction that costs us money if it errs, the same rule
`estimateCalls` follows in the bulk editor. A missing usage object is never
read as zero: a call that reported nothing still counts, at its estimate, and
the estimate share is stored so "the meter says €2 but the invoice says €3" is
diagnosable instead of mysterious.

**4.2 One price table, one module.** `app/config/ai-pricing.ts`:
`MODEL_PRICING: Record<provider, Record<modelId, {inMicrosPerMToken,
outMicrosPerMToken}>>` in **micro-euro** integers — which means a
`USD_PER_EUR` constant exists whether or not anyone names it, since every
provider lists in USD. It is named, dated and owned here, beside the prices,
and it carries the same monthly re-check: a table computed at 1.08 understates
the euro cost by ~14 % if the rate moves to 0.95, which is more than half of
what the §7 buffer is supposed to absorb (no floats — this is money,
and the `Task`/logger paths JSON-stringify their values, where a `BigInt`
throws; Int µ€ tops out at €2,147 per counter row, far past any monthly shop
total, and is clamped with a warning rather than wrapped). A model the table
does not know is priced at the **most expensive** entry of its provider and
logged — an unknown price must never read as free.

**4.3 Ledger.**

```prisma
model AiUsageCounter {
  id             String   @id @default(cuid())
  shop           String
  period         String   // "YYYY-MM" (UTC), or "taster" for the one-time grant
  source         String   // "managed" | "byo"
  calls          Int      @default(0)
  estimatedCalls Int      @default(0)  // calls whose usage was estimated
  failoverCalls  Int      @default(0)  // calls served by the fallback provider
  inputTokens    Int      @default(0)
  outputTokens   Int      @default(0)
  costMicros     Int      @default(0)  // micro-EUR we really paid (priced per model)
  billedMicros   Int      @default(0)  // micro-EUR charged to the merchant's budget
  updatedAt      DateTime @updatedAt
  @@unique([shop, period, source])
  @@index([shop])
}
```

`costMicros` and `billedMicros` are equal except during a failover, where the
merchant is charged at the default model's price and we carry the rest (§3a
rules 1–2). The quota reads `billedMicros`; the margin guard reads
`costMicros`; the difference, summed, is what the failover cost us and is the
number the global failover budget (§3a rule 3) is measured against.

Plus three columns on `Task` (`inputTokens`, `outputTokens`, `costMicros`), so
the Tasks tab can answer "what did that bulk run cost" per run — `Task` already
carries `provider` and `aiModel` and expires after 3 days, so this is the
cheapest possible per-run record.

`AiUsageCounter` is shop-scoped, so **`redactShopData` must purge it** — the
GDPR schema-coverage guard fails otherwise, by design.

**4.4 BYO is metered too.** Same table, `source: "byo"`, no cap. Three payoffs:
it is the measurement this plan's numbers come from; it gives BYO merchants the
"what is this costing me" answer that
[AI_PROVIDER_BALANCE_FEASIBILITY.md](../reference/AI_PROVIDER_BALANCE_FEASIBILITY.md)
concluded no provider can give uniformly; and it makes the managed/BYO
break-even visible to the merchant deciding between them.

---

## 5. Phase 2 — one credential resolver

`app/services/ai/ai-credentials.server.ts`, the ONLY module in the app that
reads `MANAGED_AI_*` — now **two** credentials, the default
(`MANAGED_AI_PROVIDER` / `_MODEL` / `_API_KEY`) and the failover
(`MANAGED_AI_FALLBACK_*`). They are resolved as a UNIT: provider, model and key
always travel together, because the failover crosses providers and a mismatched
pair is a key sent to the wrong endpoint. Which of the two a call gets is the
breaker's answer (§3a rule 5), never a caller's choice:

```ts
type AiCredentialDecision =
  | { ok: true; source: "byo";     provider: AIProvider; config: AIServiceConfig }
  | { ok: true; source: "managed"; provider: AIProvider; model: string;
      config: AIServiceConfig; role: "default" | "failover" }
  | { ok: false; reason: "noKey";          provider: AIProvider }   // 409 NO_AI_KEY (today's)
  | { ok: false; reason: "consentMissing" }                          // 409 AI_CONSENT_REQUIRED
  | { ok: false; reason: "budgetExceeded"; used: number; limit: number } // 402 AI_BUDGET_EXCEEDED
  | { ok: false; reason: "managedUnavailable" };                     // 503, kill switch / misconfig
```

Resolution order, and each step is a decision someone could get wrong:

1. **Mode comes from the verified subscription**, mirrored to
   `AISettings.managedAiActive` by `checkAndSyncSubscription` — never from a
   form field, never from the client. Same rule as `subscriptionPlan`.
2. **A merchant key WINS over the managed key when the merchant has one and
   asked for it.** Managed mode does not delete BYO keys and BYO keys do not
   disable a managed subscription; the merchant's stored choice
   (`AISettings.aiKeySource`) decides, and it can only be set to `managed`
   while the subscription says so. This is what makes "I hit the cap" a
   one-click escape (§7) rather than a support ticket.
3. **Consent** is checked in managed mode only, before anything else is spent.
4. **Budget** is checked last, because it is the only step that costs a DB
   round trip.

Every one of those sites — the 16 direct ones, the 8 behind `TranslationService`
and the 10 modules that assemble a config literal — goes through it.
`createAIService` in
`shared.ts` and `createAIService` in `action-context.ts` become thin wrappers
over the same call; `theme-content-api.server.ts`,
`direct-translation-ai.server.ts` and the four template actions stop assembling
key config themselves. The unit test that keeps this true is a grep-style
guard, like the repo's GraphQL-hygiene test: **no file outside the resolver may
mention a `*_API_KEY` env var or build an `AIServiceConfig` literal.**

---

## 6. Phase 2b — enforcement

**Pre-flight.** The existing gate call sites (`api.ai.tsx`, whose one gate
covers **19 AI actions** — 23 `case` branches minus the 4 in `NON_AI_ACTIONS`;
the "11 handlers" in the compliance audit is stale and was copied forward once
already — plus `api.translate-alt-text-template.tsx`,
`templates-translate-field.action.ts` ×2, `api.seo-internal-links.tsx`) switch
from `getMissingPreferredKey` to the resolver and get three new refusal codes.
All of them are directly POST-reachable, so this is server-side or it is
nothing — the same rule the `/api/ai` plan gates already follow.

**The gate is necessary and nowhere near sufficient.** Those five entry points
cover the interactive paths only. The heaviest AI consumers in this app never
pass one — see §6a, which is the single most important correction this plan
received in review. So the decision lives **per AI request**, in
`executeAIRequest`, and the HTTP gate is only the early, friendly copy of it.

**Charging.** After the call returns, when `source === "managed"`: increment the
counter by the computed cost, atomically, in the `consumeImageOperations`
shape. BYO increments the same row without a cap. Two things the first draft
got wrong here, both in the direction that costs us money:

- **Every provider ATTEMPT is billed, not every logical call.**
  `AI_SDK_MAX_RETRIES = 2` gives each SDK up to 3 HTTP attempts, and the
  queue re-enqueues up to 3 more times on rate-limit errors — so one logical
  call can be nine billed attempts of which the meter would see one. Either
  meter at the transport boundary, or set `maxRetries: 0` and retry where the
  meter can see it.
- **A timed-out call is charged at its worst case, never at zero.**
  `executeAIRequest` races `_executeAIRequestInner` against a 120 s timer and
  the losing promise is not cancelled: the provider finishes generating and
  bills us. That biases the undercount towards the longest, most expensive
  calls — exactly backwards.

**An `AIService` with no `shop` cannot be metered, so it cannot be managed.**
`theme-content-api.server.ts` builds one with neither `shop` nor `taskId`,
which also makes it skip the queue entirely (`askAI` executes directly when
either is missing). In managed mode that is a refusal, not a free call; the
call site passes the shop or it stays BYO-only.

**The reservation problem, stated rather than hidden.** A call's cost is not
knowable before it runs, so a hard cap cannot be exact. The rule: **a call may
START only while `remaining > 0`**; the overshoot is bounded by
`MAX_GLOBAL_CONCURRENCY` × the worst-case single call (input ceiling +
`max_tokens: 8192`), **times the number of web instances**. Two facts settle
that second factor, and they are settled rather than assumed (owner, 2026-09-18):
there are two environments, develop and production, and **production runs a
single instance**. So the bound is real today — one process, one queue, one
sliding window. It is also *load-bearing*: the queue, its rate-limit window,
`retranslationsInFlight` and the three auto-run ticks are all in-memory
singletons, so the day production is scaled to two instances, every one of them
doubles or races. That is a pre-existing property of the app, not something
this plan introduces — but managed mode is the first feature where it costs
money directly. Written down 2026-09-19 in
[RAILWAY-SETUP.md](../../RAILWAY-SETUP.md) §0 ("Der Web-Service läuft mit EINER
Instanz"), with the four process-local states named, so it is a stated
precondition rather than a dashboard number nobody recorded.
`AI_QUEUE_CONCURRENCY` (default 4, tunable to 32) is the other half and moves
the bound 8× on an ops edit, which is why the managed path still needs its OWN
per-shop in-flight ceiling (§9.2). A design that instead reserved the worst case up front would refuse the
last 80 % of a budget on every plan, which is the expensive direction of wrong
for the merchant; a design that only checked afterwards would have no bound at
all. This is the middle one, and the bound is what the margin guard in §8
leaves headroom for.

**Degradation is never a half-written save — and never a DELETION.** A budget
refusal at the gate happens before a task row exists. A refusal during a bulk
run fails per cell (`BulkFailure.columnId`, the existing rule), reports the
reason once, and leaves every written cell written. And the rule §6a exists
for: a budget refusal inside a detached repair must be reported as an ABORT,
never as an entry the AI could not deliver.

**A warning before a wall.** At 80 % the app says so (banner in Settings →
usage, and once in the task summary). "Your AI volume is used up" arriving with
no warning, mid-catalogue, is the review nobody wants.

---

## 6a. Unattended spend — the half the first draft missed entirely

Under BYO, a background run spends the merchant's money and nobody had to think
about it. Under our key it spends ours, and **none of these paths passes an
HTTP gate**:

| Path | Trigger | Shape |
|---|---|---|
| `reconcileStaleTranslations` → `repairStaleTranslations` | `products/update` / `collections/update` webhook | one AI request **per locale** per changed resource, detached |
| `reconcileAfterPrimarySave` | every `updateContent` save on a webhook-less type, sub-resources, metaobjects, alt-texts, theme, menus | same, detached, fired from the save |
| `TranslationDriftAutoRunService` | hourly tick, daily per shop — **no HTTP request at all** | up to `MAX_DRIFT_HANDOVERS` resources × locales |
| `retranslate.server.ts` flush in `applyBulkDiff` | end of every bulk save | up to `MAX_REPAIR_GROUPS` detached runs × locales |
| `bulkEditorTranslate`, `seoBulkMeta`, `seo-bulk-fix` | one gated POST, then `void run…()` | hours of spend after the gate already answered |
| queue + SDK retries | any 429/5xx | up to 9 provider attempts per logical call |

**The worst case needs no deliberate action at all.** A supplier feed or a CSV
import rewrites descriptions on 2,500 products: `products/update` fires for
each, the digest gate legitimately passes, and the repair runs 2,500 × 10
locales = **25,000 AI calls** — more than a whole Max budget, in one afternoon,
from an event that happened outside this app. The daily drift sweep alone is
~7,500 calls/month at 10 locales, i.e. a large share of the budget consumed by
something nobody clicked. And `maxLocales: Infinity` — the USP §7 keeps — is a
direct, uncapped multiplier on every one of these.

Three rules follow, and the first is not about money:

1. **A budget refusal must never masquerade as a failed translation.** In
   [stale-translation-sync.server.ts](../../app/services/translations/stale-translation-sync.server.ts)
   every entry the AI could not deliver lands in `outcome.failed`, and
   `if (mayPurge && !outcome.startFailed && outcome.failed.length > 0 && …)`
   then sends `translationsRemove` to Shopify and deletes the local row —
   where `mayPurge = purgeOnPrimaryChange || autoTranslateExternalChanges` is
   **always true on exactly the shops managed mode serves**. So a
   `budgetExceeded` thrown inside the locale loop would be indistinguishable
   from "the model returned nothing" and would **DELETE the merchant's existing
   storefront translations because our prepaid budget ran out** — unrecoverably,
   since the digest baseline has already advanced and the sync can never
   re-detect them. A budget refusal is therefore modelled as `startFailed` (or
   its own `aborted` outcome), which that condition already excludes, and a
   test pins that a budget-refused run leaves every stale row untouched. This
   is the most expensive bug this plan could have shipped, and it is a
   one-line condition away in either direction.
2. **Unattended work gets its own sub-cap.** A per-shop daily ceiling on
   managed spend from background paths, separate from the period budget, so a
   webhook storm cannot spend a month in an hour. Interactive work — the
   merchant sitting there clicking — is never refused while the unattended
   sub-cap is what is exhausted.
3. **A refused detached run is VISIBLE.** These paths have no UI; §8's 80 %
   banner is an interactive-path answer. A budget-refused background run writes
   a `Task` row with a merchant-readable reason, or the merchant's experience
   is "the automatic translation silently stopped working" — which is the
   support ticket that costs more than the tokens.

---

## 7. Phase 3 — plans, prices and the margin guard

**Shape.** Entitlements stay 4-valued (`Plan`) — every `Record<Plan, …>` in
the app keeps working. Key source is a **second axis**, not eight plans:
`PLAN_CONFIG` is untouched and `MANAGED_AI` is a new table beside it.

The billing types cannot stay as they are, though, and the plan should say so
rather than imply otherwise: `BillingPlan` is `'free'|'basic'|'pro'|'max'` and
`BILLING_PLANS` is a `Record` over exactly the three paid keys, with
`getPlanFromSubscription` returning the matched KEY. A managed variant is
therefore a SECOND map (`MANAGED_BILLING_PLANS`, same three keys) that the
resolver also consults, returning `{ plan, aiMode }` — not a widened
`BillingPlan`, which would ripple into every plan-keyed record in the app. Name
and price must both stay unambiguous across the six paid products, since the
name match is tried first and the price fallback takes the FIRST match.

Proposed numbers. **The budget column is provider cost, not merchant price** —
what we are willing to spend for that merchant in a UTC month:

| Plan | today | with managed AI | surcharge | net at worst case¹ | monthly budget | cost share |
|---|---|---|---|---|---|---|
| Free | €0 | — (one-time taster, §10) | — | — | see §10 | — |
| Basic | €9.90 | **€21.90** | €12.00 | €10.20 | **€1.50** | 14.7 % |
| Pro | €19.90 | **€39.90** | €20.00 | €17.00 | **€2.50** | 14.7 % |
| Max | €59.90 | **€99.90** | €40.00 | €34.00 | **€5.00** | 14.7 % |

Two things in that table are consequences, not preferences.

**No price may collide with any other product's price**, current or planned.
`getPlanFromSubscription` matches the subscription NAME first and falls back to
the first entry with a matching PRICE — and that fallback exists precisely for
renamed subscriptions, so it is not hypothetical. The obvious "Basic + AI =
€19.90" is exactly the collision: €19.90 is Pro's price today, and a renamed
Basic+AI subscription would resolve to Pro — managed mode silently off,
entitlements silently up. Hence €21.90. The full set that must stay distinct is
{9.90, 19.90, 59.90} today, {21.90, 39.90, 99.90} managed, and the v2.0 table
in PRICING_AND_LIMITS.md {14.90, 29.90, 79.90} if it is ever adopted.

**The budgets are what the guard ALLOWS**, not round numbers chosen first: the
guard's effective ceiling is `0.20 / 1.25 = 16 %` of net. (The first draft put
1.50 / 3.00 / 6.00 against surcharges of 10/20/40, which reads as a 17.6 % cost
share and **fails its own test** — the buffer multiplies the budget, so "below
20 %" is not the same as "passes". Kept as the worked example of why the guard
is a test and not a habit.)

¹ net of Shopify's revenue share taken at its worst case (15 %; it is 0 % below
$1M/year today, so this is deliberate pessimism).

**What that buys the merchant**, at the two candidate models and an assumed
1,500-in / 700-out call (**an assumption to be replaced by Phase 0's measured
average — it is the one number the whole table stands on**):

| Budget | `gpt-5-nano` | Gemini 3.1 Flash-Lite |
|---|---|---|
| €1.50 (Basic) | ≈ 4,500 calls | ≈ 1,100 calls |
| €2.50 (Pro) | ≈ 7,600 calls | ≈ 1,900 calls |
| €5.00 (Max) | ≈ 15,100 calls | ≈ 3,800 calls |

**A "call" is not a unit this app can sell, and the merchant-facing figure has
to admit that.** `translateFieldsToLocalesChunked` packs several fields AND
several locales into one request and splits at `CHUNK_THRESHOLD_CHARS`, so the
same work is 30 calls or 3,000 depending on field lengths; and every provider
runs with `max_tokens: 8192`, i.e. a worst-case call is ~12× the assumed 700
output tokens. The enforced quantity is therefore µ€ and only µ€ (one answer to
one question); what the merchant is shown is derived from the MEASURED average
and stated as a range or in a work unit they recognise ("about 300–500 products
translated into one language"), never as a single precise-looking action count
the next long description falsifies.

For orientation: translating a 100-product Basic catalogue into 5 languages is
~500 calls; a 500-product Pro catalogue into 5 languages is ~2,500. Both fit,
with room for the merchant to re-run things — which is the point. A cap that a
normal month bumps into produces refunds and one-star reviews, and it is the
expensive kind of cheap.

**The guard is a test, not a promise.** `tests/unit/managed-ai-margin.test.ts`
fails the build when, for any plan:

```
budgetMicros × FX_AND_PRICE_BUFFER (1.25)  >  surchargeNet × MAX_COST_SHARE (0.20)
```

with `surchargeNet = (managedPrice − basePrice) × (1 − 0.15)`.

The 1.25 is **three separate risks wearing one number**, which is exactly the
shape this repo calls a rule without its failure mode. Split them, size them
separately and let the test multiply them: `FX_BUFFER` (the provider bills USD,
we are paid EUR — §4.2's `USD_PER_EUR`), `LIST_PRICE_BUFFER` (a provider raises
prices mid-period and we cannot re-price until the next billing cycle) and
`OVERSHOOT_BUFFER` (§6's bound, which is a function of
`AI_QUEUE_CONCURRENCY` × instances — one instance today, §6). The 0.15 revenue share is
likewise an assumption inside a constant: name its source, and check whether
anything else is withheld from an EUR payout before the guard's whole margin
argument rests on it.

Raising a budget or cutting a price without touching the other is what the test
exists to stop, and it is the mechanical form of the requirement this plan
exists to satisfy — *the merchant must pay more than we pay*.

**Four rules about WHEN a budget exists, each of which is a hole in the first
draft** — all four were found by review, all four are free money for somebody:

1. **No managed budget during the free trial.** Every paid tier carries
   `trialDays: 7` and Shopify reports a trialing subscription as `ACTIVE`, so
   the mirror would read `managedAiActive: true` for a week nobody pays for.
   Subscribe on the 27th and the calendar-month counter even grants TWO
   budgets. During `getTrialInfo().inTrial` the managed allowance is the
   **taster**, not the plan budget — and the `trialConsumedAt` residual (an
   uninstall + `shop/redact` deletes the whole `AISettings` row and makes the
   shop trial-eligible again) is 50–100× more expensive here than it is for the
   taster, so it is stated in euros, not waved at.
2. **A shop that pays nothing gets the FREE tier's cost limits, whatever plan
   it holds** — the owner's rule, 2026-09-19, and §7a is the whole of it.
3. **The budget period is the BILLING period, not the calendar month.** Plans
   bill `EVERY_30_DAYS` with `APPLY_IMMEDIATELY` proration on switches, while
   `ImageOperationCounter`'s "YYYY-MM" key is a calendar month. Keeping the
   calendar key produces: a sign-up on the 31st that gets two full budgets in
   one billing period (on Max that is 12.00/34.00 = 35 % cost share, 1.76× the
   guard the whole plan rests on); an upgrade-spend-cancel of ≈€4.87 per shop
   per month, repeatable; and a downgrade-after-spend at 62 % cost share. So
   the counter is keyed by the subscription's own period, and a mid-period
   upgrade does not mint a second budget — the LIMIT is read from the current
   plan at check time while the USED figure carries over.
4. **A refund is not a refund of the tokens.** Shopify can refund an app charge
   and deduct it from the payout; the tokens are spent and non-refundable.
   Worst case is the full period budget against €0 revenue, the same order as
   the trial hole. Stance to state in the plan rather than discover: no
   pro-rata refund of a consumed budget, a support credit is a manual and
   logged act, and repeated disputes are a reason to refuse managed mode for
   that shop.

**Deliberately NOT in v1:** usage-based overage billing. Shopify's
`appUsagePricing` line item (with `cappedAmount`) is the correct instrument and
would turn the wall into a sale, but it needs a second subscription line item,
its own approval UX and its own reconciliation. Note it as the first follow-up,
not as scope.

**What does not change:** BYO keeps every current price and every current
limit, languages stay unlimited on all tiers (that USP was argued from BYO and
stays true for BYO; in managed mode the budget — not a locale count — is the
limit, which keeps the story intact), and nobody is migrated.

---

## 7a. A shop that pays nothing gets Free's COST limits — and nothing else changes

In PRODUCTION `getCurrentSubscription` accepts `test: true` subscriptions for
partner development stores (`allowTest = inTestBilling || isDevStore(admin)`),
so a Shopify-verified **ACTIVE Max plan that charges €0** is a normal, expected
state. Under BYO that is harmless — the merchant's key pays. Under managed it
is real provider spend against a charge that never happens, and a partner can
create development stores nearly without limit. This is a bigger hole than the
Free taster the plan spends a page sizing.

**The rule, decided 2026-09-19:** such a shop is treated as **Free for every
limit that costs US money**, and is otherwise untouched.

**What is capped** — each resolves at the Free tier's number regardless of the
subscribed plan: the managed AI budget → the one-time taster only, never a
period budget; `monthlyImageOperations` → 0; `dailyPageSpeedRuns` → 5;
`monthlyIndexNowSubmissions` → 0. Those four are exactly the quotas whose
consumption lands on an invoice of ours — AI tokens, image compute, Google's
PSI key, IndexNow submissions.

**What is NOT capped, deliberately:**

- **BYO AI stays unlimited.** It costs us nothing, so there is no reason to
  restrict it — and it is what keeps a development store fully usable for
  testing every AI path in the app.
- **Entitlements are untouched.** `maxProducts`, `contentTypes`, the SEO
  feature flags, `scoreHistoryDays`, `maxTrackedKeywords` and the rest keep
  whatever the plan says, so a Max feature stays testable on a Max dev store.
  That is not a softening of the rule but the difference between "costs us
  money" and "is a feature" — and collapsing the two has a consequence nobody
  wants: **`getSyncScope` and `planCacheCleanup` read the plan**, so a dev shop
  resolving to `free` everywhere would make the cleanup DELETE every cached
  product past 50 on the owner's own test store. A cost cap must never reach a
  path that deletes data.

**Detection is both signals, and a failed lookup is not one.**
`isCostCappedShop` answers true when `shop.plan.partnerDevelopment === true`
OR the active subscription carries `test: true` — the store type and the
billing reality, because each covers a case the other misses (a dev store with
no subscription at all; a regular store put into test billing through
`DEV_PLAN_OVERRIDE_SHOPS`). `isDevStore` is an Admin API call that can fail,
and a failure counts as **NOT capped**: refusing a paying merchant the AI they
bought is the expensive error, while the other direction is already bounded by
the global managed cap (§9.3).

**Where it lives is the whole safety of it.** ONE accessor,
`costPlanFor(shop)`, returning a `Plan`, consulted by exactly the four cost
quotas above — they already funnel through `planUtils`, so this changes what
those accessors are handed rather than adding a gate to every route. No
entitlement reader may call it, and `getSyncScope`/`planCacheCleanup` must not:
a test asserts both directions, because the damage from a wrong call here is
silent and one-way.

**Two things are stated rather than discovered.** The image manager and the
PageSpeed section become effectively untestable on a development store (0 ops,
5 runs/day) — the accepted price of the rule, with an explicit
`COST_CAP_EXEMPT_SHOPS` allowlist as the escape for the one store where the
owner needs to exercise them for real. And a merchant legitimately running a
paid plan on a store Shopify reports as `partnerDevelopment` would be capped
too; that is not a combination a real customer has, but it is the one way this
rule can be wrong, so it is logged when it fires rather than applied silently.

---

## 8. Phase 3b — what the merchant sees

**One choice, in two places, with one answer.** The mode is chosen on the plan
card (it is a price) and shown on the AI tab (it is where keys live). Both
render the same state from `AISettings.aiKeySource` + the verified
subscription.

- Plan tab: each paid tier shows **two prices** — "with your own AI key" and
  "with AI included" — with the volume stated in the unit the merchant thinks
  in ("≈ 4,500 AI actions per month", derived from the measured average, never
  in tokens).
- **AI tab in managed mode: HIDDEN, and the stored keys survive untouched**
  (owner's decision, 2026-09-19 — it supersedes this plan's first cut, which
  made the fields read-only on the argument that hiding them looks like a
  feature disappearing). In managed mode the six key fields, the provider
  select, the model select and the per-provider rate-limit fields are all noise:
  none of them affects anything, and a screen full of inert inputs invites the
  merchant to fill them in and wonder why nothing changes. §8a is what makes
  hiding them safe — and the concern behind the old wording is answered
  separately: what must stay visible is not the key fields but **the way back**
  (the mode switch, with one line saying AI is included in this plan and can be
  swapped for your own key).
- A **usage card** in Settings → Usage & limits, beside the image-operation
  quota it mirrors: percentage used, reset date, the 80 % warning, and — when
  the estimate share is non-trivial — that the figure is partly estimated.
- **The exit is always visible**: "add your own key and continue immediately"
  sits next to the cap message, not three screens away.
- Consent before the first managed call, naming the sub-processor and linking
  the privacy page. Whatever the surface, the CONTROL is the house one — a
  `ToggleRow` pill switch, never a plain checkbox (CLAUDE.md's standing
  instruction) — and it is an explicit act, never pre-set.
- Every one of these controls obeys the standing settings rule: **a click is a
  draft until Save** — including the mode switch, which additionally has to
  route through Shopify billing rather than writing a column.

---

## 8a. Hiding the key tab must not delete what it held

The owner's second half of that decision — *"if the merchant once entered keys,
they are not deleted; they may want to switch back"* — is the load-bearing one,
and in this codebase it is not a preference but a bug waiting at a known
address.

**The trap, verified.** `encryptApiKey("")` returns `null`
([encryption.server.ts](../../app/utils/encryption.server.ts) L261-266), and
the generic AI-settings save in
[app.settings.tsx](../../app/routes/app.settings.tsx) writes **all six key
columns** — plus `preferredProvider` and `selectedModel` — straight from the
submitted form on every save. So a hidden tab whose fields are no longer in the
payload does not leave those columns alone: **the next settings save writes
`null` over all six.** The merchant switches to managed, changes the app
language a week later, and their keys are gone — with the way back being six
credentials they may no longer be able to retrieve.

This is not a hypothetical: the same file already carries the fix for the same
bug one door down. `saveAppLanguage` is a deliberately NARROW update whose
comment says it verbatim — *"fields not in the payload (selectedModel, SEO
suffix) got wiped"*. Hiding the key tab is the identical situation and gets the
identical treatment.

Five rules:

1. **The key columns are written only by a save that OWNS them.** The AI-key
   tab's own save action writes the six keys, `preferredProvider` and
   `selectedModel`; no other settings save may touch those columns. That is
   already the house pattern (`saveInstructions`, `saveAiVision`,
   `saveAppLanguage` are each scoped), and it is what makes hiding the tab a UI
   change rather than a data change.
2. **Switching to managed writes NOTHING to the key columns.** The mode lives
   in `aiKeySource` (mirrored from the verified subscription, §5); it is not a
   reason to clear anything. Encrypted keys stay encrypted at rest, exactly as
   they are today, and are purged on uninstall/redact like every other shop
   row — retention is unchanged because nothing new is stored.
3. **`preferredProvider` and `selectedModel` survive too.** "Back to my own
   key" means back to the merchant's own SETUP — the provider and model they
   chose — not back to a default that silently rewrites their choice.
4. **The way back is never hidden.** The key tab is hidden; the mode switch is
   not, and neither is the line explaining that AI is included in this plan.
   Hiding the switch as well is the version that really does look like a
   vanished feature, and it is also what would strand a merchant at the budget
   wall (§6's "the exit is always visible").
5. **The guard is a round-trip test.** `ai-key-preservation.test.ts`: BYO with
   six keys set → switch to managed → save settings twice through other tabs →
   switch back → every decrypted key, the provider and the model are
   byte-identical. It fails today by construction, which is the point of
   writing it before the UI change.

---

## 9. Phase 4 — abuse, fairness and ops rails

Each of these is a way a shared key loses money or takes the app down, and each
already has a matching hole in today's code:

0. **The managed bucket must not be fed by `estimateTokens`.** `canExecute`
   checks the per-provider token window using `prompt.length/4 + 8192`, which
   charges a flat 8192 output tokens to every call. Configure
   `MANAGED_AI_TPM` at the provider's real limit and the queue admits roughly a
   tenth of the capacity we pay for; configure it ten times higher and the
   first long batch trips the real limit. The managed bucket uses a real input
   count plus the model's actual `max_tokens` — and there are **two** buckets,
   one per managed provider (`MANAGED_AI_RPM`/`TPM` and
   `MANAGED_AI_FALLBACK_RPM`/`TPM`), because a failover moves the entire load
   onto a second account whose limits are its own. And the app's aggregate ceiling
   is worth stating before volume is sold at all: `AI_QUEUE_CONCURRENCY`
   (default 4) on the single production instance is roughly one call per
   second for BYO and managed together — a single Max budget is a meaningful share of a day's global
   throughput, so how much managed volume can be sold in total is a capacity
   question, not only a margin one.
1. **The global rate-limit map is writable from one shop's settings.**
   `updateRateLimits(settings)` writes a PROCESS-WIDE per-provider bucket from
   whichever shop called last, and the fields come from `AISettings`. Under BYO
   that is merely odd; with a shared key it lets one merchant raise the limit
   everyone else runs against. Fix: bucket key becomes `${source}:${provider}`,
   the managed bucket is configured from env only (`MANAGED_AI_RPM`,
   `MANAGED_AI_TPM`) and `updateRateLimits` refuses to touch it.
2. **Per-shop fairness on the managed bucket.** The queue is round-robin per
   shop already; add a per-shop ceiling on in-flight managed calls so one bulk
   run cannot own the shared quota for ten minutes.
3. **A global monthly cap, in its own table.** `ManagedAiGlobalCounter
   { period, costMicros }` — deliberately NOT a sentinel row in the shop-scoped
   counter. (Not because the GDPR guard would fail: that guard
   [gdpr.service.test.ts](../../tests/unit/gdpr.service.test.ts) checks that
   every shop-scoped MODEL is purged, and a `shop: "__global__"` row would
   simply survive `redactShopData`'s exact-match delete. The reason is that a
   global counter has no tenant and therefore has no business in a per-shop
   unique key — and a surviving sentinel row that looks like a shop is worse
   than a separate table in every later audit.) When the global cap is
   hit, managed mode answers `503 managedUnavailable` and alerts; a bug in the
   meter can then cost one configured month's budget, not an unbounded invoice.
   **Two pools, not one**: a PAID pool sized from the subscriptions actually
   sold and a smaller TASTER pool. With one pool, a listing spike of free
   installs spending their tasters would trip the cap on the 18th and 503 every
   paying merchant for the rest of the month — the plan names free shops as the
   least accountable population and must not then let them refuse the revenue.
4. **A kill switch**: `MANAGED_AI_ENABLED=false` turns managed mode off
   globally with an honest message and the BYO path intact.
5. **Provider-side limits too** — a spend cap and an alert on the operator
   account. Our meter failing and the provider's cap failing are two
   independent failures; relying on only one of them is the same mistake as
   trusting `userErrors` without the echo.
6. **Startup validation for BOTH credential sets**: each
   `MANAGED_AI_[FALLBACK_]PROVIDER`/`MODEL` must exist in the price table, and
   each key must be present for the provider it names. `scripts/validate-env.js`
   gains the check; a managed mode pointing at a dead model is a 100 % failure
   rate for paying customers. A missing FALLBACK is a warning, not a refusal
   (§3a) — but a silent one is how an outage becomes a surprise.
7. **Prompt-injection surface does not change** (merchant content was already
   being sent), but the blast radius does: content now travels under OUR
   account. Keep `sanitizePromptInput` on every path and make sure no managed
   response is ever executed, only stored.

---

## 10. Phase 5 — the taster, i.e. the actual acquisition fix

The plan above still asks an evaluating merchant to buy something before they
see anything. So: **a managed grant on the Free plan**, which is the entry the
roadmap sells publicly; everything above is what makes it safe to offer.

**How big — the question the owner asked, with the arithmetic.** "€2 per month
on Free" was the proposal. It is too much, for two independent reasons, and
neither is about generosity:

1. **It out-grants the paying tier.** €2 of provider cost buys ≈ 6,000 calls at
   `gpt-5-nano` — more than the €1.50 budget proposed for **paid** Basic
   (≈ 4,500). A free shop would get more AI than a merchant paying €21.90, and
   the reason to ever leave Free would be the product limits alone.
2. **It is 20× what the Free plan can even use.** Free is capped at 50 products
   and 5 collections. Translating that ENTIRE entitled catalogue into five
   languages and generating a description for every product is ≈ 325 calls
   — about **€0.11** at nano, **€0.43** at Flash-Lite. Recurring monthly, €2
   pays for that run twenty times over, every month, for a shop that pays
   nothing; and unlike every other cost in this app it scales with INSTALLS,
   not with customers. A thousand free installs is €2,000/month of real invoice
   against zero revenue, and free installs are exactly what a good App Store
   listing produces.

   (The "325 calls" is one call per item per locale and is therefore an UPPER
   bound on the call count and a LOWER one on the cost per call: the app
   batches fields and locales into one request, so the same work may be 30
   calls of ten times the size. That is the unit instability §7 describes, and
   it is why the taster is enforced in µ€ with the action figure as display —
   the conclusion "€2 is 20× too much" survives it either way, because it is a
   statement about total euros, not about calls.)

**Therefore, and this is the recommendation:**

- The grant is sized in **AI actions, not euros** — `MANAGED_AI_TASTER_ACTIONS
  ≈ 350`, with the micro-euro budget DERIVED from the pinned model's price, so
  a model change moves cost and not the promise. 350 actions is "one full pass
  over everything Free entitles you to", which is exactly the evaluation the
  Free tier exists for. In money: ≈ **€0.12** at nano, ≈ **€0.46** at
  Flash-Lite — and that second figure is already over the ladder rule below
  (25 % of €1.50 is €0.375), which is why the grant is the **smaller of** the
  action count and the ladder ceiling. On an expensive model the merchant gets
  fewer actions; the ladder is never the thing that bends.
- It is **once per shop, not monthly** (`period: "taster"`), tracked like
  `trialConsumedAt` — **with the same stated residual**: an uninstall + GDPR
  redact clears it, so a determined merchant can re-grant by reinstalling. That
  is accepted: the grant is worth cents, and the alternative (retaining a
  record of an uninstalled shop) is a GDPR conversation not worth having at
  this price.
- A **hard ladder rule**, enforced in the same margin test as §7:
  `tasterBudget ≤ 0.25 × smallest paid managed budget`. It is the rule that
  makes "make Free a bit more generous" fail the build instead of quietly
  inverting the ladder.

**If a recurring free allowance is wanted anyway** — it does have a real
argument, that a monthly trickle keeps an evaluating shop engaged where a
one-shot grant is spent and forgotten — then the defensible version is
**≈ 50 actions per month (≈ €0.02–€0.07)**, on top of the one-time 350, and
still under the ladder rule. €2/month is not a variant of that; €2/month forces
paid Basic's budget (and therefore its price) up above it, which is a different
plan than this one.

Two things the taster does not get to skip: it still requires consent (§2) — a
free taster is not a lesser processing — and it still runs against the managed
rate-limit bucket and the global cap (§9), because free shops are the most
numerous and the least accountable population on the shared key.

When it runs out, the app says exactly what it costs to continue, in both
directions: add your own key (free, unlimited, keep your plan), or take the
AI-included price of your tier.

## 11. Sequencing

- **Phase 0 — measure, decide nothing.** Ship §4 (the meter) alone, behind no
  flag, metering BYO traffic. After 2–4 weeks the app knows its real cost per
  operation per feature. In parallel, the quality bake-off of §3 on the app's
  own prompts. *Every number in §7 is provisional until this lands* — the table
  is built so replacing one measured average updates it mechanically.
- **Phase 1 — resolver + consent + enforcement** (§5, §6, §2), managed mode
  reachable only for an internal allowlist of shops.
- **Phase 2 — billing variants + UI** (§7, §8) and the margin guard test.
- **Phase 3 — rails** (§9), the unattended-spend rules (§6a) and the failover
  (§3a) before the first external shop. Not after: §6a rule 1 is a data-loss
  guard and lands with the enforcement it protects; the failover is what makes
  "your AI is included" a promise we can keep on a day OpenAI cannot.
- **Phase 4 — the taster** (§10), which is the marketing moment; the public
  roadmap entry and the App Store listing change here.
- **Phase 5 — follow-ups**: usage-based overage, a BYO cost view built from the
  same meter, a per-feature cost breakdown in Tasks, and a recurring quality
  sample (§13) so "measured once" does not become "measured never again".

Per the working agreement this is a system-relevant change end to end (write
paths, auth/plan gating, billing, schema): each phase ends with an independent
review pass before it is called done.

---

## 12. Tests

| Test | Guards |
|---|---|
| `managed-ai-margin.test.ts` | budget × buffer ≤ surcharge share, per plan — §7 — AND `taster ≤ 0.25 × smallest paid budget` (§10 ladder rule) |
| `ai-usage-meter.test.ts` | each SDK's usage shape parses; a missing usage object estimates UP and flags `estimatedCalls` |
| `ai-usage-overshoot.test.ts` | NOT "cannot overbook" — a bare `increment` never can, and unlike `consumeImageOperations` the cost is unknown up front, so the reserve-before predicate does not apply. It pins the §6 bound instead: N concurrent resolvers seeing `remaining > 0` start at most `concurrency` calls, and the settled counter equals the sum of the real costs |
| `ai-failover.test.ts` | the trigger matrix of §3a rule 4: 5xx/timeout/connection/model-not-found/our-401 fail over; input-too-long, content refusal and a malformed 400 do NOT; a 429 only after the queue's retries. Plus the breaker: N failures trip it, one probe recovers it, and a tripped breaker does not re-test per call |
| `ai-failover-billing.test.ts` | a fallback call debits `billedMicros` at the DEFAULT model's price and `costMicros` at the fallback's — the rule that keeps an outage off the merchant's bill |
| `ai-credentials.test.ts` | the gate matrix: byo/managed × consent × budget × kill switch × **trial** × **test subscription** → exactly one decision each |
| `stale-repair-budget-abort.test.ts` | §6a rule 1: a budget-refused detached repair purges NOTHING (the one that protects merchant data rather than money) |
| `ai-key-source-isolation.test.ts` | no file outside the resolver reads a `MANAGED_AI_*` env var or builds an `AIServiceConfig` literal — the §B4 structural guarantee. Scope it to the managed names and carve out `api.ai-models.tsx`: a blanket `*_API_KEY` rule would match `SHOPIFY_API_KEY`, which has ~10 legitimate uses |
| `cost-plan-scope.test.ts` | §7a: `costPlanFor` caps the four cost quotas on a dev/test shop, and NO entitlement reader calls it — above all not `getSyncScope`/`planCacheCleanup`, where a `free` answer would delete cached products on the owner's own store |
| `ai-key-preservation.test.ts` | §8a: BYO with six keys → switch to managed → two saves through other tabs → switch back, and every decrypted key, the provider and the model are byte-identical. Fails today by construction |
| `billing-managed-variants.test.ts` | name→(plan, mode) and price→(plan, mode) round-trip; no two variants share a price |
| GDPR coverage guard | `AiUsageCounter` is purged by `redactShopData` |
| `ai-pricing-model-ids.test.ts` | `MANAGED_AI_MODEL` exists in the price table. NOT every `DEFAULT_MODELS` entry: HuggingFace Inference has no per-token list price, and demanding one would force a fake number for a provider §3 excludes |

---

## 13. Risks, stated rather than hidden

- **A price cut by a competitor model, or a price RISE by ours.** The margin
  guard turns that into a failing test instead of a silent loss, but it is a
  test we have to run — a monthly look at the price table is an ops task, not a
  code path.
- **Quality regression.** The cheapest model is not free of consequence. If
  nano cannot hold an SEO title under 60 characters in three languages, the
  managed tier makes the product look worse than BYO. This is what Phase 0's
  bake-off is for, and "move up one model and re-derive the budgets" must stay
  a one-constant change.
- **Support load shifts to us.** Under BYO a provider outage is the merchant's
  provider; under managed it is our outage. That is what the failover answers
  (§3a) — and it does not remove the risk, it bounds it: a long outage still
  ends at `managedUnavailable` once the failover budget is spent, and both
  providers' status is now something we watch rather than one.
- **The App Store review will read the privacy page against the product.**
  §2.2 is not optional and not a follow-up commit.
- **The offer can be worded into a terms problem.** §2.6b: an application that
  includes AI is permitted, resold API access is not, and the difference a
  reviewer sees is largely the wording on the plan card. "AI included, fair-use
  volume" is the safe form; "1,000,000 tokens per month" is not — and it is
  wrong for a second, independent reason (§7's unit instability).
- **Quality is measured once and never again.** Phase 0's bake-off says
  nothing about a provider silently updating the model behind the id. The data
  to notice already exists — `Task` carries `provider`, `aiModel`, the prompt
  and the response — so a periodic sample against the Phase 0 prompt set is a
  small, real defence rather than a hope.
- **A merchant who objects to the sub-processor's jurisdiction has exactly one
  option: BYO.** That is a defensible answer and it is still a residual, and it
  comes with an obligation consent versioning does not cover: a DPA normally
  requires ADVANCE NOTICE of a sub-processor change, which is not the same act
  as re-asking for consent afterwards.
- **The pricing record contradicts itself until it is updated.**
  PRICING_AND_LIMITS.md argues limits from "AI costs us nothing". That stays
  true for BYO and becomes false for managed; the document gets the
  qualification in the same change, or the next person reads a decision that no
  longer holds.

---

## 14. Open decisions — and how each one gets closed

An open question with no way to close it is how a plan stalls. Every one below
therefore carries a **default that applies if nobody decides**, so the work can
start; the ones that must be answered before a specific phase say which one.

They fall into four KINDS, and the kind is the method:

**(a) Settled by a measurement we can run ourselves — no external input, no
opinion.** These are closed by Phase 0 and by nothing else; deciding them by
discussion now would be inventing numbers.

| Question | How it closes | Blocks |
|---|---|---|
| What does one operation really cost? | the meter, 2–4 weeks of real BYO traffic (§4) | the final §7 numbers |
| Is the cheapest model good enough? | the bake-off on this app's own prompts (§3) | the model pin |
| How many "actions" is a merchant's month, really? | the same meter, per feature | the merchant-facing figure in §8 |

**(b) Settled by a lookup, not a decision.** Someone reads a document and
writes down the answer with a date and a link. One is already done:

| Question | Status |
|---|---|
| Do the provider's terms permit this? | **closed 2026-09-18** (§2.6b): building an app for end users is permitted, reselling account/API access is not — which is a rule about how the offer is WORDED |
| Does Shopify's own text support the consent-gate option? | open — quote Shopify, not our own audit (§2.6a) |
| Is anything besides the 15 % revenue share withheld from an EUR payout? | open — it sits inside the guard's `0.85` (§7) |
| How many production instances? | **closed 2026-09-18**: two environments, production is a SINGLE instance (§6) |

**(c) Business decisions that are genuinely the owner's** — no measurement
settles them, and each has a default so nothing waits:

| Question | Default if undecided |
|---|---|
| Surcharge level: €12 / €20 / €40 | take it; it is the guard-compliant, collision-free set (§7) |
| Managed on Free? | no — one-time taster only (§10) |
| Taster size: 350 actions, one-time | take it, capped by the ladder rule; **no** recurring free allowance in v1 |
| If the cheap model is not good enough | move up one model and re-derive; prices stay, action counts drop. **Decided 2026-09-19:** the DEFAULT stays the cheapest that passes the bake-off, and `claude-haiku-4-5` is the FAILOVER, not a quality upgrade path — promoting it to default is a pricing decision, not an ops one (§3a rule 7) |
| Global failover budget: ~25 % of the month's managed spend | take it; it bounds the one event that can break the margin guard (§3a rule 3) |
| Overage when the budget is spent | hard wall in v1; Shopify usage-billing is the first follow-up (§7) |

**(d) Decisions that only exist once something is built.** Do not pre-decide
them: the wording of the cap message, whether the usage card shows a range or a
number, how loud the 80 % warning is. They belong to the phase that builds the
screen, with real numbers in hand.

The rule for all four: **a default is not a decision, and the plan says which
is which.** Anything still on a default when its phase starts gets named in
that phase's review rather than shipping unnoticed.
