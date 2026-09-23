# Anodization Controller

Engineering notes and an untested conceptual design for a titanium anodizing
lift controller.

This is a [Bug-Mag.net project](http://bug-mag.net) by Duv McIntyre.

> **Untested conceptual design — do not build or energize from these notes.**
> Nothing in this repository has been validated on hardware. The circuit,
> protection system, firmware, motion geometry, and process limits require a
> qualified electrical/mechanical safety review and controlled testing before
> any connection to a high-voltage supply or electrolyte.

## Contents

- `anodizer-engineering-handoff.md` — engineering handoff and commissioning notes.
- `anodizer-controller-design.md` — circuit design, BOM, UI, and firmware sketch.
- `titanium-anodizing-automation.md` — process, motion, power-supply, and safety notes.
- `controller_firmware.py` — Python-formatted extraction of the palette and firmware pseudocode from the controller design note.
- `simulator.html` and `simulator.js` — browser simulator for the manual supply, Pico WH controller logic, lift actuator, discharge check, and fault model.
- `Anodization-Controller-Review.md` — local, ignored source/design review artifact when present; it is not part of the public repository.

The conceptual controller target is a **Raspberry Pi Pico WH** (the Pico 1
family with pre-soldered headers and wireless). The simulator exposes the same
board target and GPIO map used by the design notes; its Wi-Fi/BLE radio is not
used by this conceptual control path.

The Python file is a design artifact, not runnable production firmware. It
contains undefined hardware interfaces and deliberately fails closed in the
illustrative control flow; it must not be connected to hardware without a
complete electrical, firmware, and safety review.

## Current conceptual behavior

The current simulator/reference sketch includes the first review remediation
pass: discharge requires fresh, finite, non-negative electrode-pair readings
below the access threshold for a short dwell; failed discharge remains a
latched FAULT; E-stop/lid opening prevents automatic retraction; touchdown has
enough timeout budget for the modeled travel; and invalid/negative current is
rejected. These are software-model checks only and do not prove that a real
Pico, power supply, switching path, or independent safety circuit will behave
the same way.

- The part descends slowly to the electrically detected surface, then continues
  at the low touchdown voltage until it reaches the full-submersion coordinate.
  Only then does it settle and pre-form at the recipe start voltage. At the
  default 75 V start point, the whole wetted part receives the baseline color
  before the lift begins.
- Settle is estimated from the measured current transient: voltage must be in
  tolerance and the filtered logarithmic current slope must remain below the
  conceptual threshold for the required dwell. The threshold and timeout are
  commissioning placeholders, not validated process limits.
- In coached mode, the carriage tracks every measured-voltage change in either
  direction through the selected recipe table. Equal-band mode allocates equal
  physical width per color; linear mode maps voltage linearly between endpoints.
  A voltage decrease moves the carriage back down, but does not undo the peak
  color already formed on a section. Recipe overshoot, stale measurements,
  open contact, overcurrent, overvoltage, interlock changes, and motion error
  are latched faults.
- UNIFORM is a separate process: one color is validated, the part remains fully
  submerged after formation, and **BACK** requests extraction. It does not
  follow the gradient table.
- Output shutdown enters a discharge-verification state. The simulator models
  Q1, K1, electrode-pair voltage, residual charge, and failed-switch
  injections separately; retraction is not authorized until both switches are
  open and the simulated electrode voltage is below the access threshold.
- At the planned final cutoff, with the part's tip still 3 mm below the modeled
  bath surface, Q1/K1 are commanded off and discharge is verified before the
  actuator begins retracting. An earlier loss of supply output still latches
  an open-cell fault.
- Reaching the planned final recipe cutoff transitions directly to discharge
  verification before the expected end-of-immersion current drop is checked as
  an open-cell fault.
- The visualization retains a peak-voltage history for each physical section.
  DONE, ABORTED, and FAULT outcomes are distinct, and an aborted or unformed
  run is not painted as a successful rainbow.
- **BACK** is the explicit graceful-abort command. Turning the manual supply to
  0 V by itself does not command motion. E-stop and lid interlock trips latch
  until Reset; closing the lid or releasing E-stop does not resume a run.

## Simulator

Open [`simulator.html`](simulator.html) in a modern browser. Set the manual
bench-supply voltage to the low touchdown range first, set a current limit,
enable the simulated output, and press **SELECT (hold 1 s)** to begin the
conceptual run. The run then requires a low-energy touchdown, a measured
formation settle, and the selected process sequence. **BACK** starts output
shutdown and discharge verification before retraction; **Reset** is required
after a fault and returns the simulator to idle. The fault selector exercises
stale ADC data, open contact, stuck Q1/K1, motion stall, overcurrent, and slow
discharge assumptions. The simulator includes the Pico WH front-panel
controls, controller display, actuator position, exposure-history coloring,
and voltage/current trace.

The supply-output checkbox must be enabled before starting; a nonzero setpoint
does not provide simulated electrode voltage while output is unavailable. The
simulator blocks Run with a log message if the output is off and latches a fault
if it is opened during touchdown, submersion, or formation.

At 0 V, touchdown lowers the part toward the modeled bath surface and pauses
there; zero volts cannot produce the current signal used to confirm electrical
contact. Set a low nonzero touchdown voltage (at or below the conceptual 12 V
limit) to confirm contact, then watch the same slow descent continue through
full submersion before setting the recipe voltage. This modeled position is not
a substitute for a physical surface or travel sensor. The browser animates
this travel at 1 mm/s for usability; that is not a hardware speed
recommendation, and the Python sketch retains its separate 0.2 mm/s placeholder.

The voltage slider also shows triangle markers for the selected recipe's
programmed setpoints. These include the start, color-boundary, and end
voltages, with exact decimal values, as visual ramp targets; they are
deliberately not clickable so the operator can move continuously between them.

The simulator palette includes all 13 nominal color/voltage labels shown by
the product page's color-swatch image filenames. `HIGH POLISH (0 V)` is shown
for reference but disabled as a recipe endpoint because it represents no
anodizing. Vendor labels and sample voltages are not calibrated limits for a
particular bath or alloy; calibrate with coupons before treating them as
process settings.

## Safety

The design concerns high-voltage DC in a conductive electrolyte. Follow the
source notes' isolation, current limiting, guarding, emergency-disconnect, and
fault-shutdown requirements. Establish operating limits experimentally for the
specific supply, bath, alloy, geometry, and electrode arrangement.

## License and attribution

Copyright © 2026 Duv McIntyre.

The code and documentation in this repository are licensed under the [Creative
Commons Attribution 4.0 International License (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

When redistributing or adapting this work, credit **Duv McIntyre**, identify it
as a **Bug-Mag.net project**, and link to [http://bug-mag.net](http://bug-mag.net).
The complete license notice is in [`LICENSE`](LICENSE).

Creative Commons does not recommend CC licenses for software; CC BY 4.0 is used
here for both code and documentation at the author's request. Downstream
projects should review whether a software-specific license is more suitable.
