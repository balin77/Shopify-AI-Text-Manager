import { useState } from "react";
import { BlockStack, Card, InlineStack, Text } from "@shopify/polaris";
import { SettingsTranslationProbeTab } from "./SettingsTranslationProbeTab";
import { SettingsPageSpeedProbeTab } from "./SettingsPageSpeedProbeTab";
import { SettingsCollectionModelProbeTab } from "./SettingsCollectionModelProbeTab";
import { SettingsMetaobjectProbeTab } from "./SettingsMetaobjectProbeTab";
import { SettingsUnitPriceProbeTab } from "./SettingsUnitPriceProbeTab";
import { SettingsTaxonomyProbeTab } from "./SettingsTaxonomyProbeTab";

export type ProbeSubTab =
  | "translationprobe"
  | "pagespeedprobe"
  | "collectionprobe"
  | "metaobjectprobe"
  | "unitpriceprobe"
  | "taxonomyprobe";

interface Props {
  /** Same per-probe gates as before — one flag per sub-tab, not one for the group. */
  showTranslationProbe: boolean;
  showPageSpeedProbe: boolean;
  showCollectionProbe: boolean;
  showMetaobjectProbe: boolean;
  showUnitPriceProbe: boolean;
  showTaxonomyProbe: boolean;
  initialSubTab?: ProbeSubTab;
}

/**
 * Bundles the dev-only diagnostic probes (Translation, PageSpeed,
 * Collection-Model) under ONE settings tab with a horizontal sub-tab strip —
 * the same shape as SettingsOtherTab, and for the same reason: three
 * near-identical entries in the left nav pushed the real settings out of view.
 *
 * The gating is unchanged and stays PER PROBE: each flag still decides whether
 * its own sub-tab exists, so a probe whose gate closes disappears on its own
 * rather than riding on the group. The caller renders this tab only when at
 * least one flag is set; the empty check here is the caller-side twin of that,
 * so no empty strip can ever be shown.
 */
export function SettingsProbesTab({
  showTranslationProbe,
  showPageSpeedProbe,
  showCollectionProbe,
  showMetaobjectProbe,
  showUnitPriceProbe,
  showTaxonomyProbe,
  initialSubTab,
}: Props) {
  const subTabs: { id: ProbeSubTab; label: string }[] = [
    ...(showTranslationProbe ? [{ id: "translationprobe" as ProbeSubTab, label: "Translation" }] : []),
    ...(showPageSpeedProbe ? [{ id: "pagespeedprobe" as ProbeSubTab, label: "PageSpeed" }] : []),
    ...(showCollectionProbe ? [{ id: "collectionprobe" as ProbeSubTab, label: "Collection Model" }] : []),
    ...(showMetaobjectProbe ? [{ id: "metaobjectprobe" as ProbeSubTab, label: "Metaobjects" }] : []),
    ...(showUnitPriceProbe ? [{ id: "unitpriceprobe" as ProbeSubTab, label: "Unit price" }] : []),
    ...(showTaxonomyProbe ? [{ id: "taxonomyprobe" as ProbeSubTab, label: "Taxonomy" }] : []),
  ];

  // Hooks must run unconditionally, so the fallback tolerates an empty list and
  // the early return happens after useState.
  const fallback = subTabs[0]?.id;
  const resolvedInitial =
    initialSubTab && subTabs.some((s) => s.id === initialSubTab) ? initialSubTab : fallback;
  const [selected, setSelected] = useState<ProbeSubTab | undefined>(resolvedInitial);

  if (subTabs.length === 0) return null;

  return (
    <BlockStack gap="400">
      {/* Slim nav Card — identical to the "Weiteres" strip so the two grouped
          tabs read as one pattern. `padding="0"` keeps the strip's border
          anchored to the Card edge without negative margins. */}
      <Card padding="0">
        <div style={{ borderBottom: "1px solid #e1e3e5" }}>
          <InlineStack gap="0">
            {subTabs.map((tab) => {
              const isActive = selected === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setSelected(tab.id)}
                  style={{
                    padding: "0.75rem 1.25rem",
                    background: "none",
                    border: "none",
                    borderBottom: isActive ? "3px solid #008060" : "3px solid transparent",
                    marginBottom: "-1px",
                    cursor: "pointer",
                  }}
                >
                  <Text
                    as="span"
                    variant="bodyMd"
                    fontWeight={isActive ? "bold" : "regular"}
                    tone={isActive ? "base" : "subdued"}
                  >
                    {tab.label}
                  </Text>
                </button>
              );
            })}
          </InlineStack>
        </div>
      </Card>

      {/* Translation Coverage Probe (Phase 0 dev tool) */}
      {selected === "translationprobe" && showTranslationProbe && <SettingsTranslationProbeTab />}

      {/* PageSpeed raw-response probe (accessibility plan §3.3) */}
      {selected === "pagespeedprobe" && showPageSpeedProbe && <SettingsPageSpeedProbeTab />}

      {/* Collection-Model Probe (PLAN_CONTENT_CREATION Phase 0 dev tool) */}
      {selected === "collectionprobe" && showCollectionProbe && <SettingsCollectionModelProbeTab />}

      {/* Metaobject Probe (PLAN_METAOBJECTS_EDITOR Phase 0 dev tool) */}
      {selected === "metaobjectprobe" && showMetaobjectProbe && <SettingsMetaobjectProbeTab />}

      {/* Unit-price probe — is the Grundpreis writable at all? */}
      {selected === "unitpriceprobe" && showUnitPriceProbe && <SettingsUnitPriceProbeTab />}

      {/* Taxonomy probe — what the category picker can be built on. */}
      {selected === "taxonomyprobe" && showTaxonomyProbe && <SettingsTaxonomyProbeTab />}
    </BlockStack>
  );
}
