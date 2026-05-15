-- СКУД / СУРВ: полная схема MySQL (вставить в Workbench или: mysql -u test -p < scripts/surv-init.sql)

CREATE DATABASE IF NOT EXISTS surv
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE surv;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  type VARCHAR(64) NOT NULL,
  message TEXT NOT NULL,
  timestamp DATETIME(3) NOT NULL,
  INDEX idx_logs_ts (timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS knn_dataset (
  id INT PRIMARY KEY,
  payload LONGTEXT NOT NULL,
  updated_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
