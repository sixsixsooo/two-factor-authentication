const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const ExcelJS = require('exceljs');
const { db, dbPath, logEvent } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Метка версии (в консоли видно, что запущен сервер без лимитов)
const SERVER_VERSION = 'SURV v3 (БД: проверка INSERT + /api/status с dbPath)';

// Координаты офиса
const OFFICE_LAT = 47.213702;
const OFFICE_LON = 38.851113;
const MAX_DISTANCE_METERS = 50;

// Лимиты на попытки входа отключены (не используются).

// CSP отключён: TensorFlow.js тянет веса с разных хостов + wasm/web workers; строгий CSP ломает загрузку.
// Cross-Origin-Resource-Policy: same-origin у Helmet по умолчанию иногда мешает сторонним скриптам/ресурсам.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false
  })
);
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(morgan('dev'));

// Не кэшировать API и формы — иначе браузер может отдать старый 404 для GET /api/employee/:id
app.use((req, res, next) => {
  const p = req.path || '';
  if (
    p.startsWith('/api') ||
    p === '/register' ||
    p === '/login' ||
    p === '/logout' ||
    p === '/logs'
  ) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

// Ответы API не кэшировать (чтобы не показывался старый 429)
app.use('/login', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// Статику подключаем ПОСЛЕ API — иначе запросы вида GET /api/employee/7 могут некорректно обрабатываться
// Проверка: если видишь rateLimit: false — запущена актуальная версия без лимитов
app.get('/api/status', (req, res) => {
  db.get('SELECT COUNT(*) AS c FROM employees', [], (err, row) => {
    const count = err ? -1 : Number(row && row.c);
    res.json({
      ok: true,
      rateLimit: false,
      version: SERVER_VERSION,
      dbPath,
      employeeCount: count,
      dbError: err ? err.message : null,
      hint: 'Если employeeCount не растёт после регистрации — смотрите dbPath (один файл на весь сервер).'
    });
  });
});

// Короткий алиас: список сотрудников (тот же ответ, что /api/debug/employees)
app.get('/api/employees', (req, res) => {
  db.all('SELECT id, name, rate, schedule FROM employees ORDER BY id', [], (err, rows) => {
    if (err) {
      console.error('[SURV] GET /api/employees:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({
      dbPath,
      count: rows ? rows.length : 0,
      employees: rows || []
    });
  });
});

// Логи с клиента (браузер) — смотрите консоль сервера и таблицу logs
app.post('/api/client-log', (req, res) => {
  try {
    const body = req.body || {};
    const line =
      typeof body.line === 'string'
        ? body.line
        : typeof body.message === 'string'
          ? body.message
          : JSON.stringify(body).slice(0, 2000);
    const ua = req.headers['user-agent'] || '';
    const msg = `[client] ${line} | ua=${ua.slice(0, 120)}`;
    console.log(msg);
    logEvent('info', msg.slice(0, 900));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// База признаков KNN (JSON) — хранится в SQLite, подгружается на странице входа
app.get('/api/knn-dataset', (req, res) => {
  db.get('SELECT payload, updated_at FROM knn_dataset WHERE id = 1', [], (err, row) => {
    if (err) {
      return res.status(500).json({ error: 'Ошибка сервера' });
    }
    if (!row || !row.payload) {
      return res.json({ dataset: null, updatedAt: null });
    }
    try {
      const dataset = JSON.parse(row.payload);
      res.json({ dataset, updatedAt: row.updated_at });
    } catch (e) {
      res.status(500).json({ error: 'Ошибка данных в knn_dataset' });
    }
  });
});

app.post('/api/knn-dataset', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Нет JSON' });
  }
  let payload = body.dataset;
  if (payload === undefined) {
    payload = body;
  }
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Нет поля dataset' });
  }
  const json = JSON.stringify(payload);
  const now = new Date().toISOString();
  db.run(
    'INSERT OR REPLACE INTO knn_dataset (id, payload, updated_at) VALUES (1, ?, ?)',
    [json, now],
    function (err) {
      if (err) {
        console.error('[SURV] POST /api/knn-dataset error:', err.message);
        logEvent('error', `knn_dataset save: ${err.message}`);
        return res.status(500).json({ error: 'Ошибка сохранения' });
      }
      console.log('[SURV] POST /api/knn-dataset OK, размер JSON ~' + json.length + ' байт');
      logEvent('info', 'knn_dataset обновлён');
      res.json({ success: true, updatedAt: now });
    }
  );
});

// Текущая активная смена сотрудника (для главной страницы)
app.get('/api/session/current', (req, res) => {
  const employeeId = parseInt(req.query.employeeId, 10);
  if (!employeeId) {
    return res.status(400).json({ error: 'Нет employeeId' });
  }
  const sessionId = activeSessions.get(employeeId);
  if (!sessionId) {
    return res.status(404).json({ error: 'Нет активной смены' });
  }
  db.get(
    `SELECT s.start_time, e.rate, e.name FROM sessions s
     JOIN employees e ON e.id = s.employee_id
     WHERE s.id = ? AND s.end_time IS NULL`,
    [sessionId],
    (err, row) => {
      if (err || !row) {
        activeSessions.delete(employeeId);
        return res.status(404).json({ error: 'Нет активной смены' });
      }
      const now = Date.now();
      const startMs = new Date(row.start_time).getTime();
      const hoursSoFar = Math.floor((now - startMs) / (1000 * 60 * 60));
      const salarySoFar = hoursSoFar * row.rate;
      res.json({
        name: row.name,
        startTime: row.start_time,
        rate: row.rate,
        hoursSoFar,
        salarySoFar
      });
    }
  );
});

// Сводка по сотруднику: общее время и зарплата за все закрытые смены
app.get('/api/me/summary', (req, res) => {
  const employeeId = parseInt(req.query.employeeId, 10);
  if (!employeeId) {
    return res.status(400).json({ error: 'Нет employeeId' });
  }
  db.get(
    'SELECT name, rate FROM employees WHERE id = ?',
    [employeeId],
    (err, emp) => {
      if (err || !emp) {
        return res.status(404).json({ error: 'Сотрудник не найден' });
      }
      db.all(
        'SELECT start_time, end_time FROM sessions WHERE employee_id = ? AND end_time IS NOT NULL',
        [employeeId],
        (err2, sessions) => {
          if (err2) {
            return res.status(500).json({ error: 'Ошибка сервера' });
          }
          const list = sessions || [];
          let totalHours = 0;
          for (const s of list) {
            const ms = new Date(s.end_time).getTime() - new Date(s.start_time).getTime();
            if (ms > 0) totalHours += Math.floor(ms / (1000 * 60 * 60));
          }
          const totalSalary = totalHours * emp.rate;
          res.json({
            name: emp.name,
            rate: emp.rate,
            sessionsCount: list.length,
            totalHours,
            totalSalary
          });
        }
      );
    }
  );
});

function haversineDistance(lat1, lon1, lat2, lon2) {
  function toRad(x) {
    return (x * Math.PI) / 180;
  }

  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Простая сессионная модель (в памяти)
const activeSessions = new Map(); // employeeId -> sessionId

// Проверка, что сотрудник есть в БД (для страницы входа)
app.get('/api/employee/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || Number.isNaN(id)) {
    return res.status(400).json({ error: 'Неверный employeeId' });
  }
  db.get('SELECT id, name FROM employees WHERE id = ?', [id], (err, row) => {
    if (err) {
      console.error('[SURV] GET /api/employee/' + id + ' DB error:', err.message);
      logEvent('error', `GET /api/employee: ${err.message}`);
      return res.status(500).json({ error: 'Ошибка сервера' });
    }
    if (!row) {
      console.log('[SURV] GET /api/employee/' + id + ' → не найден (в БД нет строки)');
      return res.status(404).json({ exists: false, error: 'Сотрудник не найден' });
    }
    console.log('[SURV] GET /api/employee/' + id + ' → OK, имя:', row.name);
    res.json({ exists: true, id: row.id, name: row.name });
  });
});

// Диагностика: список сотрудников в текущем surv.db (для отладки «не вижу в базе»)
app.get('/api/debug/employees', (req, res) => {
  db.all('SELECT id, name, rate, schedule FROM employees ORDER BY id', [], (err, rows) => {
    if (err) {
      console.error('[SURV] debug/employees:', err.message);
      return res.status(500).json({ error: err.message });
    }
    res.json({
      dbPath,
      dbHint: 'Тот же путь, что в консоли при старте и в GET /api/status',
      count: rows ? rows.length : 0,
      employees: rows || []
    });
  });
});

app.post('/register', (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const schedule = body.schedule;
  const rateNum = body.rate === undefined || body.rate === null ? NaN : Number(body.rate);

  if (!name || !schedule || Number.isNaN(rateNum) || rateNum < 0) {
    console.log('[SURV] POST /register отклонён: невалидные поля', {
      hasName: !!name,
      schedule,
      rateNum
    });
    return res.status(400).json({ error: 'Не все поля заполнены' });
  }

  db.run(
    'INSERT INTO employees (name, face_descriptor, rate, schedule) VALUES (?, ?, ?, ?)',
    [name, '[]', rateNum, String(schedule)],
    function (err) {
      if (err) {
        console.error('[SURV] POST /register INSERT error:', err.message);
        logEvent('error', `Register error: ${err.message}`);
        return res.status(500).json({ error: 'Ошибка сервера' });
      }
      const newId = this.lastID;
      // Сразу читаем строку из того же файла — если SELECT пустой, клиенту не отдаём «успех»
      db.get('SELECT id, name, rate, schedule FROM employees WHERE id = ?', [newId], (err2, row) => {
        if (err2) {
          console.error('[SURV] POST /register VERIFY error:', err2.message);
          return res.status(500).json({ error: 'Запись не подтверждена в БД' });
        }
        if (!row) {
          console.error('[SURV] POST /register VERIFY: строка id=' + newId + ' не найдена после INSERT');
          return res.status(500).json({ error: 'Сотрудник не сохранился в SQLite (проверьте dbPath в /api/status)' });
        }
        console.log('[SURV] POST /register OK + VERIFY → employeeId=' + newId + ', имя=' + row.name);
        logEvent('info', `Registered employee ${name} (id=${newId})`);
        res.json({ success: true, employeeId: newId, name: row.name, dbPath });
      });
    }
  );
});

app.post('/login', (req, res) => {
  const { employeeId, latitude, longitude } = req.body;
  if (!employeeId || typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'Нет employeeId или GPS' });
  }

  const distance = haversineDistance(latitude, longitude, OFFICE_LAT, OFFICE_LON);
  if (distance > MAX_DISTANCE_METERS) {
    logEvent('security', `GPS too far: ${distance.toFixed(2)}m`);
    return res.status(403).json({ error: 'Вы слишком далеко от офиса' });
  }

  db.get(
    'SELECT id, name FROM employees WHERE id = ?',
    [employeeId],
    (err, emp) => {
      if (err) {
        logEvent('error', `DB error on login: ${err.message}`);
        return res.status(500).json({ error: 'Ошибка сервера' });
      }
      if (!emp) {
        return res.status(404).json({ error: 'Сотрудник не найден' });
      }

      const now = new Date().toISOString();

      const existingSessionId = activeSessions.get(employeeId);
      if (existingSessionId) {
        db.get(
          'SELECT * FROM sessions WHERE id = ?',
          [existingSessionId],
          (err2, sessionRow) => {
            if (err2 || !sessionRow || sessionRow.end_time) {
              activeSessions.delete(employeeId);
            }
          }
        );
      }

      db.run(
        'INSERT INTO sessions (employee_id, start_time, latitude, longitude) VALUES (?, ?, ?, ?)',
        [employeeId, now, latitude, longitude],
        function (err3) {
          if (err3) {
            logEvent('error', `Error creating session: ${err3.message}`);
            return res.status(500).json({ error: 'Ошибка сервера' });
          }
          activeSessions.set(employeeId, this.lastID);
          logEvent('info', `Login employee ${employeeId}, session ${this.lastID}`);
          res.json({
            success: true,
            employeeId: emp.id,
            sessionId: this.lastID,
            name: emp.name
          });
        }
      );
    }
  );
});

app.post('/logout', (req, res) => {
  const { employeeId } = req.body;
  if (!employeeId) {
    return res.status(400).json({ error: 'Нет employeeId' });
  }

  const sessionId = activeSessions.get(employeeId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Нет активной сессии' });
  }

  const now = new Date().toISOString();
  db.run(
    'UPDATE sessions SET end_time = ? WHERE id = ?',
    [now, sessionId],
    function (err) {
      if (err) {
        logEvent('error', `Logout error: ${err.message}`);
        return res.status(500).json({ error: 'Ошибка сервера' });
      }
      activeSessions.delete(employeeId);
      logEvent('info', `Logout employee ${employeeId}, session ${sessionId}`);
      res.json({ success: true });
    }
  );
});

function calculateHoursRoundedDown(startIso, endIso) {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const ms = end - start;
  if (ms <= 0) return 0;
  const hours = ms / (1000 * 60 * 60);
  return Math.floor(hours);
}

app.get('/salary', (req, res) => {
  const { from, to } = req.query;
  const fromDate = from || '1970-01-01T00:00:00.000Z';
  const toDate = to || new Date().toISOString();

  const sql = `
    SELECT e.id as employee_id, e.name, e.rate, e.schedule,
           s.start_time, s.end_time
    FROM employees e
    LEFT JOIN sessions s ON e.id = s.employee_id
    WHERE s.start_time IS NOT NULL
      AND s.end_time IS NOT NULL
      AND s.start_time >= ?
      AND s.end_time <= ?
  `;

  db.all(sql, [fromDate, toDate], (err, rows) => {
    if (err) {
      logEvent('error', `Salary error: ${err.message}`);
      return res.status(500).json({ error: 'Ошибка сервера' });
    }

    const resultMap = new Map();

    for (const row of rows) {
      const key = row.employee_id;
      const current = resultMap.get(key) || {
        employeeId: row.employee_id,
        name: row.name,
        rate: row.rate,
        schedule: row.schedule,
        hours: 0
      };

      const h = calculateHoursRoundedDown(row.start_time, row.end_time);
      current.hours += h;
      resultMap.set(key, current);
    }

    const result = Array.from(resultMap.values()).map((item) => ({
      ...item,
      salary: item.hours * item.rate
    }));

    res.json({ data: result });
  });
});

app.get('/salary/excel', async (req, res) => {
  const { from, to } = req.query;

  const fromDate = from || '1970-01-01T00:00:00.000Z';
  const toDate = to || new Date().toISOString();

  const sql = `
    SELECT e.id as employee_id, e.name, e.rate, e.schedule,
           s.start_time, s.end_time
    FROM employees e
    LEFT JOIN sessions s ON e.id = s.employee_id
    WHERE s.start_time IS NOT NULL
      AND s.end_time IS NOT NULL
      AND s.start_time >= ?
      AND s.end_time <= ?
  `;

  db.all(sql, [fromDate, toDate], async (err, rows) => {
    if (err) {
      logEvent('error', `Salary excel error: ${err.message}`);
      return res.status(500).json({ error: 'Ошибка сервера' });
    }

    const resultMap = new Map();

    for (const row of rows) {
      const key = row.employee_id;
      const current = resultMap.get(key) || {
        employeeId: row.employee_id,
        name: row.name,
        rate: row.rate,
        schedule: row.schedule,
        hours: 0
      };

      const h = calculateHoursRoundedDown(row.start_time, row.end_time);
      current.hours += h;
      resultMap.set(key, current);
    }

    const result = Array.from(resultMap.values()).map((item) => ({
      ...item,
      salary: item.hours * item.rate
    }));

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Табель');

    sheet.columns = [
      { header: 'ID', key: 'employeeId', width: 10 },
      { header: 'Имя', key: 'name', width: 25 },
      { header: 'График', key: 'schedule', width: 10 },
      { header: 'Ставка', key: 'rate', width: 10 },
      { header: 'Часы', key: 'hours', width: 10 },
      { header: 'Зарплата', key: 'salary', width: 15 }
    ];

    result.forEach((row) => sheet.addRow(row));

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="tabel.xlsx"'
    );

    await workbook.xlsx.write(res);
    res.end();
  });
});

app.get('/logs', (req, res) => {
  db.all(
    'SELECT * FROM logs ORDER BY timestamp DESC LIMIT 200',
    [],
    (err, rows) => {
      if (err) {
        logEvent('error', `Logs read error: ${err.message}`);
        return res.status(500).json({ error: 'Ошибка сервера' });
      }
      res.json({ logs: rows });
    }
  );
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`${SERVER_VERSION}`);
  console.log(`Сервер запущен на http://localhost:${PORT}`);
  console.log('[SURV] Диагностика БД: GET http://localhost:' + PORT + '/api/debug/employees');
});

