/**
 * KeywordPaste — the ONE bulk-paste box (Phase 2, plan §2.1) that replaces both
 * the old standalone CSV import field AND the single "Add keyword" field.
 *
 * One line = one keyword, with optional trailing `,priority[,intent]` columns —
 * exactly what parseKeywordsCsv already accepts. A default-priority Select fills
 * in rows without an explicit priority column (threaded to the importCsv action
 * as `defaultPriority`; an explicit per-row value still wins). Submits to the
 * existing importCsv action via the shared groupFetcher. Local text/priority
 * state lives here — the Shell no longer carries it.
 */

import { useState } from "react";
import { BlockStack, InlineStack, Text, Button, TextField, Select, Banner } from "@shopify/polaris";
import type { FetcherWithComponents } from "@remix-run/react";
import type { Translation } from "../../../i18n/de";
import type { ActionResult } from "../../../routes/app.seo.keywords";

type KeywordsPageStrings = Translation["seo"]["keywordsPage"];

export interface KeywordPasteProps {
  k: KeywordsPageStrings;
  /** The real group these keywords are pasted into. */
  groupId: string;
  groupFetcher: FetcherWithComponents<ActionResult>;
  priorityOptions: { label: string; value: string }[];
}

export function KeywordPaste({ k, groupId, groupFetcher, priorityOptions }: KeywordPasteProps) {
  const [text, setText] = useState("");
  const [defaultPriority, setDefaultPriority] = useState("2");

  const submit = () => {
    if (!text.trim()) return;
    groupFetcher.submit(
      { actionType: "importCsv", groupId, csv: text, defaultPriority },
      { method: "post" },
    );
    setText("");
  };

  return (
    <BlockStack gap="200">
      <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
        <TextField
          label={k.pasteLabel || "Paste keywords"}
          autoComplete="off"
          multiline={5}
          placeholder={k.pastePlaceholder || "vase gross\nvase glas klar\nkeramikvase handgemacht,1,commercial"}
          value={text}
          onChange={setText}
          helpText={(k.csvHint || "Up to {max} rows per import.").replace("{max}", "2000")}
        />
      </div>
      <InlineStack gap="200" blockAlign="end" wrap>
        <div style={{ minWidth: "150px" }}>
          <Select
            label={k.pasteDefaultPriority || "Default priority"}
            options={priorityOptions}
            value={defaultPriority}
            onChange={setDefaultPriority}
          />
        </div>
        <Button
          variant="primary"
          loading={groupFetcher.state !== "idle"}
          disabled={!text.trim()}
          onClick={submit}
        >
          {k.pasteButton || "Add keywords"}
        </Button>
      </InlineStack>

      {groupFetcher.data?.ok && groupFetcher.data.kind === "csvImported" && (
        <Banner tone={groupFetcher.data.csvErrors.length ? "warning" : "success"}>
          <BlockStack gap="100">
            <Text as="p" variant="bodyMd">
              {(k.csvResult || "{added} imported, {existing} already in the group.")
                .replace("{added}", String(groupFetcher.data.added))
                .replace("{existing}", String(groupFetcher.data.alreadyInGroup))}
            </Text>
            {groupFetcher.data.csvErrors.map((e) => (
              <Text key={`${e.row}:${e.keyword}`} as="p" variant="bodySm">
                {(k.csvErrorRow || 'Row {row}: "{keyword}" — {error}')
                  .replace("{row}", String(e.row))
                  .replace("{keyword}", e.keyword)
                  .replace("{error}", k.csvErrors?.[e.error] ?? e.error)}
              </Text>
            ))}
          </BlockStack>
        </Banner>
      )}
      {groupFetcher.data && !groupFetcher.data.ok && groupFetcher.data.error === "csvTooMany" && (
        <Banner tone="critical">
          {(k.csvTooMany || "A single import is limited to {max} rows.").replace("{max}", "2000")}
        </Banner>
      )}
    </BlockStack>
  );
}
