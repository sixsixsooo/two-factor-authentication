/**
 * Считывание RFID через эмуляцию клавиатуры (keyboard wedge).
 * Считыватель «печатает» ID и часто завершает Enter.
 */
(function (global) {
  'use strict';

  function normalizeCardId(raw) {
    return String(raw || '')
      .replace(/[\r\n]/g, '')
      .trim()
      .toUpperCase();
  }

  /**
   * @param {object} opts
   * @param {(cardId: string) => void} opts.onScan
   * @param {number} [opts.minLength=3]
   * @param {number} [opts.maxLength=64]
   * @param {number} [opts.idleMs=120] — если Enter не пришёл, сброс буфера по паузе
   */
  function createRfidReader(opts) {
    const onScan = opts.onScan;
    const minLength = opts.minLength != null ? opts.minLength : 3;
    const maxLength = opts.maxLength != null ? opts.maxLength : 64;
    const idleMs = opts.idleMs != null ? opts.idleMs : 120;

    let buffer = '';
    let idleTimer = null;
    let attached = false;
    let hiddenInput = null;

    function flush() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      const id = normalizeCardId(buffer);
      buffer = '';
      if (hiddenInput) hiddenInput.value = '';
      if (id.length >= minLength && id.length <= maxLength) {
        onScan(id);
      }
    }

    function scheduleIdleFlush() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(flush, idleMs);
    }

    function onKeyDown(e) {
      if (!attached) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        flush();
        return;
      }
      if (e.key === 'Escape') {
        buffer = '';
        if (hiddenInput) hiddenInput.value = '';
        return;
      }
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (buffer.length < maxLength) {
          buffer += e.key;
          if (hiddenInput) hiddenInput.value = buffer;
          scheduleIdleFlush();
        }
      }
    }

    function onInput() {
      if (!hiddenInput) return;
      buffer = hiddenInput.value;
      scheduleIdleFlush();
    }

    return {
      attach: function (inputEl) {
        if (attached) return;
        attached = true;
        hiddenInput = inputEl || null;
        document.addEventListener('keydown', onKeyDown, true);
        if (hiddenInput) {
          hiddenInput.addEventListener('input', onInput);
          hiddenInput.setAttribute('autocomplete', 'off');
          hiddenInput.setAttribute('autocorrect', 'off');
          hiddenInput.setAttribute('spellcheck', 'false');
        }
      },
      detach: function () {
        attached = false;
        buffer = '';
        document.removeEventListener('keydown', onKeyDown, true);
        if (hiddenInput) hiddenInput.removeEventListener('input', onInput);
      },
      focus: function () {
        if (hiddenInput) {
          hiddenInput.focus();
          hiddenInput.select();
        }
      },
      clear: function () {
        buffer = '';
        if (hiddenInput) hiddenInput.value = '';
      }
    };
  }

  global.SurvRfid = {
    create: createRfidReader,
    normalizeCardId: normalizeCardId
  };
})(typeof window !== 'undefined' ? window : global);
