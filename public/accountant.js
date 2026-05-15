/* global SurvAPI */
(function () {
  const actorId = localStorage.getItem('surv_employee_id');
  const role = localStorage.getItem('surv_role');

  if (!actorId) {
    window.location.href = '/login.html';
    return;
  }
  if (role !== 'accountant') {
    window.location.href = '/dashboard.html';
    return;
  }

  const filterFrom = document.getElementById('filterFrom');
  const filterTo = document.getElementById('filterTo');
  const filterMonth = document.getElementById('filterMonth');
  const overviewBox = document.getElementById('overviewBox');
  const payrollBody = document.querySelector('#payrollTable tbody');
  const lateBody = document.querySelector('#lateTable tbody');
  const staffBody = document.querySelector('#staffTable tbody');
  const t13Container = document.getElementById('t13Container');
  const loginRequestsBox = document.getElementById('loginRequestsBox');

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  filterFrom.value = monthStart.toISOString().slice(0, 10);
  filterTo.value = now.toISOString().slice(0, 10);
  filterMonth.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

  function periodIso() {
    return {
      from: filterFrom.value ? new Date(filterFrom.value).toISOString() : null,
      to: filterTo.value
        ? new Date(filterTo.value + 'T23:59:59').toISOString()
        : new Date().toISOString()
    };
  }

  function fillTableBody(tbody, rows, cols) {
    tbody.innerHTML = '';
    if (!rows.length) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="' + cols + '">Нет данных</td>';
      tbody.appendChild(tr);
      return;
    }
    rows.forEach(function (r) {
      const tr = document.createElement('tr');
      tr.innerHTML = r;
      tbody.appendChild(tr);
    });
  }

  async function loadStaff() {
    const res = await fetch('/api/accountant/employees?actorId=' + encodeURIComponent(actorId), {
      cache: 'no-store'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Ошибка');
    fillTableBody(
      staffBody,
      data.employees.map(function (e) {
        return (
          '<td>' +
          e.id +
          '</td><td>' +
          e.name +
          '</td><td>' +
          (e.role === 'accountant' ? 'бухгалтер' : 'сотрудник') +
          '</td><td>' +
          (e.has_rfid ? 'да' : '—') +
          '</td><td>' +
          e.schedule +
          '</td><td>' +
          Number(e.rate).toLocaleString('ru-RU') +
          '</td><td>' +
          (e.work_start_time || '—') +
          '</td>'
        );
      }),
      7
    );
  }

  async function loadPayroll() {
    const p = periodIso();
    const data = await SurvAPI.accountantPayroll(actorId, p.from, p.to);
    fillTableBody(
      payrollBody,
      (data.data || []).map(function (row) {
        return (
          '<td>' +
          row.employeeId +
          '</td><td>' +
          row.name +
          '</td><td>' +
          row.schedule +
          '</td><td>' +
          Number(row.rate).toLocaleString('ru-RU') +
          '</td><td>' +
          row.sessionsCount +
          '</td><td>' +
          row.hours +
          '</td><td>' +
          Number(row.salary).toLocaleString('ru-RU') +
          '</td>'
        );
      }),
      7
    );
  }

  async function loadLate() {
    const p = periodIso();
    const data = await SurvAPI.accountantLate(actorId, p.from, p.to);
    fillTableBody(
      lateBody,
      (data.data || []).map(function (row) {
        return (
          '<td>' +
          row.date +
          '</td><td>' +
          row.name +
          ' (id ' +
          row.employeeId +
          ')</td><td>' +
          row.expectedStart +
          '</td><td>' +
          row.actualStart +
          '</td><td>' +
          row.lateMinutes +
          '</td>'
        );
      }),
      5
    );
  }

  async function loadT13() {
    const parts = (filterMonth.value || '').split('-');
    const year = parseInt(parts[0], 10) || now.getFullYear();
    const month = parseInt(parts[1], 10) || now.getMonth() + 1;
    const data = await SurvAPI.accountantTimesheet(actorId, year, month);
    if (!data.data || !data.data.length) {
      t13Container.textContent = 'Нет данных за выбранный месяц.';
      return;
    }
    let html = '';
    data.data.forEach(function (emp) {
      html += '<h3 style="margin:16px 0 8px;">' + emp.name + ' — ' + emp.totalHours + ' ч, ' + emp.totalSalary + ' ₽</h3>';
      html += '<div class="table-wrap"><table class="data-table"><thead><tr><th>День</th><th>Код</th><th>Часы</th></tr></thead><tbody>';
      emp.days.forEach(function (d) {
        if (d.hours > 0 || d.code === 'Н') {
          html += '<tr><td>' + d.day + '</td><td>' + d.code + '</td><td>' + d.hours + '</td></tr>';
        }
      });
      html += '</tbody></table></div>';
    });
    t13Container.innerHTML = html;
  }

  async function loadOverview() {
    const data = await SurvAPI.accountantOverview(actorId);
    document.getElementById('accountantGreeting').textContent =
      'Бухгалтер: ' + data.accountant + ' · СКУД / учёт времени';
    let totalSalary = 0;
    let totalHours = 0;
    (data.payroll || []).forEach(function (r) {
      totalSalary += r.salary;
      totalHours += r.hours;
    });
    overviewBox.innerHTML =
      '<p><strong>Сотрудников:</strong> ' +
      data.employeesTotal +
      ' (с RFID: ' +
      data.employeesWithRfid +
      ')</p>' +
      '<p><strong>Опозданий в периоде:</strong> ' +
      data.lateCount +
      '</p>' +
      '<p><strong>Часы (текущий месяц):</strong> ' +
      totalHours +
      ' · <strong>Начислено:</strong> ' +
      totalSalary.toLocaleString('ru-RU') +
      ' ₽</p>';
  }

  async function loadLoginRequests() {
    if (!loginRequestsBox) return;
    const data = await SurvAPI.accountantLoginRequests(actorId);
    const list = data.requests || [];
    if (!list.length) {
      loginRequestsBox.textContent = 'Нет ожидающих запросов.';
      return;
    }
    let html = '<ul style="list-style:none; padding:0; margin:0;">';
    list.forEach(function (r) {
      const when = r.requested_at ? new Date(r.requested_at).toLocaleString('ru-RU') : '';
      html +=
        '<li style="margin-bottom:12px; padding:10px; background:rgba(255,255,255,0.04); border-radius:8px;">' +
        '<strong>' +
        (r.name || '') +
        '</strong> (id ' +
        r.employee_id +
        ', логин ' +
        (r.login || '—') +
        ')<br>' +
        '<span class="small">' +
        (r.email || '') +
        ' · ' +
        when +
        '</span><br>' +
        '<button type="button" class="btn" data-approve="' +
        r.id +
        '" style="margin-top:8px; margin-right:8px;">Подтвердить</button>' +
        '<button type="button" class="btn secondary" data-reject="' +
        r.id +
        '">Отклонить</button>' +
        '</li>';
    });
    html += '</ul>';
    loginRequestsBox.innerHTML = html;
    loginRequestsBox.querySelectorAll('[data-approve]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        try {
          await SurvAPI.accountantApproveLogin(actorId, btn.getAttribute('data-approve'));
          await loadLoginRequests();
        } catch (e) {
          alert(e.message || e);
        }
      });
    });
    loginRequestsBox.querySelectorAll('[data-reject]').forEach(function (btn) {
      btn.addEventListener('click', async function () {
        try {
          await SurvAPI.accountantRejectLogin(actorId, btn.getAttribute('data-reject'));
          await loadLoginRequests();
        } catch (e) {
          alert(e.message || e);
        }
      });
    });
  }

  async function refreshAll() {
    try {
      overviewBox.textContent = 'Загрузка…';
      await Promise.all([
        loadOverview(),
        loadPayroll(),
        loadLate(),
        loadT13(),
        loadStaff(),
        loadLoginRequests()
      ]);
    } catch (e) {
      overviewBox.textContent = 'Ошибка: ' + (e.message || e);
      alert(e.message || 'Нет доступа. Войдите как бухгалтер.');
    }
  }

  document.getElementById('btnRefresh').addEventListener('click', refreshAll);
  document.getElementById('btnRefreshLoginRequests')?.addEventListener('click', loadLoginRequests);

  document.getElementById('btnExcelPayroll').addEventListener('click', function () {
    const p = periodIso();
    window.location.href = SurvAPI.accountantExcelUrl('/salary/excel', actorId, {
      from: p.from,
      to: p.to
    });
  });

  document.getElementById('btnExcelT13').addEventListener('click', function () {
    const parts = (filterMonth.value || '').split('-');
    window.location.href = SurvAPI.accountantExcelUrl('/api/accountant/timesheet/excel', actorId, {
      year: parts[0],
      month: parts[1]
    });
  });

  refreshAll();
})();
