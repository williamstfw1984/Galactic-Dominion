"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const call = name => async arg => {
  const r = await ipcRenderer.invoke(name, arg);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld("api", { open: call("open"), save: call("save") });
