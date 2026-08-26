'use strict';

const app = {
  state: null,
  config: null,
  map: null,
  layers: {},
  markers: new Map(),
  selected: null,
  activeTool: 'cursor',
  measurePoints: [],
  pendingPick: null,
  resumeDialog: null,
  operator: localStorage.getItem('cop.operator') || '',
  accessCode: sessionStorage.getItem('cop.accessCode') || '',
  liveGeneration: 0,
  syncTimer: null,
  toastTimer: null
};

const $ = (selector, parent = document) => parent.querySelector(selector);
const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.7 } });
}

function showToast(message, kind = 'success') {
  const toast = $('#toast');
  $('span', toast).textContent = message;
  toast.classList.toggle('error', kind === 'error');
  toast.classList.add('show');
  clearTimeout(app.toastTimer);
  app.toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function setConnection(connected) {
  const chip = $('#connection-chip');
  chip.classList.toggle('disconnected', !connected);
  $('#connection-label').textContent = connected ? 'LIVE' : 'RECONNECTING';
}

function authHeaders(extra = {}) {
  return app.accessCode ? { ...extra, 'X-COP-Key': app.accessCode } : extra;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders({
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed (${response.status})`);
    error.status = response.status;
    if (response.status === 401) requireAccessCode();
    throw error;
  }
  return payload;
}

function setOperator(name) {
  app.operator = String(name || 'OPERATOR').trim().slice(0, 28).toUpperCase();
  localStorage.setItem('cop.operator', app.operator);
  $('#operator-name').textContent = app.operator;
  if ($('#incident-reporter')) $('#incident-reporter').textContent = app.operator;
  const initials = app.operator.split(/\s+/).map((part) => part[0]).join('').slice(0, 2);
  $('#operator-avatar').textContent = initials || 'OP';
}

function openAccessDialog(message = '') {
  const dialog = $('#access-dialog');
  $('#access-operator').value = app.operator;
  $('#access-code').value = app.accessCode;
  $('#access-error').textContent = message;
  $('#code-field').hidden = !app.config?.accessRequired;
  $('#access-code').required = Boolean(app.config?.accessRequired);
  if (!dialog.open) dialog.showModal();
  setTimeout(() => (app.operator && app.config?.accessRequired ? $('#access-code') : $('#access-operator')).focus(), 50);
}

function requireAccessCode(message = 'Enter the current deployment access code.') {
  app.config = { ...(app.config || {}), accessRequired: true };
  app.accessCode = '';
  sessionStorage.removeItem('cop.accessCode');
  for (const id of ['incident-dialog', 'unit-dialog']) {
    const dialog = $(`#${id}`);
    if (dialog?.open) dialog.close();
  }
  openAccessDialog(message);
}

function showRequestError(error) {
  if (error.status !== 401) showToast(error.message, 'error');
}

async function joinWorkspace() {
  try {
    app.state = await api('/api/state');
    $('#access-dialog').close();
    initializeMap();
    renderAll();
    connectLive();
    setConnection(true);
    if (app.resumeDialog) {
      const dialog = $(`#${app.resumeDialog}-dialog`);
      app.resumeDialog = null;
      if (dialog && !dialog.open) dialog.showModal();
    }
  } catch (error) {
    if (error.status === 401) requireAccessCode('The access code was not accepted. Try again.');
    else openAccessDialog('Unable to reach the workspace.');
  }
}

function initializeMap() {
  if (app.map || !app.state) return;
  if (!window.L) {
    $('#map-unavailable').hidden = false;
    return;
  }

  const center = app.state.operation.center || [3.139, 101.6869];
  app.map = L.map('map', {
    zoomControl: true,
    attributionControl: false,
    preferCanvas: true
  }).setView(center, app.state.operation.zoom || 13);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(app.map);

  app.layers = {
    zones: L.layerGroup().addTo(app.map),
    routes: L.layerGroup().addTo(app.map),
    units: L.layerGroup().addTo(app.map),
    incidents: L.layerGroup().addTo(app.map),
    measure: L.layerGroup().addTo(app.map)
  };

  app.map.on('mousemove', ({ latlng }) => updateGridCoordinate(latlng));
  app.map.on('click', handleMapClick);
}

function updateGridCoordinate({ lat, lng }) {
  const latCardinal = lat >= 0 ? 'N' : 'S';
  const lngCardinal = lng >= 0 ? 'E' : 'W';
  $('#grid-coordinate').textContent = `${Math.abs(lat).toFixed(4)} ${latCardinal} · ${Math.abs(lng).toFixed(4)} ${lngCardinal}`;
}

function renderMap() {
  if (!app.map || !app.state) return;
  Object.values(app.layers).forEach((layer) => {
    if (layer !== app.layers.measure) layer.clearLayers();
  });
  app.markers.clear();

  for (const zone of app.state.zones) {
    const hazard = zone.type === 'HAZARD';
    L.polygon(zone.coordinates, {
      color: hazard ? '#df8a4c' : '#69a7d8',
      weight: 1.5,
      dashArray: hazard ? '6 5' : '3 3',
      fillColor: hazard ? '#df8a4c' : '#69a7d8',
      fillOpacity: hazard ? 0.16 : 0.12
    }).bindTooltip(escapeHtml(zone.name), { sticky: true }).addTo(app.layers.zones);
  }

  for (const route of app.state.routes) {
    L.polyline(route.coordinates, {
      color: '#6cbf78',
      weight: 4,
      opacity: 0.86,
      dashArray: '10 7'
    }).bindTooltip(`${escapeHtml(route.name)} · ${escapeHtml(route.status)}`, { sticky: true }).addTo(app.layers.routes);
  }

  for (const unit of app.state.units) {
    const statusClass = unit.status === 'HOLDING' ? 'holding' : '';
    const icon = L.divIcon({
      className: '',
      iconSize: [34, 24],
      iconAnchor: [17, 12],
      html: `<div class="cop-unit ${statusClass}"><div class="unit-symbol">${teamCode(unit.team)}</div><span class="unit-label">${escapeHtml(unit.callsign)}</span></div>`
    });
    const marker = L.marker([unit.lat, unit.lng], { icon, zIndexOffset: 300 })
      .on('click', () => selectItem('unit', unit.id))
      .addTo(app.layers.units);
    app.markers.set(unit.id, marker);
  }

  for (const incident of app.state.incidents) {
    const icon = L.divIcon({
      className: '',
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      html: `<div class="cop-incident ${incident.severity.toLowerCase()}"><div class="incident-symbol"><span>!</span></div></div>`
    });
    const marker = L.marker([incident.lat, incident.lng], { icon, zIndexOffset: 500 })
      .bindTooltip(escapeHtml(incident.title), { direction: 'top', offset: [0, -12] })
      .on('click', () => selectItem('incident', incident.id))
      .addTo(app.layers.incidents);
    app.markers.set(incident.id, marker);
  }
}

function teamCode(team) {
  const codes = { Rescue: 'R', Medical: '+', Security: 'S', Logistics: 'L', Command: 'C', Field: 'F' };
  return codes[team] || String(team || 'F')[0].toUpperCase();
}

function renderAll() {
  if (!app.state) return;
  $('#operation-name').textContent = app.state.operation.name;
  $('#operation-subtitle').textContent = app.state.operation.subtitle;
  $('#metric-open').textContent = app.state.incidents.filter((item) => item.status !== 'RESOLVED').length;
  $('#metric-units').textContent = app.state.units.length;
  $('#metric-high').textContent = app.state.incidents.filter((item) => ['CRITICAL', 'HIGH'].includes(item.severity) && item.status !== 'RESOLVED').length;
  $('#feed-badge').textContent = app.state.activity.length;
  $('#last-sync').textContent = formatClock(app.state.operation.updatedAt);
  renderMap();
  renderPriorityList();
  renderActivity();
  renderUnits();
  renderMessages();
  if (app.selected) renderSelection();
  refreshIcons();
}

function renderPriorityList() {
  const incidents = app.state.incidents
    .filter((item) => ['CRITICAL', 'HIGH'].includes(item.severity) && item.status !== 'RESOLVED')
    .sort((a, b) => (a.severity === 'CRITICAL' ? -1 : 1) - (b.severity === 'CRITICAL' ? -1 : 1));
  $('#priority-list').innerHTML = incidents.map((item) => `
    <article class="priority-item ${item.severity.toLowerCase()}" data-incident-id="${escapeHtml(item.id)}">
      <div class="priority-row"><span class="priority-badge">${escapeHtml(item.severity)} · ${escapeHtml(item.status)}</span><time class="priority-time">${formatAgo(item.updatedAt)}</time></div>
      <strong class="priority-title">${escapeHtml(item.title)}</strong>
      <div class="priority-meta">${escapeHtml(item.category)} · ${escapeHtml(item.reportedBy)}</div>
      <i data-lucide="chevron-right"></i>
    </article>`).join('');
  $$('[data-incident-id]').forEach((element) => element.addEventListener('click', () => focusItem('incident', element.dataset.incidentId)));
}

function renderActivity() {
  const iconByKind = { incident: 'triangle-alert', unit: 'navigation', message: 'message-square', system: 'radio' };
  $('#activity-feed').innerHTML = app.state.activity.slice(0, 30).map((item) => `
    <article class="activity-item">
      <div class="activity-icon ${escapeHtml(item.kind)}"><i data-lucide="${iconByKind[item.kind] || 'circle-dot'}"></i></div>
      <div class="activity-copy"><strong>${escapeHtml(item.actor)}</strong><span>${escapeHtml(item.text)}</span></div>
      <time>${formatAgo(item.createdAt)}</time>
    </article>`).join('');
}

function renderUnits() {
  $('#unit-list').innerHTML = app.state.units.map((unit) => `
    <article class="unit-row" data-unit-id="${escapeHtml(unit.id)}">
      <div class="unit-mini-symbol">${teamCode(unit.team)}</div>
      <div class="unit-row-copy"><strong>${escapeHtml(unit.callsign)}</strong><span>${escapeHtml(unit.team)} · ${Number(unit.members)} personnel</span></div>
      <div class="unit-row-status"><strong>${escapeHtml(unit.status)}</strong><span>${formatAgo(unit.updatedAt)}</span></div>
    </article>`).join('');
  $$('[data-unit-id]').forEach((element) => element.addEventListener('click', () => focusItem('unit', element.dataset.unitId)));
}

function renderMessages() {
  const list = $('#message-list');
  list.innerHTML = app.state.messages.map((message) => `
    <article class="message">
      <header><strong>${escapeHtml(message.author)}</strong><time>${formatClock(message.createdAt)}</time></header>
      <p>${escapeHtml(message.text)}</p>
    </article>`).join('');
  list.scrollTop = list.scrollHeight;
}

function formatAgo(iso) {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 45) return 'NOW';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}M`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}H`;
  return `${Math.floor(seconds / 86400)}D`;
}

function formatClock(iso) {
  if (!iso) return '--:--';
  return new Intl.DateTimeFormat('en-MY', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

function selectItem(type, id) {
  app.selected = { type, id };
  renderSelection();
}

function focusItem(type, id) {
  const list = type === 'incident' ? app.state.incidents : app.state.units;
  const item = list.find((entry) => entry.id === id);
  if (!item) return;
  if (app.map) app.map.flyTo([item.lat, item.lng], Math.max(app.map.getZoom(), 15), { duration: 0.55 });
  selectItem(type, id);
  if (window.innerWidth <= 820) $('#intel-panel').classList.remove('open');
}

function renderSelection() {
  const card = $('#selection-card');
  const isIncident = app.selected?.type === 'incident';
  const collection = isIncident ? app.state.incidents : app.state.units;
  const item = collection?.find((entry) => entry.id === app.selected?.id);
  if (!item) {
    card.hidden = true;
    app.selected = null;
    return;
  }

  card.hidden = false;
  card.dataset.type = app.selected.type;
  $('.selection-accent', card).style.background = isIncident ? severityColor(item.severity) : '#64c6cf';
  $('#selection-kicker').textContent = isIncident ? `${item.severity} · ${item.status}` : `${item.team} · ${item.status}`;
  $('#selection-kicker').style.color = isIncident ? severityColor(item.severity) : '#64c6cf';
  $('#selection-title').textContent = isIncident ? item.title : item.callsign;
  $('#selection-detail').textContent = isIncident ? (item.details || 'No additional details.') : `${item.members} personnel · Updated by ${item.updatedBy}`;
  const hasLocationAccuracy = item.accuracy !== null && item.accuracy !== undefined && Number.isFinite(Number(item.accuracy));
  const locationAccuracy = hasLocationAccuracy ? ` · GPS ±${Math.round(item.accuracy)}m` : '';
  $('#selection-meta').textContent = isIncident
    ? `Reported by ${item.reportedBy}${locationAccuracy} · ${formatAgo(item.createdAt)}`
    : `Updated by ${item.updatedBy}${locationAccuracy} · ${formatAgo(item.updatedAt)}`;
  const action = $('#selection-action');
  action.hidden = !isIncident || item.status === 'RESOLVED';
  action.textContent = { OPEN: 'ASSIGN', ASSIGNED: 'MONITOR', MONITORING: 'RESOLVE' }[item.status] || 'UPDATE';
}

function severityColor(severity) {
  return severity === 'CRITICAL' ? '#e45d58' : severity === 'HIGH' ? '#df8a4c' : '#f2b84b';
}

async function advanceIncident() {
  if (app.selected?.type !== 'incident') return;
  const incident = app.state.incidents.find((item) => item.id === app.selected.id);
  if (!incident) return;
  const nextStatus = { OPEN: 'ASSIGNED', ASSIGNED: 'MONITORING', MONITORING: 'RESOLVED' }[incident.status];
  if (!nextStatus) return;
  try {
    await api(`/api/incidents/${encodeURIComponent(incident.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: nextStatus, updatedBy: app.operator })
    });
    await syncState();
    showToast(`Incident moved to ${nextStatus}`);
  } catch (error) {
    showRequestError(error);
  }
}

function setTool(tool) {
  app.activeTool = tool;
  $$('[data-tool]').forEach((button) => button.classList.toggle('active', button.dataset.tool === tool));
  $('#measure-panel').hidden = tool !== 'measure';
  if (app.map) app.map.getContainer().style.cursor = tool === 'cursor' ? '' : 'crosshair';
  if (tool === 'incident') showToast('Select the incident location on the map');
  if (tool === 'unit') showToast('Select the unit location on the map');
  if (tool === 'measure') showToast('Select two points to measure distance');
}

function handleMapClick({ latlng }) {
  if (app.pendingPick) {
    const type = app.pendingPick;
    const dialog = $(`#${type}-dialog`);
    const form = $(`#${type}-form`);
    form.elements.lat.value = latlng.lat.toFixed(6);
    form.elements.lng.value = latlng.lng.toFixed(6);
    form.elements.accuracy.value = '';
    setLocationStatus(type, 'MAP POINT SELECTED', 'good');
    app.pendingPick = null;
    dialog.showModal();
    return;
  }
  if (app.activeTool === 'incident' || app.activeTool === 'unit') {
    openEntryDialog(app.activeTool, latlng);
    setTool('cursor');
    return;
  }
  if (app.activeTool === 'measure') addMeasurePoint(latlng);
}

function openEntryDialog(type, coordinates) {
  const dialog = $(`#${type}-dialog`);
  const form = $(`#${type}-form`);
  if (coordinates) {
    form.elements.lat.value = Number(coordinates.lat).toFixed(6);
    form.elements.lng.value = Number(coordinates.lng).toFixed(6);
    setLocationStatus(type, 'MAP POINT SELECTED', 'good');
  } else {
    form.elements.lat.value = '';
    form.elements.lng.value = '';
    setLocationStatus(type, 'LOCATION REQUIRED');
  }
  form.elements.accuracy.value = '';
  if (!dialog.open) dialog.showModal();
  setTimeout(() => form.elements[type === 'incident' ? 'title' : 'callsign'].focus(), 40);
}

function beginCoordinatePick(type) {
  $(`#${type}-dialog`).close();
  app.pendingPick = type;
  setLocationStatus(type, 'SELECT ON MAP', 'warning');
  showToast(`Select the ${type} position on the map`);
}

function setLocationStatus(type, message, state = '') {
  const status = $(`#${type}-location-status`);
  if (!status) return;
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}

function markManualCoordinates(type) {
  const form = $(`#${type}-form`);
  form.elements.accuracy.value = '';
  const complete = form.elements.lat.value && form.elements.lng.value;
  setLocationStatus(type, complete ? 'MANUAL COORDINATES' : 'LOCATION REQUIRED', complete ? 'warning' : '');
}

function locateDevice(type) {
  const button = $(`#${type}-gps`);
  if (!navigator.geolocation) {
    setLocationStatus(type, 'GPS NOT SUPPORTED');
    showToast('This device does not provide browser location. Pick the point on the map.', 'error');
    return;
  }

  button.disabled = true;
  setLocationStatus(type, 'LOCATING...', 'warning');
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const form = $(`#${type}-form`);
      const { latitude, longitude, accuracy } = position.coords;
      form.elements.lat.value = latitude.toFixed(6);
      form.elements.lng.value = longitude.toFixed(6);
      form.elements.accuracy.value = Math.round(accuracy);
      const roundedAccuracy = Math.max(1, Math.round(accuracy));
      setLocationStatus(type, `GPS ±${roundedAccuracy} M`, roundedAccuracy <= 50 ? 'good' : 'warning');
      button.disabled = false;
      if (app.map) app.map.flyTo([latitude, longitude], Math.max(app.map.getZoom(), 16), { duration: 0.55 });
      showToast(`Device position acquired · accuracy ±${roundedAccuracy} m`);
    },
    (error) => {
      const messages = {
        1: 'Location permission was denied. Allow location access or pick a point on the map.',
        2: 'Your device could not determine its location. Try again or pick a point on the map.',
        3: 'The GPS request timed out. Try again or pick a point on the map.'
      };
      button.disabled = false;
      setLocationStatus(type, 'GPS UNAVAILABLE');
      showToast(messages[error.code] || 'Unable to read device location.', 'error');
    },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
  );
}

function addMeasurePoint(latlng) {
  if (app.measurePoints.length === 2) clearMeasurement();
  app.measurePoints.push(latlng);
  L.circleMarker(latlng, { radius: 4, color: '#f2b84b', fillColor: '#171c18', fillOpacity: 1, weight: 2 }).addTo(app.layers.measure);
  if (app.measurePoints.length === 1) {
    $('#measure-value').textContent = 'Select an end point';
    return;
  }
  const distance = app.map.distance(app.measurePoints[0], app.measurePoints[1]);
  L.polyline(app.measurePoints, { color: '#f2b84b', weight: 2, dashArray: '6 6' }).addTo(app.layers.measure);
  const midpoint = L.latLng(
    (app.measurePoints[0].lat + app.measurePoints[1].lat) / 2,
    (app.measurePoints[0].lng + app.measurePoints[1].lng) / 2
  );
  const label = distance >= 1000 ? `${(distance / 1000).toFixed(2)} KM` : `${Math.round(distance)} M`;
  L.marker(midpoint, { interactive: false, icon: L.divIcon({ className: 'distance-label', html: label, iconSize: [70, 22], iconAnchor: [35, 11] }) }).addTo(app.layers.measure);
  $('#measure-value').textContent = label;
}

function clearMeasurement() {
  app.measurePoints = [];
  app.layers.measure?.clearLayers();
  $('#measure-value').textContent = 'Select a start point';
}

function toggleLayer(name, visible) {
  const layer = app.layers[name];
  if (!layer || !app.map) return;
  if (visible) layer.addTo(app.map);
  else layer.removeFrom(app.map);
}

async function syncState() {
  try {
    app.state = await api('/api/state');
    renderAll();
    setConnection(true);
  } catch (error) {
    if (error.status === 401) openAccessDialog('Your access code is no longer valid.');
    setConnection(false);
  }
}

function scheduleSync() {
  clearTimeout(app.syncTimer);
  app.syncTimer = setTimeout(syncState, 80);
}

async function connectLive() {
  const generation = ++app.liveGeneration;
  while (generation === app.liveGeneration) {
    try {
      const response = await fetch('/api/events', { headers: authHeaders() });
      if (response.status === 401) {
        requireAccessCode();
        return;
      }
      if (!response.ok || !response.body) throw new Error('Live connection unavailable');
      setConnection(true);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (generation === app.liveGeneration) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) handleEventFrame(frame);
      }
    } catch {
      setConnection(false);
    }
    if (generation === app.liveGeneration) await new Promise((resolve) => setTimeout(resolve, 1800));
  }
}

function handleEventFrame(frame) {
  if (!frame || frame.startsWith(':')) return;
  let event = 'message';
  let data = '';
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;
  let payload;
  try { payload = JSON.parse(data); } catch { return; }
  if (event === 'presence') {
    $('#online-count').textContent = payload.online || 1;
    return;
  }
  if (event === 'ready') {
    setConnection(true);
    return;
  }
  if (event === 'summary') {
    $('#last-sync').textContent = formatClock(payload.updatedAt);
    return;
  }
  scheduleSync();
}

function bindInterface() {
  setOperator(app.operator || 'OPS');
  refreshIcons();

  setInterval(() => {
    $('#mission-clock').textContent = new Intl.DateTimeFormat('en-MY', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      timeZone: 'Asia/Kuala_Lumpur'
    }).format(new Date());
  }, 1000);

  $$('[data-tool]').forEach((button) => button.addEventListener('click', () => setTool(button.dataset.tool)));
  $('#quick-report').addEventListener('click', () => openEntryDialog('incident'));
  $('#recenter-button').addEventListener('click', () => {
    if (app.map) app.map.flyTo(app.state.operation.center, app.state.operation.zoom, { duration: 0.6 });
  });
  $('#layers-button').addEventListener('click', () => { $('#layer-panel').hidden = !$('#layer-panel').hidden; });
  $('#layers-close').addEventListener('click', () => { $('#layer-panel').hidden = true; });
  $$('[data-layer]').forEach((input) => input.addEventListener('change', () => toggleLayer(input.dataset.layer, input.checked)));
  $('#measure-clear').addEventListener('click', clearMeasurement);
  $('#selection-close').addEventListener('click', () => { $('#selection-card').hidden = true; app.selected = null; });
  $('#selection-action').addEventListener('click', advanceIncident);
  $('#intel-toggle').addEventListener('click', () => $('#intel-panel').classList.toggle('open'));

  $$('.intel-tab').forEach((button) => button.addEventListener('click', () => {
    $$('.intel-tab').forEach((tab) => tab.classList.toggle('active', tab === button));
    $$('.tab-view').forEach((view) => view.classList.toggle('active', view.id === `tab-${button.dataset.tab}`));
    if (button.dataset.tab === 'chat') $('#message-input').focus();
  }));

  $('#share-button').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      showToast('Shared workspace link copied');
    } catch {
      showToast('Copy the current address to share this workspace', 'error');
    }
  });

  $('#operator-button').addEventListener('click', () => openAccessDialog());
  $$('[data-dialog-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
  $('#incident-pick').addEventListener('click', () => beginCoordinatePick('incident'));
  $('#unit-pick').addEventListener('click', () => beginCoordinatePick('unit'));
  $('#incident-gps').addEventListener('click', () => locateDevice('incident'));
  $('#unit-gps').addEventListener('click', () => locateDevice('unit'));
  $('#incident-reporter-change').addEventListener('click', () => {
    app.resumeDialog = 'incident';
    $('#incident-dialog').close();
    openAccessDialog();
  });
  for (const type of ['incident', 'unit']) {
    const form = $(`#${type}-form`);
    for (const name of ['lat', 'lng']) {
      form.elements[name].addEventListener('input', () => markManualCoordinates(type));
    }
  }

  $('#incident-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      await api('/api/incidents', { method: 'POST', body: JSON.stringify({ ...values, reportedBy: app.operator }) });
      form.reset();
      $('#incident-dialog').close();
      await syncState();
      showToast('Incident report synchronized');
    } catch (error) { showRequestError(error); }
  });

  $('#unit-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      await api('/api/units', { method: 'POST', body: JSON.stringify({ ...values, updatedBy: app.operator }) });
      form.reset();
      $('#unit-dialog').close();
      await syncState();
      showToast('Unit added to the shared picture');
    } catch (error) { showRequestError(error); }
  });

  $('#message-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('#message-input');
    const text = input.value.trim();
    if (!text) return;
    try {
      await api('/api/messages', { method: 'POST', body: JSON.stringify({ text, author: app.operator }) });
      input.value = '';
      await syncState();
    } catch (error) { showRequestError(error); }
  });

  $('#access-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setOperator($('#access-operator').value);
    app.accessCode = $('#access-code').value;
    if (app.accessCode) sessionStorage.setItem('cop.accessCode', app.accessCode);
    else sessionStorage.removeItem('cop.accessCode');
    $('#access-error').textContent = '';
    await joinWorkspace();
  });

  $('#map-search-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const query = event.currentTarget.value.trim().toLowerCase();
    if (!query || !app.state) return;
    const incident = app.state.incidents.find((item) => `${item.title} ${item.category}`.toLowerCase().includes(query));
    const unit = app.state.units.find((item) => `${item.callsign} ${item.team}`.toLowerCase().includes(query));
    if (incident) focusItem('incident', incident.id);
    else if (unit) focusItem('unit', unit.id);
    else showToast('No matching map item found', 'error');
  });

  document.addEventListener('keydown', (event) => {
    if (event.target.matches('input, textarea, select')) return;
    if (event.key === '/') { event.preventDefault(); $('#map-search-input').focus(); }
    if (event.key.toLowerCase() === 'r') openEntryDialog('incident');
    if (event.key === 'Escape') {
      $('#intel-panel').classList.remove('open');
      $('#layer-panel').hidden = true;
      setTool('cursor');
    }
  });
}

async function start() {
  bindInterface();
  try {
    app.config = await fetch('/api/config').then((response) => response.json());
  } catch {
    app.config = { accessRequired: false };
  }

  if (!app.operator || (app.config.accessRequired && !app.accessCode)) {
    openAccessDialog();
    return;
  }
  await joinWorkspace();
}

start();
