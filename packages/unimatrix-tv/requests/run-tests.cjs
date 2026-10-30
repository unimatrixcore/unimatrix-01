"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const files = fs
  .readdirSync(__dirname)
  .filter((name) => name.endsWith(".test.cjs"))
  .sort()
  .map((name) => path.join(__dirname, name));
if (!files.length) throw new Error("Requests test suites are missing.");
execFileSync(process.execPath, ["--test", "--test-isolation=none", ...files], { stdio: "inherit" });
