#!/usr/bin/env bash
# 更換 LINE 官方帳號（Messaging API channel）的金鑰。金鑰由您在終端機輸入，不會顯示也不會留在指令紀錄裡。
#   ssh -t root@您的主機 'bash /opt/octopus/deploy/set-line.sh'
set -euo pipefail
DIR=/opt/octopus; ENV=$DIR/.env
[ -f "$ENV" ] || { echo "找不到 $ENV，請先執行安裝腳本"; exit 1; }
ask() { local p="$1" d="${2:-}" v; read -r -p "$p${d:+ [$d]}: " v </dev/tty || true; echo "${v:-$d}"; }
ask_secret() { local p="$1" v; read -r -s -p "$p: " v </dev/tty || true; echo >/dev/tty; echo "$v"; }
cur() { grep -E "^$1=" "$ENV" | head -1 | cut -d= -f2-; }
setv() { local k="$1" v="$2" t; t=$(mktemp); grep -vE "^$k=" "$ENV" > "$t" || true; printf '%s=%s\n' "$k" "$v" >> "$t"; cat "$t" > "$ENV"; rm -f "$t"; }

echo "更換 LINE 官方帳號。直接按 Enter 表示該項不變。"
TOKEN=$(ask_secret '新的 Channel access token（輸入時不顯示）')
SECRET=$(ask_secret '新的 Channel secret（輸入時不顯示）')
LIFF=$(ask 'LIFF ID' "$(cur LIFF_ID)")
LOGIN=$(ask 'LINE Login Channel ID' "$(cur LINE_LOGIN_CHANNEL_ID)")

cp "$ENV" "$ENV.bak.$(date +%Y%m%d%H%M%S)"; chmod 600 "$ENV".bak.* 2>/dev/null || true
[ -n "$TOKEN" ] && setv LINE_CHANNEL_ACCESS_TOKEN "$TOKEN"
[ -n "$SECRET" ] && setv LINE_CHANNEL_SECRET "$SECRET"
setv LIFF_ID "$LIFF"; setv LINE_LOGIN_CHANNEL_ID "$LOGIN"
chmod 600 "$ENV"

cd "$DIR"
if [ -n "$TOKEN" ]; then # 先確認金鑰有效，並顯示是哪一個官方帳號
  INFO=$(curl -fsS -m 15 -H "Authorization: Bearer $TOKEN" https://api.line.me/v2/bot/info || true)
  if [ -n "$INFO" ]; then echo "已連上官方帳號：$(echo "$INFO" | sed -n 's/.*"displayName":"\([^"]*\)".*/\1/p') $(echo "$INFO" | sed -n 's/.*"basicId":"\([^"]*\)".*/\1/p')"
  else echo "⚠ 無法用這組 access token 連上 LINE，請確認有沒有貼完整。設定仍已寫入，原設定備份在 $ENV.bak.*"; fi
fi
PROFILE=$(docker compose ps --format '{{.Service}}' 2>/dev/null | grep -qx caddy && echo caddy || true)
GIT_SHA=$(git rev-parse --short HEAD) COMPOSE_PROFILES=$PROFILE docker compose up -d --force-recreate
DOMAIN=$(cur DOMAIN || true)
cat <<MSG

完成，服務已用新的設定重新啟動。接下來請到 LINE Developers 的「新」官方帳號：
  1. Messaging API → Webhook URL 填 https://${DOMAIN:-您的網域}/webhook，按 Verify，並開啟 Use webhook
  2. 官方帳號管理後台 → 回應設定：關閉「自動回應訊息」
  3. 回到系統後台「設定 → LINE 圖文選單」按「重新套用圖文選單」
MSG
