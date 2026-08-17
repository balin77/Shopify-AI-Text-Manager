/**
 * PLAN_CONTENT_CREATION §1.4 — the create dialog behind the "+" button.
 *
 * Renders generically from `create-fields.config.ts`, so a new field is one
 * entry in that file rather than a change here AND there. The same file's
 * `validateCreatePayload` runs on both sides: here for immediate feedback,
 * again on the server because that is where the rule actually lives (§1.5).
 *
 * *Why a modal and not the `NEW_ID` pattern Direct Translations uses (§0.2):*
 * there, exactly one field is mandatory (the source string). Here each type has
 * several, some type-dependent — an editor form with unsatisfiable required
 * fields and a live save bar would be the worse experience. The deviation is
 * deliberate, and it is paid for by respecting the save-bar convention:
 * closing with unsaved input goes through `confirmNavigation()`.
 *
 * **No browser storage for drafts.** localStorage/sessionStorage were removed
 * for App Store compliance; an unfinished form lives in memory and is protected
 * by the close confirmation, not by a persisted draft.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Modal,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Button,
  Checkbox,
  Text,
  Banner,
  Spinner,
  Thumbnail,
  Collapsible,
  Box,
} from "@shopify/polaris";
import { FilePickerModal, type AddedItem } from "../image-manager/FilePickerModal";
import { DisabledActionTooltip } from "../DisabledActionTooltip";
import { CollectionRuleBuilder } from "./CollectionRuleBuilder";
import { CreateSeoScore } from "./CreateSeoScore";
import { useCreateAiAssist } from "./useCreateAiAssist";
import {
  createAiSpecFor,
  translatableCreateFields,
  LONG_TEXT_KEY_BY_RESOURCE,
} from "~/config/create-ai.shared";
import {
  conditionKinds,
  newCondition,
  validateRuleSources,
  type RuleSource,
} from "~/config/collection-rules.shared";
import {
  createSpecFor,
  suggestHandle,
  validateCreatePayload,
  type CreatableResource,
  type CreateFieldDef,
  type CreateValidationError,
} from "~/config/create-fields.config";

export interface CreateItemModalTexts {
  title?: string;
  create?: string;
  cancel?: string;
  moreFields?: string;
  fewerFields?: string;
  required?: string;
  handleHint?: string;
  discardConfirm?: string;
  /** Field labels, keyed exactly like `CreateFieldDef.labelKey`. */
  fields?: Record<string, string>;
  /** Option labels, keyed like `"status.DRAFT"`. */
  options?: Record<string, string>;
  shopifyDefault?: string;
  /** The image picker's two states and its modal title. */
  changeImage?: string;
  chooseImage?: string;
  chooseImageTitle?: string;
  /** Heading of the banner shown when the create itself failed. */
  createFailed?: string;
  altText?: string;
  /** §2.5c — shown while the alt text writes itself. */
  altTextGenerating?: string;
  /** §2.5d — says that the keyword does two things, which is the whole point. */
  keywordHint?: string;
  /** §2.5a-d — the AI block. */
  generateRest?: string;
  generateRestHint?: string;
  generatingField?: string;
  sendImageToAI?: string;
  keywordStuffed?: string;
  generateFailed?: string;
  /** Warning CODES from the AI hook, phrased here. */
  aiWarnings?: Record<string, string>;
  translateAfterwards?: string;
  translateAfterwardsHint?: string;
  /** Why the box is greyed for a blog or a metaobject. */
  translateAfterwardsUnsupported?: string;
  /** §2.5b — the live score panel. */
  seoScore?: { heading?: string; outOf?: string; issues?: Record<string, string> };
  collectionTypeLabel?: string;
  collectionManual?: string;
  collectionAutomated?: string;
  /**
   * Passed straight to the rule builder. Sourced from the TOP-LEVEL
   * `t.collectionRules` block, not from a copy under `createModal`: the editor
   * field renders the same builder, and two copies of these strings drift.
   */
  rules?: Record<string, never> | Record<string, unknown>;
}

export interface CreateItemModalProps {
  open: boolean;
  onClose: () => void;
  resource: CreatableResource;
  /** Extra fields only known at runtime — a metaobject definition's own fields. */
  extraFields?: CreateFieldDef[];
  /** Extra fields that depend on a CHOICE inside the form: a metaobject's own
   *  fields only exist once its definition is picked. Keyed by that value. */
  extraFieldsByOption?: Record<string, CreateFieldDef[]>;
  /** Which field's value selects from `extraFieldsByOption`. */
  extraFieldsKey?: string;
  /** §1.7 — shown instead of the form when an article has no blog to live in. */
  blocked?: { message: string; actionLabel?: string; onAction?: () => void } | null;
  /** §1.9 — values the form starts with when duplicating. */
  initialValues?: Record<string, string>;
  /** §1.4b — rendered for collections. False below API 2026-07, where
   *  `sources[]` does not exist and only manual collections are creatable. */
  rulesAvailable?: boolean;
  rulesUnavailableReason?: string;
  /** Options for `blogPicker` / `metaobjectType`, loaded by the caller. */
  dynamicOptions?: Record<string, Array<{ value: string; label: string; disabled?: boolean; helpText?: string }>>;
  /** Hands the payload to the caller. Fire-and-forget: the outcome arrives
   *  through `submitting` / `error` / `fieldErrors`, because the underlying
   *  fetcher is not promise-shaped. */
  onSubmit: (payload: CreateSubmitPayload) => void | Promise<void>;
  submitting?: boolean;
  /** Server-side failure, shown verbatim — never swallowed. */
  error?: string | null;
  /** §1.7 — the same request is still running. Not an error, but saying
   *  nothing at all is what invites the extra click this guards against. */
  pendingNotice?: string | null;
  /** Field-level errors the SERVER rejected, so the two validators agree visibly. */
  fieldErrors?: CreateValidationError[];
  /** §2.5b/§2.5c — display name of the shop's primary language, for the AI
   *  prompts. The modal has no editor locale state of its own. */
  mainLanguage?: string;
  /** §2.5a — the shop publishes more than its primary locale. False makes the
   *  "translate afterwards" checkbox DISABLED with a reason, never hidden:
   *  hiding it is what makes merchants think the feature is missing. */
  hasSecondLocale?: boolean;
  /** Tooltip for that disabled state (`t.common.requiresSecondLanguage`). */
  requiresSecondLanguageHint?: string;
  t?: CreateItemModalTexts;
}

export interface CreateSubmitPayload {
  resource: CreatableResource;
  values: Record<string, string>;
  imageUrl: string;
  imageAlt: string;
  /** §1.4b — absent for a manual collection, which is the default. */
  ruleSources?: RuleSource[];
  /** Minted per attempt — the server de-duplicates on it (§1.7). */
  requestId: string;
  /**
   * §2.5a — chain `translateAll` onto the new item once it exists.
   *
   * The create handler translates NOTHING itself: it creates, syncs, and the
   * CLIENT then fires the existing translate-all action on the returned id.
   * That keeps this a chained call of the one translation write path rather
   * than a second one, task row and progress UI included.
   */
  translateAfterwards: boolean;
}

/** Crypto-free unique enough for a per-click dedup key. */
function mintRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function CreateItemModal({
  open,
  onClose,
  resource,
  extraFields = [],
  extraFieldsByOption = {},
  extraFieldsKey,
  blocked = null,
  initialValues,
  rulesAvailable = false,
  rulesUnavailableReason,
  dynamicOptions = {},
  onSubmit,
  submitting = false,
  error,
  pendingNotice,
  fieldErrors = [],
  mainLanguage = "English",
  hasSecondLocale = false,
  requiresSecondLanguageHint,
  t = {},
}: CreateItemModalProps) {
  const spec = createSpecFor(resource);
  const [values, setValues] = useState<Record<string, string>>(initialValues ?? {});
  const [image, setImage] = useState<{ url: string; preview: string; alt: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [touched, setTouched] = useState(false);

  // §1.4b — empty means MANUAL, which is the default and stays the default.
  // A merchant who wants a hand-picked collection should not have to dismiss
  // a rule editor to get one.
  /**
   * §1.7 — ONE request id per opening of this dialog, not per click.
   *
   * Minting a fresh id on every submit is the same as having none: the server
   * dedupes on the id, so a retry carrying a new one is simply a second
   * create. Keeping it stable is what makes "already in progress" and the
   * salvage path reachable at all — a merchant who clicks Create again after
   * a timeout gets the FIRST result rather than a duplicate.
   */
  const [requestId, setRequestId] = useState(mintRequestId);

  // §2.5a — off by default. Translating every field of every new object is a
  // real cost in AI calls, so it is an opt-in the merchant sees and ticks.
  const [translateAfterwards, setTranslateAfterwards] = useState(false);
  // §0.5 — the editor's own "send the image to the AI" toggle is not reachable
  // from here, so the dialog owns one. Off by default: sending an image costs
  // more and not every provider is vision-capable.
  const [sendImageToAI, setSendImageToAI] = useState(false);

  const [ruleSources, setRuleSources] = useState<RuleSource[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesAdvanced, setRulesAdvanced] = useState(false);
  const ruleErrors = useMemo(() => (rulesOpen ? validateRuleSources(ruleSources) : []), [rulesOpen, ruleSources]);

  const ai = useCreateAiAssist({ mainLanguage, sendImageToAI });
  /** Already-phrased notices from the last AI run (partial failure, stuffing). */
  const [aiNotices, setAiNotices] = useState<string[]>([]);
  // Null for blogs and metaobjects — see `create-ai.shared.ts` for why those
  // two are deliberately not offered an AI button.
  const aiSpec = createAiSpecFor(resource);
  const longTextKey = resource ? LONG_TEXT_KEY_BY_RESOURCE[resource] ?? "" : "";
  /**
   * §2.5a — can the chained translate-all carry anything for THIS type?
   *
   * The chain sends the form's values by editor field key, and for a blog or a
   * metaobject there is no mapping — so the checkbox used to tick, submit, and
   * do nothing at all, with no task, no spinner and no note. A promise the
   * dialog cannot keep is worse than an absent one, so the box is disabled
   * with the reason instead.
   */
  const canChainTranslate = translatableCreateFields(resource).length > 0;

  // A metaobject's own fields appear only once its definition is chosen —
  // rendering them before that would ask for values against no schema.
  const chosenExtras = useMemo(() => {
    if (!extraFieldsKey) return [] as CreateFieldDef[];
    const chosen = values[extraFieldsKey];
    return chosen ? extraFieldsByOption[chosen] ?? [] : [];
  }, [extraFieldsKey, extraFieldsByOption, values]);

  const runtimeFields = useMemo(() => [...extraFields, ...chosenExtras], [extraFields, chosenExtras]);
  const allFields = useMemo(() => [...(spec?.fields ?? []), ...runtimeFields], [spec, runtimeFields]);
  /**
   * Create KEY → i18n LABEL KEY. They differ where it matters: a product's
   * long text is `key: "descriptionHtml"` with `labelKey: "description"`, and
   * `t.fields` holds the latter. Looking a key up directly yields the raw
   * internal name, which is what the progress line used to show.
   */
  const labelKeyFor = useCallback(
    (key: string) => allFields.find((f) => f.key === key)?.labelKey ?? key,
    [allFields],
  );

  const basicFields = allFields.filter((f) => !f.advanced);
  const advancedFields = allFields.filter((f) => f.advanced);

  // Seed once per opening. Not on every render: the merchant's edits would be
  // overwritten by the source's values on the next keystroke.
  useEffect(() => {
    if (open) {
      setValues(initialValues ?? {});
      // A NEW dialog is a new create; only here does a fresh id belong.
      setRequestId(mintRequestId());
      // A generation still in flight from the previous opening must not write
      // its answers into this form.
      ai.cancel();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resource]);

  const setValue = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  /**
   * A `select` shows its first option before anyone touches it. Displaying a
   * default without SENDING it means an untouched "Status: Draft" is never
   * transmitted and Shopify applies its own, different default — the form
   * would be showing one thing and doing another.
   */
  const withSelectDefaults = useCallback(
    (raw: Record<string, string>) => {
      const filled = { ...raw };
      for (const field of allFields) {
        if (field.kind !== "select" || !field.options?.length) continue;
        // ONLY the always-visible ones. "The form shows it, so send it" is the
        // right rule for a control the merchant can see — it is the wrong rule
        // for one collapsed behind "more fields", where sending option[0]
        // would silently override Shopify's own default (pinning MANUAL sort
        // order on a rule-based collection, closing comments on every blog).
        // Advanced selects render an explicit "Shopify default" entry instead.
        if (field.advanced) continue;
        if (!filled[field.key]) filled[field.key] = field.options[0].value;
      }
      return filled;
    },
    [allFields],
  );

  const localErrors = useMemo(
    () => (spec ? validateCreatePayload(resource, withSelectDefaults(values), runtimeFields) : []),
    [spec, resource, values, runtimeFields, withSelectDefaults],
  );
  // Server errors win: they are the authority, and showing only the local ones
  // would hide a rejection the merchant has to act on.
  const shownErrors = fieldErrors.length > 0 ? fieldErrors : touched ? localErrors : [];
  const errorFor = (key: string) => shownErrors.find((e) => e.field === key);

  const isDirty = Object.values(values).some((v) => v.trim().length > 0) || !!image;
  const canSubmit = !submitting && !blocked && localErrors.length === 0 && ruleErrors.length === 0;

  /**
   * Drop `field.*` values belonging to a metaobject definition that is no
   * longer selected. They would validate as `unknownField` against fields that
   * are not rendered any more — an error with no visible cause, and a Create
   * button disabled forever.
   */
  useEffect(() => {
    if (!extraFieldsKey) return;
    const allowed = new Set(chosenExtras.map((f) => f.key));
    setValues((prev) => {
      const stale = Object.keys(prev).filter((k) => k.startsWith("field.") && !allowed.has(k));
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const key of stale) delete next[key];
      return next;
    });
  }, [extraFieldsKey, chosenExtras]);

  const handleClose = useCallback(() => {
    // AppSaveBar convention (§1.4): unsaved input is never dropped silently.
    if (isDirty && !window.confirm(t.discardConfirm || "Discard this draft?")) return;
    setValues({});
    setImage(null);
    setTouched(false);
    setShowAdvanced(false);
    onClose();
  }, [isDirty, onClose, t.discardConfirm]);

  const handleSubmit = useCallback(() => {
    setTouched(true);
    if (localErrors.length > 0) return;
    onSubmit({
      resource,
      values: withSelectDefaults(values),
      // Sent only when the merchant actually built rules — an empty tree must
      // not turn a manual collection into an automated one with no rules.
      ruleSources: rulesOpen && ruleSources.length > 0 ? ruleSources : undefined,
      imageUrl: image?.url ?? "",
      imageAlt: image?.alt ?? "",
      requestId,
      // Only when the shop CAN translate AND this type has fields the chain
      // can carry. A stale `true` would otherwise promise a translation that
      // never runs.
      translateAfterwards: translateAfterwards && hasSecondLocale && canChainTranslate,
    });
  }, [
    localErrors,
    onSubmit,
    resource,
    values,
    image,
    withSelectDefaults,
    rulesOpen,
    ruleSources,
    requestId,
    translateAfterwards,
    hasSecondLocale,
    canChainTranslate,
  ]);

  /**
   * §2.5a/§2.5d — "write the rest for me".
   *
   * Only the EMPTY fields, in the order the spec lists them, each result
   * feeding the next one's context (see `useCreateAiAssist`). The keyword goes
   * into the prompt explicitly: there is no item yet, so the usual DB lookup
   * would come back empty at exactly the moment the merchant has just said
   * what the thing is about.
   */
  const handleGenerateRest = useCallback(async () => {
    if (!resource) return;
    setAiNotices([]);
    const result = await ai.generateRest(resource, values, image?.url ?? "");
    if (!result) return;

    /**
     * What did NOT come through.
     *
     * A partial run used to be silent: three fields written, the meta
     * description timed out, and the modal said nothing — so the merchant
     * created the product believing every field was filled. The per-field
     * failure list is the whole reason failures are per field, and dropping it
     * made that design pointless.
     */
    const notices: string[] = [];
    if (result.failed.length > 0 && Object.keys(result.filled).length > 0) {
      notices.push(
        (t.generateFailed || "These could not be written: {fields}").replace(
          "{fields}",
          result.failed.map((key) => t.fields?.[labelKeyFor(key)] ?? key).join(", "),
        ),
      );
    }
    // §3.2 — the retry still over-used the keyword. Said HERE of all places:
    // this is the one entrance where the merchant typed that keyword
    // themselves a moment ago.
    if (result.stuffingWarning) {
      notices.push(t.keywordStuffed || "The text repeats your keyword more often than is good for it — worth a read.");
    }
    setAiNotices(notices);
    if (Object.keys(result.filled).length > 0) {
      setValues((prev) => {
        const next = { ...prev };
        for (const [key, value] of Object.entries(result.filled)) {
          // Re-checked against the LIVE state, not the snapshot the run
          // started from: the merchant may have typed into a field while the
          // generation was running, and their words outrank the model's.
          if (!(next[key] ?? "").trim()) next[key] = value;
        }
        return next;
      });
      // Generated values fill fields the merchant has not looked at, so any
      // validation error still on screen is about the form as it WAS.
      setTouched(false);
    }
  }, [ai, resource, values, image, labelKeyFor, t]);

  /**
   * The picker can return video and 3D as well. Swallowing those silently is
   * not an option (§1.4), and this dialog only knows how to attach ONE image —
   * so a non-image pick is refused with a reason rather than ignored.
   */
  /**
   * §2.5c — the alt text, right after the image is attached.
   *
   * Shopify creates images with no alt text and nothing later reminds anyone,
   * so this is the only moment it is free. Two rules: it fills only an EMPTY
   * alt (the library picker returns the file's existing one, and overwriting
   * that would discard someone's work), and a failure is silent — the field
   * simply stays empty and editable, because nobody asked for this.
   */
  const autoAltText = useCallback(
    (attached: { url: string; preview: string; alt: string }) => {
      if (!resource || attached.alt.trim()) return;
      const title = (values.title ?? "").trim();
      if (!title) return;
      void ai.generateAltText(resource, attached.url, title).then((altText) => {
        if (!altText) return;
        // Against the LIVE state: the merchant may have typed an alt text, or
        // swapped the image, while the call was running.
        setImage((prev) => (prev && prev.url === attached.url && !prev.alt.trim() ? { ...prev, alt: altText } : prev));
      });
    },
    [ai, resource, values.title],
  );

  const handlePicked = useCallback((items: AddedItem[]) => {
    const first = items[0];
    setPickerOpen(false);
    if (!first) return;
    if (first.source === "upload") {
      if (first.kind !== "image") {
        window.alert("Only images can be attached here. Add video or 3D from the item's media manager after creating it.");
        return;
      }
      const attached = { url: first.resourceUrl, preview: first.previewUrl, alt: "" };
      setImage(attached);
      autoAltText(attached);
      return;
    }
    if (first.source === "library") {
      if (first.kind !== "image") {
        window.alert("Only images can be attached here. Add video or 3D from the item's media manager after creating it.");
        return;
      }
      const attached = { url: first.assetUrl, preview: first.previewUrl, alt: first.alt ?? "" };
      setImage(attached);
      autoAltText(attached);
      return;
    }
    // external_url is a video embed — not an image, and not attachable here.
    window.alert("An external video link cannot be used as an item image.");
  }, [autoAltText]);

  if (!spec) return null;

  const label = (field: CreateFieldDef) => t.fields?.[field.labelKey] ?? field.labelKey;


  const renderField = (field: CreateFieldDef) => {
    const value = values[field.key] ?? "";
    const fieldError = errorFor(field.key);
    const errorText = fieldError
      ? fieldError.code === "required"
        ? t.required || "Required"
        : `${fieldError.code}${fieldError.detail ? ` (${fieldError.detail})` : ""}`
      : undefined;

    switch (field.kind) {
      case "image":
        return (
          <BlockStack gap="200" key={field.key}>
            <Text as="p" variant="bodyMd">{label(field)}</Text>
            <InlineStack gap="300" blockAlign="center">
              {image && <Thumbnail source={image.preview} alt="" size="small" />}
              <Button onClick={() => setPickerOpen(true)}>
                {image ? t.changeImage || "Change image" : t.chooseImage || "Choose image"}
              </Button>
              {image && <Button variant="plain" tone="critical" onClick={() => setImage(null)}>Remove</Button>}
            </InlineStack>
            {image && (
              <TextField
                label={t.altText || "Alt text"}
                value={image.alt}
                onChange={(v) => setImage((prev) => (prev ? { ...prev, alt: v } : prev))}
                autoComplete="off"
                // §2.5c — says WHY the field is about to fill itself. A value
                // appearing with no explanation reads as a glitch.
                helpText={ai.altBusy ? t.altTextGenerating || "Writing alt text…" : undefined}
              />
            )}
          </BlockStack>
        );

      case "select": {
        const options = (field.options ?? []).map((o) => ({
          value: o.value,
          label: t.options?.[o.labelKey] ?? o.value,
        }));
        // An advanced select is not auto-filled, so it needs a visible way to
        // say "leave it to Shopify" — otherwise the first option would LOOK
        // chosen while nothing is sent.
        const withDefault = field.advanced
          ? [{ value: "", label: t.shopifyDefault || "Shopify default" }, ...options]
          : options;
        return (
          <Select
            key={field.key}
            label={label(field)}
            options={withDefault}
            value={value || (field.advanced ? "" : field.options?.[0]?.value || "")}
            onChange={(v) => setValue(field.key, v)}
            error={errorText}
          />
        );
      }

      case "blogPicker":
      case "metaobjectType": {
        const options = dynamicOptions[field.key] ?? [];
        return (
          <Select
            key={field.key}
            label={label(field)}
            options={[{ value: "", label: "—" }, ...options]}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            error={errorText}
            helpText={options.find((o) => o.value === value)?.helpText}
          />
        );
      }

      case "textarea":
      case "richtext":
        return (
          <TextField
            key={field.key}
            label={label(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            multiline={field.kind === "richtext" ? 6 : 3}
            autoComplete="off"
            maxLength={field.maxLength}
            showCharacterCount={!!field.maxLength}
            error={errorText}
          />
        );

      case "handle":
        return (
          <TextField
            key={field.key}
            label={label(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            error={errorText}
            // The suggestion is a hint, never a promise: Shopify decides, and
            // on a collision it appends "-1" (§1.7). The post-create box
            // reports the handle that actually came BACK.
            placeholder={suggestHandle(values.title ?? "")}
            helpText={t.handleHint}
          />
        );

      // §2.5d — the keyword is not just another text field: it goes into the
      // generation prompt AND becomes the item's primary keyword after the
      // create. Saying so is what makes anyone fill it in.
      case "keyword":
        return (
          <TextField
            key={field.key}
            label={label(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            maxLength={field.maxLength}
            error={errorText}
            helpText={t.keywordHint}
          />
        );

      case "tags":
        return (
          <TextField
            key={field.key}
            label={label(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            error={errorText}
            helpText="Comma-separated"
          />
        );

      case "money":
        return (
          <TextField
            key={field.key}
            label={label(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            inputMode="decimal"
            error={errorText}
          />
        );

      default:
        return (
          <TextField
            key={field.key}
            label={label(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            maxLength={field.maxLength}
            error={errorText}
          />
        );
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        title={t.title || `New ${spec.titleKey}`}
        primaryAction={{
          content: t.create || "Create",
          onAction: handleSubmit,
          loading: submitting,
          disabled: !canSubmit,
        }}
        secondaryActions={[{ content: t.cancel || "Cancel", onAction: handleClose, disabled: submitting }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {blocked && (
              <Banner tone="warning" title={blocked.message}>
                {blocked.onAction && blocked.actionLabel && (
                  <Box paddingBlockStart="200">
                    <Button onClick={blocked.onAction}>{blocked.actionLabel}</Button>
                  </Box>
                )}
              </Banner>
            )}

            {error && (
              <Banner tone="critical" title={t.createFailed || "Could not create"}>
                <p>{error}</p>
              </Banner>
            )}

            {pendingNotice && (
              <Banner tone="info">
                <p>{pendingNotice}</p>
              </Banner>
            )}

            {spec.createsUnpublished && (
              <Banner tone="info">
                <p>
                  This is created as a draft — nothing goes live until you publish it.
                </p>
              </Banner>
            )}

            {!blocked && basicFields.map(renderField)}

            {!blocked && resource === "collection" && (
              <BlockStack gap="300">
                <Select
                  label={t.collectionTypeLabel || "How are products added?"}
                  options={[
                    { value: "manual", label: t.collectionManual || "I pick them myself" },
                    { value: "automated", label: t.collectionAutomated || "Automatically, by rules" },
                  ]}
                  value={rulesOpen ? "automated" : "manual"}
                  onChange={(value) => {
                    const automated = value === "automated";
                    setRulesOpen(automated);
                    if (automated && ruleSources.length === 0) {
                      setRuleSources([
                        {
                          title: "Rule set 1",
                          inclusion: {
                            matchType: "ALL",
                            conditions: [newCondition("inclusion", conditionKinds("inclusion")[0].key, "c0")],
                          },
                        },
                      ]);
                    }
                  }}
                  disabled={!rulesAvailable}
                  helpText={!rulesAvailable ? rulesUnavailableReason : undefined}
                />

                {rulesOpen && (
                  <CollectionRuleBuilder
                    sources={ruleSources}
                    onChange={setRuleSources}
                    errors={touched ? ruleErrors : []}
                    available={rulesAvailable}
                    unavailableReason={rulesUnavailableReason}
                    showAdvanced={rulesAdvanced}
                    onToggleAdvanced={() => setRulesAdvanced((v) => !v)}
                    t={t.rules}
                  />
                )}
              </BlockStack>
            )}

            {/* §2.5a-d — the AI block. Below the basic fields and the rule
                editor, above "more fields": it works on what has been typed so
                far, and offering it first would ask the merchant to press a
                button before saying what the item is. */}
            {!blocked && aiSpec && (
              <BlockStack gap="200">
                <InlineStack gap="300" blockAlign="center">
                  <Button
                    onClick={handleGenerateRest}
                    loading={ai.generating}
                    // A title is the ONLY input every prompt here builds on.
                    // Without one the model would be inventing the product.
                    disabled={!values.title?.trim() || submitting}
                  >
                    {t.generateRest || "Write the rest with AI"}
                  </Button>
                  {ai.generating && (
                    <InlineStack gap="200" blockAlign="center">
                      <Spinner size="small" />
                      <Text as="span" variant="bodySm" tone="subdued">
                        {/* `t.fields` is keyed by labelKey, NOT by field key.
                            Looking it up by key made the first (and longest)
                            call read "Writing descriptionHtml…" in all three
                            languages. */}
                        {(t.generatingField || "Writing {field}…").replace(
                          "{field}",
                          t.fields?.[labelKeyFor(ai.busyField ?? "")] ?? ai.busyField ?? "",
                        )}
                      </Text>
                    </InlineStack>
                  )}
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {t.generateRestHint || "Only empty fields are filled — anything you wrote stays."}
                </Text>
                {/* §0.5 — the editor's toggle is not reachable from here. Only
                    offered once an image exists; there is nothing to send
                    otherwise. */}
                {image && (
                  <Checkbox
                    label={t.sendImageToAI || "Let the AI look at the image"}
                    checked={sendImageToAI}
                    onChange={setSendImageToAI}
                  />
                )}
                {ai.aiError && (
                  <Banner tone="warning" onDismiss={ai.dismissAiError}>
                    {/* A CODE from the hook, phrased here — the app ships in
                        three languages. */}
                    <p>{t.aiWarnings?.[ai.aiError] || ai.aiError}</p>
                  </Banner>
                )}
                {aiNotices.length > 0 && (
                  <Banner tone="warning" onDismiss={() => setAiNotices([])}>
                    <BlockStack gap="100">
                      {aiNotices.map((notice, index) => (
                        <Text as="p" key={index}>{notice}</Text>
                      ))}
                    </BlockStack>
                  </Banner>
                )}
              </BlockStack>
            )}

            {/* §2.5b — the same scorer, the same shop limits and the same
                suffix the sidebar will use, so the number does not change by
                itself the moment the item is created. */}
            {!blocked && aiSpec && (
              <CreateSeoScore
                title={values.title ?? ""}
                description={longTextKey ? values[longTextKey] ?? "" : ""}
                seoTitle={values.seoTitle ?? ""}
                metaDescription={values.metaDescription ?? ""}
                hasImage={!!image}
                imageHasAlt={!!image?.alt.trim()}
                hasDescriptionField={!!longTextKey}
                t={t.seoScore ?? {}}
              />
            )}

            {/* §2.5a — the biggest thing this dialog does that Shopify's
                cannot. Single-language shops see it DISABLED with a reason,
                never hidden. */}
            {!blocked && (
              <DisabledActionTooltip
                hint={
                  hasSecondLocale
                    ? canChainTranslate
                      ? undefined
                      : t.translateAfterwardsUnsupported ||
                        "This type is translated from its own editor after creating it."
                    : requiresSecondLanguageHint
                }
              >
                <Checkbox
                  label={t.translateAfterwards || "Translate into all languages afterwards"}
                  checked={translateAfterwards && hasSecondLocale && canChainTranslate}
                  onChange={setTranslateAfterwards}
                  disabled={!hasSecondLocale || !canChainTranslate || submitting}
                  helpText={hasSecondLocale && canChainTranslate ? t.translateAfterwardsHint : undefined}
                />
              </DisabledActionTooltip>
            )}

            {!blocked && advancedFields.length > 0 && (
              <BlockStack gap="200">
                <Button
                  variant="plain"
                  disclosure={showAdvanced ? "up" : "down"}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? t.fewerFields || "Fewer fields" : t.moreFields || "More fields"}
                </Button>
                <Collapsible open={showAdvanced} id="create-advanced-fields">
                  <Box paddingBlockStart="200">
                    <BlockStack gap="400">{advancedFields.map(renderField)}</BlockStack>
                  </Box>
                </Collapsible>
              </BlockStack>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      {pickerOpen && (
        <FilePickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onAdd={handlePicked}
          uploadCommitMode="immediate"
          initialKind="image"
          disallowModel
          title={t.chooseImageTitle || "Choose an image"}
        />
      )}
    </>
  );
}
