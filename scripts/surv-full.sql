-- =============================================================================
-- СКУД / СУРВ — полный скрипт MySQL (вставить в Workbench и выполнить целиком)
-- Подключение в проекте: user=test, password=1234, database=surv, host=localhost
-- =============================================================================

CREATE DATABASE IF NOT EXISTS surv
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE surv;

-- ---------------------------------------------------------------------------
-- Таблицы (если база новая — создаются; если старые — остаются, колонки добьёт миграция ниже)
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Миграция: добавить новые колонки, если БД была создана по старой схеме
-- (без ошибок «Duplicate column»)
-- ---------------------------------------------------------------------------

DROP PROCEDURE IF EXISTS surv_apply_migrations;

DELIMITER $$

CREATE PROCEDURE surv_apply_migrations()
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'role'
  ) THEN
    ALTER TABLE employees
      ADD COLUMN role ENUM('employee','accountant') NOT NULL DEFAULT 'employee' AFTER schedule;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'rfid_card_id'
  ) THEN
    ALTER TABLE employees ADD COLUMN rfid_card_id VARCHAR(128) NULL AFTER role;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'work_start_time'
  ) THEN
    ALTER TABLE employees
      ADD COLUMN work_start_time TIME NOT NULL DEFAULT '09:00:00' AFTER rfid_card_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'late_grace_minutes'
  ) THEN
    ALTER TABLE employees
      ADD COLUMN late_grace_minutes INT NOT NULL DEFAULT 5 AFTER work_start_time;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND COLUMN_NAME = 'created_at'
  ) THEN
    ALTER TABLE employees
      ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER late_grace_minutes;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' AND INDEX_NAME = 'uk_employees_rfid'
  ) THEN
    ALTER TABLE employees ADD UNIQUE KEY uk_employees_rfid (rfid_card_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'rfid_card_id'
  ) THEN
    ALTER TABLE sessions ADD COLUMN rfid_card_id VARCHAR(128) NULL AFTER longitude;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'sessions' AND COLUMN_NAME = 'access_method'
  ) THEN
    ALTER TABLE sessions
      ADD COLUMN access_method VARCHAR(32) NOT NULL DEFAULT 'face_gps_rfid' AFTER rfid_card_id;
  END IF;
END$$

DELIMITER ;

CALL surv_apply_migrations();
DROP PROCEDURE IF EXISTS surv_apply_migrations;

-- Права пользователя test (если уже создан — можно выполнить повторно)
GRANT ALL PRIVILEGES ON surv.* TO 'test'@'localhost';
FLUSH PRIVILEGES;

SELECT 'СКУД / СУРВ: база surv готова' AS status;
