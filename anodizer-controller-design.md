# Titanium Anodizing Lift Controller — Circuit Design and BOM

**Configuration:** you own a 0–120 V / 3 A supply and will adjust its voltage **by hand**. The Raspberry Pi Pico WH therefore never commands voltage. It reads the actual cell voltage, and drives the lift axis to the position that voltage should correspond to.

**Status:** untested conceptual design. The circuit, protection system, firmware, motion geometry, and process limits are not validated for construction or energized operation.

## Review corrections — supersede earlier conceptual shorthand

This document is a design study, not an authoritative wiring diagram or a
completed prototype. Every active state must run the same interlock,
measurement-validity, overvoltage, current, hardware-latch, contact, and motion
checks. A trip latches until Reset; releasing an interlock or turning the
manual supply to 0 V does not resume or extract a run.

The state sequence is `IDLE → HOMING → TOUCHDOWN → SUBMERGE → SETTLE → SWEEP` or
`UNIFORM_HOLD → DISCHARGE → RETRACT → DONE/ABORTED`, with `FAULT` latched when
shutdown or discharge cannot be verified. Q1 command state, K1 command/state,
and voltage measured directly across the electrode pair are separate signals.
Output-off is a command, not proof of de-energization. Retraction and access
are permitted only after both interrupting devices are confirmed open and the
electrode-pair voltage is below a qualified access threshold.

The schematic is not yet authoritative. The supply return, cathode, anode,
Q1/shunt nodes, K1 placement, isolated grounds, signal barriers, trip truth
table, watchdog/permit circuit, stored-energy locations, and insulation class
must be resolved in one reviewed schematic before construction. The Pico must
remain behind the required barrier; the earlier idea of floating the controller
on `HV_RETURN` is removed from build guidance. The TMR 0522 test-voltage number
is not by itself a protective-isolation claim.

You turn the knob. The machine decides where the waterline belongs.

That inverts the usual design and deletes most of the expensive parts: no DAC into the supply, no linear pass element, no 100 W heatsink, no poking around inside a working instrument.

---

## 1. Architecture

```
 [ YOUR 0–120 V / 3 A SUPPLY, manual knob ]
              │ +
              │
        K1 / ballast ─────────────────────────────► ANODE (Ti workpiece)
              │                              [ ANODIZING CELL ]
              │                                CATHODE (Ti / 316 SS plate)
       R_shunt 0.1 Ω 3 W
              │
        Q1 low-side MOSFET
              │
        HV_RETURN ◄─────────────────────────────────┘
              │
   ═══════════╪════════════ ISOLATION BARRIER ════════════════
              │
   ┌──────────▼───────────────────┐
   │ SENSE BOARD (on HV_RETURN)   │        ISO1541
   │  1:40.8 divider → ADS1115    │◄════ isolated I²C ════╗
   │  shunt metrology + arc front end│                    ║
   │  arc/fault comparators + SR  │      ISO7710F         ║
   │  latch → Q1 gate driver      │◄══ enable (1 ch) ═════╣
   │  PCF8574: latch status,      │                       ║
   │    latch reset, K1 coil      │                       ║
   │  powered by TMR 0522         │                       ║
   └──────────────────────────────┘                       ║
                                                          ║
   ┌──────────────────────────────────────────────────────╝
   │  RASPBERRY PI PICO WH  (Pico 1 / RP2040, headers + wireless)
   │   GP0/1    I²C0 → ISO1541 → ADS1115
   │   GP2/3/4  STEP / DIR / EN → TMC2209
   │   GP8/9    UART1 → TMC2209 (StallGuard, current set)
   │   GP10     OUTPUT ENABLE → ISO7710F → Q1 gate driver (fail-safe low)
   │   GP11     isolated E-stop / interlock feedback
   │   GP12/13  endstop TOP / BOTTOM
   │   GP15     piezo buzzer (out-of-tolerance / fault alert)
   │   GP16/17  I²C0 → SSD1306 128×64 OLED; resolve bus/pin allocation with ADS1115
   │   GP18/19  rotary encoder A / B
   │   GP20     SELECT button
   │   GP21     BACK button
   │   GP22     hardware fault IRQ
   └──────────────────────────────────────────────────────
              │
       TMC2209 ──► NEMA 17 + 150 mm T8 lead screw
```

---

## 2. The control concept

The oxide color at any point on the part is set by the **highest** voltage that
point saw while wet; lowering voltage cannot undo it. The carriage command is
separate from this color history: it is recalculated from the current measured
voltage and the recipe table on every control update. Raising voltage moves the
carriage up; lowering it moves the carriage back down. The per-section peak
voltage remains latched for the color rendering.

### Two operating modes worth building

**Mode 1 — Voltage-following.** You free-run the knob; the axis chases. Simple, feels good, one real hazard: nothing limits how fast you can turn the knob. Crank it 20 V in a second and the mechanism cannot lift that fast, so a still-immersed section gets over-formed and you lose that band. Guard it in firmware with a slew limit — if `dV/dt` exceeds what the axis can track, or if position error exceeds a band, drop the output and show the fault.

**Mode 2 — Coached.** The display shows the recipe's programmed voltage
markers, while the axis continuously tracks the measured voltage in either
direction through the selected mapping. Equal-band mode allocates one equal
physical segment per selected color; linear mode maps the endpoints linearly.
If motion lags a rapid knob adjustment, the carriage continues toward the
corresponding position at its bounded rate. This behavior is a conceptual model,
not a validated tracking or coating process.

Build Mode 2 as the default and Mode 1 as an expert option. Mode 2 is also what makes the whole hand-adjusted approach genuinely competitive with a programmable supply — the machine keeps the position and the voltage in register no matter how clumsy the knob work is.

Add a deadband and hysteresis on the position command — roughly 0.5 V of ADC hysteresis and a 0.1 mm minimum move — or sensor noise will make the stepper chatter continuously at the waterline, which ripples the bath and smears the band edge.

---

## 3. Voltage and current sensing

### 3.1 Divider, 120 V → 2.94 V

```
CELL + ──┬── 330k ──── 330k ──── 330k ──┬── 24.9k 0.1% ──┬── HV_RETURN
         │   (R1)      (R2)      (R3)   │    (R4)        │
         │                              ├── 100nF ───────┤
         │                              │                │
         │                              ├── 1k ── ADS1115 AIN0
         │                              └── BAT54S clamp to 3V3 / GND
```

- Ratio 24.9 k / 1.0149 M = **1 : 40.8**. 120 V in → 2.94 V, inside the ADS1115 ±4.096 V range with overshoot headroom.
- **Three resistors in series, not one 1 MΩ part.** Each sees only ~39 V and the string buys real creepage. A single chip resistor across 120 V will eventually track and flash over.
- Divider current 118 µA, ~5 mW per resistor. 1% metal film, 1/4 W minimum for the body length.
- Tap at the anode terminal, not at the supply, so the reading includes lead and contact drop — that is the voltage the part actually experiences.
- ADS1115 at gain 1 gives 125 µV/LSB → **5 mV per LSB at the cell**. Since band placement now depends entirely on this measurement, the ADS1115 is worth its $15 over the RP2040's own ADC, whose integral nonlinearity and noisy reference would put you in the tens of millivolts at best, and which cannot do the differential shunt channel at all ([Adafruit ADS1115](https://www.adafruit.com/product/1085)).

Calibrate with two known points against a DMM and store the slope/offset in flash. Absolute accuracy of ~0.3 V is achievable and is plenty, since perceived color shifts over roughly 2–5 V.

### 3.2 Shunt — more useful here than you'd expect

```
Q1 source ──┬── R_shunt 0.1 Ω 3 W ──┬── HV_RETURN
            │                       │
      ADS1115 AIN2            ADS1115 AIN3   (differential, gain 8)
```

3 A → 300 mV; gain 8 (±0.512 V FSR) → 15.6 µV/LSB → **0.16 mA ideal ADC resolution**. The metrology path is direct to the ADS1115. Any separate amplifier used by the fast protection path must have gain and output headroom calculated for the full validated current; the earlier INA181A2 50× selection is not compatible with 3 A and a 3.3 V/5 V signal domain. This channel earns its place by detecting things the voltage reading cannot:

- **contact loss** — current collapses while voltage stays up;
- **the part clearing the bath** — current falls toward zero, which is the cue to drop the output *before* the final wet contact point can arc;
- **runaway or a short** — current climbs where it should be tapering.

Low-side placement keeps both sense nodes near cell ground, so no high-side current-sense amp is needed. Put a 10 Ω / 100 nF RC on each sense line.

### 3.3 Isolation

| Function | Part | Note |
|---|---|---|
| I²C across the barrier | **ISO1541** | Bidirectional isolated I²C, built for this ([TI datasheet](https://www.ti.com/lit/ds/symlink/iso1541.pdf)) |
| Sense-side power | **TRACO TMR 0522**, 5 V → ±12 V, 2 W, 1.6 kV | Also supplies Q1's gate drive ([Traco TMR 2 datasheet](https://www.tracopower.com/tmr2-datasheet)) |
| 3V3 on sense side | 3V3 regulator rated for the complete +12 V rail and load | Do not use MCP1700 directly from +12 V |

Mill or slot a ≥6 mm gap under the barrier and pour no copper across it. Treat 6 mm as a layout starting point, not a universal safety approval; verify clearance, creepage, pollution degree, insulation system, and test voltage against the applicable requirements.

Why bother: you will have a laptop on the Pico's USB port while tuning firmware. Without the barrier, USB ground is bonded to the anodizing return, and one wiring slip puts 120 V on your laptop chassis. **Budget alternative** (saves ~$23): float the whole Pico on HV_RETURN, power it from its own wall adapter, and never connect USB while the supply is live — flash firmware with the supply unplugged. Workable, but one forgotten cable away from an expensive afternoon.

---

## 4. Output kill chain

Because you are working the knob manually, the automated kill path matters more, not less — the arc-avoidance cut at the end of the lift is timing-critical and you will not beat it by hand. This section is a protection concept, not a validated safety circuit.

| Layer | Implementation |
|---|---|
| **Q1, electronic interrupt** | IRFP460 in the low side, with gate drive referenced to its source. The 0.27 Ω value is a room-temperature maximum at the datasheet test condition; conduction loss is 0.27 W at 1 A and 2.43 W at 3 A before temperature derating. A heatsink and transient/SOA analysis are required. |
| **K1, galvanic interrupt** | DC-rated, appropriately safety-rated contactor or relay in the anode lead. Firmware turns Q1 off first during normal shutdown, but K1 must still interrupt the worst credible DC fault if Q1 fails short. |
| **E-stop** | Latching NC mushroom button in series with K1's coil **and** driving a 2N7002 that pulls Q1's gate to HV_RETURN. Pure hardware, parallel to the Pico. |
| **Lid interlock** | NC microswitch in the same coil loop. |
| **Bleed** | 100 kΩ 2 W permanently across the output terminals. |
| **Ballast** | Value and continuous/pulse rating TBD from validated current and fault-energy calculations. A 22 Ω, 50 W part is limited to about 1.5 A continuous even before thermal derating, and dissipates 198 W at 3 A. |
| **Firmware trips** | over-current, current collapse, stepper stall (TMC2209 StallGuard), endstop violation, I²C watchdog timeout, `dV/dt` beyond axis capability. |

Feed the supply from a GFCI outlet, but do not treat the GFCI as protection against contact across a floating DC cell. Keep the lid closed during runs, put the bath in a containment tray, provide ventilation for generated gas and chemical mist, control ignition sources, and define chemical-specific PPE and spill procedures. Never access the bath while energized; use a verified discharge and lockout procedure.

### 4.1 Arc and open-circuit detection

The kill chain above is fast, but until now nothing **triggers** it fast. The ADS1115 tops out around 860 samples/second and sits behind an isolated I²C bus and a 20 Hz firmware loop — that is a measurement path, not a protection path. An arc at the meniscus is a millisecond-scale event with microsecond structure, so by the time the software notices, the damage to the part is done.

The fix is a small analog detector on the sense board, referenced to HV_RETURN and powered from the TMR rail you already have. It runs entirely independently of the Pico.

```
            +-- DC path ------------------> ADS1115 AIN2/3   (metrology, slow)
            |
 R_shunt --[INA181]--+
            |        +-- high-pass 10nF/10k (fc ~1.6 kHz) --> |\
            |                                                 | >-- ARC
            |                                        Vref_arc  |/   (U3a)
            |
            +-- window comparator:  I > I_MAX  --> OVERCURRENT (U3b)
            |                       I < I_MIN  --> OPEN CCT    (U4a, blanked)
            |
 HV divider ----------------------------->  V < V_COLLAPSE --> COLLAPSE (U4b)

 ARC / OVERCURRENT / OPEN / COLLAPSE --> OR --> [ SR LATCH ] --+--> Q1 gate pulldown
                                                              +--> Pico IRQ (GP22)
                                                              +--> buzzer
```

**Four independent trip channels, because each catches a different failure:**

| Channel | Signature | Threshold |
|---|---|---|
| **ARC** | Broadband current chatter. Real anodizing current is smooth and slowly tapering; an arc is high-frequency hash. AC-coupling the shunt above ~1.6 kHz is a proposed discriminator | Set only with a controlled injected transient or enclosed qualified fixture; never draw an open-bench arc |
| **OVERCURRENT** | Hard short, part touching the cathode | ~1.5× your working current |
| **OPEN CIRCUIT** | Contact lost, part fell off, lead broken — current near zero while voltage stands up | I < 5 mA with V > 10 V, **blanked** until the MCU asserts "submerged and settled", since zero current is legitimate before immersion |
| **COLLAPSE** | Voltage dragged down by a low-impedance fault | V < 50% of the last settled value |
| **OVERVOLTAGE** | Supply or control fault above validated process limit | Independent hardware trip above `V_MAX_HARD` |

**Crossing the barrier.** The comparators, the latch and Q1's gate driver all live on the sense board, referenced to HV_RETURN — the trip path never crosses the isolation barrier, which is precisely why it can be this fast and this independent. Only explicitly isolated control/status signals cross:

| Signal | Route | Why |
|---|---|---|
| OUTPUT ENABLE | **ISO7710F** or equivalent low-default isolator, one dedicated channel | The MCU's command to allow output must not depend on a bus. Loss of signal or loss of power on either side must mean off |
| Latch status + latch reset | **PCF8574** I²C expander on the sense board, over the existing ISO1541 | Status only needs to arrive within tens of milliseconds — the hardware has already cut the output |
| K1 coil drive | PCF8574 through a transistor/driver with a hardware de-energized-on-reset state | Sequenced after Q1, but must also fail off if the expander or isolated bus resets |
| E-stop/interlock feedback | Dedicated isolated input | GP11 must never be wired directly to the sense-board or HV_RETURN domain |

Do not route the enable over I²C. A hung bus would leave the output stuck on, which is the one failure mode the whole chain exists to prevent.

**Why an SR latch rather than a comparator straight to the gate:** an arc is intermittent by nature, so a non-latching trip would chatter the output on and off and make things worse. The latch captures the first event, holds Q1 off, and requires an explicit acknowledgement to clear. Total response — comparator propagation, latch, MOSFET turn-off — is a few microseconds, roughly a thousand times faster than the firmware path.

Opening Q1 interrupts the source-fed loop but does not prove that the supply,
cell, wiring, or parasitic capacitance is discharged. K1 state and the actual
electrode-pair voltage must be verified after shutdown. The 100 kΩ bleed and
its discharge time remain schematic/calculation items, not safety evidence.

**Optional fifth channel, and you have the gear for it:** arcs radiate broadband RF. A small pickup loop near the cell into a diode envelope detector and a comparator gives a trip channel that shares no failure mode with the current path. Independent detection physics is genuinely valuable in a protection system — and you will hear the same signature on a receiver nearby, which is a decent way to characterise it before you set the threshold.

### 4.2 Prevention beats detection

Detection is the backstop. The primary defence is not creating the arc:

- **Cut the output before the last wet contact breaks.** This is the positional cutoff in §7 and it is the single most important line in the firmware. An arc at the moment of separation is the design's most likely arc by a wide margin.
- **Ramp the voltage down before the final separation** rather than cutting at full voltage. Less stored energy, less to quench.
- **Keep the electrical contact point above the active surface** and never let it exit the bath under power.
- **The calculated ballast and fuse must be coordinated** with the validated current limit and fault energy; the withdrawn 22 Ω / 50 W and 2 A fixed values must not be copied into hardware.
- **Add independent hardware overvoltage protection** below the supply's maximum output and below the component/cell limits.
- Above roughly 105 V you also risk **anodic breakdown** — sparking and pitting on the part surface while fully immersed, a different phenomenon from a meniscus arc but with the same current signature, so the ARC channel catches it too.

---

## 5. Motion axis

NEMA 17 with integrated 150 mm T8 lead screw, TMC2209 in UART mode. At 8 mm/rev and 16× microstepping one microstep is 2.5 µm — orders of magnitude finer than the meniscus blur. The 150 mm screw is not a demonstrated 150 mm usable stroke, and low-speed StallGuard readings are not accepted as the sole suspension-integrity sensor; actual position, endstops, travel limits, and motor-power-loss behavior require independent validation.

- Home against the **top** endstop at boot; bottom endstop is a sanity limit.
- Sweep rate 0.3–1.0 mm/s. A 60 mm part takes 1–3 minutes, which gives each band time to reach terminal oxide thickness.
- Suspend on PTFE line over a pulley; add a guide tube or second line if the part twists.
- Keep frame, motor and screw electrically isolated from the electrolyte. The bath is never a structural or electrical reference.
- Anode lead gets a service loop and strain relief so lifting never tugs the contact.
- Gentle accel/decel so the workpiece doesn't make waves — surface ripple is the main enemy of a crisp gradient.

---

## 6. User interface — part length and color recipe

You are not entering a rainbow, you are entering a **recipe**: part length, a start color, an end color, and how the intervening colors get distributed along the part. That is more than digits can express, so the panel is a 128x64 SSD1306 OLED driven by three controls — a **rotary encoder**, **SELECT**, and **BACK**.

Three controls is the right number. The encoder scrolls fields and values, SELECT descends into a field or commits it, BACK abandons the edit and steps up a level. Every screen in the machine is navigable with that vocabulary, so there is nothing to learn and nothing that only works on one screen.

### 6.1 Controls and wiring

| Control | Pin | Function |
|---|---|---|
| Encoder A / B | GP18 / GP19 | Scroll fields; adjust the selected value |
| SELECT | GP20 | Enter a field, commit a value; **hold 1 s on RUN** to start a run |
| BACK | GP21 | Cancel an edit, step up a level; **during a run, graceful abort** |

- Wire all five inputs to ground with internal pull-ups enabled; no external resistors needed.
- Debounce in firmware, 5 ms on the buttons. For the encoder use the RP2040's PIO or an interrupt-driven quadrature state machine rather than polling — mechanical encoders generate enough edge noise to lose counts otherwise.
- Cheap detented encoders are typically 20 detents per revolution with 4 counts per detent. Decode at full quadrature, then divide, so one detent equals one increment. Without that, every click jumps by four.
- **Acceleration on the length field.** Hold the encoder turning and step by 5 mm instead of 1 mm after the first half-turn, or crossing 10→99 mm takes 89 clicks.
- **BACK during a run requests a graceful abort:** command Q1 then K1 off,
  verify electrode-pair discharge, then retract. It is not a substitute for the
  E-stop, which stays a hardwired latching mushroom independent of the Pico.

### 6.2 Part length entry

Part length is a numeric field on the main screen, adjusted with the encoder in 1 mm steps over a **10–99 mm** range. Sub-10 mm parts aren't the use case, and the ceiling matches your stated working envelope.

Because an encoder is relative rather than absolute, **persist the value to nonvolatile storage** on every commit and reload it at boot. The planned 24C16 provides a small, MCU-independent store for the current length, calibration coefficients, recipe slots, geometry, and configuration, so those values survive replacing the Pico with another Pico or an ESP32. Use a versioned record with CRC and conservative write coalescing/wear management; do not treat it as a high-rate event log. In practice you anodize several similar parts in a session, so the machine coming up already showing 47 mm is the common case and the field often needs no touching at all.

The tradeoff against a potentiometer is worth naming: a pot would be absolute and glanceable across the room, but it drifts, it can be knocked mid-run, and it cannot land exactly on an integer without hysteresis games. The encoder gives exact integers, no drift, and one consistent input vocabulary for the whole interface. Given the OLED is already there to display the value, absolute knob position buys little.

**Latch on RUN.** Freeze the length when the run starts and ignore all input except BACK and the E-stop until the run ends. Nothing about the geometry should be able to change mid-sweep.

### 6.2 The color palette

The simulator and sketch include the product's 13 named swatches and the
nominal voltages encoded in their image filenames. These values describe the
vendor's sample names, not validated voltage windows or guaranteed results in
this project's bath. `HIGH POLISH (0 V)` means no anodizing and is excluded from
recipes. Calibrate actual ranges on coupons for the specific alloy, bath, and
setup before use.

| Swatch | Nominal voltage | Swatch | Nominal voltage |
|---|---:|---|---:|
| High Polish | 0 V (no anodizing) | Dark Bronze | 15 V |
| Purple | 22 V | Blue | 28 V |
| Silver Blue | 40 V | Gold | 65 V |
| Rose Gold | 70 V | Pink | 75 V |
| Dark Fuchsia | 85 V | Blurple | 92 V |
| Purple Teal | 95 V | Teal Green | 103 V |
| Green | 105 V | | |

Source: [Painful Pleasures, 16g internally threaded titanium bent barbell](https://www.painfulpleasures.com/products/titanium-16g-bent-barbell-internally-threaded-curved-barbell); the nominal values and names were read from the filenames of the page's color-swatch images. The page's “DarkFushia” filename is normalized to “Dark Fuchsia” here.

The swatch labels and nominal voltages are a seed list only. Establish actual
color windows experimentally from coupons in the project's own bath and alloy;
color/voltage relationships vary with material, electrolyte, surface finish,
and process conditions.

### 6.3 Recipe entry flow

```
 IDLE                              LENGTH  47mm
                                   >START  PINK        75V
                                    END    GREEN      105V
                                    SPREAD EQUAL BANDS
                                    PREVIEW / RUN

 PREVIEW                            47mm  75 -> 105 V   estimate only
   +--------+  GREEN       105V   top / first exposed section
   |  gradient  TEAL GREEN 103V   vendor sample
   |            PURPLE TEAL 95V   vendor sample
   |            BLURPLE      92V   vendor sample
   |            DARK FUCHSIA 85V   vendor sample
   |  bar      PINK         75V   bottom / last exposed section
   +--------+           6 colors, equal physical bands, estimate only
```

Preview coordinates are physical: `top` is the carriage-side end and `bottom`
is the suspended end. The simulator currently reserves the 5 mm full-submersion
clearance and a 3 mm wet-side cutoff margin in its motion span. At final cutoff,
Q1/K1 are commanded off with the part's tip still 3 mm below the modeled
waterline; retraction waits for discharge verification. For a 47 mm part with
the current conceptual coordinates, nominal positions are 114.4 mm at
formation, then about 106.2, 98.1, 89.9, 81.7, and 73.6 mm at the five
equal-band boundaries, and 65.4 mm at final cutoff. These are model coordinates only; meniscus,
drainage blur, and the actual sensor-to-carriage datum remain unvalidated.

Encoder scrolls fields, SELECT enters a list and commits, BACK steps up. Store five named recipe slots in flash so a repeat display piece is one recall away.

### 6.4 Spread modes — the reason for the display

Once you pick endpoints, something has to decide how the intervening colors map onto the part. Two modes:

- **LINEAR** — voltage is linear in position. Simple, but each color gets whatever width the physics gives it, so some bands come out thin and others fat.
- **EQUAL BANDS** — allocate equal physical length to each named color in the range, then build a piecewise voltage curve to suit. Every color reads as a deliberate stripe of the same width.

EQUAL BANDS is why the lookup table beats a linear ramp, and it is exactly what makes a display piece look intentional rather than accidental. It is also the real argument for a graphical display: you need to *see* the band layout, in millimetres, before committing a part.

The preview screen should flag any band narrower than about 1.5 mm, since that is the order of the meniscus and drainage blur — below it, the band will smear rather than read as a stripe.

### 6.5 Why mid-to-end range is the easier target

Your instinct is correct, and for a concrete reason: **the upper voltage range delivers more color change per volt**, because the oxide is into higher interference orders. So a vibrant mid-to-end sweep needs a *narrower* voltage span than a full rainbow, and a narrower span across the same part length means a gentler gradient and wider, crisper bands.

| Endpoint example | Span | Average gradient on 47 mm | Approx. travel per 6 V in LINEAR mode |
|---|---|---|---|
| Dark Bronze -> Green | 15 -> 105 V, 90 V | 1.91 V/mm | ~3.1 mm |
| Pink -> Green | 75 -> 105 V, 30 V | 0.64 V/mm | ~9.4 mm |

These endpoint calculations are illustrative only; they are not calibrated color
widths or validated process guidance. EQUAL BANDS uses piecewise voltage
boundaries to create equal physical widths, while LINEAR distributes voltage
evenly along travel.

Two things to get right for high-range recipes:

- **Pre-form the whole part at V_start before lifting.** For the selected
  Pink-to-Green example, fully immersed, settle at the nominal 75 V Pink sample
  and let current taper. This is an illustrative setpoint, not a bath-calibrated
  process limit.
- **Cap V_max around 105 V.** Above that you risk anodic breakdown — sparking, burnt patches and pitting, which are not recoverable without repolishing. Make the ceiling a firmware constant with an override you have to hold the encoder down to change.

### 6.6 How one number sets both scales

A length in millimetres is only meaningful if the machine knows **where on the part that length starts**. Two datums make it unambiguous, and then the entered number propagates through everything.

**Datum 1 — the fixture (mechanical, fixed once).** Build the hanger so the part's top edge always sits a fixed distance `FIXTURE_OFFSET` below the carriage face — a machined shoulder or a locating pin in the clamp. Then:

```
part_top_mm    = carriage_pos + FIXTURE_OFFSET
part_bottom_mm = part_top_mm + part_length      <- the entered number
```

That is the whole trick. Clamp the part *up* against the shoulder every time and one number fully describes the geometry. Clamp by eye and no firmware recovers the registration.

**Datum 2 — the bath surface (measured electrically, every run).** Don't trust a fill line; you already have the shunt:

1. Apply a validated touchdown voltage below the first validated color threshold; 15 V is not automatically safe and overlaps the provisional bronze window.
2. Descend slowly, 0.2 mm/s, watching the current channel.
3. The instant current rises off zero, the bottom edge has touched the electrolyte. Record that carriage position as `surface_pos`.
4. Continue down by `part_length + CLEARANCE` to fully submerge, then settle at V_start.

This self-calibrates bath level every run, so evaporation, refills and tank swaps stop mattering. It doubles as a contact check — no current at touchdown means a bad clamp, found before you commit the part.

**Both scales then fall out:**

| Scale | Derivation |
|---|---|
| Travel span | `fully_submerged_pos - cutoff_pos`; current model is `part_length + CLEARANCE - ARC_MARGIN` |
| Position of a band boundary | `fully_submerged_pos - frac x travel_span` |
| Voltage gradient | `(V_end - V_start) / part_length` volts per millimetre |
| Submersion depth | `part_length + CLEARANCE` below `surface_pos`; this clearance is not a color band |

**Worked example — 47 mm part, PINK to GREEN, EQUAL BANDS:**

```
LENGTH = 47 mm      -> SELECT-hold latches part_length = 47 mm
recipe 75 -> 105 V  -> 6 colors -> 8.17 mm per band
touchdown found at carriage_pos = 62.4 mm
submerge to 62.4 + 47 + 5 = 114.4 mm, settle at 75 V until current tapers
  fraction 0.00  dial 75 V    carriage 114.4 mm  PINK baseline
  fraction 0.17  dial 80 V    carriage 106.2 mm  PINK / DARK FUCHSIA boundary
  fraction 0.33  dial 88.5 V  carriage 98.1 mm   DARK FUCHSIA / BLURPLE boundary
  fraction 0.50  dial 93.5 V  carriage 89.9 mm   BLURPLE / PURPLE TEAL boundary
  fraction 0.67  dial 99 V    carriage 81.7 mm   PURPLE TEAL / TEAL GREEN boundary
  fraction 0.83  dial 104 V   carriage 73.6 mm   TEAL GREEN / GREEN boundary
  fraction 1.00  dial 105 V   carriage 65.4 mm   GREEN endpoint / wet-side cutoff
Q1/K1 off with 3 mm of the lower tip still submerged; verify discharge, then retract
```

Note that the length never changes the voltage endpoints — those come from the recipe. Length only stretches the spatial axis, which is to say it sets the gradient.

---

## 7. Firmware sketch

The authoritative conceptual state-machine sketch is [`controller_firmware.py`](controller_firmware.py). The earlier inline excerpt has been removed because it duplicated safety logic and could drift from the simulator. The sketch and simulator now share these requirements:

- common safety supervision in every active state;
- low-energy touchdown validation with a timeout and contact threshold;
- latched recipes and a separate fully-submerged UNIFORM hold;
- motion/position error and completion timeouts;
- explicit Q1/K1 shutdown followed by electrode-pair discharge verification; and
- deliberate reset after FAULT, with separate DONE and ABORTED outcomes.

These are conceptual software contracts. They do not replace a hardware watchdog, an independent permit/trip path, a reviewed schematic, or qualified commissioning.

## 8. Bill of materials

### Prototype package and purchase-status overlay

This overlay records the mounting form that is currently intended for the
breadboard prototype. **THT** means the selected part or breakout can present
through-hole pins; an IC mounted on a breakout may still be SMT. **TBD** means
the exact orderable package has not been selected, so the BOM does not assume
that a through-hole version exists. Purchase status is based only on explicit
project decisions, not on a part being discussed or priced.

| Component | Qty | Mounting/package for prototype | Purchase status |
|---|---:|---|---|
| Raspberry Pi Pico WH | 1 | THT breadboard interface via pre-soldered headers; module electronics are SMT | **Received** |
| ADS1115 Adafruit breakout | 1 | THT-capable with included 0.1 in header; ADC and support parts are SMT | **Purchased** |
| SSD1306 128×64 display module | 1 | Module/header format; exact SPI-versus-I²C board and header installation must be verified | **Ordered** |
| 24C16 I²C EEPROM, DIP-8/THT | 1 | THT nonvolatile storage for calibration coefficients, recipe slots, geometry, and other MCU-independent settings; 16-Kbit capacity is not intended for high-rate logs | **Unpurchased** |
| EC11 encoder with knob | 1 | THT panel/breadboard pins; integrated push switch | **Ordered** |
| 6×6 mm tactile switch assortment | 1 kit | THT, 4-pin momentary switches | **Ordered**; individual BACK switch TBD |
| ISO1541DR | 1 | SMT SOIC-8; use a SOIC-to-DIP breakout for breadboard work | Not confirmed |
| TRACO TMR 0522 (user reports marking/order as “TMR 3-0522”) | 1 | THT SIP-8 isolated module if this is the TMR 0522 variant | **Purchased**; exact MPN/marking to confirm |
| 24 V-to-5 V buck converter | 1 | Module or PCB; exact package TBD | TBD |
| 3V3 regulator ≥15 V input | 1 | Package TBD; select a THT regulator/module for breadboard prototype | TBD |
| Divider resistors and shunt | 1 set | THT versions available; exact resistor power/package TBD | Not confirmed |
| BAT54 assortment (listing labels include BAT54SW/BAT54SWT1G/BAT54S) | 1 assortment | Mixed package assortment; user-supplied photo confirms through-hole components are included, but the exact BAT54 variant/package still needs identification | **Purchased** |
| Piezo buzzer | 1 | THT/wired component | **Purchased** |
| Buzzer transistor and resistors | 1 set | Package TBD | Not confirmed |
| Arc/current-sense front end | 1 | Module/through-hole prototype circuit preferred; exact implementation TBD | TBD |
| Comparators | 2 | DIP THT versions are possible; exact IC/package not selected | TBD |
| 74HC74 SR latch | 1 | DIP THT version assumed for breadboard prototype | **Purchased** |
| 74HC32 logic OR | 1 | DIP THT version assumed for breadboard prototype | **Purchased** |
| ISO7710F | 1 | SMT package; use an adapter or choose a THT isolator module | Not confirmed |
| PCF8574 I²C expander | 1 | DIP THT version assumed for breadboard prototype | **Purchased** |
| Fail-off coil driver | 1 | THT-friendly driver circuit possible; exact parts TBD | TBD |
| DC fuse and holder | 1 | Holder is panel/chassis or THT depending selection | TBD |
| IRFP460 Q1 | 1 | TO-247 THT power package | Not confirmed |
| 2N7002 and gate resistors | 1 set | 2N7002 is normally SOT-23 SMT; choose a THT substitute or adapter for breadboard use | Not confirmed |
| K1 DC-rated contactor/relay | 1 | Chassis/terminal wiring, not a breadboard component | TBD |
| K1 coil driver and flyback diode | 1 set | THT-friendly driver circuit possible; exact parts TBD | Not confirmed |
| BAOMAIN mushroom E-stop | 1 | Panel-mount, screw-terminal wiring; not PCB/breadboard-mounted | Not confirmed ordered |
| NC lid interlock | 1 | Wired/panel-mount microswitch | Not confirmed |
| Ballast and bleed resistors | 1 set | Chassis/THT power components; ratings and packages TBD | Not confirmed |
| NEMA 17, TMC2209, endstops | 1 set | Motor and switches are wired; TMC2209 module is THT-header breadboardable with SMT driver IC | Not confirmed |
| Carriage/frame/tank/enclosure hardware | 1 set | Mechanical/chassis hardware, not PCB-mounted | Not confirmed |
| 24 V brick and HV test leads | 1 set | External wired equipment | Not confirmed |
| Board headers and ribbon cable | 1 set | THT headers; cable/harness assembly | TBD |
| KUAIQU SPPS-D1203-232 | 1 | External bench supply with terminals | **Ordered; not received/tested** |

The ADS1115 status is now treated as purchased. Adafruit describes the
breakout as fully assembled with a supplied 0.1 in header for breadboard or
perfboard use, while the ADS1115 circuitry itself is surface-mount
([Adafruit product page](https://www.adafruit.com/product/1085)). The
ISO1541DR package is SOIC-8 according to TI, so it is not directly
breadboardable without an adapter ([TI package listing](https://www.ti.com/product/ISO1541/part-details/ISO1541DR)).

### Sensing and control

| Qty | Part | Purpose | Approx. each |
|---:|---|---|---:|
| 1 | Raspberry Pi Pico WH (RP2040, headers + wireless) | Controller | price TBD ([Raspberry Pi](https://www.raspberrypi.com/products/raspberry-pi-pico/)) |
| 1 | ADS1115 16-bit ADC breakout | Cell voltage, shunt current; THT-capable breakout with SMT ADC | $15; **purchased** ([Adafruit](https://www.adafruit.com/product/1085)) |
| 1 | ISO1541DR | Isolated I²C barrier | ~$3 |
| 1 | TRACO TMR 0522 / reported “TMR 3-0522” (5 V → ±12 V, 2 W) | Isolated sense-side supply | **Purchased; verify exact MPN** |
| 1 | 24 V-to-5 V buck converter | Logic-board and TMR input rail | TBD |
| 1 | 3V3 regulator rated for ≥15 V input | 3V3 on sense side from +12 V | TBD |
| 3 | 330 kΩ 1% 1/4 W metal film | HV divider string | ~$0.30 |
| 1 | 24.9 kΩ 0.1% | Divider bottom leg | ~$1 |
| 1 | 0.1 Ω 3 W sense resistor | Shunt | ~$2 |
| 1 assortment | BAT54 assortment (listing labels include BAT54SW/BAT54SWT1G/BAT54S) | ADC clamp candidates; mixed THT/SMT assortment with through-hole components included; identify the selected diode before wiring | **Purchased** |
| 1 | SSD1306 128×64 I²C OLED | Recipe editor, band preview, live coaching | ~$8 |
| 1 | 24C16 I²C EEPROM, DIP-8/THT | Persist calibration results, recipe slots, geometry, counters, and configuration across Pico/ESP32 replacement | **Unpurchased** |
| 1 | EC11 incremental rotary encoder with integrated push switch and knob | Scroll fields and values; encoder push is the planned SELECT input | Ordered; cost recorded by user |
| 1 kit | 6×6 mm tactile pushbutton assortment, 250 pieces / 10 heights, 4-pin momentary NO | Candidate BACK button; exact height and individual switch remain TBD | $8.49 kit ([Amazon listing](https://www.amazon.com/dp/B0FLGZB3VP)) |
| 1 | Piezo buzzer + transistor | Out-of-tolerance chirp, fault alert; buzzer purchased, transistor not confirmed | Buzzer **purchased**; transistor TBD |

### Arc and fault detection (sense board)

| Qty | Part | Purpose | Approx. each |
|---:|---|---|---:|
| 1 | Current-sense / arc front end with validated gain and headroom | Fast shunt protection path; exact part TBD | TBD |
| 2 | LM393 / TLV3502 dual comparator | Four trip channels | ~$1.50 |
| 1 | 74HC74 or CD4043 | SR latch, holds the trip; 74HC74 purchased | 74HC74 **purchased** |
| 1 | 74HC32 or diode-OR network | Channel combining; 74HC32 purchased | 74HC32 **purchased** |
| 1 | ISO7710F single-channel digital isolator | Low-default OUTPUT ENABLE across the barrier | ~$2.50 |
| 1 | PCF8574 I²C expander + fail-off coil driver | Latch status/reset and K1 coil on the sense side; PCF8574 purchased, driver TBD | PCF8574 **purchased**; driver TBD |
| 1 | Coordinated DC fuse + holder | Last-resort anode lead protection | TBD |
| — | 10 nF / 10 kΩ high-pass, trim pots for thresholds | Arc-channel tuning | ~$4 |
| — | Passives, headers, perfboard or small PCB | | ~$15 |

### Kill chain and safety

| Qty | Part | Approx. each |
|---:|---|---:|
| 1 | IRFP460 (Q1, switch duty, thermal design required) | ~$4 |
| 1 | 2N7002 + gate resistors (E-stop gate pulldown) | ~$0.50 |
| 1 | DC-rated safety contactor/relay (K1), voltage/current rating TBD | TBD |
| 1 | ULN2003 or MOSFET + flyback diode for coil | ~$1 |
| 1 | BAOMAIN red mushroom E-stop station, 1NO + 1NC, twist reset | Prototype hardwired E-stop input; NC contact opens K1 coil circuit and drives the Q1 gate pulldown; NO contact is non-safety status only | $9.99 ([Amazon listing](https://www.amazon.com/dp/B00NTT91Y0)) |
| 1 | NC lid interlock microswitch | ~$4 |
| 1 | Ballast resistor, value/rating TBD by fault-energy calculation | TBD |
| 1 | 100 kΩ 2 W bleed resistor | ~$1 |

### Motion

| Qty | Part | Approx. each |
|---:|---|---:|
| 1 | NEMA 17 with integrated 150 mm T8 lead screw | ~$21 ([eBay listing](https://www.ebay.com/itm/186502889154)) |
| 1 | TMC2209 driver module | $9 ([Adafruit](https://www.adafruit.com/product/6121)) |
| 2 | Endstop switch | ~$3 |
| 1 | Anti-backlash nut, carriage plate, pulley, PTFE line | ~$20 |
| 1 | 2020 extrusion and frame hardware | ~$30 |

### Bath and enclosure

| Qty | Part | Approx. each |
|---:|---|---:|
| 1 | 24 V 2.5 A DC brick (motor + logic) | ~$15 |
| 1 | 600 V silicone HV test lead set | ~$12 |
| 1 | Polypropylene tank + Ti or 316 SS cathode plate | ~$25 |
| 1 | Insulated enclosure, glands, standoffs, labels | ~$35 |

### Logic-to-sense interconnect (provisional)

| Qty | Part | Purpose | Status |
|---:|---|---|---|
| 2 | Keyed/shrouded header assemblies, one per board | Mating control/sense-board connectors | At least 8 usable circuits plus any unpopulated guard positions required by the isolation layout; part number, pitch, current rating, and stock TBD |
| 1 | Matching multi-conductor ribbon cable assembly | Inter-board logic-side data and 5 V feed | At least 8 active conductors; length and cable/connector ratings TBD; use heavier-gauge 5 V/return conductors or a separate 2 A power pair if needed |

The current block diagram identifies seven conductors: logic-side +5 V and
return to the TMR 0522 primary, I²C SDA/SCL, output-enable, interlock feedback,
and hardware-fault IRQ; the eighth is a spare. This is a provisional count, not
a released pinout. The harness must terminate only on the logic/primary sides
of the isolation components. Do not carry `HV_RETURN` or isolated secondary
rails on this ribbon, and preserve the required creepage/clearance and board
slot around its landing area. If a single ribbon cannot satisfy the insulation,
voltage-drop, or current requirements, split the power pair into separate
heavier-gauge insulated wires. Select stocked, keyed parts after the connector
and isolation layout are finalized.

### External supply candidates — system-level BOM (not PCB assembly)

| Qty | Candidate | Status | Project fit and open checks |
|---:|---|---|---|
| 1 | KUAIQU SPPS-D1203-232, selected listing variant `spps-d1203-232-110v` ([product page](https://www.kuaiquinstrument.com/products/spps-d-232-black?variant=47218453184689)) | **Ordered; manufacturer documents pending; not received or bench-tested** | Listed as 0–120 V / 3 A. The listing conflicts between 300 W and 360 W; expected use below 2 A at up to 105 V is about 210 W, but confirm the exact continuous rating. Per vendor correspondence relayed by the project owner (2026-09-23), the optional USB interface supports standard Modbus RTU and its communication ground is galvanically isolated from the output-voltage ground. The published protocol lists 9600 baud, 8-N-1, remote mode, setpoint/readback registers, and output control ([protocol](https://cdn.shopify.com/s/files/1/0705/8027/3329/files/modbus_protocol_2026-09-15.docx?v=1789454072)). Review the incoming docs for exact-model applicability, isolation working/withstand ratings, output behavior on communication loss, and the power-rating discrepancy before integration. |

This is an ordered system-level candidate for a possible fully MCU-controlled,
hands-off process, not yet an approved replacement for the currently described
manual-supply setup. USB/Modbus commands must not replace the independent Q1/K1
shutdown, interlocks, and electrode-pair discharge verification. The vendor
reports galvanic isolation between USB communication ground and output ground;
review the incoming documentation and test the exact unit before integrating it.

**Cost estimate:** not currently reliable. The regulator, protection front end, DC-rated contactor, ballast, fuse, and isolation-test requirements remain TBD; recalculate the BOM after the schematic and hazard analysis are complete.

For the current manual-supply concept, the hand-knob approach avoids adding a
programmable supply and the associated host-control path. The external supply
candidate above is a separate future option and does not change this baseline.

---

## 9. Commissioning order

1. **Sense chain dry.** No cell connected. Sweep the supply 0→120 V and build the two-point calibration; confirm agreement with a DMM within 0.5 V across the range.
2. **Isolation check.** Confirm the design's required creepage/clearance, insulation resistance, and withstand test using appropriately rated test equipment and qualified procedures; a continuity check alone is insufficient.
3. **Kill chain, dry.** Test E-stop, lid switch and every firmware fault. Confirm Q1 opens and K1 drops, every time, before electrolyte is in the room.
4. **Resistive load.** Substitute a 220 Ω 100 W resistor for the bath. Verify current readings and every trip channel: short the load for OVERCURRENT, open it for OPEN CIRCUIT, and confirm the latch holds until acknowledged.
5. **Arc-detector calibration.** Use a controlled injected transient or an enclosed, interlocked test fixture under qualified supervision; do not draw an open-bench arc. Set the ARC comparator threshold below the validated detection level, then verify a normal 0→105 V ramp into the resistive load produces **zero** false trips.
6. **Motion dry-run.** Full sweep with the tank empty, watching for swing, twist or binding, and confirming homing repeatability over ten cycles. Verify commanded length against a caliper at 10, 50 and 99 mm, confirm the length survives a power cycle, and confirm BACK aborts cleanly mid-sweep.
7. **Flat coupons.** Fixed voltages in 5 V steps, photographed against a ruler, to seed and then correct the palette windows. Pay extra attention above 70 V — that is where your display-piece recipes live, and the windows are narrowest in volts there.
8. **Enable the following loop.** Mode 2 first, on a coupon, before a part you care about.

---

## 10. Prototype to production — MCU selection

One design decision already made this easy: **all the precision analog lives off-chip.** The ADS1115 does the measuring, the TMC2209 does the current control, and the OLED is I²C. So the MCU needs only GPIO, two I²C buses, one UART, hardware timers for step generation, and maybe 50 KB of flash. Every candidate below is wildly overqualified. That means you should choose on **supply-chain and porting risk**, not performance.

### Candidates with both a dev board and an assemblable SMT part

| Chip | Dev board | SMT part | Package | External parts needed | Port cost from your prototype |
|---|---|---|---|---|---|
| **RP2040** | Pico / Pico H / Pico WH | QFN-56, 7×7 mm, stocked as [JLCPCB C2761095](https://jlcpcb.com/partdetail/RaspberryPi-RP2040/C2761095) | QFN-56, centre ground pad | QSPI flash, 12 MHz crystal + 2 caps, 3V3 LDO, BOOTSEL button, ~6 decouplers | **Zero.** Same GPIO numbering as the Pico, same SDK |
| **RP2354A** | Pico 2 | QFN-60 | QFN-60 | **No external flash** — 2 MB is on-die. Crystal, LDO, caps only | Near zero; SDK is shared |
| **ESP32-S3-WROOM-1** | ESP32-S3-DevKitC-1 | Pre-certified module, ~$4 at [JLCPCB](https://jlcpcb.com/partdetail/3198299-ESP32_S3_WROOM_1_N8R8/C2913201) | Castellated module, one placement | Essentially none — flash, PSRAM, crystal and antenna are inside | Moderate rewrite; gains Wi-Fi |
| **STM32G071C8** | Nucleo-G071RB | [LQFP-48](https://jlcpcb.com/partdetail/STMicroelectronics-STM32G071C8T6/C529341) | **LQFP-48 — hand-solderable and reworkable** | Crystal optional (internal osc is adequate here), LDO, caps | Full rewrite in C/HAL |

### Recommendation, in order

**1. Solder the Pico module down, or socket it.** For a one-off machine this is arguably the correct engineering answer and it deserves stating before the clever options. Lay out a castellated footprint or a pair of 2×20 headers, and the production board carries the same $5 Pico you prototyped with. Zero porting, zero bring-up risk, no crystal or flash layout to get wrong, USB already routed, and if the MCU ever dies in a bath splash you replace a module instead of desoldering a QFN. Most assembly houses will place a castellated module as an extended part, or you hand-solder it in ten minutes ([SparkFun castellated soldering guide](https://learn.sparkfun.com/tutorials/how-to-solder-castellated-mounting-holes/all)).

**2. RP2354A if you want a proper integrated board.** The QFN-60 with 2 MB of on-die flash removes the external QSPI chip and its layout constraints, which is the fiddliest part of an RP2040 design ([RP2350 product brief](https://www.mouser.com/datasheet/2/635/Raspberry_Pi_05_22_2025_rp2350_product_brief-3600627.pdf)). Pico 2 is the matching dev board.

**3. RP2040 if you want maximum documentation.** The minimal-design reference circuit is thoroughly trodden: chip, QSPI flash, 12 MHz crystal, LDO, boot button, decoupling ([RP2040 minimal design notes](https://www.makeirl.com/blog/rp2040-minimal-design)). Its weak on-chip ADC is the usual objection to the RP2040 and it does not apply to you at all, since the ADS1115 does every measurement that matters.

**4. ESP32-S3-WROOM-1 if you want the machine on the network.** Pushing run logs, recipes and palette calibration to a laptop over Wi-Fi instead of USB is genuinely useful for building the color table across many sessions. The module is a single placement with no RF layout work. Cost is a firmware rewrite and a larger attack surface on a machine that switches 120 V.

**5. STM32G0 only if hand-rework matters more than porting.** LQFP-48 is the one package here you can reflow with an iron and inspect with a loupe, and the timers are better than anything else on the list for step generation. But you would rewrite the firmware in C, and none of the performance is needed.

### DFM notes for the assembly house

- **Manufacturing target: JLCPCB.** Prefer suitable in-stock Basic inventory
  parts; Extended inventory is acceptable when necessary. Every finalized BOM
  item must be confirmed in stock at its chosen supplier at order preparation,
  with adequate quantity available. Recheck JLCPCB catalog stock immediately
  before ordering; pause and revise the BOM rather than silently substituting an
  unavailable part.
- **Split the design into two boards.** Send the **logic board** out for assembly. Build the **HV sense and kill board by hand**, through-hole. Low-cost assemblers will happily put 0603 parts 0.3 mm apart across your 120 V divider, which is exactly what you do not want, and they will not respect an isolation keepout unless you make it a fab note plus a milled slot. That board also deserves your own eyes on every joint.
- **Watch basic versus extended parts.** Extended components attract a per-part-type feeder fee, so consolidate passive values and prefer Basic parts where the choice is free ([JLCPCB assembly pricing](https://jlcpcb.com/help/article/pcb-assembly-price)).
- **Keep GPIO numbers identical** between the dev board and the PCB. With RP2040 the chip's GPIO numbering already matches the Pico's labels, so firmware moves across untouched.
- **Test points** on the divider tap, both shunt sense lines, the Q1 gate and the 3V3 rails. You will want them during the commissioning sequence in §9.
- **Connector between boards:** high-clearance, keyed, with an unpopulated pin either side of anything carrying the HV sense return, and a slot in the board between them.

---

## References

- Color/voltage charts: [DFocus](https://dfocusrp.com/resources/titanium-anodizing-color-chart/), [Hontitan](https://hontitan.com/how-to-anodize-titanium-at-home/), [MonsterBolts](https://monsterbolts.com/pages/anodized-titanium-color-chart)
- [TI ISO1541 isolated I²C datasheet](https://www.ti.com/lit/ds/symlink/iso1541.pdf)
- [Vishay IRFP460 datasheet](https://www.vishay.com/docs/91237/91237.pdf)
- [TRACO TMR 2 series datasheet](https://www.tracopower.com/tmr2-datasheet) — verify the required insulation class and continuous working voltage; the indexed listing describes functional insulation.
- [Adafruit ADS1115](https://www.adafruit.com/product/1085) · [Adafruit TMC2209 breakout](https://www.adafruit.com/product/6121) · [Raspberry Pi Pico WH](https://www.raspberrypi.com/products/raspberry-pi-pico/)
- Process background: replace the former AMS-2471 citation with titanium-specific evidence before deriving current-density or voltage limits; [Caswell plating manual](https://tosih.org/files/books/caswell_inc_plating_manual.pdf) remains background only.
