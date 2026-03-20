/* global tf, mobilenet, knnClassifier, SurvLocalDB */

const diagLines = [];
const MAX_DIAG = 80;

function diagLog(msg, err) {
  try {
    const extra = err ? (err.stack || err.message || String(err)) : '';
    const line = new Date().toISOString() + ' ' + msg + (extra ? ' | ' + extra : '');
    diagLines.push(line);
    if (diagLines.length > MAX_DIAG) diagLines.shift();
    console.log('[SURV]', line);
    const el = document.getElementById('diagLog');
    if (el) el.textContent = diagLines.slice(-40).join('\n');
  } catch (_) {}
}

const webcam = document.getElementById('webcam');
const modelsStatus = document.getElementById('modelsStatus');
const datasetStatus = document.getElementById('datasetStatus');
const predictionStatus = document.getElementById('predictionStatus');
const faceBlock = document.getElementById('faceBlock');

const employeeIdInput = document.getElementById('employeeIdInput');
const btnCheckEmployee = document.getElementById('btnCheckEmployee');
const employeeInfo = document.getElementById('employeeInfo');

const statusBox = document.getElementById('statusBox');
const gpsStatus = document.getElementById('gpsStatus');
const gpsCoords = document.getElementById('gpsCoords');
const btnRetryGps = document.getElementById('btnRetryGps');
const btnLogin = document.getElementById('btnLogin');
const statusAction = document.getElementById('statusAction');

/**
 * Распознавание не по «уверенности KNN» (при 1 классе она всегда ~1 для любого лица),
 * а по косинусной близости текущего кадра к среднему эмбеддингу класса.
 */
const COSINE_MIN_SAME_PERSON = 0.84;
/** Подряд кадров с хорошим совпадением (после снятия лишнего margin между классами). */
const STABLE_FRAMES_NEEDED = 6;

let net = null;
let classifier = null;
/** label -> L2-нормированный средний вектор признаков */
let classMeanEmbeddings = null;
let stableMatchFrames = 0;
/** Последняя cos-схожесть с ожидаемым employeeId (для подсказки в UI) */
let lastCosineToExpected = 0;
/** Для подсказки: кто «ближе всех» по эталону, если не вы */
let lastFaceDebug = { bestId: '', bestSim: 0, secondId: '', secondSim: 0 };

/** После успешной проверки сотрудника в IndexedDB */
let employeeVerified = false;
let expectedEmployeeIdStr = null;
let verifiedEmployeeName = '';

let recognizedEmployeeId = null;
let recognizedConfidence = 0;

let isPredicting = false;
let isTraining = false;
let facePipelineStarted = false;
let facePipelinePromise = null;

let gps = { lat: null, lon: null };

function setBox(el, text, kind) {
  if (!el) return;
  el.style.display = 'block';
  el.className = 'status ' + (kind || 'info');
  el.textContent = text;
}

function setStatusText() {
  if (!employeeVerified || !expectedEmployeeIdStr) {
    predictionStatus.textContent = 'лицо: сначала проверьте employeeId';
    predictionStatus.className = 'tag bad';
    return;
  }
  if (!classMeanEmbeddings || !classMeanEmbeddings[expectedEmployeeIdStr]) {
    predictionStatus.textContent = 'лицо: нет эталона для id ' + expectedEmployeeIdStr;
    predictionStatus.className = 'tag bad';
    return;
  }
  if (!recognizedEmployeeId) {
    let line =
      'лицо: cos к вашему эталону = ' +
      lastCosineToExpected.toFixed(2) +
      ' (нужно ≥ ' +
      COSINE_MIN_SAME_PERSON +
      ', подряд ' +
      STABLE_FRAMES_NEEDED +
      ' кадров: ' +
      stableMatchFrames +
      '/' +
      STABLE_FRAMES_NEEDED +
      ')';
    if (lastFaceDebug.bestId && lastFaceDebug.bestId !== expectedEmployeeIdStr) {
      line +=
        ' · сейчас ближе id ' +
        lastFaceDebug.bestId +
        ' (cos ' +
        lastFaceDebug.bestSim.toFixed(2) +
        ')';
    }
    predictionStatus.textContent = line;
    predictionStatus.className = 'tag bad';
    return;
  }
  predictionStatus.textContent =
    'лицо: совпало (id ' +
    recognizedEmployeeId +
    ', cos=' +
    recognizedConfidence.toFixed(2) +
    ')';
  predictionStatus.className = recognizedConfidence >= COSINE_MIN_SAME_PERSON ? 'tag ok' : 'tag bad';
}

function updateDatasetStatus() {
  try {
    if (!classifier) {
      datasetStatus.textContent = 'база: —';
      return;
    }
    const numExamples = classifier.getNumExamples();
    datasetStatus.textContent = 'база: ' + (numExamples > 0 ? 'есть данные (' + numExamples + ')' : 'пусто (обучите на странице регистрации)');
  } catch (e) {
    datasetStatus.textContent = 'база: ?';
  }
}

function faceMatchesExpected() {
  return (
    employeeVerified &&
    expectedEmployeeIdStr &&
    recognizedEmployeeId === expectedEmployeeIdStr &&
    recognizedConfidence >= COSINE_MIN_SAME_PERSON
  );
}

function maybeEnableLogin() {
  const ok = faceMatchesExpected() && gps.lat !== null && gps.lon !== null;
  btnLogin.disabled = !ok;
}

function geolocationErrorMessage(code) {
  switch (code) {
    case 1:
      return 'доступ запрещён';
    case 2:
      return 'позиция недоступна';
    case 3:
      return 'таймаут';
    default:
      return 'ошибка';
  }
}

async function startGps() {
  diagLog('startGps()');
  if (!navigator.geolocation) {
    gpsStatus.textContent = 'GPS: не поддерживается';
    gpsStatus.className = 'tag bad';
    gpsCoords.textContent = 'Браузер не поддерживает Geolocation API.';
    return;
  }
  gps.lat = null;
  gps.lon = null;
  gpsStatus.textContent = 'GPS: запрос…';
  gpsStatus.className = 'tag';
  gpsCoords.textContent =
    'Разрешите доступ к местоположению. На не-localhost без HTTPS геолокация может быть недоступна.';

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gps.lat = pos.coords.latitude;
      gps.lon = pos.coords.longitude;
      gpsStatus.textContent = 'GPS: ок';
      gpsStatus.className = 'tag ok';
      gpsCoords.textContent = `lat=${gps.lat.toFixed(6)}, lon=${gps.lon.toFixed(6)}`;
      diagLog('GPS OK');
      maybeEnableLogin();
    },
    (err) => {
      const code = err && err.code;
      gpsStatus.textContent = 'GPS: ' + geolocationErrorMessage(code);
      gpsStatus.className = 'tag bad';
      gpsCoords.textContent =
        'Без сети браузер часто не получает точку. Нажмите «Последние координаты» или введите lat/lon вручную.';
      diagLog('GPS error', err);
      maybeEnableLogin();
    },
    {
      enableHighAccuracy: false,
      timeout: 30000,
      /** Разрешить кэш браузера (часто даёт точку без сети, если недавно уже определялись). */
      maximumAge: 300000
    }
  );
}

/**
 * Координаты из прошлого успешного входа (localStorage) — для работы без сети / без свежего GPS.
 */
function applySavedGpsFromStorage() {
  try {
    const raw = localStorage.getItem('surv_last_gps');
    if (!raw) {
      gpsCoords.textContent = 'Сохранённых координат ещё нет — введите lat/lon вручную ниже.';
      return false;
    }
    const j = JSON.parse(raw);
    if (j.lat == null || j.lon == null) return false;
    gps.lat = Number(j.lat);
    gps.lon = Number(j.lon);
    gpsStatus.textContent = 'GPS: сохранённые';
    gpsStatus.className = 'tag ok';
    gpsCoords.textContent = `lat=${gps.lat.toFixed(6)}, lon=${gps.lon.toFixed(6)} (из последнего входа, офлайн)`;
    diagLog('GPS из surv_last_gps');
    maybeEnableLogin();
    return true;
  } catch (e) {
    diagLog('saved GPS', e);
    return false;
  }
}

function applyManualGps() {
  const latEl = document.getElementById('manualLat');
  const lonEl = document.getElementById('manualLon');
  const lat = latEl ? parseFloat(latEl.value) : NaN;
  const lon = lonEl ? parseFloat(lonEl.value) : NaN;
  if (Number.isNaN(lat) || Number.isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    gpsCoords.textContent =
      'Некорректные координаты. lat: -90…90, lon: -180…180 (можно с точкой: 47.21).';
    return;
  }
  gps.lat = lat;
  gps.lon = lon;
  gpsStatus.textContent = 'GPS: вручную';
  gpsStatus.className = 'tag ok';
  gpsCoords.textContent = `lat=${gps.lat.toFixed(6)}, lon=${gps.lon.toFixed(6)} (ввод вручную, офлайн)`;
  try {
    localStorage.setItem(
      'surv_last_gps',
      JSON.stringify({ lat: gps.lat, lon: gps.lon, at: new Date().toISOString() })
    );
  } catch (_) {}
  diagLog('GPS вручную');
  maybeEnableLogin();
}

if (btnRetryGps) {
  btnRetryGps.addEventListener('click', () => startGps());
}

document.getElementById('btnUseSavedGps')?.addEventListener('click', () => applySavedGpsFromStorage());
document.getElementById('btnApplyManualGps')?.addEventListener('click', applyManualGps);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(label + ' (таймаут ' + ms / 1000 + ' с)')), ms)
    )
  ]);
}

async function initTfBackend() {
  if (!window.tf || !tf.setBackend) {
    throw new Error('tf.js не загрузился');
  }
  const tryBackend = async (name) => {
    await tf.setBackend(name);
    await tf.ready();
  };
  const order = ['webgl', 'cpu'];
  let lastErr = null;
  for (const name of order) {
    try {
      modelsStatus.textContent = 'модели: TF ' + name + '…';
      await withTimeout(tryBackend(name), 25000, 'Backend ' + name);
      return;
    } catch (e) {
      lastErr = e;
      diagLog('TF ' + name, e);
    }
  }
  throw new Error('TensorFlow.js: ' + (lastErr && lastErr.message));
}

/** Локальные веса MobileNet v2 (см. scripts/download-mobilenet-model.js), без TF Hub в рантайме */
const MOBILENET_MODEL_URL = '/vendor/mobilenet-model/model.json';

async function setupModels() {
  if (!mobilenet) throw new Error('MobileNet не загрузился');
  modelsStatus.textContent = 'модели: MobileNet…';
  net = await withTimeout(
    mobilenet.load({ version: 2, alpha: 1.0, modelUrl: MOBILENET_MODEL_URL }),
    120000,
    'MobileNet'
  );
  modelsStatus.textContent = 'модели: готовы';
}

async function setupWebcam() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Камера недоступна (нужен http://localhost или HTTPS)');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
  webcam.srcObject = stream;
  await new Promise((resolve, reject) => {
    webcam.onloadedmetadata = () => resolve();
    webcam.onerror = () => reject(new Error('video error'));
  });
  await webcam.play();
}

function getActivation() {
  return tf.tidy(() => {
    const img = tf.browser.fromPixels(webcam);
    return net.infer(img, 'conv_preds');
  });
}

function dotProduct(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

async function getNormalizedActivationVector() {
  const activation = getActivation();
  const flat = tf.tidy(() => tf.reshape(activation, [-1]));
  const data = await flat.data();
  flat.dispose();
  activation.dispose();
  let norm = 0;
  for (let i = 0; i < data.length; i++) norm += data[i] * data[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] / norm;
  return out;
}

async function rebuildClassMeans() {
  if (!classifier) {
    classMeanEmbeddings = null;
    return;
  }
  const ds = classifier.getClassifierDataset();
  const labels = Object.keys(ds);
  classMeanEmbeddings = {};
  for (const label of labels) {
    const t = ds[label];
    const meanTensor = tf.tidy(() => tf.mean(t, 0));
    const data = await meanTensor.data();
    meanTensor.dispose();
    let norm = 0;
    for (let i = 0; i < data.length; i++) norm += data[i] * data[i];
    norm = Math.sqrt(norm) || 1;
    const nv = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) nv[i] = data[i] / norm;
    classMeanEmbeddings[label] = nv;
  }
  diagLog('Эталоны лиц (cosine к среднему): классов ' + labels.length);
}

async function importDatasetFromJsonObject(obj) {
  if (!classifier) throw new Error('Классификатор не инициализирован');
  const matrices = {};
  for (const label of Object.keys(obj)) {
    const item = obj[label];
    if (!item || !item.shape || !item.values) continue;
    matrices[label] = tf.tensor(item.values, item.shape, 'float32');
  }
  classifier.setClassifierDataset(matrices);
  if (classifier.labelToClassId && typeof classifier.labelToClassId === 'object') {
    let idx = 0;
    for (const label of Object.keys(matrices)) {
      classifier.labelToClassId[label] = idx++;
    }
    classifier.nextClassId = idx;
  }
  updateDatasetStatus();
  await rebuildClassMeans();
}

async function tryLoadDatasetFromIndexedDB() {
  if (!window.SurvLocalDB) return false;
  try {
    const ds = await SurvLocalDB.loadKnnDataset();
    if (!ds || typeof ds !== 'object' || Object.keys(ds).length === 0) return false;
    await importDatasetFromJsonObject(ds);
    diagLog('KNN загружен из IndexedDB');
    return true;
  } catch (e) {
    diagLog('IndexedDB KNN', e);
    return false;
  }
}

/** Резерв: старый экспорт в localStorage (мог не поместиться из‑за квоты). */
async function tryLoadDatasetFromLocalStorage() {
  const json = localStorage.getItem('surv_knn_dataset_json');
  if (!json) return;
  try {
    await importDatasetFromJsonObject(JSON.parse(json));
    diagLog('KNN загружен из localStorage (legacy)');
  } catch (e) {
    diagLog('knn localStorage', e);
  }
}

async function predictLoop() {
  if (isPredicting) return;
  isPredicting = true;
  try {
    if (
      !isTraining &&
      employeeVerified &&
      net &&
      classifier &&
      classifier.getNumExamples() > 0 &&
      expectedEmployeeIdStr &&
      classMeanEmbeddings
    ) {
      const vec = await getNormalizedActivationVector();
      const expId = expectedEmployeeIdStr;
      const sims = {};
      for (const label of Object.keys(classMeanEmbeddings)) {
        sims[label] = dotProduct(vec, classMeanEmbeddings[label]);
      }
      const entries = Object.entries(sims).sort((a, b) => b[1] - a[1]);
      const best = entries[0];
      const second = entries[1];
      const simExp = sims[expId] != null ? sims[expId] : -1;
      lastCosineToExpected = simExp;
      lastFaceDebug = {
        bestId: best ? String(best[0]) : '',
        bestSim: best ? best[1] : 0,
        secondId: second ? String(second[0]) : '',
        secondSim: second ? second[1] : 0
      };

      const numClasses = entries.length;
      let frameOk = false;
      if (numClasses <= 1) {
        frameOk = simExp >= COSINE_MIN_SAME_PERSON;
      } else {
        // Раньше требовали ещё margin ≥ 0.05 между 1-м и 2-м классом — при cos 0.92 vs 0.89 вход не давали.
        // Достаточно: вы — лучший похожий класс и cos к вашему эталону не ниже порога (стабильность — счётчик кадров).
        frameOk = best[0] === expId && simExp >= COSINE_MIN_SAME_PERSON;
      }

      if (frameOk) {
        stableMatchFrames++;
        if (stableMatchFrames >= STABLE_FRAMES_NEEDED) {
          recognizedEmployeeId = expId;
          recognizedConfidence = simExp;
        }
      } else {
        stableMatchFrames = 0;
        recognizedEmployeeId = null;
        recognizedConfidence = 0;
      }

      setStatusText();
      maybeEnableLogin();
    }
  } catch (e) {
    console.error('predict', e);
  } finally {
    isPredicting = false;
    requestAnimationFrame(predictLoop);
  }
}

function resetVerificationUi() {
  employeeVerified = false;
  expectedEmployeeIdStr = null;
  verifiedEmployeeName = '';
  recognizedEmployeeId = null;
  recognizedConfidence = 0;
  stableMatchFrames = 0;
  lastCosineToExpected = 0;
  lastFaceDebug = { bestId: '', bestSim: 0, secondId: '', secondSim: 0 };
  employeeInfo.textContent = '';
  employeeInfo.style.color = '';
  faceBlock.style.opacity = '0.5';
  faceBlock.style.pointerEvents = 'none';
  modelsStatus.textContent = 'модели: после проверки employeeId';
  predictionStatus.textContent = 'лицо: ожидание…';
  predictionStatus.className = 'tag bad';
  maybeEnableLogin();
}

function fullResetFacePipeline() {
  try {
    if (webcam && webcam.srcObject) {
      webcam.srcObject.getTracks().forEach((t) => t.stop());
      webcam.srcObject = null;
    }
  } catch (_) {}
  facePipelineStarted = false;
  facePipelinePromise = null;
  classifier = null;
  net = null;
  classMeanEmbeddings = null;
  resetVerificationUi();
}

async function initFacePipeline() {
  if (facePipelineStarted) return facePipelinePromise;
  facePipelineStarted = true;
  facePipelinePromise = (async () => {
    if (typeof knnClassifier === 'undefined' || !knnClassifier.create) {
      throw new Error('knn-classifier не загрузился');
    }
    classifier = knnClassifier.create();
    const camPromise = setupWebcam().catch((err) => {
      diagLog('Камера', err);
      setBox(statusBox, 'Камера: ' + (err && err.message ? err.message : String(err)), 'error');
    });
    await initTfBackend();
    await setupModels();
    await camPromise;
    let loaded = await tryLoadDatasetFromIndexedDB();
    if (!loaded) await tryLoadDatasetFromLocalStorage();
    updateDatasetStatus();
    if (classifier.getNumExamples() === 0) {
      setBox(
        statusBox,
        'В базе KNN нет примеров лица. Сначала обучите лицо на странице регистрации.',
        'error'
      );
    }
    requestAnimationFrame(predictLoop);
  })();
  return facePipelinePromise;
}

async function onCheckEmployee() {
  const raw = employeeIdInput.value;
  const id = raw ? parseInt(raw, 10) : NaN;
  if (!id || Number.isNaN(id) || id < 1) {
    setBox(statusBox, 'Введите корректный employeeId (число).', 'error');
    return;
  }

  btnCheckEmployee.disabled = true;
  employeeInfo.textContent = 'Проверка…';
  setBox(statusBox, '', 'info');
  statusBox.style.display = 'none';

  try {
    if (!window.SurvLocalDB) {
      throw new Error('Не загружен local-db.js');
    }
    const data = await SurvLocalDB.getEmployee(id);
    diagLog('IndexedDB getEmployee(' + id + ') → ' + (data ? 'ok' : 'null'));

    if (!data) {
      employeeVerified = false;
      expectedEmployeeIdStr = null;
      employeeInfo.textContent = 'Сотрудник с таким employeeId не найден в локальной базе (IndexedDB).';
      employeeInfo.style.color = '#f87171';
      setBox(statusBox, 'Сначала зарегистрируйте сотрудника на странице регистрации (в этом же браузере).', 'error');
      faceBlock.style.opacity = '0.5';
      faceBlock.style.pointerEvents = 'none';
      maybeEnableLogin();
      return;
    }

    employeeVerified = true;
    expectedEmployeeIdStr = String(data.id);
    verifiedEmployeeName = data.name || '';
    employeeInfo.textContent = 'Найден локально: ' + verifiedEmployeeName + ' (id ' + data.id + ')';
    employeeInfo.style.color = '#93c5fd';
    faceBlock.style.opacity = '1';
    faceBlock.style.pointerEvents = 'auto';

    modelsStatus.textContent = 'модели: загрузка…';
    await initFacePipeline();
    setStatusText();
    maybeEnableLogin();
  } catch (e) {
    console.error(e);
    employeeInfo.textContent = '';
    setBox(statusBox, e && e.message ? e.message : String(e), 'error');
  } finally {
    btnCheckEmployee.disabled = false;
  }
}

btnCheckEmployee.addEventListener('click', onCheckEmployee);

employeeIdInput.addEventListener('input', () => {
  if (!employeeVerified) return;
  const v = parseInt(employeeIdInput.value, 10);
  const cur = expectedEmployeeIdStr ? parseInt(expectedEmployeeIdStr, 10) : NaN;
  if (Number.isNaN(v) || v !== cur) {
    fullResetFacePipeline();
  }
});

btnLogin.addEventListener('click', async () => {
  const id = expectedEmployeeIdStr ? parseInt(expectedEmployeeIdStr, 10) : NaN;
  if (!id || !faceMatchesExpected()) {
    setBox(statusAction, 'Не подтверждены лицо или GPS.', 'error');
    return;
  }
  if (gps.lat === null || gps.lon === null) {
    setBox(statusAction, 'Нет GPS.', 'error');
    return;
  }

  try {
    btnLogin.disabled = true;
    statusAction.style.display = 'block';
    statusAction.className = 'status info';
    statusAction.textContent = 'Вход (локально)…';

    /** Сессия только в браузере — без POST на сервер. */
    localStorage.setItem('surv_employee_id', String(id));
    localStorage.setItem('surv_local_session_start', new Date().toISOString());
    localStorage.setItem('surv_local_login', '1');
    localStorage.setItem(
      'surv_last_gps',
      JSON.stringify({ lat: gps.lat, lon: gps.lon, at: new Date().toISOString() })
    );

    statusAction.className = 'status success';
    statusAction.textContent = 'Вход выполнен. Переход в кабинет…';
    setTimeout(() => {
      window.location.href = '/dashboard.html';
    }, 400);
  } catch (e) {
    setBox(statusAction, e && e.message ? e.message : String(e), 'error');
  } finally {
    btnLogin.disabled = false;
    maybeEnableLogin();
  }
});

const btnCopyDiag = document.getElementById('btnCopyDiag');
if (btnCopyDiag) {
  btnCopyDiag.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(diagLines.join('\n'));
    } catch (e) {
      diagLog('clipboard', e);
    }
  });
}

window.addEventListener('error', (ev) => {
  diagLog('onerror: ' + (ev && ev.message), ev.error);
});

window.addEventListener('unhandledrejection', (ev) => {
  diagLog('rejection', ev.reason);
});

async function boot() {
  diagLog('boot');
  if (location.protocol === 'file:') {
    modelsStatus.textContent = 'ошибка';
    setBox(statusBox, 'Откройте http://localhost:3000/login.html', 'error');
    return;
  }
  if (!window.SurvLocalDB) {
    modelsStatus.textContent = 'ошибка';
    setBox(statusBox, 'Подключите local-db.js перед login.js', 'error');
    return;
  }

  modelsStatus.textContent = 'модели: после проверки employeeId';
  startGps();
}

window.addEventListener('DOMContentLoaded', boot);
