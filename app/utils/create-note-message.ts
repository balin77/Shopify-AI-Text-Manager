/**
 * PLAN_CONTENT_CREATION §1.6 — turning a create's NOTE into a sentence.
 *
 * A note is something the write path has to tell the merchant AFTER the object
 * already exists: a price Shopify did not store, a title it normalised, an SEO
 * field that did not stick. The server therefore answers with a CODE plus the
 * few values only it knows, never with prose — this app ships in three
 * languages and only the client knows which one is being read. These sentences
 * were English string literals inside `create.actions.ts` for as long as the
 * feature existed, so a German shop was told "The price was not stored" at
 * exactly the moment something had gone wrong.
 *
 * Same shape as `handle-redirect-message.ts` beside it, and for the same
 * reason. The one difference is that a note carries no TONE: it is rendered
 * inside the create banner, which already has one.
 */

/** Every note the create path can produce. A code with no entry renders raw. */
export type CreateNoteCode =
  | "titleDrift"
  | "priceNotStored"
  | "imageProcessing"
  | "seoNotStored"
  | "seoStepFailed"
  | "keywordNotAssigned"
  | "finishFailed"
  | "fieldsNotStored";

/**
 * The wire shape. `params` carries only what the SERVER knows and the sentence
 * cannot state by itself — a field list, the title Shopify actually stored.
 */
export interface CreateNote {
  code: CreateNoteCode;
  params?: Partial<Record<"sent" | "got" | "fields" | "detail", string>>;
}

const FALLBACKS: Record<CreateNoteCode, string> = {
  titleDrift: "Shopify stored the title as “{got}” instead of “{sent}”.",
  priceNotStored: "The price was not stored — please set it on the product.",
  imageProcessing: "The image is being processed by Shopify and may take a moment to appear.",
  seoNotStored: "SEO fields were not stored ({fields}) — please set them on the item.",
  seoStepFailed: "SEO fields could not be stored — please set them on the item.",
  keywordNotAssigned: "The keyword could not be assigned — you can set it in the SEO sidebar.",
  finishFailed: "The item was created, but finishing up failed. Reload to see it — do not create it again.",
  fieldsNotStored: "Not stored by Shopify: {fields}",
};

/**
 * What a note looks like ON THE WIRE, which is not only the type above.
 *
 * These used to be finished sentences, and server and client are deployed
 * together but not ATOMICALLY: for one restart window a page that is already
 * open can post to an instance still answering with strings. Rendering one of
 * those as `{note}` is an object child React refuses, i.e. the success banner
 * of a create that worked drops into the error boundary. The reverse skew —
 * an old page receiving the new objects — cannot be fixed from here, and is
 * the reason the tolerance is worth having in the direction it can be.
 */
export type CreateNoteLike = CreateNote | string;

/**
 * `texts` is the bundle's `content.createNotes` section. A code it does not
 * carry falls back to the English above rather than rendering as a bare
 * identifier: an untranslated sentence is still information, "seoNotStored" is
 * not.
 *
 * `detail` is appended rather than interpolated — it is a raw Shopify error
 * message, which no sentence in any language has a slot for, and dropping it
 * would leave the merchant with "the SEO fields were not stored" and no reason.
 */
export function createNoteText(
  note: CreateNoteLike,
  texts?: Partial<Record<string, string>>,
): string {
  // An already-phrased sentence from an older instance. See `CreateNoteLike`.
  if (typeof note === "string") return note;

  const template = texts?.[note.code] || FALLBACKS[note.code] || note.code;
  const filled = Object.entries(note.params ?? {}).reduce(
    // A FUNCTION replacement, never a string: the values here are the
    // merchant's own title and Shopify's field names, and a string
    // replacement reads `$$`, `$&`, `` $` `` and `$'` as substitution
    // patterns — so a product called "Mega Deal $$$" was reported back as
    // "Mega Deal $$" by the one note whose whole job is to quote it verbatim.
    (text, [key, value]) => text.replace(`{${key}}`, () => value ?? ""),
    template,
  );
  const detail = note.params?.detail;
  return detail ? `${filled} ${detail}` : filled;
}
