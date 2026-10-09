"""Synthesizes narration locally and offline. Engines:
  supertonic  Supertonic 3 (CPU): Swedish and English
  kokoro      Kokoro-82M via MLX (Apple Silicon): English

Input (stdin, JSON):  {"engine": "kokoro", "voice": "af_heart", "lang": "en", "speed": 1.0, "out": "dir",
                       "lines": [{"id": "s1-0", "text": "..."}]}
Output (stdout, JSON): {"lines": [{"id": "s1-0", "file": "...", "seconds": 3.2, "rate": 24000, "cached": false}]}

Lines are cached by a hash of everything that affects the sound, so unchanged lines are never synthesized twice.
Run it with the project's Python, or for Supertonic with uv:  uv run --with supertonic==1.3.1 python video/tts.py
"""
import hashlib
import json
import sys
import wave
from pathlib import Path

import numpy as np


def write(path: Path, samples: np.ndarray, rate: int) -> None:
    pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())


def main() -> None:
    # Libraries print progress to stdout; keep stdout for the JSON result only.
    result_out, sys.stdout = sys.stdout, sys.stderr
    job = json.load(sys.stdin)
    out = Path(job["out"])
    out.mkdir(parents=True, exist_ok=True)
    engine = job.get("engine", "supertonic")
    lang = job.get("lang", "sv")
    speed = float(job.get("speed", 1.0))
    if engine == "kokoro":
        from mlx_audio.tts.utils import load_model

        model = load_model("mlx-community/Kokoro-82M-bf16")
        rate = 24000

        def synth(text: str) -> np.ndarray:
            parts = list(model.generate(text=text, voice=job["voice"], speed=speed, lang_code=job.get("lang_code", "a")))
            if not parts:
                raise RuntimeError("Kokoro returned no audio")
            return np.concatenate([np.asarray(p.audio) for p in parts])
    else:
        from supertonic import TTS

        tts = TTS(auto_download=True)
        style = tts.get_voice_style(voice_name=job["voice"])
        rate = int(tts.sample_rate)

        def synth(text: str) -> np.ndarray:
            audio, _ = tts.synthesize(text, voice_style=style, lang=lang)
            return np.asarray(audio).squeeze()

    results = []
    for line in job["lines"]:
        key = hashlib.sha256(f'{engine}\n{job["voice"]}\n{lang}\n{speed}\n{line["text"]}'.encode()).hexdigest()[:16]
        path = out / f'{line["id"]}-{key}.wav'
        cached = path.exists()
        if not cached:
            write(path, synth(line["text"]), rate)
        with wave.open(str(path), "rb") as w:
            seconds = w.getnframes() / w.getframerate()
        results.append({"id": line["id"], "file": str(path), "seconds": seconds, "rate": rate, "cached": cached})
    json.dump({"lines": results}, result_out)


if __name__ == "__main__":
    main()
