/**
 * ResearchPanel — keyword research (plan §6) extracted from LibraryTab and
 * moved to the TOP of the Library tab (Phase 2, plan §2.1). Wrapped in a
 * Collapsible, collapsed by default, with a header toggle.
 *
 * The research language is NO LONGER chosen here — it follows the global active
 * locale (Locale-Navbar). The Shell resolves `hl = activeLocale ||
 * primaryLocaleCode` and threads it into runResearch; this panel only renders.
 */

import { useState } from "react";
import { Card, BlockStack, InlineStack, Text, Button, TextField, Select, Banner, Checkbox } from "@shopify/polaris";
import { Collapsible } from "@shopify/polaris";
import type { FetcherWithComponents } from "react-router";
import type { Translation } from "../../../i18n/de";
import type { loader } from "../../../routes/app.seo.keywords";
import type { Route } from "../../../routes/+types/app.seo.keywords";

type LoaderData = Route.ComponentProps["loaderData"];
type KeywordsPageStrings = Translation["seo"]["keywordsPage"];

export interface ResearchPanelProps {
  k: KeywordsPageStrings;
  researchAvailability: LoaderData["researchAvailability"];
  groups: LoaderData["groups"];
  /** Groups of EVERY language: a researched keyword may well belong to another
   *  language's group, and the group it lands in decides its language (§3.1). */
  allGroups: LoaderData["allGroups"];
  localeOptions: LoaderData["localeOptions"];
  seedInput: string;
  setSeedInput: (v: string) => void;
  suggestFetcher: FetcherWithComponents<{
    ok: boolean;
    groups?: { direct: string[]; questions: string[]; alphabet: string[] };
    error?: "invalid" | "rateLimited" | "blocked";
  }>;
  runResearch: (expandAlphabet: boolean) => void;
  selectedSuggestions: Set<string>;
  toggleSuggestion: (s: string) => void;
  importGroupId: string;
  setImportGroupId: (v: string) => void;
  importSelectedSuggestions: () => void;
  groupFetcher: FetcherWithComponents<unknown>;
}

export function ResearchPanel({
  k,
  researchAvailability,
  groups,
  allGroups,
  localeOptions,
  seedInput,
  setSeedInput,
  suggestFetcher,
  runResearch,
  selectedSuggestions,
  toggleSuggestion,
  importGroupId,
  setImportGroupId,
  importSelectedSuggestions,
  groupFetcher,
}: ResearchPanelProps) {
  const [open, setOpen] = useState(false);

  // The target group decides the imported keywords' language, so on a
  // multi-language shop the picker lists every language's groups and names the
  // language — otherwise a research run silently lands in the language the
  // Locale-Navbar happens to be on. `groups` (active language only) is kept as
  // the single-language shortcut.
  const multiLingual = localeOptions.length > 1;
  const localeName = (locale: string) =>
    localeOptions.find((l) => l.locale === locale)?.name || locale || k.localePrimary;
  const importOptions = multiLingual
    ? [...allGroups]
        .sort((a, b) => localeName(a.locale).localeCompare(localeName(b.locale)) || a.name.localeCompare(b.name))
        .map((g) => ({ label: `${g.name} · ${localeName(g.locale)}`, value: g.id }))
    : groups.map((g) => ({ label: g.name, value: g.id }));

  const renderSuggestionGroup = (title: string, list: string[]) =>
    list.length === 0 ? null : (
      <BlockStack gap="150" key={title}>
        <Text as="h4" variant="headingSm">
          {title}
        </Text>
        <InlineStack gap="200" wrap>
          {list.map((s) => (
            <Checkbox key={s} label={s} checked={selectedSuggestions.has(s)} onChange={() => toggleSuggestion(s)} />
          ))}
        </InlineStack>
      </BlockStack>
    );

  return (
    <Card>
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Text as="h3" variant="headingMd">
            {`🔍 ${k.researchTitle || "Keyword research"}`}
          </Text>
          <Button
            variant="plain"
            ariaExpanded={open}
            ariaControls="keyword-research-panel"
            disclosure={open ? "up" : "down"}
            onClick={() => setOpen((v) => !v)}
          >
            {k.researchToggle || "Research"}
          </Button>
        </InlineStack>

        <Collapsible
          id="keyword-research-panel"
          open={open}
          transition={{ duration: "150ms", timingFunction: "ease-in-out" }}
        >
          <BlockStack gap="300">
            <Text as="p" variant="bodySm" tone="subdued">
              {k.researchIntro ||
                "Get free long-tail suggestions from Google Autocomplete for a seed keyword, then import them into a group."}
            </Text>
            {researchAvailability.status === "blocked" && (
              <Banner tone="warning">
                {k.researchBlocked ||
                  "Google is currently not answering suggestion requests from this server. Try again later."}
                {researchAvailability.checkedAt
                  ? ` ${(k.researchCheckedAt || "Last checked: {time}").replace(
                      "{time}",
                      new Date(researchAvailability.checkedAt).toLocaleString(),
                    )}`
                  : ""}
              </Banner>
            )}
            <InlineStack gap="200" blockAlign="end" wrap>
              <div style={{ flex: "1 1 220px", maxWidth: "340px" }}>
                <TextField
                  label={k.researchSeedLabel || "Seed keyword"}
                  autoComplete="off"
                  placeholder={k.keywordPlaceholder}
                  value={seedInput}
                  onChange={setSeedInput}
                />
              </div>
              <Button
                loading={suggestFetcher.state !== "idle"}
                disabled={!seedInput.trim() || researchAvailability.status === "blocked"}
                onClick={() => runResearch(false)}
              >
                {k.researchButton || "Get suggestions"}
              </Button>
              {suggestFetcher.data?.ok && (
                <Button variant="plain" loading={suggestFetcher.state !== "idle"} onClick={() => runResearch(true)}>
                  {k.researchMore || "Load alphabet expansion (a–z)"}
                </Button>
              )}
            </InlineStack>

            {suggestFetcher.state === "idle" && suggestFetcher.data && !suggestFetcher.data.ok && (
              <Banner tone={suggestFetcher.data.error === "invalid" ? "critical" : "warning"}>
                {suggestFetcher.data.error === "rateLimited"
                  ? k.researchRateLimited || "Please wait a moment — at most 3 searches per minute."
                  : suggestFetcher.data.error === "blocked"
                    ? k.researchBlocked ||
                      "Google is currently not answering suggestion requests from this server. Try again later."
                    : k.errorGeneric}
              </Banner>
            )}

            {suggestFetcher.state === "idle" && suggestFetcher.data?.ok && suggestFetcher.data.groups && (
              <BlockStack gap="300">
                {suggestFetcher.data.groups.direct.length === 0 &&
                suggestFetcher.data.groups.questions.length === 0 &&
                suggestFetcher.data.groups.alphabet.length === 0 ? (
                  <Text as="p" tone="subdued">
                    {k.researchNoResults || "No suggestions found for this seed."}
                  </Text>
                ) : (
                  <>
                    {renderSuggestionGroup(k.researchDirect || "Direct suggestions", suggestFetcher.data.groups.direct)}
                    {renderSuggestionGroup(k.researchQuestions || "Questions", suggestFetcher.data.groups.questions)}
                    {renderSuggestionGroup(
                      k.researchAlphabet || "Alphabet expansion",
                      suggestFetcher.data.groups.alphabet,
                    )}
                    <InlineStack gap="200" blockAlign="end" wrap>
                      <div style={{ minWidth: "220px" }}>
                        <Select
                          label={k.researchImportGroup || "Import into group"}
                          options={[
                            { label: k.researchImportGroupNone || "Choose a group…", value: "" },
                            ...importOptions,
                          ]}
                          value={importGroupId}
                          onChange={setImportGroupId}
                        />
                      </div>
                      <Button
                        variant="primary"
                        loading={groupFetcher.state !== "idle"}
                        disabled={!importGroupId || selectedSuggestions.size === 0}
                        onClick={importSelectedSuggestions}
                      >
                        {(k.researchImportButton || "Import {count} selected").replace(
                          "{count}",
                          String(selectedSuggestions.size),
                        )}
                      </Button>
                    </InlineStack>
                  </>
                )}
              </BlockStack>
            )}
          </BlockStack>
        </Collapsible>
      </BlockStack>
    </Card>
  );
}
