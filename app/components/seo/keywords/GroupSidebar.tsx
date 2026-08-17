/**
 * GroupSidebar — the left column of the "Bibliothek" (Phase 2, plan §2.1).
 *
 * Top to bottom: the "Alle" and "Ohne Gruppe" pseudo-groups, a divider, the
 * real groups (name + keyword count), then a "＋ Gruppe" create control. Every
 * entry calls selectGroup(id) with "__all__" / "__ungrouped__" / a real cuid;
 * the active entry is highlighted. Presentational — state + fetchers live in
 * the Shell.
 */

import { Card, BlockStack, InlineStack, Text, Button, TextField, Divider, Box } from "@shopify/polaris";
import type { FetcherWithComponents } from "react-router";
import type { Translation } from "../../../i18n/de";
import type { loader, ActionResult } from "../../../routes/app.seo.keywords";
import type { Route } from "../../../routes/+types/app.seo.keywords";

type LoaderData = Route.ComponentProps["loaderData"];
type KeywordsPageStrings = Translation["seo"]["keywordsPage"];

export interface GroupSidebarProps {
  k: KeywordsPageStrings;
  groups: LoaderData["groups"];
  allCount: number;
  ungroupedCount: number;
  /** groupDetail?.id — "__all__" / "__ungrouped__" / a real id / null. */
  activeId: string | null;
  selectGroup: (groupId: string) => void;
  /** Active locale the new group is created under (§3.1 locale dimension). */
  activeLocale: string;
  newGroupName: string;
  setNewGroupName: (v: string) => void;
  groupFetcher: FetcherWithComponents<ActionResult>;
}

export function GroupSidebar({
  k,
  groups,
  allCount,
  ungroupedCount,
  activeId,
  selectGroup,
  activeLocale,
  newGroupName,
  setNewGroupName,
  groupFetcher,
}: GroupSidebarProps) {
  const entry = (id: string, label: string, count: number) => (
    <Button
      key={id}
      fullWidth
      textAlign="left"
      pressed={activeId === id}
      onClick={() => selectGroup(id)}
    >
      {`${label} (${count})`}
    </Button>
  );

  return (
    <Card padding="300">
      <BlockStack gap="200">
        <Text as="h3" variant="headingSm">
          {k.groupsTitle || "Keyword groups"}
        </Text>

        {entry("__all__", k.groupAll || "All", allCount)}
        {entry("__ungrouped__", k.groupUngrouped || "Ungrouped", ungroupedCount)}

        <Divider />

        {groups.length === 0 ? (
          <Text as="p" tone="subdued" variant="bodySm">
            {k.noGroups || "No groups yet."}
          </Text>
        ) : (
          <BlockStack gap="150">
            {groups.map((g) => (
              <Button
                key={g.id}
                fullWidth
                textAlign="left"
                pressed={activeId === g.id}
                onClick={() => selectGroup(g.id)}
              >
                {`${g.name} (${g.keywordCount})`}
              </Button>
            ))}
          </BlockStack>
        )}

        <Box paddingBlockStart="200">
          <BlockStack gap="150">
            <TextField
              label={k.groupSidebarCreate || k.groupNameLabel || "New group"}
              labelHidden
              autoComplete="off"
              placeholder={k.groupNamePlaceholder || "e.g. Vases 2026"}
              value={newGroupName}
              onChange={setNewGroupName}
              maxLength={100}
            />
            <InlineStack gap="200">
              <Button
                loading={groupFetcher.state !== "idle"}
                disabled={!newGroupName.trim()}
                onClick={() => {
                  groupFetcher.submit(
                    { actionType: "createGroup", name: newGroupName, locale: activeLocale },
                    { method: "post" },
                  );
                  setNewGroupName("");
                }}
              >
                {`＋ ${k.groupCreate || "Create group"}`}
              </Button>
            </InlineStack>
            {groupFetcher.data && !groupFetcher.data.ok && groupFetcher.data.error === "duplicateName" && (
              <Text as="p" tone="critical" variant="bodySm">
                {k.groupDuplicateName || "A group with this name already exists."}
              </Text>
            )}
          </BlockStack>
        </Box>
      </BlockStack>
    </Card>
  );
}
