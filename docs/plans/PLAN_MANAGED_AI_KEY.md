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
| Key material is read from `AISettings` only | [shared.ts](../../app/routes/api-ai-handlers/shared.ts) `createAIService` | ONE factory, but 17 construction sites bypass it (below) |
| `initializeProvider()` throws `MissingAIKeyError` when the key is empty | [ai.service.ts](../../src/services/ai.service.ts) L271–316 | the structural guarantee §B4 bought — it must SURVIVE this plan |
| Pre-flight gate `getMissingPreferredKey` / `noAiKeyResponse` (409 `NO_AI_KEY`) | shared.ts L173–213 | 5 call sites; becomes the natural home of the mode/budget decision |
| Every provider call funnels through `askAI` → `executeAIRequest` | ai.service.ts L1777–1966 | the ONE place a meter can sit; the queue path and the direct path both pass it |
| `estimateTokens` = `prompt.length/4 + 8192` | ai.service.ts L1765 | an estimate for the RATE limiter, never a cost — it over-counts output by ~10× |
| Provider responses are reduced to a string | `_executeAIRequestInner` L1969–2150 | real `usage` is returned by 5 of 6 SDKs and **thrown away today** |
| Rate limits are per PROVIDER and process-global, overwritten from ONE shop's `AISettings` | [ai-queue.service.ts](../../src/services/ai-queue.service.ts) L95–175, single caller [unified-content.actions.ts](../../app/actions/unified-content.actions.ts) L105 | with a SHARED key this becomes a cross-tenant lever: shop A raises the limit for everybody (§9) |
| `ImageOperationCounter` + `consumeImageOperations` | [imageOperations.server.ts](../../app/utils/imageOperations.server.ts) | the quota pattern to mirror: atomic conditional increment, UTC month, usage-not-entitlement, no cron |
| `trialConsumedAt` on `AISettings` | [schema.prisma](../../prisma/schema.prisma) L142–150 | the precedent for a once-per-shop grant, including its stated residual (uninstall+redact resets it) |
| Plan is derived from the Shopify-verified subscription by NAME, then PRICE | [billing.server.ts](../../app/services/billing.server.ts) `getPlanFromSubscription` | the mode must be encoded in the subscription, not in a column a client can write |

**The 17 construction sites.** `new AIService(...)` is called directly in
`direct-translation-ai.server.ts`, `theme-content-api.server.ts`,
`alt-text.action.ts` (×2), `sub-resources.action.ts` (×2),
`templates-translate-field.action.ts` (×2), `templates-generate.action.ts`,
`templates-translate-all.action.ts`, `unified-content.actions.ts` (×2),
`action-context.ts`, `app.seo.performance.tsx`, `shared.ts`,
`translation.service.ts`, `ai-queue.service.ts`. Each one assembles the six
key fields itself. A second key source added at only some of them is how a
merchant gets two different answers from two buttons — the exact shape of the
`sendImagesToAI` bug this repo already fixed once. **One resolver, every site**
(§5) is therefore not tidiness, it is the whole correctness argument.

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
   re-asked when the version changes (which it does the day the managed
   sub-processor changes).
2. **Disclosure**: [privacy.tsx](../../app/routes/privacy.tsx) currently states
   *"does not provide a shared or operator-owned API key"* — that sentence
   becomes FALSE on the day this ships and must be rewritten in the same
   commit, naming the managed sub-processor, the purpose, the no-training
   commitment and the transfer basis. A privacy page that contradicts the
   product is a review rejection on its own.
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

Prices below are the public list prices found on 2026-09-17 (USD per 1M
tokens). They are the INPUT to the margin guard in §8, not a claim that they
will hold — §8 is built so that a price change moves one constant.

| Candidate | in / out | Vision | No-training default | Verdict |
|---|---|---|---|---|
| **OpenAI `gpt-5-nano`** | 0.05 / 0.40 | yes | yes (API default) | **cheapest by far; first choice pending the quality bake-off** |
| **Google Gemini 3.1 Flash-Lite** | 0.25 / 1.50 | yes | paid tier only | strong second; note 2.5 Flash-Lite retires 2026-10-16 |
| Anthropic Haiku 4.5 | 1.00 / 5.00 | yes | yes | ~14× nano; only if quality forces it |
| DeepSeek `deepseek-flash` | 0.15 / 0.60 off-peak | no | unclear | excluded: residency (§2.4), no vision, peak/off-peak pricing |
| HuggingFace | — | no | **no** | excluded by §B4 |

Three decisions follow from the table:

- **The managed model is PINNED and the merchant cannot change it.** Provider
  and model selection stay a BYO privilege. Cost control that a customer can
  switch off is not cost control — and a "choose your model" dropdown over our
  key is an invitation to select Opus.
- **The default model ids in the repo are already stale** — `deepseek-chat`
  (retired 2026-07-24) and `gemini-2.0-flash-lite` in
  [ai-models.config.ts](../../app/config/ai-models.config.ts). That is harmless
  for BYO (the merchant picks) and would be an outage for managed mode. A model
  id that we depend on gets a startup check (§10).
- **Quality is measured before the choice is final** (Phase 0, §11): the same
  prompts this app really sends — a product description, a 5-field batch
  translation into 3 locales, an alt text, an SEO title under a character cap —
  run against nano, Flash-Lite and Haiku, judged side by side. A managed
  default that writes worse copy than the app's reputation implies costs more
  than it saves. Cheapest-that-is-good-enough, not cheapest.

---

## 4. Phase 1 — the meter (ships first, alone, and is useful without any of the rest)

Nothing about pricing can be decided honestly until the app knows what one
operation actually costs. It does not know today: `estimateTokens` exists for
the rate limiter and over-counts output by roughly 10×, and the real `usage`
objects the SDKs return are discarded.

**4.1 Capture real usage at the one chokepoint.** `_executeAIRequestInner`
returns `{ text, usage }` instead of `string`:

| Provider | Field |
|---|---|
| Anthropic | `message.usage.input_tokens` / `output_tokens` |
| OpenAI, Grok, DeepSeek | `completion.usage.prompt_tokens` / `completion_tokens` |
| Gemini | `response.usageMetadata.promptTokenCount` / `candidatesTokenCount` |
| HuggingFace | `response.usage` when present, else estimate |

`usage.source` is `"provider"` or `"estimate"`. **An estimate rounds UP** — it
is the direction that costs us money if it errs, the same rule
`estimateCalls` follows in the bulk editor. A missing usage object is never
read as zero: a call that reported nothing still counts, at its estimate, and
the estimate share is stored so "the meter says €2 but the invoice says €3" is
diagnosable instead of mysterious.

**4.2 One price table, one module.** `app/config/ai-pricing.ts`:
`MODEL_PRICING: Record<provider, Record<modelId, {inMicrosPerMToken,
outMicrosPerMToken}>>` in **micro-euro** integers (no floats — this is money,
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
  inputTokens    Int      @default(0)
  outputTokens   Int      @default(0)
  costMicros     Int      @default(0)  // micro-EUR of PROVIDER cost
  updatedAt      DateTime @updatedAt
  @@unique([shop, period, source])
  @@index([shop])
}
```

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
reads `MANAGED_AI_API_KEY`:

```ts
type AiCredentialDecision =
  | { ok: true; source: "byo";     provider: AIProvider; config: AIServiceConfig }
  | { ok: true; source: "managed"; provider: AIProvider; model: string; config: AIServiceConfig }
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

Every one of the 17 construction sites goes through it. `createAIService` in
`shared.ts` and `createAIService` in `action-context.ts` become thin wrappers
over the same call; `theme-content-api.server.ts`,
`direct-translation-ai.server.ts` and the four template actions stop assembling
key config themselves. The unit test that keeps this true is a grep-style
guard, like the repo's GraphQL-hygiene test: **no file outside the resolver may
mention a `*_API_KEY` env var or build an `AIServiceConfig` literal.**

---

## 6. Phase 2b — enforcement

**Pre-flight.** The existing gate call sites (`api.ai.tsx` covering 11
handlers, `api.translate-alt-text-template.tsx`,
`templates-translate-field.action.ts` ×2, `api.seo-internal-links.tsx`) switch
from `getMissingPreferredKey` to the resolver and get three new refusal codes.
All of them are directly POST-reachable, so this is server-side or it is
nothing — the same rule the `/api/ai` plan gates already follow.

**Charging.** In `askAI`, after the call returns, when `source === "managed"`:
increment the counter by the computed cost, atomically, in the
`consumeImageOperations` shape. BYO increments the same row without a cap.

**The reservation problem, stated rather than hidden.** A call's cost is not
knowable before it runs, so a hard cap cannot be exact. The rule: **a call may
START only while `remaining > 0`**; the overshoot is bounded by
`MAX_GLOBAL_CONCURRENCY` (4) × the worst-case single call (input ceiling +
`max_tokens: 8192`), i.e. cents, and it is bounded per shop by the same
number. A design that instead reserved the worst case up front would refuse the
last 80 % of a budget on every plan, which is the expensive direction of wrong
for the merchant; a design that only checked afterwards would have no bound at
all. This is the middle one, and the bound is what the margin guard in §8
leaves headroom for.

**Degradation is never a half-written save.** A budget refusal happens at the
gate, before a task row exists. A refusal DURING a bulk run fails per cell
(`BulkFailure.columnId`, the existing rule), reports the reason once, and
leaves every already-written cell written — the run is never rolled back.

**A warning before a wall.** At 80 % the app says so (banner in Settings →
usage, and once in the task summary). "Your AI volume is used up" arriving with
no warning, mid-catalogue, is the review nobody wants.

---

## 7. Phase 3 — plans, prices and the margin guard

**Shape.** Entitlements stay 4-valued (`Plan`). Key source is a **second axis**,
not eight plans: `PLAN_CONFIG` is untouched, `MANAGED_AI` is a new table beside
it, and `BILLING_PLANS` grows a managed variant per paid tier whose Shopify
subscription NAME and PRICE both differ (`getPlanFromSubscription` resolves by
name first and by price second — both halves must stay unambiguous, which they
do as long as no two variants share a price).

Proposed numbers. **The budget column is provider cost, not merchant price** —
what we are willing to spend for that merchant in a UTC month:

| Plan | today | with managed AI | surcharge | net at worst case¹ | monthly budget | cost share |
|---|---|---|---|---|---|---|
| Free | €0 | — (one-time taster, §10) | — | — | ≈350 actions once (≈€0.12–€0.46) | — |
| Basic | €9.90 | **€19.90** | €10.00 | €8.50 | **€1.50** | 17.6 % |
| Pro | €19.90 | **€39.90** | €20.00 | €17.00 | **€3.00** | 17.6 % |
| Max | €59.90 | **€99.90** | €40.00 | €34.00 | **€6.00** | 17.6 % |

¹ net of Shopify's revenue share taken at its worst case (15 %; it is 0 % below
$1M/year today, so this is deliberate pessimism).

**What that buys the merchant**, at the two candidate models and an assumed
1,500-in / 700-out call (**an assumption to be replaced by Phase 0's measured
average — it is the one number the whole table stands on**):

| Budget | `gpt-5-nano` | Gemini 3.1 Flash-Lite |
|---|---|---|
| €1.50 (Basic) | ≈ 4,500 calls | ≈ 1,100 calls |
| €3.00 (Pro) | ≈ 9,000 calls | ≈ 2,250 calls |
| €6.00 (Max) | ≈ 18,000 calls | ≈ 4,500 calls |

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

with `surchargeNet = (managedPrice − basePrice) × (1 − 0.15)`. The buffer is
not decoration: the provider bills USD and the merchant pays EUR, list prices
move, and the §6 overshoot is real. Raising a budget or cutting a price without
touching the other is what the test exists to stop, and it is the mechanical
form of the user's own requirement — *the merchant must pay more than we pay*.

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

## 8. Phase 3b — what the merchant sees

**One choice, in two places, with one answer.** The mode is chosen on the plan
card (it is a price) and shown on the AI tab (it is where keys live). Both
render the same state from `AISettings.aiKeySource` + the verified
subscription.

- Plan tab: each paid tier shows **two prices** — "with your own AI key" and
  "with AI included" — with the volume stated in the unit the merchant thinks
  in ("≈ 4,500 AI actions per month", derived from the measured average, never
  in tokens).
- AI tab in managed mode: the six key fields, the provider select and the model
  select go **read-only with an explanation**, not hidden — hiding them is how
  a merchant concludes the feature vanished. The per-provider rate-limit fields
  disappear entirely, because they must not apply (§9).
- A **usage card** in Settings → Usage & limits, beside the image-operation
  quota it mirrors: percentage used, reset date, the 80 % warning, and — when
  the estimate share is non-trivial — that the figure is partly estimated.
- **The exit is always visible**: "add your own key and continue immediately"
  sits next to the cap message, not three screens away.
- Consent modal before the first managed call, naming the sub-processor and
  linking the privacy page.
- Every one of these controls obeys the standing settings rule: **a click is a
  draft until Save** — including the mode switch, which additionally has to
  route through Shopify billing rather than writing a column.

---

## 9. Phase 4 — abuse, fairness and ops rails

Each of these is a way a shared key loses money or takes the app down, and each
already has a matching hole in today's code:

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
   counter (that would break the GDPR coverage guard). When the global cap is
   hit, managed mode answers `503 managedUnavailable` and alerts; a bug in the
   meter can then cost one configured month's budget, not an unbounded invoice.
4. **A kill switch**: `MANAGED_AI_ENABLED=false` turns managed mode off
   globally with an honest message and the BYO path intact.
5. **Provider-side limits too** — a spend cap and an alert on the operator
   account. Our meter failing and the provider's cap failing are two
   independent failures; relying on only one of them is the same mistake as
   trusting `userErrors` without the echo.
6. **Startup validation**: `MANAGED_AI_PROVIDER`/`MODEL` must exist in the
   price table and the model must be a live id (`deepseek-chat` is already
   retired in this repo's config — §3). `scripts/validate-env.js` gains the
   check; a managed mode pointing at a dead model is a 100 % failure rate for
   paying customers.
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
   (≈ 4,500). A free shop would get more AI than a merchant paying €19.90, and
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

**Therefore, and this is the recommendation:**

- The grant is sized in **AI actions, not euros** — `MANAGED_AI_TASTER_ACTIONS
  ≈ 350`, with the micro-euro budget DERIVED from the pinned model's price, so
  a model change moves cost and not the promise. 350 actions is "one full pass
  over everything Free entitles you to", which is exactly the evaluation the
  Free tier exists for. In money: ≈ **€0.12** at nano, ≈ **€0.46** at
  Flash-Lite.
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
- **Phase 3 — rails** (§9) before the first external shop. Not after.
- **Phase 4 — the taster** (§10), which is the marketing moment; the public
  roadmap entry and the App Store listing change here.
- **Phase 5 — follow-ups**: usage-based overage, a BYO cost view built from the
  same meter, a per-feature cost breakdown in Tasks.

Per the working agreement this is a system-relevant change end to end (write
paths, auth/plan gating, billing, schema): each phase ends with an independent
review pass before it is called done.

---

## 12. Tests

| Test | Guards |
|---|---|
| `managed-ai-margin.test.ts` | budget × buffer ≤ surcharge share, per plan — §7 — AND `taster ≤ 0.25 × smallest paid budget` (§10 ladder rule) |
| `ai-usage-meter.test.ts` | each SDK's usage shape parses; a missing usage object estimates UP and flags `estimatedCalls` |
| `ai-usage-quota.test.ts` | concurrent charges cannot overbook (mirrors the image-op race test) |
| `ai-credentials.test.ts` | the gate matrix: byo/managed × consent × budget × kill switch → exactly one decision each |
| `ai-key-source-isolation.test.ts` | no file outside the resolver reads a `*_API_KEY` env var or builds an `AIServiceConfig` literal — the §B4 structural guarantee |
| `billing-managed-variants.test.ts` | name→(plan, mode) and price→(plan, mode) round-trip; no two variants share a price |
| GDPR coverage guard | `AiUsageCounter` is purged by `redactShopData` |
| `ai-pricing-model-ids.test.ts` | every `MANAGED_AI_MODEL` and every `DEFAULT_MODELS` entry exists in the price table |

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
  provider; under managed it is our outage. A single pinned provider has no
  failover — a second managed provider is a follow-up, and until it exists the
  status of the managed provider is something we have to watch.
- **The App Store review will read the privacy page against the product.**
  §2.2 is not optional and not a follow-up commit.
- **The pricing record contradicts itself until it is updated.**
  PRICING_AND_LIMITS.md argues limits from "AI costs us nothing". That stays
  true for BYO and becomes false for managed; the document gets the
  qualification in the same change, or the next person reads a decision that no
  longer holds.

---

## 14. Open questions for the owner

1. **Surcharges** — €10 / €20 / €40 on Basic / Pro / Max, i.e. roughly
   doubling. Higher (better margin, weaker acquisition) or lower with a
   smaller budget?
2. **Managed on Free?** The taster says "yes, once". A permanently managed Free
   tier is not proposed — it is an unbounded invitation.
3. **The taster**: 350 one-time actions (§10, ≈ one full pass over a Free
   catalogue) — confirmed? And does a small recurring allowance (≈50
   actions/month) get added on top, or stay out?
4. **Model quality bar**: if nano is not good enough, is Flash-Lite at ~4× the
   token cost acceptable at the same prices (cost share ~17.6 % → the budgets
   in §7 hold, the ACTION counts drop 4×), or do the budgets move?
5. **Overage**: hard wall in v1 (proposed) or Shopify usage-billing straight
   away?
