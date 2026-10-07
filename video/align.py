"""Word timings from the real audio: transcribes each narration line with Parakeet (MLX) and returns
when every spoken word starts and ends, so captions follow the voice instead of an estimate.

Input (stdin, JSON):  {"lines": [{"id": "...", "file": "..."}]}
Output (stdout, JSON): {"lines": [{"id": "...", "speech": {"start": 0.1, "end": 3.2},
                                   "words": [{"text": "open", "start": 1.4, "end": 1.7}]}]}
Needs Apple Silicon with parakeet-mlx and the mlx-community/parakeet-tdt-0.6b-v3 model.
"""
import json
import os
import sys

os.environ.setdefault("HF_HUB_OFFLINE", "1")


def words_of(result) -> list[dict]:
    """Group Parakeet tokens into words: a token whose text starts with a space begins a new word."""
    words: list[dict] = []
    for sentence in result.sentences:
        for t in sentence.tokens:
            if t.text.startswith(" ") or not words:
                words.append({"text": t.text.strip(), "start": float(t.start), "end": float(t.end)})
            else:
                words[-1]["text"] += t.text
                words[-1]["end"] = float(t.end)
    return [w for w in words if w["text"]]


def main() -> None:
    result_out, sys.stdout = sys.stdout, sys.stderr
    from parakeet_mlx import from_pretrained

    model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
    out = []
    for line in json.load(sys.stdin)["lines"]:
        words = words_of(model.transcribe(line["file"]))
        speech = {"start": words[0]["start"], "end": words[-1]["end"]} if words else {"start": 0.0, "end": 0.0}
        out.append({"id": line["id"], "speech": speech, "words": words})
    json.dump({"lines": out}, result_out)


if __name__ == "__main__":
    main()
