(function() {
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

  function loadSummary() {
    fetch('/api/me/summary?employeeId=' + encodeURIComponent(employeeId), { cache: 'no-store' })
      .then(function(r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function(data) {
        userName.textContent = data.name;
        rateValue.textContent = data.rate.toLocaleString('ru-RU');
        sessionsCount.textContent = data.sessionsCount != null ? data.sessionsCount : 0;
        totalHours.textContent = data.totalHours;
        totalSalary.textContent = data.totalSalary.toLocaleString('ru-RU');
      })
      .catch(function() {
        userName.textContent = 'Ошибка загрузки';
      });
  }

  function loadCurrentSession() {
    fetch('/api/session/current?employeeId=' + encodeURIComponent(employeeId), { cache: 'no-store' })
      .then(function(r) {
        if (r.status === 404) {
          currentSessionBlock.style.display = 'none';
          noSessionHint.style.display = 'block';
          if (currentSessionInterval) clearInterval(currentSessionInterval);
          return null;
        }
        return r.ok ? r.json() : Promise.reject();
      })
      .then(function(data) {
        if (!data) return;
        currentSessionBlock.style.display = 'block';
        noSessionHint.style.display = 'none';
        var startDate = new Date(data.startTime);
        sessionStart.textContent = startDate.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
        var rate = data.rate;
        var startMs = startDate.getTime();

        function formatElapsed(ms) {
          var sec = Math.floor(ms / 1000) % 60;
          var min = Math.floor(ms / 60000) % 60;
          var hour = Math.floor(ms / 3600000);
          return hour + ' ч ' + min + ' мин ' + sec + ' сек';
        }
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
      .catch(function() {
        currentSessionBlock.style.display = 'none';
        noSessionHint.style.display = 'block';
      });
  }

  btnStopSession.addEventListener('click', function() {
    btnStopSession.disabled = true;
    btnStopSession.textContent = 'Завершаем...';
    fetch('/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: parseInt(employeeId, 10) }),
      cache: 'no-store'
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data && data.success) {
          if (currentSessionInterval) clearInterval(currentSessionInterval);
          currentSessionBlock.style.display = 'none';
          noSessionHint.style.display = 'block';
          loadSummary();
        }
      })
      .finally(function() {
        btnStopSession.disabled = false;
        btnStopSession.textContent = 'Завершить смену';
      });
  });

  loadSummary();
  loadCurrentSession();
})();
