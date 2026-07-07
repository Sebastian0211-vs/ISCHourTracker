# ISC Hour Tracker

Multi-account work-hours tracker (40 h Swiss week) with MongoDB storage.

- **Frontend:** React (Vite) — petal-styled UI, weekly gauge, 40 h countdown ring, months view, fiche de paie PDF export
- **Backend:** Node/Express — email+password accounts (bcrypt), JWT sessions, per-user data in MongoDB
- **Deploy target:** Docker Compose behind nginx at `https://hourtrack.triceratops.ch`

## Local development

```bash
# 1. Mongo (any local instance, or: docker run -d -p 27017:27017 mongo:7)
# 2. Server
cd server && npm install
echo "JWT_SECRET=$(openssl rand -hex 32)" > ../.env
JWT_SECRET=dev-secret node index.js
# 3. Client (separate terminal — proxies /api to :3000)
cd client && npm install && npm run dev
```

## Production deployment (VPS)

See the steps in the conversation / below:

1. Point DNS `hourtrack.triceratops.ch` → your VPS IP (A record).
2. Install Docker + compose plugin, nginx, certbot.
3. Copy this folder to the VPS, create `.env` with a random `JWT_SECRET`.
4. `docker compose up -d --build`
5. Enable the nginx site (`nginx-hourtrack.conf`), then `certbot --nginx -d hourtrack.triceratops.ch`.

## API

| Method | Path                        | Auth | Body                     |
| ------ | --------------------------- | ---- | ------------------------ |
| POST   | `/api/auth/register`        | –    | `{email, password}`      |
| POST   | `/api/auth/login`           | –    | `{email, password}`      |
| POST   | `/api/auth/change-password` | JWT  | `{current, next}`        |
| GET    | `/api/me`                   | JWT  | –                        |
| PUT    | `/api/data`                 | JWT  | `{rate, weeks}`          |

## Backups

MongoDB data lives in the `mongo-data` Docker volume. Nightly dump example (cron):

```bash
docker compose exec -T mongo mongodump --archive --db isc-hour-tracker > backup-$(date +%F).archive
```

Restore:

```bash
docker compose exec -T mongo mongorestore --archive --drop < backup-YYYY-MM-DD.archive
```
