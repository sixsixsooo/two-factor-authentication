const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Одна база на все экземпляры: можно задать общий путь (иначе у каждой копии папки — свой surv.db)
const dbPath = process.env.SURV_DB_PATH
  ? path.resolve(process.env.SURV_DB_PATH)
  : path.join(__dirname, 'surv.db');
const db = new sqlite3.Database(dbPath);

// В консоли сервера видно, какой файл реально используется (важно при нескольких копиях проекта)
console.log('[SURV DB] SQLite файл:', dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      face_descriptor TEXT,
      rate REAL NOT NULL,
      schedule TEXT NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      latitude REAL,
      longitude REAL,
      FOREIGN KEY (employee_id) REFERENCES employees(id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);

  // Единая база признаков KNN (JSON: { "1": { shape, values }, ... })
  db.run(`
    CREATE TABLE IF NOT EXISTS knn_dataset (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.run('PRAGMA journal_mode = WAL', (err) => {
    if (err) console.error('[SURV DB] PRAGMA journal_mode:', err.message);
  });
});

function logEvent(type, message) {
  const timestamp = new Date().toISOString();
  db.run(
    'INSERT INTO logs (type, message, timestamp) VALUES (?, ?, ?)',
    [type, message, timestamp]
  );
}

module.exports = {
  db,
  dbPath,
  logEvent
};

