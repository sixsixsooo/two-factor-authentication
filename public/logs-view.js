const tbody = document.getElementById('logsBody');

async function loadLogs() {
  try {
    const resp = await fetch('/logs');
    const data = await resp.json();
    tbody.innerHTML = '';
    (data.logs || []).forEach((log) => {
      const tr = document.createElement('tr');
      const t = new Date(log.timestamp).toLocaleString();
      tr.innerHTML = `
        <td>${t}</td>
        <td>${log.type}</td>
        <td>${log.message}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (e) {
    console.error(e);
  }
}

window.addEventListener('DOMContentLoaded', loadLogs);

