---
title: Titanium Anodizer — Engineering Handoff
project: Titanium Anodizing Lift Controller
status: design complete, not yet built
date: 2026-09-22
tags: [project/anodizer, electronics, hardware, safety]
---

# Titanium Anodizer — Engineering Handoff

**Purpose of this document.** Onboarding for collaborators. It explains *why* the design is shaped the way it is, records the decisions that were considered and rejected, and gives operating instructions. The full circuit and BOM live in [[anodizer-controller-design]]; the original process notes are in [[titanium-anodizing-automation]].

**Status:** design complete on paper. Nothing has been built or validated on hardware. Every number below is calculated or sourced, not measured.

---

## 1. What the machine does

Titanium anodizing colors metal by growing a transparent oxide film whose thickness sets an interference color — the soap-bubble effect. Thickness is set by **voltage**, so a part held at one voltage takes one color, and a part whose depth-in-bath is coordinated with a rising voltage takes a **gradient**.

This machine is a motorized lift that coordinates part position with cell voltage. It has two modes:

| Mode | What you get | Notes |
|---|---|---|
| **UNIFORM** | One even color over the whole part | Simplest and safest. Start here |
| **GRADIENT** | A rainbow or a chosen multi-color spread along the part's length | The reason the project exists |

The operator turns the power supply knob **by hand**. The controller measures the actual cell voltage and moves the part to whatever position that voltage corresponds to. It does not command the supply.

---

## 2. The five decisions that shaped everything

### 2.1 Voltage is the control variable, and time almost isn't

This is the single most important fact about the process, and it is counterintuitive coming from most other electroplating or coating work.

Oxide growth is **field-driven**, following high-field Cabrera–Mott conduction, where current density rises exponentially with field strength ([high-field model](https://repositorio-aberto.up.pt/bitstream/10216/103082/2/105618.1.pdf)). The field is `E = V / d`. Hold voltage constant and every nanometre of new oxide reduces the field, which cuts the current exponentially. The reaction throttles itself and stops. Terminal thickness ends up proportional to voltage, with an anodizing ratio for TiO₂ of roughly 1–3 nm/V ([growth model review](https://core.ac.uk/download/pdf/161911982.pdf)), commonly cited near 2 nm/V.

Three consequences that drive the whole design:

- **Color charts are voltage charts, not time charts.** Gold/bronze 10–18 V, purple 18–25 V, blue 30–40 V, gold again 50–55 V, teal and green 80–100 V ([DFocus](https://dfocusrp.com/resources/titanium-anodizing-color-chart/), [MonsterBolts](https://monsterbolts.com/pages/anodized-titanium-color-chart)). Red is not obtainable.
- **Dwell time barely matters.** Once the film has formed at a given voltage, holding longer changes almost nothing.
- **The color is set by the highest voltage a point saw while wet, and it never thins back down.** The process is one-way.

### 2.2 Therefore the voltage sweep must be monotonic

Because color records a peak and cannot be undone, the voltage must only ever increase during a run. The firmware tracks `v_peak = max(v_measured)` and treats a decrease as informational, not corrective. Physically retracting the part is harmless; reducing voltage to "fix" a color is impossible.

### 2.3 The actuator cannot replace a programmable supply — but it can follow one

**Rejected idea, worth recording because it is the obvious one.** The original hope was that a voltage-controlled linear actuator could produce a rainbow from a *fixed* supply voltage, dodging the cost of a programmable supply. It cannot. Every point on the part would see the same single voltage while wet, so the whole part comes out one color regardless of how it moved.

What *is* valid is the inverse: couple position to voltage. At 0 V the part is fully submerged; as voltage rises the part withdraws, so each height is stamped with the voltage present when the waterline passed it. That converts a knob sweep into a spatial gradient, which is the design we built.

### 2.4 The operator turns the knob

A programmable supply was priced and rejected (candidates included the GW Instek GPP-6030 and Chroma 6200-120; the cheap DPH8920 was disqualified because it caps at 96 V, below the green range). A motorized variac, HV boost modules, a DAC-driven external pass element with a 1 °C/W heatsink — all evaluated and dropped as either expensive, unsafe, or thermally awkward.

The project already owns a **0–120 V DC / 3 A bench supply**. Hand-adjusting it is free. The controller's job becomes measuring rather than commanding, which is both cheaper and a smaller safety surface.

There are two ways to run this, and the default is the second:

- **Voltage-following.** Turn the knob freely; the axis chases. Needs a `dV/dt` slew-limit fault ("knob too fast") because the axis has a finite speed and can fall behind.
- **Coached (default).** The display tells you the voltage to dial next. The axis only advances while you are inside a tolerance window, and a buzzer chirps when you drift outside it. Slower, far more repeatable.

### 2.5 Galvanic isolation is mandatory, not a nicety

The measurement side sits on the anodizing return. A laptop plugged into the controller's USB port would otherwise bond earth to the cell return. The barrier is an **ISO1541 isolated I²C** link plus a **TRACO TMR 0522** (5 V to ±12 V, 1.6 kV) feeding an **MCP1700-3302** LDO, with a ≥6 mm milled slot under the barrier.

This is not optional and it is not a place to economize. Anyone modifying the sense board must preserve the keepout.

---

## 3. Subsystems, and the non-obvious failure mode in each

### 3.1 Voltage sensing — do not use the microcontroller's own ADC

The RP2040's internal ADC is not good enough for a measurement this design depends on. Instead: a 1:40.8 divider built from **three 330 kΩ 1% resistors in series** (three, so each drops only ~39 V — this is about creepage and part voltage rating, not accuracy) over a **24.9 kΩ 0.1%**. At 120 V the tap reads 2.94 V. Divider current is 118 µA. A 100 nF cap, 1 kΩ series resistor and BAT54S clamp protect the input of an **ADS1115**, which at gain 1 gives 125 µV per LSB — about 5 mV referred to the cell.

### 3.2 Current sensing earns its place several times over

A **0.1 Ω 3 W low-side shunt** read differentially on the ADS1115 at gain 8 resolves 0.16 mA. It detects contact loss, confirms the part is submerged, detects the part clearing the bath *before* an arc can strike, and catches runaway.

**It also tells you when the film is finished** — see §4.

### 3.3 Kill chain — three independent layers

- **Q1, an IRFP460** low-side MOSFET used purely as a switch. At 1 A it dissipates 0.27 W, so no heatsink. This is the fast interrupt.
- **K1, an ordinary 12 V DPST relay** in the anode lead, which opens **only at zero current**. Sequencing matters: an ordinary relay cannot quench a DC arc, so it must never be the element that breaks current.
- **A hardwired latching mushroom E-stop** in the K1 coil circuit, with a 2N7002 pulling Q1's gate low. Plus an NC lid interlock, a 100 kΩ 2 W bleed resistor, a 22 Ω 50 W ballast, and a GFCI-fed supply.

### 3.4 Arc detection is hardware, because software is a thousand times too slow

The ADS1115 tops out near 860 samples/second behind an isolated bus and a 20 Hz firmware loop. That is a metrology path. An arc has microsecond structure, so anything relying on the firmware loop notices only after the part is ruined.

A small analog detector on the sense board, powered from the isolated rail, provides four trip channels:

| Channel | Detects | Signature |
|---|---|---|
| **ARC** | Arcing at the waterline, or anodic breakdown in the bath | Broadband current hash. Real anodizing current is smooth and slowly tapering, so AC-coupling the shunt above ~1.6 kHz makes this easy to discriminate |
| **OVERCURRENT** | Short, or part touching the cathode | ~1.5× working current |
| **OPEN CIRCUIT** | Lost contact, dropped part, broken lead | Near-zero current with voltage standing up |
| **COLLAPSE** | Low-impedance fault | Voltage below 50% of last settled value |

All four feed an **SR latch** that pulls Q1's gate down directly, responding in a few microseconds. **The latch is deliberate:** arcs are intermittent, so a non-latching trip would chatter the output on and off and make the situation worse. It requires explicit acknowledgement to clear.

The trip path never crosses the isolation barrier — that is what lets it be this fast and this independent. Only three signals cross: **OUTPUT ENABLE** on a dedicated ISO7710 channel (fail-safe low), plus latch status, latch reset and the K1 coil on a PCF8574 over the existing isolated I²C.

> **Do not move OUTPUT ENABLE onto the I²C bus.** A hung bus would leave the output stuck on, which is the exact failure the entire chain exists to prevent.

### 3.5 Prevention over detection

The detector is a backstop. The primary defences are procedural and cost nothing:

- **Cut the output before the last wet contact breaks.** This is the most important line in the firmware. Separation at the waterline is by far the most likely arc.
- **Ramp voltage down before final separation** rather than cutting at full value.
- Keep the electrical contact point above the active surface; never let it exit the bath energized.
- The 22 Ω ballast caps arc current regardless of what else fails.
- A 2 A slow-blow fuse in the anode lead sits behind everything electronic.
- **Cap V_MAX at about 105 V.** Above that you risk anodic breakdown — sparking and pitting.

### 3.6 Motion

NEMA 17 with an integrated 150 mm T8 lead screw, driven by a **TMC2209** over UART. 2.5 µm per microstep; sweep speeds 0.3–1.0 mm/s. PTFE suspension line, top endstop for homing, StallGuard repurposed as a jam detector.

### 3.7 Two datums, one of them found fresh every run

- **Mechanical:** a fixture shoulder puts the part top a fixed distance below the carriage face.
- **Electrical:** the bath surface is located every run. Apply 15 V, descend at 0.2 mm/s, and the moment current rises off zero is touchdown. Record it as `surface_pos`.

Finding the surface electrically self-calibrates for bath level and doubles as a contact check before anything irreversible happens. It is the reason you never have to measure fluid height by hand.

---

## 4. Reading the current trace

Worth its own section because it drives two firmware decisions and is the best diagnostic the machine has.

At constant voltage the trace is: **a sharp spike on application, an exponential decay over seconds, then a low plateau.** The decay is the film forming and throttling its own growth. The plateau is **not zero** — a residual leakage floor persists from electronic conduction through the film, oxygen evolution and slight dissolution.

- **Declare "formed" on the plateau, not on a fraction of peak.** The floor's absolute value shifts with part area, electrolyte conductivity and bath temperature — a warm bath leaks more. So watch `di/dt` and declare formed when current changes less than about 1% per second for 3–5 s, with a minimum dwell so noise on a steep decay cannot declare victory early.
- **Current that refuses to taper is a fault, not a reason to wait.** It means electrolyte too conductive or contaminated, a parasitic leak path, or a voltage above breakdown where sparking sustains conduction indefinitely. Time out and fault.
- **Peak current cross-checks the entered part length**, since peak current scales with wetted area. A gross mismatch means a mistyped length or a part that never fully submerged — caught before the color is committed.
- **In GRADIENT mode the trace is a staircase**, because each knob increment produces its own spike and decay. These are low-frequency and the 1.6 kHz high-pass should reject them; confirm during calibration by deliberately jerking the knob.

---

## 5. Operating instructions

### 5.1 Interface

A 128×64 OLED with a rotary encoder, SELECT and BACK. The OLED exists specifically so recipes can be previewed — with only a numeric display you cannot see where color bands will land, which is most of the value in a deliberate multi-color piece.

- **Encoder** scrolls fields and adjusts values. Decode at full quadrature then divide by four; the length field gets acceleration.
- **SELECT** enters a field or confirms. Hold 1 s on RUN to start.
- **BACK** exits a field, and aborts gracefully mid-run.
- **Buzzer** chirps when you are outside the coaching tolerance window, and sounds on fault.

Part length is entered in millimetres, 10–99 mm, persisted to flash and latched at RUN.

### 5.2 UNIFORM mode — the recommended starting point

1. Set MODE to UNIFORM, enter part length, pick a color.
2. Hold SELECT on RUN. The axis homes, finds the bath surface electrically, then submerges the part **deeper than gradient mode would**, since any part of the workpiece at or above the surface takes a different finish and a stray waterline band is the whole defect here.
3. The display coaches you to the target voltage. Dial up; the buzzer stops when you are in the window.
4. The part oscillates ±1 mm at about 0.5 Hz during formation. This sheds clinging hydrogen and oxygen bubbles, which otherwise leave streaks and comet marks — far more visible on a flat single color than on a gradient.
5. Watch the taper bar. When formation completes the display reads **"dial to 0 V to extract."**
6. **Dial the supply to zero and the machine lifts the part out.**

**Why the trigger is the knob and not a button.** Extraction happens at 0 V, so the waterline separation that causes the meniscus arc in gradient mode physically cannot arc — there is no potential across the gap when it breaks. It also keeps both hands on the supply knob instead of reaching for a button with a wet part hanging over electrolyte. And it costs nothing in color, since the film records the peak voltage and dialing down cannot unmake it.

The trigger is gated on formation and debounced over 500 ms. A knob bump mid-formation will not yank a half-finished part out; if voltage hits zero before the film is formed the machine holds position and asks rather than guessing.

### 5.3 GRADIENT mode

1. Set MODE to GRADIENT and enter part length.
2. Build a recipe as a list of colors. Each is stored as a `(name, V_low, V_high)` window rather than a single voltage.
3. Choose a spread mode:
   - **LINEAR** — voltage maps linearly to position.
   - **EQUAL BANDS** — every named color gets the same physical width. Usually what people actually want, and only feasible to set up because the OLED can preview it.
4. Preview. **Any band narrower than 1.5 mm is flagged** — below that the meniscus blurs it away.
5. The part pre-forms fully immersed at the starting voltage until current tapers. **Do not skip this**, or the top of the part comes out pale.
6. Sweep upward, coached. Output cuts before the last wet contact breaks.

### 5.4 Choose vibrant mid-to-high recipes over full rainbows

Higher voltages sit at higher interference orders, which means more color change per volt. Counterintuitively, that makes vibrant recipes **easier**, not harder, because they need a narrower voltage span and therefore produce a gentler gradient with wider bands.

Worked example on a 47 mm part:

| Recipe | Span | Gradient | Band width per 6 V |
|---|---|---|---|
| Full rainbow, bronze → green | 85 V | 1.81 V/mm | ~3.3 mm |
| Magenta → green | 22 V | 0.47 V/mm | ~12.8 mm |

About **4× more forgiving**, and it works down to roughly 15 mm parts versus a ~30 mm floor for a full rainbow.

### 5.5 Calibration transfers between parts

The palette is stored as voltage windows, and the position table as `(volts, fraction_of_length)` rather than absolute millimetres. One calibration therefore serves every part size — a single number, the part length, rescales both the voltage schedule and the travel.

---

## 6. Build and commissioning order

Do not skip steps, and do not put electrolyte in the room before step 4.

1. **Sense chain dry**, no cell. Sweep 0–120 V, build the two-point calibration, confirm agreement with a DMM within 0.5 V.
2. **Isolation check.** Confirm no continuity from HV_RETURN to Pico ground.
3. **Kill chain dry.** E-stop, lid switch, every firmware fault. Confirm Q1 opens and K1 drops every single time.
4. **Resistive load.** Substitute a 220 Ω 100 W resistor for the bath. Short it for OVERCURRENT, open it for OPEN CIRCUIT, confirm the latch holds until acknowledged.
5. **Arc threshold calibration.** Draw a deliberate small arc at 60 V through a test gap and set the ARC threshold just below reliable detection. Then confirm a normal 0→105 V ramp into the resistive load produces **zero** false trips. **This step decides whether the protection is real or decorative. Budget an afternoon.**
6. **Motion dry-run.** Empty tank. Watch for swing, twist and binding; confirm homing repeatability over ten cycles; verify commanded length against calipers at 10, 50 and 99 mm; confirm length survives a power cycle and BACK aborts cleanly.
7. **Flat coupons** at fixed voltages in 5 V steps, photographed against a ruler, to seed and then correct the palette windows. Pay extra attention above 70 V, where the display-piece recipes live and the windows are narrowest in volts.
8. **UNIFORM mode on a coupon**, end to end including zero-volt extraction. Simplest sequence and the only one that cannot arc, so it shakes out touchdown, formation detection and retraction before a moving waterline is added.
9. **GRADIENT mode**, coached, on a coupon before a part anyone cares about.

---

## 7. Prototype to production

All precision analog is off-chip — the ADS1115 measures, the TMC2209 handles motor current. The MCU needs GPIO, two I²C buses, one UART, step timers and about 50 KB of flash. Every candidate is overqualified, so **choose on porting risk and supply chain, not performance.**

| Chip | Dev board | SMT availability | Porting cost |
|---|---|---|---|
| RP2040 | Pico / Pico H | QFN-56, [JLCPCB C2761095](https://jlcpcb.com/partdetail/RaspberryPi-RP2040/C2761095) | Zero — GPIO numbering matches |
| RP2354A | Pico 2 | QFN-60, **2 MB on-die flash**, no external QSPI ([brief](https://www.mouser.com/datasheet/2/635/Raspberry_Pi_05_22_2025_rp2350_product_brief-3600627.pdf)) | Near zero |
| ESP32-S3-WROOM-1 | DevKitC-1 | Pre-certified module ~$4, [JLCPCB C2913201](https://jlcpcb.com/partdetail/3198299-ESP32_S3_WROOM_1_N8R8/C2913201) | Moderate rewrite; gains Wi-Fi logging |
| STM32G071C8 | Nucleo-G071RB | [LQFP-48](https://jlcpcb.com/partdetail/STMicroelectronics-STM32G071C8T6/C529341), hand-reworkable | Full C/HAL rewrite |

**Recommendation for a one-off:** solder the Pico module down, or socket it on 2×20 headers ([castellated soldering guide](https://learn.sparkfun.com/tutorials/how-to-solder-castellated-mounting-holes/all)). Zero porting, no crystal or QSPI layout to get wrong, USB already routed, and a splash means swapping a $5 module instead of desoldering a QFN. For a properly integrated board the RP2354A is the pick, since on-die flash removes the fiddliest part of an RP2040 layout.

### DFM: split into two boards

Send the **logic board** out for assembly. **Hand-build the HV sense and kill board yourself**, through-hole.

A low-cost assembler will cheerfully place 0603 parts 0.3 mm apart across a 120 V divider and will not respect the isolation keepout without an explicit fab note plus a milled slot. That board also deserves personal inspection of every joint. Connect the two with a high-clearance keyed connector with unpopulated guard pins and a slot between them.

Extended parts carry a per-type feeder fee, so consolidate passive values and prefer Basic parts where the choice is free ([JLCPCB assembly pricing](https://jlcpcb.com/help/article/pcb-assembly-price)). Keep GPIO numbering identical to the Pico's. Add test points on the divider tap, both shunt lines, the Q1 gate and both 3V3 rails.

---

## 8. Budget

Roughly **$290–330** all in, including frame and tank. About **$110** for electronics alone; arc detection adds about $12.

Key line items: [ADS1115 breakout $14.95](https://www.adafruit.com/product/1085), [TMC2209 breakout $8.95](https://www.adafruit.com/product/6121), [Pico H $5.50](https://www.sparkfun.com/raspberry-pi-pico-h.html), [NEMA 17 with T8 screw ~$21](https://www.ebay.com/itm/186502889154). Full itemization in [[anodizer-controller-design]].

---

## 9. Open items for collaborators

- **Nothing is built.** All values are calculated. Steps 1–5 of §6 are the real design review.
- **Arc threshold is unknown** until measured on this specific cell and electrolyte. §6 step 5.
- **Palette windows are literature values** ([DFocus](https://dfocusrp.com/resources/titanium-anodizing-color-chart/), [Hontitan](https://hontitan.com/how-to-anodize-titanium-at-home/)) and must be corrected against coupons from this bath, since electrolyte and alloy both shift them.
- **Sweep speed is a guess** at 0.3–1.0 mm/s; the real band sharpness limit is meniscus behaviour and needs empirical work.
- **Formation timeout and `di/dt` threshold** need real traces to set sensibly.
- Process references: [AMS-2471](https://titanium.blog/standards/ams-2471/), [Caswell plating manual](https://tosih.org/files/books/caswell_inc_plating_manual.pdf).

---

## 10. Safety summary for anyone operating this

This machine runs **105 V DC into a conductive liquid**. That is a genuinely dangerous combination and DC is harder to let go of than AC.

- GFCI-fed supply, lid closed during runs, bath in a containment tray.
- Nitrile gloves. **One hand in your pocket** while the output is live.
- Never reach into the tank without confirming the output is off and the bleed resistor has had time to work.
- Treat the E-stop as the primary control, not a last resort.
- If a fault latches, **find out why before acknowledging it.** The latch exists to preserve evidence of a real fault, and clearing it reflexively throws away the only diagnostic you get.

---

## Related notes

- [[anodizer-controller-design]] — full circuit, pin map, firmware sketch, BOM
- [[titanium-anodizing-automation]] — original process research and problem statement
