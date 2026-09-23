"""Untested conceptual controller sketch for the Pico 1 / Pico WH target.

This is a design artifact, not production firmware. The hardware interfaces,
protection circuit, motion feedback, discharge detector, and process limits
must be designed, reviewed, and tested before any energized operation.

The simulator and this sketch use the same state contract:
IDLE -> HOMING -> TOUCHDOWN -> SUBMERGE -> SETTLE -> SWEEP/UNIFORM_HOLD -> DISCHARGE
-> RETRACT -> DONE/ABORTED, with FAULT latched until a deliberate reset.
"""

# Copyright © 2026 Duv McIntyre
# SPDX-License-Identifier: CC-BY-4.0
# Bug-Mag.net project: http://bug-mag.net

import math


# Vendor swatch labels and nominal voltages transcribed from image filenames
# on the product page; they are examples, not calibrated process limits.
PALETTE = [
    ("HIGH POLISH", 0, 0), ("DARK BRONZE", 15, 15), ("PURPLE", 22, 22),
    ("BLUE", 28, 28), ("SILVER BLUE", 40, 40), ("GOLD", 65, 65),
    ("ROSE GOLD", 70, 70), ("PINK", 75, 75), ("DARK FUCHSIA", 85, 85),
    ("BLURPLE", 92, 92), ("PURPLE TEAL", 95, 95), ("TEAL GREEN", 103, 103),
    ("GREEN", 105, 105),
]

STATE = "IDLE"
RUN_OUTCOME = None
FAULT_REASON = None
V_PEAK = 0.0
COACH_INDEX = 0
PART_LENGTH = 47
SURFACE_POS = None
FULLY_SUBMERGED_POS = None
CUTOFF_POS = None
DISCHARGE_DEADLINE = None

# Commissioning placeholders. They are intentionally conservative model
# parameters, not validated operating limits.
V_MAX_SOFT = 105.0
V_MAX_HARD = 108.0
TOUCHDOWN_MAX_V = 12.0
TOUCHDOWN_MIN_V = 0.5
TOUCHDOWN_TIMEOUT = 45.0
SETTLE_TIMEOUT = 30.0
DISCHARGE_TIMEOUT = 8.0
DISCHARGE_SAFE_V = 10.0
SETTLE_MIN_DWELL = 3.0
SETTLE_CURRENT_MAX = 0.050
SETTLE_SLOPE_TOL = 0.01
SETTLE_WINDOW_SAMPLES = 32
MIN_CONTACT_CURRENT = 0.005
COACH_DWELL = 1.0
POSITION_TOLERANCE = 0.1
POSITION_FAULT_TOLERANCE = 2.0
POSITION_FAULT_TIMEOUT = 3.0
ARC_MARGIN = 3.0
CLEARANCE = 5.0


def transition(next_state):
    """Change state and reset state-local timers in the real implementation."""
    global STATE
    STATE = next_state
    reset_state_timer()


def fail_safe_trip(reason):
    """Latch a fault and require discharge verification before any motion."""
    global FAULT_REASON, RUN_OUTCOME
    if FAULT_REASON is None:
        FAULT_REASON = reason
    RUN_OUTCOME = "FAULT"
    output_off()                 # Q1 command first; hardware latch is authoritative.
    set_k1(False)
    hold_axis()                  # A fault never authorizes motion implicitly.
    transition("DISCHARGE")
    record_fault(reason)


def safety_supervisor(state, v, i, now, target_v=None):
    """Common checks that must run before every active-state branch.

    The actual implementation must make these measurements independent enough
    to detect a stuck command. In particular, output-off is not discharge
    proof: the electrode-pair voltage and both interrupting devices are
    checked separately in DISCHARGE.
    """
    if state not in {"TOUCHDOWN", "SETTLE", "SWEEP", "UNIFORM_HOLD"}:
        return True
    if not interlocks_closed():
        fail_safe_trip("interlock opened; reset required")
        return False
    if hardware_trip_latched():
        fail_safe_trip("hardware protection latch")
        return False
    if not measurement_valid(v, i) or not math.isfinite(v) or not math.isfinite(i) or i < 0:
        fail_safe_trip("invalid measurement")
        return False
    if v > V_MAX_HARD or v > V_MAX_SOFT:
        fail_safe_trip("overvoltage ceiling")
        return False
    if i > current_limit() * 1.05:
        fail_safe_trip("overcurrent")
        return False
    if state == "SWEEP" and v > 10.0 and i < MIN_CONTACT_CURRENT:
        fail_safe_trip("open cell or contact")
        return False
    if target_v is not None and state in {"SETTLE", "SWEEP", "UNIFORM_HOLD"}:
        if abs(v - target_v) > voltage_tolerance():
            reset_position_fault_timer()
    return True


def build_table(start_idx, end_idx, spread):
    """Build a validated voltage/fraction table from palette centers."""
    if start_idx < 1 or end_idx >= len(PALETTE) or start_idx > end_idx:
        raise ValueError("choose anodized colors; HIGH POLISH at 0 V is not an anodizing recipe")
    band = PALETTE[start_idx:end_idx + 1]
    if not band:
        raise ValueError("empty recipe")
    centers = [(color[1] + color[2]) / 2 for color in band]
    if spread == "LINEAR":
        if len(centers) < 2 or centers[0] >= centers[-1]:
            raise ValueError("LINEAR requires two increasing endpoints")
        return [(centers[0], 0.0), (centers[-1], 1.0)]
    if spread != "EQUAL_BANDS":
        raise ValueError("unknown spread mode")
    if len(centers) == 1:
        return [(centers[0], 0.0), (centers[0], 1.0)]
    table = [(centers[0], 0.0)]
    for index in range(1, len(centers)):
        table.append(((centers[index - 1] + centers[index]) / 2, index / len(centers)))
    table.append((centers[-1], 1.0))
    return table


def wait_for_oxide_settle(target_v, timeout):
    """Require contact, valid measurements, decay, and stable dwell.

    A flat zero-current trace is not a successful formation plateau. The real
    implementation must use a calibrated filtered slope and leakage floor;
    this sketch requires current above the contact floor and below the
    commissioning plateau bound for the full dwell, with a hard timeout.
    """
    started = monotonic()
    stable_since = None
    samples = []
    while monotonic() - started < timeout:
        now = monotonic()
        v, i = ads_read()
        if not safety_supervisor("SETTLE", v, i, now, target_v):
            return False
        if not voltage_in_window(v, target_v, voltage_tolerance()):
            stable_since = None
            samples.clear()
            service_stop_path()
            sleep(0.05)
            continue
        if i < MIN_CONTACT_CURRENT:
            fail_safe_trip("open contact during settle")
            return False
        samples.append((now, i))
        samples = samples[-SETTLE_WINDOW_SAMPLES:]
        slope = estimate_filtered_log_slope(samples)
        if i <= SETTLE_CURRENT_MAX and abs(slope) <= SETTLE_SLOPE_TOL:
            stable_since = stable_since or now
            if now - stable_since >= SETTLE_MIN_DWELL:
                return True
        else:
            stable_since = None
        service_stop_path()
        sleep(0.05)
    fail_safe_trip("settle timeout")
    return False


def validate_touchdown():
    """Find the surface only at a separately verified low-energy setting."""
    deadline = monotonic() + TOUCHDOWN_TIMEOUT
    while monotonic() < deadline:
        v, i = ads_read()
        if not measurement_valid(v, i) or not math.isfinite(v) or not math.isfinite(i) or i < 0:
            fail_safe_trip("invalid touchdown measurement")
            return False
        if not interlocks_closed():
            fail_safe_trip("touchdown interlock")
            return False
        if v < TOUCHDOWN_MIN_V or v > TOUCHDOWN_MAX_V:
            fail_safe_trip("touchdown voltage outside low-energy window")
            return False
        if hardware_trip_latched() or v > V_MAX_HARD:
            fail_safe_trip("touchdown protection trip")
            return False
        if i >= MIN_CONTACT_CURRENT:
            return True
        descend(0.2)  # Bounded by endstops and a motion watchdog.
        service_stop_path()
        sleep(0.05)
    fail_safe_trip("touchdown timeout or no contact")
    return False


def verify_discharge(outcome):
    """Verify the electrode pair is safe before authorizing retraction/access."""
    global RUN_OUTCOME, DISCHARGE_DEADLINE, FAULT_REASON, STATE
    RUN_OUTCOME = outcome
    output_off()
    set_k1(False)
    DISCHARGE_DEADLINE = monotonic() + DISCHARGE_TIMEOUT
    safe_since = None
    transition("DISCHARGE")
    while monotonic() < DISCHARGE_DEADLINE:
        electrode_v = read_electrode_pair_voltage()
        q1_open = q1_state_is_off()
        k1_open = k1_state_is_off()
        now = monotonic()
        valid = (measurement_fresh("electrode_pair") and math.isfinite(electrode_v)
                 and electrode_v >= 0)
        if q1_open and k1_open and valid and electrode_v <= DISCHARGE_SAFE_V:
            safe_since = safe_since or now
        else:
            safe_since = None
        if safe_since is not None and now - safe_since >= 0.25:
            transition("RETRACT")
            return True
        service_stop_path()
        sleep(0.05)
    # Do not recurse through DISCHARGE or authorize retraction after a failed
    # verification. The fault remains visible until an explicit reset.
    FAULT_REASON = "discharge not verified"
    RUN_OUTCOME = "FAULT"
    STATE = "FAULT"
    hold_axis()
    record_fault(FAULT_REASON)
    return False


# --- Latched recipe and start sequence -----------------------------------
recipe = latch_recipe_from_ui()
TABLE = build_table(recipe.start_idx, recipe.end_idx, recipe.spread)
if recipe.mode == "UNIFORM" and recipe.start_idx != recipe.end_idx:
    raise ValueError("UNIFORM requires one selected color")
if recipe.spread == "EQUAL_BANDS" and recipe.length_mm / max(1, len(recipe.colors)) < 1.5:
    oled.warn("band width < 1.5 mm")

if select_held(1000):
    validate_interlocks_closed()
    validate_recipe(recipe, TABLE, V_MAX_SOFT)
    PART_LENGTH = recipe.length_mm       # Geometry and recipe are frozen for this run.
    V_PEAK = 0.0
    COACH_INDEX = 0
    SURFACE_POS = None
    transition("HOMING")


# --- HOMING / TOUCHDOWN ---------------------------------------------------
if STATE == "HOMING":
    home_axis_with_limits()
    transition("TOUCHDOWN")
    oled.coach(TOUCHDOWN_MIN_V, TOUCHDOWN_MAX_V)
    enable_output_only_if_interlocks_are_closed()
    if validate_touchdown():
        SURFACE_POS = pos_actual
        FULLY_SUBMERGED_POS = SURFACE_POS + PART_LENGTH + CLEARANCE
        CUTOFF_POS = SURFACE_POS + ARC_MARGIN
        descend_to(FULLY_SUBMERGED_POS, bounded=True)
        transition("SETTLE")


# --- SETTLE / PROCESS -----------------------------------------------------
if STATE == "SETTLE":
    target_v = TABLE[0][0]
    oled.coach(target_v)
    if wait_for_oxide_settle(target_v, SETTLE_TIMEOUT):
        arm_open_circuit_channel()
        if recipe.mode == "UNIFORM":
            transition("UNIFORM_HOLD")
        else:
            transition("SWEEP")


while STATE in {"SWEEP", "UNIFORM_HOLD"}:
    v, i = ads_read()
    V_PEAK = max(V_PEAK, v)
    frac = clamp(interp_inverse(TABLE, v), 0.0, 1.0)
    COACH_INDEX = segment_index_at_fraction(TABLE, frac)
    wanted = next_setpoint(TABLE, COACH_INDEX)
    if not safety_supervisor(STATE, v, i, monotonic(), wanted):
        break

    if STATE == "UNIFORM_HOLD":
        hold_axis_at(FULLY_SUBMERGED_POS)
        oled.coach(wanted, actual=v, message="uniform formed; BACK to extract")
    elif recipe.control_mode == "COACHED":
        target_pos = FULLY_SUBMERGED_POS - frac * (FULLY_SUBMERGED_POS - CUTOFF_POS)
        oled.coach(wanted, actual=v, band=band_name_at(v), message="carriage tracks voltage up and down")
        if abs(pos_actual - target_pos) > POSITION_TOLERANCE:
            move_towards_bounded(target_pos, max_rate=1.0)
            if motion_no_progress_duration(target_pos) > POSITION_FAULT_TIMEOUT:
                fail_safe_trip("motion position error or stall")

    if back_pressed():
        verify_discharge("ABORTED")
        break
    service_stop_path()
    sleep(0.05)


# --- RETRACT / OUTCOME ----------------------------------------------------
if STATE == "RETRACT":
    retract_to_home_bounded()
    STATE = RUN_OUTCOME if RUN_OUTCOME in {"DONE", "ABORTED", "FAULT"} else "DONE"
    log_run_outcome(STATE, V_PEAK, recipe)

# A fault remains latched. Reset must be deliberate and must not be inferred
# from lid closure, E-stop release, or the manual supply knob reaching zero.
