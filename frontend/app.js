/* ── Config ─────────────────────────────────────────────────── */
const API_BASE_URL = `${window.location.protocol}//${window.location.hostname}:8000`;
const POLL_INTERVAL = 5000; // ms

const TILES = {
  dark:  'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

/* ── Fetch Interceptor (Logs) ───────────────────────────────── */
const originalFetch = window.fetch;
window.fetch = async function(...args) {
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
  const time = new Date().toLocaleTimeString([], {hour12: false});
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

/* ── Init ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  fetchModelParams();
  refresh();
  setInterval(refresh, POLL_INTERVAL);
  setInterval(updateLiveText, 1000);
});

/* ── Map ────────────────────────────────────────────────────── */
function initMap() {
  map = L.map('map', { zoomControl: false });

  tileLayer = L.tileLayer(getTileUrl(), {
    attribution: '© OpenStreetMap contributors, © CARTO',
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
        ()  => map.setView([3.14, 101.69], 14)
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
    const gwColor = ageSecs < 60 ? '#22c55e' : '#64748b';

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
      const nodeColor = rAgeSecs < 60 ? getNodeColor(r.node_id) : '#64748b';
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
  return `<div class="popup-content">
    <h3>📦 ${escHtml(r.node_name)}</h3>
    <div class="popup-row"><span>Gateway</span><span>${escHtml(r.gateway_name)}</span></div>
    <div class="popup-row"><span>RSSI</span><span>${r.rssi} dBm</span></div>
    <div class="popup-row"><span>SNR</span><span>${r.snr != null ? r.snr + ' dB' : 'N/A'}</span></div>
    <div class="popup-row"><span>Est. distance</span><span>~${Math.round(r.predicted_distance)} m</span></div>
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
  const svgEdit   = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const svgTrash  = `<svg width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;
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
    const ageClass = ageSecs < 60 ? '' : 'stale';
    const dotColor = ageSecs < 60 ? getNodeColor(r.node_id) : '#64748b';
    return `
    <div class="node-card">
      <div class="node-card-header">
        <div class="node-card-name-wrap">
          <span class="node-color-dot" style="background:${dotColor};box-shadow:0 0 6px ${dotColor};"></span>
          <div class="node-card-name">${escHtml(r.node_name)}</div>
        </div>
        <div class="age-badge ${ageClass}">${timeAgo(r.timestamp)}</div>
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
  const id   = document.getElementById('gw-id').value.trim();
  const name = document.getElementById('gw-name').value.trim();
  const lat  = parseFloat(document.getElementById('gw-lat').value);
  const lng  = parseFloat(document.getElementById('gw-lng').value);

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
  const n   = parseFloat(document.getElementById('n-slider').value);
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
  const rssi_ref    = parseFloat(document.getElementById('rssi-ref-slider').value);
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
  if (secs < 60)   return `${secs}s ago`;
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  return `${Math.round(secs / 3600)}h ago`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
}

// Apply saved theme on load (before map init, so initMap picks right tile URL)
(function() {
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
  const path  = document.getElementById('toggle-icon-path');
  if (label) label.textContent = 'Close';
  if (path)  path.setAttribute('d', 'M18 6L6 18M6 6l12 12'); // X icon
}

function closeMobilePanel() {
  mobilePanelOpen = false;
  document.getElementById('panel').classList.remove('panel-open');
  document.getElementById('panel-backdrop').classList.remove('visible');

  const label = document.getElementById('toggle-btn-label');
  const path  = document.getElementById('toggle-icon-path');
  if (label) label.textContent = 'Panel';
  if (path)  path.setAttribute('d', 'M4 6h16M4 12h16M4 18h16'); // hamburger icon
}

// On window resize: if switching back to desktop, ensure panel state is clean
window.addEventListener('resize', () => {
  if (window.innerWidth > 768 && mobilePanelOpen) {
    document.getElementById('panel').classList.remove('panel-open');
    document.getElementById('panel-backdrop').classList.remove('visible');
    mobilePanelOpen = false;
  }
});
