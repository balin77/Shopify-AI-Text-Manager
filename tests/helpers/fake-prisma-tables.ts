/**
 * Tiny in-memory stand-ins for Prisma delegates, interpreting exactly the
 * `where` / `orderBy` / `take` / `{ increment }` shapes the offline-token code
 * uses (equality, not, in, notIn, lt, gt, startsWith, null, AND, OR). The tests
 * then exercise the REAL query construction instead of a hand-picked return.
 */

type Row = Record<string, any>;

function cmp(value: any, cond: any): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date || typeof cond !== "object") {
    return value instanceof Date && cond instanceof Date ? value.getTime() === cond.getTime() : value === cond;
  }
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case "not":
        if (arg === null ? value === null || value === undefined : value === arg) return false;
        break;
      case "in":
        if (!(arg as any[]).includes(value)) return false;
        break;
      case "notIn":
        if ((arg as any[]).includes(value)) return false;
        break;
      case "lt":
        if (value === null || value === undefined || !(value < (arg as any))) return false;
        break;
      case "gt":
        if (value === null || value === undefined || !(value > (arg as any))) return false;
        break;
      case "gte":
        if (value === null || value === undefined || !(value >= (arg as any))) return false;
        break;
      case "startsWith":
        if (typeof value !== "string" || !value.startsWith(arg as string)) return false;
        break;
      default:
        throw new Error(`fake prisma: unsupported operator ${op}`);
    }
  }
  return true;
}

export function matches(row: Row, where: Row = {}): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "AND") {
      if (!(cond as Row[]).every((w) => matches(row, w))) return false;
    } else if (key === "NOT") {
      if (matches(row, cond as Row)) return false;
    } else if (key === "OR") {
      if (!(cond as Row[]).some((w) => matches(row, w))) return false;
    } else if (!cmp(row[key], cond)) return false;
  }
  return true;
}

function sorted(rows: Row[], orderBy?: Row | Row[]): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).map((o) => Object.entries(o)[0]);
  return [...rows].sort((a, b) => {
    for (const [key, dir] of keys) {
      const direction = typeof dir === "string" ? dir : (dir as any).sort;
      const nullsFirst = typeof dir === "object" && (dir as any).nulls === "first";
      const sign = direction === "desc" ? -1 : 1;
      const av = a[key] ?? null;
      const bv = b[key] ?? null;
      let c = 0;
      if (av === null && bv === null) c = 0;
      else if (av === null) c = nullsFirst ? -1 : 1;
      else if (bv === null) c = nullsFirst ? 1 : -1;
      else c = (av < bv ? -1 : av > bv ? 1 : 0) * sign;
      if (c !== 0) return c;
    }
    return 0;
  });
}

export function fakeDelegate(table: Row[], defaults: () => Row = () => ({})) {
  const apply = (row: Row, data: Row) => {
    // @updatedAt: every write stamps the row (the tests use fake timers).
    if ("updatedAt" in row || "startedAt" in row) row.updatedAt = new Date();
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && !(v instanceof Date) && "increment" in v) row[k] = (row[k] ?? 0) + (v as any).increment;
      else row[k] = v;
    }
  };
  return {
    findMany: async ({ where, orderBy, take, select }: Row = {}) => {
      let rows = sorted(table.filter((r) => matches(r, where)), orderBy);
      if (take !== undefined) rows = rows.slice(0, take);
      return rows.map((r) =>
        select ? Object.fromEntries(Object.keys(select).map((k) => [k, r[k]])) : { ...r },
      );
    },
    findUnique: async ({ where }: Row) => {
      const row = table.find((r) => matches(r, where));
      return row ? { ...row } : null;
    },
    upsert: async ({ where, create, update }: Row) => {
      const row = table.find((r) => matches(r, where));
      if (row) {
        apply(row, update);
        return { ...row };
      }
      const fresh = { ...defaults(), ...create };
      if ("startedAt" in fresh && !("updatedAt" in fresh)) fresh.updatedAt = new Date();
      table.push(fresh);
      return { ...fresh };
    },
    update: async ({ where, data }: Row) => {
      const row = table.find((r) => matches(r, where));
      if (!row) throw new Error("fake prisma: record not found");
      apply(row, data);
      return { ...row };
    },
    updateMany: async ({ where, data }: Row) => {
      const hit = table.filter((r) => matches(r, where));
      hit.forEach((r) => apply(r, data));
      return { count: hit.length };
    },
    deleteMany: async ({ where }: Row = {}) => {
      const keep = table.filter((r) => !matches(r, where));
      const count = table.length - keep.length;
      table.splice(0, table.length, ...keep);
      return { count };
    },
  };
}

export function migrationDefaults(): Row {
  const now = new Date();
  return {
    encryptedOldToken: null,
    status: "pending",
    attempts: 0,
    lastError: null,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
  };
}
