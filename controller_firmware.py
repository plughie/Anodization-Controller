"""Conceptual controller sketch extracted from anodizer-controller-design.md.

This file is not production firmware. It contains the palette example and the
firmware pseudocode from the design note; hardware drivers, validation,
fault-handling implementation, and safety review are still required.
"""

# Copyright © 2026 Duv McIntyre
# SPDX-License-Identifier: CC-BY-4.0
# Bug-Mag.net project: http://bug-mag.net

PALETTE = [                      # name,      V_low, V_high
    ("BRONZE",   15, 18), ("VIOLET",   20, 25),
    ("BLUE",     30, 40), ("TEAL",     45, 50),
    ("GOLD",     52, 58), ("ROSE",     62, 68),
    ("MAGENTA",  75, 82), ("CYAN",     86, 92),
    ("GREEN",    96, 104),
]


state = IDLE   # IDLE -> RECIPE -> HOMING -> TOUCHDOWN -> SETTLE -> SWEEP -> CLEAR -> DONE | FAULT
v_peak = 0.0

# --- build the position->voltage map from the recipe ---
def build_table(start_idx, end_idx, spread):
    band = PALETTE[start_idx:end_idx + 1]
    mid  = lambda c: (c[1] + c[2]) / 2          # centre of a color window
    if spread == LINEAR:
        return [(mid(band[0]), 0.0), (mid(band[-1]), 1.0)]
    n = len(band)                               # EQUAL BANDS
    return [(mid(c), k / (n - 1)) for k, c in enumerate(band)]

# --- IDLE / RECIPE: encoder scrolls, SELECT commits, BACK steps up ---
length_mm = flash.load("length", 47)            # encoder is relative: persist it
TABLE = build_table(start_idx, end_idx, spread)
for name, lo, hi in band_edges(TABLE):
    if (hi - lo) * length_mm < 1.5:
        oled.warn(f"{name} band < 1.5mm")       # meniscus will smear it

if select_held(1000):                           # deliberate start
    part_length = length_mm                     # LATCH - geometry frozen
    v_start, v_end = TABLE[0][0], TABLE[-1][0]
    assert v_end <= V_MAX                       # 105 V ceiling, breakdown risk
    flash.save("length", length_mm)
    state = HOMING

# --- TOUCHDOWN: find the bath surface with the shunt ---
oled.coach(15)                                  # below the first color threshold
while i < I_TOUCH:
    descend(0.2)                                # mm/s
surface_pos = pos_actual
descend_to(surface_pos + part_length + CLEARANCE)

# --- SETTLE: pre-form the whole part at v_start, fully immersed ---
oled.coach(v_start)
wait_until(current_tapered() and abs(v - v_start) < tol)
arm_open_circuit_channel()                      # un-blank now that we're wet

# --- 20 Hz loop during SWEEP ---
v, i = ads_read()                               # volts at cell, amps
v_peak = max(v_peak, v)                         # oxide remembers only the peak

frac    = interp_inverse(TABLE, v_peak)         # volts -> fraction of length
pos_cmd = surface_pos - frac * part_length       # -> carriage millimetres
if abs(pos_cmd - pos_actual) > 0.1:              # deadband: no stepper chatter
    move_towards(pos_cmd, max_rate=1.0)          # mm/s ceiling

if MODE == COACHED:
    travelled = surface_pos - pos_actual
    wanted = interp(TABLE, (travelled + step_ahead) / part_length)
    oled.coach(wanted, actual=v, band=band_name_at(wanted))
    if abs(v - wanted) > tol:
        hold_axis()
        buzzer.chirp()                           # eyes on the bath, not the panel

if latch_set():                                  # fault; HW already cut Q1
    fault(latch_channel())
if back_pressed():
    abort()                                      # graceful: output off, retract
if i > I_LIMIT:
    fault("overcurrent")                        # software backstop only
if i < I_MIN and v > 10:
    fault("contact lost")                       # hardware channel is primary
if dv_dt > SLEW_MAX:
    fault("knob too fast")
if surface_pos - pos_actual > part_length - arc_margin:
    output_off()                                 # Q1 first, then K1

# Log t, pos, v, v_peak, i, and the active recipe to CSV over USB every run.
