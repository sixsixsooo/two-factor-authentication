/**
 * Отчёты СКУД: табель T-13, опоздания, сводка по часам/ставкам.
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toLocalDateKey(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}

function isWeekend(date) {
  const d = date.getDay();
  return d === 0 || d === 6;
}

function isWorkdayForSchedule(schedule, date) {
  if (schedule === '2/2') return true;
  return !isWeekend(date);
}

function parseWorkStart(timeVal) {
  if (!timeVal) return { h: 9, m: 0 };
  const s = String(timeVal);
  const parts = s.split(':');
  return { h: parseInt(parts[0], 10) || 9, m: parseInt(parts[1], 10) || 0 };
}

function sessionHours(start, end) {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms <= 0) return 0;
  return Math.floor(ms / (1000 * 60 * 60));
}

/**
 * Табель по форме T-13 (упрощённо): часы по дням месяца на каждого сотрудника.
 */
function buildTimesheetT13(employees, sessions, year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthStart = new Date(year, month - 1, 1);
  const monthEnd = new Date(year, month - 1, daysInMonth, 23, 59, 59);

  return employees
    .filter((e) => e.role !== 'accountant')
    .map((emp) => {
      const empSessions = sessions.filter((s) => s.employee_id === emp.id);
      const days = [];
      let totalHours = 0;

      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month - 1, day);
        const key = toLocalDateKey(date);
        const daySessions = empSessions.filter((s) => {
          const st = new Date(s.start_time);
          return (
            st.getFullYear() === year &&
            st.getMonth() === month - 1 &&
            st.getDate() === day
          );
        });
        let hours = 0;
        for (const s of daySessions) {
          if (s.end_time) hours += sessionHours(s.start_time, s.end_time);
        }
        totalHours += hours;

        let code = '';
        if (hours > 0) code = 'Я';
        else if (!isWorkdayForSchedule(emp.schedule, date)) code = 'В';
        else code = 'Н';

        days.push({ day, date: key, hours, code });
      }

      return {
        employeeId: emp.id,
        name: emp.name,
        schedule: emp.schedule,
        rate: emp.rate,
        workStartTime: emp.work_start_time,
        days,
        totalHours,
        totalSalary: totalHours * emp.rate
      };
    });
}

/**
 * Отчёт по опозданиям.
 */
function buildLateReport(employees, sessions, fromDate, toDate) {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  const rows = [];

  for (const emp of employees) {
    if (emp.role === 'accountant') continue;
    const ws = parseWorkStart(emp.work_start_time);
    const grace = Number(emp.late_grace_minutes) || 5;

    const empSessions = sessions.filter((s) => s.employee_id === emp.id);
    for (const s of empSessions) {
      const start = new Date(s.start_time);
      if (start < from || start > to) continue;
      if (!isWorkdayForSchedule(emp.schedule, start)) continue;

      const expected = new Date(start);
      expected.setHours(ws.h, ws.m, 0, 0);
      const lateMs = start.getTime() - expected.getTime();
      const lateMinutes = Math.floor(lateMs / 60000);

      if (lateMinutes > grace) {
        rows.push({
          employeeId: emp.id,
          name: emp.name,
          sessionId: s.id,
          date: toLocalDateKey(start),
          expectedStart: `${pad2(ws.h)}:${pad2(ws.m)}`,
          actualStart: start.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
          lateMinutes: lateMinutes - grace,
          schedule: emp.schedule
        });
      }
    }
  }

  rows.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return rows;
}

function buildPayrollSummary(employees, sessions, fromDate, toDate) {
  const from = new Date(fromDate);
  const to = new Date(toDate);

  return employees
    .filter((e) => e.role !== 'accountant')
    .map((emp) => {
      let hours = 0;
      let sessionsCount = 0;
      for (const s of sessions) {
        if (s.employee_id !== emp.id || !s.end_time) continue;
        const st = new Date(s.start_time);
        if (st < from || st > to) continue;
        hours += sessionHours(s.start_time, s.end_time);
        sessionsCount += 1;
      }
      return {
        employeeId: emp.id,
        name: emp.name,
        schedule: emp.schedule,
        rate: emp.rate,
        sessionsCount,
        hours,
        salary: hours * emp.rate
      };
    });
}

module.exports = {
  buildTimesheetT13,
  buildLateReport,
  buildPayrollSummary,
  sessionHours
};
