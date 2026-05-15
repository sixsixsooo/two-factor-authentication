/* global tf, mobilenet, knnClassifier, SurvAPI, SurvFacePipeline, SurvRfid */

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
const btnLogin = document.getElementById('btnLogin');
const statusAction = document.getElementById('statusAction');
const panelSkud = document.getElementById('panelSkud');
const panelPassword = document.getElementById('panelPassword');
const btnShowPasswordLogin = document.getElementById('btnShowPasswordLogin');
const btnBackSkud = document.getElementById('btnBackSkud');
const btnPasswordRequest = document.getElementById('btnPasswordRequest');
const btnLoginPassword = document.getElementById('btnLoginPassword');
const passwordLoginInput = document.getElementById('passwordLogin');
const passwordPasswordInput = document.getElementById('passwordPassword');
const passwordStatus = document.getElementById('passwordStatus');
const statusActionPassword = document.getElementById('statusActionPassword');

/**
 * Распознавание не по «уверенности KNN» (при 1 классе она всегда ~1 для любого лица),
 * а по косинусной близости текущего кадра к среднему эмбеддингу класса.
 */
const COSINE_MIN_SAME_PERSON = 0.78;
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
/** true если в последнем кадре BlazeFace не нашёл лицо (или crop пустой). */
let lastFaceMissing = false;

let requiresRfid = true;
let rfidVerified = false;
let scannedRfidCardId = null;
let rfidReader = null;
let expectedEmployeeRole = 'employee';

const rfidBlock = document.getElementById('rfidBlock');
const rfidLoginCapture = document.getElementById('rfidLoginCapture');
const rfidLoginStatus = document.getElementById('rfidLoginStatus');

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

/** После первого успешного распознавания лица вход не блокируется, если лицо ушло из кадра. */
let faceConfirmedOnce = false;

let loginMode = 'skud';
let passwordRequestId = null;
let passwordApproved = false;
let passwordPollTimer = null;

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
  if (faceConfirmedOnce) {
    predictionStatus.textContent = 'лицо: подтверждено — можно войти (держать лицо в кадре не нужно)';
    predictionStatus.className = 'tag ok';
    return;
  }
  if (lastFaceMissing) {
    predictionStatus.textContent = 'лицо: нет лица в кадре (BlazeFace) — смотрите в камеру';
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

function faceOkForLogin() {
  return faceConfirmedOnce || faceMatchesExpected();
}

function rfidOkForLogin() {
  return rfidVerified && !!scannedRfidCardId;
}

function maybeEnableLogin() {
  if (loginMode === 'password') {
    if (btnLoginPassword) btnLoginPassword.disabled = !passwordApproved;
    return;
  }
  const ok = faceOkForLogin() && rfidOkForLogin();
  if (btnLogin) btnLogin.disabled = !ok;
}

function setRfidLoginStatus(text, kind) {
  if (!rfidLoginStatus) return;
  rfidLoginStatus.textContent = text;
  if (kind === 'ok') rfidLoginStatus.style.color = '#86efac';
  else if (kind === 'bad') rfidLoginStatus.style.color = '#f87171';
  else if (kind === 'warn') rfidLoginStatus.style.color = '#fbbf24';
  else rfidLoginStatus.style.color = '#9ca3af';
}

function setupLoginRfidReader() {
  if (!window.SurvRfid || !rfidLoginCapture || rfidReader) return;
  rfidReader = SurvRfid.create({
    onScan: function (cardId) {
      scannedRfidCardId = cardId;
      if (rfidLoginCapture) rfidLoginCapture.value = '';
      rfidVerified = true;
      setRfidLoginStatus('Пропуск: считан', 'ok');
      diagLog('RFID: пропуск считан (вход)');
      maybeEnableLogin();
    }
  });
  rfidReader.attach(rfidLoginCapture);
  rfidLoginCapture.addEventListener('focus', function () {
    rfidReader.focus();
  });
}

function enableRfidBlock() {
  requiresRfid = true;
  rfidVerified = false;
  scannedRfidCardId = null;
  if (rfidLoginCapture) rfidLoginCapture.value = '';
  if (rfidBlock) {
    rfidBlock.style.opacity = '1';
    rfidBlock.style.pointerEvents = 'auto';
  }
  setRfidLoginStatus('Пропуск: приложите карту к считывателю', 'warn');
  setupLoginRfidReader();
  if (rfidReader) rfidReader.focus();
  maybeEnableLogin();
}

function showPasswordPanel(show) {
  loginMode = show ? 'password' : 'skud';
  if (panelPassword) panelPassword.style.display = show ? 'block' : 'none';
  if (panelSkud) panelSkud.style.display = show ? 'none' : '';
  if (btnShowPasswordLogin) btnShowPasswordLogin.style.display = show ? 'none' : '';
  if (btnBackSkud) btnBackSkud.style.display = show ? '' : 'none';
  maybeEnableLogin();
}

function stopPasswordPoll() {
  if (passwordPollTimer) {
    clearInterval(passwordPollTimer);
    passwordPollTimer = null;
  }
}

async function pollPasswordRequest() {
  if (!passwordRequestId || !window.SurvAPI) return;
  try {
    const st = await SurvAPI.getPasswordLoginRequest(passwordRequestId);
    if (st.status === 'approved') {
      passwordApproved = true;
      if (passwordStatus) {
        passwordStatus.textContent = 'Бухгалтер подтвердил вход. Нажмите «Войти».';
        passwordStatus.style.color = '#86efac';
      }
      stopPasswordPoll();
      maybeEnableLogin();
    } else if (st.status === 'rejected') {
      passwordApproved = false;
      if (passwordStatus) {
        passwordStatus.textContent = 'Бухгалтер отклонил запрос.';
        passwordStatus.style.color = '#f87171';
      }
      stopPasswordPoll();
    } else if (st.status === 'expired') {
      passwordApproved = false;
      if (passwordStatus) {
        passwordStatus.textContent = 'Время запроса истекло. Отправьте снова.';
        passwordStatus.style.color = '#fbbf24';
      }
      stopPasswordPoll();
    } else if (passwordStatus) {
      passwordStatus.textContent = 'Ожидание подтверждения бухгалтером…';
    }
  } catch (e) {
    diagLog('poll password', e);
  }
}

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
  if (!window.SurvFacePipeline) {
    throw new Error('Не загружен face-pipeline.js');
  }
  modelsStatus.textContent = 'модели: BlazeFace…';
  await withTimeout(SurvFacePipeline.ensureBlazeFace(), 120000, 'BlazeFace');
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

async function getNormalizedActivationVector() {
  lastFaceMissing = false;
  if (!window.SurvFacePipeline || !net || !webcam) return null;
  const activation = await SurvFacePipeline.getFaceActivation(webcam, net, false);
  if (!activation) {
    lastFaceMissing = true;
    return null;
  }
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

function dotProduct(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
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

async function tryLoadDatasetFromServer() {
  if (!window.SurvAPI) return false;
  try {
    const { dataset } = await SurvAPI.loadKnnDataset();
    if (!dataset || typeof dataset !== 'object' || Object.keys(dataset).length === 0) return false;
    await importDatasetFromJsonObject(dataset);
    diagLog('KNN загружен с сервера (MySQL)');
    return true;
  } catch (e) {
    diagLog('KNN server load', e);
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
      if (!vec) {
        if (!faceConfirmedOnce) {
          stableMatchFrames = 0;
          recognizedEmployeeId = null;
          recognizedConfidence = 0;
        }
        lastCosineToExpected = 0;
        lastFaceDebug = { bestId: '', bestSim: 0, secondId: '', secondSim: 0 };
        setStatusText();
        maybeEnableLogin();
        return;
      }
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
          if (!faceConfirmedOnce) {
            faceConfirmedOnce = true;
            diagLog('лицо подтверждено (зафиксировано)');
          }
        }
      } else if (!faceConfirmedOnce) {
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
  faceConfirmedOnce = false;
  recognizedEmployeeId = null;
  recognizedConfidence = 0;
  stableMatchFrames = 0;
  lastCosineToExpected = 0;
  lastFaceDebug = { bestId: '', bestSim: 0, secondId: '', secondSim: 0 };
  lastFaceMissing = false;
  rfidVerified = false;
  scannedRfidCardId = null;
  requiresRfid = true;
  if (rfidBlock) {
    rfidBlock.style.opacity = '0.5';
    rfidBlock.style.pointerEvents = 'none';
  }
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
    if (window.SurvFacePipeline && typeof SurvFacePipeline.dispose === 'function') {
      SurvFacePipeline.dispose();
    }
  } catch (_) {}
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
    let loaded = await tryLoadDatasetFromServer();
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
    if (!window.SurvAPI) {
      throw new Error('Не загружен surv-api.js');
    }
    const data = await SurvAPI.getEmployee(id);
    diagLog('GET /api/employee/' + id + ' → ' + (data ? 'ok' : 'null'));

    if (!data) {
      employeeVerified = false;
      expectedEmployeeIdStr = null;
      employeeInfo.textContent = 'Сотрудник с таким employeeId не найден в базе на сервере.';
      employeeInfo.style.color = '#f87171';
      setBox(statusBox, 'Сначала зарегистрируйте сотрудника на странице регистрации.', 'error');
      faceBlock.style.opacity = '0.5';
      faceBlock.style.pointerEvents = 'none';
      maybeEnableLogin();
      return;
    }

    employeeVerified = true;
    expectedEmployeeIdStr = String(data.id);
    verifiedEmployeeName = data.name || '';
    expectedEmployeeRole = data.role || 'employee';
    employeeInfo.textContent =
      'Найден: ' +
      verifiedEmployeeName +
      ' (id ' +
      data.id +
      ', ' +
      (data.role === 'accountant' ? 'бухгалтер' : 'сотрудник') +
      ')';
    employeeInfo.style.color = '#93c5fd';
    faceBlock.style.opacity = '1';
    faceBlock.style.pointerEvents = 'auto';

    enableRfidBlock();

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

function finishLoginRedirect(loginData) {
  const role = loginData.role || 'employee';
  localStorage.setItem('surv_employee_id', String(loginData.employeeId));
  localStorage.setItem('surv_role', role);
  localStorage.removeItem('surv_local_session_start');
  localStorage.removeItem('surv_local_login');
  setTimeout(() => {
    window.location.href = role === 'accountant' ? '/accountant.html' : '/dashboard.html';
  }, 400);
}

btnLogin.addEventListener('click', async () => {
  const id = expectedEmployeeIdStr ? parseInt(expectedEmployeeIdStr, 10) : NaN;
  if (!id || !faceOkForLogin()) {
    setBox(statusAction, 'Подтвердите лицо и приложите RFID-карту.', 'error');
    return;
  }
  if (!rfidOkForLogin()) {
    setBox(statusAction, 'Приложите RFID-карту к считывателю.', 'error');
    return;
  }

  try {
    btnLogin.disabled = true;
    statusAction.style.display = 'block';
    statusAction.className = 'status info';
    statusAction.textContent = 'Вход на сервер…';

    const loginData = await SurvAPI.login(id, scannedRfidCardId);
    statusAction.className = 'status success';
    statusAction.textContent = 'Вход выполнен (' + (loginData.name || '') + '). Переход…';
    finishLoginRedirect(loginData);
  } catch (e) {
    setBox(statusAction, e && e.message ? e.message : String(e), 'error');
  } finally {
    maybeEnableLogin();
  }
});

if (btnShowPasswordLogin) {
  btnShowPasswordLogin.addEventListener('click', () => showPasswordPanel(true));
}
if (btnBackSkud) {
  btnBackSkud.addEventListener('click', () => {
    stopPasswordPoll();
    showPasswordPanel(false);
  });
}

if (btnPasswordRequest) {
  btnPasswordRequest.addEventListener('click', async () => {
    const login = passwordLoginInput ? passwordLoginInput.value : '';
    const password = passwordPasswordInput ? passwordPasswordInput.value : '';
    passwordApproved = false;
    passwordRequestId = null;
    stopPasswordPoll();
    if (btnLoginPassword) btnLoginPassword.disabled = true;
    try {
      btnPasswordRequest.disabled = true;
      const data = await SurvAPI.requestPasswordLogin(login, password);
      passwordRequestId = data.requestId;
      if (passwordStatus) {
        passwordStatus.textContent = data.message || 'Запрос отправлен.';
        passwordStatus.style.color = '#93c5fd';
      }
      passwordPollTimer = setInterval(pollPasswordRequest, 2500);
      pollPasswordRequest();
    } catch (e) {
      if (passwordStatus) {
        passwordStatus.textContent = e && e.message ? e.message : String(e);
        passwordStatus.style.color = '#f87171';
      }
    } finally {
      btnPasswordRequest.disabled = false;
    }
  });
}

if (btnLoginPassword) {
  btnLoginPassword.addEventListener('click', async () => {
    if (!passwordApproved || !passwordRequestId) return;
    try {
      btnLoginPassword.disabled = true;
      setBox(statusActionPassword, 'Вход…', 'info');
      const loginData = await SurvAPI.loginWithPasswordApproval(passwordRequestId);
      setBox(statusActionPassword, 'Вход выполнен. Переход…', 'success');
      stopPasswordPoll();
      finishLoginRedirect(loginData);
    } catch (e) {
      setBox(statusActionPassword, e && e.message ? e.message : String(e), 'error');
    } finally {
      maybeEnableLogin();
    }
  });
}

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
  if (!window.SurvAPI) {
    modelsStatus.textContent = 'ошибка';
    setBox(statusBox, 'Подключите surv-api.js перед login.js', 'error');
    return;
  }

  modelsStatus.textContent = 'модели: после проверки employeeId';
}

window.addEventListener('DOMContentLoaded', boot);
