"use strict";
/* Gathers the installer editor's files into dist/editor-app, ready to be packaged as a program. */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const source = path.join(root, "installer-editor"), out = path.join(root, "dist", "editor-app");
const SHARED = ["settings-format.js", "built-in.js", "installer-file.js", path.join("renderer", "password.js")];

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(source, out, { recursive: true });
for (const file of SHARED) fs.copyFileSync(path.join(root, file), path.join(out, path.basename(file)));
const pkg = JSON.parse(fs.readFileSync(path.join(out, "package.json"), "utf8"));
pkg.build.electronVersion = require("electron/package.json").version;
fs.writeFileSync(path.join(out, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
console.log(out);
