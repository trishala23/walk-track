'use strict';

/* -------------------------------------------------------------------------
 * Tunable constants
 *
 * These control the peak-detection algorithm. If the counter is UNDER-
 * counting steps (missing real steps), try lowering STEP_THRESHOLD or
 * SMOOTHING_ALPHA. If it's OVER-counting (counting noise/vibration as
 * steps), try raising STEP_THRESHOLD or MIN_STEP_INTERVAL_MS.
 * ---------------------------------------------------------------------- */

// Acceleration magnitude (m/s^2) the smoothed signal must rise above, then
// fall back below, for a step to be registered. Typical walking peaks are
// roughly 1-3 m/s^2 above gravity once gravity is removed by the low-pass
// filter below.
const STEP_THRESHOLD = 1.2;

// Minimum time between two counted steps, in milliseconds. Prevents a
// single footfall's vibration from being counted twice. Average walking
// cadence is one step roughly every 400-600ms, so 250-300ms is a safe
// floor that still allows fast walking/light jogging.
const MIN_STEP_INTERVAL_MS = 300;

// Smoothing factor for the exponential moving average (0-1). Lower values
// smooth more aggressively (less noise, but slower to react); higher
// values track the raw signal more closely.
const SMOOTHING_ALPHA = 0.2;

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
};

const state = {
  stepCount: loadStepCount(),
  smoothedMagnitude: 0,
  isAboveThreshold: false,
  lastStepTime: 0,
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

  detectStep(normalizedMagnitude);
  updateDebugUI(normalizedMagnitude);
}

function hasValues(vector) {
  return vector.x !== null && vector.y !== null && vector.z !== null;
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
 * 4. Enforce MIN_STEP_INTERVAL_MS between counted steps as a debounce,
 *    since a genuine footfall vibration or a brief re-cross of the
 *    threshold shouldn't register as two separate steps.
 */
function detectStep(rawMagnitude) {
  state.smoothedMagnitude =
    SMOOTHING_ALPHA * rawMagnitude + (1 - SMOOTHING_ALPHA) * state.smoothedMagnitude;

  const now = Date.now();

  if (!state.isAboveThreshold && state.smoothedMagnitude > STEP_THRESHOLD) {
    // Rising edge: entered a peak.
    state.isAboveThreshold = true;
  } else if (state.isAboveThreshold && state.smoothedMagnitude <= STEP_THRESHOLD) {
    // Falling edge: left the peak, this is a candidate step.
    state.isAboveThreshold = false;

    const timeSinceLastStep = now - state.lastStepTime;
    if (timeSinceLastStep >= MIN_STEP_INTERVAL_MS) {
      state.lastStepTime = now;
      registerStep();
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

function updateDebugUI(rawMagnitude) {
  if (!els.debugToggle.checked) return;
  els.debugRaw.textContent = rawMagnitude.toFixed(2);
  els.debugSmoothed.textContent = state.smoothedMagnitude.toFixed(2);
  els.debugGap.textContent = state.lastStepTime ? Date.now() - state.lastStepTime : '-';
}

function resetCounter() {
  state.stepCount = 0;
  state.lastStepTime = 0;
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
