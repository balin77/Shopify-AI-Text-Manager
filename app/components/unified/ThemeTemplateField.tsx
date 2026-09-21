/**
 * The theme template, as a dropdown of the templates that actually exist.
 *
 * It was a free-text box, which is the wrong control for a value that has to
 * match a FILE in the published theme: a typo renders the resource with the
 * default template and reports nothing, anywhere. Shopify's own admin offers a
 * list, so this does too.
 *
 * ── It DELEGATES rather than drawing a control of its own ───────────────────
 * Everything around the box — the bold label with its question mark, the
 * foreign-locale lock, the `attributesSyncedAt` "not loaded yet" state and its
 * reload button — is `AttributeField`'s, and all of it applies here unchanged.
 * So this component answers one question, "which options", and hands the field
 * back as a `select`. A second copy of the lock rules is how two controls in
 * one card come to disagree about when they are editable.
 *
 * ── A failed lookup falls back to the TEXT box, never to an empty list ──────
 * An empty dropdown is a control whose next save clears a working value. So
 * `success: false` from the route puts the plain text field back and says why:
 * the merchant keeps both the value they have and the ability to change it.
 *
 * ── The stored suffix is ALWAYS an option ───────────────────────────────────
 * Two reasons, and the first one is not cosmetic: a Polaris `Select` whose
 * value matches none of its options renders the FIRST one, so a product on
 * `product.wide` would read as "Default" for as long as the list is in flight —
 * and the next save would make that true. The second is that themes get
 * switched and templates get deleted while the resource keeps its suffix; once
 * the list has arrived and still does not contain it, the option says so
 * instead of disappearing, exactly as `TaxonomyValuePicker` does.
 */

import { AttributeField, type AttributeFieldProps } from "./AttributeField";
import { useThemeTemplateSuffixes } from "../../hooks/useThemeTemplateSuffixes";
import type { ThemeTemplateResource } from "../../services/theme-templates.shared";

export interface ThemeTemplateTexts {
  /** The empty suffix — what a resource renders with when nothing is set. */
  defaultTemplate?: string;
  /** `{suffix}` — a stored value the published theme has no file for. */
  missingTemplate?: string;
  /** Shown under the text fallback when the list could not be read. */
  lookupFailed?: string;
}

export interface ThemeTemplateFieldProps extends AttributeFieldProps {
  /** Which template family to offer — `product`, `article`, … */
  resource: ThemeTemplateResource;
  themeTemplateTexts?: ThemeTemplateTexts;
}

export function ThemeTemplateField({
  field,
  resource,
  themeTemplateTexts,
  ...rest
}: ThemeTemplateFieldProps) {
  // The lookup (and its one-request-per-resource memo) is shared with the bulk
  // editor's templateSuffix column — see useThemeTemplateSuffixes.
  const loaded = useThemeTemplateSuffixes(resource);

  // The lookup failed: back to the plain text box, so the value stays readable
  // and changeable. `attributeNote` is AttributeField's own line under the
  // control, which is where the reason belongs.
  if (loaded && !loaded.ok) {
    return (
      <AttributeField
        {...rest}
        field={{ ...field, type: "text" }}
        attributeNote={themeTemplateTexts?.lookupFailed}
      />
    );
  }

  const value = rest.value;
  const suffixes = loaded?.ok ? loaded.suffixes : [];
  const options = [
    { value: "", label: themeTemplateTexts?.defaultTemplate || "Default" },
    ...suffixes.map((suffix) => ({ value: suffix, label: suffix })),
  ];
  if (value && !suffixes.includes(value)) {
    options.push({
      value,
      // Marked only once the list has ARRIVED. While it is in flight the value
      // is simply itself — a field that flashed "not in this theme" on every
      // load would be reporting the request, not the theme.
      label: loaded?.ok
        ? (themeTemplateTexts?.missingTemplate || "{suffix} — not in the published theme").replace(
            "{suffix}",
            value,
          )
        : value,
    });
  }

  return (
    <AttributeField
      {...rest}
      field={{ ...field, type: "select", options }}
      readOnly={rest.readOnly || loaded === null}
      // Grey for the few hundred milliseconds the list is in flight, but with
      // nothing to explain: the generic read-only sentence says the field is
      // managed in the Shopify admin, which is not why it is disabled here.
      // AttributeField's own foreign-locale and never-synced reasons are
      // computed inside it and are unaffected.
      readOnlyHint={rest.readOnly ? rest.readOnlyHint : undefined}
    />
  );
}
