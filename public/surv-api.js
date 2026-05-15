/**
 * Клиент API сервера (MySQL / СКУД).
 */
(function (global) {
  'use strict';

  async function parseJsonResponse(res) {
    var data = {};
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok) {
      var err = new Error(data.error || res.statusText || 'Ошибка сервера');
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  function actorQuery(actorId) {
    return actorId ? '?actorId=' + encodeURIComponent(actorId) : '';
  }

  async function getEmployee(id) {
    var res = await fetch('/api/employee/' + encodeURIComponent(id), { cache: 'no-store' });
    if (res.status === 404) return null;
    return parseJsonResponse(res);
  }

  async function getMe(employeeId) {
    var res = await fetch('/api/me?employeeId=' + encodeURIComponent(employeeId), { cache: 'no-store' });
    return parseJsonResponse(res);
  }

  async function registerEmployee(rec) {
    var res = await fetch('/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        name: rec.name,
        schedule: rec.schedule,
        rate: rec.rate,
        role: rec.role || 'employee',
        rfidCardId: rec.rfidCardId || null,
        workStartTime: rec.workStartTime || '09:00:00',
        lateGraceMinutes: rec.lateGraceMinutes != null ? rec.lateGraceMinutes : 5,
        login: rec.login,
        password: rec.password,
        email: rec.email
      })
    });
    return parseJsonResponse(res);
  }

  async function loadKnnDataset() {
    var res = await fetch('/api/knn-dataset', { cache: 'no-store' });
    return parseJsonResponse(res);
  }

  async function saveKnnDataset(datasetObj) {
    var res = await fetch('/api/knn-dataset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ dataset: datasetObj })
    });
    return parseJsonResponse(res);
  }

  async function login(employeeId, rfidCardId) {
    var res = await fetch('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        employeeId: employeeId,
        rfidCardId: rfidCardId || null
      })
    });
    return parseJsonResponse(res);
  }

  async function requestPasswordLogin(login, password) {
    var res = await fetch('/api/auth/password-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ login: login, password: password })
    });
    return parseJsonResponse(res);
  }

  async function getPasswordLoginRequest(requestId) {
    var res = await fetch('/api/auth/password-request/' + encodeURIComponent(requestId), {
      cache: 'no-store'
    });
    return parseJsonResponse(res);
  }

  async function loginWithPasswordApproval(requestId) {
    var res = await fetch('/api/login/password-approved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ requestId: requestId })
    });
    return parseJsonResponse(res);
  }

  async function accountantLoginRequests(actorId) {
    var res = await fetch('/api/accountant/login-requests' + actorQuery(actorId), {
      cache: 'no-store'
    });
    return parseJsonResponse(res);
  }

  async function accountantApproveLogin(actorId, requestId) {
    var res = await fetch('/api/accountant/login-requests/' + encodeURIComponent(requestId) + '/approve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ actorId: actorId })
    });
    return parseJsonResponse(res);
  }

  async function accountantRejectLogin(actorId, requestId) {
    var res = await fetch('/api/accountant/login-requests/' + encodeURIComponent(requestId) + '/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ actorId: actorId })
    });
    return parseJsonResponse(res);
  }

  async function logout(employeeId) {
    var res = await fetch('/logout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ employeeId: employeeId })
    });
    return parseJsonResponse(res);
  }

  async function accountantOverview(actorId) {
    var res = await fetch('/api/accountant/overview' + actorQuery(actorId), { cache: 'no-store' });
    return parseJsonResponse(res);
  }

  async function accountantPayroll(actorId, from, to) {
    var q = actorQuery(actorId).replace('?', '') ? actorQuery(actorId) + '&' : '?';
    if (actorQuery(actorId)) q = actorQuery(actorId) + '&';
    else q = '?';
    var url =
      '/api/accountant/payroll' +
      (actorQuery(actorId) ? actorQuery(actorId) + '&' : '?') +
      'from=' +
      encodeURIComponent(from) +
      '&to=' +
      encodeURIComponent(to);
    var res = await fetch(url, { cache: 'no-store' });
    return parseJsonResponse(res);
  }

  async function accountantLate(actorId, from, to) {
    var url =
      '/api/accountant/late' +
      (actorQuery(actorId) ? actorQuery(actorId) + '&' : '?') +
      'from=' +
      encodeURIComponent(from) +
      '&to=' +
      encodeURIComponent(to);
    var res = await fetch(url, { cache: 'no-store' });
    return parseJsonResponse(res);
  }

  async function accountantTimesheet(actorId, year, month) {
    var url =
      '/api/accountant/timesheet' +
      (actorQuery(actorId) ? actorQuery(actorId) + '&' : '?') +
      'year=' +
      year +
      '&month=' +
      month;
    var res = await fetch(url, { cache: 'no-store' });
    return parseJsonResponse(res);
  }

  function accountantExcelUrl(path, actorId, params) {
    var parts = [];
    if (actorId) parts.push('actorId=' + encodeURIComponent(actorId));
    if (params) {
      Object.keys(params).forEach(function (k) {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      });
    }
    return path + '?' + parts.join('&');
  }

  global.SurvAPI = {
    getEmployee: getEmployee,
    getMe: getMe,
    registerEmployee: registerEmployee,
    loadKnnDataset: loadKnnDataset,
    saveKnnDataset: saveKnnDataset,
    login: login,
    requestPasswordLogin: requestPasswordLogin,
    getPasswordLoginRequest: getPasswordLoginRequest,
    loginWithPasswordApproval: loginWithPasswordApproval,
    accountantLoginRequests: accountantLoginRequests,
    accountantApproveLogin: accountantApproveLogin,
    accountantRejectLogin: accountantRejectLogin,
    logout: logout,
    accountantOverview: accountantOverview,
    accountantPayroll: accountantPayroll,
    accountantLate: accountantLate,
    accountantTimesheet: accountantTimesheet,
    accountantExcelUrl: accountantExcelUrl
  };
})(typeof window !== 'undefined' ? window : global);
