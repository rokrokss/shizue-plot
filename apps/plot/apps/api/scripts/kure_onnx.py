"""KURE-v1 (nlpai-lab/KURE-v1) to the ONNX the server embedder runs (embedder.ts).

KURE-v1 ships only safetensors for PyTorch. This makes the directory
`embedder:publish` uploads to the object store: optimum's feature-extraction
export (the transformer's `last_hidden_state`, for transformers.js to pool),
ONNX Runtime's dynamic int8 quantization to `onnx/model_quantized.onnx`, the
tokenizer and config files beside it. Then it checks the int8 model against
sentence-transformers running the original: the pooling the model's own
`1_Pooling/config.json` names (CLS) and its Normalize module, on Korean and
English sentences. It fails below a cosine of 0.99, and writes the reference
vectors as `reference.json` beside the output for the Node check.

The quantization: int8 weights with a scale per channel, except the feed-forward
output projections (`layer.N/output/dense`, after the GELU) of the last
`--keep-ffn-out` layers, which stay fp32 — they carry most of the error, at
12.5 MB more each. Measured 2026-10-15, min / mean cosine to the original on
the Korean sentences (file size): every MatMul per tensor 0.981 / 0.985
(569 MB), per channel 0.985 / 0.989 (570 MB), last 8 layers kept 0.990- /
0.993 (670 MB), last 12 0.991 / 0.993 (721 MB), all 24 0.992 / 0.993 (872 MB).

Run once per conversion, in a venv of exactly these (Python 3.12, macOS arm64):

    torch==2.5.1 transformers==4.46.3 tokenizers==0.20.3
    sentence-transformers==3.3.1 optimum[exporters]==1.23.3 onnx==1.17.0
    onnxruntime==1.20.1 numpy==1.26.4 safetensors==0.4.5 huggingface_hub==0.26.5
    datasets==3.1.0 pyarrow==17.0.0

    HF_HUB_OFFLINE=1 venv/bin/python -I kure_onnx.py --model <KURE-v1 download> --out <dir>

with `--model` a download of the repo at revision 8b418a58414668e75532ed045c22d9ca018ae2b2
(model.safetensors sha256 c18156e8…a02c). The upload is `<dir>/KURE-v1`.
"""

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np

KOREAN = [
    "비 오는 밤, 그는 낡은 서점 문을 조용히 열었다.",
    "고양이가 창가에 앉아 지나가는 사람들을 바라보고 있었다.",
    "우리가 처음 만난 곳은 바닷가의 작은 등대였지.",
    "그녀는 오래된 지도를 펼쳐 보물섬의 위치를 짚었다.",
    "기사단장은 성문 앞에서 마지막 명령을 내렸다.",
    "어제 먹은 떡볶이가 너무 매워서 아직도 입이 얼얼해.",
    "마법사는 지팡이를 들어 폭풍을 잠재웠다.",
    "회사 그만두고 시골에서 카페를 차리고 싶어.",
    "그 편지에는 끝내 전하지 못한 고백이 적혀 있었다.",
    "용병들은 국경 마을에서 하룻밤을 묵기로 했다.",
    "도서관 사서는 금지된 책장의 열쇠를 숨기고 있었다.",
    "너 때문에 내가 얼마나 걱정했는지 알아?",
    "숲속 오두막에는 늙은 약초상이 홀로 살고 있었다.",
    "황제는 반란군의 요구를 끝내 받아들이지 않았다.",
    "벚꽃이 흩날리는 교정에서 졸업 사진을 찍었다.",
    "그는 검을 내려놓고 무릎을 꿇었다.",
    "지하철이 끊겨서 결국 택시를 타고 집에 왔다.",
    "드래곤의 비늘은 달빛을 받아 은색으로 빛났다.",
    "할머니는 매년 겨울 김장을 하셨다.",
    "탐정은 피 묻은 손수건에서 결정적인 단서를 찾아냈다.",
    "우주선의 산소가 세 시간밖에 남지 않았다.",
    "오늘따라 네 목소리가 듣고 싶었어.",
]
ENGLISH = [
    "On a rainy night he quietly opened the door of the old bookstore.",
    "The cat sat by the window watching people pass by.",
    "We first met at a small lighthouse by the sea.",
    "She unfolded the old map and pointed to the treasure island.",
    "The knight commander gave his final order before the castle gate.",
    "I want to quit my job and open a cafe in the countryside.",
    "The letter held a confession she never managed to deliver.",
    "The dragon's scales shone silver in the moonlight.",
    "The detective found a decisive clue on the bloodstained handkerchief.",
    "The spaceship had only three hours of oxygen left.",
    "Do you have any idea how worried I was about you?",
]
TOKENIZER_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json"]
THRESHOLD = 0.99
KEEP_FFN_OUT = 12


def pooling_of(model: Path) -> tuple[str, bool]:
    """The pooling and normalization the model's sentence-transformers modules name."""
    config = json.loads((model / "1_Pooling" / "config.json").read_text())
    modes = [key for key, on in config.items() if key.startswith("pooling_mode_") and on is True]
    if modes != ["pooling_mode_cls_token"]:
        sys.exit(f"expected CLS pooling, the model says {modes}")
    modules = json.loads((model / "modules.json").read_text())
    normalize = any(module["type"].endswith(".Normalize") for module in modules)
    return "cls", normalize


def pool(hidden: np.ndarray, mask: np.ndarray, mode: str, normalize: bool) -> np.ndarray:
    if mode == "cls":
        vectors = hidden[:, 0]
    else:
        weights = mask[..., None].astype(np.float32)
        vectors = (hidden * weights).sum(1) / weights.sum(1)
    if normalize:
        vectors = vectors / np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors


def run_onnx(path: Path, tokenizer, texts: list[str]) -> tuple[np.ndarray, np.ndarray]:
    import onnxruntime as ort

    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    session = ort.InferenceSession(str(path), options, providers=["CPUExecutionProvider"])
    names = {i.name for i in session.get_inputs()}
    encoded = tokenizer(texts, padding=True, truncation=True, return_tensors="np")
    feed = {key: value.astype(np.int64) for key, value in encoded.items() if key in names}
    (hidden,) = session.run(["last_hidden_state"], feed)
    return hidden, encoded["attention_mask"]


def cosines(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return (a * b).sum(1) / (np.linalg.norm(a, axis=1) * np.linalg.norm(b, axis=1))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--keep-ffn-out", type=int, default=KEEP_FFN_OUT, help="last layers whose FFN output stays fp32")
    parser.add_argument("--check-fp32", action="store_true", help="also check the fp32 export (another 2.3 GB)")
    args = parser.parse_args()
    model: Path = args.model.resolve()
    out: Path = args.out.resolve()
    fp32 = out / "fp32"
    target = out / "KURE-v1"

    mode, normalize = pooling_of(model)
    print(f"pooling {mode}, normalize {normalize}")

    import gc

    import torch

    torch.set_num_threads(4)
    if not (fp32 / "model.onnx").exists():
        from optimum.exporters.onnx import main_export

        main_export(
            str(model),
            output=fp32,
            task="feature-extraction",
            library_name="transformers",
            local_files_only=True,
            do_validation=False,
        )
        gc.collect()

    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic

    graph = onnx.load(str(fp32 / "model.onnx"), load_external_data=False).graph
    outputs = [output.name for output in graph.output]
    if "last_hidden_state" not in outputs:
        sys.exit(f"the export answers {outputs}, not last_hidden_state")
    layers = json.loads((model / "config.json").read_text())["num_hidden_layers"]
    kept = [
        node.name
        for node in graph.node
        if node.op_type == "MatMul"
        and "/attention/" not in node.name
        and "/output/dense/" in node.name
        and int(node.name.split("layer.")[1].split("/")[0]) >= layers - args.keep_ffn_out
    ]
    if len(kept) != args.keep_ffn_out:
        sys.exit(f"expected {args.keep_ffn_out} FFN output projections, found {kept}")
    (target / "onnx").mkdir(parents=True, exist_ok=True)
    quantize_dynamic(
        fp32 / "model.onnx",
        target / "onnx" / "model_quantized.onnx",
        weight_type=QuantType.QInt8,
        per_channel=True,
        nodes_to_exclude=kept,
    )
    for name in TOKENIZER_FILES:
        shutil.copyfile(model / name, target / name)

    from sentence_transformers import SentenceTransformer
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(str(target))
    # The reference first, and the PyTorch model let go before an ONNX one loads.
    reference_model = SentenceTransformer(str(model), device="cpu", local_files_only=True)
    references = {
        language: {"texts": texts, "vectors": reference_model.encode(texts, convert_to_numpy=True).tolist()}
        for language, texts in (("ko", KOREAN), ("en", ENGLISH))
    }
    del reference_model
    gc.collect()
    report = {}
    failed = False
    checked = [("int8", target / "onnx" / "model_quantized.onnx")]
    if args.check_fp32:
        checked.insert(0, ("fp32", fp32 / "model.onnx"))
    for language, texts in (("ko", KOREAN), ("en", ENGLISH)):
        reference = np.array(references[language]["vectors"], dtype=np.float32)
        for name, path in checked:
            hidden, mask = run_onnx(path, tokenizer, texts)
            exact = cosines(pool(hidden, mask, mode, normalize), reference)
            mean = cosines(pool(hidden, mask, "mean", normalize), reference)
            report[f"{language} {name}"] = {
                "n": len(texts),
                "min": round(float(exact.min()), 5),
                "mean": round(float(exact.mean()), 5),
                "mean-pooling mean": round(float(mean.mean()), 5),
            }
            failed |= name == "int8" and float(exact.min()) < THRESHOLD
    print(json.dumps(report, indent=2))
    (out / "reference.json").write_text(json.dumps(references))
    if failed:
        sys.exit(f"int8 falls below cosine {THRESHOLD}")


if __name__ == "__main__":
    main()
