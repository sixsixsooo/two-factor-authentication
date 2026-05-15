/**
 * MySQL (mysql2) — серверная БД СКУД / СУРВ.
 */
const mysql = require('mysql2/promise');

const dbName = process.env.MYSQL_DATABASE || 'surv';

const baseConfig = {
  host: process.env.MYSQL_HOST || 'localhost',
  user: process.env.MYSQL_USER || 'test',
  password: process.env.MYSQL_PASSWORD || '1234',
  port: Number(process.env.MYSQL_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4'
};

const dbInfo = {
  engine: 'mysql',
  host: baseConfig.host,
  port: baseConfig.port,
  database: dbName,
  user: baseConfig.user
};

let pool = null;

async function safeAlter(pool, sql) {
  try {
    await pool.query(sql);
  } catch (e) {
    if (e.code !== 'ER_DUP_FIELDNAME' && e.code !== 'ER_DUP_KEYNAME' && e.code !== 'ER_TABLE_EXISTS_ERROR') {
      throw e;
    }
  }
}

async function migrateSchema(pool) {
  await safeAlter(
    pool,
    `ALTER TABLE employees ADD COLUMN role ENUM('employee','accountant') NOT NULL DEFAULT 'employee'`
  );
  await safeAlter(pool, `ALTER TABLE employees ADD COLUMN rfid_card_id VARCHAR(128) NULL`);
  await safeAlter(
    pool,
    `ALTER TABLE employees ADD COLUMN work_start_time TIME NOT NULL DEFAULT '09:00:00'`
  );
  await safeAlter(
    pool,
    `ALTER TABLE employees ADD COLUMN late_grace_minutes INT NOT NULL DEFAULT 5`
  );
  try {
    await pool.query(
      'CREATE UNIQUE INDEX idx_employees_rfid ON employees (rfid_card_id)'
    );
  } catch (e) {
    if (e.code !== 'ER_DUP_KEYNAME') throw e;
  }

  await safeAlter(pool, `ALTER TABLE sessions ADD COLUMN rfid_card_id VARCHAR(128) NULL`);
  await safeAlter(
    pool,
    `ALTER TABLE sessions ADD COLUMN access_method VARCHAR(32) NOT NULL DEFAULT 'face_gps_rfid'`
  );

  await safeAlter(pool, `ALTER TABLE employees ADD COLUMN login VARCHAR(64) NULL`);
  await safeAlter(pool, `ALTER TABLE employees ADD COLUMN password_hash VARCHAR(255) NULL`);
  await safeAlter(pool, `ALTER TABLE employees ADD COLUMN email VARCHAR(255) NULL`);
  try {
    await pool.query('CREATE UNIQUE INDEX idx_employees_login ON employees (login)');
  } catch (e) {
    if (e.code !== 'ER_DUP_KEYNAME') throw e;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_approval_requests (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      status ENUM('pending','approved','rejected','expired','consumed') NOT NULL DEFAULT 'pending',
      requested_at DATETIME(3) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      resolved_at DATETIME(3) NULL,
      resolved_by INT NULL,
      CONSTRAINT fk_login_req_employee
        FOREIGN KEY (employee_id) REFERENCES employees(id)
        ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_login_req_resolver
        FOREIGN KEY (resolved_by) REFERENCES employees(id)
        ON DELETE SET NULL ON UPDATE CASCADE,
      INDEX idx_login_req_status (status),
      INDEX idx_login_req_employee (employee_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS access_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NULL,
      event_type VARCHAR(64) NOT NULL,
      rfid_card_id VARCHAR(128) NULL,
      message TEXT,
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      INDEX idx_access_employee (employee_id),
      INDEX idx_access_created (created_at),
      CONSTRAINT fk_access_employee
        FOREIGN KEY (employee_id) REFERENCES employees(id)
        ON DELETE SET NULL ON UPDATE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function initDatabase() {
  const bootstrap = await mysql.createConnection({
    host: baseConfig.host,
    user: baseConfig.user,
    password: baseConfig.password,
    port: baseConfig.port
  });
  await bootstrap.query(
    `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await bootstrap.end();

  pool = mysql.createPool({ ...baseConfig, database: dbName });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      face_descriptor TEXT,
      rate DOUBLE NOT NULL,
      schedule VARCHAR(64) NOT NULL,
      role ENUM('employee','accountant') NOT NULL DEFAULT 'employee',
      rfid_card_id VARCHAR(128) NULL,
      work_start_time TIME NOT NULL DEFAULT '09:00:00',
      late_grace_minutes INT NOT NULL DEFAULT 5,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uk_employees_rfid (rfid_card_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      employee_id INT NOT NULL,
      start_time DATETIME(3) NOT NULL,
      end_time DATETIME(3) NULL,
      latitude DOUBLE NULL,
      longitude DOUBLE NULL,
      rfid_card_id VARCHAR(128) NULL,
      access_method VARCHAR(32) NOT NULL DEFAULT 'face_gps_rfid',
      CONSTRAINT fk_sessions_employee
        FOREIGN KEY (employee_id) REFERENCES employees(id)
        ON DELETE RESTRICT ON UPDATE CASCADE,
      INDEX idx_sessions_employee (employee_id),
      INDEX idx_sessions_times (start_time, end_time)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(64) NOT NULL,
      message TEXT NOT NULL,
      timestamp DATETIME(3) NOT NULL,
      INDEX idx_logs_ts (timestamp)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS knn_dataset (
      id INT PRIMARY KEY,
      payload LONGTEXT NOT NULL,
      updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await migrateSchema(pool);

  console.log(
    '[SURV DB] MySQL:',
    `${baseConfig.user}@${baseConfig.host}:${baseConfig.port}/${dbName}`
  );
}

function getPool() {
  if (!pool) {
    throw new Error('БД не инициализирована: вызовите initDatabase() перед стартом сервера');
  }
  return pool;
}

async function logAccessEvent(employeeId, eventType, rfidCardId, message) {
  try {
    const p = getPool();
    await p.execute(
      `INSERT INTO access_events (employee_id, event_type, rfid_card_id, message, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [employeeId || null, eventType, rfidCardId || null, message || null, new Date()]
    );
  } catch (e) {
    console.error('[SURV DB] access_events:', e.message);
  }
}

async function logEvent(type, message) {
  try {
    const p = getPool();
    await p.execute('INSERT INTO logs (type, message, timestamp) VALUES (?, ?, ?)', [
      type,
      String(message).slice(0, 4000),
      new Date()
    ]);
  } catch (e) {
    console.error('[SURV DB] logEvent:', e.message);
  }
}

module.exports = {
  initDatabase,
  getPool,
  logEvent,
  logAccessEvent,
  dbInfo
};
