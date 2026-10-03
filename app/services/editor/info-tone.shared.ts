/**
 * One InfoBox holds one message, so a message that has to carry several parts
 * takes the STRONGEST tone among them: critical stays critical, a warning
 * outranks a note, and a plain success line never raises anything.
 */
export type InfoTone = "success" | "info" | "warning" | "critical";

const RANK: Record<InfoTone, number> = { success: 0, info: 1, warning: 2, critical: 3 };

export function strongestTone(tones: readonly InfoTone[], fallback: InfoTone = "info"): InfoTone {
  let best: InfoTone | null = null;
  for (const tone of tones) if (best === null || RANK[tone] > RANK[best]) best = tone;
  return best ?? fallback;
}
