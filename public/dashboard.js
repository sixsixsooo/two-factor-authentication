/* global SurvLocalDB */
(function () {
  const employeeId = localStorage.getItem('surv_employee_id');
  if (!employeeId) {
    window.location.href = '/index.html';
    return;
  }

  const currentSessionBlock = document.getElementById('currentSessionBlock');
  const noSessionHint = document.getElementById('noSessionHint');
  const userName = document.getElementById('userName');
  const sessionStart = document.getElementById('sessionStart');
  const currentElapsed = document.getElementById('currentElapsed');
  const currentHours = document.getElementById('currentHours');
  const currentSalary = document.getElementById('currentSalary');
  const rateValue = document.getElementById('rateValue');
  const sessionsCount = document.getElementById('sessionsCount');
  const totalHours = document.getElementById('totalHours');
  const totalSalary = document.getElementById('totalSalary');
  const btnStopSession = document.getElementById('btnStopSession');

  let currentSessionInterval = null;
  const LOCAL_STATS_KEY = 'surv_local_sessions_stats';

  function statsStorageKey() {
    return LOCAL_STATS_KEY + '_' + employeeId;
  }

  function getLocalStats() {
    try {
      var key = statsStorageKey();
      var raw = localStorage.getItem(key);
      if (!raw) {
        var legacy = localStorage.getItem(LOCAL_STATS_KEY);
        if (legacy) {
          localStorage.setItem(key, legacy);
          localStorage.removeItem(LOCAL_STATS_KEY);
          raw = legacy;
        }
      }
      if (!raw) return { count: 0, totalHours: 0, totalSalary: 0 };
      var o = JSON.parse(raw);
      return {
        count: Number(o.count) || 0,
        totalHours: Number(o.totalHours) || 0,
        totalSalary: Number(o.totalSalary) || 0
      };
    } catch (_) {
      return { count: 0, totalHours: 0, totalSalary: 0 };
    }
  }

  function saveLocalStats(s) {
    localStorage.setItem(statsStorageKey(), JSON.stringify(s));
  }

  function formatElapsed(ms) {
    var sec = Math.floor(ms / 1000) % 60;
    var min = Math.floor(ms / 60000) % 60;
    var hour = Math.floor(ms / 3600000);
    return hour + ' ч ' + min + ' мин ' + sec + ' сек';
  }

  /**
   * Если сотрудник есть в IndexedDB — всегда показываем ЕГО имя/ставку и локальную статистику,
   * даже после завершения смены (когда флаг surv_local_login уже сброшен). Иначе подтянется SQLite с сервера и «чужие» данные.
   */
  function loadSummary() {
    if (!window.SurvLocalDB) {
      userName.textContent = 'Нет local-db.js';
      return Promise.resolve();
    }
    return SurvLocalDB.getEmployee(parseInt(employeeId, 10)).then(function (emp) {
      if (emp) {
        userName.textContent = emp.name || 'Сотрудник';
        rateValue.textContent = Number(emp.rate).toLocaleString('ru-RU');
        var st = getLocalStats();
        sessionsCount.textContent = String(st.count);
        totalHours.textContent = String(st.totalHours);
        totalSalary.textContent = st.totalSalary.toLocaleString('ru-RU');
        return;
      }
      return fetch('/api/me/summary?employeeId=' + encodeURIComponent(employeeId), { cache: 'no-store' })
        .then(function (r) {
          return r.ok ? r.json() : Promise.reject();
        })
        .then(function (data) {
          userName.textContent = data.name;
          rateValue.textContent = data.rate.toLocaleString('ru-RU');
          sessionsCount.textContent = data.sessionsCount != null ? data.sessionsCount : 0;
          totalHours.textContent = data.totalHours;
          totalSalary.textContent = data.totalSalary.toLocaleString('ru-RU');
        })
        .catch(function () {
          userName.textContent = 'Сотрудник не найден (ни в IndexedDB, ни на сервере)';
          rateValue.textContent = '—';
          sessionsCount.textContent = '0';
          totalHours.textContent = '0';
          totalSalary.textContent = '0';
        });
    });
  }

  function startLocalSessionTimer(startMs, rate) {
    function updateCurrent() {
      var now = Date.now();
      var elapsedMs = now - startMs;
      var hoursSoFar = Math.floor(elapsedMs / (1000 * 60 * 60));
      var salarySoFar = hoursSoFar * rate;
      currentElapsed.textContent = formatElapsed(elapsedMs);
      currentHours.textContent = String(hoursSoFar);
      currentSalary.textContent = salarySoFar.toLocaleString('ru-RU');
    }
    updateCurrent();
    if (currentSessionInterval) clearInterval(currentSessionInterval);
    currentSessionInterval = setInterval(updateCurrent, 1000);
  }

  function loadServerCurrentSession() {
    fetch('/api/session/current?employeeId=' + encodeURIComponent(employeeId), { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) {
          currentSessionBlock.style.display = 'none';
          noSessionHint.style.display = 'block';
          if (currentSessionInterval) clearInterval(currentSessionInterval);
          return null;
        }
        return r.ok ? r.json() : Promise.reject();
      })
      .then(function (data) {
        if (!data) return;
        currentSessionBlock.style.display = 'block';
        noSessionHint.style.display = 'none';
        var startDate = new Date(data.startTime);
        sessionStart.textContent = startDate.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
        var rate = data.rate;
        var startMs = startDate.getTime();

        function updateCurrent() {
          var now = Date.now();
          var elapsedMs = now - startMs;
          var hoursSoFar = Math.floor(elapsedMs / (1000 * 60 * 60));
          var salarySoFar = hoursSoFar * rate;
          currentElapsed.textContent = formatElapsed(elapsedMs);
          currentHours.textContent = hoursSoFar;
          currentSalary.textContent = salarySoFar.toLocaleString('ru-RU');
        }
        updateCurrent();
        if (currentSessionInterval) clearInterval(currentSessionInterval);
        currentSessionInterval = setInterval(updateCurrent, 1000);
      })
      .catch(function () {
        currentSessionBlock.style.display = 'none';
        noSessionHint.style.display = 'block';
      });
  }

  function loadCurrentSession() {
    var localStart = localStorage.getItem('surv_local_session_start');
    if (localStart && window.SurvLocalDB) {
      SurvLocalDB.getEmployee(parseInt(employeeId, 10)).then(function (emp) {
        if (!emp) {
          loadServerCurrentSession();
          return;
        }
        var startDate = new Date(localStart);
        var rate = Number(emp.rate);
        sessionStart.textContent = startDate.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
        currentSessionBlock.style.display = 'block';
        noSessionHint.style.display = 'none';
        startLocalSessionTimer(startDate.getTime(), rate);
      });
      return;
    }

    loadServerCurrentSession();
  }

  btnStopSession.addEventListener('click', function () {
    btnStopSession.disabled = true;
    btnStopSession.textContent = 'Завершаем...';

    var localStart = localStorage.getItem('surv_local_session_start');

    if (localStart && window.SurvLocalDB) {
      SurvLocalDB.getEmployee(parseInt(employeeId, 10))
        .then(function (emp) {
          if (!emp) {
            return fetch('/logout', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ employeeId: parseInt(employeeId, 10) }),
              cache: 'no-store'
            })
              .then(function (r) {
                return r.json();
              })
              .then(function (data) {
                if (data && data.success) {
                  if (currentSessionInterval) clearInterval(currentSessionInterval);
                  currentSessionBlock.style.display = 'none';
                  noSessionHint.style.display = 'block';
                  loadSummary();
                }
              });
          }
          var startMs = new Date(localStart).getTime();
          var endMs = Date.now();
          var elapsedMs = Math.max(0, endMs - startMs);
          var completedHours = Math.floor(elapsedMs / (1000 * 60 * 60));
          var rate = Number(emp.rate);
          var addSalary = completedHours * rate;
          var st = getLocalStats();
          st.count = (st.count || 0) + 1;
          st.totalHours = (st.totalHours || 0) + completedHours;
          st.totalSalary = (st.totalSalary || 0) + addSalary;
          saveLocalStats(st);
          localStorage.removeItem('surv_local_session_start');
          localStorage.removeItem('surv_local_login');
          if (currentSessionInterval) clearInterval(currentSessionInterval);
          currentSessionBlock.style.display = 'none';
          noSessionHint.style.display = 'block';
          return loadSummary();
        })
        .finally(function () {
          btnStopSession.disabled = false;
          btnStopSession.textContent = 'Завершить смену';
        });
      return;
    }

    fetch('/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: parseInt(employeeId, 10) }),
      cache: 'no-store'
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data && data.success) {
          if (currentSessionInterval) clearInterval(currentSessionInterval);
          currentSessionBlock.style.display = 'none';
          noSessionHint.style.display = 'block';
          loadSummary();
        }
      })
      .finally(function () {
        btnStopSession.disabled = false;
        btnStopSession.textContent = 'Завершить смену';
      });
  });

  loadSummary().then(function () {
    loadCurrentSession();
  });
})();
