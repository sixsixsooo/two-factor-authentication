/**
 * Локальная «база» в браузере: IndexedDB (десятки МБ+, без квоты localStorage).
 * Сотрудники + единый датасет KNN. Работает без Node/SQLite на сервере.
 */
(function (global) {
  'use strict';

  var DB_NAME = 'surv_local_v2';
  var DB_VERSION = 1;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var db = e.target.result;
        if (!db.objectStoreNames.contains('employees')) {
          db.createObjectStore('employees', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('knn')) {
          db.createObjectStore('knn', { keyPath: 'key' });
        }
      };
      req.onsuccess = function () {
        resolve(req.result);
      };
      req.onerror = function () {
        reject(req.error);
      };
    });
  }

  function addEmployee(rec) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('employees', 'readwrite');
        var store = tx.objectStore('employees');
        var item = {
          name: rec.name,
          schedule: String(rec.schedule),
          rate: Number(rec.rate),
          createdAt: new Date().toISOString()
        };
        var r = store.add(item);
        r.onsuccess = function () {
          resolve(r.result);
        };
        r.onerror = function () {
          reject(r.error);
        };
      });
    });
  }

  function getEmployee(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('employees', 'readonly');
        var r = tx.objectStore('employees').get(Number(id));
        r.onsuccess = function () {
          resolve(r.result || null);
        };
        r.onerror = function () {
          reject(r.error);
        };
      });
    });
  }

  function getAllEmployees() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('employees', 'readonly');
        var r = tx.objectStore('employees').getAll();
        r.onsuccess = function () {
          resolve(r.result || []);
        };
        r.onerror = function () {
          reject(r.error);
        };
      });
    });
  }

  function saveKnnDataset(datasetObj) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('knn', 'readwrite');
        tx.objectStore('knn').put({
          key: 'main',
          dataset: datasetObj,
          updatedAt: new Date().toISOString()
        });
        tx.oncomplete = function () {
          resolve();
        };
        tx.onerror = function () {
          reject(tx.error);
        };
      });
    });
  }

  function loadKnnDataset() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('knn', 'readonly');
        var r = tx.objectStore('knn').get('main');
        r.onsuccess = function () {
          var row = r.result;
          resolve(row && row.dataset ? row.dataset : null);
        };
        r.onerror = function () {
          reject(r.error);
        };
      });
    });
  }

  global.SurvLocalDB = {
    addEmployee: addEmployee,
    getEmployee: getEmployee,
    getAllEmployees: getAllEmployees,
    saveKnnDataset: saveKnnDataset,
    loadKnnDataset: loadKnnDataset
  };
})(typeof window !== 'undefined' ? window : global);
