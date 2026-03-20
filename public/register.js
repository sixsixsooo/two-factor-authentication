/* global tf, mobilenet, knnClassifier, SurvLocalDB */

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

function getActivation() {
  return tf.tidy(() => {
    const img = tf.browser.fromPixels(webcam);
    return net.infer(img, 'conv_preds');
  });
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

async function tryLoadDatasetFromIndexedDB() {
  if (!window.SurvLocalDB) return false;
  try {
    const ds = await SurvLocalDB.loadKnnDataset();
    if (!ds || typeof ds !== 'object' || Object.keys(ds).length === 0) return false;
    await importDatasetFromJsonObject(ds);
    diagLog('KNN загружен из IndexedDB (локально)');
    return true;
  } catch (e) {
    diagLog('IndexedDB load', e);
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

async function saveKnnToIndexedDB() {
  if (!classifier || classifier.getNumExamples() === 0) {
    throw new Error('Нет данных KNN для сохранения');
  }
  if (!window.SurvLocalDB) {
    throw new Error('SurvLocalDB не загружен (local-db.js)');
  }
  const obj = await buildKnnExportObject();
  await SurvLocalDB.saveKnnDataset(obj);
  diagLog('KNN сохранён в IndexedDB (локально на этом ПК)');
}

async function trainExamplesForLabel(labelStr) {
  for (let i = 0; i < TRAIN_STEPS; i++) {
    const activation = getActivation();
    classifier.addExample(activation, labelStr);
    activation.dispose();
    if (i % 5 === 0) {
      setFaceBox(`Обучение лица: ${i + 1}/${TRAIN_STEPS}`, 'info');
      predictionStatus.textContent = 'кадры: ' + (i + 1) + '/' + TRAIN_STEPS;
    }
    await new Promise((r) => setTimeout(r, TRAIN_EVERY_MS));
  }
  updateDatasetStatus();
  predictionStatus.textContent = 'обучение: готово';
  predictionStatus.className = 'tag ok';
}

/**
 * Карточка сотрудника + KNN только в IndexedDB (без API сервера).
 */
async function registerFull() {
  if (isRunning || !net || !classifier) return;

  if (!window.SurvLocalDB) {
    showStatus('error', 'Не загружен local-db.js');
    return;
  }

  const name = document.getElementById('name').value.trim();
  const schedule = document.getElementById('schedule').value;
  const rate = parseFloat(document.getElementById('rate').value);
  if (!name || !schedule || Number.isNaN(rate) || rate < 0) {
    showStatus('error', 'Заполните имя, график и ставку (число ≥ 0).');
    return;
  }

  isRunning = true;
  btnRegisterFull.disabled = true;
  showStatus('info', 'Сохранение в локальную базу (IndexedDB)…');
  setFaceBox('Запись карточки сотрудника…', 'info');

  try {
    const employeeId = await SurvLocalDB.addEmployee({ name, schedule, rate });
    const labelStr = String(employeeId);
    localStorage.setItem('surv_last_employee_id', labelStr);

    diagLog('IndexedDB addEmployee → id=' + employeeId);
    showStatus('success', `Карточка сохранена локально. employeeId = ${employeeId}. Обучение лица…`);

    setFaceBox('Смотрите в камеру — обучение KNN…', 'info');
    await trainExamplesForLabel(labelStr);

    setFaceBox('Сохранение признаков лица в IndexedDB…', 'info');
    await saveKnnToIndexedDB();

    showStatus(
      'success',
      `Готово. Сотрудник №${employeeId} и лицо сохранены на этом компьютере (IndexedDB). Откройте «Вход» и введите тот же id.`
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
        (String(msg).toLowerCase().includes('indexeddb') || String(msg).toLowerCase().includes('quota')
          ? ' Попробуйте другой браузер или отключите режим инкогнито.'
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
  if (!window.SurvLocalDB) {
    showStatus('error', 'Подключите local-db.js перед register.js');
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

    await tryLoadDatasetFromIndexedDB();

    updateDatasetStatus();
    btnRegisterFull.disabled = false;
    diagLog('Готово: TF + камера + IndexedDB');
  } catch (e) {
    console.error(e);
    diagLog('main', e);
    modelsStatus.textContent = 'ошибка';
    showStatus('error', e && e.message ? e.message : String(e));
  }
}

window.addEventListener('DOMContentLoaded', main);
