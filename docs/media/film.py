"""Kept, 30 s: "One step out." A paper maze that folds flat.
Blender -b --python film.py -- still 2 7 12 17 22 28
Blender -b --python film.py -- frames 0 30   then   -- edit
"""
import bpy, math, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "kit"))
import kit as K

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = "/Users/prathamranjan/Documents/Codex/2026-11-02/w/kept/docs/screenshots/"
R = math.radians

s = K.reset(samples=32)
K.world("#d8c6a8", 0.10)

# ---------- palette: kraft paper, cream card, coffee, stamp red ----------
KRAFT, CARD, WALL, INK, RED, COFFEE, TEAL = "#9c6b3f", "#f1e6d0", "#fbf6ea", "#3b2a1e", "#c8372d", "#3d2416", "#2bb6a8"
m_kraft = K.mat("kraft", KRAFT, 0.85)
m_card = K.mat("card", CARD, 0.8)
m_wall = K.mat("wall", WALL, 0.75)
m_ink = K.mat("ink", INK, 0.7)
m_red = K.mat("red", RED, 0.6)
m_edge = K.mat("edge", "#d9c9a8", 0.8)

K.plane("table", (8, 8), (0, 0, 0), m_kraft)
K.box("board", (1.04, 0.60, 0.006), (0, 0, 0.003), m_card, 0.002)
Z0, H, T = 0.006, 0.055, 0.004


def wall_x(name, y, x0, x1, word=None, h=H, size=0.026):
    """A paper wall running along X, hinged at its base so it can fold flat (rotate +90 degrees about X)."""
    e = K.empty(name, ((x0 + x1) / 2, y, Z0))
    K.box(name + "_b", (x1 - x0, T, h), (0, 0, h / 2), m_wall, 0.0008, e)
    if word:
        K.text(name + "_t", word, size, (0, -T / 2 - 0.0006, h / 2), m_ink, "din", parent=e, spacing=1.08)
    return e


def wall_y(name, x, y0, y1, h=H):
    e = K.empty(name, (x, (y0 + y1) / 2, Z0))
    K.box(name + "_b", (T, y1 - y0, h), (0, 0, h / 2), m_wall, 0.0008, e)
    return e


folds = [
    (wall_x("w1", -0.14, -0.50, 0.30, "ARE YOU SURE?"), "x"),
    (wall_x("w2", 0.00, -0.30, 0.50, "CALL US TO CANCEL"), "x"),
    (wall_x("w3", 0.14, -0.50, 0.30, "WAIT!  50% OFF"), "x"),
    (wall_y("stub1", -0.10, -0.14, -0.05), "y"),
    (wall_y("stub2", 0.44, -0.14, 0.00), "y"),
    (wall_y("stub3", 0.10, -0.28, -0.20), "y"),
    (wall_y("stub4", -0.20, 0.06, 0.14), "y"),
]
wall_x("back", 0.28, -0.50, 0.50, "TAKE A SURVEY FIRST")
wall_x("front", -0.28, -0.50, 0.50, None, 0.02)
wall_y("left", -0.50, -0.14, 0.28, 0.03)
wall_y("right_a", 0.50, -0.28, -0.125, 0.03)
wall_y("right_b", 0.50, -0.015, 0.28, 0.03)
for i, (e, axis) in enumerate(folds):
    t = 9.7 + i * 0.28
    K.key(e, "rotation_euler", t, (0, 0, 0))
    K.key(e, "rotation_euler", t + 0.55, (R(90), 0, 0) if axis == "x" else (0, R(88), 0))

# the exit: a small paper door in the right edge, at the end of lane B
LANE_Y = -0.07
door = K.empty("door", (0.50, LANE_Y, Z0))
m_door = K.mat("doorframe", "#8a5a34", 0.7)
K.box("post_a", (0.012, 0.012, 0.085), (0, -0.055, 0.0425), m_door, 0.001, door)
K.box("post_b", (0.012, 0.012, 0.085), (0, 0.055, 0.0425), m_door, 0.001, door)
K.box("lintel", (0.012, 0.122, 0.012), (0, 0, 0.091), m_door, 0.001, door)
leaf = K.empty("leaf", (0, 0.049, 0), door)
K.box("leaf_b", (0.004, 0.098, 0.082), (0, -0.049, 0.041), K.mat("leafm", RED, 0.6), 0.0008, leaf)
K.ball("knob", 0.004, (-0.004, -0.085, 0.04), K.mat("brass", "#d9a441", 0.3, 0.9), leaf)
K.text("exit_t", "EXIT", 0.022, (-0.0026, -0.049, 0.062), K.mat("white", "#ffffff", 0.6), "din", rot=(R(90), 0, R(-90)), parent=leaf)
K.key(leaf, "rotation_euler", 21.7, (0, 0, 0)); K.key(leaf, "rotation_euler", 22.2, (0, 0, R(-105)))

# the member: a coffee-coloured marble, stuck, then free
mb = K.ball("marble", 0.018, (-0.44, -0.21, Z0 + 0.018), K.mat("marble", COFFEE, 0.15, coat=1.0))
Z = Z0 + 0.018
PATH = [(0.0, -0.44, -0.21), (1.6, 0.04, -0.21), (1.75, 0.02, -0.21), (2.0, 0.07, -0.215), (2.2, 0.05, -0.21),
        (2.6, -0.30, -0.21), (3.3, 0.36, -0.21), (3.7, 0.37, LANE_Y), (4.3, -0.06, LANE_Y), (4.45, -0.045, LANE_Y),
        (4.8, 0.40, LANE_Y), (4.95, 0.385, LANE_Y), (5.6, 0.05, LANE_Y), (14.2, 0.05, LANE_Y), (15.0, 0.15, LANE_Y),
        (20.9, 0.15, LANE_Y), (22.5, 0.52, LANE_Y), (23.6, 0.82, LANE_Y - 0.03)]
for t, x, y in PATH:
    K.key(mb, "location", t, (x, y, Z))

# the buyer's AI assistant: a small glowing token that hops up and rings the shop bell
bell = K.empty("bell", (-0.66, -0.21, 0))
K.cyl("bell_base", 0.04, 0.006, (0, 0, 0.003), K.mat("bellbase", "#2b211a", 0.5), bell)
dome = K.ball("bell_dome", 0.032, (0, 0, 0.006), K.mat("brass", "#d9a441", 0.3, 0.9), bell)
dome.scale = (1, 1, 0.7)
btn = K.cyl("bell_btn", 0.006, 0.014, (0, 0, 0.034), K.mat("brass", "#d9a441", 0.3, 0.9), bell)
K.key(btn, "location", 7.4, (0, 0, 0.034)); K.key(btn, "location", 7.5, (0, 0, 0.029)); K.key(btn, "location", 7.62, (0, 0, 0.034))
tok = K.box("token", (0.034, 0.034, 0.034), (-1.25, -0.21, 0.017), K.mat("token", TEAL, 0.3, emit=TEAL, emit_strength=1.6), 0.007)
hops = [(5.2, -1.25), (5.9, -1.05), (6.5, -0.88), (7.1, -0.745)]
for (t0, x0), (t1, x1) in zip(hops, hops[1:]):
    K.key(tok, "location", t0, (x0, -0.21, 0.017)); K.key(tok, "location", (t0 + t1) / 2, ((x0 + x1) / 2, -0.21, 0.10)); K.key(tok, "location", t1 - 0.05, (x1, -0.21, 0.017))
K.key(tok, "location", 7.25, (-0.705, -0.21, 0.12)); K.key(tok, "location", 7.4, (-0.66, -0.21, 0.058)); K.key(tok, "location", 7.5, (-0.66, -0.21, 0.053)); K.key(tok, "location", 7.62, (-0.66, -0.21, 0.058))
K.key(tok, "rotation_euler", 5.2, (0, 0, 0)); K.key(tok, "rotation_euler", 7.1, (0, 0, R(180)))

# one straight lane appears: red dashes from the marble to the door
for i in range(9):
    d = K.box("dash_%d" % i, (0.026, 0.007, 0.0012), (0.115 + i * 0.043, LANE_Y, Z0 + 0.0008), m_red, 0.0004)
    K.show(d, 12.2 + i * 0.14)
    K.pop(d, 12.2 + i * 0.14, 0.2)

# one offer: a card that stands up in the lane, and the owner's stamp beside it
offer = K.empty("offer", (0.235, LANE_Y + 0.03, Z0 + 0.0015))
K.box("offer_b", (0.12, 0.003, 0.08), (0, 0, 0.04), K.mat("offercard", "#fffdf6", 0.7), 0.001, offer)
K.text("offer_t1", "SKIP A MONTH", 0.017, (0, -0.0022, 0.053), m_ink, "din", parent=offer)
K.text("offer_t2", "instead?", 0.014, (0, -0.0022, 0.031), m_red, "georgia", parent=offer)
K.show(offer, 15.2, 21.0)
K.key(offer, "rotation_euler", 15.2, (R(90), 0, 0)); K.key(offer, "rotation_euler", 15.75, (R(-6), 0, 0)); K.key(offer, "rotation_euler", 15.95, (0, 0, 0))
K.key(offer, "rotation_euler", 20.4, (0, 0, 0)); K.key(offer, "rotation_euler", 20.9, (R(90), 0, 0))
stamp = K.empty("stamp", (0.37, -0.205, 0.40))
K.box("stamp_block", (0.11, 0.045, 0.018), (0, 0, 0.009), K.mat("wood", "#a0703f", 0.6), 0.002, stamp)
K.cyl("stamp_handle", 0.012, 0.06, (0, 0, 0.048), K.mat("wood", "#a0703f", 0.6), stamp, bevel=0.002)
K.ball("stamp_knob", 0.018, (0, 0, 0.085), K.mat("wood2", "#7b5230", 0.5), stamp)
stamp.rotation_euler = (0, 0, R(-8))
K.show(stamp, 16.2, 18.2)
for t, z in ((16.2, 0.40), (16.75, Z0 + 0.001), (16.95, Z0 + 0.001), (17.5, 0.42)):
    K.key(stamp, "location", t, (0.37, -0.205, z))
mark = K.empty("mark", (0.37, -0.205, Z0 + 0.0006))
mark.rotation_euler = (0, 0, R(-8))
K.text("mark_t", "ONE FAIR OFFER", 0.02, (0, 0, 0), m_red, "din", rot=(0, 0, 0), parent=mark, spacing=1.1)
for dx, dy, sx, sy in ((0, 0.016, 0.118, 0.002), (0, -0.016, 0.118, 0.002), (-0.058, 0, 0.002, 0.034), (0.058, 0, 0.002, 0.034)):
    K.box("mark_l", (sx, sy, 0.0004), (dx, dy, 0), m_red, 0, mark)
K.show(mark, 16.9)

# the member's phone, with the real member page (stamp card; "cancel here, any time")
ph = K.phone("phone", SHOTS + "member-375-light.png", loc=(0.70, 0.06, -0.3))
ph.rotation_euler = (R(-8), 0, R(-22))
ph.scale = (1.8, 1.8, 1.8)
K.show(ph, 22.4)
K.key(ph, "location", 22.4, (0.70, 0.06, -0.28)); K.key(ph, "location", 23.2, (0.70, 0.06, 0.015)); K.key(ph, "location", 23.4, (0.70, 0.06, 0.0))
focus = bpy.data.objects["phone_focus"]

# ---------- light: one warm window light, soft fill, like a craft table ----------
K.area("key", (-1.1, 0.7, 1.5), (0, 0, 0), 150, 1.4, "#ffe2b8")
K.area("fill", (0.8, -1.6, 0.9), (0, 0, 0), 22, 1.6, "#dfe8ff")
K.area("rim", (1.3, 0.9, 0.5), (0.4, 0, 0.05), 30, 0.8, "#ffd0a0")

# ---------- cameras ----------
c1 = K.camera("S01_maze", 40, (-0.20, -1.12, 0.86), (0.0, -0.03, 0.0), fstop=5.6)
K.key(c1, "location", 0.0, (-0.20, -1.12, 0.86)); K.key(c1, "location", 5.0, (-0.10, -1.02, 0.78))
c2 = K.camera("S02_bell", 60, (-0.98, -0.80, 0.30), (-0.74, -0.21, 0.035), fstop=4.0)
K.key(c2, "location", 5.0, (-0.98, -0.80, 0.30)); K.key(c2, "location", 9.0, (-0.90, -0.74, 0.27))
c3 = K.camera("S03_fold", 38, (0.05, -1.00, 1.00), (0.03, -0.02, 0.0), fstop=6.3)
K.key(c3, "location", 9.0, (0.05, -1.00, 1.00)); K.key(c3, "location", 15.0, (0.10, -0.92, 0.90))
c4 = K.camera("S04_offer", 55, (0.02, -0.72, 0.36), (0.27, -0.09, 0.035), fstop=5.0)
K.key(c4, "location", 15.0, (0.02, -0.72, 0.36)); K.key(c4, "location", 20.0, (0.07, -0.66, 0.33))
c5 = K.camera("S05_door", 45, (0.22, -0.90, 0.46), (0.56, -0.02, 0.09), fstop=5.6)
K.key(c5, "location", 20.0, (0.22, -0.90, 0.46)); K.key(c5, "location", 26.0, (0.34, -0.84, 0.42))
c6 = K.camera("S06_end", 40, (0.0, -1.05, 1.05), (0.05, -0.02, 0.0), fstop=6.3)
K.key(c6, "location", 26.0, (0.0, -1.05, 1.05)); K.key(c6, "location", 30.0, (0.0, -1.16, 1.16))
for c, t in ((c1, 0.0), (c2, 5.0), (c3, 9.0), (c4, 15.0), (c5, 20.0), (c6, 26.0)):
    K.cut(c, t)

# ---------- titles ----------
B = "#2a1a10"
K.title("Leaving a subscription shouldn't be a maze.", 0.5, 2.6, box=B)
K.title("$2.5 billion: Amazon's settlement over how Prime signs people up and lets them leave", 2.7, 4.9, 44, 0.16, box=B)
K.title("FTC v. Amazon, announced September 2025", 2.7, 4.9, 26, 0.085, font="mono", box=B)
K.title("Now AI assistants manage subscriptions for people.", 5.3, 8.9, box=B)
K.title("Kept gives a small shop one honest way out.", 9.4, 14.8, box=B)
K.title("One fair offer. Only if the owner's rules allow it.", 15.3, 19.8, box=B)
K.title("Say no, and it's cancelled on PayPal. No second ask.", 20.3, 25.9, box=B)
K.shade(26.2, 30.0, "#1c120b", 0.66)
K.title("Kept", 26.4, 30.0, 230, 0.60, font="georgia")
K.title("Cancelling is never blocked.", 26.8, 30.0, 60, 0.40)
K.title("PayPal sandbox demo  ·  pph-kept.onrender.com", 27.2, 30.0, 28, 0.30, font="mono")

# ---------- sound ----------
SFX = "/Users/prathamranjan/Documents/Codex/2026-11-02/w/groundtruth/video/public/sfx/"
K.sound("/Users/prathamranjan/Documents/Codex/2026-11-02/w/makegood-video/public/music/coffee-or-tea.mp3", 0.0, 0.5, fade_out=(28.0, 30.0))
for t in (1.7, 2.0, 4.4, 4.9):
    K.sound(SFX + "pop_dry.mp3", t, 0.35)
for t, _ in hops[1:]:
    K.sound(SFX + "pop_bubble.mp3", t - 0.05, 0.45)
K.sound(SFX + "ding_correct.mp3", 7.45, 0.7)
for i in range(len(folds)):
    K.sound(SFX + "whoosh_fast.mp3", 9.7 + i * 0.28, 0.3)
K.sound(SFX + "click_select.mp3", 15.7, 0.6)
K.sound(SFX + "impact_deep.mp3", 16.75, 0.5)
K.sound(SFX + "whoosh_trans.mp3", 21.7, 0.45)
K.sound(SFX + "confirm.mp3", 22.5, 0.7)
K.sound(SFX + "impact_logo.mp3", 26.35, 0.6)

K.run(os.path.join(HERE, "out"), "kept")
