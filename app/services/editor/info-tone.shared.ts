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

export interface ToneNote {
  text: string;
  tone: InfoTone;
}

/**
 * Step 2 of accept-and-translate answers into the box that step 1's save
 * answer already filled, and one box holds one message. The notes of the
 * save (a redirect that was created or failed, fields Shopify did not echo)
 * are carried into the later message instead of being replaced by it. Empty
 * notes and notes the message already says are dropped; only a note that
 * needs attention raises the tone, so a success note never does, and a
 * critical one stays critical.
 */
export function carryNotes(base: ToneNote, carried: readonly ToneNote[]): ToneNote {
  const extra = carried.filter((note) => !!note.text && !base.text.includes(note.text));
  if (extra.length === 0) return base;
  return {
    text: [base.text, ...extra.map((note) => note.text)].filter(Boolean).join(" "),
    tone: strongestTone([base.tone, ...extra.map((note) => note.tone).filter((tone) => tone !== "success")]),
  };
}
