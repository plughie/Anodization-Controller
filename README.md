# Anodization Controller

Engineering notes and a conceptual firmware sketch for a titanium anodizing
lift controller.

## Contents

- `anodizer-engineering-handoff.md` — engineering handoff and commissioning notes.
- `anodizer-controller-design.md` — circuit design, BOM, UI, and firmware sketch.
- `titanium-anodizing-automation.md` — process, motion, power-supply, and safety notes.
- `controller_firmware.py` — Python-formatted extraction of the palette and firmware pseudocode from the controller design note.

The Python file is a design artifact, not runnable production firmware. It
contains undefined hardware interfaces and must not be connected to hardware
without a complete electrical, firmware, and safety review.

## Safety

The design concerns high-voltage DC in a conductive electrolyte. Follow the
source notes' isolation, current limiting, guarding, emergency-disconnect, and
fault-shutdown requirements. Establish operating limits experimentally for the
specific supply, bath, alloy, geometry, and electrode arrangement.
