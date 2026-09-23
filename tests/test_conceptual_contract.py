"""Offline guardrails for the conceptual controller artifacts.

These tests do not certify hardware or electrochemistry. They prevent future
edits from silently removing the safety-contract elements reviewed in
Anodization-Controller-Review.md.
"""

from pathlib import Path
import ast
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ConceptualContractTests(unittest.TestCase):
    def test_firmware_is_valid_python_and_has_latched_safety_states(self):
        source = (ROOT / "controller_firmware.py").read_text()
        tree = ast.parse(source)
        functions = {node.name for node in tree.body if isinstance(node, ast.FunctionDef)}
        self.assertIn("safety_supervisor", functions)
        self.assertIn("validate_touchdown", functions)
        self.assertIn("verify_discharge", functions)
        for token in ("DISCHARGE", "UNIFORM_HOLD", "FAULT", "MIN_CONTACT_CURRENT", "V_MAX_SOFT"):
            self.assertIn(token, source)

    def test_firmware_does_not_treat_output_off_as_discharge_proof(self):
        source = (ROOT / "controller_firmware.py").read_text()
        discharge_start = source.index("def verify_discharge")
        discharge = source[discharge_start:]
        self.assertIn("read_electrode_pair_voltage", discharge)
        self.assertIn("q1_state_is_off", discharge)
        self.assertIn("k1_state_is_off", discharge)
        self.assertIn("DISCHARGE_TIMEOUT", discharge)

    def test_simulator_models_independent_fault_assumptions(self):
        source = (ROOT / "simulator.js").read_text()
        for token in (
            '"q1-short"', '"k1-welded"', '"stale-adc"', '"open-contact"',
            '"overcurrent"', '"motion-stall"', '"residual-charge"',
            "function safetySupervisor", "function actualCell", "function beginDischarge",
        ):
            self.assertIn(token, source)

    def test_simulator_latches_recipe_and_distinguishes_outcomes(self):
        source = (ROOT / "simulator.js").read_text()
        self.assertIn("sim.recipe = recipe", source)
        self.assertIn('"UNIFORM_HOLD"', source)
        for outcome in ('"COMPLETED"', '"ABORTED"', '"FAULT"'):
            self.assertIn(outcome, source)
        self.assertIn("sectionPeaks", source)

    def test_review_regressions_are_guarded(self):
        simulator = (ROOT / "simulator.js").read_text()
        firmware = (ROOT / "controller_firmware.py").read_text()
        # Discharge must use a fresh, stable, non-negative electrode reading;
        # a stale zero or a negative sensor value cannot authorize retraction.
        self.assertIn("sim.adcAge === 0", simulator)
        self.assertIn("sim.dischargeSafeStable >= 0.25", simulator)
        self.assertIn("measurement_fresh(\"electrode_pair\")", firmware)
        self.assertIn("electrode_v >= 0", firmware)
        # Interlock loss blocks both active operation and automatic retraction.
        self.assertIn("if (!els.lid.checked || !els.estop.checked) return;", simulator)
        self.assertIn("hold_axis()", firmware)
        # Final output cutoff is on the wet side, before the part clears the bath.
        self.assertIn("sim.cutoff = sim.surfacePos + CONFIG.ARC_MARGIN", simulator)
        self.assertIn('s === "DISCHARGE" ? "Set bench supply knob to 0 V"', simulator)
        self.assertIn('addLog(`Q1/K1 commanded off; verifying electrode discharge', simulator)
        self.assertIn("TOUCHDOWN_TIMEOUT: 240", simulator)


if __name__ == "__main__":
    unittest.main()
