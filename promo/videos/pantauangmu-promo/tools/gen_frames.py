"""Generate PantaUangmu HyperFrames frame sub-compositions (shared CSS + per-frame body/timeline).

Usage: python3 tools/gen_frames.py <project dir>
"""
import pathlib, sys

OUT = pathlib.Path(sys.argv[1]) / "compositions" / "frames"
OUT.mkdir(parents=True, exist_ok=True)

FONTS = "".join(
    f'@font-face{{font-family:"{fam}";font-weight:{w};font-style:normal;font-display:block;src:url("assets/fonts/{file}-{w}.woff2") format("woff2");}}\n'
    for fam, file, ws in [("Fredoka", "Fredoka", (500, 600, 700)), ("Plus Jakarta Sans", "PlusJakartaSans", (500, 600, 700, 800))]
    for w in ws
)

COMMON = """
#root { position:absolute; inset:0; overflow:hidden; font-family:"Plus Jakarta Sans", sans-serif; color:#0E1A3A; }
.ground { position:absolute; inset:0; background:
  radial-gradient(900px 700px at 15% 8%, rgba(30,139,240,.20), transparent 60%),
  radial-gradient(800px 700px at 95% 92%, rgba(3,163,114,.16), transparent 60%), #F4F8FF; }
.head { position:absolute; left:80px; right:80px; top:150px; text-align:center; }
.eyebrow { display:block; font-weight:800; font-size:30px; letter-spacing:.12em; text-transform:uppercase; color:#1E8BF0; }
.h2 { display:block; margin-top:22px; font-family:"Fredoka", sans-serif; font-weight:600; font-size:84px; line-height:1.08; letter-spacing:-.02em; color:#0E1A3A; }
.h2 .b { color:#1E8BF0; } .h2 .g { color:#03A372; }
.h2 .nl { display:block; }
.phone { position:absolute; left:180px; width:720px; top:560px; height:1000px; border-radius:64px; background:#fff;
  border:10px solid #fff; box-shadow:0 40px 90px rgba(11,77,183,.22), 0 0 0 2px rgba(30,139,240,.18); overflow:hidden; }
.tg-top { position:absolute; left:0; right:0; top:0; height:128px; background:#fff; border-bottom:2px solid #E6EDF7;
  display:flex; align-items:center; gap:22px; padding:24px 34px 0; }
.ava { width:72px; height:72px; border-radius:50%; flex:none; display:flex; align-items:center; justify-content:center;
  font-family:"Fredoka", sans-serif; font-weight:600; font-size:32px; color:#fff; background:#1E8BF0; overflow:hidden; }
.ava img { width:100%; height:100%; object-fit:cover; object-position:30% 30%; }
.tg-name { display:block; font-weight:800; font-size:30px; }
.tg-sub { display:block; font-weight:700; font-size:22px; color:#1468BE; }
.chat { position:absolute; left:0; right:0; top:128px; bottom:110px; padding:30px 28px; display:flex; flex-direction:column; gap:20px;
  background:linear-gradient(180deg,#E9F1FB,#E3F2EC); }
.msg { max-width:84%; padding:20px 26px; border-radius:30px; font-size:31px; line-height:1.35; font-weight:600; }
.me { align-self:flex-end; background:#1E8BF0; color:#fff; border-bottom-right-radius:8px; }
.bot { align-self:flex-start; background:#fff; color:#0E1A3A; border-bottom-left-radius:8px; box-shadow:0 4px 14px rgba(14,26,58,.06); }
.who { display:block; font-size:22px; font-weight:800; margin-bottom:4px; }
.inbar { position:absolute; left:0; right:0; bottom:0; height:110px; background:#fff; border-top:2px solid #E6EDF7;
  display:flex; align-items:center; padding:0 26px; gap:18px; }
.field { flex:1; height:68px; border-radius:34px; background:#F1F5FB; display:flex; align-items:center; padding:0 28px;
  font-size:30px; font-weight:600; color:#0E1A3A; }
.ph { color:#6B7894; }
.caret { display:inline-block; width:3px; height:34px; background:#1E8BF0; margin-left:3px; }
.send { width:68px; height:68px; border-radius:50%; background:#1E8BF0; display:flex; align-items:center; justify-content:center; flex:none; }
.chip { display:inline-block; padding:16px 30px; border-radius:100px; font-weight:700; font-size:32px;
  background:#fff; border:2px solid rgba(30,139,240,.25); color:#0E1A3A; box-shadow:0 8px 22px rgba(11,77,183,.08); }
.pill-g { display:inline-block; padding:14px 30px; border-radius:100px; font-weight:800; font-size:28px; letter-spacing:.08em;
  background:rgba(3,163,114,.12); color:#027A55; }
"""

PLANE = '<svg width="34" height="34" viewBox="0 0 24 24" fill="#fff"><path d="M21.9 4.3 18.6 19.8c-.2 1.1-.9 1.4-1.8.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1 9.2-8.3c.4-.4-.1-.6-.6-.2L6 13.4l-4.9-1.5c-1.1-.3-1.1-1.1.2-1.6L20.5 2.9c.9-.3 1.7.2 1.4 1.4Z"/></svg>'


def phone(chat_html, field_html, name="PantaUangmu", sub="bot", ava='<img src="assets/pantauangmu-mascot.png" alt="">', pid="phone"):
    return f"""
  <div class="phone" id="{pid}">
    <div class="tg-top"><div class="ava">{ava}</div><div><span class="tg-name">{name}</span><span class="tg-sub">{sub}</span></div></div>
    <div class="chat">{chat_html}</div>
    <div class="inbar"><div class="field">{field_html}</div><div class="send">{PLANE}</div></div>
  </div>"""


def frame(fid, old, css, body, js):
    dur = DURATIONS[fid]; scale = round(dur / old, 4)
    return f"""<template>
  <script src="assets/vendor/gsap.min.js"></script>
  <style>
{FONTS}{COMMON}{css}
  </style>
  <div id="root" data-composition-id="{fid}" data-width="1080" data-height="1920">
    <div class="ground clip" id="f{fid[:2].lstrip('0')}-ground" data-start="0" data-duration="{dur}" data-track-index="0"></div>
{body}
  </div>
  <script>
    const tl = gsap.timeline({{ paused: true }});
    // Reveal times were authored for {old}s; stretch positions (not tween lengths) to the voice-synced {dur}s.
    const S = {scale};
    for (const m of ["fromTo", "to", "set"]) {{
      const f = tl[m].bind(tl);
      tl[m] = (...a) => {{ if (typeof a[a.length - 1] === "number") a[a.length - 1] *= S; return f(...a); }};
    }}
    const rise = (sel, at, d = 0.6, y = 60) => tl.fromTo(sel, {{ opacity: 0, y }}, {{ opacity: 1, y: 0, duration: d, ease: "power3.out" }}, at);
    const pop = (sel, at, d = 0.5) => tl.fromTo(sel, {{ opacity: 0, scale: 0.6 }}, {{ opacity: 1, scale: 1, duration: d, ease: "back.out(1.8)" }}, at);
    const typeInto = (sel, text, at, cps = 14) => {{
      const el = document.querySelector(sel); const s = {{ n: 0 }};
      tl.fromTo(s, {{ n: 0 }}, {{ n: text.length, duration: text.length / cps, ease: "none",
        onUpdate: () => {{ el.textContent = text.slice(0, Math.round(s.n)); }} }}, at);
    }};
{js}
    window.__timelines["{fid}"] = tl;
  </script>
</template>
"""


# Frame lengths synced to the Cartesia voice-over (assets/audio/vo-cartesia.wav pauses).
DURATIONS = {"01-hook": 7.6, "02-intro": 4.0, "03-start": 6.3, "04-chat": 7.8,
             "05-jatah": 10.3, "06-bersama": 8.0, "07-mvp": 8.45, "08-cta": 7.55}

FRAMES = {}

# 01 — Hook
FRAMES["01-hook"] = (5, """
.f1-head { position:absolute; left:80px; right:80px; top:200px; text-align:center; }
.f1-big { display:block; font-family:"Fredoka", sans-serif; font-weight:700; font-size:150px; line-height:1; letter-spacing:-.03em; margin-top:26px; }
.f1-big span { color:#1E8BF0; }
.f1-steps { position:absolute; left:140px; right:140px; top:640px; display:flex; flex-direction:column; gap:26px; }
.f1-step { display:flex; align-items:center; gap:28px; padding:30px 38px; border-radius:28px; background:#fff;
  border:2px solid rgba(30,139,240,.18); font-size:42px; font-weight:700; box-shadow:0 10px 26px rgba(11,77,183,.07); }
.f1-num { width:66px; height:66px; border-radius:50%; flex:none; background:#FDECEC; color:#dc2626; display:flex; align-items:center; justify-content:center;
  font-family:"Fredoka", sans-serif; font-weight:600; font-size:34px; }
.f1-stamp { position:absolute; left:0; right:0; top:1300px; text-align:center; }
.f1-stamp span { display:inline-block; font-family:"Fredoka", sans-serif; font-weight:700; font-size:170px; color:#dc2626; letter-spacing:-.02em; }
""", """
    <div class="f1-head"><span class="eyebrow" id="f1-eb">Mau catat</span><span class="f1-big" id="f1-big">kopi <span>25rb</span>?</span></div>
    <div class="f1-steps">
      <div class="f1-step" id="f1-s1"><span class="f1-num">1</span>Buka aplikasi</div>
      <div class="f1-step" id="f1-s2"><span class="f1-num">2</span>Cari menu</div>
      <div class="f1-step" id="f1-s3"><span class="f1-num">3</span>Pilih kategori</div>
      <div class="f1-step" id="f1-s4"><span class="f1-num">4</span>Isi semua kolom</div>
    </div>
    <div class="f1-stamp"><span id="f1-stamp">ribet.</span></div>
""", """
    rise("#f1-eb", 0.0, 0.5, 30);
    pop("#f1-big", 0.15, 0.6);
    ["#f1-s1","#f1-s2","#f1-s3","#f1-s4"].forEach((s, i) => rise(s, 1.2 + i * 0.55, 0.45, 50));
    tl.to(".f1-step", { opacity: 0.4, duration: 0.4, ease: "power2.out" }, 3.6);
    tl.fromTo(".f1-steps", { x: 0 }, { keyframes: { x: [0, -14, 12, -8, 5, 0] }, duration: 0.45, ease: "none" }, 3.6);
    tl.fromTo("#f1-stamp", { opacity: 0, scale: 2.2, rotation: -4 }, { opacity: 1, scale: 1, rotation: -4, duration: 0.45, ease: "back.out(2)" }, 3.75);
""")

# 02 — Intro
FRAMES["02-intro"] = (4.5, """
.f2-rings { position:absolute; left:90px; top:300px; width:900px; height:900px; }
.f2-ring { position:absolute; inset:0; border-radius:50%; border:2px solid rgba(30,139,240,.18); }
.f2-ring.r2 { inset:110px; border-color:rgba(3,163,114,.20); } .f2-ring.r3 { inset:220px; border-color:rgba(30,139,240,.24); }
.f2-logo { position:absolute; left:90px; width:900px; top:390px; }
.f2-logo img { width:900px; display:block; }
.f2-pill { position:absolute; left:0; right:0; top:1150px; text-align:center; }
.f2-pill span { display:inline-flex; align-items:center; gap:18px; padding:22px 42px; border-radius:100px; background:#1E8BF0; color:#fff;
  font-weight:800; font-size:38px; box-shadow:0 18px 40px rgba(30,139,240,.35); }
.f2-chips { position:absolute; left:60px; right:60px; top:1330px; display:flex; justify-content:center; gap:18px; }
""", f"""
    <div class="f2-rings" id="f2-rings"><div class="f2-ring"></div><div class="f2-ring r2"></div><div class="f2-ring r3"></div></div>
    <div class="f2-logo" id="f2-logo"><img src="assets/pantauangmu-lockup.png" alt="PantaUangmu"></div>
    <div class="f2-pill"><span id="f2-pill">{PLANE}Hidup di dalam Telegram</span></div>
    <div class="f2-chips"><span class="chip" id="f2-c1">Tanpa install</span><span class="chip" id="f2-c2">Tanpa akun</span><span class="chip" id="f2-c3">Gratis</span></div>
""", """
    tl.fromTo("#f2-rings", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 1.2, ease: "power3.out" }, 0);
    tl.fromTo("#f2-logo", { opacity: 0, scale: 0.6 }, { opacity: 1, scale: 1, duration: 0.9, ease: "back.out(1.6)" }, 0.1);
    tl.fromTo("#f2-logo img", { y: 0 }, { y: -14, duration: 1.7, ease: "sine.inOut", yoyo: true, repeat: 1 }, 1.0);
    rise("#f2-pill", 1.4, 0.6, 40);
    ["#f2-c1","#f2-c2","#f2-c3"].forEach((s, i) => pop(s, 3.0 + i * 0.18, 0.45));
""")

# 03 — /start
FRAMES["03-start"] = (5, """
.f3-nos { position:absolute; left:60px; right:60px; top:440px; display:flex; justify-content:center; gap:16px; }
.f3-no { position:relative; font-size:30px; color:#4A5878; }
.f3-strike { position:absolute; left:18px; right:18px; top:50%; height:5px; margin-top:-2px; border-radius:3px; background:#dc2626; }
.f3-phone-wrap { position:absolute; inset:0; }
#f3-phone { top:580px; height:980px; }
""", """
    <div class="head"><span class="eyebrow" id="f3-eb">USP 01 · Tanpa ribet</span><span class="h2" id="f3-h">Tanpa install. <span class="b nl">Tanpa akun.</span></span></div>
    <div class="f3-nos">
      <span class="chip f3-no" id="f3-n1">Download app<i class="f3-strike" id="f3-k1"></i></span>
      <span class="chip f3-no" id="f3-n2">Email<i class="f3-strike" id="f3-k2"></i></span>
      <span class="chip f3-no" id="f3-n3">Password<i class="f3-strike" id="f3-k3"></i></span>
    </div>
    <div class="f3-phone-wrap" id="f3-wrap">""" + phone(
        '<div class="msg me" id="f3-me">/start</div><div class="msg bot" id="f3-bot">Halo! 👋 Langsung catat aja, contoh: <b>25rb makan siang</b></div>',
        '<span id="f3-type"></span><i class="caret" id="f3-caret"></i>', pid="f3-phone") + """
    </div>
""", """
    rise("#f3-eb", 0.0, 0.5, 30); rise("#f3-h", 0.1, 0.6, 40);
    ["#f3-n1","#f3-n2","#f3-n3"].forEach((s, i) => pop(s, 0.3 + i * 0.12, 0.4));
    ["#f3-k1","#f3-k2","#f3-k3"].forEach((s, i) => tl.fromTo(s, { scaleX: 0, transformOrigin: "left center" }, { scaleX: 1, duration: 0.3, ease: "power2.out" }, 0.8 + i * 0.3));
    tl.to(".f3-no", { opacity: 0.55, duration: 0.3 }, 1.8);
    tl.fromTo("#f3-wrap", { opacity: 0, y: 260 }, { opacity: 1, y: 0, duration: 0.8, ease: "power3.out" }, 1.6);
    typeInto("#f3-type", "/start", 2.4, 9);
    tl.fromTo("#f3-me", { opacity: 0, y: 30, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: "back.out(1.6)" }, 3.15);
    tl.set("#f3-type", { opacity: 0 }, 3.15);
    tl.fromTo("#f3-bot", { opacity: 0, y: 30, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.45, ease: "back.out(1.6)" }, 3.6);
    tl.fromTo("#f3-wrap", { scale: 1 }, { scale: 1.035, duration: 1.4, ease: "sine.inOut" }, 3.6);
""")

# 04 — chat parser
FRAMES["04-chat"] = (6.5, """
#f4-phone { top:540px; height:860px; left:200px; width:680px; }
.f4-card { max-width:92%; }
.f4-ok { display:block; font-family:"Fredoka", sans-serif; font-weight:600; font-size:36px; color:#03A372; }
.f4-amt { display:block; margin-top:6px; font-size:34px; } .f4-amt b { font-weight:800; }
.f4-meta { display:block; font-size:24px; color:#8A96B0; font-weight:600; }
.f4-btns { display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:16px; }
.f4-btn { background:#EEF5FE; color:#0B4DB7; border-radius:16px; padding:13px 8px; text-align:center; font-size:23px; font-weight:800; }
.f4-btn.w { grid-column:span 2; }
.f4-timer { position:absolute; left:0; right:0; top:450px; text-align:center; }
.f4-timer span { display:inline-block; padding:12px 30px; border-radius:100px; background:#0E1A3A; color:#fff; font-weight:800; font-size:30px; }
.f4-chips { position:absolute; inset:0; }
.f4-chips .chip { position:absolute; font-size:30px; padding:14px 26px; }
""", """
    <div class="head"><span class="eyebrow" id="f4-eb">USP 02 · Bahasa sehari-hari</span><span class="h2" id="f4-h">Chat biasa. <span class="g nl">Langsung tercatat.</span></span></div>
    <div class="f4-timer"><span id="f4-timer">⏱ 3 detik</span></div>
""" + phone(
        '<div class="msg me" id="f4-me">25rb makan siang</div>'
        '<div class="msg bot f4-card" id="f4-card"><span class="f4-ok">✓ Tercatat</span><span class="f4-amt">🍜 Makan · <b>Rp 25.000</b></span>'
        '<span class="f4-meta">Dompet: Tunai · Hari ini</span><div class="f4-btns"><span class="f4-btn">Ubah Kategori</span><span class="f4-btn">Ubah Dompet</span><span class="f4-btn w">↩ Urungkan</span></div></div>',
        '<span id="f4-type"></span><i class="caret" id="f4-caret"></i>', pid="f4-phone") + """
    <div class="f4-chips">
      <span class="chip" id="f4-p1" style="left:40px; top:640px">1,5jt</span>
      <span class="chip" id="f4-p2" style="left:860px; top:600px">150k</span>
      <span class="chip" id="f4-p3" style="left:30px; top:900px">35.000</span>
      <span class="chip" id="f4-p4" style="left:830px; top:930px">kemarin</span>
      <span class="chip" id="f4-p5" style="left:50px; top:1180px">gojek</span>
      <span class="chip" id="f4-p6" style="left:800px; top:1230px">gopay</span>
      <span class="chip" id="f4-p7" style="left:330px; top:1440px">indomaret</span>
    </div>
""", """
    rise("#f4-eb", 0.0, 0.5, 30); rise("#f4-h", 0.1, 0.6, 40);
    tl.fromTo("#f4-phone", { opacity: 0, y: 200 }, { opacity: 1, y: 0, duration: 0.8, ease: "power3.out" }, 0.2);
    typeInto("#f4-type", "25rb makan siang", 1.0, 11);
    tl.set("#f4-type", { opacity: 0 }, 2.55);
    tl.fromTo("#f4-me", { opacity: 0, y: 30, scale: 0.9 }, { opacity: 1, y: 0, scale: 1, duration: 0.35, ease: "back.out(1.6)" }, 2.55);
    pop("#f4-timer", 3.0, 0.4);
    tl.fromTo("#f4-card", { opacity: 0, y: 40, scale: 0.85 }, { opacity: 1, y: 0, scale: 1, duration: 0.55, ease: "back.out(1.5)", transformOrigin: "left top" }, 3.2);
    ["#f4-p1","#f4-p2","#f4-p3","#f4-p4","#f4-p5","#f4-p6","#f4-p7"].forEach((s, i) => pop(s, 4.6 + i * 0.16, 0.4));
    tl.fromTo("#f4-phone", { scale: 1 }, { scale: 1.03, duration: 2.2, ease: "sine.inOut" }, 4.2);
""")

# 05 — Jatah Aman Harian
FRAMES["05-jatah"] = (7, """
#f5-phone { position:absolute; left:180px; width:720px; top:520px; height:900px; border-radius:64px; background:#fff; border:10px solid #fff;
  box-shadow:0 40px 90px rgba(11,77,183,.22), 0 0 0 2px rgba(30,139,240,.18); overflow:hidden; }
.f5-app { position:absolute; left:0; right:0; top:128px; bottom:0; padding:40px 44px; background:#fff; }
.f5-label { display:block; font-size:30px; font-weight:700; color:#4A5878; }
.f5-num { display:block; font-family:"Fredoka", sans-serif; font-weight:700; font-size:132px; letter-spacing:-.03em; color:#03A372; line-height:1.1; margin:6px 0 14px; }
.f5-track { height:28px; border-radius:6px; background:rgba(30,139,240,.10); margin-top:40px; overflow:hidden; }
.f5-fill { display:block; height:100%; width:62%; border-radius:6px; background:linear-gradient(90deg,#03A372,#23CE95); }
.f5-cap { display:flex; justify-content:space-between; font-size:24px; font-weight:700; color:#5E6B88; margin-top:12px; }
.f5-row { display:flex; justify-content:space-between; padding:22px 0; border-bottom:2px solid #EEF2F8; font-size:30px; font-weight:600; }
.f5-row b { font-weight:800; }
.f5-trio { position:absolute; left:40px; right:40px; top:1460px; display:flex; justify-content:center; gap:16px; }
.f5-trio .chip { font-size:30px; }
.f5-trio .on { background:#03A372; color:#fff; border-color:#03A372; }
.f5-trio .amb { color:#B77B00; } .f5-trio .red { color:#dc2626; }
""", """
    <div class="head"><span class="eyebrow" id="f5-eb">USP 03 · Satu angka</span><span class="h2" id="f5-h">Aman nggak <span class="g">hari ini?</span></span></div>
    <div id="f5-phone">
      <div class="tg-top"><div class="ava"><img src="assets/pantauangmu-mascot.png" alt=""></div><div><span class="tg-name">PantaUangmu</span><span class="tg-sub">mini app</span></div></div>
      <div class="f5-app">
        <span class="f5-label">Jatah Aman Harian</span>
        <span class="f5-num" id="f5-num">Rp 0</span>
        <span class="pill-g" id="f5-pill">● AMAN</span>
        <div class="f5-track"><i class="f5-fill" id="f5-fill"></i></div>
        <div class="f5-cap"><span>Gajian 25 Okt</span><span>8 hari lagi</span></div>
        <div style="margin-top:24px">
          <div class="f5-row" id="f5-r1"><span>🍜 Makan siang</span><b>−Rp 25.000</b></div>
          <div class="f5-row" id="f5-r2"><span>🛵 Gojek</span><b>−Rp 18.000</b></div>
          <div class="f5-row" id="f5-r3"><span>☕ Kopi</span><b>−Rp 22.000</b></div>
        </div>
      </div>
    </div>
    <div class="f5-trio"><span class="chip on" id="f5-t1">● Aman</span><span class="chip amb" id="f5-t2">● Hati-hati</span><span class="chip red" id="f5-t3">● Melampaui</span></div>
""", """
    rise("#f5-eb", 0.0, 0.5, 30); rise("#f5-h", 0.1, 0.6, 40);
    tl.fromTo("#f5-phone", { opacity: 0, y: 220 }, { opacity: 1, y: 0, duration: 0.8, ease: "power3.out" }, 0.3);
    const numEl = document.querySelector("#f5-num"); const c = { v: 0 };
    tl.fromTo(c, { v: 0 }, { v: 87500, duration: 2.0, ease: "power3.out",
      onUpdate: () => { numEl.textContent = "Rp " + (Math.round(c.v / 500) * 500).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, "."); } }, 1.4);
    pop("#f5-pill", 3.1, 0.45);
    tl.fromTo("#f5-fill", { scaleX: 0, transformOrigin: "left center" }, { scaleX: 1, duration: 1.2, ease: "power2.out" }, 3.6);
    ["#f5-r1","#f5-r2","#f5-r3"].forEach((s, i) => rise(s, 4.2 + i * 0.25, 0.4, 24));
    ["#f5-t1","#f5-t2","#f5-t3"].forEach((s, i) => pop(s, 5.4 + i * 0.18, 0.4));
    tl.fromTo("#f5-phone", { scale: 1 }, { scale: 1.03, duration: 2.4, ease: "sine.inOut" }, 4.4);
""")

# 06 — Buku bersama
FRAMES["06-bersama"] = (6, """
#f6-phone { top:580px; height:880px; }
#f6-phone .chat { gap:14px; padding:24px 24px; }
#f6-phone .msg { padding:16px 24px; font-size:29px; }
.f6-avs { position:absolute; left:0; right:0; top:410px; display:flex; justify-content:center; }
.f6-av { width:110px; height:110px; border-radius:50%; border:6px solid #F4F8FF; margin-left:-22px; display:flex; align-items:center; justify-content:center;
  font-family:"Fredoka", sans-serif; font-weight:600; font-size:44px; color:#fff; }
.f6-total { position:absolute; left:0; right:0; top:1495px; text-align:center; }
.f6-total span { display:inline-block; padding:18px 36px; border-radius:100px; background:#0E1A3A; color:#fff; font-weight:800; font-size:32px; }
.f6-total b { color:#23CE95; }
.f6-by { display:block; font-size:23px; color:#5E6B88; font-weight:700; margin-top:4px; }
.f6-ok { color:#03A372; font-weight:800; }
""", """
    <div class="head"><span class="eyebrow" id="f6-eb">USP 04 · Buku bersama</span><span class="h2" id="f6-h">Bareng <span class="b">lebih rapi.</span></span></div>
    <div class="f6-avs">
      <span class="f6-av" id="f6-a1" style="background:#C25E0C">R</span>
      <span class="f6-av" id="f6-a2" style="background:#E255A1">N</span>
      <span class="f6-av" id="f6-a3" style="background:#1E8BF0">+3</span>
    </div>
""" + phone(
        '<div class="msg bot" id="f6-m1"><span class="who" style="color:#C25E0C">Raka</span>25rb galon</div>'
        '<div class="msg bot" id="f6-m2"><span class="who" style="color:#1E8BF0">PantaUangmu</span><span class="f6-ok">✓ Rp 25.000</span> · Rumah<span class="f6-by">dicatat oleh Raka</span></div>'
        '<div class="msg bot" id="f6-m3"><span class="who" style="color:#E255A1">Nabila</span>120rb belanja mingguan</div>'
        '<div class="msg bot" id="f6-m4"><span class="who" style="color:#1E8BF0">PantaUangmu</span><span class="f6-ok">✓ Rp 120.000</span> · Belanja<span class="f6-by">dicatat oleh Nabila</span></div>',
        '<span class="ph">Tulis pesan…</span>', name="Kos Melati 🏠", sub="5 anggota · PantaUangmu", ava="🏠", pid="f6-phone") + """
    <div class="f6-total"><span id="f6-total">Total minggu ini <b>Rp 145.000</b></span></div>
""", """
    rise("#f6-eb", 0.0, 0.5, 30); rise("#f6-h", 0.1, 0.6, 40);
    ["#f6-a1","#f6-a2","#f6-a3"].forEach((s, i) => pop(s, 0.5 + i * 0.15, 0.45));
    tl.fromTo("#f6-phone", { opacity: 0, y: 220 }, { opacity: 1, y: 0, duration: 0.8, ease: "power3.out" }, 0.6);
    ["#f6-m1","#f6-m2"].forEach((s, i) => tl.fromTo(s, { opacity: 0, y: 30, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(1.6)" }, 1.4 + i * 0.9));
    ["#f6-m3","#f6-m4"].forEach((s, i) => tl.fromTo(s, { opacity: 0, y: 30, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: 0.4, ease: "back.out(1.6)" }, 3.5 + i * 0.9));
    pop("#f6-total", 5.1, 0.45);
""")

# 07 — MVP grid
FRAMES["07-mvp"] = (5.5, """
.f7-grid { position:absolute; left:70px; right:70px; top:470px; display:grid; grid-template-columns:1fr 1fr; gap:28px; }
.f7-card { background:#fff; border:2px solid rgba(30,139,240,.16); border-radius:34px; padding:36px 34px; min-height:280px;
  box-shadow:0 14px 34px rgba(11,77,183,.08); }
.f7-ic { display:flex; width:84px; height:84px; border-radius:24px; align-items:center; justify-content:center; font-size:46px; background:rgba(30,139,240,.10); margin-bottom:20px; }
.f7-card:nth-child(even) .f7-ic { background:rgba(3,163,114,.12); }
.f7-t { display:block; font-family:"Fredoka", sans-serif; font-weight:600; font-size:40px; line-height:1.12; }
.f7-d { display:block; margin-top:8px; font-size:26px; font-weight:600; color:#4A5878; line-height:1.3; }
.f7-free { position:absolute; left:0; right:0; top:1500px; text-align:center; }
.f7-free span { font-size:34px; padding:18px 40px; }
""", """
    <div class="head"><span class="eyebrow" id="f7-eb">MVP · Siap dipakai</span><span class="h2" id="f7-h">Semua yang <span class="b">kamu butuh.</span></span></div>
    <div class="f7-grid">
      <div class="f7-card" id="f7-c1"><span class="f7-ic">💬</span><span class="f7-t">Chat & Mini App</span><span class="f7-d">Catat, edit, urungkan</span></div>
      <div class="f7-card" id="f7-c2"><span class="f7-ic">📊</span><span class="f7-t">Ringkasan & grafik</span><span class="f7-d">Hari, minggu, bulan</span></div>
      <div class="f7-card" id="f7-c3"><span class="f7-ic">👛</span><span class="f7-t">Banyak dompet</span><span class="f7-d">Tunai, bank, e-wallet</span></div>
      <div class="f7-card" id="f7-c4"><span class="f7-ic">🎯</span><span class="f7-t">Anggaran</span><span class="f7-d">Peringatan 80% & 100%</span></div>
      <div class="f7-card" id="f7-c5"><span class="f7-ic">⏰</span><span class="f7-t">Pengingat harian</span><span class="f7-d">Jam bisa diatur</span></div>
      <div class="f7-card" id="f7-c6"><span class="f7-ic">🔒</span><span class="f7-t">Ekspor CSV</span><span class="f7-d">Hapus akun kapan saja</span></div>
    </div>
    <div class="f7-free"><span class="pill-g" id="f7-free">PENCATATAN INTI SELALU GRATIS</span></div>
""", """
    rise("#f7-eb", 0.0, 0.5, 30); rise("#f7-h", 0.1, 0.6, 40);
    ["#f7-c1","#f7-c2","#f7-c3","#f7-c4","#f7-c5","#f7-c6"].forEach((s, i) =>
      tl.fromTo(s, { opacity: 0, y: 70, scale: 0.92 }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "back.out(1.5)" }, 0.8 + i * 0.5));
    pop("#f7-free", 4.1, 0.5);
""")

# 08 — CTA (final frame, holds)
FRAMES["08-cta"] = (5, """
.f8-rings { position:absolute; left:140px; top:200px; width:800px; height:800px; }
.f8-ring { position:absolute; inset:0; border-radius:50%; border:2px solid rgba(30,139,240,.16); }
.f8-ring.r2 { inset:100px; border-color:rgba(3,163,114,.18); }
.f8-logo { position:absolute; left:190px; width:700px; top:260px; }
.f8-logo img { width:700px; display:block; }
.f8-lines { position:absolute; left:60px; right:60px; top:880px; text-align:center; }
.f8-l { display:block; font-family:"Fredoka", sans-serif; font-weight:700; font-size:108px; line-height:1.12; letter-spacing:-.02em; }
.f8-l .b { color:#1E8BF0; } .f8-l .g { color:#03A372; }
.f8-cta { position:absolute; left:0; right:0; top:1250px; text-align:center; }
.f8-btn { display:inline-flex; align-items:center; gap:22px; padding:34px 60px; border-radius:100px; background:#1E8BF0; color:#fff;
  font-weight:800; font-size:48px; box-shadow:0 24px 60px rgba(30,139,240,.40); }
.f8-sub { display:block; margin-top:34px; font-size:32px; font-weight:700; color:#4A5878; }
""", f"""
    <div class="f8-rings" id="f8-rings"><div class="f8-ring"></div><div class="f8-ring r2"></div></div>
    <div class="f8-logo" id="f8-logo"><img src="assets/pantauangmu-lockup.png" alt="PantaUangmu"></div>
    <div class="f8-lines"><span class="f8-l" id="f8-l1">Catat <span class="b">3 detik.</span></span><span class="f8-l" id="f8-l2">Paham <span class="g">10 detik.</span></span></div>
    <div class="f8-cta"><span class="f8-btn" id="f8-btn">{PLANE}Buka Telegram → /start</span><span class="f8-sub" id="f8-sub">Gratis. Tanpa install. Tanpa akun baru.</span></div>
""", """
    tl.fromTo("#f8-rings", { opacity: 0, scale: 0.5 }, { opacity: 1, scale: 1, duration: 1.0, ease: "power3.out" }, 0);
    tl.fromTo("#f8-logo", { opacity: 0, scale: 0.85 }, { opacity: 1, scale: 1, duration: 0.8, ease: "back.out(1.5)" }, 0.05);
    rise("#f8-l1", 1.2, 0.55, 50); rise("#f8-l2", 1.8, 0.55, 50);
    pop("#f8-btn", 3.0, 0.55);
    tl.fromTo("#f8-btn", { scale: 1 }, { scale: 1.04, duration: 0.6, ease: "sine.inOut", yoyo: true, repeat: 1 }, 3.6);
    rise("#f8-sub", 3.4, 0.5, 30);
""")

for fid, (old, css, body, js) in FRAMES.items():
    (OUT / f"{fid}.html").write_text(frame(fid, old, css, body, js))
    print("wrote", fid)
