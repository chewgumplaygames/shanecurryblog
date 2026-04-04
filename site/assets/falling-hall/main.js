const WIDTH = 160;
const HEIGHT = 120;
const ASPECT = WIDTH / HEIGHT;
const TAU = Math.PI * 2;
const FACET_COUNT = 18;
const RING_SPACING = 1.35;
const BASE_FALL_SPEED = 4.1;
const BOOSTED_FALL_SPEED = 6.2;
const DRIFT_ACCELERATION = 5.8;
const CENTER_PULL = 1.05;
const LATERAL_DRAG = 3.4;
const PLAYER_RADIUS = 0.17;
const MAX_DISTANCE = 40;
const MAX_STEPS = 28;
const SURFACE_EPSILON = 0.035;
const FOCAL_LENGTH = 1.05;
const EDGE_START = 0.72;
const EDGE_END = 0.98;
const BELL_SCALE = [69, 72, 76, 79, 81, 84];
const LIGHT_DIRECTION = normalize3(-0.42, -0.26, -0.87);

const keyState = new Set();
const ringCache = new Map();
const screenX = new Float32Array(WIDTH);
const screenY = new Float32Array(HEIGHT);

for (let x = 0; x < WIDTH; x += 1) {
  screenX[x] = (((x + 0.5) / WIDTH) * 2 - 1) * ASPECT;
}

for (let y = 0; y < HEIGHT; y += 1) {
  screenY[y] = ((y + 0.5) / HEIGHT) * 2 - 1;
}

const canvas = document.querySelector("#scene");
const context = canvas.getContext("2d", { alpha: false });
const imageData = context.createImageData(WIDTH, HEIGHT);
const buffer = imageData.data;

const statusElement = document.querySelector("#status");
const stateElement = document.querySelector("#fall-state");
const audioTrigger = document.querySelector("#audio-trigger");
const impactReadout = document.querySelector("#impact-readout");
const depthReadout = document.querySelector("#depth-readout");
const driftReadout = document.querySelector("#drift-readout");
const dangerReadout = document.querySelector("#danger-readout");
const depthMeter = document.querySelector("#depth-meter");
const driftMeter = document.querySelector("#drift-meter");
const dangerMeter = document.querySelector("#danger-meter");

context.imageSmoothingEnabled = false;

const state = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  z: 0,
  speed: BASE_FALL_SPEED,
  roll: 0,
  time: 0,
  impacts: 0,
  impactFlash: 0,
  collisionCooldown: 0,
  lastImpactAt: -Infinity,
};

class BellSynth {
  constructor(stateText, statusText) {
    this.stateText = stateText;
    this.statusText = statusText;
    this.audioContext = null;
    this.masterGain = null;
    this.periodicWave = null;
    this.started = false;
  }

  async arm() {
    if (!this.audioContext) {
      this.setupAudio();
    }

    await this.audioContext.resume();
    this.started = true;

    if (this.statusText) {
      this.statusText.textContent = "Bell field armed";
    }
    if (this.stateText) {
      this.stateText.textContent =
        "Falling live. Drift through the shaft and the walls will ring when you strike them.";
    }
  }

  setupAudio() {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;

    if (!AudioContextCtor) {
      throw new Error("Web Audio is unavailable in this browser.");
    }

    this.audioContext = new AudioContextCtor();
    this.masterGain = new GainNode(this.audioContext, { gain: 0.16 });
    this.masterGain.connect(this.audioContext.destination);
    this.periodicWave = createNesTriangleWave(this.audioContext);
  }

  strike(intensity, pan, noteIndex) {
    if (!this.started || !this.audioContext || !this.periodicWave) {
      return;
    }

    const time = this.audioContext.currentTime + 0.01;
    const clampedIntensity = clamp(intensity, 0.18, 1.2);
    const midi =
      BELL_SCALE[noteIndex % BELL_SCALE.length] + Math.min(7, Math.round(clampedIntensity * 5));
    const fundamental = midiToFrequency(midi);
    const output =
      typeof StereoPannerNode === "function"
        ? new StereoPannerNode(this.audioContext, { pan: clamp(pan, -1, 1) })
        : new GainNode(this.audioContext);

    const bus = new GainNode(this.audioContext, { gain: 1 });
    const filter = new BiquadFilterNode(this.audioContext, {
      type: "bandpass",
      frequency: Math.min(3200, fundamental * 2.2),
      Q: 2.4,
    });
    const shimmer = new GainNode(this.audioContext, { gain: 1 });

    bus.connect(output);
    output.connect(this.masterGain);
    shimmer.connect(filter);
    filter.connect(output);

    this.scheduleVoice({
      type: "triangle",
      frequency: fundamental,
      peak: 0.08 * clampedIntensity,
      decay: 1.45,
      time,
      destination: bus,
      usePeriodicWave: true,
    });
    this.scheduleVoice({
      type: "sine",
      frequency: fundamental * 2.01,
      peak: 0.07 * clampedIntensity,
      decay: 1.08,
      time,
      destination: shimmer,
    });
    this.scheduleVoice({
      type: "sine",
      frequency: fundamental * 3.17,
      peak: 0.05 * clampedIntensity,
      decay: 0.8,
      time,
      destination: shimmer,
    });

    window.setTimeout(() => {
      output.disconnect();
      bus.disconnect();
      shimmer.disconnect();
      filter.disconnect();
    }, 2200);
  }

  scheduleVoice({ type, frequency, peak, decay, time, destination, usePeriodicWave = false }) {
    const oscillator = new OscillatorNode(this.audioContext, { type });
    const gain = new GainNode(this.audioContext, { gain: 0.0001 });

    if (usePeriodicWave) {
      oscillator.setPeriodicWave(this.periodicWave);
    }

    oscillator.frequency.setValueAtTime(frequency, time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.linearRampToValueAtTime(peak, time + 0.02);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak * 0.42), time + decay * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + decay);

    oscillator.connect(gain);
    gain.connect(destination);
    oscillator.start(time);
    oscillator.stop(time + decay + 0.1);
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(min, max, value) {
  const t = clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}

function midiToFrequency(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function normalize3(x, y, z) {
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

function hashInt(value) {
  let hash = value | 0;

  hash = Math.imul(hash ^ 61, 9);
  hash ^= hash >>> 4;
  hash = Math.imul(hash, 0x27d4eb2d);
  hash ^= hash >>> 15;

  return (hash >>> 0) / 4294967295;
}

function hash2(a, b) {
  return hashInt(Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263));
}

function createNesTriangleWave(audioContext) {
  const stepValues = [
    15, 14, 13, 12, 11, 10, 9, 8,
    7, 6, 5, 4, 3, 2, 1, 0,
    0, 1, 2, 3, 4, 5, 6, 7,
    8, 9, 10, 11, 12, 13, 14, 15,
  ];
  const normalized = stepValues.map((value) => (value / 15) * 2 - 1);
  const mean =
    normalized.reduce((sum, value) => sum + value, 0) / normalized.length;
  const samples = normalized.map((value) => value - mean);
  const harmonicCount = 24;
  const real = new Float32Array(harmonicCount + 1);
  const imag = new Float32Array(harmonicCount + 1);

  for (let harmonic = 1; harmonic <= harmonicCount; harmonic += 1) {
    let cosineSum = 0;
    let sineSum = 0;

    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
      const phase = (2 * Math.PI * harmonic * sampleIndex) / samples.length;
      cosineSum += samples[sampleIndex] * Math.cos(phase);
      sineSum += samples[sampleIndex] * Math.sin(phase);
    }

    real[harmonic] = (2 / samples.length) * cosineSum;
    imag[harmonic] = (2 / samples.length) * sineSum;
  }

  return audioContext.createPeriodicWave(real, imag, {
    disableNormalization: true,
  });
}

function getRingVertices(ring) {
  let vertices = ringCache.get(ring);

  if (vertices) {
    return vertices;
  }

  vertices = new Float32Array(FACET_COUNT + 1);

  const baseRadius =
    1.78 +
    Math.sin(ring * 0.43) * 0.16 +
    Math.sin(ring * 0.15 + 1.7) * 0.1;

  for (let facet = 0; facet < FACET_COUNT; facet += 1) {
    const coarseNoise = hash2(ring, facet) - 0.5;
    const fineNoise = hash2(ring + 31, facet + 97) - 0.5;
    const dimple = Math.sin(ring * 0.27 + facet * 0.58) * 0.05;

    vertices[facet] = baseRadius + coarseNoise * 0.34 + fineNoise * 0.12 + dimple;
  }

  vertices[FACET_COUNT] = vertices[0];
  ringCache.set(ring, vertices);

  return vertices;
}

function pruneRingCache(z) {
  const centerRing = Math.floor(z / RING_SPACING);

  for (const ring of ringCache.keys()) {
    if (ring < centerRing - 3 || ring > centerRing + 40) {
      ringCache.delete(ring);
    }
  }
}

function sampleRingRadius(ring, angle) {
  const twist = ring * 0.16;
  const wrapped = ((angle + twist) / TAU - Math.floor((angle + twist) / TAU)) * FACET_COUNT;
  const facet = Math.floor(wrapped);
  const blend = wrapped - facet;
  const vertices = getRingVertices(ring);

  return {
    radius: lerp(vertices[facet], vertices[facet + 1], blend),
    facet,
    blend,
  };
}

function sampleTunnelInfo(angle, z) {
  const ringFloat = z / RING_SPACING;
  const ring = Math.floor(ringFloat);
  const ringBlend = smoothstep(0, 1, ringFloat - ring);
  const current = sampleRingRadius(ring, angle);
  const next = sampleRingRadius(ring + 1, angle);

  return {
    radius: lerp(current.radius, next.radius, ringBlend),
    facet: ringBlend < 0.5 ? current.facet : next.facet,
    blend: lerp(current.blend, next.blend, ringBlend),
  };
}

function sampleTunnelRadius(angle, z) {
  return sampleTunnelInfo(angle, z).radius;
}

function signedTunnelDistance(x, y, z) {
  return Math.hypot(x, y) - sampleTunnelRadius(Math.atan2(y, x), z);
}

function estimateNormal(x, y, z) {
  const epsilon = 0.035;
  const nx =
    signedTunnelDistance(x + epsilon, y, z) - signedTunnelDistance(x - epsilon, y, z);
  const ny =
    signedTunnelDistance(x, y + epsilon, z) - signedTunnelDistance(x, y - epsilon, z);
  const nz =
    signedTunnelDistance(x, y, z + epsilon) - signedTunnelDistance(x, y, z - epsilon);
  const length = Math.hypot(nx, ny, nz) || 1;

  return [nx / length, ny / length, nz / length];
}

function shadeVoid(u, v) {
  const radialScreen = Math.hypot(u * 0.94, v * 1.12);
  const glow = Math.exp(-radialScreen * radialScreen * 7.5);
  const swirl = 0.5 + 0.5 * Math.sin(Math.atan2(v, u) * 7 - state.z * 1.05 - radialScreen * 16);
  const inverse = 1 / (radialScreen + 0.34);
  const dustX = u * inverse * 5.5;
  const dustY = v * inverse * 5.5 + state.z * 1.75;
  const cellX = Math.floor(dustX * 5);
  const cellY = Math.floor(dustY * 5);
  const sparkleSeed = hash2(cellX, cellY);
  const localX = dustX * 5 - cellX - 0.5;
  const localY = dustY * 5 - cellY - 0.5;
  const sparkle =
    sparkleSeed > 0.992 ? smoothstep(0.24, 0, Math.hypot(localX, localY)) : 0;
  const flash = state.impactFlash * 40;

  return [
    clamp(2 + glow * 28 + swirl * 6 + sparkle * 170 + flash, 0, 255),
    clamp(4 + glow * 18 + sparkle * 140 + flash * 0.8, 0, 255),
    clamp(10 + glow * 40 + swirl * 14 + sparkle * 220 + flash * 1.1, 0, 255),
  ];
}

function shadeHit(x, y, z, travel, dx, dy, dz) {
  const normal = estimateNormal(x, y, z);
  const info = sampleTunnelInfo(Math.atan2(y, x), z);
  const viewDot = clamp(normal[0] * -dx + normal[1] * -dy + normal[2] * -dz, 0, 1);
  const lightDot = Math.max(
    0,
    normal[0] * LIGHT_DIRECTION[0] +
      normal[1] * LIGHT_DIRECTION[1] +
      normal[2] * LIGHT_DIRECTION[2],
  );
  const rim = Math.pow(1 - viewDot, 2.4);
  const seam = Math.pow(Math.abs(info.blend * 2 - 1), 7);
  const band = 0.5 + 0.5 * Math.sin(z * 4.8 + info.facet * 0.7 - state.time * 2.5);
  const fog = Math.exp(-travel * 0.078);
  const flash = state.impactFlash * 48;

  return [
    clamp(10 + fog * (18 + lightDot * 52 + band * 46 + seam * 122) + flash, 0, 255),
    clamp(12 + fog * (24 + lightDot * 66 + band * 26 + seam * 54) + flash * 0.75, 0, 255),
    clamp(22 + fog * (38 + lightDot * 108 + rim * 72 + seam * 62) + flash * 1.05, 0, 255),
  ];
}

function renderScene() {
  pruneRingCache(state.z);

  const rollCos = Math.cos(state.roll);
  const rollSin = Math.sin(state.roll);
  let pointer = 0;

  for (let y = 0; y < HEIGHT; y += 1) {
    const baseV = screenY[y];

    for (let x = 0; x < WIDTH; x += 1) {
      const baseU = screenX[x];
      const rotatedU = baseU * rollCos - baseV * rollSin;
      const rotatedV = baseU * rollSin + baseV * rollCos;
      const dir = normalize3(rotatedU, rotatedV, FOCAL_LENGTH);
      let travel = 0.08;
      let hitColor = null;

      for (let step = 0; step < MAX_STEPS; step += 1) {
        const sampleX = state.x + dir[0] * travel;
        const sampleY = state.y + dir[1] * travel;
        const sampleZ = state.z + dir[2] * travel;
        const angle = Math.atan2(sampleY, sampleX);
        const radial = Math.hypot(sampleX, sampleY);
        const radius = sampleTunnelRadius(angle, sampleZ);
        const distanceToWall = radius - radial;

        if (distanceToWall <= SURFACE_EPSILON) {
          hitColor = shadeHit(sampleX, sampleY, sampleZ, travel, dir[0], dir[1], dir[2]);
          break;
        }

        travel += clamp(distanceToWall * 0.82, 0.045, 1.15);

        if (travel >= MAX_DISTANCE) {
          break;
        }
      }

      const color = hitColor ?? shadeVoid(rotatedU, rotatedV);

      buffer[pointer] = color[0];
      buffer[pointer + 1] = color[1];
      buffer[pointer + 2] = color[2];
      buffer[pointer + 3] = 255;
      pointer += 4;
    }
  }

  context.putImageData(imageData, 0, 0);
}

function isPressed(code) {
  return keyState.has(code);
}

function updatePhysics(dt, synth) {
  const inputX =
    (isPressed("KeyD") || isPressed("ArrowRight") ? 1 : 0) -
    (isPressed("KeyA") || isPressed("ArrowLeft") ? 1 : 0);
  const inputY =
    (isPressed("KeyS") || isPressed("ArrowDown") ? 1 : 0) -
    (isPressed("KeyW") || isPressed("ArrowUp") ? 1 : 0);
  const inputLength = Math.hypot(inputX, inputY) || 1;
  const blend = 1 - Math.exp(-dt * 2.5);
  const targetSpeed =
    isPressed("ShiftLeft") || isPressed("ShiftRight") ? BOOSTED_FALL_SPEED : BASE_FALL_SPEED;

  state.speed = lerp(state.speed, targetSpeed, blend);

  state.vx += (inputX / inputLength) * DRIFT_ACCELERATION * dt;
  state.vy += (inputY / inputLength) * DRIFT_ACCELERATION * dt;
  state.vx -= state.x * CENTER_PULL * dt;
  state.vy -= state.y * CENTER_PULL * dt;

  const drag = Math.exp(-LATERAL_DRAG * dt);
  state.vx *= drag;
  state.vy *= drag;
  state.x += state.vx * dt;
  state.y += state.vy * dt;
  state.z += state.speed * dt;
  state.time += dt;
  state.roll = lerp(
    state.roll,
    clamp(state.vx * 0.1 + Math.sin(state.z * 0.15) * 0.035, -0.18, 0.18),
    1 - Math.exp(-dt * 3.4),
  );
  state.impactFlash = Math.max(0, state.impactFlash - dt * 2.3);
  state.collisionCooldown = Math.max(0, state.collisionCooldown - dt);

  resolveCollision(synth);
}

function resolveCollision(synth) {
  const radial = Math.hypot(state.x, state.y);

  if (radial < 0.0001) {
    return;
  }

  const angle = Math.atan2(state.y, state.x);
  const info = sampleTunnelInfo(angle, state.z);
  const limit = info.radius - PLAYER_RADIUS;

  if (radial <= limit) {
    return;
  }

  const nx = state.x / radial;
  const ny = state.y / radial;
  const penetration = radial - limit;
  const outwardSpeed = state.vx * nx + state.vy * ny;
  const tangentialVx = state.vx - nx * outwardSpeed;
  const tangentialVy = state.vy - ny * outwardSpeed;
  const reflectedSpeed = outwardSpeed > 0 ? -outwardSpeed * 0.42 : outwardSpeed * 0.1;

  state.x = nx * limit;
  state.y = ny * limit;
  state.vx = tangentialVx * 0.86 + nx * reflectedSpeed;
  state.vy = tangentialVy * 0.86 + ny * reflectedSpeed;

  const intensity = clamp(Math.abs(outwardSpeed) * 0.6 + penetration * 8, 0, 1.1);

  if (state.collisionCooldown <= 0 && intensity > 0.18) {
    state.impacts += 1;
    state.impactFlash = clamp(state.impactFlash + 0.9, 0, 1);
    state.collisionCooldown = 0.18;
    state.lastImpactAt = state.time;

    if (impactReadout) {
      impactReadout.textContent = `${state.impacts} ${state.impacts === 1 ? "chime" : "chimes"}`;
    }
    if (statusElement) {
      statusElement.textContent = "Wall strike";
    }
    if (stateElement && synth.started) {
      stateElement.textContent =
        "The shaft rang back. Keep drifting if you want to scrape another seam.";
    }

    synth.strike(intensity, nx * 0.85, info.facet);
  }
}

function updateHud(synth) {
  const radial = Math.hypot(state.x, state.y);
  const angle = radial > 0.0001 ? Math.atan2(state.y, state.x) : 0;
  const radius = sampleTunnelRadius(angle, state.z) - PLAYER_RADIUS;
  const edgeRatio = clamp(radial / Math.max(radius, 0.1), 0, 1);
  const drift = Math.hypot(state.vx, state.vy);

  if (depthReadout) {
    depthReadout.textContent = `${Math.floor(state.z * 6)} m`;
  }
  if (driftReadout) {
    driftReadout.textContent = drift.toFixed(2);
  }
  if (dangerReadout) {
    if (edgeRatio < EDGE_START) {
      dangerReadout.textContent = "Centered";
    } else if (edgeRatio < EDGE_END) {
      dangerReadout.textContent = "Leaning";
    } else {
      dangerReadout.textContent = "Grazing";
    }
  }
  if (depthMeter) {
    depthMeter.style.transform = `scaleX(${0.12 + (state.z % 40) / 40})`;
  }
  if (driftMeter) {
    driftMeter.style.transform = `scaleX(${clamp(drift / 1.8, 0, 1)})`;
  }
  if (dangerMeter) {
    dangerMeter.style.transform = `scaleX(${edgeRatio})`;
  }
  if (statusElement && state.time - state.lastImpactAt > 0.32) {
    if (!synth.started) {
      statusElement.textContent = "Audio dormant";
    } else if (edgeRatio >= EDGE_END) {
      statusElement.textContent = "Edge pressure";
    } else {
      statusElement.textContent = "Falling clean";
    }
  }
}

function preventPageScroll(event) {
  if (
    [
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "ShiftLeft",
      "ShiftRight",
    ].includes(event.code)
  ) {
    event.preventDefault();
  }
}

window.addEventListener("keydown", (event) => {
  preventPageScroll(event);
  keyState.add(event.code);
});

window.addEventListener("keyup", (event) => {
  preventPageScroll(event);
  keyState.delete(event.code);
});

window.addEventListener("blur", () => {
  keyState.clear();
});

function boot() {
  const synth = new BellSynth(stateElement, statusElement);
  let lastFrameTime = performance.now();

  if (impactReadout) {
    impactReadout.textContent = "0 chimes";
  }
  if (statusElement) {
    statusElement.textContent = "Audio dormant";
  }

  if (audioTrigger) {
    audioTrigger.addEventListener("click", async () => {
      try {
        await synth.arm();
        audioTrigger.textContent = "BELLS ARMED";
      } catch (error) {
        if (statusElement) {
          statusElement.textContent = "Audio failed";
        }
        if (stateElement) {
          stateElement.textContent = error instanceof Error ? error.message : String(error);
        }
        console.error(error);
      }
    });
  }

  function frame(now) {
    const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
    lastFrameTime = now;

    updatePhysics(dt, synth);
    renderScene();
    updateHud(synth);

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

boot();
