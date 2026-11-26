"use strict";
/* Puts a settings file at the end of an installer, replacing any settings it already carries.
   With no arguments: the installer in dist and the default settings in resources. */
const fs = require("fs");
const path = require("path");
const format = require("../settings-format.js");
const { writeInstaller } = require("../installer-file.js");

const root = path.join(__dirname, "..");
const builtInstaller = () => {
  const dist = path.join(root, "dist");
  const name = fs.readdirSync(dist).find(f => /Setup.*\.exe$/.test(f));
  if (!name) throw new Error("No installer was found in " + dist);
  return path.join(dist, name);
};
const installer = process.argv[2] || builtInstaller();
const settings = format.decode(fs.readFileSync(process.argv[3] || path.join(root, "resources", "settings.dat"), "utf8"));

writeInstaller(installer, settings, installer).then(
  () => console.log(`${path.basename(installer)}: settings embedded`),
  error => { console.error(error.message); process.exitCode = 1; }
);
