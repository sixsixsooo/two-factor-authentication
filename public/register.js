const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const cameraStatus = document.getElementById('cameraStatus');
const modelsStatus = document.getElementById('modelsStatus');
const faceStatus = document.getElementById('faceStatus');
const statusBox = document.getElementById('status');
const btnRegister = document.getElementById('btnRegister');

let modelsLoaded = false;
let currentDescriptor = null;
let stream = null;

function setStatus(el, text, type) {
  el.textContent = text;
  el.classList.remove('ok', 'bad');
  if (type === 'ok') el.classList.add('ok');
  if (type === 'bad') el.classList.add('bad');
}

async function loadModels() {
  if (typeof faceapi === 'undefined') {
    setStatus(modelsStatus, 'ошибка: библиотека не загружена', 'bad');
    return;
  }
  const MODEL_URL = window.location.origin + '/weights';
  try {
    setStatus(modelsStatus, 'модели: загрузка…', null);
    await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    await faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
    await faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL);
    modelsLoaded = true;
    setStatus(modelsStatus, 'модели: загружены', 'ok');
    maybeEnableRegister();
  } catch (e) {
    const msg = (e && (e.message || e.toString())) || 'Неизвестная ошибка';
    setStatus(modelsStatus, 'ошибка загрузки моделей', 'bad');
    console.error('loadModels error:', e);
    if (statusBox) {
      statusBox.style.display = 'block';
      statusBox.className = 'status error';
      statusBox.textContent = 'Модели: ' + msg;
    }
  }
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    video.srcObject = stream;
    setStatus(cameraStatus, 'камера: ок', 'ok');
  } catch (e) {
    setStatus(cameraStatus, 'камера: ошибка', 'bad');
    console.error(e);
  }
}

function maybeEnableRegister() {
  btnRegister.disabled = !(modelsLoaded && currentDescriptor);
}

// Более мягкие настройки: ниже порог уверенности, крупнее вход — сетка лица стабильнее при поворотах
const FACE_DETECTOR_OPTIONS = new faceapi.TinyFaceDetectorOptions({
  scoreThreshold: 0.25,
  inputSize: 512
});

async function detectLoop() {
  const displaySize = { width: video.clientWidth, height: video.clientHeight };
  faceapi.matchDimensions(overlay, displaySize);

  setInterval(async () => {
    if (!modelsLoaded) return;
    if (video.readyState < 2) return;

    const detections = await faceapi
      .detectSingleFace(video, FACE_DETECTOR_OPTIONS)
      .withFaceLandmarks()
      .withFaceDescriptor();

    const ctx = overlay.getContext('2d');
    ctx.clearRect(0, 0, overlay.width, overlay.height);

    if (detections) {
      const resized = faceapi.resizeResults(detections, displaySize);
      faceapi.draw.drawDetections(overlay, resized);
      faceapi.draw.drawFaceLandmarks(overlay, resized);
      setStatus(faceStatus, 'лицо: найдено', 'ok');
      currentDescriptor = Array.from(detections.descriptor);
    } else {
      setStatus(faceStatus, 'лицо: нет', 'bad');
      currentDescriptor = null;
    }
    maybeEnableRegister();
  }, 300);
}

window.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadModels(), startCamera()]);
  detectLoop();
});

document.getElementById('registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!currentDescriptor) {
    statusBox.style.display = 'block';
    statusBox.className = 'status error';
    statusBox.textContent = 'Лицо не обнаружено. Подойдите ближе к камере.';
    return;
  }
  const name = document.getElementById('name').value.trim();
  const schedule = document.getElementById('schedule').value;
  const rate = parseFloat(document.getElementById('rate').value);

  btnRegister.disabled = true;
  statusBox.style.display = 'block';
  statusBox.className = 'status info';
  statusBox.textContent = 'Сохранение...';

  try {
    const resp = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, schedule, rate, faceDescriptor: currentDescriptor })
    });
    const data = await resp.json();
    if (!resp.ok || !data.success) {
      throw new Error(data.error || 'Ошибка регистрации');
    }
    statusBox.className = 'status success';
    statusBox.textContent = `Сотрудник сохранён (ID: ${data.employeeId})`;
  } catch (err) {
    statusBox.className = 'status error';
    statusBox.textContent = err.message;
  } finally {
    btnRegister.disabled = false;
  }
});

