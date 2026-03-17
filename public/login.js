const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const cameraStatus = document.getElementById('cameraStatus');
const modelsStatus = document.getElementById('modelsStatus');
const faceStatus = document.getElementById('faceStatus');
const gpsStatus = document.getElementById('gpsStatus');
const gpsCoords = document.getElementById('gpsCoords');
const statusBox = document.getElementById('status');
const btnAction = document.getElementById('btnAction');
const modeSelect = document.getElementById('mode');

let modelsLoaded = false;
let stream = null;
let lastDescriptor = null;
let gps = { lat: null, lon: null };

function setStatus(el, text, type) {
  el.textContent = text;
  el.classList.remove('ok', 'bad');
  if (type === 'ok') el.classList.add('ok');
  if (type === 'bad') el.classList.add('bad');
}

function maybeEnableAction() {
  const isLogout = modeSelect.value === 'logout';
  if (isLogout) {
    btnAction.disabled = false;
  } else {
    btnAction.disabled = !(modelsLoaded && gps.lat !== null && lastDescriptor);
  }
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
    maybeEnableAction();
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

function startGps() {
  if (!navigator.geolocation) {
    setStatus(gpsStatus, 'GPS: не поддерживается', 'bad');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      gps.lat = pos.coords.latitude;
      gps.lon = pos.coords.longitude;
      setStatus(gpsStatus, 'GPS: ок', 'ok');
      gpsCoords.textContent = `lat=${gps.lat.toFixed(6)}, lon=${gps.lon.toFixed(6)}`;
      maybeEnableAction();
    },
    (err) => {
      console.error(err);
      setStatus(gpsStatus, 'GPS: отказано', 'bad');
      gpsCoords.textContent = 'Разрешите доступ к геолокации.';
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// Более мягкие настройки детектора: ниже порог уверенности и крупнее вход — сетка лица рисуется при небольших поворотах
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
      lastDescriptor = Array.from(detections.descriptor);
    } else {
      setStatus(faceStatus, 'лицо: нет', 'bad');
      lastDescriptor = null;
    }
    maybeEnableAction();
  }, 300);
}

window.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadModels(), startCamera()]);
  startGps();
  detectLoop();
});

modeSelect.addEventListener('change', () => {
  statusBox.style.display = 'none';
  maybeEnableAction();
});

// Формирует текст ошибки из ответа сервера; для 429 даёт подсказку
function getLoginErrorMessage(resp, data, fallback) {
  const code = resp.status;
  const serverMsg = (data && data.error) ? String(data.error).trim() : '';
  let msg = serverMsg || fallback || 'Ошибка входа';
  if (code === 429) {
    msg = 'Сервер вернул «слишком много попыток». Лимиты в приложении отключены. ' +
      'Перезапустите сервер (закройте все Node и снова запустите npm start) или проверьте прокси/кэш. ' +
      (serverMsg ? ' Ответ сервера: ' + serverMsg : '');
  } else if (serverMsg && code !== 200) {
    msg = msg + ' (код ' + code + ')';
  }
  return msg;
}

btnAction.addEventListener('click', async () => {
  const mode = modeSelect.value;
  statusBox.style.display = 'block';
  statusBox.className = 'status info';
  statusBox.textContent = 'Отправка...';
  btnAction.disabled = true;

  try {
    if (mode === 'login') {
      if (!lastDescriptor || gps.lat === null) {
        throw new Error('Нужны лицо в кадре и GPS');
      }
      const resp = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faceDescriptor: lastDescriptor,
          latitude: gps.lat,
          longitude: gps.lon
        }),
        cache: 'no-store'
      });
      let data;
      try {
        data = await resp.json();
      } catch (e) {
        throw new Error('Ответ сервера не JSON. Код: ' + resp.status + '. Перезапустите сервер.');
      }
      if (!resp.ok || !data.success) {
        throw new Error(getLoginErrorMessage(resp, data, 'Ошибка входа'));
      }
      localStorage.setItem('surv_employee_id', data.employeeId);
      statusBox.className = 'status success';
      statusBox.textContent = `Вход выполнен. Переход на главную...`;
      setTimeout(() => { window.location.href = '/dashboard.html'; }, 800);
    } else {
      const employeeId = parseInt(localStorage.getItem('surv_employee_id') || '0', 10);
      if (!employeeId) {
        throw new Error('Нет сохранённого сотрудника (выполните вход).');
      }
      const resp = await fetch('/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId }),
        cache: 'no-store'
      });
      let data;
      try {
        data = await resp.json();
      } catch (e) {
        throw new Error('Ответ сервера не JSON. Код: ' + resp.status);
      }
      if (!resp.ok || !data.success) {
        throw new Error(data.error || 'Ошибка выхода (код ' + resp.status + ')');
      }
      statusBox.className = 'status success';
      statusBox.textContent = 'Выход выполнен. Время смены зафиксировано.';
    }
  } catch (err) {
    statusBox.className = 'status error';
    statusBox.textContent = err && err.message ? err.message : String(err);
    console.error('Login action error:', err);
  } finally {
    btnAction.disabled = false;
  }
});

