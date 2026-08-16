/**
 * KeywordImportModal — the bulk paste box, moved out of the group editor.
 *
 * It used to sit permanently expanded above the keyword table, which made the
 * everyday case ("add one keyword") look like a data-import chore. Adding one
 * keyword is now the "+ Keyword" button on the table; pasting a list from a
 * keyword tool is the exception and lives behind this modal.
 *
 * The payload is unchanged: one line = one keyword with an optional trailing
 * `,priority` column, submitted to the same importCsv action, with a
 * default-priority Select for rows that carry no explicit one.
 */

import { useEffect, useState } from "react";
import { Modal, BlockStack, InlineStack, Text, TextField, Select, Banner } from "@shopify/polaris";
import type { FetcherWithComponents } from "react-router";
import type { Translation } from "../../../i18n/de";
import type { ActionResult } from "../../../routes/app.seo.keywords";

type KeywordsPageStrings = Translation["seo"]["keywordsPage"];

export interface KeywordImportModalProps {
  k: KeywordsPageStrings;
  open: boolean;
  onClose: () => void;
  /** The real group these keywords are pasted into. */
  groupId: string;
  groupFetcher: FetcherWithComponents<ActionResult>;
  priorityOptions: { label: string; value: string }[];
}

export function KeywordImportModal({
  k,
  open,
  onClose,
  groupId,
  groupFetcher,
  priorityOptions,
}: KeywordImportModalProps) {
  const [text, setText] = useState("");
  const [defaultPriority, setDefaultPriority] = useState("2");

  // Fresh box on every open, so a previous run's text and its result banner
  // never greet the next import.
  useEffect(() => {
    if (open) {
      setText("");
      setDefaultPriority("2");
    }
  }, [open]);

  const submit = () => {
    if (!text.trim()) return;
    groupFetcher.submit(
      { actionType: "importCsv", groupId, csv: text, defaultPriority },
      { method: "post" },
    );
    setText("");
  };

  const result = groupFetcher.state === "idle" ? groupFetcher.data : undefined;
  const imported = result?.ok && result.kind === "csvImported" ? result : null;
  const tooMany = result && !result.ok && result.error === "csvTooMany";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={k.importModalTitle}
      primaryAction={{
        content: k.pasteButton,
        loading: groupFetcher.state !== "idle",
        disabled: !text.trim(),
        onAction: submit,
      }}
      secondaryActions={[{ content: k.distModalCancel, onAction: onClose }]}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <Text as="p" variant="bodySm" tone="subdued">
            {k.importModalIntro}
          </Text>
          <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" }}>
            <TextField
              label={k.pasteLabel}
              autoComplete="off"
              multiline={6}
              placeholder={k.pastePlaceholder}
              value={text}
              onChange={setText}
              helpText={k.csvHint.replace("{max}", "2000")}
            />
          </div>
          <InlineStack gap="200" blockAlign="end" wrap>
            <div style={{ minWidth: "180px" }}>
              <Select
                label={k.pasteDefaultPriority}
                options={priorityOptions}
                value={defaultPriority}
                onChange={setDefaultPriority}
                helpText={k.importModalPriorityHint}
              />
            </div>
          </InlineStack>

          {imported && (
            <Banner tone={imported.csvErrors.length ? "warning" : "success"}>
              <BlockStack gap="100">
                <Text as="p" variant="bodyMd">
                  {k.csvResult
                    .replace("{added}", String(imported.added))
                    .replace("{existing}", String(imported.alreadyInGroup))}
                </Text>
                {imported.csvErrors.map((e) => (
                  <Text key={`${e.row}:${e.keyword}`} as="p" variant="bodySm">
                    {k.csvErrorRow
                      .replace("{row}", String(e.row))
                      .replace("{keyword}", e.keyword)
                      .replace("{error}", k.csvErrors?.[e.error] ?? e.error)}
                  </Text>
                ))}
              </BlockStack>
            </Banner>
          )}
          {tooMany && (
            <Banner tone="critical">{k.csvTooMany.replace("{max}", "2000")}</Banner>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
