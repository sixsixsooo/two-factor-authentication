const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const ExcelJS = require('exceljs');
const { db, logEvent } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// Метка версии (в консоли видно, что запущен сервер без лимитов)
const SERVER_VERSION = 'SURV v2 (лимиты отключены)';

// Координаты офиса
const OFFICE_LAT = 47.212;
const OFFICE_LON = 38.9087;
const MAX_DISTANCE_METERS = 50;

// Лимиты на попытки входа отключены (не используются).

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// Ответы API не кэшировать (чтобы не показывался старый 429)
app.use('/login', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

// Веса face-api: отдавать shard-файлы без расширения как binary
app.use('/weights', (req, res, next) => {
  if (!req.path.endsWith('.json') && req.path.length > 0) {
    res.setHeader('Content-Type', 'application/octet-stream');
  }
  next();
}, express.static(path.join(__dirname, 'public', 'weights')));

app.use(express.static(path.join(__dirname, 'public')));

// Проверка: если видишь rateLimit: false — запущена актуальная версия без лимитов
app.get('/api/status', (req, res) => {
  res.json({ rateLimit: false, ok: true });
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

function euclideanDistance(desc1, desc2) {
  if (desc1.length !== desc2.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < desc1.length; i++) {
    const diff = desc1[i] - desc2[i];
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

// Простая сессионная модель (в памяти)
const activeSessions = new Map(); // employeeId -> sessionId

app.post('/register', (req, res) => {
  const { name, schedule, rate, faceDescriptor } = req.body;
  if (!name || !schedule || !rate || !faceDescriptor) {
    return res.status(400).json({ error: 'Не все поля заполнены' });
  }

  const descriptorString = JSON.stringify(faceDescriptor);

  db.run(
    'INSERT INTO employees (name, face_descriptor, rate, schedule) VALUES (?, ?, ?, ?)',
    [name, descriptorString, rate, schedule],
    function (err) {
      if (err) {
        logEvent('error', `Register error: ${err.message}`);
        return res.status(500).json({ error: 'Ошибка сервера' });
      }
      logEvent('info', `Registered employee ${name} (id=${this.lastID})`);
      res.json({ success: true, employeeId: this.lastID });
    }
  );
});

app.post('/login', (req, res) => {
  const { faceDescriptor, latitude, longitude } = req.body;
  if (!faceDescriptor || typeof latitude !== 'number' || typeof longitude !== 'number') {
    return res.status(400).json({ error: 'Нет данных лица или GPS' });
  }

  const distance = haversineDistance(latitude, longitude, OFFICE_LAT, OFFICE_LON);
  if (distance > MAX_DISTANCE_METERS) {
    logEvent('security', `GPS too far: ${distance.toFixed(2)}m`);
    return res.status(403).json({ error: 'Вы слишком далеко от офиса' });
  }

  db.all('SELECT * FROM employees', [], (err, rows) => {
    if (err) {
      logEvent('error', `DB error on login: ${err.message}`);
      return res.status(500).json({ error: 'Ошибка сервера' });
    }

    if (!rows || rows.length === 0) {
      return res.status(404).json({ error: 'Нет зарегистрированных сотрудников' });
    }

    const inputDesc = faceDescriptor;
    let bestMatch = null;
    let bestDistance = Infinity;

    for (const row of rows) {
      let storedDesc;
      try {
        storedDesc = JSON.parse(row.face_descriptor);
      } catch (e) {
        continue;
      }
      const dist = euclideanDistance(inputDesc, storedDesc);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestMatch = row;
      }
    }

    if (!bestMatch || bestDistance > 0.6) {
      logEvent('security', `Face not recognized, minDist=${bestDistance}`);
      return res.status(401).json({ error: 'Лицо не распознано' });
    }

    const employeeId = bestMatch.id;
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
          employeeId,
          sessionId: this.lastID,
          name: bestMatch.name
        });
      }
    );
  });
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

app.listen(PORT, () => {
  console.log(`${SERVER_VERSION}`);
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});

