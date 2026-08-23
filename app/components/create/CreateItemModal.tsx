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
 *
 * **Every decision in here is a pill switch, and every explanation is a ❓.**
 * The three toggles come from [ToggleRow.tsx](../ToggleRow.tsx) and the labels
 * from `FieldLabel` — one shape for the whole app, and the reason both are
 * imported rather than drawn here (see CLAUDE.md, "Field chrome"). The AI is
 * one of those decisions now rather than a button of its own: `handleSubmit`
 * runs the generation and then creates, on one click.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Button,
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
import { FieldLabel } from "../unified/FieldChrome";
import { ToggleRow } from "../ToggleRow";
import { TaxonomyValuePicker } from "../metaobjects/TaxonomyValueField";
import { HexColorInput } from "../metaobjects/HexColorInput";
import { useCreateAiAssist } from "./useCreateAiAssist";
import { createAiSpecFor, translatableCreateFields } from "~/config/create-ai.shared";
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

/** Said in two branches of the picker callback (upload and library) and worth
 *  one constant: two copies of a sentence drift, and this one is a refusal the
 *  merchant has to be able to act on. */
const ONLY_IMAGES_FALLBACK =
  "Only images can be attached here. Add video or 3D from the item's media manager after creating it.";

export interface CreateItemModalTexts {
  title?: string;
  /** `New {resource}` — the resource name comes from `resourceLabel`, because
   *  interpolating the config's own slug produced an English word in every
   *  language ("New metaobject"). */
  titleFor?: string;
  /** The created resource's name, already translated by the caller. */
  resourceLabel?: string;
  removeImage?: string;
  /** The picker accepts video and 3D; this field does not. */
  onlyImagesHere?: string;
  externalVideoNotAnImage?: string;
  /** The "nothing selected" row of a dynamic picker. */
  noneOption?: string;
  /**
   * What a field is FOR, keyed exactly like `CreateFieldDef.labelKey`.
   *
   * Rendered in the ❓ beside the label, never as help text under the box:
   * an explanation a merchant reads once belongs in the question mark (see
   * CLAUDE.md, "Field chrome"), and three of these sentences used to sit
   * under three controls of one short form. A key with no entry simply gets
   * no question mark.
   */
  fieldHelp?: Record<string, string>;
  /** §2.3 — everything this app creates is created unpublished. */
  createsUnpublishedNotice?: string;
  defaultRuleSetName?: string;
  /** Validation CODES from `validateCreatePayload`, phrased here. Without
   *  them the bare code reached the screen next to the field. */
  errors?: Record<string, string>;
  /** Reasons a dynamic option is disabled, keyed by the code the server sent. */
  optionReasons?: Record<string, string>;
  /**
   * The editor's `content` block, for controls this modal SHARES with the
   * entry editor (today: the taxonomy picker). Their strings belong where the
   * editor already reads them; copying them under `createModal` would give one
   * control two vocabularies.
   */
  content?: Record<string, string>;
  create?: string;
  cancel?: string;
  moreFields?: string;
  fewerFields?: string;
  required?: string;
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
  /** §2.5a-d — the AI block. */
  generateRest?: string;
  generateRestHint?: string;
  generatingField?: string;
  sendImageToAI?: string;
  /** A generated value the validator refuses — the one AI outcome that has to
   *  be read while the dialog is still open, because nothing was created. */
  generatedNeedsFixing?: string;
  /** Warning CODES from the AI hook, phrased here. */
  aiWarnings?: Record<string, string>;
  translateAfterwards?: string;
  translateAfterwardsHint?: string;
  /** Why the box is greyed for a blog or a metaobject. */
  translateAfterwardsUnsupported?: string;
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
  /**
   * Field keys the caller has FIXED, which are therefore not offered.
   *
   * Opened from a metaobject type's own page, the type is not a choice: the
   * page IS the choice, and a Select that could change it invites creating an
   * entry of a different type than the one on screen. The value still travels
   * in `initialValues` and is still submitted -- hidden, not dropped.
   */
  lockedFieldKeys?: string[];
  /** §1.7 — shown instead of the form when an article has no blog to live in. */
  blocked?: { message: string; actionLabel?: string; onAction?: () => void } | null;
  /** §1.9 — values the form starts with when duplicating. */
  initialValues?: Record<string, string>;
  /** §1.4b — rendered for collections. False below API 2026-07, where
   *  `sources[]` does not exist and only manual collections are creatable. */
  rulesAvailable?: boolean;
  rulesUnavailableReason?: string;
  /** The shop's currency, for the rule builder's price conditions. */
  currencyCode?: string;
  /** Options for `blogPicker` / `metaobjectType`, loaded by the caller. */
  dynamicOptions?: Record<
    string,
    Array<{
      value: string;
      label: string;
      disabled?: boolean;
      helpText?: string;
      /** An i18n key the CLIENT phrases — the server does not know the
       *  merchant's language, and this text explains a greyed-out option. */
      helpTextCode?: string;
      helpTextDetail?: string;
    }>
  >;
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
  /**
   * What the AI run that ran ON THIS SUBMIT could not deliver, as warning
   * CODES for the post-create banner.
   *
   * The generation happens between the click and the create, so the dialog is
   * gone by the time anyone could read a notice inside it — and a partial run
   * that says nothing is exactly the silent failure the per-field failure list
   * exists to prevent. The codes travel with the payload and end up on the
   * created item's banner, phrased there.
   */
  aiWarningCodes?: string[];
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
  lockedFieldKeys,
  blocked = null,
  initialValues,
  rulesAvailable = false,
  rulesUnavailableReason,
  currencyCode,
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
  /**
   * §2.5d — "write the rest with AI", as a DECISION rather than a button.
   *
   * It used to be a button the merchant pressed, waited out, and only then
   * pressed Create: two waits and two clicks for one intention. Ticked here,
   * the prompts go out as part of the create — the click that creates the
   * item is the click that sends them. Off by default for the same reason as
   * the translation above: AI calls cost money and nobody should pay for one
   * they did not ask for.
   */
  const [generateWithAi, setGenerateWithAi] = useState(false);
  // §0.5 — the editor's own "send the image to the AI" toggle is not reachable
  // from here, so the dialog owns one. Off by default: sending an image costs
  // more and not every provider is vision-capable.
  const [sendImageToAI, setSendImageToAI] = useState(false);

  const [ruleSources, setRuleSources] = useState<RuleSource[]>([]);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [rulesAdvanced, setRulesAdvanced] = useState(false);
  const ruleErrors = useMemo(() => (rulesOpen ? validateRuleSources(ruleSources) : []), [rulesOpen, ruleSources]);

  /**
   * What the form holds RIGHT NOW, for the one code path that reads it after
   * an `await`.
   *
   * The AI pass runs between the click and the create — several calls, several
   * seconds — and the fields stay editable throughout. A `handleSubmit` that
   * merged and submitted its own pre-await closure would silently throw away
   * everything typed in the meantime, and let generated text land in a field
   * the merchant had just filled: exactly the overwrite the "never overwrite"
   * rule exists to prevent, reintroduced by the ordering rather than by the
   * merge. An effect with no dependency array runs after every commit, so this
   * is current by the time any network answer comes back.
   */
  const liveFormRef = useRef({
    values,
    image,
    ruleSources,
    rulesOpen,
    translateAfterwards,
  });
  useEffect(() => {
    liveFormRef.current = { values, image, ruleSources, rulesOpen, translateAfterwards };
  });

  const ai = useCreateAiAssist({ mainLanguage, sendImageToAI });
  /**
   * The one AI outcome that has to be read INSIDE this dialog: a generated
   * value the validator refuses. Everything else the run can report travels
   * to the created item's banner as a code, because the dialog is closed by
   * then — this case is the exception precisely because nothing was created.
   */
  const [aiNotices, setAiNotices] = useState<string[]>([]);
  // Null for blogs and metaobjects — see `create-ai.shared.ts` for why those
  // two are deliberately not offered the AI pass.
  const aiSpec = createAiSpecFor(resource);
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

  const locked = useMemo(() => new Set(lockedFieldKeys ?? []), [lockedFieldKeys]);
  const offeredFields = useMemo(() => allFields.filter((f) => !locked.has(f.key)), [allFields, locked]);
  const basicFields = offeredFields.filter((f) => !f.advanced);
  const advancedFields = offeredFields.filter((f) => f.advanced);

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

  /**
   * A dynamic option the loader marked DISABLED, with a reason.
   *
   * A metaobject definition whose REQUIRED fields include a type this app has
   * no editor for is offered with its reason rather than filtered out (§1.5) —
   * but it can also arrive PRESELECTED, because the metaobjects tab prefills
   * the type the merchant is already looking at. Measured on a live shop
   * (PLAN_METAOBJECTS_EDITOR §2.1): `shopify--color-pattern` is exactly such a
   * definition — two of its three required fields are taxonomy references —
   * so this is the standard colour type, not a corner case. Without this the
   * Create button would be enabled on a payload Shopify is guaranteed to
   * reject, which is the one thing that list of reasons exists to prevent.
   */
  const disabledOptionKey = useMemo(() => {
    for (const [key, options] of Object.entries(dynamicOptions)) {
      const selected = options.find((o) => o.value === values[key]);
      if (selected?.disabled) return key;
    }
    return null;
  }, [dynamicOptions, values]);

  const canSubmit =
    !submitting &&
    // The AI pass of THIS submit is still running. A second click would start
    // a second run and, with it, a second create.
    !ai.generating &&
    !blocked &&
    !disabledOptionKey &&
    localErrors.length === 0 &&
    ruleErrors.length === 0;

  /**
   * Reasons that belong to a field the caller LOCKED, and therefore have no
   * control to render them on.
   *
   * Locking the metaobject type removed the one surface that explained a
   * refused definition: `disabledOptionKey` still switches Create off, and its
   * reason lived only as that Select's error. The result was a dialog with a
   * greyed button and no cause anywhere -- exactly the dead end the disabled
   * option carries a reason to avoid. A field the merchant cannot see needs
   * its reason said somewhere they can.
   */
  /** An option's reason, phrased here because the server sent a CODE. */
  const optionReason = useCallback(
    (option?: { helpText?: string; helpTextCode?: string; helpTextDetail?: string }): string | undefined => {
      if (!option) return undefined;
      if (option.helpTextCode) {
        const phrased = t.optionReasons?.[option.helpTextCode];
        if (phrased) return phrased.replace("{detail}", option.helpTextDetail ?? "");
      }
      return option.helpText;
    },
    [t],
  );

  const lockedNotices = useMemo(() => {
    const notices: string[] = [];
    for (const key of locked) {
      const option = (dynamicOptions[key] ?? []).find((o) => o.value === values[key]);
      const reason = option?.disabled ? optionReason(option) : undefined;
      if (reason) notices.push(reason);
      for (const error of localErrors.filter((e) => e.field === key)) {
        notices.push(t.errors?.[error.code] || `${error.code} ${error.detail ?? ""}`.trim());
      }
    }
    return notices;
  }, [locked, dynamicOptions, values, localErrors, t, optionReason]);

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
    // A generation still in flight has nowhere to write once this closes, and
    // `handleSubmit` reads the same token to decide it must not create.
    ai.cancel();
    setValues({});
    setImage(null);
    setTouched(false);
    setShowAdvanced(false);
    onClose();
    // `ai.cancel` rather than `ai`: the hook returns a fresh object every
    // render, and depending on it would rebuild this callback each time.
  }, [isDirty, onClose, t.discardConfirm, ai.cancel]);

  /**
   * §2.5a/§2.5d — generate, then create, on ONE click.
   *
   * The AI used to be a button of its own: press it, wait out four calls,
   * then press Create. Two waits and two clicks for one intention, and the
   * form sat there in between looking finished. Ticked, the prompts go out as
   * part of this submit — the click that creates the item is the click that
   * sends them.
   *
   * Sequential rather than in parallel with the create, and that ordering is
   * the point: the generated text goes INTO the create, so there is one write
   * to Shopify and one echo rule, and the chained translate-all downstream
   * carries the generated fields because it reads the same values. Firing the
   * create first would mean a second write path to patch the object
   * afterwards, and a translation of fields that were still empty when it
   * started.
   */
  const handleSubmit = useCallback(async () => {
    setTouched(true);
    if (localErrors.length > 0) return;

    const aiWarningCodes: string[] = [];

    if (generateWithAi && aiSpec) {
      setAiNotices([]);
      const result = await ai.generateRest(resource, values, image?.url ?? "");
      // Abandoned — the dialog was closed or reopened while the run was in
      // flight. Creating now would use a form nobody is looking at any more.
      if (!result) return;

      /**
       * Nothing came through at all. Nothing is created either.
       *
       * This is the one moment where stopping is FREE: no object exists yet,
       * so the merchant retries or unticks the box and nothing is left behind.
       * A PARTIAL run is the opposite case — those fields are written, and
       * throwing them away to keep the outcome tidy costs the merchant the
       * work. The hook has already set its `allFailed` warning, which is what
       * the banner below shows as the visible cause.
       */
      if (Object.keys(result.filled).length === 0 && result.failed.length > 0) return;

      // Merged over the LIVE form, never over the closure this call started
      // with: the fields stayed editable for the seconds the run took, and the
      // merchant's words outrank the model's wherever both exist.
      const merged = { ...liveFormRef.current.values };
      for (const [key, value] of Object.entries(result.filled)) {
        if ((merged[key] ?? "").trim()) continue;
        // A handle is a SLUG and the model does not know that grammar. One
        // with a capital or a space fails `validateCreatePayload` and would
        // block a create the merchant did not break, so it is normalised with
        // the same function the placeholder suggests.
        merged[key] = key === "handle" ? suggestHandle(value) : value;
      }
      setValues(merged);
      liveFormRef.current = { ...liveFormRef.current, values: merged };

      const generatedErrors = validateCreatePayload(resource, withSelectDefaults(merged), runtimeFields);
      if (generatedErrors.length > 0) {
        // Shown, not sent. The text is in the form, the errors mark the field,
        // and the server would reject exactly the same thing one round trip
        // later — with the dialog already closed.
        setAiNotices([
          t.generatedNeedsFixing ||
            "The AI wrote its part, but something does not fit yet — check the marked fields.",
        ]);
        return;
      }

      // §3.2 — both of these are reported on the created item's banner: this
      // dialog is gone by the time anyone could read them here, and a partial
      // run that says nothing is the silent failure the per-field failure list
      // exists to prevent.
      if (result.failed.length > 0) aiWarningCodes.push("aiPartial");
      if (result.stuffingWarning) aiWarningCodes.push("keywordStuffed");
    }

    // Everything the payload carries comes from the same live snapshot, for
    // the same reason: an image attached or a rule edited while the AI was
    // writing is part of what the merchant is creating. Without the AI pass
    // this is simply the current state.
    const form = liveFormRef.current;
    // The rule tree is validated against the live one too — `canSubmit` looked
    // at the render before the AI pass, and a condition emptied while it ran
    // would otherwise reach a mutation that fails at the SCHEMA level.
    if (form.rulesOpen && validateRuleSources(form.ruleSources).length > 0) return;
    onSubmit({
      resource,
      values: withSelectDefaults(form.values),
      // Sent only when the merchant actually built rules — an empty tree must
      // not turn a manual collection into an automated one with no rules.
      ruleSources: form.rulesOpen && form.ruleSources.length > 0 ? form.ruleSources : undefined,
      imageUrl: form.image?.url ?? "",
      imageAlt: form.image?.alt ?? "",
      requestId,
      // Only when the shop CAN translate AND this type has fields the chain
      // can carry. A stale `true` would otherwise promise a translation that
      // never runs.
      translateAfterwards: form.translateAfterwards && hasSecondLocale && canChainTranslate,
      aiWarningCodes,
    });
  }, [
    localErrors,
    onSubmit,
    resource,
    values,
    image,
    withSelectDefaults,
    runtimeFields,
    requestId,
    hasSecondLocale,
    canChainTranslate,
    generateWithAi,
    aiSpec,
    ai.generateRest,
    t,
  ]);

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
        window.alert(t.onlyImagesHere || ONLY_IMAGES_FALLBACK);
        return;
      }
      const attached = { url: first.resourceUrl, preview: first.previewUrl, alt: "" };
      setImage(attached);
      autoAltText(attached);
      return;
    }
    if (first.source === "library") {
      if (first.kind !== "image") {
        window.alert(t.onlyImagesHere || ONLY_IMAGES_FALLBACK);
        return;
      }
      const attached = { url: first.assetUrl, preview: first.previewUrl, alt: first.alt ?? "" };
      setImage(attached);
      autoAltText(attached);
      return;
    }
    // external_url is a video embed — not an image, and not attachable here.
    window.alert(t.externalVideoNotAnImage || "An external video link cannot be used as an item image.");
  }, [autoAltText]);

  if (!spec) return null;

  const label = (field: CreateFieldDef) => t.fields?.[field.labelKey] ?? field.labelKey;

  /**
   * The label EVERY control in this dialog wears: the words, a red asterisk
   * when the field is mandatory, and the ❓ holding what the field is for.
   *
   * `FieldLabel` is the app's one label shape (see CLAUDE.md, "Field chrome"),
   * so the create form and the editor cannot come to look different. The
   * asterisk is drawn from `field.required` — the same flag the validator
   * rejects on, so a field cannot be refused without having said so first.
   */
  const fieldLabel = (field: CreateFieldDef) => (
    <FieldLabel
      label={label(field)}
      help={t.fieldHelp?.[field.labelKey]}
      requiredIndicator={field.required}
    />
  );


  const renderField = (field: CreateFieldDef) => {
    const value = values[field.key] ?? "";
    const fieldError = errorFor(field.key);
    // A CODE is not a message. Before this, a rejected field showed
    // "invalidTaxonomyValue (Solid)" — the validator's own vocabulary, in
    // English, next to the input. The map is the phrasing; an unmapped code
    // still falls back to itself rather than to nothing, because a silent
    // field with a disabled Create button is the worse dead end.
    const errorText = fieldError
      ? fieldError.code === "required"
        ? t.required || "Required"
        : (t.errors?.[fieldError.code] || `${fieldError.code} {detail}`)
            .replace("{detail}", fieldError.detail ?? "")
            .trim()
      : undefined;

    switch (field.kind) {
      case "image":
        return (
          <BlockStack gap="200" key={field.key}>
            {fieldLabel(field)}
            <InlineStack gap="300" blockAlign="center">
              {image && <Thumbnail source={image.preview} alt="" size="small" />}
              <Button onClick={() => setPickerOpen(true)}>
                {image ? t.changeImage || "Change image" : t.chooseImage || "Choose image"}
              </Button>
              {image && <Button variant="plain" tone="critical" onClick={() => setImage(null)}>{t.removeImage || "Remove"}</Button>}
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
            label={fieldLabel(field)}
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
        const selectedOption = options.find((o) => o.value === value);
        return (
          <Select
            key={field.key}
            label={fieldLabel(field)}
            options={[{ value: "", label: t.noneOption || "—" }, ...options]}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            // A disabled option that is nevertheless SELECTED (prefilled) shows
            // its reason as an ERROR rather than as quiet help text: the Create
            // button is off because of it, and a disabled button with no
            // visible cause is the same dead end as a silently missing option.
            // The reason is rendered ONCE — as the error when it explains a
            // refusal, as help text otherwise.
            error={errorText || (selectedOption?.disabled ? optionReason(selectedOption) || true : undefined)}
            helpText={selectedOption?.disabled ? undefined : optionReason(selectedOption)}
          />
        );
      }

      case "textarea":
      case "richtext":
        return (
          <TextField
            key={field.key}
            label={fieldLabel(field)}
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
            label={fieldLabel(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            error={errorText}
            // The suggestion is a hint, never a promise: Shopify decides, and
            // on a collision it appends "-1" (§1.7). The post-create box
            // reports the handle that actually came BACK.
            placeholder={suggestHandle(values.title ?? "")}
          />
        );

      // §2.5d — the keyword is not just another text field: it goes into the
      // generation prompt AND becomes the item's primary keyword after the
      // create. That is what its ❓ says, and saying it is what makes anyone
      // fill the field in.
      case "keyword":
        return (
          <TextField
            key={field.key}
            label={fieldLabel(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            maxLength={field.maxLength}
            error={errorText}
          />
        );

      // The taxonomy picker is the SAME component the entry editor renders, so
      // the form and the editor cannot come to write different bytes into one
      // field. It needs the definition TYPE, which is the value of whichever
      // field selects the runtime fields — the modal already knows it, and it
      // is what the route resolves the attribute handle from.
      case "taxonomyValue": {
        const metaobjectType = extraFieldsKey ? values[extraFieldsKey] ?? "" : "";
        const taxonomy = field.taxonomy;
        if (!metaobjectType || !taxonomy) return null;
        return (
          <TaxonomyValuePicker
            key={field.key}
            // A STRING: the picker draws the shared label itself (it has four
            // states, each with its own layout around it), so it takes the
            // words and the asterisk rather than a finished node.
            label={label(field)}
            requiredIndicator={field.required}
            value={value}
            onChange={(next) => setValue(field.key, next)}
            metaobjectType={metaobjectType}
            taxonomyFieldKey={taxonomy.fieldKey}
            fieldType={taxonomy.fieldType}
            // The create form never has the definition's validations on the
            // client: the route reads the handle server-side out of the cached
            // definition, so `null` here means "ask the route", not "there is
            // no attribute". The route answers with its own reason either way.
            attributeHandle={null}
            isList={taxonomy.isList}
            min={taxonomy.min}
            max={taxonomy.max}
            error={errorText}
            content={t.content}
          />
        );
      }

      case "color":
        return (
          <BlockStack gap="150" key={field.key}>
            {fieldLabel(field)}
            <HexColorInput
              // Its own label is hidden — the swatch row draws the visible one
              // above, and this is the input's accessible name.
              label={label(field)}
              value={value}
              onChange={(v) => setValue(field.key, v)}
              error={errorText}
              invalidMessage={t.errors?.invalidColor}
              showBaseColors
              baseColorsLabel={t.content?.metaobjectColorBasePalette}
              conventionHint={t.content?.metaobjectColorBaseConvention}
            />
          </BlockStack>
        );

      case "tags":
        return (
          <TextField
            key={field.key}
            label={fieldLabel(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            error={errorText}
          />
        );

      case "money":
        return (
          <TextField
            key={field.key}
            label={fieldLabel(field)}
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
            label={fieldLabel(field)}
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
        title={t.title ||
        (t.titleFor || "New {resource}").replace("{resource}", t.resourceLabel || spec.titleKey)}
        primaryAction={{
          content: t.create || "Create",
          // `handleSubmit` awaits the AI pass before it creates; Polaris wants
          // a void handler, and an unhandled rejection here would be silent.
          onAction: () => void handleSubmit(),
          // The generation is part of this click, so the button stays busy for
          // it — the spinner is not "creating" yet, and the line under the
          // toggle says which field is being written.
          loading: submitting || ai.generating,
          disabled: !canSubmit,
        }}
        secondaryActions={[
          { content: t.cancel || "Cancel", onAction: handleClose, disabled: submitting },
        ]}
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
                  {t.createsUnpublishedNotice ||
                    "This is created as a draft — nothing goes live until you publish it."}
                </p>
              </Banner>
            )}

            {lockedNotices.length > 0 && (
              <Banner tone="warning">
                <BlockStack gap="100">
                  {lockedNotices.map((notice) => (
                    <Text as="p" variant="bodySm" key={notice}>{notice}</Text>
                  ))}
                </BlockStack>
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
                          title: t.defaultRuleSetName || "Rule set 1",
                          inclusion: {
                            matchType: "ALL",
                            conditions: [
                              newCondition("inclusion", conditionKinds("inclusion")[0].key, "c0", { currencyCode }),
                            ],
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
                    currencyCode={currencyCode}
                    showAdvanced={rulesAdvanced}
                    onToggleAdvanced={() => setRulesAdvanced((v) => !v)}
                    t={t.rules}
                  />
                )}
              </BlockStack>
            )}

            {/* §2.5a-d — the AI block. Below the basic fields and the rule
                editor, above "more fields": it works on what has been typed so
                far, and offering it first would ask the merchant to decide
                before saying what the item is. */}
            {!blocked && aiSpec && (
              <BlockStack gap="200">
                <ToggleRow
                  label={t.generateRest || "Write the rest with AI"}
                  help={t.generateRestHint || "Only empty fields are filled — anything you wrote stays."}
                  checked={generateWithAi}
                  onChange={setGenerateWithAi}
                  disabled={submitting}
                />
                {/* §0.5 — the editor's own "send the image" toggle is not
                    reachable from here, so the dialog owns one. Offered only
                    once an image exists; there is nothing to send otherwise. */}
                {image && (
                  <ToggleRow
                    label={t.sendImageToAI || "Let the AI look at the image"}
                    checked={sendImageToAI}
                    onChange={setSendImageToAI}
                    disabled={submitting}
                  />
                )}
                {/* Which field is being written, while the submit waits for it.
                    The run happens between the click and the create, so this
                    line is the only thing standing between a merchant and a
                    dialog that looks frozen. */}
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

            {/* §2.5a — the biggest thing this dialog does that Shopify's
                cannot. Single-language shops see it DISABLED with a reason,
                never hidden. */}
            {!blocked && (
              <DisabledActionTooltip
                // A ToggleRow spans the width and puts its switch at the right
                // edge; the default shrink-wrapping span would pull it in next
                // to the label, out of line with the toggles above it.
                block
                hint={
                  hasSecondLocale
                    ? canChainTranslate
                      ? undefined
                      : t.translateAfterwardsUnsupported ||
                        "This type is translated from its own editor after creating it."
                    : requiresSecondLanguageHint
                }
              >
                <ToggleRow
                  label={t.translateAfterwards || "Translate into all languages afterwards"}
                  help={t.translateAfterwardsHint}
                  checked={translateAfterwards && hasSecondLocale && canChainTranslate}
                  onChange={setTranslateAfterwards}
                  disabled={!hasSecondLocale || !canChainTranslate || submitting}
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
