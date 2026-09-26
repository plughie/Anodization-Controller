/*
 * Anodization Controller simulator.
 *
 * This is an untested conceptual model. It deliberately models the source,
 * controller permission, switching devices, electrode voltage, current
 * measurement, residual charge, motion, and fault latching separately so a
 * fault changes an assumption and must be detected by the safety supervisor.
 */
(() => {
  "use strict";

  const palette = [
    ["HIGH POLISH", 0, 0, "#bac3cc"], ["DARK BRONZE", 15, 15, "#7b3f27"],
    ["PURPLE", 22, 22, "#610F9D"], ["BLUE", 28, 28, "#02418E"],
    ["SILVER BLUE", 40, 40, "#C0D7DC"], ["GOLD", 65, 65, "#FFD006"],
    ["ROSE GOLD", 70, 70, "#EB965F"], ["PINK", 75, 75, "#FF7EDB"],
    ["DARK FUCHSIA", 85, 85, "#D254E6"], ["BLURPLE", 92, 92, "#8182F0"],
    ["PURPLE TEAL", 95, 95, "#01EAFF"], ["TEAL GREEN", 103, 103, "#39E6C7"],
    ["GREEN", 105, 105, "#3ADE87"]
  ];
  const CONFIG = {
    // Faster animation rate for the browser model only. Firmware notes retain
    // the slower conceptual hardware rate and require separate review.
    V_MAX_SOFT: 105, V_MAX_HARD: 108, TOUCHDOWN_MAX: 12, TOUCHDOWN_RATE: 1.0, SUBMERGE_RATE: 1.0,
    SWEEP_RATE: 1.0, RETRACT_RATE: 1.0, TOUCHDOWN_TIMEOUT: 240, SETTLE_TIMEOUT: 30,
    DISCHARGE_TIMEOUT: 8, DISCHARGE_SAFE_V: 10, DISCHARGE_TAU: 1.5,
    MIN_CONTACT_CURRENT: 0.005, SETTLE_CURRENT_MAX: 0.05, SETTLE_DWELL: 3,
    POSITION_TOLERANCE: 0.1, POSITION_FAULT_TOLERANCE: 2, POSITION_FAULT_TIME: 3,
    CLEARANCE: 5, ARC_MARGIN: 3, SECTION_COUNT: 9
  };
  const DISPLAY_TARGET = {
    controller: "SSD1306",
    resolution: "128×64",
    bus: "I²C",
    sda: "GP16",
    scl: "GP17",
    addresses: ["0x3C", "0x3D"],
    status: "ordered / browser simulation only",
    price: "$2.50"
  };

  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const mid = (color) => (color[1] + color[2]) / 2;
  const root = $("anodizer-simulator");
  const els = {
    voltage: $("voltage-input"), currentLimit: $("current-input"), supply: $("supply-output"),
    mode: $("mode-input"), length: $("length-input"), start: $("start-input"), end: $("end-input"),
    spread: $("spread-input"), lid: $("lid-input"), estop: $("estop-input"), startRun: $("start-button"),
    reset: $("reset-button"), select: $("select-button"), back: $("back-button"), inject: $("fault-button"),
    fault: $("fault-input"), state: $("state-label"), stateDot: $("state-dot"), voltageValue: $("voltage-value"),
    currentValue: $("current-value"), lengthValue: $("length-value"), knob: $("voltage-knob"), knobValue: $("voltage-knob-value"),
    setpoints: $("voltage-setpoints"),
    oledState: $("oled-state"), oled1: $("oled-line-1"), oled2: $("oled-line-2"), oled3: $("oled-line-3"),
    oled4: $("oled-line-4"), oled5: $("oled-line-5"), metricVoltage: $("metric-voltage"), metricCurrent: $("metric-current"),
    metricPeak: $("metric-peak"), metricPosition: $("metric-position"), carriage: $("carriage"), hanger: $("part-hanger"),
    part: $("titanium-part"), positionLabel: $("position-label"), travelLabel: $("travel-label"), voltagePath: $("voltage-path"),
    currentPath: $("current-path"), log: $("event-log")
  };

  // This describes the ordered module, but deliberately does not claim a
  // physical I²C connection. The browser OLED below is only a framebuffer
  // representation until Pico firmware and a hardware bring-up test exist.
  root.dataset.displayTarget = `${DISPLAY_TARGET.controller}-${DISPLAY_TARGET.resolution}`;
  root.dataset.displayBus = DISPLAY_TARGET.bus;
  root.dataset.displayAddress = DISPLAY_TARGET.addresses.join("/");

  palette.forEach((color, index) => {
    const option = document.createElement("option");
    option.value = index;
    option.disabled = color[1] === 0;
    option.textContent = color[1] === color[2] ? `${color[0]} (${color[1]} V${color[1] === 0 ? ", no anodizing" : ""})` : `${color[0]} (${color[1]}–${color[2]} V)`;
    els.start.append(option.cloneNode(true)); els.end.append(option);
  });
  els.start.value = "7"; els.end.value = "12";

  const sim = {
    state: "IDLE", pendingOutcome: null, fault: "", injectedFault: null, stateElapsed: 0,
    voltage: 0, currentLimit: 0.5, measuredVoltage: 0, measuredCurrent: 0, electrodeVoltage: 0,
    previousVoltage: 0, peakVoltage: 0, residualVoltage: 0, position: 18, surfacePos: 62.4,
    fullySubmerged: 114.4, cutoff: 65.4, travelSpan: 49, partLength: 47, frac: 0,
    formation: 0, settleStable: 0, coachIndex: 0, coachStable: 0, desiredVoltage: 0, touchdownVoltage: 0,
    recipe: null, sectionPeaks: Array(CONFIG.SECTION_COUNT).fill(0), positionFaultTime: 0,
    adcAge: 0, q1Command: false, k1Command: false, q1State: false, k1State: false,
    trace: [], log: [], dischargeSafeStable: 0, lastTime: performance.now()
  };

  function addLog(message) {
    sim.log.unshift(`${new Date().toLocaleTimeString()}  ${message}`);
    sim.log = sim.log.slice(0, 16);
    els.log.innerHTML = sim.log.map((line) => `<div>${line}</div>`).join("");
  }

  function transition(next) { sim.state = next; sim.stateElapsed = 0; }

  function buildRecipe() {
    const start = Number(els.start.value), end = Number(els.end.value);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return null;
    const colors = palette.slice(start, end + 1);
    if (els.mode.value === "UNIFORM" && colors.length !== 1) return null;
    const centers = colors.map(mid);
    let points;
    if (els.mode.value === "UNIFORM") points = [[centers[0], 0], [centers[0], 1]];
    else if (els.spread.value === "LINEAR") points = centers.length >= 2 ? [[centers[0], 0], [centers.at(-1), 1]] : null;
    else if (centers.length === 1) points = [[centers[0], 0], [centers[0], 1]];
    else {
      points = [[centers[0], 0]];
      for (let i = 1; i < centers.length; i++) points.push([(centers[i - 1] + centers[i]) / 2, i / centers.length]);
      points.push([centers.at(-1), 1]);
    }
    return points ? { mode: els.mode.value, spread: els.spread.value, start, end, colors, points, name: `${colors[0][0]} → ${colors.at(-1)[0]}` } : null;
  }

  function interpInverse(points, voltage) {
    if (!points) return 0;
    if (voltage <= points[0][0]) return points[0][1];
    for (let i = 1; i < points.length; i++) {
      if (voltage <= points[i][0]) {
        const [v0, f0] = points[i - 1], [v1, f1] = points[i];
        return f0 + (voltage - v0) * (f1 - f0) / Math.max(0.001, v1 - v0);
      }
    }
    return points.at(-1)[1];
  }

  function interp(points, frac) {
    if (!points) return 0;
    const f = clamp(frac, 0, 1);
    for (let i = 1; i < points.length; i++) {
      if (f <= points[i][1]) {
        const [v0, f0] = points[i - 1], [v1, f1] = points[i];
        return v0 + (f - f0) * (v1 - v0) / Math.max(0.001, f1 - f0);
      }
    }
    return points.at(-1)[0];
  }

  function colorForVoltage(voltage) {
    if (!Number.isFinite(voltage) || voltage <= 0) return "#687784";
    const windowColor = palette.find((color) => voltage >= color[1] && voltage <= color[2]);
    if (windowColor) return windowColor[3];
    return palette.reduce((best, color) => Math.abs(mid(color) - voltage) < Math.abs(mid(best) - voltage) ? color : best)[3];
  }

  function recipeName() {
    if (sim.recipe) return sim.recipe.name;
    const preview = buildRecipe();
    return preview ? preview.name : "invalid recipe";
  }

  let renderedSetpointKey = null;
  function renderVoltageSetpoints() {
    const recipe = buildRecipe();
    const points = recipe?.points ?? [];
    const voltages = points.filter((point, index) => index === 0 || point[0] !== points[index - 1][0]).map((point) => point[0]);
    const key = recipe ? `${recipe.mode}:${recipe.spread}:${recipe.start}:${recipe.end}:${voltages.join(",")}` : "invalid";
    if (key === renderedSetpointKey) return;
    renderedSetpointKey = key;
    els.setpoints.textContent = "";
    if (!recipe || voltages.length === 0) {
      els.setpoints.textContent = "Choose a valid recipe";
      return;
    }
    voltages.forEach((voltage, index) => {
      const marker = document.createElement("span");
      marker.className = "setpoint";
      marker.style.left = `${voltage / 120 * 100}%`;
      const label = voltages.length === 1 ? "Uniform" : index === 0 ? "Start" : index === voltages.length - 1 ? "End" : `Boundary ${index}`;
      const tooltip = `${label}: ${voltage.toFixed(1)} V`;
      marker.dataset.tooltip = tooltip;
      marker.title = `${tooltip}; move the slider gradually`;
      marker.tabIndex = 0;
      marker.setAttribute("role", "img");
      marker.setAttribute("aria-label", `${label} programmed voltage ${voltage.toFixed(1)} volts`);
      marker.dataset.voltage = voltage.toFixed(1);
      els.setpoints.append(marker);
    });
  }

  function partGeometry() {
    const scale = 2.4, hangerOffset = 34, partHeight = clamp(sim.partLength * scale, 24, 260);
    // The bottom of the drawn part is exactly at the waterline when position == surfacePos.
    const y = clamp(285 - hangerOffset - partHeight + (sim.position - sim.surfacePos) * scale, 28, 260);
    const partTop = y + hangerOffset;
    const wetFraction = clamp((sim.position - sim.surfacePos) / Math.max(1, sim.partLength), 0, 1);
    return { y, partTop, partHeight, wetFraction };
  }

  function updateExposure() {
    if (!sim.recipe || !sim.q1State || !sim.k1State || sim.measuredVoltage <= 0) return;
    for (let index = 0; index < CONFIG.SECTION_COUNT; index++) {
      // Position is the part's lower-end coordinate. A section measured from
      // the top therefore sits at position - (1 - fraction) * length.
      const fraction = (index + 0.5) / CONFIG.SECTION_COUNT;
      const sectionPosition = sim.position - (1 - fraction) * sim.partLength;
      const wet = sectionPosition >= sim.surfacePos;
      if (wet) sim.sectionPeaks[index] = Math.max(sim.sectionPeaks[index], sim.measuredVoltage);
    }
  }

  function renderPartColor() {
    const stops = Array.from({ length: CONFIG.SECTION_COUNT }, (_, index) => $(`part-stop-${index}`));
    const { wetFraction } = partGeometry();
    const neutral = "#687784";
    sim.sectionPeaks.forEach((peak, index) => {
      const offset = index / Math.max(1, CONFIG.SECTION_COUNT - 1) * 100;
      const color = peak > 0 ? colorForVoltage(peak) : neutral;
      stops[index].setAttribute("offset", `${offset}%`); stops[index].setAttribute("stop-color", color); stops[index].style.display = "";
    });
    // Show the active waterline boundary without erasing the section's exposure history.
    els.part.setAttribute("data-wet-fraction", wetFraction.toFixed(3));
  }

  function outputPermit() { return ["TOUCHDOWN", "SUBMERGE", "SETTLE", "SWEEP", "UNIFORM_HOLD"].includes(sim.state) && !sim.fault; }

  function applyOutputCommands() {
    sim.q1Command = outputPermit() && els.lid.checked && els.estop.checked;
    sim.k1Command = sim.q1Command;
    sim.q1State = sim.q1Command || sim.injectedFault === "q1-short";
    sim.k1State = sim.k1Command || sim.injectedFault === "k1-welded";
  }

  function actualCell(dt) {
    const source = els.supply.checked ? sim.voltage : 0;
    const pathClosed = sim.q1State && sim.k1State && els.lid.checked && els.estop.checked;
    let electrode = pathClosed ? source : sim.residualVoltage;
    if (pathClosed && sim.injectedFault !== "residual-charge") sim.residualVoltage = electrode;
    if (!pathClosed) sim.residualVoltage *= Math.exp(-dt / (sim.injectedFault === "residual-charge" ? 30 : CONFIG.DISCHARGE_TAU));
    electrode = pathClosed ? source : sim.residualVoltage;
    const immersion = clamp((sim.position - sim.surfacePos) / Math.max(1, sim.partLength), 0, 1);
    const effectiveResistance = 180 + immersion * 180;
    const formationFactor = sim.state === "SETTLE" || sim.state === "SWEEP" || sim.state === "UNIFORM_HOLD" ? Math.max(0.12, 1 - 0.88 * sim.formation) : 1;
    const demand = electrode / effectiveResistance * (0.2 + immersion * 0.8) * formationFactor;
    let current = pathClosed && immersion > 0 ? Math.min(sim.currentLimit, Math.max(0, demand)) : 0;
    if ((sim.state === "TOUCHDOWN" || sim.state === "SUBMERGE") && pathClosed && sim.position >= sim.surfacePos) current = Math.min(sim.currentLimit, Math.max(current, source / 900));
    if (sim.injectedFault === "open-contact") current = 0;
    if (sim.injectedFault === "overcurrent") current = Math.max(current, sim.currentLimit * 1.5);
    const measuredVoltage = pathClosed ? electrode : electrode;
    if (sim.injectedFault === "stale-adc") {
      sim.adcAge += dt;
      return [sim.measuredVoltage, sim.measuredCurrent];
    }
    sim.adcAge = 0;
    return [measuredVoltage, current];
  }

  function beginDischarge(outcome) {
    sim.pendingOutcome = outcome; sim.q1Command = false; sim.k1Command = false; sim.dischargeSafeStable = 0; transition("DISCHARGE");
    addLog(`Q1/K1 commanded off; verifying electrode discharge (${outcome.toLowerCase()})`);
  }

  function latchFault(reason) {
    if (sim.fault) return;
    sim.fault = reason; sim.pendingOutcome = "FAULT"; sim.q1Command = false; sim.k1Command = false;
    transition("DISCHARGE"); addLog(`FAULT LATCHED: ${reason}`);
  }

  function failDischarge(reason) {
    if (!sim.fault) sim.fault = reason;
    sim.pendingOutcome = "FAULT"; sim.q1Command = false; sim.k1Command = false;
    transition("FAULT"); addLog(`FAULT LATCHED: ${reason}`);
  }

  function safetySupervisor() {
    const active = ["TOUCHDOWN", "SUBMERGE", "SETTLE", "SWEEP", "UNIFORM_HOLD"].includes(sim.state);
    if (!active) return true;
    if (!els.supply.checked) { latchFault("simulated supply output unavailable"); return false; }
    if (!els.lid.checked || !els.estop.checked) { latchFault("interlock opened; reset required"); return false; }
    if (sim.injectedFault === "hardware-latch") { latchFault("hardware trip latch"); return false; }
    if (sim.adcAge > 0.5) { latchFault("ADC data stale"); return false; }
    if (!Number.isFinite(sim.measuredVoltage) || !Number.isFinite(sim.measuredCurrent)) { latchFault("invalid measurement"); return false; }
    if (sim.measuredVoltage > CONFIG.V_MAX_HARD || sim.measuredVoltage > CONFIG.V_MAX_SOFT) { latchFault("overvoltage ceiling"); return false; }
    if (sim.measuredCurrent < 0 || sim.measuredCurrent > sim.currentLimit * 1.05) { latchFault("invalid or excessive current"); return false; }
    if (sim.state === "SWEEP" && sim.measuredVoltage > 10 && sim.measuredCurrent < CONFIG.MIN_CONTACT_CURRENT) { latchFault("open cell/contact"); return false; }
    return true;
  }

  function startRun() {
    if (!["IDLE", "DONE", "ABORTED"].includes(sim.state)) return;
    const recipe = buildRecipe();
    if (!recipe || !els.lid.checked || !els.estop.checked) { addLog("Start blocked: invalid recipe or interlock"); return; }
    if (!els.supply.checked) { addLog("Start blocked: enable simulated supply output first"); return; }
    if (sim.currentLimit < CONFIG.MIN_CONTACT_CURRENT) { addLog("Start blocked: current limit too low for contact validation"); return; }
    sim.recipe = recipe; sim.partLength = Number(els.length.value); sim.surfacePos = 62.4;
    sim.fullySubmerged = sim.surfacePos + sim.partLength + CONFIG.CLEARANCE; sim.cutoff = sim.surfacePos + CONFIG.ARC_MARGIN;
    sim.travelSpan = sim.fullySubmerged - sim.cutoff; sim.peakVoltage = 0; sim.position = 18; sim.frac = 0;
    sim.formation = 0; sim.coachIndex = 0; sim.coachStable = 0; sim.settleStable = 0; sim.positionFaultTime = 0; sim.touchdownVoltage = 0; sim.fault = "";
    sim.pendingOutcome = null; sim.residualVoltage = 0; sim.sectionPeaks.fill(0); sim.adcAge = 0; sim.dischargeSafeStable = 0; transition("HOMING");
    addLog(`Run started: ${recipe.name}, ${sim.partLength} mm`);
  }

  function reset() {
    Object.assign(sim, { state: "IDLE", pendingOutcome: null, fault: "", injectedFault: null, stateElapsed: 0, voltage: 0,
      peakVoltage: 0, residualVoltage: 0, measuredVoltage: 0, measuredCurrent: 0, position: 18, frac: 0, formation: 0,
      coachIndex: 0, coachStable: 0, settleStable: 0, recipe: null, adcAge: 0, dischargeSafeStable: 0, trace: [], log: [] });
    sim.sectionPeaks.fill(0); els.voltage.value = "0"; els.supply.checked = false; addLog("Controller reset");
  }

  function back() {
    if (["HOMING", "TOUCHDOWN", "SUBMERGE", "SETTLE", "SWEEP", "UNIFORM_HOLD"].includes(sim.state)) beginDischarge("ABORTED");
    else addLog("BACK pressed; no active run");
  }

  function step(dt) {
    sim.stateElapsed += dt; sim.voltage = Number(els.voltage.value); sim.currentLimit = Number(els.currentLimit.value);
    applyOutputCommands();
    const [v, i] = actualCell(dt); sim.measuredVoltage = v; sim.measuredCurrent = i;
    const points = sim.recipe?.points;
    // The planned final cutoff is an orderly end-of-recipe transition, not an
    // open-cell fault. Evaluate it before the open-contact supervisor because
    // current is expected to fall as the last section clears the bath.
    const finalRecipeVoltage = points?.length ? points[points.length - 1][0] : 0;
    const observedPeakVoltage = Math.max(sim.peakVoltage, v);
    const finalVoltageReached = points?.length && observedPeakVoltage >= finalRecipeVoltage - 2;
    const atFinalCutoff = sim.state === "SWEEP" && finalVoltageReached && sim.position <= sim.cutoff + CONFIG.POSITION_TOLERANCE;
    if (atFinalCutoff) {
      beginDischarge("COMPLETED");
      addLog("Final recipe cutoff reached; verifying discharge before retraction");
    }
    if (!safetySupervisor()) { applyOutputCommands(); return; }
    if (sim.state === "HOMING") { sim.position = 18; transition("TOUCHDOWN"); addLog("Homing complete; low-energy touchdown search armed"); }
    if (sim.state === "TOUCHDOWN") {
      if (sim.voltage > CONFIG.TOUCHDOWN_MAX) { latchFault("touchdown voltage unsafe"); return; }
      // At 0 V the actuator still lowers the part, but there is no electrical
      // contact signal. Use the simulator's known waterline coordinate as a
      // conservative stop; require a nonzero low-energy setting to confirm
      // touchdown before continuing to full submersion.
      const zeroVoltage = sim.voltage < 0.5;
      const touchdownTarget = sim.surfacePos;
      sim.position = Math.min(touchdownTarget, sim.position + dt * CONFIG.TOUCHDOWN_RATE);
      if (!zeroVoltage && sim.measuredCurrent >= CONFIG.MIN_CONTACT_CURRENT && sim.position >= sim.surfacePos) {
        sim.surfacePos = sim.position; sim.fullySubmerged = sim.surfacePos + sim.partLength + CONFIG.CLEARANCE;
        sim.cutoff = sim.surfacePos + CONFIG.ARC_MARGIN; sim.travelSpan = sim.fullySubmerged - sim.cutoff;
        sim.touchdownVoltage = sim.voltage; transition("SUBMERGE"); addLog("Touchdown current detected; continuing slow descent to full submersion");
      } else if (sim.stateElapsed >= CONFIG.TOUCHDOWN_TIMEOUT) latchFault("touchdown timeout or no contact");
    } else if (sim.state === "SUBMERGE") {
      if (!els.supply.checked || sim.voltage < 0.5 || sim.voltage > CONFIG.TOUCHDOWN_MAX) { latchFault("submerge voltage outside low-energy window"); return; }
      sim.position = Math.min(sim.fullySubmerged, sim.position + dt * CONFIG.SUBMERGE_RATE);
      if (sim.position >= sim.fullySubmerged) { transition("SETTLE"); addLog("Full submersion reached; settle phase armed"); }
    } else if (sim.state === "SETTLE") {
      sim.position = sim.fullySubmerged; sim.desiredVoltage = points?.[0]?.[0] ?? 0;
      if (!els.supply.checked || Math.abs(v - sim.desiredVoltage) > 2) { sim.settleStable = 0; }
      else if (i < CONFIG.MIN_CONTACT_CURRENT) latchFault("open cell during settle");
      else if (i <= CONFIG.SETTLE_CURRENT_MAX) { sim.formation = clamp(sim.formation + dt / 4, 0, 1); sim.settleStable += dt; }
      else { sim.formation = clamp(sim.formation + dt / 4, 0, 1); sim.settleStable = 0; }
      if (sim.settleStable >= CONFIG.SETTLE_DWELL) {
        sim.sectionPeaks.fill(sim.desiredVoltage); sim.peakVoltage = sim.desiredVoltage;
        if (sim.recipe.mode === "UNIFORM") { transition("UNIFORM_HOLD"); addLog("Uniform formation settled; held fully submerged"); }
        else { transition("SWEEP"); addLog("Formation settled; coached sweep armed"); }
      } else if (sim.stateElapsed >= CONFIG.SETTLE_TIMEOUT) latchFault("settle timeout");
    } else if (sim.state === "UNIFORM_HOLD") {
      sim.position = sim.fullySubmerged; sim.desiredVoltage = points[0][0]; sim.peakVoltage = Math.max(sim.peakVoltage, v);
      updateExposure();
    } else if (sim.state === "SWEEP") {
      sim.peakVoltage = Math.max(sim.peakVoltage, v);
      let commandedMotion = false;
      let motionTarget = sim.position;
      const positionBeforeMotion = sim.position;
      if (sim.recipe.mode === "COACHED") {
        // Position follows the measured voltage continuously in either
        // direction. The fraction table encodes equal color-band widths or a
        // linear gradient, depending on the latched recipe.
        const previousCoachIndex = sim.coachIndex;
        sim.frac = clamp(interpInverse(points, v), 0, 1);
        let upperPoint = points.findIndex((point, index) => index > 0 && sim.frac < point[1]);
        if (upperPoint < 0) upperPoint = points.length - 1;
        sim.coachIndex = clamp(upperPoint - 1, 0, Math.max(0, points.length - 2));
        sim.desiredVoltage = points[Math.min(sim.coachIndex + 1, points.length - 1)][0];
        if (sim.coachIndex !== previousCoachIndex) addLog(`Voltage mapped to band ${sim.coachIndex + 1}; next setpoint ${sim.desiredVoltage.toFixed(1)} V`);
        motionTarget = sim.fullySubmerged - sim.frac * sim.travelSpan;
        if (Math.abs(motionTarget - sim.position) > CONFIG.POSITION_TOLERANCE) {
          commandedMotion = true;
          sim.position += (sim.injectedFault === "motion-stall" ? 0 : clamp(motionTarget - sim.position, -dt * CONFIG.SWEEP_RATE, dt * CONFIG.SWEEP_RATE));
        }
      } else {
        sim.frac = clamp(interpInverse(points, sim.peakVoltage), 0, 1); sim.desiredVoltage = interp(points, sim.frac);
        motionTarget = sim.fullySubmerged - sim.frac * sim.travelSpan;
        if (Math.abs(motionTarget - sim.position) > CONFIG.POSITION_TOLERANCE) {
          commandedMotion = true;
          sim.position += (sim.injectedFault === "motion-stall" ? 0 : clamp(motionTarget - sim.position, -dt * CONFIG.SWEEP_RATE, dt * CONFIG.SWEEP_RATE));
        }
      }
      updateExposure();
      const expectedTravel = dt * CONFIG.SWEEP_RATE;
      const actualTravel = Math.abs(sim.position - positionBeforeMotion);
      if (commandedMotion && actualTravel < expectedTravel * 0.5 && Math.abs(motionTarget - sim.position) > CONFIG.POSITION_FAULT_TOLERANCE) sim.positionFaultTime += dt;
      else sim.positionFaultTime = 0;
      if (sim.positionFaultTime >= CONFIG.POSITION_FAULT_TIME) latchFault("motion position error or stall");
      if (sim.recipe.mode === "COACHED" && finalVoltageReached && sim.position <= sim.cutoff + CONFIG.POSITION_TOLERANCE) beginDischarge("COMPLETED");
    } else if (sim.state === "DISCHARGE") {
      sim.q1Command = false; sim.k1Command = false; sim.q1State = sim.injectedFault === "q1-short"; sim.k1State = sim.injectedFault === "k1-welded";
      const safeReading = sim.adcAge === 0 && Number.isFinite(v) && Number.isFinite(i) && v >= 0;
      if (sim.q1State || sim.k1State) sim.dischargeSafeStable = 0;
      else if (safeReading && v <= CONFIG.DISCHARGE_SAFE_V) sim.dischargeSafeStable += dt;
      else sim.dischargeSafeStable = 0;
      if (sim.dischargeSafeStable >= 0.25) { transition("RETRACT"); addLog("Electrode-pair discharge verified; retracting"); }
      else if (sim.stateElapsed >= CONFIG.DISCHARGE_TIMEOUT) failDischarge(sim.q1State || sim.k1State ? "switch shutdown not confirmed" : "discharge not verified");
    } else if (sim.state === "RETRACT") {
      if (!els.lid.checked || !els.estop.checked) return;
      sim.position = Math.max(sim.position - dt * CONFIG.RETRACT_RATE, 18);
      if (sim.position <= 18) { const outcome = sim.pendingOutcome; transition(outcome === "FAULT" ? "FAULT" : outcome === "ABORTED" ? "ABORTED" : "DONE"); addLog(`Run ${sim.state.toLowerCase()}`); }
    }
    sim.trace.push([v, i]); if (sim.trace.length > 120) sim.trace.shift();
  }

  function renderScene() {
    const { y, partTop, partHeight } = partGeometry();
    els.carriage.setAttribute("y", y); els.hanger.setAttribute("y1", y + 25); els.hanger.setAttribute("y2", partTop); els.part.setAttribute("y", partTop); els.part.setAttribute("height", partHeight);
    els.positionLabel.textContent = `carriage: ${sim.position.toFixed(1)} mm`; els.travelLabel.textContent = `part: ${sim.partLength} mm · bottom ${(sim.position + sim.partLength).toFixed(1)} mm`;
    const cutoff = clamp(285 - 34 - partHeight + (sim.cutoff - sim.surfacePos) * 2.4 + 34 + partHeight, 28, 260);
    $("cutoff-mark").querySelector("line").setAttribute("y1", cutoff); $("cutoff-mark").querySelector("line").setAttribute("y2", cutoff); $("cutoff-mark").querySelector("text").setAttribute("y", cutoff + 4);
    els.metricPosition.textContent = `${sim.position.toFixed(1)} mm`; renderPartColor();
  }

  function renderTrace() {
    const width = 535, height = 120, x0 = 45, y0 = 25;
    const vPath = sim.trace.map((p, i) => `${i ? "L" : "M"}${x0 + i / 119 * width},${y0 + height - p[0] / 120 * height}`).join(" ");
    const iPath = sim.trace.map((p, i) => `${i ? "L" : "M"}${x0 + i / 119 * width},${y0 + height - p[1] / 3 * height}`).join(" ");
    els.voltagePath.setAttribute("d", vPath); els.currentPath.setAttribute("d", iPath);
  }

  function render() {
    const s = sim.state, faulted = s === "FAULT", active = ["HOMING", "TOUCHDOWN", "SUBMERGE", "SETTLE", "SWEEP", "UNIFORM_HOLD", "DISCHARGE", "RETRACT"].includes(s);
    const displayedLength = active ? sim.partLength : Number(els.length.value);
    renderVoltageSetpoints();
    els.state.textContent = s; els.stateDot.className = `dot ${faulted ? "fault" : ["IDLE", "DONE", "ABORTED"].includes(s) ? "idle" : ""}`;
    els.voltageValue.textContent = sim.voltage.toFixed(1); els.currentValue.textContent = sim.currentLimit.toFixed(2); els.lengthValue.textContent = displayedLength;
    els.knobValue.textContent = sim.voltage.toFixed(0); els.knob.style.setProperty("--pct", sim.voltage / 120);
    els.metricVoltage.textContent = `${sim.measuredVoltage.toFixed(1)} V`; els.metricCurrent.textContent = `${sim.measuredCurrent.toFixed(3)} A`; els.metricPeak.textContent = `${sim.peakVoltage.toFixed(1)} V`;
    els.oledState.textContent = faulted ? "FAULT LATCHED" : s === "IDLE" ? "READY" : s; els.oledState.className = faulted ? "big fault" : "big";
    els.oled1.textContent = `Q1: ${sim.q1State ? "ON" : "OFF"} · K1: ${sim.k1State ? "ON" : "OFF"}`;
    const touchdownProgress = Math.round(clamp((sim.position - 18) / Math.max(1, sim.surfacePos - 18), 0, 1) * 100);
    els.oled2.textContent = faulted ? sim.fault : s === "IDLE" && !els.supply.checked ? "Enable simulated supply output" : s === "TOUCHDOWN" ? (sim.voltage < 0.5 ? `Lowering to surface ${touchdownProgress}%; set 0–12 V to detect contact` : `Touchdown ${touchdownProgress}% · ${sim.voltage.toFixed(1)} V`) : s === "SUBMERGE" ? `Submerging ${Math.round(clamp((sim.position - sim.surfacePos) / Math.max(1, sim.fullySubmerged - sim.surfacePos), 0, 1) * 100)}% · ${sim.touchdownVoltage.toFixed(1)} V` : s === "SWEEP" ? `Dial: ${sim.desiredVoltage.toFixed(1)} V` : s === "SETTLE" ? `Settle: ${sim.desiredVoltage.toFixed(1)} V` : s === "DISCHARGE" ? `Electrode: ${sim.measuredVoltage.toFixed(1)} V` : s === "RETRACT" ? "Output isolated; retracting" : s === "ABORTED" ? "Aborted; reset to start again" : s === "DONE" ? "Run complete" : "Set supply to 0 V";
    els.oled3.textContent = `Length: ${displayedLength} mm`; els.oled4.textContent = `Recipe: ${recipeName()}`;
    els.oled5.textContent = faulted ? "Reset required" : s === "ABORTED" ? "Aborted; Reset for new run" : s === "DONE" ? "Completed; Reset for new run" : s === "SUBMERGE" ? "Keep low voltage until fully submerged" : s === "UNIFORM_HOLD" ? "Uniform formed; press BACK" : s === "DISCHARGE" ? "Set bench supply knob to 0 V" : s === "RETRACT" ? "Verified safe; keep clear" : "Hold SELECT to begin";
    root.querySelectorAll("[data-run-edit]").forEach((el) => { el.disabled = active || faulted; });
    renderScene(); renderTrace();
  }

  [els.mode, els.length, els.start, els.end, els.spread].forEach((el) => el.dataset.runEdit = "true");
  els.voltage.addEventListener("input", render); els.currentLimit.addEventListener("input", render);
  els.length.addEventListener("input", () => { if (!["IDLE", "DONE", "ABORTED"].includes(sim.state)) return; sim.partLength = Number(els.length.value); render(); });
  [els.mode, els.start, els.end, els.spread, els.supply, els.lid, els.estop].forEach((el) => el.addEventListener("change", render));
  els.startRun.addEventListener("click", startRun);
  let selectHoldTimer = null;
  const beginSelectHold = (event) => { if (selectHoldTimer || !["IDLE", "DONE", "ABORTED"].includes(sim.state) || (event.type === "keydown" && event.repeat)) return; event.preventDefault(); addLog("SELECT held; release after 1 second to start"); selectHoldTimer = setTimeout(() => { selectHoldTimer = null; startRun(); }, 1000); };
  const cancelSelectHold = (event) => { if (!selectHoldTimer) return; if (event) event.preventDefault(); clearTimeout(selectHoldTimer); selectHoldTimer = null; };
  els.select.addEventListener("pointerdown", beginSelectHold); ["pointerup", "pointerleave", "pointercancel"].forEach((event) => els.select.addEventListener(event, cancelSelectHold));
  els.select.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") beginSelectHold(event); });
  els.select.addEventListener("keyup", (event) => { if (event.key === "Enter" || event.key === " ") cancelSelectHold(event); });
  window.addEventListener("blur", cancelSelectHold);
  els.back.addEventListener("click", back); els.reset.addEventListener("click", reset); els.inject.addEventListener("click", () => { sim.injectedFault = els.fault.value; addLog(`Fault injected: ${sim.injectedFault}`); });

  function loop(now) { const dt = Math.min(0.08, Math.max(0.001, (now - sim.lastTime) / 1000)); sim.lastTime = now; try { step(dt); render(); } catch (error) { latchFault(`simulator exception: ${error.message}`); render(); } requestAnimationFrame(loop); }
  addLog("Simulation ready"); render(); requestAnimationFrame(loop);
})();
