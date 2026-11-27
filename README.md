# Nanma CRM

Internal work-management CRM for Nanma Branding: clients, card tables, subtasks with timers and ratings, internal and client approvals, content calendar, leave, messenger, billing, operating cost, AI credits, attendance and salary (eSSL import), reports and HR tools.

## What's in this repository

- `index.html` – the whole app (HTML, CSS and JavaScript in one file).

## Important: how it runs today

This version runs inside **claude.ai** as an artifact. It uses claude.ai's built-in services through `window.claude.use(...)`:

| Service | Used for |
|---|---|
| `db` | All data (clients, cards, time logs, leave, chat, settings…) |
| `user` | Who is signed in (their id, name and edit rights) |
| `assets` | Uploaded files and pictures |

These services do not exist on an ordinary web server. Opening `index.html` on Hostinger as it is will show an empty page that can't load or save anything.

## Moving to our own server (Hostinger)

To run on our own server the app needs:

1. **A database** (MySQL on Hostinger) – replaces `db`.
2. **Sign-in** (our own accounts) – replaces `user`.
3. **File storage** on the server – replaces `assets`.
4. **A small server program** (Node.js) that the page talks to for the above.

The page code stays almost the same: a replacement for `window.claude.use(...)` is added that talks to our server instead. Data is copied from the claude.ai version once the server is ready.

## Not stored in this repository

No passwords, salaries or employee data are in this file. All data lives in the database.
