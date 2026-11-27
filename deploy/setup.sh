#!/usr/bin/env bash
# Nanma CRM – one-time setup on an Ubuntu 22.04/24.04 server (run as root).
# Safe to run again: it updates the code and keeps the data.
set -euo pipefail

DOMAIN="${DOMAIN:-crm.nanmabranding.cloud}"
EMAIL="${EMAIL:-hr@nanmabranding.com}"
PORT="${PORT:-3100}"
REPO="https://github.com/SniPerAshAn/nanma-crm.git"
APP=/opt/nanma-crm
DATA=/var/lib/nanma-crm
BACKUPS=/var/backups/nanma-crm
OWNER_ID="u_itNRQ_y8RhKbiy1QYdTsHA"

say(){ printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die(){ printf '\n\033[31mSTOPPED: %s\033[0m\n' "$*"; exit 1; }
[ "$(id -u)" = 0 ] || die "Run this as root."

say "Checking that nothing else is using the web ports"
for p in 80 443; do
  holder=$(ss -ltnpH "sport = :$p" 2>/dev/null | grep -o 'users:(("[^"]*' | head -1 | sed 's/users:(("//' || true)
  if [ -n "$holder" ] && [ "$holder" != "nginx" ]; then
    die "Port $p is already used by '$holder'. Nothing was changed. Send this message to Claude so the setup can be adjusted."
  fi
done
if ss -ltnH "sport = :$PORT" | grep -q . && ! systemctl is-active --quiet nanma-crm; then
  die "Port $PORT is already in use by another program. Nothing was changed. Send this message to Claude."
fi

say "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git nginx sqlite3 certbot python3-certbot-nginx

need_node=1
if command -v node >/dev/null; then
  major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 22 ] && need_node=0
fi
if [ $need_node = 1 ]; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -e 'require("node:sqlite")' 2>/dev/null || die "This Node.js version has no built-in SQLite. Send this message to Claude."

say "Getting the CRM code"
id nanma >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin nanma
if [ -d "$APP/.git" ]; then git -C "$APP" pull --ff-only; else git clone "$REPO" "$APP"; fi
mkdir -p "$DATA/files" "$BACKUPS"
[ -f "$DATA/config.json" ] || printf '{"port":%s,"ownerId":"%s","ownerName":"Mark Antony Francis"}\n' "$PORT" "$OWNER_ID" > "$DATA/config.json"
chown -R nanma:nanma "$DATA"; chmod 700 "$DATA"

if [ ! -f "$DATA/.owner-set" ]; then
  say "Choose the owner sign-in for the CRM"
  read -rp "Owner username (for example mark): " OU
  while :; do
    read -rsp "Owner password (6+ characters, hidden while typing): " OP; echo
    read -rsp "Type it again: " OP2; echo
    [ "$OP" = "$OP2" ] && [ ${#OP} -ge 6 ] && break
    echo "They didn't match or were too short – try again."
  done
  sudo -u nanma NANMA_DATA="$DATA" node --disable-warning=ExperimentalWarning "$APP/server/server.js" set-password "$OU" "$OP" "$OWNER_ID"
  unset OP OP2; touch "$DATA/.owner-set"; chown nanma:nanma "$DATA/.owner-set"
fi

say "Starting the CRM service"
cat > /etc/systemd/system/nanma-crm.service <<EOF
[Unit]
Description=Nanma CRM
After=network.target

[Service]
User=nanma
Environment=NANMA_DATA=$DATA
WorkingDirectory=$APP
ExecStart=$(command -v node) --disable-warning=ExperimentalWarning $APP/server/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable nanma-crm >/dev/null
systemctl restart nanma-crm
sleep 2
curl -fs "http://127.0.0.1:$PORT/healthz" >/dev/null || die "The CRM didn't start. Run: journalctl -u nanma-crm -n 50   and send the output to Claude."

say "Setting up the web address $DOMAIN"
cat > /etc/nginx/sites-available/nanma-crm <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 30m;
    gzip on;
    gzip_types text/html text/javascript application/json text/css;
    location /api/events {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_read_timeout 1h;
        proxy_set_header X-Real-IP \$remote_addr;
    }
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
ln -sf /etc/nginx/sites-available/nanma-crm /etc/nginx/sites-enabled/nanma-crm
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow "Nginx Full" >/dev/null; fi
nginx -t
systemctl enable --now nginx >/dev/null
systemctl reload nginx

say "Getting the free HTTPS certificate"
if ! certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
  echo "Couldn't get the certificate yet (the web address may still be spreading – this can take up to an hour)."
  echo "Run this setup again later; everything else is already done."
fi

say "Nightly backups (kept for 30 days)"
cat > /usr/local/bin/nanma-backup <<EOF
#!/bin/sh
set -e
d=\$(date +%F)
sqlite3 $DATA/crm.db ".backup '$BACKUPS/crm-\$d.db'"
mkdir -p $BACKUPS/files && cp -rn $DATA/files/. $BACKUPS/files/ 2>/dev/null || true
find $BACKUPS -maxdepth 1 -name 'crm-*.db' -mtime +30 -delete
EOF
chmod +x /usr/local/bin/nanma-backup
echo "30 2 * * * root /usr/local/bin/nanma-backup" > /etc/cron.d/nanma-crm

cat > /usr/local/bin/nanma-update <<EOF
#!/bin/sh
set -e
git -C $APP pull --ff-only
systemctl restart nanma-crm
echo "Nanma CRM updated."
EOF
chmod +x /usr/local/bin/nanma-update

say "Done!"
echo "Open https://$DOMAIN and sign in with the owner username and password you just chose."
echo "To get future updates, run:  nanma-update"
