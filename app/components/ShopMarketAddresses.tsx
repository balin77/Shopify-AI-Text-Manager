/**
 * Settings → Shop-Sprachen → "Märkte und Adressen": which markets have an
 * address of their own, and the two acts that change it.
 *
 * Shopify keeps a shop's languages on the WEB PRESENCE, and markets without a
 * domain or subfolder of their own share the shop's (measured, see
 * market-address.server.ts). So "a language for one market only" starts here:
 * give the market its own subfolder, and the language checkboxes above offer
 * it separately.
 *
 * Both acts move storefront URLs, so neither is a draft behind the save bar:
 * creating is its own confirmed modal with a URL preview and an SEO warning,
 * removing goes through the app's type-the-name dialog. Both are offered only
 * while no draft is open (the same rule as removing a language), on their own
 * fetcher, and the server replays every request over a FRESH read.
 */

import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { Banner, BlockStack, Button, Checkbox, InlineStack, Modal, Select, Text, TextField } from "@shopify/polaris";
import { DisabledActionTooltip } from "./DisabledActionTooltip";
import { DeleteItemModal } from "./create/DeleteItemModal";
import { HelpTooltip } from "./HelpTooltip";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { localizedMarketName, regionCodeForName } from "../utils/market-name";

/** Mirrors `MarketAddresses` in market-address.server.ts. */
export interface MarketAddressesView {
  markets: Array<{
    marketId: string;
    name: string;
    own: { presenceId: string; url: string | null; subfolderSuffix: string | null } | null;
  }>;
  sharedUrl: string | null;
}

interface Props {
  addresses: MarketAddressesView | null;
  /** Published shop locales — a storefront address can only serve those. */
  locales: Array<{ locale: string; name?: string; primary: boolean }>;
  appLocale: string;
  /** A language draft is open: address changes wait until it is saved. */
  blocked: boolean;
  s: any;
  t: any;
}

const CREATE_ACTION = "createMarketAddress";
const REMOVE_ACTION = "removeMarketAddress";

export function ShopMarketAddresses({ addresses, locales, appLocale, blocked, s, t }: Props) {
  const a = s.addresses ?? {};
  const { showInfoBox } = useInfoBox();
  const fetcher = useFetcher<any>();
  const busy = fetcher.state !== "idle";

  const [creating, setCreating] = useState<{ marketId: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<{ marketId: string; name: string } | null>(null);
  const [suffix, setSuffix] = useState("");
  const [defaultLocale, setDefaultLocale] = useState("");
  const [alternates, setAlternates] = useState<string[]>([]);
  const [submittedFor, setSubmittedFor] = useState<string | null>(null);

  const langName = (code: string, fallback?: string) => getLocalizedLanguageName(code, appLocale, fallback);
  const marketName = (name: string) => localizedMarketName(name, appLocale);
  const primaryLocale = locales.find((l) => l.primary)?.locale ?? locales[0]?.locale ?? "";

  const response = fetcher.data && submittedFor && fetcher.data.marketId === submittedFor ? fetcher.data : null;
  const failure: string | null =
    response && !response.success && fetcher.state === "idle" ? errorText(String(response.error ?? "")) : null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !response?.success) return;
    const name = creating?.name ?? removing?.name ?? "";
    showInfoBox(
      (response.actionType === CREATE_ACTION ? a.createdMessage : a.removedMessage || "").replace(
        "{name}",
        marketName(name),
      ),
      "success",
    );
    setCreating(null);
    setRemoving(null);
    setSubmittedFor(null);
    // React Router revalidates the loaders after the action by itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.state, response]);

  function errorText(code: string): string {
    const known: Record<string, string | undefined> = {
      unknownMarket: a.errorUnknownMarket,
      marketHasAddress: a.errorMarketHasAddress,
      invalidSuffix: a.errorInvalidSuffix,
      suffixTaken: a.errorSuffixTaken,
      unknownLocale: a.errorUnknownLocale,
      unverified: a.errorUnverified,
      notConfirmed: a.errorNotConfirmed,
      notSupported: a.errorNotSupported,
      schemaUnreadable: a.errorNotSupported,
      notSubfolder: a.errorNotSubfolder,
      invalidChanges: s.errorInvalidChanges,
    };
    return known[code] || code;
  }

  const openCreate = (marketId: string, name: string) => {
    // Shopify's subfolders are `/<language>-<suffix>`; the market's region code
    // is the natural suffix when its name is a standard region name.
    setSuffix((regionCodeForName(name) ?? "").toLowerCase());
    setDefaultLocale(primaryLocale);
    setAlternates([]);
    setSubmittedFor(null);
    setCreating({ marketId, name });
  };

  const origin = (() => {
    try {
      return addresses?.sharedUrl ? new URL(addresses.sharedUrl).origin : "";
    } catch {
      return "";
    }
  })();
  const preview =
    origin && suffix && defaultLocale ? `${origin}/${defaultLocale.toLowerCase()}-${suffix.toLowerCase()}/` : "";

  if (addresses === null) {
    return (
      <BlockStack gap="200">
        <SectionHeading a={a} />
        <Text as="p" variant="bodySm" tone="caution">
          {a.unavailable}
        </Text>
      </BlockStack>
    );
  }
  if (addresses.markets.length === 0) return null;

  return (
    <BlockStack gap="200">
      <SectionHeading a={a} />
      {addresses.markets.map((m) => (
        <InlineStack key={m.marketId} align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="050">
            <Text as="p" variant="bodyMd" fontWeight="semibold">
              {marketName(m.name)}
            </Text>
            <Text as="p" variant="bodySm" tone="subdued">
              {m.own
                ? (a.ownAddress || "{url}").replace("{url}", m.own.url ?? m.own.subfolderSuffix ?? "")
                : (a.sharedAddress || "{url}").replace("{url}", addresses.sharedUrl ?? "")}
            </Text>
          </BlockStack>
          {/* A DOMAIN presence carries a domain the merchant connected in
              Shopify; only a subfolder is removed from here. */}
          {(!m.own || m.own.subfolderSuffix) && (
            <DisabledActionTooltip hint={blocked ? s.removeBlockedByDraft : undefined}>
              {m.own ? (
                <Button
                  variant="plain"
                  tone="critical"
                  disabled={blocked || busy}
                  onClick={() => {
                    setSubmittedFor(null);
                    setRemoving({ marketId: m.marketId, name: m.name });
                  }}
                >
                  {a.removeButton}
                </Button>
              ) : (
                <Button disabled={blocked || busy} onClick={() => openCreate(m.marketId, m.name)}>
                  {a.createButton}
                </Button>
              )}
            </DisabledActionTooltip>
          )}
        </InlineStack>
      ))}

      {creating && (
        <Modal
          open
          onClose={() => !busy && setCreating(null)}
          title={(a.createTitle || "{name}").replace("{name}", marketName(creating.name))}
          primaryAction={{
            content: a.createConfirm,
            loading: busy,
            disabled: busy || !/^[a-z]{2,8}$/.test(suffix) || !defaultLocale,
            onAction: () => {
              const form = new FormData();
              form.append("actionType", CREATE_ACTION);
              form.append("marketId", creating.marketId);
              form.append("suffix", suffix);
              form.append("defaultLocale", defaultLocale);
              form.append("alternateLocales", JSON.stringify(alternates));
              setSubmittedFor(creating.marketId);
              fetcher.submit(form, { method: "post" });
            },
          }}
          secondaryActions={[{ content: t.common?.cancel || "Cancel", onAction: () => setCreating(null), disabled: busy }]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              {failure && (
                <Banner tone="critical">
                  <p>{failure}</p>
                </Banner>
              )}
              <TextField
                label={a.suffixLabel}
                helpText={a.suffixHelp}
                value={suffix}
                onChange={(v) => setSuffix(v.toLowerCase().replace(/[^a-z]/g, "").slice(0, 8))}
                autoComplete="off"
              />
              <Select
                label={a.defaultLocaleLabel}
                options={locales.map((l) => ({ label: `${langName(l.locale, l.name)} (${l.locale})`, value: l.locale }))}
                value={defaultLocale}
                onChange={(v) => {
                  setDefaultLocale(v);
                  setAlternates((prev) => prev.filter((x) => x !== v));
                }}
              />
              <BlockStack gap="100">
                <Text as="p" variant="bodyMd">
                  {a.alternateLabel}
                </Text>
                <InlineStack gap="300" wrap>
                  {locales
                    .filter((l) => l.locale !== defaultLocale)
                    .map((l) => (
                      <Checkbox
                        key={l.locale}
                        label={langName(l.locale, l.name)}
                        checked={alternates.includes(l.locale)}
                        onChange={(on) =>
                          setAlternates((prev) => (on ? [...prev, l.locale] : prev.filter((x) => x !== l.locale)))
                        }
                      />
                    ))}
                </InlineStack>
              </BlockStack>
              {preview && (
                <Text as="p" variant="bodyMd">
                  {(a.preview || "{url}").replace("{url}", preview)}
                </Text>
              )}
              <Banner tone="warning">
                <p>{a.createWarning}</p>
              </Banner>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}

      {removing && (
        <DeleteItemModal
          open
          onClose={() => {
            if (busy) return;
            setRemoving(null);
            setSubmittedFor(null);
          }}
          item={{ id: removing.marketId, title: marketName(removing.name), resource: "marketAddress" }}
          deleting={busy}
          error={failure}
          onConfirm={() => {
            const form = new FormData();
            form.append("actionType", REMOVE_ACTION);
            form.append("marketId", removing.marketId);
            setSubmittedFor(removing.marketId);
            fetcher.submit(form, { method: "post" });
          }}
          t={{ ...(t.content?.deleteModal ?? {}), ...(a.removeModal ?? {}) }}
        />
      )}
    </BlockStack>
  );
}

function SectionHeading({ a }: { a: any }) {
  return (
    <InlineStack gap="100" blockAlign="center" wrap={false}>
      <Text as="h3" variant="headingSm">
        {a.title}
      </Text>
      <HelpTooltip helpKey="shopLanguagesMarkets" position="below" />
    </InlineStack>
  );
}
