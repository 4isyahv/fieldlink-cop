# FieldLink COP

FieldLink is a deployable common operating picture for teams working from different locations and devices. It provides a shared map, live unit tracking, incident reporting, operational chat, activity history, and online presence.

The app does not require devices to share the same Wi-Fi. For that mode, deploy the server to a public HTTPS host and give authorized operators the resulting URL and access code.

## Run locally

Requirements: Node.js 20 or newer. There are no package dependencies to install.

```powershell
$env:ACCESS_CODE="replace-with-a-strong-code"
node server.js
```

Open `http://localhost:3000`. Other devices can only use this local address when they can reach the computer running the server. For access from separate networks, deploy it as described below.

## Deploy for different networks

### Render

1. Put this folder in a GitHub or GitLab repository.
2. In Render, create a Blueprint and select the repository.
3. Render reads `render.yaml`, builds the container, creates a persistent disk, and generates an `ACCESS_CODE` secret.
4. Open the generated `https://...onrender.com` URL from each device.
5. In the Render service settings, reveal or replace `ACCESS_CODE` and give it only to authorized operators.

The included persistent disk is important: it keeps the operating picture after a restart. Render's free web tier does not support persistent disks, so the blueprint uses its lowest disk-capable plan.

### Any Docker host

```powershell
docker build -t fieldlink-cop .
docker run -p 3000:3000 -e ACCESS_CODE="replace-with-a-strong-code" -v cop-data:/app/data fieldlink-cop
```

Put the container behind an HTTPS reverse proxy or use a host that terminates HTTPS automatically. Set `DATA_FILE` if the persistent volume is mounted somewhere other than `/app/data`.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port exposed by the service |
| `ACCESS_CODE` | empty | Shared workspace code; always set this on a public deployment |
| `DATA_FILE` | `data/cop-state.json` | Persistent operating-picture file |

Map tiles and interface icons are loaded from public CDNs. Operators therefore need normal internet access in addition to access to the deployed service.

## Operational notes

- Updates use a single long-lived HTTPS connection and appear on other connected devices immediately.
- Reports, status changes, unit positions, chat, and activity history are persisted on the server.
- An operator identity is stored in that browser and attached to each update. It is a self-declared display name, not a verified user account. The access code is kept only for the current browser session.
- **Use Device GPS** requests high-accuracy browser location. Coordinates and the reported accuracy are sent to the COP only when the operator transmits the report or adds the unit.
- This is an operational coordination starter, not a system approved for classified, life-critical, or regulated data. A production deployment should add named user accounts, role-based permissions, backups, monitoring, an audit export, and an organization-approved hosting environment.

## API health check

`GET /healthz` returns `{ "status": "ok" }` and does not require the access code. Other API routes are protected when `ACCESS_CODE` is configured.
