const bcrypt = require('bcryptjs');

const REQUEST_TTL_MS = 15 * 60 * 1000;
const BCRYPT_ROUNDS = 10;

function normalizeLogin(login) {
  return String(login || '')
    .trim()
    .toLowerCase();
}

function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

async function hashPassword(plain) {
  return bcrypt.hash(String(plain), BCRYPT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(String(plain), hash);
}

async function expireStaleRequests(pool) {
  await pool.execute(
    `UPDATE login_approval_requests
     SET status = 'expired', resolved_at = NOW(3)
     WHERE status = 'pending' AND expires_at < NOW(3)`
  );
}

async function findEmployeeByLogin(pool, login) {
  const [rows] = await pool.query(
    'SELECT id, name, role, password_hash, email, login FROM employees WHERE login = ?',
    [login]
  );
  return rows[0] || null;
}

async function createPasswordLoginRequest(pool, login, password) {
  await expireStaleRequests(pool);
  const normLogin = normalizeLogin(login);
  if (!normLogin || !password) {
    const err = new Error('Введите логин и пароль');
    err.status = 400;
    throw err;
  }

  const emp = await findEmployeeByLogin(pool, normLogin);
  if (!emp) {
    const err = new Error('Неверный логин или пароль');
    err.status = 401;
    throw err;
  }
  if (!emp.password_hash) {
    const err = new Error('Для этого сотрудника не задан пароль. Обратитесь к администратору.');
    err.status = 403;
    throw err;
  }
  const ok = await verifyPassword(password, emp.password_hash);
  if (!ok) {
    const err = new Error('Неверный логин или пароль');
    err.status = 401;
    throw err;
  }

  const [pending] = await pool.query(
    `SELECT id FROM login_approval_requests
     WHERE employee_id = ? AND status = 'pending' AND expires_at > NOW(3)
     ORDER BY id DESC LIMIT 1`,
    [emp.id]
  );
  if (pending.length) {
    return { requestId: pending[0].id, employeeId: emp.id, employeeName: emp.name, reused: true };
  }

  const expiresAt = new Date(Date.now() + REQUEST_TTL_MS);
  const [result] = await pool.execute(
    `INSERT INTO login_approval_requests (employee_id, status, requested_at, expires_at)
     VALUES (?, 'pending', NOW(3), ?)`,
    [emp.id, expiresAt]
  );
  return {
    requestId: result.insertId,
    employeeId: emp.id,
    employeeName: emp.name,
    reused: false
  };
}

async function getPasswordLoginRequest(pool, requestId) {
  await expireStaleRequests(pool);
  const id = parseInt(requestId, 10);
  if (!id) return null;
  const [rows] = await pool.query(
    `SELECT r.id, r.employee_id, r.status, r.requested_at, r.expires_at, r.resolved_at,
            e.name, e.role, e.email
     FROM login_approval_requests r
     JOIN employees e ON e.id = r.employee_id
     WHERE r.id = ?`,
    [id]
  );
  return rows[0] || null;
}

async function listPendingLoginRequests(pool) {
  await expireStaleRequests(pool);
  const [rows] = await pool.query(
    `SELECT r.id, r.employee_id, r.requested_at, r.expires_at,
            e.name, e.email, e.login
     FROM login_approval_requests r
     JOIN employees e ON e.id = r.employee_id
     WHERE r.status = 'pending' AND r.expires_at > NOW(3)
     ORDER BY r.requested_at ASC`
  );
  return rows;
}

async function resolveLoginRequest(pool, requestId, accountantId, approve) {
  await expireStaleRequests(pool);
  const id = parseInt(requestId, 10);
  const [rows] = await pool.query(
    `SELECT id, employee_id, status FROM login_approval_requests WHERE id = ?`,
    [id]
  );
  if (!rows.length) {
    const err = new Error('Запрос не найден');
    err.status = 404;
    throw err;
  }
  const row = rows[0];
  if (row.status !== 'pending') {
    const err = new Error('Запрос уже обработан');
    err.status = 409;
    throw err;
  }
  const status = approve ? 'approved' : 'rejected';
  await pool.execute(
    `UPDATE login_approval_requests
     SET status = ?, resolved_at = NOW(3), resolved_by = ?
     WHERE id = ?`,
    [status, accountantId, id]
  );
  return { requestId: id, employeeId: row.employee_id, status };
}

async function consumeApprovedRequest(pool, requestId) {
  const row = await getPasswordLoginRequest(pool, requestId);
  if (!row) {
    const err = new Error('Запрос не найден');
    err.status = 404;
    throw err;
  }
  if (row.status === 'consumed') {
    const err = new Error('Вход по этому запросу уже выполнен');
    err.status = 409;
    throw err;
  }
  if (row.status === 'rejected') {
    const err = new Error('Бухгалтер отклонил запрос на вход');
    err.status = 403;
    throw err;
  }
  if (row.status === 'expired') {
    const err = new Error('Время запроса истекло. Отправьте запрос снова.');
    err.status = 410;
    throw err;
  }
  if (row.status !== 'approved') {
    const err = new Error('Ожидается подтверждение бухгалтера');
    err.status = 403;
    throw err;
  }
  await pool.execute(
    `UPDATE login_approval_requests SET status = 'consumed', resolved_at = COALESCE(resolved_at, NOW(3))
     WHERE id = ?`,
    [requestId]
  );
  return row;
}

module.exports = {
  normalizeLogin,
  normalizeEmail,
  hashPassword,
  verifyPassword,
  createPasswordLoginRequest,
  getPasswordLoginRequest,
  listPendingLoginRequests,
  resolveLoginRequest,
  consumeApprovedRequest,
  REQUEST_TTL_MS
};
