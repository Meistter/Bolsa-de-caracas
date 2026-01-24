// Configurar Favicon (logo.ico)
const faviconLink = document.createElement("link");
faviconLink.rel = "icon";
faviconLink.href = "logo.ico";
document.head.appendChild(faviconLink);

const API_BASE = "/api/bolsa";
let marketData = [];
const charts = {};
let mainChart = null;
let selectedSymbol = null;
let currentRange = 1;
let globalRange = 1; // Rango por defecto para el dashboard general
let lastUpdateTimestamp = null;

function getSafeId(symbol) {
  return symbol.replace(/[^a-zA-Z0-9]/g, '-');
}

function processNewData(newData) {
    // Datos nuevos detectados, actualizamos todo.
    marketData = newData;
    const newTimestamp = newData[0].fecha_registro;
    lastUpdateTimestamp = newTimestamp;

    const lastUpdate = new Date(newTimestamp);
    document.getElementById("status-text").innerText = `Última Sincronización: ${lastUpdate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })}`;

    updateGeneralView();
    updateSidebar();
    createGlobalRangeSelector();

    // Las miniaturas usan el rango global seleccionado
    marketData.forEach((item) => loadHistory(item.symbol, globalRange, false));

    if (selectedSymbol) {
      updateIndividualView();
      loadHistory(selectedSymbol, currentRange, true);
    }
}

async function fetchData() {
  try {
    const response = await fetch(`${API_BASE}/actual`);
    if (!response.ok) {
      const errorText = await response.text();
      document.getElementById("status-text").innerText = `Error ${response.status}: ${response.statusText}\n${errorText}`;
      console.error(`Error ${response.status}: ${response.statusText}`, errorText);
      return;
    }
    const newData = await response.json();

    if (newData.length === 0) {
      return; // No hay datos, no hacemos nada.
    }

    const newTimestamp = newData[0].fecha_registro;

    // Si la fecha del último registro es la misma, no repintamos nada.
    if (newTimestamp === lastUpdateTimestamp) {
      return;
    }

    processNewData(newData);
  } catch (error) {
    document.getElementById("status-text").innerText = `Servidor Desconectado: ${error.message}`;
    console.error("Error en fetchData:", error);
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
    btn.innerText = days === 1 ? "Últimas 24h" : `${days} Días`;
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
    const response = await fetch(`${API_BASE}/historial/${encodeURIComponent(symbol)}/${days}`);
    const history = await response.json();

    // Asegurar orden cronológico
    history.sort((a, b) => new Date(a.fecha_registro) - new Date(b.fecha_registro));

    // Calcular variación y color basado en el historial cargado (Calculado por nosotros)
    let isUp = true;
    let diff = 0;
    let percent = 0;

    if (history.length > 0) {
      const startPrice = parseFloat(String(history[0].precio).replace(',', '.'));
      const endPrice = parseFloat(String(history[history.length - 1].precio).replace(',', '.'));
      diff = endPrice - startPrice;
      percent = startPrice !== 0 ? (diff / startPrice) * 100 : 0;
      isUp = diff >= 0;
    }

    // Actualizar texto de variación en la UI con el cálculo propio
    const arrow = isUp ? "▲" : "▼";
    const colorClass = isUp ? "up" : "down";
    const diffStr = diff.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const percentStr = percent.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const varText = `${arrow} ${diffStr} (${percentStr}%)`;

    const safeSymbol = getSafeId(symbol);
    const varEl = isLarge ? document.getElementById("single-var") : document.getElementById(`var-${safeSymbol}`);
    if (varEl) {
      varEl.innerText = varText;
      varEl.className = `variation ${colorClass}`;
    }

    // Actualizar también el color del precio para que coincida con la variación calculada
    const priceEl = isLarge ? document.getElementById("single-price") : document.getElementById(`price-${safeSymbol}`);
    if (priceEl) {
      priceEl.className = `price ${colorClass}`;
    }

    const chart = isLarge ? mainChart : charts[symbol];
    if (chart && history.length > 0) {
      // Generar etiquetas: Mostramos fecha y hora, Chart.js ocultará las que no quepan
      chart.data.labels = history.map((h) => {
        const dateObj = new Date(h.fecha_registro);
        const timePart = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
        const month = String(dateObj.getMonth() + 1).padStart(2, '0');
        const day = String(dateObj.getDate()).padStart(2, '0');
        const datePart = `${day}/${month}`;
        
        return days > 1 ? `${datePart} ${timePart}` : timePart;
      });

      chart.data.datasets[0].data = history.map((h) => parseFloat(String(h.precio).replace(',', '.')));

      chart.data.datasets[0].borderColor = isUp ? "#22c55e" : "#ef4444";
      chart.data.datasets[0].backgroundColor = isUp
        ? "rgba(34, 197, 148, 0.1)"
        : "rgba(239, 68, 68, 0.1)";

      chart.update();
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
    const safeSymbol = getSafeId(item.symbol);
    const id = item.symbol;
    if (!document.getElementById(`container-${safeSymbol}`)) {
      const card = document.createElement("div");
      card.className = "card";
      card.id = `container-${safeSymbol}`;
      card.innerHTML = `
                        <div class="company-header">
                            <img src="${item.icon}" class="logo" onerror="this.src='https://via.placeholder.com/32'">
                            <div>
                                <div style="color:var(--accent); font-weight:bold; font-size:1rem">${id}</div>
                                <div style="font-size:1rem; color:#94a3b8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; width:240px;">${item.nombre}</div>
                            </div>
                        </div>
                        <div class="price" id="price-${safeSymbol}" style="font-size:1.4rem">0</div>
                        <div id="var-${safeSymbol}" style="font-size:0.8rem; margin-bottom:10px;">0</div>
                        <div class="card-chart-wrapper"><canvas id="chart-${safeSymbol}"></canvas></div>
                    `;
      container.appendChild(card);
      initChart(`chart-${safeSymbol}`, id, false);
    }
    updateUIElements(item, `price-${safeSymbol}`, `var-${safeSymbol}`);
  });
}

function updateSidebar() {
  const sidebar = document.getElementById("sidebar-list");
  if (sidebar.children.length > 0) return;
  marketData.forEach((item) => {
    const div = document.createElement("div");
    div.className = "sidebar-item";
    div.id = `side-${getSafeId(item.symbol)}`;
    div.innerHTML = `<img src="${item.icon}" class="logo" style="width:24px; height:24px;"> 
                     <div style="display:flex; flex-direction:column; margin-left:10px; line-height:1.2;">
                        <span style="font-size:1rem; font-weight:bold;">${item.nombre}</span>
                        <span style="font-size:1rem; color:#94a3b8;">${item.symbol}</span>
                     </div>`;
    div.onclick = () => selectCompany(item.symbol);
    sidebar.appendChild(div);
  });
}

async function selectCompany(symbol) {
  selectedSymbol = symbol;
  document
    .querySelectorAll(".sidebar-item")
    .forEach((el) => el.classList.remove("active"));
  const safeSymbol = getSafeId(symbol);
  if (document.getElementById(`side-${safeSymbol}`))
    document.getElementById(`side-${safeSymbol}`).classList.add("active");
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
                <div class="stat-box"><span class="stat-label">Último Registro</span><span class="stat-val">${new Date(item.fecha_registro).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true })}</span></div>
            `;
}

function updateUIElements(item, priceId, varId) {
  const price = parseFloat(item.precio);
  let varAbs = parseFloat(String(item.var_abs).replace(',', '.'));
  if (isNaN(varAbs)) varAbs = 0;
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
            autoSkip: true, // Permitir saltar etiquetas para evitar superposición
            maxTicksLimit: isLarge ? 10 : 5, // Limitar cantidad máxima de fechas en el eje X
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

function updateMarketStatus() {
  const now = new Date();
  const caracasTime = new Date(now.toLocaleString("en-US", { timeZone: "America/Caracas" }));
  const day = caracasTime.getDay();
  const hour = caracasTime.getHours();

  // Lunes (1) a Viernes (5), 9am a 1pm (13:00)
  const isOpen = (day >= 1 && day <= 5) && (hour >= 9 && hour < 13);

  const statusText = isOpen ? "Abierto" : "Cerrado";
  const color = isOpen ? "#22c55e" : "#ef4444";

  let statusEl = document.getElementById("market-status");
  if (!statusEl) {
    // Intentar insertar antes de status-text si existe, para ubicarlo en el header
    const statusTextEl = document.getElementById("status-text");
    if (statusTextEl && statusTextEl.parentNode) {
      statusEl = document.createElement("div");
      statusEl.id = "market-status";
      statusEl.style.fontWeight = "bold";
      statusEl.style.marginBottom = "5px";
      statusTextEl.parentNode.insertBefore(statusEl, statusTextEl);
    }
  }

  if (statusEl) {
    statusEl.innerHTML = `Estado del Mercado: <span style="color:${color}">${statusText}</span>`;
  }
}

function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        console.log('WebSocket conectado.');
    };

    ws.onmessage = (event) => {
        const newData = JSON.parse(event.data);
        if (newData.length > 0 && newData[0].fecha_registro !== lastUpdateTimestamp) {
            console.log('Nuevos datos recibidos vía WebSocket.');
            processNewData(newData);
        }
    };

    ws.onclose = () => {
        console.log('WebSocket desconectado. Intentando reconectar en 5 segundos...');
        setTimeout(connectWebSocket, 5000);
    };
}

// Iniciar la aplicación
fetchData(); // Primera carga inmediata
updateMarketStatus(); // Verificar estado inicial
setInterval(updateMarketStatus, 60000); // Actualizar estado cada minuto
connectWebSocket(); // Iniciar conexión WebSocket
