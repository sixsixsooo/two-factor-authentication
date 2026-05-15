/* global tf, mobilenet, knnClassifier, SurvAPI, SurvFacePipeline, SurvRfid */

const diagLines = [];
function diagLog(msg, err) {
  try {
    const extra = err ? (err.stack || err.message || String(err)) : '';
    const line = new Date().toISOString() + ' ' + msg + (extra ? ' | ' + extra : '');
    diagLines.push(line);
    if (diagLines.length > 80) diagLines.shift();
    console.log('[SURV-reg]', line);
    const el = document.getElementById('diagLog');
    if (el) el.textContent = diagLines.slice(-40).join('\n');
  } catch (_) {}
}

const statusBox = document.getElementById('status');
const faceStatus = document.getElementById('faceStatus');
const btnRegisterFull = document.getElementById('btnRegisterFull');

const webcam = document.getElementById('webcam');
const modelsStatus = document.getElementById('modelsStatus');
const datasetStatus = document.getElementById('datasetStatus');
const predictionStatus = document.getElementById('predictionStatus');

/** Больше кадров + слегка пошевелите головой во время записи — лучше отделяет вас от «любого лица». */
const TRAIN_STEPS = 50;
const TRAIN_EVERY_MS = 90;

let net = null;
let classifier = null;
let isRunning = false;
let capturedRfidCardId = null;
let rfidReader = null;

const rfidCaptureInput = document.getElementById('rfidCapture');
const rfidStatusEl = document.getElementById('rfidStatus');
const roleSelect = document.getElementById('role');

function showStatus(type, text) {
  statusBox.style.display = 'block';
  statusBox.className = 'status ' + type;
  statusBox.textContent = text;
}

function setFaceBox(text, kind) {
  faceStatus.style.display = 'block';
  faceStatus.className = 'status ' + (kind || 'info');
  faceStatus.textContent = text;
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
  if (!window.tf || !tf.setBackend) throw new Error('tf.js не загрузился');
  const tryB = async (name) => {
    await tf.setBackend(name);
    await tf.ready();
  };
  for (const name of ['webgl', 'cpu']) {
    try {
      modelsStatus.textContent = 'модели: TF ' + name + '…';
      await withTimeout(tryB(name), 25000, name);
      return;
    } catch (e) {
      diagLog('TF ' + name, e);
    }
  }
  throw new Error('Не удалось запустить TensorFlow.js');
}

const MOBILENET_MODEL_URL = '/vendor/mobilenet-model/model.json';

async function setupModels() {
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
    throw new Error('Камера: нужен http://localhost или HTTPS');
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
  webcam.srcObject = stream;
  await new Promise((resolve, reject) => {
    webcam.onloadedmetadata = () => resolve();
    webcam.onerror = () => reject(new Error('video'));
  });
  await webcam.play();
}

async function getActivationFromFace() {
  if (!window.SurvFacePipeline || !net || !webcam) return null;
  return SurvFacePipeline.getFaceActivation(webcam, net, false);
}

function updateDatasetStatus() {
  try {
    if (!classifier) {
      datasetStatus.textContent = 'база: —';
      return;
    }
    const n = classifier.getNumExamples();
    datasetStatus.textContent = 'база: ' + (n > 0 ? 'готова (' + n + ')' : 'пусто');
  } catch (e) {
    datasetStatus.textContent = 'база: ?';
  }
}

async function importDatasetFromJsonObject(obj) {
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
    diagLog('KNN load server', e);
    return false;
  }
}

async function buildKnnExportObject() {
  const obj = {};
  const datasetMatrices = classifier.getClassifierDataset();
  for (const label of Object.keys(datasetMatrices)) {
    const t = datasetMatrices[label];
    const values = Array.from(await t.data());
    obj[label] = { shape: t.shape, values };
  }
  return obj;
}

async function saveKnnToServer() {
  if (!classifier || classifier.getNumExamples() === 0) {
    throw new Error('Нет данных KNN для сохранения');
  }
  if (!window.SurvAPI) {
    throw new Error('SurvAPI не загружен (surv-api.js)');
  }
  const obj = await buildKnnExportObject();
  let merged = { ...obj };
  try {
    const { dataset } = await SurvAPI.loadKnnDataset();
    if (dataset && typeof dataset === 'object') {
      merged = { ...dataset, ...obj };
    }
  } catch (e) {
    diagLog('KNN merge load', e);
  }
  await SurvAPI.saveKnnDataset(merged);
  diagLog('KNN сохранён на сервере (MySQL)');
}

async function trainExamplesForLabel(labelStr) {
  let i = 0;
  while (i < TRAIN_STEPS) {
    const activation = await getActivationFromFace();
    if (!activation) {
      setFaceBox(`Лицо не найдено (BlazeFace). Уже записано ${i}/${TRAIN_STEPS} — смотрите в камеру`, 'info');
      predictionStatus.textContent = 'ожидание лица…';
      await new Promise((r) => setTimeout(r, TRAIN_EVERY_MS));
      continue;
    }
    classifier.addExample(activation, labelStr);
    activation.dispose();
    if (i % 5 === 0) {
      setFaceBox(`Обучение лица: ${i + 1}/${TRAIN_STEPS}`, 'info');
      predictionStatus.textContent = 'кадры: ' + (i + 1) + '/' + TRAIN_STEPS;
    }
    i += 1;
    await new Promise((r) => setTimeout(r, TRAIN_EVERY_MS));
  }
  updateDatasetStatus();
  predictionStatus.textContent = 'обучение: готово';
  predictionStatus.className = 'tag ok';
}

/** Карточка сотрудника и KNN — на сервере (MySQL). */
async function registerFull() {
  if (isRunning || !net || !classifier) return;

  if (!window.SurvAPI) {
    showStatus('error', 'Не загружен surv-api.js');
    return;
  }

  const name = document.getElementById('name').value.trim();
  const login = document.getElementById('loginName')?.value.trim() || '';
  const email = document.getElementById('email')?.value.trim() || '';
  const password = document.getElementById('password')?.value || '';
  const schedule = document.getElementById('schedule').value;
  const rate = parseFloat(document.getElementById('rate').value);
  const role = roleSelect ? roleSelect.value : 'employee';
  const workStart = document.getElementById('workStart')?.value || '09:00';
  const workStartTime = workStart.length === 5 ? workStart + ':00' : workStart;

  if (!name || !schedule || Number.isNaN(rate) || rate < 0) {
    showStatus('error', 'Заполните имя, график и ставку (число ≥ 0).');
    return;
  }
  if (!login || login.length < 3) {
    showStatus('error', 'Логин: минимум 3 символа.');
    return;
  }
  if (!password || password.length < 6) {
    showStatus('error', 'Пароль: минимум 6 символов.');
    return;
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showStatus('error', 'Укажите корректный e-mail.');
    return;
  }
  if (!capturedRfidCardId) {
    showStatus('error', 'Приложите RFID-карту к считывателю.');
    return;
  }

  isRunning = true;
  btnRegisterFull.disabled = true;
  showStatus('info', 'Сохранение на сервер (MySQL)…');
  setFaceBox('Запись карточки сотрудника…', 'info');

  try {
    const reg = await SurvAPI.registerEmployee({
      name,
      login,
      password,
      email,
      schedule,
      rate,
      role,
      rfidCardId: capturedRfidCardId,
      workStartTime
    });
    const employeeId = reg.employeeId;
    const labelStr = String(employeeId);
    localStorage.setItem('surv_last_employee_id', labelStr);

    diagLog('POST /register → id=' + employeeId);
    showStatus('success', `Карточка в БД. employeeId = ${employeeId}. Обучение лица…`);

    setFaceBox('Смотрите в камеру — обучение KNN…', 'info');
    await trainExamplesForLabel(labelStr);

    setFaceBox('Сохранение признаков лица на сервер…', 'info');
    await saveKnnToServer();

    showStatus(
      'success',
      `Готово. Сотрудник №${employeeId} и лицо в MySQL на сервере. Откройте «Вход» и введите id ${employeeId}.`
    );
    setFaceBox('Регистрация завершена.', 'ok');
  } catch (e) {
    console.error(e);
    diagLog('registerFull error', e);
    const msg =
      e && e.message
        ? e.message
        : String(e);
    showStatus(
      'error',
      msg +
        (String(msg).toLowerCase().includes('mysql') || String(msg).toLowerCase().includes('connect')
          ? ' Проверьте, что MySQL запущен и сервер node запущен без ошибок БД.'
          : '')
    );
    setFaceBox(msg, 'error');
  } finally {
    isRunning = false;
    btnRegisterFull.disabled = false;
  }
}

btnRegisterFull.addEventListener('click', registerFull);

document.getElementById('btnCopyDiag')?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(diagLines.join('\n'));
  } catch (e) {
    diagLog('clip', e);
  }
});

async function main() {
  if (location.protocol === 'file:') {
    modelsStatus.textContent = 'ошибка';
    showStatus('error', 'Откройте http://localhost:3000/register.html');
    return;
  }
  if (!window.SurvAPI) {
    showStatus('error', 'Подключите surv-api.js перед register.js');
    return;
  }

  try {
    if (typeof knnClassifier === 'undefined' || !knnClassifier.create) {
      throw new Error('knn-classifier не загрузился');
    }
    classifier = knnClassifier.create();

    const camPromise = setupWebcam().catch((err) => {
      diagLog('камера', err);
      setFaceBox('Камера: ' + (err && err.message ? err.message : String(err)), 'error');
    });

    await initTfBackend();
    await setupModels();
    await camPromise;

    await tryLoadDatasetFromServer();

    updateDatasetStatus();
    btnRegisterFull.disabled = false;
    setupRfidCapture();
    diagLog('Готово: TF + камера + MySQL API');
  } catch (e) {
    console.error(e);
    diagLog('main', e);
    modelsStatus.textContent = 'ошибка';
    showStatus('error', e && e.message ? e.message : String(e));
  }
}

function updateRfidStatusUi() {
  if (!rfidStatusEl) return;
  if (capturedRfidCardId) {
    rfidStatusEl.textContent = 'Пропуск: считан и будет привязан к сотруднику';
    rfidStatusEl.style.color = '#86efac';
  } else {
    rfidStatusEl.textContent = 'Пропуск: не считан — кликните в поле и приложите карту';
    rfidStatusEl.style.color = '#fbbf24';
  }
}

function setupRfidCapture() {
  if (!window.SurvRfid || !rfidCaptureInput) return;
  rfidReader = SurvRfid.create({
    onScan: function (cardId) {
      capturedRfidCardId = cardId;
      rfidCaptureInput.value = '';
      updateRfidStatusUi();
      diagLog('RFID: пропуск считан (регистрация)');
    }
  });
  rfidReader.attach(rfidCaptureInput);
  rfidCaptureInput.addEventListener('focus', function () {
    rfidReader.focus();
  });
  if (roleSelect) {
    roleSelect.addEventListener('change', updateRfidStatusUi);
  }
  updateRfidStatusUi();
}

window.addEventListener('DOMContentLoaded', main);
