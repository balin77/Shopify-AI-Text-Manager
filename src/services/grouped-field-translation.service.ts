import type { PrismaClient } from "@prisma/client";
import { normalizeGroupedValue } from "../../app/utils/grouped-field.utils";

export type GroupedFieldSource = "ai" | "user" | "imported";

export interface LookupArgs {
  shop: string;
  fieldKey: string;
  sourceLocale: string;
  sourceValue: string;
  targetLocales: string[];
}

export interface LookupResult {
  hits: Record<string, string>;
  misses: string[];
  sourceValueNorm: string;
}

export interface UpsertManyArgs {
  shop: string;
  fieldKey: string;
  sourceLocale: string;
  sourceValue: string;
  entries: Record<string, string>;
  source: GroupedFieldSource;
}

export class GroupedFieldTranslationService {
  constructor(private db: PrismaClient) {}

  async lookup(args: LookupArgs): Promise<LookupResult> {
    const sourceValueNorm = normalizeGroupedValue(args.sourceValue);
    const rows = await this.db.groupedFieldTranslation.findMany({
      where: {
        shop: args.shop,
        fieldKey: args.fieldKey,
        sourceLocale: args.sourceLocale,
        sourceValueNorm,
        targetLocale: { in: args.targetLocales },
      },
      select: { targetLocale: true, translatedValue: true },
    });

    const hits: Record<string, string> = {};
    for (const row of rows) {
      hits[row.targetLocale] = row.translatedValue;
    }
    const misses = args.targetLocales.filter((loc) => !(loc in hits));
    return { hits, misses, sourceValueNorm };
  }

  async upsertMany(args: UpsertManyArgs): Promise<void> {
    const sourceValueNorm = normalizeGroupedValue(args.sourceValue);
    const entries = Object.entries(args.entries).filter(([, v]) => v && v.length > 0);
    if (entries.length === 0) return;

    await this.db.$transaction(
      entries.map(([targetLocale, translatedValue]) =>
        this.db.groupedFieldTranslation.upsert({
          where: {
            shop_fieldKey_sourceLocale_sourceValueNorm_targetLocale: {
              shop: args.shop,
              fieldKey: args.fieldKey,
              sourceLocale: args.sourceLocale,
              sourceValueNorm,
              targetLocale,
            },
          },
          create: {
            shop: args.shop,
            fieldKey: args.fieldKey,
            sourceLocale: args.sourceLocale,
            sourceValueNorm,
            sourceValue: args.sourceValue,
            targetLocale,
            translatedValue,
            source: args.source,
          },
          update: {
            translatedValue,
            source: args.source,
          },
        }),
      ),
    );
  }

  async listForShop(args: { shop: string; fieldKey?: string; sourceLocale?: string }) {
    return this.db.groupedFieldTranslation.findMany({
      where: {
        shop: args.shop,
        ...(args.fieldKey ? { fieldKey: args.fieldKey } : {}),
        ...(args.sourceLocale ? { sourceLocale: args.sourceLocale } : {}),
      },
      orderBy: [{ fieldKey: "asc" }, { sourceValue: "asc" }, { targetLocale: "asc" }],
    });
  }

  async deleteEntry(args: { shop: string; id: string }): Promise<void> {
    await this.db.groupedFieldTranslation.deleteMany({
      where: { id: args.id, shop: args.shop },
    });
  }

  async deleteGroup(args: {
    shop: string;
    fieldKey: string;
    sourceLocale: string;
    sourceValueNorm: string;
  }): Promise<void> {
    await this.db.groupedFieldTranslation.deleteMany({
      where: {
        shop: args.shop,
        fieldKey: args.fieldKey,
        sourceLocale: args.sourceLocale,
        sourceValueNorm: args.sourceValueNorm,
      },
    });
  }

  async findProductsUsingSourceValue(args: {
    shop: string;
    sourceValueNorm: string;
  }): Promise<Array<{ id: string; productType: string | null }>> {
    const candidates = await this.db.product.findMany({
      where: {
        shop: args.shop,
        productType: { not: null },
      },
      select: { id: true, productType: true },
    });
    return candidates.filter(
      (p) => p.productType && normalizeGroupedValue(p.productType) === args.sourceValueNorm,
    );
  }
}
