"use strict";
/* Downloads the speech models that ship inside the program: Kokoro (voices), the sound decoder of the expressive voices, and Whisper (microphone). */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const MODELS = {
  "onnx-community/Kokoro-82M-v1.0-ONNX": ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"],
  "onnx-community/snac_24khz-ONNX": ["onnx/decoder_model.onnx"],
  "Xenova/whisper-base.en": ["added_tokens.json", "config.json", "generation_config.json", "merges.txt", "normalizer.json", "preprocessor_config.json",
    "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json", "vocab.json", "onnx/encoder_model_quantized.onnx", "onnx/decoder_model_merged_quantized.onnx"]
};
const root = path.join(__dirname, "..", "resources", "speech-models");
for (const [repo, files] of Object.entries(MODELS)) {
  for (const file of files) {
    const dest = path.join(root, repo, file);
    if (fs.existsSync(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    console.log("downloading", repo, file);
    execFileSync("curl", ["-sSL", "--fail", "--retry", "3", "-o", dest + ".part", `https://huggingface.co/${repo}/resolve/main/${file}`], { stdio: "inherit" });
    fs.renameSync(dest + ".part", dest);                  // a download cut short is never taken for the whole file
  }
}
console.log("speech models ready");
