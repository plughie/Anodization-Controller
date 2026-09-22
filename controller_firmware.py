"""Untested conceptual controller sketch extracted from the design note.

This is not production firmware. Hardware interfaces, validation, fault
handling, safety review, and all process limits remain to be implemented and
verified.
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


state = "IDLE"   # IDLE -> RECIPE -> HOMING -> TOUCHDOWN -> SETTLE -> SWEEP -> CLEAR -> DONE | FAULT
v_peak = 0.0


def fail_safe_trip(reason):
    global state
    output_off()             # Q1 first; hardware latch remains authoritative
    hold_axis()
    set_k1(False)
    record_fault(reason)
    state = "FAULT"


def build_table(start_idx, end_idx, spread):
    """Build a voltage/fraction table from validated palette centers."""
    band = PALETTE[start_idx:end_idx + 1]
    if not band:
        raise ValueError("empty recipe")
    centers = [(c[1] + c[2]) / 2 for c in band]
    if spread == "LINEAR":
        if len(centers) < 2 or centers[0] >= centers[-1]:
            raise ValueError("LINEAR requires two increasing endpoints")
        return [(centers[0], 0.0), (centers[-1], 1.0)]
    if spread != "EQUAL_BANDS":
        raise ValueError("unknown spread mode")
    if len(centers) == 1:
        return [(centers[0], 0.0), (centers[0], 1.0)]

    # n colors produce n equal physical bands. Intermediate voltages are
    # boundaries between adjacent validated color centers.
    table = [(centers[0], 0.0)]
    n = len(centers)
    for k in range(1, n):
        boundary = (centers[k - 1] + centers[k]) / 2
        table.append((boundary, k / n))
    table.append((centers[-1], 1.0))
    return table


# --- IDLE / RECIPE: encoder scrolls, SELECT commits, BACK steps up. ---
length_mm = clamp(flash.load("length", 47), 10, 99)
TABLE = build_table(start_idx, end_idx, spread)
band_count = end_idx - start_idx + 1
if spread == "EQUAL_BANDS" and length_mm / band_count < 1.5:
    oled.warn("band width < 1.5mm")

if select_held(1000):                         # deliberate start
    validate_interlocks_closed()
    validate_recipe(TABLE, V_MAX_SOFT)
    part_length = length_mm                 # LATCH: geometry frozen
    v_start, v_end = TABLE[0][0], TABLE[-1][0]
    flash.save("length", length_mm)
    state = "HOMING"

# --- TOUCHDOWN: find the bath surface with a validated low voltage. ---
if state == "HOMING":
    home_axis_with_limits()
    state = "TOUCHDOWN"
    oled.coach(TOUCHDOWN_V)
    enable_output_only_if_interlocks_are_closed()
touchdown_deadline = monotonic() + TOUCHDOWN_TIMEOUT
while state == "TOUCHDOWN":
    v, i = ads_read()
    if v > V_MAX_SOFT or latch_set() or bottom_endstop():
        fail_safe_trip("touchdown guard")
        break
    if i >= I_TOUCH:
        surface_pos = pos_actual
        break
    if monotonic() >= touchdown_deadline:
        fail_safe_trip("touchdown timeout")
        break
    descend(0.2)                            # mm/s, bounded by endstops

# --- SETTLE: pre-form the whole part at v_start, fully immersed. ---
if state == "TOUCHDOWN":
    fully_submerged_pos = surface_pos + part_length + CLEARANCE
    cutoff_pos = surface_pos + ARC_MARGIN
    travel_span = fully_submerged_pos - cutoff_pos
    descend_to(fully_submerged_pos, bounded=True)
    state = "SETTLE"
    oled.coach(v_start)
    wait_until(current_tapered(), timeout=SETTLE_TIMEOUT)
    if not voltage_in_window(v_start, tol):
        fail_safe_trip("settle voltage")
    else:
        arm_open_circuit_channel()
        state = "SWEEP"

# --- Sweep loop, nominally 20 Hz; every iteration must complete safely. ---
while state == "SWEEP":
    v, i = ads_read()
    v_peak = max(v_peak, v)                  # oxide remembers only the peak
    if v > V_MAX_SOFT or latch_set():
        fail_safe_trip("voltage or hardware latch")
        break
    if i > I_LIMIT or (i < I_MIN and v > OPEN_VOLTAGE):
        fail_safe_trip("current fault")
        break

    frac = clamp(interp_inverse(TABLE, v_peak), 0.0, 1.0)
    pos_cmd = fully_submerged_pos - frac * travel_span
    if pos_actual <= cutoff_pos:
        output_off()
        state = "CLEAR"
        break
    if abs(pos_cmd - pos_actual) > 0.1:
        move_towards(pos_cmd, max_rate=1.0)

    if MODE == "COACHED":
        wanted = interp(TABLE, frac)
        oled.coach(wanted, actual=v, band=band_name_at(wanted))
        if v > wanted + tol:
            fail_safe_trip("voltage too high for position")
            break
        if abs(v - wanted) > tol:
            hold_axis()
            buzzer.chirp()
    if back_pressed():
        fail_safe_trip("operator abort")
        break
    sleep(0.05)


# Log t, pos, v, v_peak, i, interlock state, and the active recipe to CSV.
