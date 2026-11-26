"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const call = name => async arg => {
  const r = await ipcRenderer.invoke(name, arg);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

let spoken = 0;                                         // numbers the requests for speech, so each hears only its own sound
contextBridge.exposeInMainWorld("api", {
  getSettings: call("settings:get"),
  saveSettings: call("settings:save"),
  engineStatus: call("engine:status"),
  installEngine: call("engine:install"),
  pullModel: call("model:pull"),
  modelContext: call("model:context"),
  modelThinks: call("model:thinks"),
  chat: call("chat"),
  chatStream: (req, onText) => {
    const listener = (_e, piece) => onText(piece);
    ipcRenderer.on("chat:text", listener);
    return call("chat:stream")(req).finally(() => ipcRenderer.removeListener("chat:text", listener));
  },
  stopChat: () => ipcRenderer.send("chat:stop"),
  checkSafety: call("safety:check"),
  country: call("system:country"),
  logCall: call("log:add"),
  readLog: call("log:read"),
  deleteLog: call("log:delete"),
  voices: call("tts:voices"),
  installVoices: call("tts:install"),
  designVoice: call("voice:design"),
  saveVoice: call("voice:save"),
  deleteVoice: call("voice:delete"),
  keepVoices: call("voice:keep"),
  voiceSample: call("voice:sample"),
  importVoice: call("voice:import"),
  saveFile: call("file:save"),
  openFile: call("file:open"),
  speak: (req, onSound) => {
    const id = ++spoken, listener = (_e, sound) => { if (sound.id === id) onSound(sound); };
    ipcRenderer.on("tts:sound", listener);
    return call("tts:speak")({ ...req, id }).finally(() => ipcRenderer.removeListener("tts:sound", listener));
  },
  stopSpeaking: () => ipcRenderer.send("tts:stop"),
  transcribe: call("stt:transcribe"),
  checkComputer: call("system:check"),
  warm: call("warm"),
  hostGame: call("game:host"),
  gameSettings: call("game:settings"),
  chooseGameModel: call("game:model"),
  onProgress: fn => ipcRenderer.on("progress", (_e, info) => fn(info))
});
