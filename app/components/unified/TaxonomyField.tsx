/**
 * PLAN_CONTENT_CREATION §Phase 3.1 — the product category picker.
 *
 * ── Why a search and not a Select ───────────────────────────────────────────
 * Shopify's product taxonomy has roughly ten thousand nodes. A dropdown is not
 * a design choice here, it is impossible; and a free-text field is worse than
 * impossible, because the value is a `TaxonomyCategory` GID and a wrong one
 * fails at the GraphQL SCHEMA level — a top-level `errors` array with
 * `data: null` that never reaches `userErrors`, so the whole save reads as a
 * success while nothing was written.
 *
 * So the merchant searches, and the only values this field can hold are ones
 * Shopify itself returned.
 *
 * ── What an empty result means ──────────────────────────────────────────────
 * Never "no such category". A failed lookup says so, and a search that is too
 * short says THAT, because "nothing matched" and "keep typing" and "the lookup
 * broke" are three different things and only one of them means the merchant
 * should try different words.
 *
 * ── The label ───────────────────────────────────────────────────────────────
 * The stored `categoryName` is Shopify's `fullName` — the whole path. Showing
 * only the leaf would make two different categories called "Shirts" look
 * identical, which is exactly the mistake a taxonomy exists to prevent.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { BlockStack, Banner, Button, InlineStack, Spinner, Text, TextField } from "@shopify/polaris";
import type { TaxonomyOption } from "../../routes/api.product-taxonomy";

export interface TaxonomyFieldProps {
  /** The TaxonomyCategory GID, or "" when the product has none. */
  value: string;
  onChange: (value: string) => void;
  /** Full path of the current category, from the cache. "" when unknown. */
  currentLabel: string;
  label: string;
  disabled?: boolean;
  t: {
    search?: string;
    searching?: string;
    keepTyping?: string;
    noMatches?: string;
    lookupFailed?: string;
    none?: string;
    clear?: string;
    /** Marker on a category that is a branch rather than a specific type. */
    broad?: string;
  };
}

/** Long enough that a keystroke does not cost a request, short enough that the
 *  list feels live. The route additionally refuses searches under 2 chars. */
const DEBOUNCE_MS = 300;

export function TaxonomyField({ value, onChange, currentLabel, label, disabled, t }: TaxonomyFieldProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<TaxonomyOption[] | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "tooShort" | "failed">("idle");

  /**
   * Bumped per search. Responses can arrive out of order — a slow request for
   * "shi" landing after a fast one for "shirt" would replace the right list
   * with a stale one, and the merchant would watch their results change back.
   */
  const requestToken = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults(null);
      setState("idle");
      return;
    }

    const token = ++requestToken.current;
    setState("loading");
    const timer = setTimeout(() => {
      fetch(`/api/product-taxonomy?kind=taxonomy&q=${encodeURIComponent(trimmed)}`)
        .then((r) => r.json())
        .then((data) => {
          if (token !== requestToken.current) return;
          if (!data?.success) {
            // A failed lookup is NOT an empty result. Saying "no matches" here
            // would send the merchant looking for different words for a
            // category that exists.
            setState("failed");
            setResults(null);
            return;
          }
          if (data.tooShort) {
            setState("tooShort");
            setResults(null);
            return;
          }
          setState("idle");
          setResults((data.categories ?? []) as TaxonomyOption[]);
        })
        .catch(() => {
          if (token !== requestToken.current) return;
          setState("failed");
          setResults(null);
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [query]);

  const choose = useCallback(
    (option: TaxonomyOption) => {
      onChange(option.id);
      setQuery("");
      setResults(null);
      requestToken.current += 1;
    },
    [onChange],
  );

  return (
    <BlockStack gap="200">
      <Text as="p" variant="bodyMd">{label}</Text>

      <InlineStack gap="200" blockAlign="center">
        <Text as="span" variant="bodyMd" tone={value ? undefined : "subdued"}>
          {/* A stored id with no cached label is possible on a row that has not
              been attribute-synced since the category was set. The id is not a
              name, so the field says "set, name unknown" by showing nothing
              rather than a GID. */}
          {value ? currentLabel || t.none || "Not set" : t.none || "Not set"}
        </Text>
        {value && !disabled && (
          <Button variant="plain" tone="critical" onClick={() => onChange("")}>
            {t.clear || "Clear"}
          </Button>
        )}
      </InlineStack>

      {!disabled && (
        <TextField
          label=""
          labelHidden
          value={query}
          onChange={setQuery}
          autoComplete="off"
          placeholder={t.search || "Search categories…"}
          clearButton
          onClearButtonClick={() => setQuery("")}
        />
      )}

      {state === "loading" && (
        <InlineStack gap="200" blockAlign="center">
          <Spinner size="small" />
          <Text as="span" variant="bodySm" tone="subdued">{t.searching || "Searching…"}</Text>
        </InlineStack>
      )}

      {state === "tooShort" && (
        <Text as="p" variant="bodySm" tone="subdued">{t.keepTyping || "Type at least two characters."}</Text>
      )}

      {state === "failed" && (
        <Banner tone="warning">
          <p>{t.lookupFailed || "The category list could not be loaded. Try again in a moment."}</p>
        </Banner>
      )}

      {state === "idle" && results !== null && results.length === 0 && (
        <Text as="p" variant="bodySm" tone="subdued">{t.noMatches || "No category matches that."}</Text>
      )}

      {state === "idle" && results !== null && results.length > 0 && (
        <BlockStack gap="100">
          {results.map((option) => (
            <InlineStack key={option.id} gap="200" blockAlign="center">
              <Button variant="plain" onClick={() => choose(option)}>
                {option.fullName}
              </Button>
              {/* A branch IS a valid value on Shopify's side, so this is a note
                  and not a refusal — but a product filed under a branch shows
                  up wrong in marketplace listings, and nothing else would say
                  so until then. */}
              {!option.isLeaf && (
                <Text as="span" variant="bodySm" tone="subdued">{t.broad || "(broad)"}</Text>
              )}
            </InlineStack>
          ))}
        </BlockStack>
      )}
    </BlockStack>
  );
}
