const ExcelJS = require('exceljs');
const { getPool, logEvent, logAccessEvent } = require('../db');
const { buildTimesheetT13, buildLateReport, buildPayrollSummary } = require('./reporting');
const {
  listPendingLoginRequests,
  resolveLoginRequest
} = require('./password-login');

function normalizeRfid(id) {
  return String(id || '')
    .replace(/[\r\n]/g, '')
    .trim()
    .toUpperCase();
}

async function getEmployeeRole(pool, employeeId) {
  const [rows] = await pool.query('SELECT id, role, name FROM employees WHERE id = ?', [employeeId]);
  return rows[0] || null;
}

function requireAccountant(handler) {
  return async (req, res) => {
    const actorId = parseInt(
      req.query.actorId || req.headers['x-surv-employee-id'] || req.body?.actorId,
      10
    );
    if (!actorId) {
      return res.status(401).json({ error: 'Укажите actorId (ID бухгалтера)' });
    }
    try {
      const pool = getPool();
      const actor = await getEmployeeRole(pool, actorId);
      if (!actor || actor.role !== 'accountant') {
        return res.status(403).json({ error: 'Доступ только для роли «бухгалтер»' });
      }
      req.accountant = actor;
      return handler(req, res, pool);
    } catch (err) {
      console.error('[SURV accountant]', err.message);
      res.status(500).json({ error: 'Ошибка сервера' });
    }
  };
}

function monthBounds(year, month) {
  const y = parseInt(year, 10);
  const m = parseInt(month, 10);
  const start = new Date(y, m - 1, 1);
  const end = new Date(y, m, 0, 23, 59, 59, 999);
  return { start, end, year: y, month: m };
}

async function loadEmployeesAndSessions(pool, from, to) {
  const [employees] = await pool.query(
    `SELECT id, name, rate, schedule, role, work_start_time, late_grace_minutes, rfid_card_id
     FROM employees ORDER BY id`
  );
  const [sessions] = await pool.query(
    `SELECT id, employee_id, start_time, end_time, rfid_card_id
     FROM sessions
     WHERE start_time >= ? AND start_time <= ?`,
    [from, to]
  );
  return { employees, sessions };
}

function registerAccountantRoutes(app) {
  app.get(
    '/api/accountant/overview',
    requireAccountant(async (req, res, pool) => {
      const now = new Date();
      const from = new Date(now.getFullYear(), now.getMonth(), 1);
      const { employees, sessions } = await loadEmployeesAndSessions(pool, from, now);
      const payroll = buildPayrollSummary(employees, sessions, from, now);
      const late = buildLateReport(employees, sessions, from, now);
      const staff = employees.filter((e) => e.role === 'employee');
      const withRfid = staff.filter((e) => e.rfid_card_id).length;

      res.json({
        accountant: req.accountant.name,
        periodFrom: from.toISOString(),
        periodTo: now.toISOString(),
        employeesTotal: staff.length,
        employeesWithRfid: withRfid,
        activeSessionsNote: 'Активные смены — в памяти сервера',
        payroll,
        lateCount: late.length,
        latePreview: late.slice(0, 10)
      });
    })
  );

  app.get(
    '/api/accountant/payroll',
    requireAccountant(async (req, res, pool) => {
      const from = req.query.from ? new Date(req.query.from) : new Date(1970, 0, 1);
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const { employees, sessions } = await loadEmployeesAndSessions(pool, from, to);
      res.json({ data: buildPayrollSummary(employees, sessions, from, to) });
    })
  );

  app.get(
    '/api/accountant/late',
    requireAccountant(async (req, res, pool) => {
      const from = req.query.from ? new Date(req.query.from) : new Date(1970, 0, 1);
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const { employees, sessions } = await loadEmployeesAndSessions(pool, from, to);
      res.json({ data: buildLateReport(employees, sessions, from, to) });
    })
  );

  app.get(
    '/api/accountant/timesheet',
    requireAccountant(async (req, res, pool) => {
      const year = parseInt(req.query.year, 10) || new Date().getFullYear();
      const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;
      const { start, end } = monthBounds(year, month);
      const { employees, sessions } = await loadEmployeesAndSessions(pool, start, end);
      res.json({ year, month, data: buildTimesheetT13(employees, sessions, year, month) });
    })
  );

  app.get(
    '/api/accountant/timesheet/excel',
    requireAccountant(async (req, res, pool) => {
      const year = parseInt(req.query.year, 10) || new Date().getFullYear();
      const month = parseInt(req.query.month, 10) || new Date().getMonth() + 1;
      const { start, end } = monthBounds(year, month);
      const { employees, sessions } = await loadEmployeesAndSessions(pool, start, end);
      const data = buildTimesheetT13(employees, sessions, year, month);

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet(`T-13_${year}_${month}`);

      for (const emp of data) {
        sheet.addRow([`Сотрудник: ${emp.name} (id ${emp.employeeId})`, `График: ${emp.schedule}`, `Ставка: ${emp.rate}`]);
        const header = ['День', 'Дата', 'Код', 'Часы'];
        sheet.addRow(header);
        emp.days.forEach((d) => sheet.addRow([d.day, d.date, d.code, d.hours]));
        sheet.addRow(['Итого часов', '', '', emp.totalHours]);
        sheet.addRow(['Итого ₽', '', '', emp.totalSalary]);
        sheet.addRow([]);
      }

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="t13_${year}_${month}.xlsx"`
      );
      await workbook.xlsx.write(res);
      res.end();
    })
  );

  app.get(
    '/api/accountant/employees',
    requireAccountant(async (req, res, pool) => {
      const [rows] = await pool.query(
        `SELECT id, name, rate, schedule, role, rfid_card_id IS NOT NULL AS has_rfid,
                work_start_time, late_grace_minutes, created_at
         FROM employees ORDER BY role DESC, id`
      );
      res.json({ employees: rows });
    })
  );

  app.get(
    '/api/accountant/access-events',
    requireAccountant(async (req, res, pool) => {
      const [rows] = await pool.query(
        `SELECT a.*, e.name AS employee_name
         FROM access_events a
         LEFT JOIN employees e ON e.id = a.employee_id
         ORDER BY a.created_at DESC LIMIT 300`
      );
      res.json({ events: rows });
    })
  );

  app.get(
    '/api/accountant/login-requests',
    requireAccountant(async (req, res, pool) => {
      const requests = await listPendingLoginRequests(pool);
      res.json({ requests });
    })
  );

  app.post(
    '/api/accountant/login-requests/:id/approve',
    requireAccountant(async (req, res, pool) => {
      const id = req.params.id;
      const result = await resolveLoginRequest(pool, id, req.accountant.id, true);
      await logAccessEvent(
        result.employeeId,
        'password_login_approved',
        null,
        `Бухгалтер ${req.accountant.id} подтвердил запрос #${id}`
      );
      res.json({ ok: true, ...result });
    })
  );

  app.post(
    '/api/accountant/login-requests/:id/reject',
    requireAccountant(async (req, res, pool) => {
      const id = req.params.id;
      const result = await resolveLoginRequest(pool, id, req.accountant.id, false);
      await logAccessEvent(
        result.employeeId,
        'password_login_rejected',
        null,
        `Бухгалтер ${req.accountant.id} отклонил запрос #${id}`
      );
      res.json({ ok: true, ...result });
    })
  );

  app.get(
    '/salary',
    requireAccountant(async (req, res, pool) => {
      const from = req.query.from ? new Date(req.query.from) : new Date(1970, 0, 1);
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const { employees, sessions } = await loadEmployeesAndSessions(pool, from, to);
      res.json({ data: buildPayrollSummary(employees, sessions, from, to) });
    })
  );

  app.get(
    '/salary/excel',
    requireAccountant(async (req, res, pool) => {
      const from = req.query.from ? new Date(req.query.from) : new Date(1970, 0, 1);
      const to = req.query.to ? new Date(req.query.to) : new Date();
      const { employees, sessions } = await loadEmployeesAndSessions(pool, from, to);
      const result = buildPayrollSummary(employees, sessions, from, to);

      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet('Табель');
      sheet.columns = [
        { header: 'ID', key: 'employeeId', width: 10 },
        { header: 'Имя', key: 'name', width: 25 },
        { header: 'График', key: 'schedule', width: 10 },
        { header: 'Ставка', key: 'rate', width: 10 },
        { header: 'Смен', key: 'sessionsCount', width: 10 },
        { header: 'Часы', key: 'hours', width: 10 },
        { header: 'Зарплата', key: 'salary', width: 15 }
      ];
      result.forEach((row) => sheet.addRow(row));

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', 'attachment; filename="tabel.xlsx"');
      await workbook.xlsx.write(res);
      res.end();
    })
  );
}

module.exports = { registerAccountantRoutes, normalizeRfid, getEmployeeRole };
