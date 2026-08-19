/**
 * The production image copies root runtime modules BY NAME
 * ([Dockerfile](../../Dockerfile)), so a module imported by one of them and
 * forgotten there throws `ERR_MODULE_NOT_FOUND` at boot — inside server.js's
 * try/catch, which means the app still serves requests while a whole background
 * service is silently gone. Shipping `orphan-run-recovery.js` without adding it
 * to that line would have disabled task recovery AND the stuck-task monitor for
 * every task type, leaving one log line behind.
 *
 * This walks the import graph of the copied modules instead of asserting a
 * hard-coded list: the next root module gets the same guard for free.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");

function dockerfileCopies(): { files: string[]; dirs: string[] } {
  const dockerfile = readFileSync(path.join(ROOT, "Dockerfile"), "utf8");
  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const line of dockerfile.split("\n")) {
    if (!/^\s*COPY\b/.test(line) || line.includes("--from=builder")) continue;
    for (const token of line.split(/\s+/)) {
      if (token.endsWith(".js")) files.add(token);
      // `COPY app/config ./app/config/` brings a whole tree — the destination
      // token is skipped because it starts with "./".
      else if (!token.startsWith("./") && !token.startsWith("--") && /^[\w.-]+(\/[\w.-]+)*\/?$/.test(token) && token !== "COPY" && existsSync(path.join(ROOT, token)) && !token.endsWith(".json")) {
        dirs.add(token.replace(/\/$/, ""));
      }
    }
  }
  return { files: Array.from(files), dirs: Array.from(dirs) };
}

function copiedRootModules(): string[] {
  return dockerfileCopies().files;
}

/** Static `import … from "./x.js"` specifiers, which is all the runtime modules
 *  use, resolved against the importing file's own directory. */
function relativeJsImports(file: string, fromDir: string): string[] {
  const src = readFileSync(path.join(ROOT, file), "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/from\s+["'](\.\.?\/[^"']+\.js)["']/g)) {
    out.push(path.normalize(path.join(fromDir, m[1])).replace(/\\/g, "/"));
  }
  return out;
}

describe("Dockerfile runtime modules", () => {
  it("copies every root module the copied ones import, transitively", () => {
    const { files, dirs } = dockerfileCopies();
    expect(files.length).toBeGreaterThan(3); // the line exists and was parsed

    // A dep is shipped if it is copied by name or lives under a copied tree
    // (`app/config`, `app/utils`, …).
    const shipped = (dep: string) =>
      files.includes(dep) || dirs.some((d) => dep === d || dep.startsWith(`${d}/`));

    const missing: string[] = [];
    const seen = new Set<string>();
    const queue = [...files];
    while (queue.length > 0) {
      const file = queue.shift()!;
      if (seen.has(file) || !existsSync(path.join(ROOT, file))) continue;
      seen.add(file);
      for (const dep of relativeJsImports(file, path.dirname(file))) {
        if (!shipped(dep)) missing.push(`${file} imports ${dep}`);
        queue.push(dep);
      }
    }

    expect(missing).toEqual([]);
  });

  it("ships the orphan-run recovery the stuck-task reaper imports", () => {
    // Named explicitly because its absence is invisible at runtime: the app boots
    // fine and only the background services are gone.
    expect(copiedRootModules()).toContain("orphan-run-recovery.js");
  });
});
