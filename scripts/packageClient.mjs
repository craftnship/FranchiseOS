// Builds the web app (client/) and copies it into catalyst/client for Catalyst Web Client Hosting.
// The app is served at /app/, so client/vite.config.ts builds with base "/app/".
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const root = new URL("..", import.meta.url).pathname;
const dist = join(root, "client", "dist");
if (!existsSync(join(dist, "index.html"))) throw new Error("Run `npm run build --prefix client` first.");
const target = join(root, "catalyst", "client");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });
writeFileSync(join(target, "client-package.json"), JSON.stringify({ name: "app", version: "0.1.0", homepage: "index.html", login_redirect: "index.html" }, null, 2) + "\n");
console.log("packaged client into catalyst/client");
