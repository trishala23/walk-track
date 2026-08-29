'use strict';

/* -------------------------------------------------------------------------
 * Tunable constants
 *
 * These control the peak-detection algorithm. If the counter is UNDER-
 * counting steps (missing real steps), try lowering STEP_THRESHOLD or
 * SMOOTHING_ALPHA, or lowering REQUIRED_CONSISTENT_STEPS. If it's OVER-
 * counting (counting noise/shaking/vibration as steps), try raising
 * STEP_THRESHOLD, MIN_STEP_INTERVAL_MS, or REQUIRED_CONSISTENT_STEPS.
 * ---------------------------------------------------------------------- */

// Acceleration magnitude (m/s^2) the smoothed signal must rise above, then
// fall back below, for a step to be registered. A real footfall produces a
// noticeably bigger spike than casual hand movement/shaking, so this is
// set high enough that just moving the phone around while stationary
// shouldn't cross it. Typical walking peaks are roughly 2-4 m/s^2 above
// gravity once gravity is removed by the low-pass filter below.
const STEP_THRESHOLD = 2.2;

// Plausible walking-cadence window between consecutive candidate peaks, in
// milliseconds. MIN prevents a single footfall's vibration from being
// counted twice (average cadence is one step roughly every 400-600ms, so
// 300-400ms is a safe floor). MAX rejects gaps too long to be the same
// walking rhythm (over a second between "steps" isn't a walking gait).
const MIN_STEP_INTERVAL_MS = 350;
const MAX_STEP_INTERVAL_MS = 1000;

// Number of consecutive candidate peaks that must land inside the cadence
// window above before they start being counted as steps. Deliberate
// shaking/waving the phone side to side produces the same kind of
// acceleration spike as a footfall, but rarely holds a steady walking
// rhythm for more than one or two peaks in a row - requiring a short
// streak filters that out without needing an ever-higher amplitude
// threshold (which would risk missing real, lighter footfalls). The
// tradeoff: the first REQUIRED_CONSISTENT_STEPS-1 steps of each walking
// session go uncounted while the rhythm is established.
const REQUIRED_CONSISTENT_STEPS = 2;

// Smoothing factor for the exponential moving average (0-1). Lower values
// smooth more aggressively (less noise, but slower to react); higher
// values track the raw signal more closely.
const SMOOTHING_ALPHA = 0.2;

// Gyroscope rotation rate (degrees/second, combined across axes) above
// which a sample is treated as a deliberate device rotation (flipping,
// spinning the phone in hand) rather than a walking footfall, and is not
// allowed to register a step. Rotating the phone still produces a real
// acceleration spike at the sensor (it isn't at the rotation's center),
// so amplitude alone can't tell a flip from a step - normal walking
// keeps rotation rate low even when the phone swings in a pocket or
// hand, while a deliberate flip is much faster.
const ROTATION_GATE_DEG_PER_SEC = 250;

const STORAGE_KEY = 'stepCounter.count';

/* ------------------------------------------------------------------- */

const els = {
  status: document.getElementById('status'),
  stepCount: document.getElementById('stepCount'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  resetBtn: document.getElementById('resetBtn'),
  errorPanel: document.getElementById('errorPanel'),
  errorMessage: document.getElementById('errorMessage'),
  retryBtn: document.getElementById('retryBtn'),
  debugToggle: document.getElementById('debugToggle'),
  debugPanel: document.getElementById('debugPanel'),
  debugRaw: document.getElementById('debugRaw'),
  debugSmoothed: document.getElementById('debugSmoothed'),
  debugThreshold: document.getElementById('debugThreshold'),
  debugGap: document.getElementById('debugGap'),
  debugRotation: document.getElementById('debugRotation'),
  debugStreak: document.getElementById('debugStreak'),
};

const state = {
  stepCount: loadStepCount(),
  smoothedMagnitude: 0,
  isAboveThreshold: false,
  lastStepTime: 0,
  lastCandidateTime: 0,
  consistentStepStreak: 0,
  tracking: false,
};

init();

function init() {
  els.stepCount.textContent = state.stepCount;
  els.debugThreshold.textContent = STEP_THRESHOLD.toFixed(2);

  els.startBtn.addEventListener('click', startTracking);
  els.stopBtn.addEventListener('click', stopTracking);
  els.resetBtn.addEventListener('click', resetCounter);
  els.retryBtn.addEventListener('click', startTracking);
  els.debugToggle.addEventListener('change', () => {
    els.debugPanel.hidden = !els.debugToggle.checked;
  });

  if (typeof DeviceMotionEvent === 'undefined') {
    showUnsupported();
  }
}

/**
 * Requests access to motion sensors and, on success, starts listening for
 * devicemotion events. Handles the iOS 13+ permission-gate case as well as
 * browsers/devices that don't support or need explicit permission.
 */
async function requestPermission() {
  if (typeof DeviceMotionEvent === 'undefined') {
    showUnsupported();
    return false;
  }

  // iOS 13+ Safari requires an explicit, user-gesture-triggered permission
  // request. Other browsers (Android Chrome, desktop) don't expose this
  // method at all, so we fall back to assuming access is already granted.
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    try {
      const result = await DeviceMotionEvent.requestPermission();
      if (result !== 'granted') {
        showPermissionDenied();
        return false;
      }
      return true;
    } catch (err) {
      showPermissionDenied();
      return false;
    }
  }

  return true;
}

async function startTracking() {
  hideError();

  const granted = await requestPermission();
  if (!granted) return;

  state.tracking = true;
  state.smoothedMagnitude = 0;
  state.isAboveThreshold = false;

  window.addEventListener('devicemotion', handleMotion);

  // Some desktop browsers/devices "support" the API but never actually
  // fire devicemotion events (no accelerometer hardware). Detect that
  // case with a short timeout and show a friendly message instead of
  // silently doing nothing.
  const noDataTimer = setTimeout(() => {
    if (state.tracking && state.lastEventAt === undefined) {
      stopTracking();
      showError(
        'No motion data was received. This device/browser may not have ' +
        'an accelerometer, or motion access is unavailable (common on ' +
        'desktop browsers). Try opening this page on a phone.'
      );
    }
  }, 3000);
  state.noDataTimer = noDataTimer;

  setStatus('Tracking active', 'active');
  els.startBtn.hidden = true;
  els.stopBtn.hidden = false;
}

function stopTracking() {
  state.tracking = false;
  window.removeEventListener('devicemotion', handleMotion);
  clearTimeout(state.noDataTimer);

  els.startBtn.hidden = false;
  els.stopBtn.hidden = true;

  if (els.errorPanel.hidden) {
    setStatus('Tracking stopped');
  }
}

/**
 * devicemotion event handler: pulls acceleration data off the event,
 * computes the magnitude, and feeds it into the step detector.
 */
function handleMotion(event) {
  state.lastEventAt = Date.now();
  clearTimeout(state.noDataTimer);

  // Prefer linear acceleration (gravity already removed) when the device
  // provides it; otherwise fall back to acceleration including gravity.
  const accel = event.acceleration && hasValues(event.acceleration)
    ? event.acceleration
    : event.accelerationIncludingGravity;

  if (!accel || !hasValues(accel)) {
    return;
  }

  const magnitude = Math.sqrt(
    (accel.x || 0) ** 2 + (accel.y || 0) ** 2 + (accel.z || 0) ** 2
  );

  // If we're using accelerationIncludingGravity, subtract the resting
  // gravity magnitude (~9.8 m/s^2) so the signal centers near zero, the
  // same way linear acceleration would.
  const usingGravity = accel === event.accelerationIncludingGravity;
  const normalizedMagnitude = usingGravity ? Math.abs(magnitude - 9.8) : Math.abs(magnitude);

  const isRotatingFast = isRotatingFastEnoughToIgnore(event.rotationRate);

  detectStep(normalizedMagnitude, isRotatingFast);
  updateDebugUI(normalizedMagnitude, isRotatingFast);
}

function hasValues(vector) {
  return vector.x !== null && vector.y !== null && vector.z !== null;
}

function isRotatingFastEnoughToIgnore(rotationRate) {
  if (!rotationRate) return false;
  const { alpha, beta, gamma } = rotationRate;
  if (alpha === null || beta === null || gamma === null) return false;

  const rotationMagnitude = Math.sqrt(alpha ** 2 + beta ** 2 + gamma ** 2);
  return rotationMagnitude > ROTATION_GATE_DEG_PER_SEC;
}

/**
 * Peak-detection step algorithm.
 *
 * 1. Smooth the raw magnitude with an exponential moving average (a
 *    simple low-pass filter) to remove high-frequency sensor noise.
 * 2. Track whether the smoothed signal is currently above
 *    STEP_THRESHOLD ("in a peak").
 * 3. Count a step on the falling edge: the moment the signal drops back
 *    below the threshold after having been above it. This avoids
 *    counting the same footfall multiple times while it's above the
 *    threshold.
 * 4. Ignore candidate steps while the phone is rotating fast (see
 *    ROTATION_GATE_DEG_PER_SEC) - a deliberate flip/spin produces a real
 *    acceleration spike too, but isn't a footfall.
 * 5. Require a short streak of candidates spaced within a plausible
 *    walking-cadence window (MIN/MAX_STEP_INTERVAL_MS) before counting
 *    them (see REQUIRED_CONSISTENT_STEPS). This is what distinguishes a
 *    real walking rhythm from an isolated shake/wave, which produces the
 *    same kind of amplitude spike but rarely holds a steady cadence.
 */
function detectStep(rawMagnitude, isRotatingFast) {
  state.smoothedMagnitude =
    SMOOTHING_ALPHA * rawMagnitude + (1 - SMOOTHING_ALPHA) * state.smoothedMagnitude;

  const now = Date.now();

  if (!state.isAboveThreshold && state.smoothedMagnitude > STEP_THRESHOLD) {
    // Rising edge: entered a peak.
    state.isAboveThreshold = true;
  } else if (state.isAboveThreshold && state.smoothedMagnitude <= STEP_THRESHOLD) {
    // Falling edge: left the peak, this is a candidate step.
    state.isAboveThreshold = false;

    if (!isRotatingFast) {
      const sinceLastCandidate = state.lastCandidateTime ? now - state.lastCandidateTime : null;
      const isOnBeat =
        sinceLastCandidate !== null &&
        sinceLastCandidate >= MIN_STEP_INTERVAL_MS &&
        sinceLastCandidate <= MAX_STEP_INTERVAL_MS;

      state.lastCandidateTime = now;
      state.consistentStepStreak = isOnBeat ? state.consistentStepStreak + 1 : 1;

      if (state.consistentStepStreak >= REQUIRED_CONSISTENT_STEPS) {
        state.lastStepTime = now;
        registerStep();
      }
    }
  }

  state.rawMagnitude = rawMagnitude;
}

function registerStep() {
  state.stepCount += 1;
  saveStepCount(state.stepCount);
  updateUI();
}

function updateUI() {
  els.stepCount.textContent = state.stepCount;
}

function updateDebugUI(rawMagnitude, isRotatingFast) {
  if (!els.debugToggle.checked) return;
  els.debugRaw.textContent = rawMagnitude.toFixed(2);
  els.debugSmoothed.textContent = state.smoothedMagnitude.toFixed(2);
  els.debugGap.textContent = state.lastStepTime ? Date.now() - state.lastStepTime : '-';
  els.debugRotation.textContent = isRotatingFast ? 'yes (steps ignored)' : 'no';
  els.debugStreak.textContent = `${state.consistentStepStreak} / ${REQUIRED_CONSISTENT_STEPS}`;
}

function resetCounter() {
  state.stepCount = 0;
  state.lastStepTime = 0;
  state.lastCandidateTime = 0;
  state.consistentStepStreak = 0;
  saveStepCount(0);
  updateUI();
}

function loadStepCount() {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  const parsed = parseInt(stored, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function saveStepCount(count) {
  window.localStorage.setItem(STORAGE_KEY, String(count));
}

/* ------------------------------ status/error UI ------------------------------ */

function setStatus(message, kind) {
  els.status.textContent = message;
  els.status.classList.remove('status--active', 'status--error');
  if (kind === 'active') els.status.classList.add('status--active');
  if (kind === 'error') els.status.classList.add('status--error');
}

function showError(message, kind) {
  els.errorMessage.textContent = message;
  els.errorPanel.hidden = false;
  setStatus(kind === 'unsupported' ? 'Motion sensors not supported on this device/browser' : 'Something went wrong', 'error');
}

function hideError() {
  els.errorPanel.hidden = true;
  els.retryBtn.hidden = true;
}

function showUnsupported() {
  els.startBtn.hidden = true;
  showError(
    'Motion sensors are not supported on this device or browser. Step ' +
    'tracking requires the DeviceMotion API, available on most phone ' +
    'browsers (Chrome on Android, Safari on iOS). Desktop browsers ' +
    'typically don’t support this.',
    'unsupported'
  );
}

function showPermissionDenied() {
  els.retryBtn.hidden = false;
  showError(
    'Motion access was denied. To enable it: on iOS, go to Settings > ' +
    'Safari > Motion & Orientation Access and make sure it’s on, ' +
    'then reload this page. On Android, check the site permissions for ' +
    'your browser. Then tap Retry.',
    'error'
  );
}
