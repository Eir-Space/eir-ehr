"""Round-trip check of the narration: transcribe each synthesized line with a local Swedish
recogniser and compare it with the script. Advisory: it finds words the voice garbles (names,
acronyms), so fix those in pronunciation.yaml. It cannot judge tone or naturalness; listen to the video.

Swedish uses KlangAI/pianissimo-sv-mlx-8bit (needs sentencepiece), English uses Parakeet. Both need Apple
Silicon with MLX (see the voice-agent project). Input (stdin): {"lang": "en", "lines": [{"id": "...", "file": "...", "expected": "..."}]}
Output (stdout): {"wer": 0.04, "lines": [{"id": "...", "heard": "...", "wer": 0.1}]}
"""
import importlib
import json
import os
import re
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")


def normalise(text: str) -> list[str]:
    words = re.sub(r"[^\w\s]", " ", text.lower()).split()
    # Spelled-out letters ("e h r") and the same letters run together ("ehr") should match.
    joined: list[str] = []
    run = ""
    for w in words + [""]:
        if len(w) == 1 and w.isalpha():
            run += w
            continue
        if run:
            joined.append(run)
            run = ""
        if w:
            joined.append(w)
    return joined


# Words the recogniser writes differently from the spelling we give the voice, but that a listener
# hears correctly ("fajr" is how FHIR is said, and the recogniser writes it "fire").
EQUIVALENT = {
    "fajr": {"fire", "fhir", "fyr"},
    "ayr": {"eir", "air", "ayr"},
    "air": {"eir", "ayr", "air"},
    "fire": {"fhir", "fire"},
    "yammel": {"yaml", "yamel", "yammel"},
}


def align(expected: list[str], heard: list[str]) -> list[str]:
    return [next((e for e, alts in EQUIVALENT.items() if h in alts and e in expected), h) for h in heard]


def wer(expected: list[str], heard: list[str]) -> float:
    heard = align(expected, heard)
    d = list(range(len(heard) + 1))
    for i, e in enumerate(expected, 1):
        prev, d[0] = d[0], i
        for j, h in enumerate(heard, 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (e != h))
            prev, d[j] = d[j], cur
    return d[-1] / max(1, len(expected))


def main() -> None:
    result_out, sys.stdout = sys.stdout, sys.stderr
    job = json.load(sys.stdin)
    if job.get("lang", "sv") == "sv":
        from huggingface_hub import snapshot_download

        path = snapshot_download("KlangAI/pianissimo-sv-mlx-8bit")
        sys.path.insert(0, path)
        loader = importlib.import_module("pianissimo_mlx")
        model = loader.load(path)

        def transcribe(file: str) -> str:
            return loader.transcribe(model, file).text.strip()
    else:
        from parakeet_mlx import from_pretrained

        parakeet = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")

        def transcribe(file: str) -> str:
            return parakeet.transcribe(file).text.strip()

    results, errors, words = [], 0.0, 0
    for line in job["lines"]:
        heard = transcribe(line["file"])
        exp = normalise(line["expected"])
        score = wer(exp, normalise(heard))
        errors += score * len(exp)
        words += len(exp)
        results.append({"id": line["id"], "expected": line["expected"], "heard": heard, "wer": round(score, 3)})
    json.dump({"wer": round(errors / max(1, words), 3), "lines": results}, result_out, ensure_ascii=False)


if __name__ == "__main__":
    main()
