// Copies the compiled backend (dist/) into each Catalyst function folder before `catalyst deploy`.
import { cpSync, existsSync, rmSync } from "fs";
import { join } from "path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
if (!existsSync(dist)) throw new Error("Run `npm run build` first.");
for (const fn of ["fos_api", "fos_webhooks"]) {
  const target = join(root, "catalyst", "functions", fn, "dist");
  rmSync(target, { recursive: true, force: true });
  cpSync(dist, target, { recursive: true, filter: (src) => !src.includes(`${join("dist", "tests")}`) });
  console.log(`packaged ${fn}`);
}
