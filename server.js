'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_FILE = path.resolve(process.env.DATA_FILE || path.join(ROOT, 'data', 'cop-state.json'));
const PORT = Number(process.env.PORT || 3000);
const ACCESS_CODE = String(process.env.ACCESS_CODE || '').trim();
const MAX_BODY_BYTES = 32 * 1024;
const clients = new Set();

const initialState = {
  operation: {
    name: 'OP MERIDIAN',
    subtitle: 'Regional Flood Response',
    center: [3.139, 101.6869],
    zoom: 13,
    updatedAt: '2026-08-26T08:42:00.000Z'
  },
  units: [
    { id: 'unit-alpha', callsign: 'ALPHA 1', team: 'Rescue', status: 'MOVING', members: 6, lat: 3.1558, lng: 101.6998, heading: 205, updatedAt: '2026-08-26T08:41:00.000Z', updatedBy: 'OPS' },
    { id: 'unit-bravo', callsign: 'BRAVO 2', team: 'Medical', status: 'ON SCENE', members: 4, lat: 3.1312, lng: 101.6746, heading: 45, updatedAt: '2026-08-26T08:39:00.000Z', updatedBy: 'MED' },
    { id: 'unit-charlie', callsign: 'CHARLIE 3', team: 'Logistics', status: 'HOLDING', members: 3, lat: 3.1468, lng: 101.6603, heading: 90, updatedAt: '2026-08-26T08:36:00.000Z', updatedBy: 'LOG' }
  ],
  incidents: [
    { id: 'inc-bridge', title: 'Bridge access blocked', category: 'Infrastructure', severity: 'CRITICAL', status: 'OPEN', lat: 3.1495, lng: 101.6909, details: 'Debris and rising water. Use northern approach.', reportedBy: 'ALPHA 1', createdAt: '2026-08-26T08:22:00.000Z', updatedAt: '2026-08-26T08:22:00.000Z' },
    { id: 'inc-medical', title: 'Medical assistance requested', category: 'Medical', severity: 'HIGH', status: 'ASSIGNED', lat: 3.1274, lng: 101.6842, details: 'Two civilians awaiting transport.', reportedBy: 'BRAVO 2', createdAt: '2026-08-26T08:31:00.000Z', updatedAt: '2026-08-26T08:37:00.000Z' },
    { id: 'inc-road', title: 'Road partially flooded', category: 'Hazard', severity: 'MEDIUM', status: 'MONITORING', lat: 3.1412, lng: 101.7118, details: 'Passable to high-clearance vehicles only.', reportedBy: 'OPS', createdAt: '2026-08-26T08:13:00.000Z', updatedAt: '2026-08-26T08:13:00.000Z' }
  ],
  zones: [
    { id: 'zone-flood', name: 'Flood risk zone', type: 'HAZARD', coordinates: [[3.1512, 101.6812], [3.1587, 101.6935], [3.1502, 101.7043], [3.1403, 101.6978], [3.1415, 101.6853]] },
    { id: 'zone-staging', name: 'Staging area', type: 'FRIENDLY', coordinates: [[3.1289, 101.6652], [3.1346, 101.6652], [3.1346, 101.6725], [3.1289, 101.6725]] }
  ],
  routes: [
    { id: 'route-supply', name: 'Supply route GREEN', status: 'OPEN', coordinates: [[3.1211, 101.6561], [3.1289, 101.6687], [3.1392, 101.6764], [3.151, 101.6798]] }
  ],
  messages: [
    { id: 'msg-1', author: 'OPS', text: 'Northern staging area is active.', createdAt: '2026-08-26T08:35:00.000Z' },
    { id: 'msg-2', author: 'ALPHA 1', text: 'Approaching bridge from the east.', createdAt: '2026-08-26T08:40:00.000Z' }
  ],
  activity: [
    { id: 'act-1', kind: 'incident', actor: 'BRAVO 2', text: 'Medical request assigned', createdAt: '2026-08-26T08:37:00.000Z' },
    { id: 'act-2', kind: 'unit', actor: 'ALPHA 1', text: 'Position updated', createdAt: '2026-08-26T08:41:00.000Z' },
    { id: 'act-3', kind: 'system', actor: 'OPS', text: 'Operating picture synchronized', createdAt: '2026-08-26T08:42:00.000Z' }
  ]
};

function ensureDataFile() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(initialState, null, 2));
  }
}

function loadState() {
  ensureDataFile();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    console.error('Unable to read state file:', error.message);
    return structuredClone(initialState);
  }
}

let state = loadState();

function saveState() {
  state.operation.updatedAt = new Date().toISOString();
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2));
  fs.renameSync(temporary, DATA_FILE);
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(body);
}

function isAuthorized(request) {
  if (!ACCESS_CODE) return true;
  const provided = String(request.headers['x-cop-key'] || '');
  const expected = Buffer.from(ACCESS_CODE);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requireAuthorization(request, response) {
  if (isAuthorized(request)) return true;
  sendJson(response, 401, { error: 'Access code required' });
  return false;
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        request.destroy();
      }
    });
    request.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function cleanText(value, maxLength = 160) {
  return String(value || '').trim().slice(0, maxLength);
}

function requireCoordinates(body) {
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw Object.assign(new Error('Valid latitude and longitude are required'), { status: 400 });
  }
  return { lat, lng };
}

function addActivity(kind, actor, text) {
  state.activity.unshift({
    id: crypto.randomUUID(),
    kind,
    actor: cleanText(actor || 'OPERATOR', 28),
    text: cleanText(text, 180),
    createdAt: new Date().toISOString()
  });
  state.activity = state.activity.slice(0, 100);
}

function broadcast(type, payload) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients) client.write(frame);
}

function commit(type, payload) {
  saveState();
  broadcast(type, payload);
  broadcast('summary', {
    updatedAt: state.operation.updatedAt,
    openIncidents: state.incidents.filter((item) => item.status !== 'RESOLVED').length
  });
}

function handleEvents(request, response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.write(`event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`);
  clients.add(response);
  broadcast('presence', { online: clients.size });
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20000);
  request.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(response);
    broadcast('presence', { online: clients.size });
  });
}

async function handleApi(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/config') {
    return sendJson(response, 200, {
      accessRequired: Boolean(ACCESS_CODE),
      operationName: state.operation.name,
      service: 'FieldLink COP'
    });
  }
  if (!requireAuthorization(request, response)) return;

  if (request.method === 'GET' && url.pathname === '/api/state') {
    return sendJson(response, 200, state);
  }
  if (request.method === 'GET' && url.pathname === '/api/events') {
    return handleEvents(request, response);
  }

  const body = await readJson(request);
  const now = new Date().toISOString();

  if (request.method === 'POST' && url.pathname === '/api/incidents') {
    const { lat, lng } = requireCoordinates(body);
    const title = cleanText(body.title, 80);
    if (!title) throw Object.assign(new Error('Incident title is required'), { status: 400 });
    const incident = {
      id: crypto.randomUUID(),
      title,
      category: cleanText(body.category || 'Other', 40),
      severity: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(body.severity) ? body.severity : 'MEDIUM',
      status: 'OPEN',
      lat,
      lng,
      details: cleanText(body.details, 300),
      reportedBy: cleanText(body.reportedBy || 'OPERATOR', 28),
      createdAt: now,
      updatedAt: now
    };
    state.incidents.unshift(incident);
    addActivity('incident', incident.reportedBy, `Reported: ${incident.title}`);
    commit('incident.created', incident);
    return sendJson(response, 201, incident);
  }

  const incidentMatch = url.pathname.match(/^\/api\/incidents\/([^/]+)$/);
  if (request.method === 'PATCH' && incidentMatch) {
    const incident = state.incidents.find((item) => item.id === incidentMatch[1]);
    if (!incident) return sendJson(response, 404, { error: 'Incident not found' });
    const nextStatus = cleanText(body.status, 20).toUpperCase();
    if (!['OPEN', 'ASSIGNED', 'MONITORING', 'RESOLVED'].includes(nextStatus)) {
      throw Object.assign(new Error('Invalid incident status'), { status: 400 });
    }
    incident.status = nextStatus;
    incident.updatedAt = now;
    const actor = cleanText(body.updatedBy || 'OPERATOR', 28);
    addActivity('incident', actor, `${nextStatus}: ${incident.title}`);
    commit('incident.updated', incident);
    return sendJson(response, 200, incident);
  }

  if (request.method === 'POST' && url.pathname === '/api/units') {
    const { lat, lng } = requireCoordinates(body);
    const callsign = cleanText(body.callsign, 24).toUpperCase();
    if (!callsign) throw Object.assign(new Error('Callsign is required'), { status: 400 });
    const unit = {
      id: crypto.randomUUID(),
      callsign,
      team: cleanText(body.team || 'Field', 40),
      status: cleanText(body.status || 'AVAILABLE', 20).toUpperCase(),
      members: Math.max(1, Math.min(99, Number(body.members) || 1)),
      lat,
      lng,
      heading: 0,
      updatedAt: now,
      updatedBy: cleanText(body.updatedBy || callsign, 28)
    };
    state.units.push(unit);
    addActivity('unit', unit.updatedBy, `${callsign} added to the picture`);
    commit('unit.created', unit);
    return sendJson(response, 201, unit);
  }

  const unitMatch = url.pathname.match(/^\/api\/units\/([^/]+)$/);
  if (request.method === 'PATCH' && unitMatch) {
    const unit = state.units.find((item) => item.id === unitMatch[1]);
    if (!unit) return sendJson(response, 404, { error: 'Unit not found' });
    if (body.lat !== undefined || body.lng !== undefined) {
      const coordinates = requireCoordinates(body);
      unit.lat = coordinates.lat;
      unit.lng = coordinates.lng;
    }
    if (body.status) unit.status = cleanText(body.status, 20).toUpperCase();
    if (body.members) unit.members = Math.max(1, Math.min(99, Number(body.members)));
    unit.updatedAt = now;
    unit.updatedBy = cleanText(body.updatedBy || unit.callsign, 28);
    addActivity('unit', unit.updatedBy, `${unit.callsign} status: ${unit.status}`);
    commit('unit.updated', unit);
    return sendJson(response, 200, unit);
  }

  if (request.method === 'POST' && url.pathname === '/api/messages') {
    const text = cleanText(body.text, 240);
    if (!text) throw Object.assign(new Error('Message text is required'), { status: 400 });
    const message = {
      id: crypto.randomUUID(),
      author: cleanText(body.author || 'OPERATOR', 28),
      text,
      createdAt: now
    };
    state.messages.push(message);
    state.messages = state.messages.slice(-100);
    addActivity('message', message.author, message.text);
    commit('message.created', message);
    return sendJson(response, 201, message);
  }

  return sendJson(response, 404, { error: 'API route not found' });
}

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStatic(response, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(requested)}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    return sendJson(response, 403, { error: 'Forbidden' });
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') return sendJson(response, 404, { error: 'Not found' });
      return sendJson(response, 500, { error: 'Unable to read file' });
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/healthz') return sendJson(response, 200, { status: 'ok' });
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (!['GET', 'HEAD'].includes(request.method)) return sendJson(response, 405, { error: 'Method not allowed' });
    return serveStatic(response, url);
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    }
    if (!error.status) console.error(error);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`FieldLink COP listening on http://localhost:${PORT}`);
  if (!ACCESS_CODE) console.log('ACCESS_CODE is not set; the workspace is open to anyone with its URL.');
});

function shutdown() {
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
