// Copies the compiled backend (dist/) into each Catalyst function folder before `catalyst deploy`,
// and installs each function's own dependencies (catalyst deploy uploads its node_modules as is).
import { execSync } from "child_process";
import { cpSync, existsSync, rmSync } from "fs";
import { join } from "path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "dist");
if (!existsSync(dist)) throw new Error("Run `npm run build` first.");
for (const fn of ["fos_api", "fos_webhooks", "fos_jobs"]) {
  const target = join(root, "catalyst", "functions", fn, "dist");
  rmSync(target, { recursive: true, force: true });
  cpSync(dist, target, { recursive: true, filter: (src) => !src.includes(`${join("dist", "tests")}`) });
  execSync("npm install --omit=dev --no-audit --no-fund --loglevel=error", { cwd: join(root, "catalyst", "functions", fn), stdio: "inherit" });
  console.log(`packaged ${fn}`);
}
