/**
 * Guards for "Alle Daten löschen" on /admin.
 *
 * A shop that is still installed (not marked uninstalled AND an offline session
 * with a token exists) is refused unless the operator ticks "trotzdem löschen":
 * deleting a live shop's data is almost never what is meant.
 */
import { db } from "~/db.server";

export async function isShopInstalled(shop: string): Promise<boolean> {
  const [state, withToken] = await Promise.all([
    db.shopInstallState.findUnique({ where: { shop }, select: { uninstalledAt: true } }),
    db.session.count({ where: { shop, isOnline: false, accessToken: { not: "" } } }),
  ]);
  return !state?.uninstalledAt && withToken > 0;
}

export const INSTALLED_REFUSAL_TEXT =
  'Der Shop ist noch installiert (aktive Sitzung mit Token). Zum Löschen "trotzdem löschen" einschalten.';

/** Form field value of the ToggleSwitch-backed hidden input. */
export function isForceTicked(value: FormDataEntryValue | null): boolean {
  return value === "on" || value === "true" || value === "1";
}
