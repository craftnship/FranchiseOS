"use strict";
// Generated function shell: the compiled TypeScript is copied into ./dist by `npm run package:functions`.
const catalyst = require("zcatalyst-sdk-node");
const { handleWebhookRequest } = require("./dist/functions/webhooks/catalystEntry");

module.exports = (req, res) => {
  handleWebhookRequest(req, res, catalyst).catch((err) => {
    console.error(JSON.stringify({ level: "error", message: "fos_webhooks.crash", error: String(err && err.stack || err) }));
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } }));
  });
};
