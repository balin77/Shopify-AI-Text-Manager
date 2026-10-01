/**
 * Does the managed credential ACTUALLY answer? — PLAN_MANAGED_AI_KEY §9.6, §3a.
 *
 * `scripts/validate-env.js` checks that both credentials are complete and that
 * their models are in the price table. That is a lookup in OUR table, and the
 * failure it cannot see is the one that matters: a model id that has been
 * retired, a key that has been revoked, a quota that was never raised. §3 says
 * this repo's own model ids do go stale — `DEFAULT_MODELS` has carried more
 * than one — and a managed mode pointing at a dead model is a 100 % failure
 * rate for paying customers, discovered by them.
 *
 * So this is a REAL call: one tiny completion through the same
 * `_executeAIRequestInner` every merchant request uses, per credential, at
 * boot. It costs a few hundred tokens once per deploy.
 *
 * Three rules:
 *
 * - It NEVER blocks startup. A provider having a bad minute at the moment we
 *   deploy is not a reason to refuse to serve a shop whose own key works.
 * - A failing DEFAULT is an error, a failing FALLBACK is a warning. Without
 *   the fallback we still serve; without the default, managed mode is broken
 *   for everyone who bought it.
 * - It runs only where managed mode is actually on. In every other deployment
 *   it is a no-op that costs nothing and says nothing.
 */

import { logger } from "../../utils/logger.server";
import { notifyOps } from "../ops-alert.server";
import { isDevAppBuild, managedDevTestingEnabled } from "../dev-plan-override.server";
import {
  isManagedAiEnabled,
  managedAiAvailable,
  readManagedCredential,
  PROVIDER_KEY_FIELD,
  type ManagedRole,
} from "./ai-credentials.server";

export interface SmokeResult {
  role: ManagedRole;
  provider: string;
  model: string;
  ok: boolean;
  error?: string;
}

/** The smallest prompt that still proves the model produces text. */
const PROBE_PROMPT = 'Reply with the single word: ok';

async function probe(role: ManagedRole): Promise<SmokeResult | null> {
  const cred = readManagedCredential(role);
  if (!cred) return null;

  const base: Omit<SmokeResult, "ok"> = {
    role,
    provider: cred.provider,
    model: cred.model,
  };

  try {
    const { AIService } = await import("../../../src/services/ai.service");
    // Built directly rather than through the resolver: the resolver answers
    // for a SHOP (consent, budget, the kill switch), and none of those
    // questions has a meaning here. What is being tested is the credential.
    const config: Record<string, unknown> = {
      selectedModel: cred.model,
      credentialSource: "managed",
    };
    // The SAME map the resolver spends, not a second derivation of it. The
    // local copy was a no-op ternary ("claude" -> "claude") that happened to
    // agree today and would have gone quietly wrong the day a provider's
    // column stops being `<provider>ApiKey` — in a probe whose whole job is
    // to notice a misconfigured credential.
    config[PROVIDER_KEY_FIELD[cred.provider]] = cred.apiKey;

    const service = new AIService(cred.provider, config as never);
    // No shop, so nothing is metered — which is correct: this call is ours,
    // not a merchant's, and charging it to somebody would be wrong in both
    // directions.
    const text = await service.replayRequest(PROBE_PROMPT);
    if (!text || !text.trim()) throw new Error("the model answered with nothing");
    return { ...base, ok: true };
  } catch (error) {
    return { ...base, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Which roles failed on the previous run — so a recovery can be reported. */
const failedLastRun = new Set<ManagedRole>();

/**
 * Run the smoke test. Never throws, never blocks, and returns what it found so
 * a caller (or a test) can assert on it.
 */
export async function runManagedAiSmokeTest(): Promise<SmokeResult[]> {
  // Switched on, allowed in this build, but no usable DEFAULT credential
  // (missing, unknown/unpriced/unconsented provider): asked BEFORE the gate
  // below, because `managedAiAvailable` answers false for exactly this case
  // and the most useful misconfiguration alert would otherwise never fire.
  if (
    isManagedAiEnabled() &&
    !(isDevAppBuild() && !managedDevTestingEnabled()) &&
    readManagedCredential("default") === null
  ) {
    logger.error(
      "[ManagedAI] MANAGED_AI_ENABLED is true but no usable default credential is configured — every managed call will refuse.",
    );
    notifyOps(
      "smoke:default:missing",
      "🚨 Enthaltene KI: MANAGED_AI_ENABLED ist an, aber MANAGED_AI_PROVIDER / _MODEL / _API_KEY fehlen oder sind ungültig. Jeder Aufruf wird abgelehnt.",
    );
    return [];
  }
  // `managedAiAvailable`, not the bare flag: it also refuses the dev/custom-
  // app build, which must never spend the operator key (§7a) — not even once
  // per boot for a probe.
  if (!managedAiAvailable()) return [];

  const results: SmokeResult[] = [];
  for (const role of ["default", "failover"] as const) {
    const result = await probe(role);
    if (!result) {
      if (role === "default") {
        // Unreachable after the check above; kept as the log of last resort.
        logger.error(
          "[ManagedAI] MANAGED_AI_ENABLED is true but no default credential is configured — every managed call will refuse.",
        );
      } else {
        logger.warn(
          "[ManagedAI] No failover credential configured — an outage of the default provider is an outage of managed AI.",
        );
      }
      continue;
    }
    results.push(result);

    if (result.ok) {
      logger.info(`[ManagedAI] Smoke test OK: ${result.role} ${result.provider}/${result.model}`);
      if (failedLastRun.delete(result.role)) {
        notifyOps(
          `smoke:recovered:${result.role}`,
          `✅ Enthaltene KI: ${roleLabel(result.role)} (${result.provider}/${result.model}) antwortet wieder.`,
          { throttleMs: 0 },
        );
      }
    } else {
      failedLastRun.add(result.role);
      notifyOps(
        `smoke:${result.role}`,
        result.role === "default"
          ? `🚨 Enthaltene KI: Das HAUPTMODELL ${result.provider}/${result.model} antwortet nicht.\n` +
              `Fehler: ${result.error}\n` +
              `Händler auf der enthaltenen KI laufen jetzt über den teureren Ausweichanbieter (solange dessen Budget reicht). ` +
              `Ist das Modell abgeschaltet, in Railway MANAGED_AI_MODEL auf den Nachfolger setzen und neu deployen.`
          : `⚠️ Enthaltene KI: Der AUSWEICHANBIETER ${result.provider}/${result.model} antwortet nicht.\n` +
              `Fehler: ${result.error}\n` +
              `Das Hauptmodell läuft noch, aber ein Ausfall davon wäre jetzt ein Ausfall der enthaltenen KI. ` +
              `In Railway MANAGED_AI_FALLBACK_MODEL bzw. den Schlüssel prüfen.`,
      );
    }
    if (result.ok) continue;
    if (result.role === "default") {
      logger.error(
        `[ManagedAI] Smoke test FAILED for the default credential (${result.provider}/${result.model}): ${result.error}. ` +
          `Managed AI is configured but does not work — every paying merchant on it fails 100% of the time. ` +
          `A retired model id looks exactly like this.`,
      );
    } else {
      logger.warn(
        `[ManagedAI] Smoke test failed for the failover credential (${result.provider}/${result.model}): ${result.error}. ` +
          `The default still works; an outage of it is now an outage of managed AI.`,
      );
    }
  }
  return results;
}

function roleLabel(role: ManagedRole): string {
  return role === "default" ? "Das Hauptmodell" : "Der Ausweichanbieter";
}

const DAY_MS = 24 * 60 * 60 * 1000;
let scheduled = false;

/**
 * Run the smoke test now and then once a day, for the life of the process.
 * A model can be retired between two deploys; a check that only runs at boot
 * would learn of it at the next deploy, after the failover pool had paid for
 * every call in between. Idempotent; the timer does not keep the process
 * alive.
 */
export function startManagedAiSmokeSchedule(): void {
  if (scheduled) return;
  scheduled = true;
  void runManagedAiSmokeTest().catch(() => undefined);
  const timer = setInterval(() => {
    void runManagedAiSmokeTest().catch(() => undefined);
  }, DAY_MS);
  timer.unref?.();
}
