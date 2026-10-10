"use strict";
// Generated function shell: the compiled TypeScript is copied into ./dist by `npm run package:functions`.
const catalyst = require("zcatalyst-sdk-node");
const { runCron } = require("./dist/functions/jobs/catalystEntry");

module.exports = (cronDetails, context) => {
  runCron(context, catalyst);
};
