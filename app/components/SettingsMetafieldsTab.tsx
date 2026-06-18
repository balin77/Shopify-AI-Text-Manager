/**
 * SettingsMetafieldsTab — scan & enable product metafield definitions for the
 * ContentPilot translation pipeline.
 *
 * Surfaces ALL product metafield definitions (incl. third-party app ones that
 * `translatableContent` never returns), grouped by owner:
 *  - Shop-owned + ContentPilot → checkbox active; enabling patches the
 *    definition's `translatable` capability when needed.
 *  - Third-party app-owned → checkbox disabled (Shopify rejects our patch).
 *
 * Only definitions that are BOTH translatable AND enabled here appear in the
 * product editor (decided design point 1).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Card,
  Text,
  BlockStack,
  InlineStack,
  Button,
  Badge,
  Banner,
  Checkbox,
  Spinner,
  Tooltip,
} from "@shopify/polaris";
import type { Translation as I18nTranslation } from "~/i18n/de";

type MetafieldOwnerCategory = "shop" | "third-party" | "contentpilot";

interface ScannedDefinition {
  id: string;
  namespace: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
  translatable: boolean;
  ownerCategory: MetafieldOwnerCategory;
  appName?: string;
}

interface EnabledDef {
  definitionId: string;
  namespace: string;
  key: string;
  patchedTranslatable: boolean;
}

interface Props {
  enabledMetafieldDefinitions: EnabledDef[];
  metafieldsLastScanAt: string | null;
  t: I18nTranslation;
}

interface ScanResult {
  success: boolean;
  actionType?: string;
  definitions?: ScannedDefinition[];
  metafieldsLastScanAt?: string;
  error?: string;
}

interface SaveResult {
  success: boolean;
  actionType?: string;
  enabledCount?: number;
  failed?: Array<{ namespace: string; key: string; error?: string }>;
  error?: string;
}

const GROUP_ORDER: MetafieldOwnerCategory[] = ["shop", "contentpilot", "third-party"];

export function SettingsMetafieldsTab({ enabledMetafieldDefinitions, metafieldsLastScanAt, t }: Props) {
  const scanFetcher = useFetcher<ScanResult>();
  const saveFetcher = useFetcher<SaveResult>();

  const [definitions, setDefinitions] = useState<ScannedDefinition[]>([]);
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(enabledMetafieldDefinitions.map((d) => d.definitionId)),
  );
  const [lastScanAt, setLastScanAt] = useState<string | null>(metafieldsLastScanAt);
  const initialSelectedKey = useMemo(
    () => enabledMetafieldDefinitions.map((d) => d.definitionId).sort().join("|"),
    [enabledMetafieldDefinitions],
  );

  const ms = (t.settings ?? {}) as unknown as Record<string, string>;
  const tr = (key: string, fallback: string) => ms[key] ?? fallback;

  // Scan whenever we have no list yet. `definitions` lives only in component
  // state and the tab unmounts on tab switch, so a merchant returning to the
  // tab would otherwise see the empty state until a manual re-scan. The 24h
  // staleness no longer gates the trigger (it only ever affected the timestamp
  // display); a settings tab is low-traffic so scanning on open is fine.
  const autoScanned = useRef(false);
  useEffect(() => {
    if (autoScanned.current) return;
    if (scanFetcher.state === "idle" && definitions.length === 0) {
      autoScanned.current = true;
      scanFetcher.submit({ actionType: "scanProductMetafieldDefinitions" }, { method: "post" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Absorb scan results.
  useEffect(() => {
    if (scanFetcher.state === "idle" && scanFetcher.data?.success && scanFetcher.data.definitions) {
      setDefinitions(scanFetcher.data.definitions);
      if (scanFetcher.data.metafieldsLastScanAt) setLastScanAt(scanFetcher.data.metafieldsLastScanAt);
      // Drop selections for definitions that no longer exist.
      const ids = new Set(scanFetcher.data.definitions.map((d) => d.id));
      setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
    }
  }, [scanFetcher.state, scanFetcher.data]);

  // Reconcile checkbox state after a save: uncheck any definition that could
  // not be persisted (e.g. an app-owned one Shopify refused to patch), so the
  // UI matches what was actually saved instead of showing a stuck checkmark.
  useEffect(() => {
    if (saveFetcher.state !== "idle" || !saveFetcher.data?.success) return;
    const failedKeys = new Set((saveFetcher.data.failed ?? []).map((f) => `${f.namespace}.${f.key}`));
    if (failedKeys.size === 0) return;
    setSelected((prev) => {
      const next = new Set(prev);
      for (const def of definitions) {
        if (failedKeys.has(`${def.namespace}.${def.key}`)) next.delete(def.id);
      }
      return next;
    });
  }, [saveFetcher.state, saveFetcher.data, definitions]);

  const isScanning = scanFetcher.state !== "idle";
  const isSaving = saveFetcher.state !== "idle";

  const groups = useMemo(() => {
    const byGroup: Record<MetafieldOwnerCategory, ScannedDefinition[]> = {
      shop: [],
      contentpilot: [],
      "third-party": [],
    };
    for (const def of definitions) byGroup[def.ownerCategory].push(def);
    for (const cat of GROUP_ORDER) {
      byGroup[cat].sort((a, b) =>
        `${a.namespace}.${a.key}`.localeCompare(`${b.namespace}.${b.key}`),
      );
    }
    return byGroup;
  }, [definitions]);

  const currentSelectedKey = useMemo(
    () => [...selected].sort().join("|"),
    [selected],
  );
  const isDirty = currentSelectedKey !== initialSelectedKey;

  function toggle(def: ScannedDefinition, checked: boolean) {
    if (def.ownerCategory === "third-party") return; // not selectable
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(def.id);
      else next.delete(def.id);
      return next;
    });
  }

  function handleScan() {
    scanFetcher.submit({ actionType: "scanProductMetafieldDefinitions" }, { method: "post" });
  }

  function handleSave() {
    const byId = new Map(definitions.map((d) => [d.id, d]));
    const payload: Array<{ definitionId: string; namespace: string; key: string; requiresPatch: boolean }> = [];
    for (const id of selected) {
      const def = byId.get(id);
      if (!def || def.ownerCategory === "third-party") continue;
      payload.push({
        definitionId: def.id,
        namespace: def.namespace,
        key: def.key,
        requiresPatch: !def.translatable,
      });
    }
    saveFetcher.submit(
      { actionType: "saveEnabledMetafieldDefinitions", definitions: JSON.stringify(payload) },
      { method: "post" },
    );
  }

  const groupTitles: Record<MetafieldOwnerCategory, string> = {
    shop: tr("metafieldsGroupShop", "Shop-owned"),
    contentpilot: tr("metafieldsGroupContentPilot", "ContentPilot"),
    "third-party": tr("metafieldsGroupThirdParty", "Third-party apps"),
  };

  const saveFailed = saveFetcher.data?.failed ?? [];
  const showSaveSuccess =
    saveFetcher.state === "idle" && saveFetcher.data?.success && saveFailed.length === 0;

  return (
    <BlockStack gap="400">
      <Card>
        <BlockStack gap="300">
          <Text as="h2" variant="headingLg">
            {tr("metafields", "Metafields")}
          </Text>
          <Text as="p" tone="subdued" variant="bodyMd">
            {tr(
              "metafieldsDescription",
              "Enable additional metafields that ContentPilot should include when translating products — including fields from third-party apps.",
            )}
          </Text>
          <InlineStack gap="300" blockAlign="center">
            <Button onClick={handleScan} loading={isScanning} disabled={isSaving}>
              {tr("metafieldsScanNow", "Scan now")}
            </Button>
            {isScanning ? (
              <InlineStack gap="100" blockAlign="center">
                <Spinner size="small" accessibilityLabel="scanning" />
                <Text as="span" tone="subdued" variant="bodySm">
                  {tr("metafieldsScanning", "Scanning…")}
                </Text>
              </InlineStack>
            ) : (
              <Text as="span" tone="subdued" variant="bodySm">
                {lastScanAt
                  ? tr("metafieldsLastScan", "Last scan: {date}").replace(
                      "{date}",
                      new Date(lastScanAt).toLocaleString(),
                    )
                  : tr("metafieldsNeverScanned", "Not scanned yet")}
              </Text>
            )}
          </InlineStack>
        </BlockStack>
      </Card>

      {scanFetcher.data && scanFetcher.data.success === false && (
        <Banner tone="critical">
          <Text as="p" variant="bodyMd">{scanFetcher.data.error ?? t.common.error}</Text>
        </Banner>
      )}

      {showSaveSuccess && (
        <Banner tone="success">
          <Text as="p" variant="bodyMd">
            {tr("metafieldsSaved", "Metafields saved")}
          </Text>
        </Banner>
      )}

      {saveFetcher.state === "idle" && saveFailed.length > 0 && (
        <Banner tone="warning">
          <Text as="p" variant="bodyMd">
            {tr(
              "metafieldsSaveFailed",
              "Some definitions could not be enabled (app-owned): {keys}",
            ).replace("{keys}", saveFailed.map((f) => `${f.namespace}.${f.key}`).join(", "))}
          </Text>
        </Banner>
      )}

      {!isScanning && definitions.length === 0 ? (
        <Card>
          <BlockStack gap="200" inlineAlign="center">
            <Text as="p" variant="headingMd">
              {tr("metafieldsEmptyHeading", "No metafield definitions found")}
            </Text>
            <Text as="p" tone="subdued" variant="bodyMd">
              {tr("metafieldsEmptyBody", "Run a scan to discover product metafields you can enable for translation.")}
            </Text>
          </BlockStack>
        </Card>
      ) : (
        GROUP_ORDER.map((cat) => {
          const defs = groups[cat];
          if (defs.length === 0) return null;
          return (
            <Card key={cat}>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h3" variant="headingMd">{groupTitles[cat]}</Text>
                  <Badge tone="info">{`${defs.length}`}</Badge>
                </InlineStack>
                <BlockStack gap="200">
                  {defs.map((def) => {
                    const disabled = def.ownerCategory === "third-party";
                    const statusBadge = def.translatable
                      ? <Badge tone="success">{tr("metafieldsBadgeTranslatable", "translatable")}</Badge>
                      : disabled
                        ? null
                        : <Badge tone="attention">{tr("metafieldsBadgeActivatable", "activatable")}</Badge>;
                    return (
                      <div
                        key={def.id}
                        style={{ borderTop: "1px solid #f1f1f1", paddingTop: "0.5rem" }}
                      >
                        <InlineStack gap="200" blockAlign="start" wrap={false}>
                          <Checkbox
                            label=""
                            labelHidden
                            checked={selected.has(def.id)}
                            disabled={disabled || isSaving}
                            onChange={(checked) => toggle(def, checked)}
                          />
                          <BlockStack gap="050">
                            <InlineStack gap="200" blockAlign="center">
                              <Text as="span" variant="bodyMd" fontWeight="semibold">
                                {def.namespace}.{def.key}
                              </Text>
                              <Badge>{def.type || "—"}</Badge>
                              {statusBadge}
                              {disabled && (
                                <Tooltip
                                  content={tr(
                                    "metafieldsThirdPartyHelp",
                                    "Owned by another app and cannot be made translatable by ContentPilot (planned for Phase 2).",
                                  )}
                                >
                                  <span
                                    style={{ cursor: "help", color: "#6d7175", fontWeight: 600 }}
                                    aria-label="info"
                                  >
                                    ⓘ
                                  </span>
                                </Tooltip>
                              )}
                            </InlineStack>
                            {(def.name || def.appName) && (
                              <Text as="span" tone="subdued" variant="bodySm">
                                {def.appName ? `${def.appName} · ` : ""}{def.name}
                              </Text>
                            )}
                          </BlockStack>
                        </InlineStack>
                      </div>
                    );
                  })}
                </BlockStack>
              </BlockStack>
            </Card>
          );
        })
      )}

      {definitions.length > 0 && (
        <InlineStack align="end">
          <Button
            variant="primary"
            onClick={handleSave}
            loading={isSaving}
            disabled={!isDirty || isScanning}
          >
            {tr("metafieldsSaveChanges", "Save changes")}
          </Button>
        </InlineStack>
      )}
    </BlockStack>
  );
}
