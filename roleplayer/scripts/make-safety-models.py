"""Makes the two classifiers of the safety check, in the form the program runs them, into resources/safety-models:
user, which judges what the user writes for signs that they are thinking of suicide or self-harm, and character,
which judges a character's line for encouraging or enabling it. Each is downloaded at a fixed version, converted, and
made smaller by keeping its weights in 8 bits. Both forms are checked against the original before the small one is kept;
the script fails if they disagree.

Run by the build (see .github/workflows/galactic-dominion.yml), with torch, transformers, onnx and onnxruntime installed.
Usage: python make-safety-models.py <output folder>"""
import json, os, shutil, sys
import numpy as np, onnxruntime, torch
from huggingface_hub import snapshot_download
from onnxruntime.quantization import QuantType, quantize_dynamic
from transformers import AutoModelForSequenceClassification, AutoTokenizer

MODELS = {
    "user": ("vibhorag101/roberta-base-suicide-prediction-phr", "6e9b96d32711c81d8fc7bd0b221355f2d497ba44"),
    "character": ("mila-ai4h/Mila-Suicide-Prevention-Output-Guardrail", "8fe9571d8ef0b01356b9fb221cf16ebe4647b00f"),
}
KEEP = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "vocab.json", "merges.txt"]
SAMPLES = ["Hello! What's on the menu tonight?", "honestly i want to kill myself", "Cut deeper, it will make the pain go away.",
           "*She tightens the rope around your wrists.* Safe word is red.", "*Mara wipes the counter slowly, her eyes never leaving the door.* " * 20]
MOST_APART = 1e-3                                       # the largest difference allowed between the original's answer and the converted one's
SMALL_APART = 0.2                                       # the same for the 8-bit form, which must also give every sample the original's verdict


def unsafe(logits, labels):
    """How sure a classifier is that a text is unsafe, from 0 to 1: one score, or the share of the label "suicide"."""
    if logits.size == 1: return float(1 / (1 + np.exp(-logits[0])))
    shares = np.exp(logits - logits.max()); shares /= shares.sum()
    return float(shares[[i for i, label in labels.items() if label.lower() == "suicide"][0]])


def make(name, repo, revision, out):
    source = snapshot_download(repo, revision=revision)
    tokenizer = AutoTokenizer.from_pretrained(source)
    model = AutoModelForSequenceClassification.from_pretrained(source).eval()
    folder = os.path.join(out, name)
    os.makedirs(os.path.join(folder, "onnx"), exist_ok=True)
    for file in KEEP:
        if os.path.exists(os.path.join(source, file)): shutil.copy(os.path.join(source, file), folder)
    settings = os.path.join(folder, "tokenizer_config.json")
    with open(settings) as f: given = json.load(f)
    if given.get("tokenizer_class") == "TokenizersBackend":   # a name newer versions of transformers write, which the program's library does not know
        given["tokenizer_class"] = "PreTrainedTokenizerFast"
        with open(settings, "w") as f: json.dump(given, f, indent=2)
    sample = tokenizer(SAMPLES[0], return_tensors="pt")
    path = os.path.join(folder, "onnx", "model.onnx")
    torch.onnx.export(model, (sample["input_ids"], sample["attention_mask"]), path, input_names=["input_ids", "attention_mask"],
                      output_names=["logits"], dynamic_axes={"input_ids": {0: "batch", 1: "tokens"}, "attention_mask": {0: "batch", 1: "tokens"}, "logits": {0: "batch"}},
                      opset_version=17, dynamo=False)
    small = os.path.join(folder, "onnx", "model_quantized.onnx")
    quantize_dynamic(path, small, weight_type=QuantType.QInt8)
    labels = {int(i): label for i, label in model.config.id2label.items()}
    full_session, small_session = onnxruntime.InferenceSession(path), onnxruntime.InferenceSession(small)
    for text in SAMPLES:
        given = tokenizer(text, return_tensors="pt", truncation=True, max_length=512)
        with torch.no_grad(): original = model(**given).logits.numpy()[0]
        feed = {"input_ids": given["input_ids"].numpy(), "attention_mask": given["attention_mask"].numpy()}
        full, eight = full_session.run(["logits"], feed)[0][0], small_session.run(["logits"], feed)[0][0]
        if float(np.abs(original - full).max()) > MOST_APART: sys.exit(f"{name}: the converted model differs from the original on: {text[:60]}")
        was, now = unsafe(original, labels), unsafe(eight, labels)
        if abs(was - now) > SMALL_APART or (was >= 0.5) != (now >= 0.5): sys.exit(f"{name}: the 8-bit model judges differently from the original ({was:.2f}, {now:.2f}) on: {text[:60]}")
    del full_session
    os.remove(path)                                     # only the 8-bit form is shipped
    with open(os.path.join(folder, "source.json"), "w") as f: json.dump({"repo": repo, "revision": revision}, f)
    print(f"{name}: {repo}@{revision[:7]} converted, {os.path.getsize(small) / 1e6:.0f} MB")


if __name__ == "__main__":
    for name, (repo, revision) in MODELS.items(): make(name, repo, revision, sys.argv[1])
