/* ── Config ─────────────────────────────────────────────────── */
const API_BASE_URL = '';
const POLL_INTERVAL = 5000; // ms

const TILES = {
  dark: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  light: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
};

/* ── Fetch Interceptor (Logs) ───────────────────────────────── */
const originalFetch = window.fetch;
window.fetch = async function (...args) {
  const method = (args[1] && args[1].method) || 'GET';
  const url = typeof args[0] === 'string' ? args[0] : args[0].url;
  let path = url.replace(API_BASE_URL, '');

  // Clean up cache buster from logs
  if (path.includes('?t=')) path = path.split('?t=')[0];

  const startTime = performance.now();
  try {
    const response = await originalFetch(...args);
    const duration = Math.round(performance.now() - startTime);
    addLog(method, path, response.status, duration);
    return response;
  } catch (error) {
    const duration = Math.round(performance.now() - startTime);
    addLog(method, path, 'ERR', duration);
    throw error;
  }
};

function addLog(method, path, status, duration) {
  const el = document.getElementById('log-list');
  if (!el) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const statusClass = status >= 200 && status < 300 ? 'ok' : 'err';
  entry.innerHTML = `
    <div class="log-row-1"><span>${time}</span><span class="log-status ${statusClass}">${status} (${duration}ms)</span></div>
    <div class="log-row-2"><span class="log-method ${method.toLowerCase()}">${method}</span><span>${path}</span></div>
  `;
  el.prepend(entry);
  if (el.children.length > 100) el.removeChild(el.lastChild); // keep max 100 logs
}

function clearLogs() {
  const el = document.getElementById('log-list');
  if (el) el.innerHTML = '';
}


/* ── State ──────────────────────────────────────────────────── */
let map;
let tileLayer;                   // active Leaflet tile layer
let mapLayers = {};              // gatewayId -> { marker, circles[] }
let gateways = {};               // gatewayId -> gateway object
let latestReadings = [];
let lastPollTime = null;
let editingGwId = null;          // null = adding, string = editing
let pickingCoords = false;
let prevTimestamps = {};         // `${nodeId}_${gwId}` -> last seen timestamp
let lastSeenEventId = 0;         // track backend events

// Circle popup state
let allCircles = [];             // flat list: { circle, reading } sorted oldest->newest
let currentPopupState = null;    // { latlng, matches, index } — persists across redraws
let cyclePopupLayer = null;      // the L.popup instance currently on map

/* ── Node colour palette ────────────────────────────────────── */
const NODE_COLORS = [
  '#06b6d4', // cyan
  '#a855f7', // purple
  '#ec4899', // pink
  '#eab308', // yellow
  '#84cc16', // lime
  '#f97316', // orange
  '#14b8a6', // teal
  '#6366f1', // indigo
  '#f43f5e', // rose
  '#0ea5e9', // sky
];
const nodeColorMap = {};
let nodeColorIndex = 0;

function getNodeColor(nodeId) {
  if (!nodeColorMap[nodeId]) {
    nodeColorMap[nodeId] = NODE_COLORS[nodeColorIndex % NODE_COLORS.length];
    nodeColorIndex++;
  }
  return nodeColorMap[nodeId];
}

/* ── Auth ───────────────────────────────────────────────────── */
async function checkAuth() {
  try {
    const res = await originalFetch(`${API_BASE_URL}/api/auth/me`);
    if (res.ok) {
      const data = await res.json();
      document.getElementById('hdr-username').textContent = data.username;
      hideLoginOverlay();
      return true;
    }
  } catch (e) { /* network error — treat as unauth */ }
  showLoginOverlay();
  return false;
}

function showLoginOverlay() {
  const overlay = document.getElementById('login-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

function hideLoginOverlay() {
  const overlay = document.getElementById('login-overlay');
  if (overlay) overlay.classList.add('hidden');
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = document.getElementById('login-submit-btn');
  const errEl = document.getElementById('login-error');
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;

  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const res = await originalFetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      credentials: 'same-origin',
    });
    if (res.ok) {
      const data = await res.json();
      document.getElementById('hdr-username').textContent = data.username;
      hideLoginOverlay();
      // Kick off the app now that we're logged in
      initApp();
    } else {
      const err = await res.json().catch(() => ({}));
      errEl.textContent = err.detail || 'Invalid credentials';
    }
  } catch (e) {
    errEl.textContent = 'Network error — please try again';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

async function logout() {
  await originalFetch(`${API_BASE_URL}/api/auth/logout`, {
    method: 'POST',
    credentials: 'same-origin',
  });
  document.getElementById('hdr-username').textContent = '';
  showLoginOverlay();
  // Reset card animation so it replays
  const card = document.querySelector('.login-card');
  if (card) {
    card.style.animation = 'none';
    void card.offsetWidth;
    card.style.animation = '';
  }
}

let appInitialized = false;

function initApp() {
  if (appInitialized) {
    // Already running — just kick a fresh poll (map + timers are still alive)
    refresh();
    return;
  }
  appInitialized = true;
  initMap();
  fetchModelParams();
  refresh();
  setInterval(refresh, POLL_INTERVAL);
  setInterval(updateLiveText, 1000);
}

/* ── Init ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', async () => {
  const authed = await checkAuth();
  if (authed) {
    initApp();
  }
});

/* ── Map ────────────────────────────────────────────────────── */
function initMap() {
  map = L.map('map', { zoomControl: false });

  tileLayer = L.tileLayer(getTileUrl(), {
    attribution: 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ',
    maxNativeZoom: 16,
    maxZoom: 19,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const savedState = localStorage.getItem('loraMapState');
  if (savedState) {
    try {
      const state = JSON.parse(savedState);
      map.setView([state.lat, state.lng], state.zoom);
    } catch (e) {
      setDefaultView();
    }
  } else {
    setDefaultView();
  }

  function setDefaultView() {
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (p) => map.setView([p.coords.latitude, p.coords.longitude], 15),
        () => map.setView([3.14, 101.69], 14)
      );
    } else {
      map.setView([3.14, 101.69], 14);
    }
  }

  map.on('moveend', saveMapState);
  map.on('zoomend', saveMapState);

  function saveMapState() {
    const center = map.getCenter();
    const state = {
      lat: center.lat,
      lng: center.lng,
      zoom: map.getZoom()
    };
    localStorage.setItem('loraMapState', JSON.stringify(state));
  }

  map.on('click', (e) => {
    if (pickingCoords) {
      document.getElementById('gw-lat').value = e.latlng.lat.toFixed(6);
      document.getElementById('gw-lng').value = e.latlng.lng.toFixed(6);
      toast('📍 Coordinates set from map', 'success');
      return;
    }
    // Find circles at clicked point and open a navigable popup
    const matches = findCirclesAtPoint(e.latlng);
    if (matches.length > 0) {
      // Start at the newest (last in array, rendered on top)
      showCirclePopup(e.latlng, matches, matches.length - 1);
    } else {
      currentPopupState = null;
      if (cyclePopupLayer) {
        cyclePopupLayer.removeFrom(map);
      }
    }
  });

  // Re-enable native double-click zoom
  map.doubleClickZoom.enable();
}

/* ── Polling ────────────────────────────────────────────────── */
async function refresh() {
  try {
    const ts = Date.now();
    const [gwRes, rdRes, evRes] = await Promise.all([
      fetch(`${API_BASE_URL}/api/gateways?t=${ts}`),
      fetch(`${API_BASE_URL}/api/readings/latest?t=${ts}`),
      fetch(`${API_BASE_URL}/api/chirpstack/events?t=${ts}`),
    ]);
    const gwData = await gwRes.json();
    const rdData = await rdRes.json();
    const evData = await evRes.json();

    gateways = {};
    gwData.forEach(g => (gateways[g.id] = g));
    latestReadings = rdData;

    // Inject backend events into Logs UI
    evData.forEach(ev => {
      if (ev.id > lastSeenEventId) {
        addLog(ev.method, ev.path, ev.status, ev.duration);
        lastSeenEventId = ev.id;
      }
    });

    updateMap();
    renderGatewayList(gwData);
    renderNodeList(rdData);
    updateHeaderStats(gwData, rdData);

    if (document.getElementById('tab-battery').classList.contains('active')) {
      updateBatteryChart();
    }

    lastPollTime = Date.now();
    pulseLiveDot();
  } catch (e) {
    console.error('Poll failed:', e);
    document.getElementById('live-dot').classList.add('stale');
    document.getElementById('live-text').textContent = 'Disconnected';
  }
}

/* ── Map rendering ──────────────────────────────────────────── */
function updateMap() {
  // Clear old layers
  Object.values(mapLayers).forEach(({ marker, circles }) => {
    marker?.remove();
    circles?.forEach(c => c.remove());
  });
  mapLayers = {};
  allCircles = [];    // reset circle registry
  currentPopupState = null; // will be restored at end if popup was open

  // Group readings by gateway
  const byGw = {};
  latestReadings.forEach(r => {
    if (!byGw[r.gateway_id]) byGw[r.gateway_id] = [];
    byGw[r.gateway_id].push(r);
  });

  // ── Pass 1: gateways WITH readings — coloured marker + circles ──
  Object.entries(byGw).forEach(([gwId, readings]) => {
    const gw = gateways[gwId];
    if (!gw || gw.latitude == null || gw.longitude == null) return;

    const newest = readings.reduce((a, b) =>
      new Date(a.timestamp) > new Date(b.timestamp) ? a : b
    );
    const ageSecs = (Date.now() - new Date(newest.timestamp + 'Z').getTime()) / 1000;
    // Gateway marker: green if any fresh traffic, grey otherwise
    const gwColor = ageSecs < 150 ? '#22c55e' : '#64748b';

    const icon = L.divIcon({
      html: `<div class="gw-marker" style="background:${gwColor}; color:${gwColor};"></div>`,
      className: '', iconSize: [18, 18], iconAnchor: [9, 9],
    });
    const marker = L.marker([gw.latitude, gw.longitude], { icon }).addTo(map);
    marker.bindPopup(buildGwPopup(gw, readings));

    // Sort readings oldest→newest so newest circle renders on top (clickable first)
    readings.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const circles = readings.map(r => {
      if (!r.predicted_distance) return null;
      // Each circle uses the node's unique colour when fresh, grey when stale
      const rAgeSecs = (Date.now() - new Date(r.timestamp + 'Z').getTime()) / 1000;
      const nodeColor = rAgeSecs < 150 ? getNodeColor(r.node_id) : '#64748b';
      const circle = L.circle([gw.latitude, gw.longitude], {
        radius: r.predicted_distance,
        color: nodeColor,
        fillColor: nodeColor,
        fillOpacity: 0.06,
        weight: 2,
        opacity: 0.75,
      }).addTo(map);
      // No bindPopup — popup handled by map click handler

      // Register in flat list for popup system
      allCircles.push({ circle, reading: r });

      // ── Pulse on new data ──
      const key = `${r.node_id}_${gwId}`;
      if (prevTimestamps[key] !== r.timestamp) {
        prevTimestamps[key] = r.timestamp;
        firePulse(gw.latitude, gw.longitude, r.predicted_distance, nodeColor);
        flashMarker(marker, gwColor);
      }

      return circle;
    }).filter(Boolean);

    mapLayers[gwId] = { marker, circles };
  });

  // ── Pass 2: gateways WITHOUT readings — grey idle marker, no circle ──
  Object.values(gateways).forEach(gw => {
    if (mapLayers[gw.id]) return;                          // already drawn above
    if (gw.latitude == null || gw.longitude == null) return; // no coords set yet

    const icon = L.divIcon({
      html: `<div class="gw-marker" style="background:#334155; color:#334155; border-color: rgba(255,255,255,0.2);"></div>`,
      className: '', iconSize: [18, 18], iconAnchor: [9, 9],
    });
    const marker = L.marker([gw.latitude, gw.longitude], { icon }).addTo(map);
    marker.bindPopup(`<div class="popup-content">
      <h3>🗼 ${escHtml(gw.name)}</h3>
      <div class="popup-row"><span>EUI</span><span>${escHtml(gw.id)}</span></div>
      <div class="popup-row"><span>Status</span><span style="color:#64748b">No traffic yet</span></div>
      <div class="popup-row"><span>Lat / Lng</span><span>${gw.latitude.toFixed(5)}, ${gw.longitude.toFixed(5)}</span></div>
    </div>`);

    mapLayers[gw.id] = { marker, circles: [] };
  });

  // ── Restore popup if one was open before the redraw ──
  if (cyclePopupLayer && map.hasLayer(cyclePopupLayer) && cyclePopupLayer._latlng) {
    const savedLatlng = cyclePopupLayer._latlng;
    const savedNodeId = cyclePopupLayer._nodeId;
    const newMatches = findCirclesAtPoint(savedLatlng);
    if (newMatches.length > 0) {
      // Try to restore same node, otherwise stay at last index
      let idx = newMatches.findIndex(m => m.reading.node_id === savedNodeId);
      if (idx === -1) idx = newMatches.length - 1;
      showCirclePopup(savedLatlng, newMatches, idx);
    } else {
      cyclePopupLayer = null;
    }
  }
}

/* ── Circle popup helpers ─────────────────────────────────── */
// Find all registered circles whose radius contains the given latlng
function findCirclesAtPoint(latlng) {
  return allCircles.filter(({ circle }) => {
    const dist = map.distance(latlng, circle.getLatLng());
    return dist <= circle.getRadius();
  });
}

// Open (or update) the navigable popup for the given set of circles
function showCirclePopup(latlng, matches, index) {
  currentPopupState = { latlng, matches, index };

  const { reading } = matches[index];
  const total = matches.length;
  const current = index + 1;

  const dotColor = getNodeColor(reading.node_id);

  let navHtml = '';
  if (total > 1) {
    navHtml = `
      <div class="popup-nav" onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" ondblclick="event.stopPropagation()">
        <button class="popup-nav-btn" onclick="cyclePopup(event, -1)">←</button>
        <span class="popup-nav-label">
          <span class="popup-nav-dot" style="background:${dotColor}"></span>
          ${current} of ${total}
        </span>
        <button class="popup-nav-btn" onclick="cyclePopup(event, 1)">→</button>
      </div>`;
  }

  const content = buildReadingPopup(reading) + navHtml;

  if (!cyclePopupLayer) {
    cyclePopupLayer = L.popup({ closeButton: true, autoClose: false, closeOnClick: false })
      .setLatLng(latlng)
      .setContent(content)
      .openOn(map);
  } else {
    cyclePopupLayer.setLatLng(latlng).setContent(content);
    if (!map.hasLayer(cyclePopupLayer)) cyclePopupLayer.openOn(map);
  }

  // Tag with current node so we can restore after redraw
  cyclePopupLayer._nodeId = reading.node_id;
  cyclePopupLayer._latlng = latlng;
}

// Called from popup nav buttons
function cyclePopup(e, direction) {
  if (e) {
    e.stopPropagation();
    if (L.DomEvent && L.DomEvent.stopPropagation) L.DomEvent.stopPropagation(e);
  }
  if (!currentPopupState) return;
  const { latlng, matches } = currentPopupState;
  const newIndex = (currentPopupState.index + direction + matches.length) % matches.length;
  showCirclePopup(latlng, matches, newIndex);
}

/* ── Pulse animation on new reading ────────────────────────── */
function firePulse(lat, lng, radius, color) {
  const ring = L.circle([lat, lng], {
    radius,
    color,
    fillColor: color,
    fillOpacity: 0.25,
    weight: 3,
    opacity: 1,
    interactive: false,
  }).addTo(map);

  let step = 0;
  const steps = 24;
  const timer = setInterval(() => {
    step++;
    const t = step / steps;
    ring.setStyle({ opacity: 1 - t, fillOpacity: 0.25 * (1 - t) });
    ring.setRadius(radius * (1 + t * 0.6));
    if (step >= steps) { clearInterval(timer); ring.remove(); }
  }, 40);
}

function flashMarker(marker, color) {
  // Quick brightness flash on the div icon element
  const el = marker.getElement();
  if (!el) return;
  const dot = el.querySelector('.gw-marker');
  if (!dot) return;
  dot.style.transition = 'none';
  dot.style.boxShadow = `0 0 18px 6px ${color}`;
  dot.style.transform = 'scale(1.6)';
  setTimeout(() => {
    dot.style.transition = 'box-shadow 0.6s ease, transform 0.6s ease';
    dot.style.boxShadow = `0 0 10px ${color}`;
    dot.style.transform = 'scale(1)';
  }, 80);
}

function buildGwPopup(gw, readings) {
  return `<div class="popup-content">
    <h3>🗼 ${escHtml(gw.name)}</h3>
    <div class="popup-row"><span>EUI</span><span>${escHtml(gw.id)}</span></div>
    <div class="popup-row"><span>Nodes heard</span><span>${readings.length}</span></div>
    <div class="popup-row"><span>Lat / Lng</span><span>${gw.latitude?.toFixed(5)}, ${gw.longitude?.toFixed(5)}</span></div>
  </div>`;
}

function buildReadingPopup(r) {
  const batRow = r.battery_level != null
    ? `<div class="popup-row"><span>Battery</span><span>${Math.round(r.battery_level)}%</span></div>`
    : '';
  return `<div class="popup-content">
    <h3>📦 ${escHtml(r.node_name)}</h3>
    <div class="popup-row"><span>Gateway</span><span>${escHtml(r.gateway_name)}</span></div>
    <div class="popup-row"><span>RSSI</span><span>${r.rssi} dBm</span></div>
    <div class="popup-row"><span>SNR</span><span>${r.snr != null ? r.snr + ' dB' : 'N/A'}</span></div>
    <div class="popup-row"><span>Est. distance</span><span>~${Math.round(r.predicted_distance)} m</span></div>
    ${batRow}
    <div class="popup-row"><span>Last seen</span><span>${timeAgo(r.timestamp)}</span></div>
  </div>`;
}

/* ── Gateway list ───────────────────────────────────────────── */
function renderGatewayList(gwList) {
  const el = document.getElementById('gateway-list');
  if (!gwList.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">🗼</div>No gateways yet.<br>Add one above.</div>`;
    return;
  }
  // SVG icon helpers
  const svgEdit = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const svgTrash = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
  const svgLocate = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>`;

  el.innerHTML = gwList.map(gw => {
    const hasCoords = gw.latitude != null && gw.longitude != null;
    return `
    <div class="gateway-card">
      <div class="gw-card-header">
        <div class="gw-card-name">${escHtml(gw.name)}</div>
        <div class="gw-card-actions">
          <button class="btn btn-ghost btn-sm icon-btn" onclick="editGateway('${escHtml(gw.id)}')" title="Edit">${svgEdit}</button>
          <button class="btn btn-danger btn-sm icon-btn" onclick="deleteGateway('${escHtml(gw.id)}')" title="Delete">${svgTrash}</button>
          ${hasCoords ? `<button class="btn btn-ghost btn-sm icon-btn" onclick="flyTo(${gw.latitude},${gw.longitude})" title="Fly to">${svgLocate}</button>` : ''}
        </div>
      </div>
      <div class="gw-card-id">${escHtml(gw.id)}</div>
      <div class="gw-card-coords ${hasCoords ? '' : 'no-coords'}">
        ${hasCoords
        ? `<span class="coord-badge">${gw.latitude.toFixed(5)}</span> <span class="coord-badge">${gw.longitude.toFixed(5)}</span>`
        : '<span>No coordinates — set them to show on map</span>'}
      </div>
    </div>`;
  }).join('');
}

/* ── Node list ──────────────────────────────────────────────── */
function renderNodeList(readings) {
  const el = document.getElementById('node-list');
  if (!readings.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div>No data yet.<br>Waiting for uplinks…</div>`;
    return;
  }

  // Deduplicate by node_id (keep latest)
  const byNode = {};
  readings.forEach(r => {
    if (!byNode[r.node_id] || new Date(r.timestamp) > new Date(byNode[r.node_id].timestamp))
      byNode[r.node_id] = r;
  });

  el.innerHTML = Object.values(byNode).map(r => {
    const rssiPct = Math.max(0, Math.min(100, ((r.rssi + 120) / 80) * 100));
    const ageSecs = (Date.now() - new Date(r.timestamp + 'Z').getTime()) / 1000;
    const ageClass = ageSecs < 150 ? '' : 'stale';
    const dotColor = ageSecs < 150 ? getNodeColor(r.node_id) : '#64748b';

    // Battery indicator — only rendered when battery_level is present
    const batIndicator = r.battery_level != null ? (() => {
      const pct = Math.round(r.battery_level);
      const color = pct > 50 ? 'var(--green)' : pct > 20 ? 'var(--orange)' : 'var(--red)';
      // SVG battery: body 20×11, nub 2.5×5, fill scales with pct (max fill-width = 16)
      const fillW = Math.max(0, (pct / 100) * 16).toFixed(1);
      const icon = `<svg class="bat-icon" viewBox="0 0 24 12" xmlns="http://www.w3.org/2000/svg">
        <rect x="0.5" y="0.5" width="20" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.2"/>
        <rect x="21.5" y="3.5" width="2" height="5" rx="1" fill="currentColor"/>
        <rect x="2" y="2" width="${fillW}" height="8" rx="1" fill="currentColor"/>
      </svg>`;
      return `<div class="bat-indicator" style="color:${color}">${icon}<span>${pct}%</span></div>`;
    })() : '';

    return `
    <div class="node-card">
      <div class="node-card-header">
        <div class="node-card-name-wrap">
          <span class="node-color-dot" style="background:${dotColor};box-shadow:0 0 6px ${dotColor};"></span>
          <div class="node-card-name">${escHtml(r.node_name)}</div>
        </div>
        <div class="node-card-right">
          ${batIndicator}
          <div class="age-badge ${ageClass}">${timeAgo(r.timestamp)}</div>
        </div>
      </div>
      <div class="node-card-eui">${escHtml(r.node_id)}</div>
      <div class="rssi-bar-wrap">
        <div class="rssi-label"><span>Signal (RSSI)</span><span>${r.rssi} dBm</span></div>
        <div class="rssi-track"><div class="rssi-fill" style="width:${rssiPct}%"></div></div>
      </div>
      <div class="node-stats">
        <div class="stat-pill">📡 <strong>~${Math.round(r.predicted_distance ?? 0)} m</strong></div>
        ${r.snr != null ? `<div class="stat-pill">SNR <strong>${r.snr} dB</strong></div>` : ''}
        <div class="stat-pill">via <strong>${escHtml(r.gateway_name)}</strong></div>
      </div>
    </div>`;
  }).join('');
}

/* ── Header stats ───────────────────────────────────────────── */
function updateHeaderStats(gwList, rdList) {
  document.getElementById('hdr-gw-count').textContent = gwList.length;
  const nodeSet = new Set(rdList.map(r => r.node_id));
  document.getElementById('hdr-node-count').textContent = nodeSet.size;
}

/* ── Live indicator ─────────────────────────────────────────── */
function pulseLiveDot() {
  const dot = document.getElementById('live-dot');
  dot.classList.remove('stale', 'pulse');
  void dot.offsetWidth; // reflow
  dot.classList.add('pulse');
}

function updateLiveText() {
  if (!lastPollTime) return;
  const secs = Math.round((Date.now() - lastPollTime) / 1000);
  document.getElementById('live-text').textContent =
    secs < 2 ? 'Live' : `Updated ${secs}s ago`;
}

/* ── Gateway form ───────────────────────────────────────────── */
function toggleGatewayForm() {
  editingGwId = null;
  clearForm();
  const c = document.getElementById('gateway-form-container');
  const isVisible = c.classList.contains('visible');
  c.classList.toggle('visible', !isVisible);
  pickingCoords = !isVisible;
  document.getElementById('form-title').textContent = 'Add Gateway';
  document.getElementById('gw-id').disabled = false;
}

function editGateway(id) {
  const gw = gateways[id];
  if (!gw) return;
  editingGwId = id;
  document.getElementById('form-title').textContent = 'Edit Gateway';
  document.getElementById('gw-id').value = gw.id;
  document.getElementById('gw-id').disabled = true;
  document.getElementById('gw-name').value = gw.name;
  document.getElementById('gw-lat').value = gw.latitude ?? '';
  document.getElementById('gw-lng').value = gw.longitude ?? '';
  document.getElementById('gateway-form-container').classList.add('visible');
  pickingCoords = true;
  switchTab('gateways');
}

function cancelGatewayForm() {
  document.getElementById('gateway-form-container').classList.remove('visible');
  pickingCoords = false;
  clearForm();
}

function clearForm() {
  ['gw-id', 'gw-name', 'gw-lat', 'gw-lng'].forEach(id => {
    document.getElementById(id).value = '';
    document.getElementById(id).disabled = false;
  });
  editingGwId = null;
}

async function submitGatewayForm() {
  const id = document.getElementById('gw-id').value.trim();
  const name = document.getElementById('gw-name').value.trim();
  const lat = parseFloat(document.getElementById('gw-lat').value);
  const lng = parseFloat(document.getElementById('gw-lng').value);

  if (!name) { toast('Name is required', 'error'); return; }

  const body = { name, latitude: isNaN(lat) ? null : lat, longitude: isNaN(lng) ? null : lng };

  try {
    let res;
    if (editingGwId) {
      res = await fetch(`${API_BASE_URL}/api/gateways/${editingGwId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      if (!id) { toast('Gateway EUI is required', 'error'); return; }
      res = await fetch(`${API_BASE_URL}/api/gateways`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...body }),
      });
    }
    if (!res.ok) {
      const err = await res.json();
      toast(err.detail || 'Error saving gateway', 'error');
      return;
    }
    toast('Gateway saved ✓', 'success');
    cancelGatewayForm();
    refresh();
  } catch (e) {
    toast('Network error', 'error');
  }
}

async function deleteGateway(id) {
  if (!confirm(`Delete gateway ${id}?`)) return;
  try {
    await fetch(`${API_BASE_URL}/api/gateways/${id}`, { method: 'DELETE' });
    toast('Gateway deleted', 'success');
    refresh();
  } catch (e) {
    toast('Error deleting gateway', 'error');
  }
}

function flyTo(lat, lng) {
  map.flyTo([lat, lng], 16, { duration: 1.2 });
  switchTab('gateways');
}

/* ── Model Tab ──────────────────────────────────────────────── */
async function fetchModelParams() {
  try {
    const res = await fetch(`${API_BASE_URL}/api/config/range-model`);
    const p = await res.json();
    document.getElementById('rssi-ref-slider').value = p.rssi_ref;
    document.getElementById('n-slider').value = p.path_loss_exp;
    onSliderChange();
  } catch (e) { /* backend not up yet */ }
}

function onSliderChange() {
  const ref = parseFloat(document.getElementById('rssi-ref-slider').value);
  const n = parseFloat(document.getElementById('n-slider').value);
  document.getElementById('rssi-ref-val').textContent = `${ref} dBm`;
  document.getElementById('n-val').textContent = n.toFixed(1);
  updateDistancePreview(ref, n);
}

function updateDistancePreview(ref, n) {
  const testRssi = [-60, -75, -90, -105];
  const el = document.getElementById('preview-values');
  el.innerHTML = testRssi.map(rssi => {
    const d = Math.round(Math.pow(10, (ref - rssi) / (10 * n)));
    return `<div class="preview-item">
      <div class="preview-rssi">${rssi} dBm</div>
      <div class="preview-dist">${d} m</div>
    </div>`;
  }).join('');
}

async function applyModelParams() {
  const rssi_ref = parseFloat(document.getElementById('rssi-ref-slider').value);
  const path_loss_exp = parseFloat(document.getElementById('n-slider').value);
  try {
    const res = await fetch(`${API_BASE_URL}/api/config/range-model`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rssi_ref, path_loss_exp }),
    });
    if (res.ok) {
      toast('Model parameters updated ✓', 'success');
      refresh();
    }
  } catch (e) {
    toast('Failed to update model', 'error');
  }
}

/* ── Tabs ───────────────────────────────────────────────────── */
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.getElementById(`content-${name}`).classList.add('active');
  
  if (name === 'battery') {
    updateBatteryChart();
  }
}

/* ── Toast ──────────────────────────────────────────────────── */
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3100);
}

/* ── Helpers ────────────────────────────────────────────────── */
function timeAgo(ts) {
  const secs = Math.round((Date.now() - new Date(ts + 'Z').getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Battery Tab ────────────────────────────────────────────── */
let batteryChart = null;
let batteryTimeframe = 1; // default 1 hour
let lastBatteryDataSignature = '';

async function fetchBatteryHistory(hours) {
  const ts = Date.now();
  const res = await fetch(`${API_BASE_URL}/api/readings/battery-history?hours=${hours}&t=${ts}`);
  return await res.json();
}

function onTimeframeChange() {
  batteryTimeframe = parseFloat(document.getElementById('battery-timeframe').value) || 1;
  updateBatteryChart();
}

async function updateBatteryChart() {
  try {
    const history = await fetchBatteryHistory(batteryTimeframe);
    
    // Check signature to avoid updating chart if the underlying data has not changed
    const sig = history.length + '_' + (history.length > 0 ? history[history.length - 1].timestamp : '') + '_' + batteryTimeframe;
    if (sig === lastBatteryDataSignature && batteryChart) {
      return; // Skip rendering
    }
    lastBatteryDataSignature = sig;

    renderBatteryChart(history);
    renderBatteryStats(history);
  } catch (e) {
    console.error('Failed to update battery chart:', e);
  }
}

function renderBatteryChart(data) {
  const ctx = document.getElementById('batteryChart');
  if (!ctx) return;

  // Group by node_id
  const groups = {};
  data.forEach(r => {
    if (!groups[r.node_id]) {
      groups[r.node_id] = {
        name: r.node_name,
        points: []
      };
    }
    groups[r.node_id].points.push({
      x: new Date(r.timestamp + 'Z').getTime(),
      y: r.battery_level
    });
  });

  const datasets = Object.entries(groups).map(([nodeId, group]) => {
    const color = getNodeColor(nodeId);
    return {
      label: group.name,
      data: group.points,
      borderColor: color,
      backgroundColor: color + '12', // subtle gradient area fill
      borderWidth: 2,
      tension: 0.3,
      fill: true,
      pointRadius: 2,
      pointHoverRadius: 5,
      spanGaps: true
    };
  });

  const isLight = document.documentElement.classList.contains('light-mode');
  const textColor = isLight ? '#5f6368' : '#9aa0a6';
  const gridColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';
  const tooltipBg = isLight ? 'rgba(255, 255, 255, 0.95)' : 'rgba(14, 15, 16, 0.95)';
  const tooltipBorder = isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.08)';
  const tooltipText = isLight ? '#000' : '#fff';

  const nowMs = Date.now();
  // Round to nearest 10 seconds to align timeline updates and prevent constant micro-shifts
  const roundedNowMs = Math.floor(nowMs / 10000) * 10000;
  const minMs = roundedNowMs - batteryTimeframe * 60 * 60 * 1000;

  if (!batteryChart) {
    batteryChart = new Chart(ctx, {
      type: 'line',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            type: 'linear',
            position: 'bottom',
            min: minMs,
            max: roundedNowMs,
            ticks: {
              color: textColor,
              font: { family: 'Inter', size: 10 },
              callback: function(value) {
                const date = new Date(value);
                if (batteryTimeframe <= 24) {
                  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                } else if (batteryTimeframe <= 168) {
                  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                } else {
                  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
                }
              }
            },
            grid: { color: gridColor }
          },
          y: {
            min: 0,
            max: 100,
            ticks: {
              color: textColor,
              font: { family: 'Inter', size: 10 },
              callback: function(value) { return value + '%'; }
            },
            grid: { color: gridColor }
          }
        },
        plugins: {
          legend: {
            labels: {
              color: textColor,
              font: { family: 'Inter', size: 11, weight: '500' }
            }
          },
          tooltip: {
            backgroundColor: tooltipBg,
            titleColor: tooltipText,
            bodyColor: tooltipText,
            borderColor: tooltipBorder,
            borderWidth: 1,
            titleFont: { family: 'Inter', size: 11, weight: 'bold' },
            bodyFont: { family: 'Inter', size: 11 },
            callbacks: {
              title: function(context) {
                const date = new Date(context[0].raw.x);
                if (batteryTimeframe <= 24) {
                  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                } else {
                  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                }
              },
              label: function(context) {
                return ` ${context.dataset.label}: ${context.raw.y.toFixed(1)}%`;
              }
            }
          }
        }
      }
    });
  } else {
    // Update datasets in-place to avoid re-creation layout animations
    const existing = batteryChart.data.datasets;
    const existingMap = {};
    existing.forEach(d => { existingMap[d.label] = d; });

    const newDatasets = [];
    datasets.forEach(newD => {
      const ext = existingMap[newD.label];
      if (ext) {
        ext.data = newD.data;
        ext.borderColor = newD.borderColor;
        ext.backgroundColor = newD.backgroundColor;
        newDatasets.push(ext);
      } else {
        newDatasets.push(newD);
      }
    });

    batteryChart.data.datasets = newDatasets;
    batteryChart.options.scales.x.min = minMs;
    batteryChart.options.scales.x.max = roundedNowMs;
    batteryChart.options.scales.x.ticks.color = textColor;
    batteryChart.options.scales.x.grid.color = gridColor;
    batteryChart.options.scales.y.ticks.color = textColor;
    batteryChart.options.scales.y.grid.color = gridColor;
    batteryChart.options.plugins.legend.labels.color = textColor;
    batteryChart.options.plugins.tooltip.backgroundColor = tooltipBg;
    batteryChart.options.plugins.tooltip.borderColor = tooltipBorder;
    batteryChart.options.plugins.tooltip.titleColor = tooltipText;
    batteryChart.options.plugins.tooltip.bodyColor = tooltipText;
    
    // Use 'none' transition mode to prevent jumping animation
    batteryChart.update('none');
  }
}

function renderBatteryStats(data) {
  const el = document.getElementById('battery-stats');
  if (!el) return;

  const groups = {};
  data.forEach(r => {
    if (!groups[r.node_id]) {
      groups[r.node_id] = {
        name: r.node_name,
        points: []
      };
    }
    groups[r.node_id].points.push({
      time: new Date(r.timestamp + 'Z').getTime(),
      val: r.battery_level
    });
  });

  const nodeIds = Object.keys(groups);
  if (nodeIds.length === 0) {
    el.innerHTML = `<div class="empty-state" style="padding: 10px 0;"><div class="empty-icon">🔋</div>No battery history in this timeframe.</div>`;
    return;
  }

  el.innerHTML = nodeIds.map(nodeId => {
    const color = getNodeColor(nodeId);
    const group = groups[nodeId];
    group.points.sort((a, b) => a.time - b.time);

    const latestVal = group.points[group.points.length - 1].val;

    let drainRateText = 'Calculating…';
    let remainingText = 'Calculating…';

    if (group.points.length >= 2) {
      const first = group.points[0];
      const last = group.points[group.points.length - 1];
      const dtHours = (last.time - first.time) / (1000 * 60 * 60);

      if (dtHours > 0.05) {
        const dVal = first.val - last.val;
        const rate = dVal / dtHours;

        if (rate > 0.01) {
          drainRateText = `${rate.toFixed(2)}% / hr`;
          const hoursLeft = latestVal / rate;
          if (hoursLeft > 24) {
            remainingText = `~${(hoursLeft / 24).toFixed(1)} days`;
          } else {
            remainingText = `~${hoursLeft.toFixed(1)} hrs`;
          }
        } else if (rate < -0.01) {
          drainRateText = `+${Math.abs(rate).toFixed(2)}% / hr (Charging)`;
          remainingText = 'Stable';
        } else {
          drainRateText = '0.00% / hr (Stable)';
          remainingText = 'Stable';
        }
      } else {
        drainRateText = 'Gathering points…';
        remainingText = 'Gathering points…';
      }
    }

    return `
      <div class="battery-stat-card" style="--accent-color: ${color}">
        <div class="bat-stat-header">
          <span class="bat-stat-name">
            <span class="node-color-dot" style="background:${color};box-shadow:0 0 6px ${color}; margin-right:0;"></span>
            ${escHtml(group.name)}
          </span>
          <span class="bat-stat-current" style="color: ${color}">${Math.round(latestVal)}%</span>
        </div>
        <div class="bat-stat-body">
          <div class="bat-stat-item">
            <span class="bat-stat-label">Drain Rate</span>
            <span class="bat-stat-value">${drainRateText}</span>
          </div>
          <div class="bat-stat-item">
            <span class="bat-stat-label">Remaining Est.</span>
            <span class="bat-stat-value">${remainingText}</span>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

/* ── Theme toggle ───────────────────────────────────────────── */
function getTileUrl() {
  return document.documentElement.classList.contains('light-mode')
    ? TILES.light
    : TILES.dark;
}

function toggleTheme() {
  const isLight = document.documentElement.classList.toggle('light-mode');
  localStorage.setItem('theme', isLight ? 'light' : 'dark');

  // Swap map tiles
  if (tileLayer) {
    tileLayer.setUrl(isLight ? TILES.light : TILES.dark);
  }

  // Update chart theme if initialized
  if (batteryChart) {
    const textColor = isLight ? '#5f6368' : '#9aa0a6';
    const gridColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';
    const tooltipBg = isLight ? 'rgba(255, 255, 255, 0.95)' : 'rgba(14, 15, 16, 0.95)';
    const tooltipBorder = isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.08)';
    const tooltipText = isLight ? '#000' : '#fff';

    batteryChart.options.scales.x.ticks.color = textColor;
    batteryChart.options.scales.x.grid.color = gridColor;
    batteryChart.options.scales.y.ticks.color = textColor;
    batteryChart.options.scales.y.grid.color = gridColor;
    batteryChart.options.plugins.legend.labels.color = textColor;
    batteryChart.options.plugins.tooltip.backgroundColor = tooltipBg;
    batteryChart.options.plugins.tooltip.borderColor = tooltipBorder;
    batteryChart.options.plugins.tooltip.titleColor = tooltipText;
    batteryChart.options.plugins.tooltip.bodyColor = tooltipText;
    batteryChart.update('none');
  }
}

// Apply saved theme on load (before map init, so initMap picks right tile URL)
(function () {
  if (localStorage.getItem('theme') === 'light') {
    document.documentElement.classList.add('light-mode');
  }
})();

/* ── Mobile panel (bottom sheet) ───────────────────────────── */
let mobilePanelOpen = false;

function toggleMobilePanel() {
  mobilePanelOpen ? closeMobilePanel() : openMobilePanel();
}

function openMobilePanel() {
  mobilePanelOpen = true;
  document.getElementById('panel').classList.add('panel-open');
  document.getElementById('panel-backdrop').classList.add('visible');

  const label = document.getElementById('toggle-btn-label');
  const path = document.getElementById('toggle-icon-path');
  if (label) label.textContent = 'Close';
  if (path) path.setAttribute('d', 'M18 6L6 18M6 6l12 12'); // X icon
}

function closeMobilePanel() {
  mobilePanelOpen = false;
  document.getElementById('panel').classList.remove('panel-open');
  document.getElementById('panel-backdrop').classList.remove('visible');

  const label = document.getElementById('toggle-btn-label');
  const path = document.getElementById('toggle-icon-path');
  if (label) label.textContent = 'Panel';
  if (path) path.setAttribute('d', 'M4 6h16M4 12h16M4 18h16'); // hamburger icon
}

// On window resize: if switching back to desktop, ensure panel state is clean
window.addEventListener('resize', () => {
  if (window.innerWidth > 768 && mobilePanelOpen) {
    document.getElementById('panel').classList.remove('panel-open');
    document.getElementById('panel-backdrop').classList.remove('visible');
    mobilePanelOpen = false;
  }
});
