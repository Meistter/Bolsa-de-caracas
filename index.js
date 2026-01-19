const API_BASE = "/api/bolsa";
const POLL_INTERVAL = 60000; // Consultar cada 60 segundos para detectar cambios rápido
let marketData = [];
const charts = {};
let mainChart = null;
let selectedSymbol = null;
let currentRange = 1;
let globalRange = 7; // Rango por defecto para el dashboard general
let lastUpdateTimestamp = null;

async function fetchData() {
  try {
    const response = await fetch(`${API_BASE}/actual`);
    const newData = await response.json();

    if (newData.length === 0) {
      return; // No hay datos, no hacemos nada.
    }

    const newTimestamp = newData[0].fecha_registro;

    // Si la fecha del último registro es la misma, no repintamos nada.
    if (newTimestamp === lastUpdateTimestamp) {
      return;
    }

    // Datos nuevos detectados, actualizamos todo.
    marketData = newData;
    lastUpdateTimestamp = newTimestamp;

    const lastUpdate = new Date(newTimestamp);
    document.getElementById("status-text").innerText = `Última Sincronización: ${lastUpdate.toLocaleTimeString()}`;

    updateGeneralView();
    updateSidebar();
    createGlobalRangeSelector();

    // Las miniaturas usan el rango global seleccionado
    marketData.forEach((item) => loadHistory(item.symbol, globalRange, false));

    if (selectedSymbol) {
      updateIndividualView();
      loadHistory(selectedSymbol, currentRange, true);
    }
  } catch (error) {
    document.getElementById("status-text").innerText = "Servidor Desconectado";
  }
}

async function setRange(days, btn) {
  currentRange = days;
  document
    .querySelectorAll(".range-btn")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  if (selectedSymbol) await loadHistory(selectedSymbol, currentRange, true);
}

// Función para crear e inyectar el selector global si no existe
function createGlobalRangeSelector() {
  const viewAll = document.getElementById("view-all");
  if (!viewAll || document.getElementById("global-range-selector")) return;

  const container = document.createElement("div");
  container.id = "global-range-selector";
  container.className = "range-selector";
  container.style.maxWidth = "1400px";
  container.style.margin = "20px auto 0 auto";
  container.style.padding = "0 20px";

  [1, 3, 7, 15, 30].forEach((days) => {
    const btn = document.createElement("button");
    btn.className = `range-btn ${days === globalRange ? "active" : ""}`;
    btn.innerText = days === 1 ? "Hoy" : `${days} Días`;
    btn.onclick = () => setGlobalRange(days, btn);
    container.appendChild(btn);
  });

  const dashboard = document.getElementById("dashboard");
  viewAll.insertBefore(container, dashboard);
}

async function setGlobalRange(days, btn) {
  globalRange = days;
  const container = document.getElementById("global-range-selector");
  Array.from(container.children).forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  // Recargar todas las gráficas del dashboard
  marketData.forEach((item) => loadHistory(item.symbol, globalRange, false));
}

async function loadHistory(symbol, days, isLarge) {
  try {
    const response = await fetch(`${API_BASE}/historial/${symbol}/${days}`);
    const history = await response.json();

    const chart = isLarge ? mainChart : charts[symbol];
    if (chart && history.length > 0) {
      // Lógica de etiquetas: Si el rango es grande, mostramos menos etiquetas para que no se amontonen
      chart.data.labels = history.map((h, index) => {
        const dateObj = new Date(h.fecha_registro);
        const timePart = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
        const year = dateObj.getFullYear();
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getDate()).padStart(2, '0');
        const datePart = `${day}/${month}/${year}`;

        if (!isLarge) return days > 1 ? datePart : timePart;

        // Si son 30 días, mostramos la fecha cada 5 días (ya que ahora hay 1 punto por día)
        if (days >= 15) {
          return index % 5 === 0 ? datePart : "";
        }
        // Para rangos > 1 día (3 o 7), mostramos solo la fecha
        return days > 1 ? datePart : timePart;
      });

      chart.data.datasets[0].data = history.map((h) => h.precio);

      const last = history[history.length - 1];
      const isUp = parseFloat(last.var_abs) >= 0;
      chart.data.datasets[0].borderColor = isUp ? "#22c55e" : "#ef4444";
      chart.data.datasets[0].backgroundColor = isUp
        ? "rgba(34, 197, 148, 0.1)"
        : "rgba(239, 68, 68, 0.1)";

      chart.update(isLarge ? "active" : "none");
    }
  } catch (e) {
    console.error("Error historial:", e);
  }
}

function switchView(view) {
  document.getElementById("view-all").style.display =
    view === "all" ? "block" : "none";
  document.getElementById("view-single").style.display =
    view === "single" ? "flex" : "none";
  document.getElementById("btn-all").classList.toggle("active", view === "all");
  document
    .getElementById("btn-single")
    .classList.toggle("active", view === "single");
  if (view === "single" && !selectedSymbol && marketData.length > 0)
    selectCompany(marketData[0].symbol);
}

function updateGeneralView() {
  const container = document.getElementById("dashboard");
  marketData.forEach((item) => {
    const id = item.symbol;
    if (!document.getElementById(`container-${id}`)) {
      const card = document.createElement("div");
      card.className = "card";
      card.id = `container-${id}`;
      card.innerHTML = `
                        <div class="company-header">
                            <img src="${item.icon}" class="logo" onerror="this.src='https://via.placeholder.com/32'">
                            <div>
                                <div style="color:var(--accent); font-weight:bold; font-size:0.8rem">${id}</div>
                                <div style="font-size:0.75rem; color:#94a3b8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:180px;">${item.nombre}</div>
                            </div>
                        </div>
                        <div class="price" id="price-${id}" style="font-size:1.4rem">0</div>
                        <div id="var-${id}" style="font-size:0.8rem; margin-bottom:10px;">0</div>
                        <div class="card-chart-wrapper"><canvas id="chart-${id}"></canvas></div>
                    `;
      container.appendChild(card);
      initChart(`chart-${id}`, id, false);
    }
    updateUIElements(item, `price-${id}`, `var-${id}`);
  });
}

function updateSidebar() {
  const sidebar = document.getElementById("sidebar-list");
  if (sidebar.children.length > 0) return;
  marketData.forEach((item) => {
    const div = document.createElement("div");
    div.className = "sidebar-item";
    div.id = `side-${item.symbol}`;
    div.innerHTML = `<img src="${item.icon}" class="logo" style="width:24px; height:24px;"> <span>${item.symbol}</span>`;
    div.onclick = () => selectCompany(item.symbol);
    sidebar.appendChild(div);
  });
}

async function selectCompany(symbol) {
  selectedSymbol = symbol;
  document
    .querySelectorAll(".sidebar-item")
    .forEach((el) => el.classList.remove("active"));
  if (document.getElementById(`side-${symbol}`))
    document.getElementById(`side-${symbol}`).classList.add("active");
  if (mainChart) mainChart.destroy();
  initChart("main-large-chart", symbol, true);
  updateIndividualView();
  await loadHistory(symbol, currentRange, true);
}

function updateIndividualView() {
  const item = marketData.find((c) => c.symbol === selectedSymbol);
  if (!item) return;
  document.getElementById("single-logo").src = item.icon;
  document.getElementById("single-title").innerText = item.nombre;
  document.getElementById("single-symbol").innerText = item.symbol;
  updateUIElements(item, "single-price", "single-var");

  document.getElementById("single-stats").innerHTML = `
                <div class="stat-box"><span class="stat-label">Volumen</span><span class="stat-val">${item.volumen}</span></div>
                <div class="stat-box"><span class="stat-label">Monto Efectivo</span><span class="stat-val">${parseFloat(item.monto_efectivo).toLocaleString("es-VE")} VES</span></div>
                <div class="stat-box"><span class="stat-label">Var. Absoluta</span><span class="stat-val">${item.var_abs}</span></div>
                <div class="stat-box"><span class="stat-label">Var. Relativa</span><span class="stat-val">${item.var_rel}%</span></div>
                <div class="stat-box"><span class="stat-label">Último Registro</span><span class="stat-val">${item.hora}</span></div>
            `;
}

function updateUIElements(item, priceId, varId) {
  const price = parseFloat(item.precio);
  const varAbs = parseFloat(item.var_abs);
  const isUp = varAbs >= 0;
  const colorClass = isUp ? "up" : "down";
  const pEl = document.getElementById(priceId);
  if (pEl) {
    pEl.innerText = price.toLocaleString("es-VE", { minimumFractionDigits: 2 });
    pEl.className = `price ${colorClass}`;
  }
  const vEl = document.getElementById(varId);
  if (vEl) {
    vEl.innerText = `${isUp ? "▲" : "▼"} ${item.var_abs} (${item.var_rel}%)`;
    vEl.className = `variation ${colorClass}`;
  }
}

function initChart(canvasId, storageId, isLarge) {
  const ctx = document.getElementById(canvasId).getContext("2d");
  const config = {
    type: "line",
    data: {
      labels: [],
      datasets: [
        {
          data: [],
          borderWidth: 2,
          tension: 0.2,
          fill: true,
          pointRadius: isLarge ? 1 : 0,
          pointHitRadius: 10,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          display: isLarge,
          grid: { display: false },
          ticks: {
            color: "#64748b",
            font: { size: 9 },
            maxRotation: 0,
            autoSkip: false,
          },
        },
        y: {
          grid: { color: "rgba(255,255,255,0.05)" },
          ticks: { color: "#94a3b8", font: { size: 10 } },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: { mode: "index", intersect: false },
      },
    },
  };
  if (isLarge) mainChart = new Chart(ctx, config);
  else charts[storageId] = new Chart(ctx, config);
}

// Iniciar la aplicación
fetchData(); // Primera carga inmediata
setInterval(fetchData, POLL_INTERVAL); // Actualización automática cada minuto
