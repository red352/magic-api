"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "src", "language-data", "generated", "core.json");
const target = path.join(root, "src", "language-data", "generated", "core.json");
const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
fs.writeFileSync(target, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
console.log(`Updated ${path.relative(root, target)}`);
