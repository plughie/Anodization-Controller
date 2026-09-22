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
- `simulator.html` — browser simulator for the manual supply, Pico WH controller logic, and lift actuator.

The conceptual controller target is a **Raspberry Pi Pico WH** (the Pico 1
family with pre-soldered headers and wireless). The simulator exposes the same
board target and GPIO map used by the design notes; its Wi-Fi/BLE radio is not
used by this conceptual control path.

The Python file is a design artifact, not runnable production firmware. It
contains undefined hardware interfaces and deliberately fails closed in the
illustrative control flow; it must not be connected to hardware without a
complete electrical, firmware, and safety review.

## Simulator

Open [`simulator.html`](simulator.html) in a modern browser. Set the manual
bench-supply voltage and current limit, enable the simulated output, and press
**SELECT (hold 1 s)** to begin the conceptual run. **BACK** disables the
output and starts a graceful retract during an active run; **Reset** clears a
latched fault or returns the simulator to idle. The simulator includes the
Pico WH front-panel controls, controller display, actuator position, and
voltage/current trace.

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
