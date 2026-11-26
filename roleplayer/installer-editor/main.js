"use strict";
/* Galactic Dominion Installer Editor: changes the settings a Galactic Dominion installer carries, and saves the result as a new installer. */
const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const fs = require("fs");
const path = require("path");
const format = require("./settings-format.js");
const builtIn = require("./built-in.js");
const { readInstaller, writeInstaller } = require("./installer-file.js");

const SELFTEST = process.env.ROLEPLAYER_EDITOR_SELFTEST;   // path of a job file; set only by automated tests
let win = null;

// The editor keeps nothing between runs, so the browser engine's working files go to the temporary folder.
app.setPath("userData", path.join(app.getPath("temp"), "galactic-dominion-installer-editor"));

const handle = (name, fn) => ipcMain.handle(name, async (_e, arg) => {
  try { return { ok: true, value: await fn(arg) }; } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
handle("open", async () => {
  const picked = await dialog.showOpenDialog(win, { title: "Choose a Galactic Dominion installer", properties: ["openFile"], filters: [{ name: "Installer", extensions: ["exe"] }] });
  if (picked.canceled) return null;
  const file = picked.filePaths[0];
  const { settings } = readInstaller(file);
  if (!settings) throw new Error("This file is not a Galactic Dominion installer that can be edited.");
  if (!format.valid(settings)) throw new Error("The settings inside this installer are incomplete.");
  return { file, name: path.basename(file), settings: builtIn.complete(settings) };
});
handle("save", async ({ source, settings }) => {
  const suggested = path.join(path.dirname(source), path.basename(source, ".exe") + " (customised).exe");
  const picked = await dialog.showSaveDialog(win, { title: "Save the new installer", defaultPath: suggested, filters: [{ name: "Installer", extensions: ["exe"] }] });
  if (picked.canceled) return null;
  await writeInstaller(source, settings, picked.filePath);
  return picked.filePath;
});

async function selfTest() {
  const job = JSON.parse(fs.readFileSync(SELFTEST, "utf8"));
  await writeInstaller(job.source, format.decode(fs.readFileSync(job.settings, "utf8")), job.target);
}

app.whenReady().then(async () => {
  if (SELFTEST) { try { await selfTest(); } catch (e) { console.error(e); process.exitCode = 1; } app.quit(); return; }
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 920, height: 860, minWidth: 360, minHeight: 480, backgroundColor: "#0E1016", title: "Galactic Dominion Installer Editor",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  win.loadFile(path.join(__dirname, "editor.html"));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
});
app.on("window-all-closed", () => app.quit());
