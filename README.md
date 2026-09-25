# BOTX — Railway-ready

This package runs the BOTX dashboard and Baileys WhatsApp bot from one Node.js application. The dashboard HTML is embedded in `server.js`.

## Deploy on Railway

1. Upload this folder to a GitHub repository (for example `botx`).
2. In Railway, create a new project and choose **Deploy from GitHub repo**.
3. Select the repository.
4. Add a persistent Railway Volume to the BOTX service with mount path:
   `/app/runtime`
5. Add these variables:
   - `SESSION_SECRET` = a long random secret
   - `NODE_ENV` = `production`
   - `BOTX_STORAGE_DIR` = `/app/runtime`
6. Deploy.
7. In Service Settings → Networking, generate a public domain.
8. Open the generated HTTPS URL and create your BOTX account.

The persistent volume is important because Baileys authentication files and the SQLite database are stored under `/app/runtime`.

## Local run

Requires Node.js 22.

```bash
npm install
node server.js
```

Then open http://localhost:3000.

## Included live functions

- Account signup/login/logout
- Dashboard
- Bot name/prefix settings
- Real Baileys WhatsApp connection
- Pairing-code linking
- Persistent WhatsApp auth state when the Railway volume is attached
- `.ping`, `.menu`, `.status`
- Start/stop controls

M-Pesa/subscriptions are not included yet.

## Important

Baileys is an unofficial WhatsApp Web library. Use it only in ways permitted by WhatsApp's terms and avoid spam/abusive automation.
