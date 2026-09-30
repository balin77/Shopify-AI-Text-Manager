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

import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { Badge, Banner, BlockStack, Button, Checkbox, InlineStack, Modal, Select, Tag, Text, TextField } from "@shopify/polaris";
import { DisabledActionTooltip } from "./DisabledActionTooltip";
import { DeleteItemModal } from "./create/DeleteItemModal";
import { HelpTooltip } from "./HelpTooltip";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { getLocalizedLanguageName } from "../utils/contentEditor.utils";
import { countryOptions, localizedMarketName, regionCodeForName } from "../utils/market-name";
import { compareStrings } from "../utils/format";

/** Mirrors `MarketAddresses` in market-address.server.ts. */
export interface MarketAddressesView {
  markets: Array<{
    marketId: string;
    name: string;
    status: string;
    primary: boolean | null;
    own: { presenceId: string; url: string | null; subfolderSuffix: string | null; sharedWith: string[] } | null;
  }>;
  sharedUrl: string | null;
  takenSuffixes: string[];
  orphans: Array<{ presenceId: string; url: string | null; subfolderSuffix: string }>;
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
const CREATE_MARKET_ACTION = "createMarket";
const DELETE_MARKET_ACTION = "deleteMarket";
const REMOVE_ORPHAN_ACTION = "removeOrphanAddress";
/** The id the new-market form's answers are keyed on (it has no market yet). */
const NEW_MARKET = "new";

export function ShopMarketAddresses({ addresses, locales, appLocale, blocked, s, t }: Props) {
  const a = s.addresses ?? {};
  const { showInfoBox } = useInfoBox();
  const fetcher = useFetcher<any>();
  const busy = fetcher.state !== "idle";

  const [creating, setCreating] = useState<{ marketId: string; name: string } | null>(null);
  const [removing, setRemoving] = useState<{ marketId: string; name: string } | null>(null);
  const [addingMarket, setAddingMarket] = useState(false);
  const [deletingMarket, setDeletingMarket] = useState<{ marketId: string; name: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [newCountries, setNewCountries] = useState<string[]>([]);
  const [countryPick, setCountryPick] = useState("");
  const countries = useMemo(
    () => countryOptions(appLocale).sort((x, y) => compareStrings(x.name, y.name, appLocale)),
    [appLocale],
  );
  const countryName = (code: string) => countries.find((c) => c.code === code)?.name ?? code;
  const [suffix, setSuffix] = useState("");
  const [defaultLocale, setDefaultLocale] = useState("");
  const [alternates, setAlternates] = useState<string[]>([]);
  const [submittedFor, setSubmittedFor] = useState<string | null>(null);
  const [removingOrphan, setRemovingOrphan] = useState<{ presenceId: string; label: string } | null>(null);
  /** The create-address form's starting values — "dirty" means changed from these. */
  const [createInitial, setCreateInitial] = useState<{ suffix: string; defaultLocale: string } | null>(null);
  /**
   * Closing a form with input in it is confirmed by a second BUTTON (the app's
   * rule, as in the create dialog): Cancel arms a red discard button beside
   * itself and does not close. Any further input disarms it again.
   */
  const [confirmingClose, setConfirmingClose] = useState(false);
  useEffect(() => {
    setConfirmingClose(false);
  }, [newName, newCountries, suffix, defaultLocale, alternates]);
  const addMarketDirty = newName.trim().length > 0 || newCountries.length > 0;
  const createDirty =
    !!createInitial &&
    (suffix !== createInitial.suffix || defaultLocale !== createInitial.defaultLocale || alternates.length > 0);

  const langName = (code: string, fallback?: string) => getLocalizedLanguageName(code, appLocale, fallback);
  const marketName = (name: string) => localizedMarketName(name, appLocale);
  const primaryLocale = locales.find((l) => l.primary)?.locale ?? locales[0]?.locale ?? "";

  // This fetcher is the section's own, so an answer WITHOUT a `marketId` (the
  // action's outer catch) is still the answer to what was just submitted.
  const response =
    fetcher.data && submittedFor && (fetcher.data.marketId === submittedFor || fetcher.data.marketId == null)
      ? fetcher.data
      : null;
  const failure: string | null =
    response && !response.success && fetcher.state === "idle" ? errorText(String(response.error ?? "")) : null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !response?.success) return;
    const name = creating?.name ?? removing?.name ?? deletingMarket?.name ?? removingOrphan?.label ?? newName;
    const message: Record<string, string | undefined> = {
      [CREATE_ACTION]: a.createdMessage,
      [REMOVE_ACTION]: a.removedMessage,
      [CREATE_MARKET_ACTION]: a.marketCreatedMessage,
      [DELETE_MARKET_ACTION]: a.marketDeletedMessage,
      [REMOVE_ORPHAN_ACTION]: a.orphanRemovedMessage,
    };
    showInfoBox((message[response.actionType] || "").replace("{name}", marketName(name)), "success");
    setCreating(null);
    setRemoving(null);
    setAddingMarket(false);
    setDeletingMarket(null);
    setRemovingOrphan(null);
    setConfirmingClose(false);
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
      presenceShared: a.errorPresenceShared,
      primaryMarket: a.errorPrimaryMarket,
      createdNotDraft: a.errorCreatedNotDraft,
      removeAddressFirst: a.errorRemoveAddressFirst,
      notOrphan: a.errorNotOrphan,
      invalidChanges: s.errorInvalidChanges,
      invalidMarketName: a.errorInvalidMarketName,
      marketNameTaken: a.errorMarketNameTaken,
      invalidCountries: a.errorInvalidCountries,
    };
    return known[code] || code;
  }

  const openCreate = (marketId: string, name: string) => {
    // Shopify's subfolders are `/<language>-<suffix>`; the market's region code
    // is the natural suffix when its name is a standard region name.
    const initialSuffix = (regionCodeForName(name) ?? "").toLowerCase();
    setSuffix(initialSuffix);
    setDefaultLocale(primaryLocale);
    setAlternates([]);
    setCreateInitial({ suffix: initialSuffix, defaultLocale: primaryLocale });
    setConfirmingClose(false);
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
  return (
    <BlockStack gap="200">
      <InlineStack align="space-between" blockAlign="center" gap="300">
        <SectionHeading a={a} />
        <DisabledActionTooltip hint={blocked ? s.removeBlockedByDraft : undefined}>
          <Button
            disabled={blocked || busy}
            onClick={() => {
              setNewName("");
              setNewCountries([]);
              setCountryPick("");
              setSubmittedFor(null);
              setConfirmingClose(false);
              setAddingMarket(true);
            }}
          >
            {a.addMarketButton}
          </Button>
        </DisabledActionTooltip>
      </InlineStack>
      {addresses.markets.map((m) => (
        <InlineStack key={m.marketId} align="space-between" blockAlign="center" gap="300">
          <BlockStack gap="050">
            <InlineStack gap="200" blockAlign="center">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {marketName(m.name)}
              </Text>
              {m.status !== "ACTIVE" && <Badge>{a.draftBadge}</Badge>}
            </InlineStack>
            <Text as="p" variant="bodySm" tone="subdued">
              {m.status !== "ACTIVE"
                ? a.draftHint
                : m.primary === true
                  ? (a.primaryAddress || "{url}").replace("{url}", addresses.sharedUrl ?? "")
                  : m.own
                    ? (a.ownAddress || "{url}").replace("{url}", m.own.url ?? m.own.subfolderSuffix ?? "")
                    : (a.sharedAddress || "{url}").replace("{url}", addresses.sharedUrl ?? "")}
            </Text>
            {m.own && m.own.sharedWith.length > 0 && (
              <Text as="p" variant="bodySm" tone="subdued">
                {(a.presenceSharedWith || "{names}").replace("{names}", m.own.sharedWith.map(marketName).join(", "))}
              </Text>
            )}
          </BlockStack>
          <InlineStack gap="300" blockAlign="center">
          {/* A DOMAIN presence carries a domain the merchant connected in
              Shopify; only a subfolder is removed from here, and only one no
              other market uses. A draft market has no storefront to address,
              and the primary market IS the root storefront. */}
          {m.status === "ACTIVE" &&
            m.primary !== true &&
            (!m.own || (m.own.subfolderSuffix && m.own.sharedWith.length === 0)) && (
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
          {m.primary !== true && (
            <DisabledActionTooltip
              hint={blocked ? s.removeBlockedByDraft : ownBlocksDelete(m) ? a.errorRemoveAddressFirst : undefined}
            >
              <Button
                variant="plain"
                tone="critical"
                disabled={blocked || busy || ownBlocksDelete(m)}
                onClick={() => {
                  setSubmittedFor(null);
                  setDeletingMarket({ marketId: m.marketId, name: m.name });
                }}
              >
                {a.deleteMarketButton}
              </Button>
            </DisabledActionTooltip>
          )}
          </InlineStack>
        </InlineStack>
      ))}
      {addresses.orphans.map((o) => {
        // The PATH, not the full URL: it is what the confirmation asks the
        // merchant to type, and the host is the same for every row.
        const label = (() => {
          try {
            return o.url ? new URL(o.url).pathname.replace(/\/$/, "") || `/${o.subfolderSuffix}` : `/${o.subfolderSuffix}`;
          } catch {
            return `/${o.subfolderSuffix}`;
          }
        })();
        return (
          <InlineStack key={o.presenceId} align="space-between" blockAlign="center" gap="300">
            <BlockStack gap="050">
              <Text as="p" variant="bodyMd" fontWeight="semibold">
                {(a.orphanTitle || "{url}").replace("{url}", label)}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {a.orphanHint}
              </Text>
            </BlockStack>
            <DisabledActionTooltip hint={blocked ? s.removeBlockedByDraft : undefined}>
              <Button
                variant="plain"
                tone="critical"
                disabled={blocked || busy}
                onClick={() => {
                  setSubmittedFor(null);
                  setRemovingOrphan({ presenceId: o.presenceId, label });
                }}
              >
                {a.removeButton}
              </Button>
            </DisabledActionTooltip>
          </InlineStack>
        );
      })}

      {removingOrphan && (
        <DeleteItemModal
          open
          onClose={() => {
            if (busy) return;
            setRemovingOrphan(null);
            setSubmittedFor(null);
          }}
          item={{ id: removingOrphan.presenceId, title: removingOrphan.label, resource: "marketAddress" }}
          deleting={busy}
          error={failure}
          onConfirm={() => {
            const form = new FormData();
            form.append("actionType", REMOVE_ORPHAN_ACTION);
            form.append("presenceId", removingOrphan.presenceId);
            setSubmittedFor(removingOrphan.presenceId);
            fetcher.submit(form, { method: "post" });
          }}
          t={{ ...(t.content?.deleteModal ?? {}), ...(a.removeModal ?? {}), ...(a.orphanRemoveModal ?? {}) }}
        />
      )}

      {addingMarket && (
        <Modal
          open
          onClose={() => {
            if (busy) return;
            if (addMarketDirty) setConfirmingClose(true);
            else setAddingMarket(false);
          }}
          title={a.addMarketTitle}
          primaryAction={{
            content: a.addMarketConfirm,
            loading: busy,
            disabled: busy || newName.trim().length === 0 || newCountries.length === 0,
            onAction: () => {
              const form = new FormData();
              form.append("actionType", CREATE_MARKET_ACTION);
              form.append("name", newName.trim());
              form.append("countries", JSON.stringify(newCountries));
              setSubmittedFor(NEW_MARKET);
              fetcher.submit(form, { method: "post" });
            },
          }}
          secondaryActions={[
            {
              content: t.common?.cancel || "Cancel",
              onAction: () => (addMarketDirty ? setConfirmingClose(true) : setAddingMarket(false)),
              disabled: busy,
            },
            ...(confirmingClose
              ? [{ content: a.discardInput || "Discard your input", destructive: true, disabled: busy, onAction: () => setAddingMarket(false) }]
              : []),
          ]}
        >
          <Modal.Section>
            <BlockStack gap="300">
              {failure && (
                <Banner tone="critical">
                  <p>{failure}</p>
                </Banner>
              )}
              <TextField label={a.marketNameLabel} value={newName} onChange={setNewName} autoComplete="off" maxLength={60} />
              <InlineStack gap="200" blockAlign="end" wrap={false}>
                <div style={{ flex: 1 }}>
                  <Select
                    label={a.countriesLabel}
                    options={[
                      { label: a.countryPlaceholder || "…", value: "" },
                      ...countries.filter((c) => !newCountries.includes(c.code)).map((c) => ({ label: c.name, value: c.code })),
                    ]}
                    value={countryPick}
                    onChange={setCountryPick}
                  />
                </div>
                <Button
                  disabled={!countryPick}
                  onClick={() => {
                    setNewCountries((prev) => [...prev, countryPick]);
                    // A one-country market is named after its country until the merchant types otherwise.
                    if (!newName.trim() && newCountries.length === 0) setNewName(countryName(countryPick));
                    setCountryPick("");
                  }}
                >
                  {s.addButton || "Add"}
                </Button>
              </InlineStack>
              {newCountries.length > 0 && (
                <InlineStack gap="200" wrap>
                  {newCountries.map((code) => (
                    <Tag key={code} onRemove={() => setNewCountries((prev) => prev.filter((c) => c !== code))}>
                      {countryName(code)}
                    </Tag>
                  ))}
                </InlineStack>
              )}
              <Banner tone="info">
                <p>{a.addMarketHint}</p>
              </Banner>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}

      {deletingMarket && (
        <DeleteItemModal
          open
          onClose={() => {
            if (busy) return;
            setDeletingMarket(null);
            setSubmittedFor(null);
          }}
          item={{ id: deletingMarket.marketId, title: marketName(deletingMarket.name), resource: "market" }}
          deleting={busy}
          error={failure}
          onConfirm={() => {
            const form = new FormData();
            form.append("actionType", DELETE_MARKET_ACTION);
            form.append("marketId", deletingMarket.marketId);
            setSubmittedFor(deletingMarket.marketId);
            fetcher.submit(form, { method: "post" });
          }}
          t={{ ...(t.content?.deleteModal ?? {}), ...(a.deleteMarketModal ?? {}) }}
        />
      )}

      {creating && (
        <Modal
          open
          onClose={() => {
            if (busy) return;
            if (createDirty) setConfirmingClose(true);
            else setCreating(null);
          }}
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
          secondaryActions={[
            {
              content: t.common?.cancel || "Cancel",
              onAction: () => (createDirty ? setConfirmingClose(true) : setCreating(null)),
              disabled: busy,
            },
            ...(confirmingClose
              ? [{ content: a.discardInput || "Discard your input", destructive: true, disabled: busy, onAction: () => setCreating(null) }]
              : []),
          ]}
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

/**
 * A market's own unshared SUBFOLDER goes with it on delete (measured, see
 * `deleteMarket`); a domain or a shared address is changed in Shopify first.
 */
function ownBlocksDelete(m: MarketAddressesView["markets"][number]): boolean {
  return !!m.own && (!m.own.subfolderSuffix || m.own.sharedWith.length > 0);
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
