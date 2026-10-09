// Deploys Catalyst functions without wiping their environment variables.
// `catalyst deploy` replaces a function's env vars with catalyst-config.json's env_variables, so this
// fills them from catalyst/env.local.json (gitignored, never committed) for the deploy only and
// restores the committed config afterwards.
//
// catalyst/env.local.json: { "fos_api": { "ZOHO_CLIENT_ID": "..." }, "fos_webhooks": { ... } }
// Usage: node scripts/deployFunctions.mjs [fos_api fos_webhooks]
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const root = new URL("..", import.meta.url).pathname;
const catalystDir = join(root, "catalyst");
const envFile = join(catalystDir, "env.local.json");
const fns = process.argv.slice(2).length ? process.argv.slice(2) : ["fos_api", "fos_webhooks"];

if (!existsSync(envFile)) throw new Error(`Missing ${envFile}. Create it from env.example.json before deploying.`);
const env = JSON.parse(readFileSync(envFile, "utf8"));

const originals = new Map();
try {
  for (const fn of fns) {
    if (!env[fn] || !Object.keys(env[fn]).length) throw new Error(`env.local.json has no variables for ${fn}; deploying would wipe them.`);
    const configPath = join(catalystDir, "functions", fn, "catalyst-config.json");
    const original = readFileSync(configPath, "utf8");
    originals.set(configPath, original);
    const config = JSON.parse(original);
    config.deployment.env_variables = env[fn];
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  }
  execFileSync("catalyst", ["deploy", "--only", fns.map((f) => `functions:${f}`).join(",")], { cwd: catalystDir, stdio: "inherit" });
} finally {
  for (const [path, content] of originals) writeFileSync(path, content);
}
