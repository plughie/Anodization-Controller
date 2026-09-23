"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const html = fs.readFileSync("simulator.html", "utf8");
const ids = [...new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]))];
const nodes = new Map();

function makeNode(id) {
  return {
    id,
    value: ({
      "voltage-input": "0", "current-input": "0.5", "mode-input": "COACHED",
      "length-input": "47", "start-input": "6", "end-input": "8", "spread-input": "EQUAL_BANDS"
    })[id] ?? "",
    checked: ["supply-output", "lid-input", "estop-input"].includes(id),
    disabled: false, dataset: {}, style: { setProperty() {} },
    children: [], append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
    cloneNode() { return Object.assign(makeNode(id), { value: this.value, textContent: this.textContent, disabled: this.disabled }); },
    setAttribute() {}, addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return { setAttribute() {} }; }
  };
}

for (const id of ids) nodes.set(id, makeNode(id));
const document = {
  getElementById(id) { if (!nodes.has(id)) nodes.set(id, makeNode(id)); return nodes.get(id); },
  createElement() { return makeNode("option"); }
};
const source = fs.readFileSync("simulator.js", "utf8").replace(
  /\}\)\(\);\s*$/,
  "globalThis.probe = { sim, els, startRun, step, render, updateExposure, colorForVoltage, renderVoltageSetpoints };})();"
);
const context = {
  document, performance: { now: () => 0 }, window: { addEventListener() {} },
  requestAnimationFrame() {}, setTimeout, clearTimeout, Date, console
};
vm.createContext(context);
vm.runInContext(source, context);

const { sim, els, startRun, step, render, updateExposure, colorForVoltage, renderVoltageSetpoints } = context.probe;
assert.equal(els.start.children.length, 13, "selector should include every vendor color image option");
assert.equal(els.start.children[0].disabled, true, "0 V High Polish is not an anodizing recipe color");
assert.deepEqual(els.start.children.map((option) => option.textContent), [
  "HIGH POLISH (0 V, no anodizing)", "DARK BRONZE (15 V)", "PURPLE (22 V)",
  "BLUE (28 V)", "SILVER BLUE (40 V)", "GOLD (65 V)", "ROSE GOLD (70 V)",
  "PINK (75 V)", "DARK FUCHSIA (85 V)", "BLURPLE (92 V)", "PURPLE TEAL (95 V)",
  "TEAL GREEN (103 V)", "GREEN (105 V)"
], "all color and voltage labels must match the product page image names");
assert.equal(colorForVoltage(75), "#df6d9f", "vendor Pink sample should render pink");
assert.equal(colorForVoltage(92), "#665fd6", "vendor Blurple sample should render blurple");
assert.equal(colorForVoltage(105), "#61bd65", "vendor Green sample should render green");
renderVoltageSetpoints();
assert.deepEqual(els.setpoints.children.map((marker) => marker.dataset.voltage), [
  "75.0", "80.0", "88.5", "93.5", "99.0", "104.0", "105.0"
], "default recipe should expose exact programmed voltage markers");
assert.ok(els.setpoints.children.every((marker) => marker.className === "setpoint"), "setpoints should be non-interactive markers");
els.voltage.value = "8.5";
els.supply.checked = false;
startRun();
assert.equal(sim.state, "IDLE", "run should be blocked when simulated output is unavailable");
assert.match(sim.log[0], /enable simulated supply output/);
els.supply.checked = true;
els.voltage.value = "0";
startRun();
step(0.05); // HOMING -> TOUCHDOWN
assert.equal(sim.state, "TOUCHDOWN");
const initialPosition = sim.position;
for (let elapsed = 0; elapsed < 50; elapsed += 0.05) step(0.05);
assert.equal(sim.voltage, 0);
assert.ok(sim.position > initialPosition, "actuator should descend at 0 V");
assert.ok(Math.abs(sim.position - sim.surfacePos) < 0.02, "simulator-rate touchdown should reach the waterline in about 45 s");
assert.equal(sim.state, "TOUCHDOWN", "0 V cannot electrically confirm contact");
render();
assert.match(els.oled2.textContent, /Lowering to surface 100%/);

// Follow the reported default sequence: apply low touchdown voltage, then
// the first coached color voltage and wait while the next target is requested.
els.voltage.value = "6";
step(0.05);
assert.equal(sim.state, "SUBMERGE", "low-voltage current confirms touchdown and starts the visible submerge");
const touchdownPosition = sim.position;
for (let elapsed = 0; elapsed < 52; elapsed += 0.05) step(0.05);
assert.ok(sim.position > touchdownPosition + 40, "carriage should continue descending after surface contact");
assert.equal(sim.position, sim.fullySubmerged, "submerge phase should reach the full-submersion coordinate");
assert.equal(sim.state, "SETTLE", "full submersion should arm the settle phase");
els.voltage.value = "75";
for (let elapsed = 0; elapsed < 12; elapsed += 0.05) step(0.05);
assert.equal(sim.state, "SWEEP", `the first color should settle and arm the coached sweep (state=${sim.state}, fault=${sim.fault}, formation=${sim.formation}, settle=${sim.settleStable}, current=${sim.measuredCurrent}, log=${sim.log.join(" | ")})`);
assert.equal(sim.fault, "", "waiting at a voltage target must not be mistaken for a motion stall");
assert.equal(sim.coachIndex, 0, "start voltage is in the first color band");
els.voltage.value = "80";
for (let elapsed = 0; elapsed < 12; elapsed += 0.05) step(0.05);
assert.ok(Math.abs(sim.frac - 1 / 6) < 0.001, "first equal-band boundary should map to one-sixth of the length");
assert.ok(Math.abs(sim.position - (sim.fullySubmerged - sim.travelSpan / 6)) < 0.2, "carriage should reach the first color boundary");
els.voltage.value = "88.5";
for (let elapsed = 0; elapsed < 12; elapsed += 0.05) step(0.05);
assert.ok(Math.abs(sim.frac - 1 / 3) < 0.001, "second equal-band boundary should map to one-third of the length");
const higherVoltagePosition = sim.position;
els.voltage.value = "76";
for (let elapsed = 0; elapsed < 12; elapsed += 0.05) step(0.05);
assert.ok(sim.position > higherVoltagePosition, "lowering voltage should drive the carriage back down into the bath");
assert.equal(sim.fault, "", "bidirectional tracking must not latch a motion fault");
els.voltage.value = "86.5";
const lowerVoltagePosition = sim.position;
for (let elapsed = 0; elapsed < 12; elapsed += 0.05) step(0.05);
assert.ok(sim.position < lowerVoltagePosition, "raising voltage should drive the carriage back up");

// At the first lifted color boundary, the exposed upper sections retain the
// formation color while submerged lower sections receive the current voltage.
sim.position = sim.fullySubmerged - sim.travelSpan / 3;
sim.measuredVoltage = 100;
const beforeExposure = sim.sectionPeaks.slice();
updateExposure();
assert.ok(sim.sectionPeaks[0] === beforeExposure[0], "top exposed section should retain its earlier color");
assert.ok(sim.sectionPeaks[1] === beforeExposure[1], "next exposed section should retain its earlier color");
assert.ok(sim.sectionPeaks.slice(2).some((peak, index) => peak > beforeExposure[index + 2]), "submerged sections should record the new voltage");

// Reaching the planned final cutoff while the output is still available must
// initiate normal discharge before the expected open-cell reading can trip.
sim.coachIndex = sim.recipe.points.length - 2;
sim.peakVoltage = sim.recipe.points[sim.recipe.points.length - 1][0];
sim.position = sim.cutoff;
sim.residualVoltage = 100;
els.supply.checked = true;
step(0.05);
assert.equal(sim.state, "DISCHARGE", "final-cutoff supply shutdown should enter normal discharge");
assert.equal(sim.fault, "", "final-cutoff supply shutdown should not latch open contact");
assert.equal(sim.q1Command, false, "Q1 must be commanded off at the final cutoff");
const positionAtOutputOff = sim.position;
step(0.05);
assert.equal(sim.q1State, false, "simulated Q1 feedback should confirm off before retraction");
assert.equal(sim.position, positionAtOutputOff, "part must remain immersed during discharge verification");
for (let elapsed = 0; elapsed < 55; elapsed += 0.05) step(0.05);
assert.equal(sim.state, "DONE", "normal discharge and retraction should finish as DONE");
assert.equal(sim.fault, "", "planned recipe completion must not leave a fault latched");

console.log("PASS touchdown, coached motion, and submerged-only exposure updates");
