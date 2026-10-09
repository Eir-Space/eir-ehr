"""Generates an original ambient pad of a given length (royalty free: synthesized here, no samples).
Slow, warm chords with detuned voices, a few soft high notes, and a gentle echo. Deterministic.
Usage: python video/music.py <seconds> <out.wav>"""
import sys, wave
import numpy as np

SR = 44100
# Cmaj9 - Am9 - Fmaj7 - Gsus (MIDI), one chord per 8 s
CHORDS = [[48, 55, 59, 62, 64], [45, 55, 60, 64, 67], [41, 52, 57, 60, 64], [43, 50, 55, 60, 62]]
BAR = 8.0

def hz(m): return 440.0 * 2 ** ((m - 69) / 12)

def voice(f, t):
    out = np.zeros_like(t)
    for d in (-0.0015, 0.0, 0.0015):  # slight detune for width
        ff = f * (1 + d)
        out += np.sin(2 * np.pi * ff * t) + 0.12 * np.sin(2 * np.pi * 2 * ff * t) + 0.03 * np.sin(2 * np.pi * 3 * ff * t)
    return out / 3

def main():
    secs, path = float(sys.argv[1]), sys.argv[2]
    n = int(secs * SR); t = np.arange(n) / SR
    L = np.zeros(n); R = np.zeros(n)
    rng = np.random.default_rng(7)
    for b in range(int(secs / BAR) + 2):
        chord = CHORDS[b % len(CHORDS)]
        s0 = b * BAR - 1.5; s1 = s0 + BAR + 3.0   # overlap chords for a smooth swell
        i0, i1 = max(0, int(s0 * SR)), min(n, int(s1 * SR))
        if i1 <= i0: continue
        tt = t[i0:i1]; u = (tt - s0) / (s1 - s0)
        env = np.sin(np.pi * np.clip(u, 0, 1)) ** 2
        for k, m in enumerate(chord):
            v = voice(hz(m), tt) * env * (0.5 if m < 50 else 0.32)
            pan = 0.35 + 0.3 * (k / (len(chord) - 1))
            L[i0:i1] += v * (1 - pan); R[i0:i1] += v * pan
        # a soft high note once per bar
        note = chord[int(rng.integers(2, len(chord)))] + 24
        st = b * BAR + 2.0; i2 = int(st * SR)
        if i2 < n:
            tn = np.arange(min(n - i2, int(5 * SR))) / SR
            bell = np.sin(2 * np.pi * hz(note) * tn) * np.exp(-tn * 1.1) * (1 - np.exp(-tn * 40)) * 0.09
            L[i2:i2 + len(tn)] += bell * 0.6; R[i2:i2 + len(tn)] += bell * 0.9
    # echo
    for d, g in ((0.43, 0.22), (0.89, 0.12)):
        k = int(d * SR); L[k:] += R[:-k] * g; R[k:] += L[:-k] * g
    st = np.stack([L, R], 1)
    st /= np.max(np.abs(st)) * 1.1
    pcm = (st * 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())

main()
