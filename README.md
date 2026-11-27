# Nanma CRM

The work tracker used at Nanma Branding: clients, cards and subtasks, internal and client approval, My Work, calendar, leave, attendance and salary (HR only), billing, reports, awards and team chat.

## What's in this repository

| Path | What it is |
|---|---|
| `index.html` | The whole CRM app (one page). |
| `server/server.js` | The server program. It stores the data in one SQLite file, handles sign-in, uploads and live updates. Plain Node.js 22, no extra packages. |
| `server/shim.js` | Connects the app page to the server. |
| `server/login.html` | The sign-in page (also lets new staff create a login with their invite code). |
| `deploy/setup.sh` | One-time setup for an Ubuntu server: installs everything, starts the CRM, sets up the web address with HTTPS and nightly backups. |

## Not stored in this repository

Company data (cards, clients, people, attendance, salaries, logins) is never in this repository. It lives only on the company server in `/var/lib/nanma-crm`, with nightly backups in `/var/backups/nanma-crm`.

## Running it on the server

```
curl -fsSL https://raw.githubusercontent.com/SniPerAshAn/nanma-crm/main/deploy/setup.sh -o setup.sh && sudo bash setup.sh
```

After that, `nanma-update` gets the latest version.

## Who can see and change what

- **Owner** – everything.
- **HR, department heads, managers and admins** – manage cards, clients and people. Salaries and attendance stay HR-only.
- **Staff** – their own work: start, stop and finish subtasks, comment, chat and request leave.
- Each person's own settings are private to them.
