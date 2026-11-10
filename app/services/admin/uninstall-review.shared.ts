/**
 * What the /admin detail view shows for "Als deinstalliert markieren": the
 * eligibility verdict and the evidence behind it. Import-free and client-safe
 * (the panel renders it). Dates are ISO strings or null, everything else is a
 * flag, a count or a code; there is never a token or any secret in it.
 */

/** The only shop-domain shape the marking accepts. */
export const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/** Why a shop cannot be marked (one code; the order of the checks is fixed). */
export type MarkRefusal = "unknown_shop" | "already_uninstalled" | "no_evidence" | "token_present";

export interface UninstallEvidence {
  connectionState: string | null;
  connectionStateReason: string | null;
  connectionStateSince: string | null;
  derivedStatus: string | null;
  lastWebhookAt: string | null;
  lastApiOkAt: string | null;
  lastActivityAt: string | null;
  lastAuthAt: string | null;
  reinstallEvidenceAt: string | null;
  sessionsTotal: number;
  hasToken: boolean;
  hasRefreshToken: boolean;
  migration: string | null;
}

export interface UninstallReviewView {
  shop: string;
  eligible: boolean;
  refusal: MarkRefusal | null;
  evidence: UninstallEvidence | null;
}

/** Short German reason shown instead of an enabled button. */
export function markRefusalText(refusal: MarkRefusal): string {
  switch (refusal) {
    case "unknown_shop":
      return "Für diesen Shop ist kein Installationsstatus bekannt.";
    case "already_uninstalled":
      return "Der Shop ist bereits als deinstalliert markiert.";
    case "no_evidence":
      return "Kein Nachweis: nötig sind mindestens 30 Tage gesperrt (7 bei «Shop nicht gefunden») und seither kein Webhook, Besuch, keine Anmeldung, kein API-Erfolg und kein Wiederinstallations-Beleg.";
    case "token_present":
      return "Die Session des Shops hält noch ein Token (möglicherweise ein lebender Zugriff). Das geht nur per Skript mit --force-with-token.";
  }
}
