const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const dbPath = path.join(__dirname, 'surv.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      face_descriptor TEXT NOT NULL,
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
  logEvent
};

