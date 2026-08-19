/**
 * Prices, shipping settings and stock -- for ONE variant, or for a whole group
 * of them at once.
 *
 * -- Why it lives in the variants card ---------------------------------------
 * It describes the variants the options above it produce. Editing "Weiss /
 * 20cm" two cards away from the list that says what "Weiss" is made the
 * merchant hold the mapping in their head. A divider separates the two halves:
 * above, what the options ARE; below, what each combination costs and weighs.
 *
 * -- Scopes, and why bulk editing is the point -------------------------------
 * Three colours and four sizes is twelve variants, and a merchant almost never
 * wants exactly one of them. The picker therefore offers one variant, every
 * variant carrying one option VALUE ("all white", "all 20cm"), or all of them
 * -- see `variant-scope.shared.ts` for which groups exist and why.
 *
 * A bulk field shows the value its members AGREE on, and nothing when they
 * differ. That distinction is the whole safety of the feature: showing the
 * first member's price for twelve variants that each have their own would
 * invite the merchant either to leave it alone believing they are all that
 * price, or to touch it and overwrite eleven values they never saw. An
 * untouched bulk field writes nothing at all -- only what is typed is applied,
 * and it is applied to every member.
 *
 * -- STOCK is not bulk-editable, deliberately ---------------------------------
 * Every other field here is a property the variants can genuinely share: a
 * price, a weight, a customs code. A stock level is a COUNT, per variant per
 * location, and `inventorySetQuantities` takes an absolute quantity compared
 * against the one that was loaded. Writing one number across twelve variants
 * would not "set the stock", it would flatten twelve different counts to the
 * same figure -- and it would do it through the one write path in this app
 * that exists to refuse exactly that kind of overwrite. So stock appears for a
 * single variant only, and the panel says why rather than hiding it.
 */

import { useMemo, useState, type CSSProperties } from "react";
import {
  Badge,
  BlockStack,
  Box,
  Banner,
  Button,
  Collapsible,
  Divider,
  InlineStack,
  Select,
  Spinner,
  Text,
  TextField,
  Thumbnail,
  Tooltip,
} from "@shopify/polaris";
import { HelpTooltip } from "../HelpTooltip";
import { ToggleSwitch } from "../ToggleSwitch";
import { useCommerceData, WEIGHT_UNITS } from "../../contexts/CommerceDataContext";
import { buildVariantScopes, commonValue, type VariantScope } from "../../services/variant-scope.shared";

/** The fields that live on the VARIANT rather than on its InventoryItem. */
type VariantField = "price" | "compareAtPrice" | "barcode" | "inventoryPolicy" | "taxable";

export function CommerceVariantsSection() {
  const commerce = useCommerceData();
  /** The chosen scope id, or null while none has been picked. */
  const [scopeId, setScopeId] = useState<string | null>(null);
  /** Whether the customs details are folded open. Closed by default, the way
   *  Shopify folds them: most merchants never touch an HS code. */
  const [customsOpen, setCustomsOpen] = useState(false);

  const variants = commerce?.data?.variants ?? [];
  const t = commerce?.t ?? {};

  const scopes = useMemo(
    () =>
      buildVariantScopes(variants, {
        all: (t.scopeAll as string) || "All variants",
        groupLabel: (optionName, value) =>
          ((t.scopeGroup as string) || "All {value}").replace("{value}", value).replace("{option}", optionName),
      }),
    [variants, t.scopeAll, t.scopeGroup],
  );

  // Every hook is above this line: the panel has twice dropped the whole
  // editor into its error boundary by putting one below an early return, and
  // React counts hooks per render, not per branch.
  if (!commerce || !commerce.isPrimaryLocale || commerce.planBlocked) return null;
  const { data, saving, priceEdits, setPriceEdits, itemEdits, setItemEdits, edits, setEdits, loadError, load } =
    commerce;

  // A failed load used to leave this card EMPTY: the banner and its retry
  // button live in the channels card, which is somewhere else on the screen.
  // A merchant looking at the variants card saw nothing and no reason.
  if (loadError) {
    return (
      <BlockStack gap="300">
        <Divider />
        <Banner tone="warning">
          <BlockStack gap="200">
            <Text as="p">{loadError}</Text>
            <Box><Button onClick={() => load()}>{(t.retry as string) || "Try again"}</Button></Box>
          </BlockStack>
        </Banner>
      </BlockStack>
    );
  }
  if (!data) {
    return (
      <BlockStack gap="300">
        <Divider />
        <Spinner size="small" accessibilityLabel={(t.loading as string) || "Loading"} />
      </BlockStack>
    );
  }
  if (variants.length === 0) return null;

  /** The chosen scope, falling back to the first variant. A selection pointing
   *  at a scope a reload no longer produces would otherwise show nothing. */
  const scope: VariantScope = scopes.find((s) => s.id === scopeId) ?? scopes[0];
  const members = variants.filter((v) => scope.variantIds.includes(v.id));
  if (members.length === 0) return null;
  const first = members[0];
  const isBulk = members.length > 1;

  /** The value all members agree on, or "" when they differ. */
  /** Variant-level fields: the two prices, the barcode, the stock policy. */
  /** STRINGIFIED: `taxable` is a boolean on the variant, and comparing it to
   *  "true" without this is always false — the switch showed off for a taxed
   *  variant and writing it back would have untaxed it. */
  const priceValueOf = (member: (typeof members)[number], field: VariantField): string => {
    const edited = priceEdits[`${member.id}::${field}`];
    if (edited !== undefined) return edited;
    const loaded = (member as unknown as Record<string, unknown>)[field];
    return loaded == null ? "" : String(loaded);
  };
  const priceValue = (field: VariantField): string =>
    commonValue(members.map((m) => priceValueOf(m, field))) ?? "";
  const priceMixed = (field: VariantField): boolean =>
    isBulk && commonValue(members.map((m) => priceValueOf(m, field))) === null;

  /**
   * Whether the members DISAGREE on a field as it was loaded — ignoring what
   * has been typed since.
   *
   * This is what makes an empty bulk field safe. A field showing "" because
   * its members differ is showing "unknown", not "empty", so clearing it back
   * to "" has to mean UNTOUCHED. Without that there is no way back: a merchant
   * who types a character into a mixed barcode field and deletes it again sent
   * `barcode: ""` for every member, and Shopify cleared values they had never
   * seen — precisely what the mixed display exists to prevent.
   *
   * Where the members AGREE, "" keeps its ordinary meaning of "clear this",
   * because the field was showing the value that is being erased.
   */
  const loadedDisagrees = (field: string): boolean =>
    isBulk &&
    commonValue(
      members.map((m) => {
        const loaded = (m as unknown as Record<string, unknown>)[field];
        return loaded == null ? "" : String(loaded);
      }),
    ) === null;

  const setPrice = (field: string, value: string) =>
    setPriceEdits((prev) => {
      const next = { ...prev };
      const untouched = value === "" && loadedDisagrees(field);
      for (const member of members) {
        if (untouched) delete next[`${member.id}::${field}`];
        else next[`${member.id}::${field}`] = value;
      }
      return next;
    });

  const itemValue = (field: string, fallback = ""): string => {
    const values = members.map((m) => {
      const edited = itemEdits[`${m.id}::${field}`];
      if (edited !== undefined) return edited;
      const loaded = (m as unknown as Record<string, unknown>)[field];
      return loaded == null ? fallback : String(loaded);
    });
    return commonValue(values) ?? "";
  };
  const itemMixed = (field: string): boolean => {
    if (!isBulk) return false;
    const values = members.map((m) => {
      const edited = itemEdits[`${m.id}::${field}`];
      if (edited !== undefined) return edited;
      const loaded = (m as unknown as Record<string, unknown>)[field];
      return loaded == null ? "" : String(loaded);
    });
    return commonValue(values) === null;
  };

  const setItem = (field: string, value: string) =>
    setItemEdits((prev) => {
      const next = { ...prev };
      // Same rule as the prices — see `loadedDisagrees`.
      const untouched = value === "" && loadedDisagrees(field);
      for (const member of members) {
        if (untouched) delete next[`${member.id}::${field}`];
        else next[`${member.id}::${field}`] = value;
      }
      return next;
    });

  /**
   * Prices and shipping side by side where the editor is wide enough, stacked
   * where it is not. `auto-fit` rather than a breakpoint: this panel sits in a
   * column whose width the merchant DRAGS, so a media query would answer the
   * wrong question.
   */
  const sectionGrid: CSSProperties = {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
    gap: "12px",
    // STRETCH, not start: side by side the two cards are read as a pair, and
    // one ending 40px above the other looks like a mistake rather than like
    // less content. Each card fills the row's height (`minHeight="100%"`
    // below), so the taller one sets it.
    alignItems: "stretch",
  };

  /**
   * Whether the scope is a PHYSICAL product.
   *
   * Off, nothing else in the shipping card applies: there is no weight to
   * declare and no customs to clear, so every input below is disabled rather
   * than left to be filled in with numbers Shopify will ignore. A mixed group
   * counts as physical — some of it is, and disabling the fields would take
   * the merchant's ability to fix the half that needs them.
   */
  const isPhysical =
    itemMixed("requiresShipping") ||
    itemValue("requiresShipping", String(first.requiresShipping ?? true)) === "true";

  /** "Mixed" as a placeholder, so an empty bulk field is not read as "empty". */
  const mixedHint = (mixed: boolean) =>
    mixed ? ((t.mixedValues as string) || "Different values") : undefined;

  /** The picker's entries, grouped the way they are meant to be read. */
  const singleOptions = scopes.filter((s) => s.kind === "variant").map((s) => ({ value: s.id, label: s.label }));
  const groupsByOption = new Map<string, Array<{ value: string; label: string }>>();
  for (const s of scopes) {
    if (s.kind !== "group" || !s.optionName) continue;
    const list = groupsByOption.get(s.optionName) ?? [];
    list.push({ value: s.id, label: s.label });
    groupsByOption.set(s.optionName, list);
  }
  const allScope = scopes.find((s) => s.kind === "all");

  return (
    <BlockStack gap="300">
      {/* Drawn HERE rather than by the card: this component returns null in
          four states, and a divider placed around it by the card would be a
          rule under empty space in every one of them. */}
      <Divider />
      {/* No heading here. "Bestand" over the whole block titled the prices and
          the shipping settings too; it sits over the locations table, which is
          the thing it names. */}
      {data.variantsTruncated && (
        <Text as="p" variant="bodySm" tone="subdued">
          {(t.variantsTruncated as string) || "This product has more variants than were loaded. Edit the rest in the Shopify admin."}
        </Text>
      )}

      {/* The picker and what it covers, side by side. The image is the point:
          "Weiss / 20cm" is a name, and the picture is the thing. */}
      <InlineStack gap="300" blockAlign="center" wrap={false}>
        {scope.images.length > 0 && (
          <InlineStack gap="100" blockAlign="center" wrap={false}>
            {scope.images.map((image) => (
              <Thumbnail
                key={image.url}
                source={image.url}
                alt={image.alt}
                // One variant gets one big picture; a group gets up to four
                // small ones, so the scope is visible rather than asserted.
                size={isBulk ? "small" : "medium"}
              />
            ))}
          </InlineStack>
        )}
        {scopes.length > 1 && (
          <div style={{ flex: 1, minWidth: 0 }}>
            <Select
              label={(t.variantSelectLabel as string) || "Variant"}
              options={[
                { title: (t.scopeSingle as string) || "One variant", options: singleOptions },
                ...[...groupsByOption.entries()].map(([optionName, options]) => ({
                  title: optionName,
                  options,
                })),
                ...(allScope ? [{ title: " ", options: [{ value: allScope.id, label: allScope.label }] }] : []),
              ]}
              value={scope.id}
              onChange={setScopeId}
              disabled={saving}
            />
          </div>
        )}
      </InlineStack>

      {/* No title: the picker above already says which variant or group this
          is, and repeating it put the same words twice on one screen. The ROW
          stays, at a fixed height, because the badge lives in it — without the
          reservation the whole panel jumped every time the merchant switched
          from one variant to a group. */}
      <div style={{ minHeight: "20px" }}>
        {isBulk && (
          <Badge tone="attention">
            {((t.scopeCount as string) || "{n} variants").replace("{n}", String(members.length))}
          </Badge>
        )}
      </div>

      {/* Prices and shipping are short enough to sit SIDE BY SIDE where the
          editor is wide, and stack where it is not. Inventory gets its own
          full-width card: it holds a table. */}
      <div style={sectionGrid}>
        <Box background="bg-surface-secondary" padding="300" borderRadius="200" minHeight="100%">
          <BlockStack gap="300">
                  {/* ── Prices ─────────────────────────────────────────
                      All three on ONE row, because the confusion they cause is
                      the difference BETWEEN them: the field that used to sit up
                      here alone was `cost`, what the merchant pays, and anyone
                      looking for "the price" read it. Side by side, each one
                      names itself against the other two.

                      The explanations moved into tooltips: three lines of prose
                      under three inputs is taller than the inputs themselves,
                      and it is text a merchant reads once. */}
                  <SectionHeading text={(t.pricesHeading as string) || "Prices"} helpKey="commercePrices" />
                  <InlineStack gap="300" blockAlign="start" wrap>
                    <MoneyField
                      label={(t.price as string) || "Price"}
                      help={(t.priceHint as string) || "What the customer pays."}
                      value={priceValue("price")}
                      placeholder={mixedHint(priceMixed("price"))}
                      onChange={(value) =>
                        setPrice("price", value)
                      }
                      disabled={saving}
                    />
                    <MoneyField
                      label={(t.compareAtPrice as string) || "Compare-at price"}
                      help={(t.compareAtPriceHint as string) || "The struck-through price. Empty = no sale."}
                      value={priceValue("compareAtPrice")}
                      placeholder={mixedHint(priceMixed("compareAtPrice"))}
                      onChange={(value) =>
                        setPrice("compareAtPrice", value)
                      }
                      disabled={saving}
                    />
                    {first.inventoryItemId && (
                      <MoneyField
                        label={(t.cost as string) || "Cost per item"}
                        help={(t.costHint as string) || "What you pay. Never shown to customers."}
                        value={itemValue("cost")}
                        placeholder={mixedHint(itemMixed("cost"))}
                        onChange={(value) => setItem("cost", value)}
                        disabled={saving}
                      />
                    )}
                  </InlineStack>

                  {/* Shopify puts this under the prices, and it belongs there:
                      it is a property of the PRICE, not of the item. A pill
                      rather than a bare checkbox — the row style this app uses
                      for a setting of this kind. */}
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <ToggleSwitch
                      checked={priceValue("taxable") === "true"}
                      indeterminate={priceMixed("taxable")}
                      ariaLabel={(t.taxableSwitch as string) || "Charge tax on this variant"}
                      onChange={(checked) => setPrice("taxable", String(checked))}
                      disabled={saving}
                    />
                    <Text as="p" variant="bodyMd">
                      {priceMixed("taxable")
                        ? (t.mixedValues as string) || "Different values"
                        : (t.taxableSwitch as string) || "Charge tax on this variant"}
                    </Text>
                  </InlineStack>
          </BlockStack>
        </Box>

        {/* The InventoryItem's own settings. Shown for EVERY variant, tracked
            or not: a weight and a customs code are facts about the item, not
            about whether Shopify counts it. */}
        <Box background="bg-surface-secondary" padding="300" borderRadius="200" minHeight="100%">
          <BlockStack gap="300">
                  {first.inventoryItemId ? (
                    <>
                    <InlineStack align="space-between" blockAlign="center" wrap={false}>
                      <SectionHeading
                        text={(t.shippingHeading as string) || "Shipping and customs"}
                        helpKey="commerceShipping"
                      />
                      {/* Shopify's "Physisches Produkt" switch, in the same
                          corner. It IS `requiresShipping`; a digital product
                          turns it off and the whole customs block below stops
                          applying. */}
                      <InlineStack gap="200" blockAlign="center" wrap={false}>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {(t.requiresShipping as string) || "Physical product"}
                        </Text>
                        <ToggleSwitch
                          checked={itemValue("requiresShipping", String(first.requiresShipping ?? true)) === "true"}
                          indeterminate={itemMixed("requiresShipping")}
                          ariaLabel={(t.requiresShipping as string) || "Physical product"}
                          onChange={(checked) => setItem("requiresShipping", String(checked))}
                          disabled={saving}
                        />
                      </InlineStack>
                    </InlineStack>
                    {/* Weight and its unit are a number and a word — sized
                        for that, not for the column they used to fill. */}
                    <InlineStack gap="200" blockAlign="start" wrap={false}>
                      <Box minWidth="96px" maxWidth="110px">
                        <TextField
                          label={(t.weight as string) || "Weight"}
                          value={itemValue("weight")}
                          placeholder={mixedHint(itemMixed("weight"))}
                          onChange={(value) => setItem("weight", value)}
                          autoComplete="off"
                          inputMode="decimal"
                          align="right"
                          disabled={saving || !isPhysical}
                        />
                      </Box>
                      <Box minWidth="104px" maxWidth="124px">
                        <Select
                          label={(t.weightUnit as string) || "Unit"}
                          // `GRAMS` is not a unit anybody writes on a label.
                          // Same enum vocabulary the editor's attribute fields
                          // read, passed in with the rest of this panel's text.
                          options={[
                            // A mixed group gets a placeholder entry rather
                            // than one member's unit standing for the group.
                            ...(itemMixed("weightUnit")
                              ? [{ value: "", label: (t.mixedValues as string) || "Different values" }]
                              : []),
                            ...WEIGHT_UNITS.map((unit) => ({
                              value: unit,
                              label: (t.enumLabels as Record<string, string> | undefined)?.[`weightUnit.${unit}`] ?? unit,
                            })),
                          ]}
                          value={itemMixed("weightUnit") ? "" : (itemValue("weightUnit") || "KILOGRAMS")}
                          onChange={(value) => setItem("weightUnit", value)}
                          disabled={saving || !isPhysical}
                        />
                      </Box>
                    </InlineStack>

                    {/* Customs, folded away. Shopify folds them for the same
                        reason: an HS code and a country of origin matter to
                        the merchants who ship across a border and to nobody
                        else, and unfolded they doubled the height of a card
                        that otherwise holds two small fields. */}
                    <Button
                      variant="plain"
                      disclosure={customsOpen ? "up" : "down"}
                      onClick={() => setCustomsOpen((open) => !open)}
                      disabled={!isPhysical}
                    >
                      {(t.customsDetails as string) || "More details"}
                    </Button>
                    <Collapsible open={customsOpen && isPhysical} id="commerce-customs">
                      <BlockStack gap="300">
                        <TextField
                          label={(t.countryOfOrigin as string) || "Country of origin"}
                          value={itemValue("countryCodeOfOrigin")}
                          placeholder={mixedHint(itemMixed("countryCodeOfOrigin"))}
                          onChange={(value) => setItem("countryCodeOfOrigin", value)}
                          autoComplete="off"
                          maxLength={2}
                          disabled={saving || !isPhysical}
                        />
                        <TextField
                          label={(t.hsCode as string) || "HS code"}
                          value={itemValue("harmonizedSystemCode")}
                          placeholder={mixedHint(itemMixed("harmonizedSystemCode"))}
                          onChange={(value) => setItem("harmonizedSystemCode", value)}
                          autoComplete="off"
                          disabled={saving || !isPhysical}
                        />
                      </BlockStack>
                    </Collapsible>
                    </>
                  ) : null}
          </BlockStack>
        </Box>
      </div>

      {/* Inventory keeps a card of its OWN and the full width: it holds a
          table, and squeezing that beside the prices would put four numeric
          columns into half a screen. */}
      <Box background="bg-surface-secondary" padding="300" borderRadius="200">
        <BlockStack gap="300">
                  {/* ── Inventory switches ──────────────────────────────────
                      Pill toggles rather than checkboxes: the row style this
                      app uses for every setting of this kind. Both are
                      per-variant facts, so they follow the same bulk rule as
                      the fields above — on a group they show what the members
                      AGREE on and say so when they do not. */}
                  <SectionHeading
                    text={(t.inventoryHeading as string) || "Inventory"}
                    helpKey="commerceStock"
                  />
                  <BlockStack gap="200">
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <ToggleSwitch
                        // A mixed group is NOT off: a switch's position is the
                        // claim a merchant reads, and off over a half-tracked
                        // group asserts something untrue about half of it.
                        checked={itemValue("inventoryTracked", "true") === "true"}
                        indeterminate={itemMixed("inventoryTracked")}
                        ariaLabel={(t.trackedLabel as string) || "Track quantity"}
                        onChange={(checked) => setItem("inventoryTracked", String(checked))}
                        disabled={saving || !first.inventoryItemId}
                      />
                      <BlockStack gap="050">
                        <Text as="p" variant="bodyMd">
                          {(t.trackedLabel as string) || "Track quantity"}
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          {itemMixed("inventoryTracked")
                            ? ((t.mixedValues as string) || "Different values")
                            : ((t.trackedHint as string) ||
                              "Shopify keeps a count and lowers it with every order. Off, there is no count at all and the variant can always be bought.")}
                        </Text>
                      </BlockStack>
                    </InlineStack>

                    {/* Only while the item is TRACKED: untracked there is no
                        zero for the policy to apply to, and a switch that
                        decides nothing invites the merchant to think it
                        does. */}
                    {(itemValue("inventoryTracked", "true") === "true" || itemMixed("inventoryTracked")) && (
                      <InlineStack gap="300" blockAlign="center" wrap={false}>
                        <ToggleSwitch
                          checked={priceValue("inventoryPolicy") === "CONTINUE"}
                          indeterminate={priceMixed("inventoryPolicy")}
                          ariaLabel={(t.continueSellingLabel as string) || "Continue selling when out of stock"}
                          onChange={(checked) => setPrice("inventoryPolicy", checked ? "CONTINUE" : "DENY")}
                          disabled={saving}
                        />
                        <BlockStack gap="050">
                          <Text as="p" variant="bodyMd">
                            {(t.continueSellingLabel as string) || "Continue selling when out of stock"}
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {priceMixed("inventoryPolicy")
                              ? ((t.mixedValues as string) || "Different values")
                              : ((t.continueSellingHint as string) ||
                                "Customers can order it at zero stock. Off, Shopify shows it as sold out.")}
                          </Text>
                        </BlockStack>
                      </InlineStack>
                    )}
                  </BlockStack>

          {/* Stock, for ONE variant only -- see the header. */}
          {isBulk ? (
            <Text as="p" variant="bodySm" tone="subdued">
              {(t.stockNotBulk as string) ||
                "Stock is a count per variant and per location, so it is edited one variant at a time."}
            </Text>
          ) : (
            <>
                  {first.inventoryTracked === null && !itemMixed("inventoryTracked") && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {(t.stockUnknown as string) || "Not loaded yet — reload to see this variant's stock."}
                    </Text>
                  )}

                  {itemValue("inventoryTracked", "true") === "false" && (
                    // NOT zero. Shopify keeps no count for this variant, and a
                    // 0 here would read as "sold out".
                    <Text as="p" variant="bodySm" tone="subdued">
                      {(t.stockUntracked as string) || "Stock is not tracked for this variant — it can be sold without limit."}
                    </Text>
                  )}

                  {first.inventoryTracked === true && !first.inventoryItemId && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {(t.stockNoItem as string) || "This variant has no inventory record, so its stock cannot be edited here."}
                    </Text>
                  )}

                  {/* The EDITED flag, not the loaded one: the switch above
                      turns tracking off, and a table that stays behind still
                      offers numbers for an item Shopify will stop counting —
                      numbers the save would write first and the untrack would
                      then discard. */}
                  {itemValue("inventoryTracked", "true") === "true" && first.inventoryItemId && (
                    <BlockStack gap="200">
                      {/* The heading belongs HERE, over the locations it
                          describes — above the variant it read as a title for
                          the prices and the shipping settings too. */}
                      <InlineStack gap="200" blockAlign="center">
                        <Text as="h4" variant="headingSm" fontWeight="bold">{(t.stockHeading as string) || "Stock"}</Text>
                        <HelpTooltip helpKey="commerceStock" />
                      </InlineStack>

                      {first.levelsTruncated && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {(t.levelsTruncated as string) || "This variant has stock at more locations than were loaded."}
                        </Text>
                      )}
                      {first.levels.length === 0 && data.shopLocations.length === 0 && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {(t.noLevels as string) || "No location holds stock of this variant."}
                        </Text>
                      )}

                      {/* Shopify's own arrangement: one row per location, the
                          four numbers as columns, and a total. A stacked list
                          of "Berlin — [20] available: 20" made the merchant
                          add up their own warehouses. */}
                      <StockTable
                        rows={[
                          ...first.levels.map((level) => ({
                            key: `${first.id}::${level.locationId}`,
                            name: level.locationName || level.locationId,
                            active: level.locationActive,
                            stocked: true,
                            unavailable: level.unavailable,
                            committed: level.committed,
                            available: level.available,
                            onHand: level.onHand,
                          })),
                          /* Locations the item is not stocked at. Shopify
                             reports a level only where an item has been
                             ACTIVATED, so these are absent from `levels` — and
                             a merchant with three warehouses seeing one row
                             reasonably concludes the panel is broken.

                             They get the SAME input as the others rather than
                             an "activate" button: typing a number is what a
                             merchant means by "stock it here", and the
                             activation rides along with the save.

                             Suppressed entirely when the level window was cut
                             off: locations 11+ of a variant stocked at more
                             than `INVENTORY_LEVEL_PAGE_SIZE` places are
                             missing from `levels` while present in
                             `shopLocations`, and would be offered an input
                             that routes into activation — writing a quantity
                             over a real one with no compare-and-swap. */
                          ...(first.levelsTruncated ? [] : data.shopLocations)
                            .filter((location) => !first.levels.some((l) => l.locationId === location.id))
                            .map((location) => ({
                              key: `${first.id}::${location.id}`,
                              name: location.name,
                              active: location.isActive && !!first.inventoryItemId,
                              stocked: false,
                              unavailable: null,
                              committed: null,
                              available: null,
                              onHand: null,
                            })),
                        ]}
                        edits={edits}
                        onEdit={(key: string, value: string) => setEdits((prev) => ({ ...prev, [key]: value }))}
                        disabled={saving}
                        truncated={first.levelsTruncated}
                        t={t}
                      />
                    </BlockStack>
                  )}

            </>
          )}

          {/* The variant's own references, UNDER the table. No heading: two
              labelled fields do not need a word above them saying that more
              detail follows. */}
          <InlineStack gap="300" blockAlign="start" wrap>
            <Box minWidth="220px">
              <TextField
                label={(t.skuLabel as string) || "SKU (Stock Keeping Unit)"}
                value={itemValue("sku")}
                placeholder={mixedHint(itemMixed("sku"))}
                onChange={(value) => setItem("sku", value)}
                autoComplete="off"
                disabled={saving || !first.inventoryItemId}
              />
            </Box>
            <Box minWidth="220px">
              <TextField
                label={(t.barcodeLabel as string) || "Barcode (ISBN, UPC, GTIN, etc.)"}
                value={priceValue("barcode")}
                placeholder={mixedHint(priceMixed("barcode"))}
                onChange={(value) => setPrice("barcode", value)}
                autoComplete="off"
                disabled={saving}
              />
            </Box>
          </InlineStack>
        </BlockStack>
      </Box>
    </BlockStack>
  );
}

interface StockRow {
  key: string;
  name: string;
  active: boolean;
  /** False for a location the item is not activated at — see the caller. */
  stocked: boolean;
  unavailable: number | null;
  committed: number | null;
  available: number | null;
  onHand: number | null;
}

/**
 * The locations table, in the shape Shopify's own product page uses.
 *
 * Four numbers per location and a total. Only ON HAND is editable: `available`
 * is derived (on hand minus open commitments) and writing it would contradict
 * them, `committed` belongs to orders, and `unavailable` is what is left over.
 *
 * A missing number is an em dash, never a zero. `tracked: false` and "never
 * synced" both arrive here as `null`, and 0 would tell a merchant they are
 * sold out of something they can sell without limit.
 */
function StockTable({
  rows,
  edits,
  onEdit,
  disabled,
  truncated,
  t,
}: {
  rows: StockRow[];
  /** The location window was cut off — see the total row. */
  truncated: boolean;
  edits: Record<string, string>;
  onEdit: (key: string, value: string) => void;
  disabled: boolean;
  t: Record<string, unknown>;
}) {
  // Roomier than the first cut, and the LAST column gets its own right-hand
  // padding: the "on hand" input sat flush against the table's border.
  const cell: CSSProperties = {
    padding: "10px 14px",
    textAlign: "right",
    borderTop: "1px solid var(--p-color-border-secondary)",
    whiteSpace: "nowrap",
  };
  const lastCell: CSSProperties = { ...cell, paddingRight: "20px" };
  const firstCell: CSSProperties = { ...cell, textAlign: "left", paddingLeft: "20px" };
  const headCell: CSSProperties = { ...cell, borderTop: "none" };
  const headFirst: CSSProperties = { ...firstCell, borderTop: "none" };
  const headLast: CSSProperties = { ...lastCell, borderTop: "none" };
  const num = (value: number | null) => (value == null ? "—" : String(value));

  /**
   * ALL or nothing. A total is only a total when every row contributed to it.
   *
   * Summing the known rows and skipping the unknown ones produced a smaller
   * number under the word "Total" — and worse, a different number of rows per
   * column, so "Available" could describe two locations while "On hand"
   * described three. A row that is not stocked contributes 0, which is a known
   * quantity; a row whose number could not be READ makes the total unknown.
   */
  const total = (pick: (row: StockRow) => number | null) => {
    const values = rows.map((row) => (row.stocked ? pick(row) : 0));
    return values.some((v) => v == null) ? null : values.reduce((a, b) => (a as number) + (b as number), 0);
  };
  /** The on-hand total counts what is TYPED, so the figure moves with the edit. */
  const onHandTotal = (() => {
    const values = rows.map((row) => {
      const edited = edits[row.key];
      if (edited !== undefined && edited.trim() !== "") {
        const parsed = Number.parseInt(edited, 10);
        // A value that does not parse makes the total UNKNOWN rather than
        // dropping that location out of it — the sum would otherwise fall
        // while the merchant typed.
        return Number.isFinite(parsed) ? parsed : null;
      }
      return row.stocked ? row.onHand : 0;
    });
    return values.some((v) => v == null) ? null : values.reduce((a, b) => (a as number) + (b as number), 0);
  })();

  return (
    <Box
      borderColor="border"
      borderWidth="025"
      borderRadius="200"
      overflowX="scroll"
      // Air around the table as well as inside it: pressed against the box's
      // own edge it read as part of the border.
      paddingBlock="200"
    >
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={headFirst}>
              <Text as="span" variant="bodySm" tone="subdued">
                {(t.locationsColumn as string) || "Locations"}
              </Text>
            </th>
            {[
              (t.unavailableColumn as string) || "Unavailable",
              (t.committedColumn as string) || "Committed",
              (t.availableColumn as string) || "Available",
              (t.onHandColumn as string) || "On hand",
            ].map((label, index, all) => (
              <th key={label} style={index === all.length - 1 ? headLast : headCell}>
                <Text as="span" variant="bodySm" tone="subdued">{label}</Text>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td style={firstCell}>
                <Text as="span" variant="bodySm" tone={row.active ? undefined : "subdued"}>
                  {row.name}
                  {/* Deactivated locations keep their stock but take no
                      writes. Greyed, never hidden — a location that vanishes
                      reads as stock that disappeared. */}
                  {!row.active ? ` (${(t.locationInactive as string) || "inactive"})` : ""}
                </Text>
                {/* A location the item is not ACTIVATED at says so. In a table
                    of dashes it would otherwise be indistinguishable from a
                    location whose numbers merely could not be read — and the
                    difference is what the whole row is here to show. */}
                {!row.stocked && (
                  <Text as="span" variant="bodySm" tone="subdued">
                    {" "}
                    {(t.notStockedHere as string) || "not stocked here"}
                  </Text>
                )}
              </td>
              <td style={cell}><Text as="span" variant="bodySm">{num(row.unavailable)}</Text></td>
              <td style={cell}><Text as="span" variant="bodySm">{num(row.committed)}</Text></td>
              <td style={cell}><Text as="span" variant="bodySm">{num(row.available)}</Text></td>
              <td style={lastCell}>
                <Box minWidth="86px" maxWidth="86px">
                  <TextField
                    label={(t.onHandColumn as string) || "On hand"}
                    labelHidden
                    type="number"
                    inputMode="numeric"
                    align="right"
                    // Empty, not "0", for a location the variant is not
                    // stocked at: a pre-filled 0 would read as "we hold none"
                    // rather than "we do not stock this here".
                    value={edits[row.key] ?? (row.stocked ? String(row.onHand ?? "") : "")}
                    placeholder={row.stocked ? undefined : "–"}
                    onChange={(value) => onEdit(row.key, value)}
                    autoComplete="off"
                    disabled={disabled || !row.active}
                  />
                </Box>
              </td>
            </tr>
          ))}
          {/* No total row when the location window was cut off: the rows are
              the first ten of more, and their sum under the word "Total" is a
              number the merchant would decide against. */}
          {rows.length > 1 && !truncated && (
            <tr>
              <td style={firstCell}>
                <Text as="span" variant="bodySm" fontWeight="semibold">
                  {(t.totalRow as string) || "Total"}
                </Text>
              </td>
              <td style={cell}><Text as="span" variant="bodySm" fontWeight="semibold">{num(total((r) => r.unavailable))}</Text></td>
              <td style={cell}><Text as="span" variant="bodySm" fontWeight="semibold">{num(total((r) => r.committed))}</Text></td>
              <td style={cell}><Text as="span" variant="bodySm" fontWeight="semibold">{num(total((r) => r.available))}</Text></td>
              <td style={lastCell}><Text as="span" variant="bodySm" fontWeight="semibold">{num(onHandTotal)}</Text></td>
            </tr>
          )}
        </tbody>
      </table>
    </Box>
  );
}

/** A small group heading with the app's usual "?" beside it. Three inputs in a
 *  row need a word saying what the row IS; a bare row of labels does not. */
function SectionHeading({ text, helpKey }: { text: string; helpKey: string }) {
  return (
    // Bolder and a size up: at headingXs these read as captions, and the
    // sections they name are the only thing telling three rows of inputs
    // apart.
    <InlineStack gap="100" blockAlign="center">
      <Text as="h4" variant="headingSm" fontWeight="bold">{text}</Text>
      <HelpTooltip helpKey={helpKey} />
    </InlineStack>
  );
}

/**
 * A money input sized for money, with its explanation on hover.
 *
 * The explanation used to be `helpText` under the field. Under three fields in
 * a row that is three lines of prose taller than the inputs themselves — and it
 * is text a merchant reads once and then never again.
 */
function MoneyField({
  label,
  help,
  value,
  onChange,
  disabled,
  placeholder,
}: {
  label: string;
  help: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Set on a BULK field whose members disagree — an empty box would
   *  otherwise read as "they are all empty". */
  placeholder?: string;
}) {
  return (
    <Box minWidth="130px" maxWidth="150px">
      <Tooltip content={help} preferredPosition="above">
        {/* The tooltip wraps the whole control, label included: hovering the
            LABEL is what a merchant does when they are unsure what a field
            means. */}
        <div>
          <TextField
            label={label}
            value={value}
            onChange={onChange}
            autoComplete="off"
            inputMode="decimal"
            align="right"
            disabled={disabled}
            placeholder={placeholder}
          />
        </div>
      </Tooltip>
    </Box>
  );
}