const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');
const ExcelJS = require('exceljs');
const { initDatabase, getPool, logEvent, logAccessEvent, dbInfo } = require('./db');
const { registerAccountantRoutes, normalizeRfid } = require('./lib/routes-accountant');
const {
  normalizeLogin,
  normalizeEmail,
  hashPassword,
  createPasswordLoginRequest,
  getPasswordLoginRequest,
  consumeApprovedRequest
} = require('./lib/password-login');

const app = express();
const PORT = process.env.PORT || 3000;

const SERVER_VERSION = 'SURV v7 (лицо+RFID, вход по паролю с подтверждением бухгалтера)';

const activeSessions = new Map();

async function startEmployeeSession(pool, employeeId, accessMethod, rfidCardId) {
  const existingSessionId = activeSessions.get(employeeId);
  if (existingSessionId) {
    const [sess] = await pool.query('SELECT * FROM sessions WHERE id = ?', [existingSessionId]);
    if (!sess.length || sess[0].end_time) {
      activeSessions.delete(employeeId);
    }
  }
  const now = new Date();
  const [result] = await pool.execute(
    `INSERT INTO sessions (employee_id, start_time, latitude, longitude, rfid_card_id, access_method)
     VALUES (?, ?, NULL, NULL, ?, ?)`,
    [employeeId, now, rfidCardId || null, accessMethod]
  );
  activeSessions.set(employeeId, result.insertId);
  return result.insertId;
}

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: false
  })
);
app.use(cors());
app.use(express.json({ limit: '12mb' }));
app.use(morgan('dev'));

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

app.use('/login', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

app.get('/api/status', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query('SELECT COUNT(*) AS c FROM employees');
    const count = Number(rows[0].c);
    res.json({
      ok: true,
      rateLimit: false,
      version: SERVER_VERSION,
      db: dbInfo,
      employeeCount: count,
      hint: 'Сотрудники и KNN хранятся в MySQL на сервере.'
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      version: SERVER_VERSION,
      db: dbInfo,
      dbError: err.message
    });
  }
});

app.get('/api/employees', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT id, name, rate, schedule FROM employees ORDER BY id'
    );
    res.json({ db: dbInfo, count: rows.length, employees: rows });
  } catch (err) {
    console.error('[SURV] GET /api/employees:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/client-log', async (req, res) => {
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
    await logEvent('info', msg.slice(0, 900));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

app.get('/api/knn-dataset', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT payload, updated_at FROM knn_dataset WHERE id = 1 LIMIT 1'
    );
    if (!rows.length || !rows[0].payload) {
      return res.json({ dataset: null, updatedAt: null });
    }
    const dataset = JSON.parse(rows[0].payload);
    res.json({
      dataset,
      updatedAt: rows[0].updated_at ? new Date(rows[0].updated_at).toISOString() : null
    });
  } catch (err) {
    console.error('[SURV] GET /api/knn-dataset:', err.message);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/knn-dataset', async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Нет JSON' });
  }
  let payload = body.dataset;
  if (payload === undefined) payload = body;
  if (!payload || typeof payload !== 'object') {
    return res.status(400).json({ error: 'Нет поля dataset' });
  }

  const json = JSON.stringify(payload);
  const now = new Date();

  try {
    const pool = getPool();
    await pool.execute(
      `INSERT INTO knn_dataset (id, payload, updated_at) VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE payload = VALUES(payload), updated_at = VALUES(updated_at)`,
      [json, now]
    );
    console.log('[SURV] POST /api/knn-dataset OK, ~' + json.length + ' байт');
    await logEvent('info', 'knn_dataset обновлён');
    res.json({ success: true, updatedAt: now.toISOString() });
  } catch (err) {
    console.error('[SURV] POST /api/knn-dataset:', err.message);
    await logEvent('error', `knn_dataset save: ${err.message}`);
    res.status(500).json({ error: 'Ошибка сохранения' });
  }
});

app.get('/api/session/current', async (req, res) => {
  const employeeId = parseInt(req.query.employeeId, 10);
  if (!employeeId) {
    return res.status(400).json({ error: 'Нет employeeId' });
  }

  const sessionId = activeSessions.get(employeeId);
  if (!sessionId) {
    return res.status(404).json({ error: 'Нет активной смены' });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT s.start_time, e.rate, e.name FROM sessions s
       JOIN employees e ON e.id = s.employee_id
       WHERE s.id = ? AND s.end_time IS NULL`,
      [sessionId]
    );
    if (!rows.length) {
      activeSessions.delete(employeeId);
      return res.status(404).json({ error: 'Нет активной смены' });
    }
    const row = rows[0];
    const startMs = new Date(row.start_time).getTime();
    const hoursSoFar = Math.floor((Date.now() - startMs) / (1000 * 60 * 60));
    res.json({
      name: row.name,
      startTime: new Date(row.start_time).toISOString(),
      rate: row.rate,
      hoursSoFar,
      salarySoFar: hoursSoFar * row.rate
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/me/summary', async (req, res) => {
  const employeeId = parseInt(req.query.employeeId, 10);
  if (!employeeId) {
    return res.status(400).json({ error: 'Нет employeeId' });
  }

  try {
    const pool = getPool();
    const [empRows] = await pool.query(
      'SELECT name, rate FROM employees WHERE id = ?',
      [employeeId]
    );
    if (!empRows.length) {
      return res.status(404).json({ error: 'Сотрудник не найден' });
    }
    const emp = empRows[0];

    const [sessions] = await pool.query(
      'SELECT start_time, end_time FROM sessions WHERE employee_id = ? AND end_time IS NOT NULL',
      [employeeId]
    );

    let totalHours = 0;
    for (const s of sessions) {
      const ms = new Date(s.end_time).getTime() - new Date(s.start_time).getTime();
      if (ms > 0) totalHours += Math.floor(ms / (1000 * 60 * 60));
    }

    res.json({
      name: emp.name,
      rate: emp.rate,
      sessionsCount: sessions.length,
      totalHours,
      totalSalary: totalHours * emp.rate
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
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
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

app.get('/api/me', async (req, res) => {
  const id = parseInt(req.query.employeeId, 10);
  if (!id) return res.status(400).json({ error: 'Нет employeeId' });
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, name, role, schedule, rate, rfid_card_id IS NOT NULL AS has_rfid,
              work_start_time, late_grace_minutes
       FROM employees WHERE id = ?`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Не найден' });
    const e = rows[0];
    res.json({
      id: e.id,
      name: e.name,
      role: e.role,
      schedule: e.schedule,
      rate: e.rate,
      hasRfid: !!e.has_rfid,
      workStartTime: e.work_start_time,
      lateGraceMinutes: e.late_grace_minutes
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/employee/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || Number.isNaN(id)) {
    return res.status(400).json({ error: 'Неверный employeeId' });
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query(
      `SELECT id, name, role, schedule, rate, rfid_card_id IS NOT NULL AS has_rfid,
              work_start_time, late_grace_minutes
       FROM employees WHERE id = ?`,
      [id]
    );
    if (!rows.length) {
      console.log('[SURV] GET /api/employee/' + id + ' → не найден');
      return res.status(404).json({ exists: false, error: 'Сотрудник не найден' });
    }
    const e = rows[0];
    console.log('[SURV] GET /api/employee/' + id + ' → OK');
    res.json({
      exists: true,
      id: e.id,
      name: e.name,
      role: e.role,
      schedule: e.schedule,
      rate: e.rate,
      hasRfid: !!e.has_rfid,
      requiresRfid: true,
      workStartTime: e.work_start_time,
      lateGraceMinutes: e.late_grace_minutes
    });
  } catch (err) {
    console.error('[SURV] GET /api/employee:', err.message);
    await logEvent('error', `GET /api/employee: ${err.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.get('/api/debug/employees', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT id, name, rate, schedule FROM employees ORDER BY id'
    );
    res.json({
      db: dbInfo,
      count: rows.length,
      employees: rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/register', async (req, res) => {
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const schedule = body.schedule;
  const rateNum = body.rate === undefined || body.rate === null ? NaN : Number(body.rate);
  const role = body.role === 'accountant' ? 'accountant' : 'employee';
  const rfidCardId = body.rfidCardId ? normalizeRfid(body.rfidCardId) : null;
  const workStartTime = body.workStartTime || '09:00:00';
  const lateGrace = parseInt(body.lateGraceMinutes, 10);
  const lateGraceMinutes = Number.isNaN(lateGrace) ? 5 : Math.max(0, lateGrace);
  const login = normalizeLogin(body.login);
  const email = normalizeEmail(body.email);
  const password = body.password != null ? String(body.password) : '';

  if (!name || !schedule || Number.isNaN(rateNum) || rateNum < 0) {
    return res.status(400).json({ error: 'Не все поля заполнены' });
  }
  if (!rfidCardId) {
    return res.status(400).json({ error: 'Приложите RFID-карту при регистрации' });
  }
  if (!login || login.length < 3) {
    return res.status(400).json({ error: 'Логин: минимум 3 символа (латиница/цифры)' });
  }
  if (!/^[a-z0-9._-]+$/.test(login)) {
    return res.status(400).json({ error: 'Логин: только a-z, 0-9, точка, дефис, подчёркивание' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Пароль: минимум 6 символов' });
  }
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Укажите корректный e-mail' });
  }

  try {
    const pool = getPool();
    if (rfidCardId) {
      const [dup] = await pool.query('SELECT id FROM employees WHERE rfid_card_id = ?', [rfidCardId]);
      if (dup.length) {
        return res.status(409).json({ error: 'Эта карта уже привязана к другому сотруднику' });
      }
    }
    const [dupLogin] = await pool.query('SELECT id FROM employees WHERE login = ?', [login]);
    if (dupLogin.length) {
      return res.status(409).json({ error: 'Такой логин уже занят' });
    }

    const passwordHash = await hashPassword(password);

    const [result] = await pool.execute(
      `INSERT INTO employees (name, face_descriptor, rate, schedule, role, rfid_card_id, work_start_time, late_grace_minutes, login, password_hash, email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        '[]',
        rateNum,
        String(schedule),
        role,
        rfidCardId,
        workStartTime,
        lateGraceMinutes,
        login,
        passwordHash,
        email
      ]
    );
    const newId = result.insertId;

    const [rows] = await pool.query(
      'SELECT id, name, rate, schedule, role FROM employees WHERE id = ?',
      [newId]
    );
    if (!rows.length) {
      return res.status(500).json({ error: 'Сотрудник не сохранился в MySQL' });
    }

    await logAccessEvent(newId, 'register', rfidCardId, `Регистрация: ${name}, роль ${role}`);
    console.log('[SURV] POST /register OK → id=' + newId + ', role=' + role);
    await logEvent('info', `Registered ${role} ${name} (id=${newId})`);
    res.json({
      success: true,
      employeeId: newId,
      name: rows[0].name,
      role: rows[0].role,
      db: dbInfo
    });
  } catch (err) {
    console.error('[SURV] POST /register:', err.message);
    await logEvent('error', `Register error: ${err.message}`);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Карта уже используется' });
    }
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/login', async (req, res) => {
  const { employeeId, rfidCardId } = req.body;
  if (!employeeId) {
    return res.status(400).json({ error: 'Нет employeeId' });
  }

  try {
    const pool = getPool();
    const [empRows] = await pool.query(
      'SELECT id, name, role, rfid_card_id FROM employees WHERE id = ?',
      [employeeId]
    );
    if (!empRows.length) {
      return res.status(404).json({ error: 'Сотрудник не найден' });
    }
    const emp = empRows[0];
    const scanned = rfidCardId ? normalizeRfid(rfidCardId) : '';

    if (!emp.rfid_card_id) {
      return res.status(403).json({ error: 'К пропуску не привязана карта. Зарегистрируйте карту заново.' });
    }
    if (!scanned || scanned !== normalizeRfid(emp.rfid_card_id)) {
      await logAccessEvent(employeeId, 'login_fail_rfid', scanned, 'Неверная карта при входе');
      return res.status(403).json({ error: 'Неверная карта доступа' });
    }

    const sessionId = await startEmployeeSession(pool, employeeId, 'face_rfid', scanned);
    await logAccessEvent(employeeId, 'login_success', scanned, `Смена ${sessionId}`);
    await logEvent('info', `Login ${emp.role} ${employeeId}, session ${sessionId}`);
    res.json({
      success: true,
      employeeId: emp.id,
      sessionId,
      name: emp.name,
      role: emp.role
    });
  } catch (err) {
    await logEvent('error', `Error on login: ${err.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/auth/password-request', async (req, res) => {
  const { login, password } = req.body || {};
  try {
    const pool = getPool();
    const created = await createPasswordLoginRequest(pool, login, password);
    await logAccessEvent(
      created.employeeId,
      'password_login_request',
      null,
      `Запрос на вход по паролю #${created.requestId}`
    );
    res.json({
      requestId: created.requestId,
      employeeName: created.employeeName,
      status: 'pending',
      message: created.reused
        ? 'Запрос уже ожидает подтверждения бухгалтера.'
        : 'Запрос отправлен бухгалтеру. Дождитесь подтверждения.'
    });
  } catch (err) {
    const code = err.status || 500;
    if (code >= 500) console.error('[SURV] password-request:', err.message);
    res.status(code).json({ error: err.message || 'Ошибка сервера' });
  }
});

app.get('/api/auth/password-request/:id', async (req, res) => {
  try {
    const pool = getPool();
    const row = await getPasswordLoginRequest(pool, req.params.id);
    if (!row) {
      return res.status(404).json({ error: 'Запрос не найден' });
    }
    res.json({
      requestId: row.id,
      status: row.status,
      employeeId: row.employee_id,
      employeeName: row.name,
      role: row.role,
      email: row.email
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.post('/api/login/password-approved', async (req, res) => {
  const requestId = parseInt(req.body?.requestId, 10);
  if (!requestId) {
    return res.status(400).json({ error: 'Нет requestId' });
  }
  try {
    const pool = getPool();
    const row = await consumeApprovedRequest(pool, requestId);
    const sessionId = await startEmployeeSession(
      pool,
      row.employee_id,
      'password_accountant',
      null
    );
    await logAccessEvent(
      row.employee_id,
      'login_success',
      null,
      `Вход по паролю (запрос #${requestId}), смена ${sessionId}`
    );
    await logEvent('info', `Password login ${row.employee_id}, session ${sessionId}`);
    res.json({
      success: true,
      employeeId: row.employee_id,
      sessionId,
      name: row.name,
      role: row.role
    });
  } catch (err) {
    const code = err.status || 500;
    res.status(code).json({ error: err.message || 'Ошибка сервера' });
  }
});

app.post('/logout', async (req, res) => {
  const { employeeId } = req.body;
  if (!employeeId) {
    return res.status(400).json({ error: 'Нет employeeId' });
  }

  const sessionId = activeSessions.get(employeeId);
  if (!sessionId) {
    return res.status(400).json({ error: 'Нет активной сессии' });
  }

  try {
    const pool = getPool();
    await pool.execute('UPDATE sessions SET end_time = ? WHERE id = ?', [new Date(), sessionId]);
    activeSessions.delete(employeeId);
    await logEvent('info', `Logout employee ${employeeId}, session ${sessionId}`);
    res.json({ success: true });
  } catch (err) {
    await logEvent('error', `Logout error: ${err.message}`);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

function calculateHoursRoundedDown(startIso, endIso) {
  const ms = new Date(endIso) - new Date(startIso);
  if (ms <= 0) return 0;
  return Math.floor(ms / (1000 * 60 * 60));
}

registerAccountantRoutes(app);

app.get('/logs', async (req, res) => {
  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT * FROM logs ORDER BY timestamp DESC LIMIT 200'
    );
    res.json({ logs: rows });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

async function start() {
  await initDatabase();
  app.listen(PORT, () => {
    console.log(SERVER_VERSION);
    console.log(`Сервер запущен на http://localhost:${PORT}`);
    console.log(
      '[SURV] MySQL:',
      `${dbInfo.user}@${dbInfo.host}:${dbInfo.port}/${dbInfo.database}`
    );
    console.log('[SURV] Диагностика: GET http://localhost:' + PORT + '/api/debug/employees');
  });
}

start().catch((err) => {
  console.error('[SURV] Не удалось запустить сервер:', err.message);
  console.error(
    'Проверьте MySQL (служба запущена), пользователя test/1234 и CREATE DATABASE priv.'
  );
  process.exit(1);
});
