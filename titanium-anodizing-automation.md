# Automated Titanium Anodizing for Color Effects

> **Untested conceptual design.** The values and procedures below are research
> notes, not validated operating instructions. Do not connect a supply or
> electrolyte until the electrical design, guarding, ventilation, chemical
> controls, and emergency shutdown have been reviewed and tested.

## Project goal

Automate titanium anodizing across approximately 0–105 V DC while smoothly lifting the workpiece from the electrolyte to create a controlled color gradient or rainbow effect.

## Power requirements

For a small titanium object, a 0–105 V DC supply capable of approximately 1–2 A is generally sufficient. The actual current depends on the exposed titanium area, electrolyte, electrode spacing, and bath condition.

A useful starting estimate is:

```text
Current ≈ exposed area in dm² × 1–2.5 A/dm²
```

Approximate examples:

| Exposed area | Approximate current |
|---:|---:|
| 10 cm² | 0.1–0.25 A |
| 50 cm² | 0.5–1.25 A |
| 100 cm² | 1–2.5 A |

The supply does not need to deliver its maximum current continuously. A 0–120 V, 3 A supply may provide useful headroom, provided its current limit can be set low enough for the workpiece and the external ballast, fuse, wiring, and protection system are rated for the validated operating and fault currents. The current values here are illustrative, not approved limits.

Titanium color is primarily controlled by the anodizing voltage. The oxide thickness determines the optical interference color, while current mainly determines whether the process can proceed evenly and whether the supply overloads.

## PWM and voltage control

Raw PWM applied directly to the anodizing bath is not recommended for precise color control. A signal switching between 0 V and a high voltage does not reliably behave like a steady intermediate voltage because the electrochemical process responds to the instantaneous voltage and its history.

Raw PWM can produce uneven colors, banding, or localized burning. For automation, use one of these approaches:

- A programmable 0–105/120 V constant-voltage supply.
- A high-voltage DC converter controlled by a DAC or filtered PWM signal.
- A PWM-controlled converter followed by a properly rated LC filter and closed-loop voltage feedback.

The output should have a controlled ramp, low overshoot, and a current limit. The voltage should be measured at the anodizing cell or supply terminals so the controller knows the actual output rather than relying only on the command signal.

## Creating a rainbow or gradient

There are two different effects:

1. **Whole-part color sweep:** change the voltage while the entire part is immersed. This generally leaves one final color over most of the exposed surface.
2. **Spatial gradient:** coordinate voltage with position while the part is being lifted. Different sections leave the electrolyte at different times and therefore receive different anodizing conditions.

For a spatial rainbow, use a slow, repeatable lift and change the voltage as a function of position. The final pattern will also be affected by the bath meniscus, electrolyte drainage, surface cleanliness, contact quality, and the exact titanium alloy.

The color-to-voltage relationship is not perfectly universal, so calibration coupons or test pieces should be used to build a voltage-versus-color map for the particular bath and material.

## Lifting mechanism

A servo-controlled arm with a pulley can work. The pulley can help keep the workpiece in the same vertical plane, but a guide is still useful to prevent swinging, twisting, or sideways movement.

Recommended mechanical features:

- Rigidly mount the bath, pulley, and actuator to a common frame.
- Use chemically resistant, electrically insulating line such as PTFE, nylon, or polypropylene.
- Keep the servo, pulley hardware, frame, and actuator electrically isolated from the electrolyte and titanium electrode.
- Add a guide rail, guide tube, or two-point guide if the workpiece rotates or swings.
- Use gentle acceleration and deceleration so the workpiece does not create waves in the bath.
- Provide a flexible electrical lead with strain relief so lifting does not pull on the electrical contact.
- Keep the contact point above the active surface when possible; the contact area may remain uncolored or develop a different finish.

A vertical linear actuator, belt drive, or leadscrew is generally easier to calibrate than a rotating servo arm because its speed and position are more directly related. If a servo arm is used, measure the actual vertical position and create a calibration table because lift speed changes with arm angle.

## Suggested control sequence

```text
1. Confirm the workpiece is securely connected.
2. Confirm the lift is at its starting position.
3. Confirm the bath level and electrode position.
4. Set a safe current limit and maximum voltage.
5. Fully immerse the workpiece.
6. Enable the DC output at a controlled voltage.
7. Wait for the output and current to settle.
8. Begin lifting at a constant, slow speed.
9. Update voltage according to measured lift position.
10. Monitor voltage, current, travel position, and fault status.
11. Disable the output before the electrical contact or wet section can arc.
12. Finish lifting and rinse the workpiece.
```

A position-based ramp is preferable to a purely time-based ramp because the result remains more consistent if the actuator speed changes slightly.

Example conceptual mapping:

```text
voltage = start_voltage + (position / lift_distance) × voltage_span
```

In practice, use a lookup table or calibrated curve rather than assuming that voltage maps linearly to perceived color.

## Suitable power supplies

The preferred specification is:

- Output: 0–105 or 0–120 V DC
- Current capacity: 0.5–3 A for small parts
- Constant-voltage and constant-current modes
- Adjustable current limit
- Remote output enable
- USB, RS-232, LAN, or isolated 0–10 V analog programming
- Overvoltage, overcurrent, and thermal protection
- Controlled voltage ramp or sequencing
- Low output overshoot and ripple

Potential supply classes and examples:

### GW Instek GPP-6030

The GPP-6030 family supports the required voltage range only in the documented
tracking-series configuration: its main channels are individually 0–60 V, while
120 V operation is obtained by series tracking. Confirm the exact model,
configuration, insulation, current limit, and manufacturer operating procedure
before treating it as a 0–120 V source.

Reference: [GW Instek GPP programmable DC power supplies](https://www.gwinstek.com/en-GB/products/downloadSeriesDownNew/21838/2128)

### Chroma 6200-120

The Chroma 6200-120 is listed as a 0–120 V, 0.5 A, 60 W programmable DC source. It supports optional analog, RS-232, or GPIB programming. Its current rating may be sufficient for very small workpieces.

Reference: [Chroma 6200 series specifications](https://www.chromausa.com/pdf/2009-General-Catalog-Power-Section.pdf)

### Low-cost 120 V, 3 A bench supplies

Low-cost supplies advertised as 0–120 V and 0–3 A may be adequate electrically, but the word “programmable” is inconsistent across models. Some provide only front-panel adjustment, memory presets, or a USB charging port. Before buying, confirm that the unit supports actual remote voltage commands, analog programming, or a documented serial protocol.

## Safety and implementation requirements

105–120 V DC in a conductive electrolyte can cause severe shock, arcing, burns, gas ignition, chemical exposure, and equipment damage. Use an isolated, current-limited supply and enclose or guard the bath and electrical connections. Provide ventilation for generated gas and chemical mist, control ignition sources, and never access the bath while energized.

Recommended protections include:

- Current limiting set below the maximum safe level for the part.
- A hardwired emergency disconnect.
- A normally disabled output that requires an explicit enable command.
- Overvoltage protection below the maximum allowed voltage.
- A lid, shield, or guarded work area around the bath.
- No exposed mains wiring near the electrolyte.
- Strain relief and insulation on every moving electrical lead.
- A fault condition that disables the supply if the actuator stalls, the workpiece leaves the expected path, or current rises unexpectedly.

The actuator and its control electronics should be electrically isolated from the anodizing circuit. The bath should not be used as a structural or electrical reference for the motion system.

## Process references

- AMS2471 is an aluminum-alloy anodizing standard and is not a titanium process
  specification. Do not use it to derive titanium voltage, current-density, or
  color limits without titanium-specific evidence.
- [Caswell plating manual](https://tosih.org/files/books/caswell_inc_plating_manual.pdf)
- [Research on voltage-based coloring of Ti-6Al-4V](https://www.sciencedirect.com/science/article/pii/S0022391317301440)

These references provide general process information. The final voltage and current settings should be established experimentally for the specific titanium alloy, electrolyte, geometry, and electrode arrangement.
