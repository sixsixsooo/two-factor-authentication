-- Миграция для уже существующей базы surv (роли + RFID + журнал доступа)
USE surv;

ALTER TABLE employees ADD COLUMN role ENUM('employee','accountant') NOT NULL DEFAULT 'employee';
ALTER TABLE employees ADD COLUMN rfid_card_id VARCHAR(128) NULL;
ALTER TABLE employees ADD COLUMN work_start_time TIME NOT NULL DEFAULT '09:00:00';
ALTER TABLE employees ADD COLUMN late_grace_minutes INT NOT NULL DEFAULT 5;

-- Если колонка уже есть — MySQL выдаст ошибку, пропустите эту строку:
-- CREATE UNIQUE INDEX idx_employees_rfid ON employees (rfid_card_id);

ALTER TABLE sessions ADD COLUMN rfid_card_id VARCHAR(128) NULL;
ALTER TABLE sessions ADD COLUMN access_method VARCHAR(32) NOT NULL DEFAULT 'face_gps_rfid';

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
