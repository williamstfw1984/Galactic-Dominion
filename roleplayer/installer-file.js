"use strict";
/* Reads and writes the settings a Galactic Dominion installer carries after its own data. Used by the build and by the installer editor. */
const fs = require("fs");
const { pipeline } = require("stream/promises");
const format = require("./settings-format.js");

/* The size of the installer without any settings it carries, and those settings (null when it carries none). */
function readInstaller(file) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size, tail = Buffer.alloc(format.TAIL);
    fs.readSync(fd, tail, 0, format.TAIL, Math.max(0, size - format.TAIL));
    const length = format.embeddedLength(tail);
    if (!length) return { programSize: size, settings: null };
    const programSize = size - format.TAIL - length, text = Buffer.alloc(length);
    fs.readSync(fd, text, 0, length, programSize);
    return { programSize, settings: format.decode(text.toString("latin1")) };
  } finally { fs.closeSync(fd); }
}

/* Saves a copy of the installer that carries the given settings. The target may be the source itself. */
async function writeInstaller(source, settings, target) {
  if (!format.valid(settings)) throw new Error("The settings are incomplete and were not saved.");
  const { programSize } = readInstaller(source), partial = target + ".partial";
  try {
    await pipeline(fs.createReadStream(source, { end: programSize - 1 }), fs.createWriteStream(partial));
    fs.appendFileSync(partial, format.trailer(format.encode(settings)), "latin1");
    fs.renameSync(partial, target);
  } finally { fs.rmSync(partial, { force: true }); }     // nothing half-written is left behind when saving fails
}

module.exports = { readInstaller, writeInstaller };
