"""Procedural upbeat pop music bed for the PantaUangmu promo (royalty-free, generated here).

112 BPM, D major, I–V–vi–IV. Usage: python3 tools/make_bgm.py <out.wav> [seconds]
"""
import sys, wave
import numpy as np

SR = 44100
BPM = 112
BEAT = 60 / BPM
BAR = 4 * BEAT
OUT = sys.argv[1]
LENGTH = float(sys.argv[2]) if len(sys.argv) > 2 else 61.0
N = int(SR * (LENGTH + 2.0))
rng = np.random.default_rng(7)  # seeded: identical output every run

L = np.zeros(N); R = np.zeros(N)


def midi(n): return 440.0 * 2 ** ((n - 69) / 12)


def add(sig, t0, gain=1.0, pan=0.0):
    i = int(t0 * SR)
    if i >= N: return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * (1 - max(pan, 0))
    R[i:i + len(sig)] += sig * (1 + min(pan, 0))


def env(n, a, d):  # attack (s), exponential decay time-constant (s)
    t = np.arange(n) / SR
    e = np.exp(-t / d)
    na = max(1, int(a * SR))
    e[:na] *= np.linspace(0, 1, na)
    return e


def lowpass(x, k):  # one-pole smoothing, k in (0,1]: smaller = darker
    y = np.empty_like(x); acc = 0.0
    for i in range(len(x)):
        acc += k * (x[i] - acc); y[i] = acc
    return y


def kick():
    n = int(0.4 * SR); t = np.arange(n) / SR
    f = 45 + 95 * np.exp(-t / 0.035)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.001, 0.13)


def clap():
    n = int(0.25 * SR); x = rng.standard_normal(n)
    x = x - lowpass(x, 0.15)
    return x * env(n, 0.002, 0.06) * 0.5


def hat(open_=False):
    n = int((0.18 if open_ else 0.06) * SR); x = rng.standard_normal(n)
    x = np.diff(np.diff(x, prepend=0), prepend=0)
    return x * env(n, 0.001, 0.05 if open_ else 0.015) * 0.09


def tone(freq, dur, harmonics, decay, attack=0.004, detune=0.0):
    n = int(dur * SR); t = np.arange(n) / SR; s = np.zeros(n)
    for h, amp in harmonics:
        s += amp * np.sin(2 * np.pi * freq * h * t)
        if detune: s += amp * 0.6 * np.sin(2 * np.pi * freq * h * (1 + detune) * t)
    return s * env(n, attack, decay)


# D major: I–V–vi–IV  (D, A, Bm, G) — root midi + triad
CHORDS = [(50, [62, 66, 69]), (45, [61, 64, 69]), (47, [62, 66, 71]), (43, [62, 67, 71])]
# Chorus hook (scale degrees as midi), one note per beat, 4 bars
HOOK = [74, 76, 78, 76, 73, 74, 76, 73, 74, 71, 74, 76, 74, 78, 79, 78]

bars = int(np.ceil(LENGTH / BAR))
pump = np.ones(N)
for b in range(bars):
    t_bar = b * BAR
    root, triad = CHORDS[b % 4]
    intro = b < 2
    chorus = 10 <= b < 18 or b >= bars - 6
    outro_last = b == bars - 1

    for beat in range(4):
        tb = t_bar + beat * BEAT
        if not intro:
            add(kick(), tb, 0.9)
            k0 = int(tb * SR); kn = int(0.32 * SR)
            pump[k0:k0 + kn] = np.minimum(pump[k0:k0 + kn], 0.35 + 0.65 * np.linspace(0, 1, len(pump[k0:k0 + kn])) ** 0.6)
            if beat in (1, 3): add(clap(), tb, 0.8)
        add(hat(), tb, 0.6 if intro else 0.8, 0.3)
        add(hat(open_=not intro and chorus), tb + BEAT / 2, 0.9, -0.3)
        # bass: 8th-note root with octave pop on the offbeat
        if not intro:
            add(tone(midi(root), BEAT / 2 * 0.95, [(1, 1), (2, .45), (3, .2)], 0.16), tb, 0.55)
            add(tone(midi(root + 12), BEAT / 2 * 0.9, [(1, 1), (2, .3)], 0.1), tb + BEAT / 2, 0.30)

    # pluck arpeggio, 16ths across the bar
    seq = [triad[0], triad[1], triad[2], triad[1] + 12 if chorus else triad[1]]
    for s in range(16):
        n = seq[s % 4] + (12 if chorus and s % 8 >= 4 else 0)
        add(tone(midi(n), 0.3, [(1, 1), (2, .5), (3, .25), (4, .12)], 0.15, 0.002),
            t_bar + s * BEAT / 4, 0.16 if intro else 0.20, 0.35 if s % 2 else -0.35)

    # soft pad chord
    for n in triad:
        add(tone(midi(n - 12), BAR * 1.05, [(1, 1), (2, .3), (3, .1)], 3.0, 0.08, detune=0.004), t_bar, 0.13 if not chorus else 0.16)

    # bell hook in chorus
    if chorus and not outro_last:
        i0 = (b % 4) * 4
        for beat in range(4):
            add(tone(midi(HOOK[i0 + beat]), 0.6, [(1, 1), (2, .4), (3.01, .15)], 0.28, 0.003),
                t_bar + beat * BEAT, 0.16, 0.1)

    # rising noise sweep into each chorus
    if b in (9, bars - 7):
        n = int(BAR * SR); x = rng.standard_normal(n)
        x = x - lowpass(x, 0.08)
        add(x * np.linspace(0, 1, n) ** 2 * 0.12, t_bar)

# sidechain pump on everything except drums is approximated by pumping the whole bed lightly
L *= 0.75 + 0.25 * pump; R *= 0.75 + 0.25 * pump

# final hit + ring out on the last downbeat
end_t = bars * BAR
add(kick(), end_t, 0.9)
for n in CHORDS[0][1]:
    add(tone(midi(n), 2.0, [(1, 1), (2, .4)], 0.7), end_t, 0.18)

# simple stereo slap/reverb
for d, g in [(0.083, 0.22), (0.131, 0.16), (0.197, 0.11)]:
    k = int(d * SR)
    L[k:] += R[:-k] * g; R[k:] += L[:-k] * g

# trim, fade, normalise
total = int((LENGTH + 0.8) * SR)
L = L[:total]; R = R[:total]
fade_in = int(0.4 * SR); fade_out = int(1.5 * SR)
for ch in (L, R):
    ch[:fade_in] *= np.linspace(0, 1, fade_in)
    ch[-fade_out:] *= np.linspace(1, 0, fade_out)
peak = max(np.abs(L).max(), np.abs(R).max())
st = np.stack([L, R], axis=1) / peak * 0.89
pcm = (st * 32767).astype(np.int16)
with wave.open(OUT, "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm.tobytes())
print(f"wrote {OUT}: {len(L) / SR:.2f}s, {bars} bars @ {BPM} BPM")
