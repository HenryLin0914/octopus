#!/usr/bin/env bash
# 舞蹈教室報到系統 — VPS 安裝／更新腳本（可重複執行）
# 用法（在自己的電腦上執行，金鑰只會輸入到您自己的終端機）：
#   ssh -t root@henrylin.tw 'bash <(curl -fsSL https://raw.githubusercontent.com/HenryLin0914/octopus/main/deploy/install.sh)'
set -euo pipefail
REPO=https://github.com/HenryLin0914/octopus.git
DIR=/opt/octopus
DOMAIN_DEFAULT=octopus-style-class.henrylin.tw
say() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }
ask() { local p="$1" d="${2:-}" v; read -r -p "$p${d:+ [$d]}: " v </dev/tty || true; echo "${v:-$d}"; }
ask_secret() { local p="$1" v; read -r -s -p "$p: " v </dev/tty || true; echo >/dev/tty; echo "$v"; }

[ "$(id -u)" = 0 ] || { echo "請用 root 執行"; exit 1; }

say "檢查 Docker"
if ! command -v docker >/dev/null 2>&1; then
  warn "這台主機還沒有 Docker。"
  [ "$(ask '要現在安裝 Docker 嗎？(y/N)' N)" = y ] || { echo "已取消。請先安裝 Docker 後再執行。"; exit 1; }
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "找不到 docker compose 外掛，請先安裝 docker-compose-plugin"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "找不到 git，請先安裝（apt install -y git）"; exit 1; }

say "下載程式到 $DIR"
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch -q origin main && git -C "$DIR" reset -q --hard origin/main
else git clone -q --depth 1 "$REPO" "$DIR"; fi
cd "$DIR"

if [ ! -f .env ]; then
  say "第一次安裝：設定（直接按 Enter 使用預設值）"
  DOMAIN=$(ask '網域' "$DOMAIN_DEFAULT")
  LIFF_ID=$(ask 'LIFF ID' '2011843526-LFRnD0q5')
  LOGIN_ID=$(ask 'LINE Login Channel ID' '2011843526')
  echo "接下來兩項是機密，輸入時畫面不會顯示。請從 LINE Developers 的 Messaging API channel 複製："
  TOKEN=$(ask_secret 'Channel access token')
  SECRET=$(ask_secret 'Channel secret（Basic settings 頁）')
  SETUP_CODE=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')
  umask 077
  cat > .env <<ENV
DOMAIN=$DOMAIN
LIFF_ID=$LIFF_ID
LINE_LOGIN_CHANNEL_ID=$LOGIN_ID
LINE_CHANNEL_ACCESS_TOKEN=$TOKEN
LINE_CHANNEL_SECRET=$SECRET
SETUP_CODE=$SETUP_CODE
APP_PORT=8787
COMPOSE_PROFILES=
ENV
  umask 022
fi
set -a; . ./.env; set +a

say "決定 HTTPS 的處理方式"
port_busy() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"; }
ours_caddy() { docker compose ps --format '{{.Service}}' 2>/dev/null | grep -qx caddy; }
MODE=manual
if ours_caddy || { ! port_busy 80 && ! port_busy 443; }; then MODE=caddy
elif command -v nginx >/dev/null 2>&1 && [ -d /etc/nginx ]; then MODE=nginx; fi
sed -i "s/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=$([ $MODE = caddy ] && echo caddy)/" .env
echo "方式：$MODE"

say "建置並啟動容器"
mkdir -p data && chown 1000:1000 data
GIT_SHA=$(git rev-parse --short HEAD) COMPOSE_PROFILES=$([ $MODE = caddy ] && echo caddy || true) docker compose up -d --build --remove-orphans
for i in $(seq 1 30); do curl -fsS "http://127.0.0.1:${APP_PORT:-8787}/api/health" >/dev/null 2>&1 && break; sleep 1; done
curl -fsS "http://127.0.0.1:${APP_PORT:-8787}/api/health" && echo

if [ $MODE = nginx ]; then
  say "主機已有 nginx：只新增／更新這個站台自己的設定檔（不動其他站台）"
  CONF=/etc/nginx/conf.d/octopus-style-class.conf
  PROXY="        proxy_pass http://127.0.0.1:${APP_PORT:-8787};
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;"
  # 找一個已經在用、且憑證涵蓋本網域（例如萬用憑證 *.henrylin.tw）的站台，沿用它的 SSL 設定
  SSL_LINES=""; LISTEN=""; H2=""
  for f in /etc/nginx/conf.d/*.conf; do
    [ "$f" = "$CONF" ] && continue
    crt=$(grep -m1 -E '^\s*ssl_certificate\s' "$f" 2>/dev/null | awk '{print $2}' | tr -d ';') || true
    [ -n "$crt" ] && [ -f "$crt" ] || continue
    sans=$(openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | tr ',' '\n' | sed 's/.*DNS://' | tr -d ' ') || continue
    ok=0; for n in $sans; do case "$n" in "$DOMAIN") ok=1;; \*.*) [ "${DOMAIN#*.}" = "${n#\*.}" ] && ok=1;; esac; done
    [ $ok = 1 ] || continue
    SSL_LINES=$(grep -E '^\s*(ssl_certificate|ssl_certificate_key|ssl_dhparam|ssl_trusted_certificate)\s|^\s*include\s+\S*(ssl|letsencrypt)\S*;' "$f" | sed 's/^\s*/    /' | awk '!seen[$0]++' || true)
    LISTEN=$(grep -E '^\s*listen\s+(\[::\]:)?443' "$f" | sed 's/^\s*/    /' | sed -E 's/\s+default_server//' | awk '!seen[$0]++' || true)
    if grep -qE '^\s*http2\s+on;' "$f"; then H2="    http2 on;"; fi
    echo "沿用 $f 的憑證設定（$crt）"; break
  done
  [ -f "$CONF" ] && cp "$CONF" "$CONF.prev"
  if [ -n "$SSL_LINES" ] && [ -n "$LISTEN" ]; then
    cat > "$CONF" <<NGX
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}
server {
$LISTEN
$H2
    server_name $DOMAIN;
$SSL_LINES
    client_max_body_size 2m;
    location / {
$PROXY
    }
}
NGX
  elif [ ! -f "$CONF" ]; then
    cat > "$CONF" <<NGX
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 2m;
    location / {
$PROXY
    }
}
NGX
  fi
  if nginx -t 2>/tmp/octopus-nginx-test.log; then nginx -s reload; rm -f "$CONF.prev"
  else
    warn "nginx 設定檢查沒過，已還原。錯誤訊息："; cat /tmp/octopus-nginx-test.log
    if [ -f "$CONF.prev" ]; then mv "$CONF.prev" "$CONF"; else rm -f "$CONF"; fi
  fi
  if [ -f "$CONF" ] && ! grep -q ssl_certificate "$CONF"; then
    if command -v certbot >/dev/null 2>&1; then certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || warn "憑證申請失敗（多半是 DNS 還沒指到這台）。DNS 生效後重跑這個腳本即可。"
    else warn "找不到涵蓋 $DOMAIN 的現成憑證，也沒有 certbot，尚未啟用 HTTPS。"; fi
  fi
  say "檢查對外連線"
  code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/health" || true)
  echo "https://$DOMAIN/api/health → HTTP $code"
  if [ "$code" != 200 ]; then
    warn "還沒通。以下資訊請截圖回報："
    echo "--- $CONF"; cat "$CONF" 2>/dev/null
    echo "--- 其他站台的 listen／憑證設定"; grep -HnE '^\s*(listen|ssl_certificate\s|server_name)' /etc/nginx/conf.d/*.conf 2>/dev/null | grep -v "$CONF" | head -40
    [ -f /etc/nginx/conf.d/subdomain.conf.template ] && { echo "--- subdomain.conf.template"; cat /etc/nginx/conf.d/subdomain.conf.template; }
  fi
elif [ $MODE = manual ]; then
  warn "80/443 已被其他程式使用，而且不是 nginx。請在現有的反向代理加一筆：$DOMAIN → http://127.0.0.1:${APP_PORT:-8787}"
  echo "目前佔用 80/443 的程式："; ss -ltnp 2>/dev/null | grep -E ':(80|443) ' || true
fi

say "自動更新"
CRON=/etc/cron.d/octopus-update
if [ ! -f "$CRON" ] && [ ! -f "$DIR/.no-auto-update" ]; then
  if [ "$(ask '要每 2 分鐘自動檢查 GitHub 並更新嗎？（之後改版不用再登入主機）(Y/n)' Y)" != n ]; then
    cat > "$CRON" <<CR
*/2 * * * * root cd $DIR && git fetch -q origin main && [ "\$(git rev-parse HEAD)" != "\$(git rev-parse origin/main)" ] && git reset -q --hard origin/main && GIT_SHA=\$(git rev-parse --short HEAD) docker compose up -d --build --remove-orphans >> /var/log/octopus-update.log 2>&1
CR
    chmod 644 "$CRON"; echo "已啟用。要停用請刪除 $CRON"
  else touch "$DIR/.no-auto-update"; fi
fi

say "完成"
cat <<DONE
網站：        https://$DOMAIN/
後台：        https://liff.line.me/$LIFF_ID/admin.html
安裝碼：      $SETUP_CODE   ← 第一次開後台時輸入，就會成為管理員

還要到 LINE Developers 改兩個網址：
  1. LINE Login channel → LIFF → Endpoint URL：   https://$DOMAIN/
  2. Messaging API → Webhook URL：                https://$DOMAIN/webhook

資料庫：$DIR/data/octopus.db（每日備份在 $DIR/data/backups，保留 14 天）
移除整套系統：cd $DIR && docker compose --profile caddy down && rm -rf $DIR /etc/cron.d/octopus-update /etc/nginx/conf.d/octopus-style-class.conf
DONE
