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

echo
echo "新的官方帳號如果和原本的 LINE Login 在「不同的 Provider」，LINE 給每個人的使用者 ID 會全部不同，"
echo "舊的家長綁定和管理員身分都會失效，需要清掉後重新綁定（學生、課程、上課卡、出席、帳務資料都會保留）。"
RESET=$(ask '是否清除舊的 LINE 綁定與管理員？輸入 yes 清除，其他＝不清除' 'no')

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
if [ "$RESET" = "yes" ]; then
  sleep 3
  docker compose exec -T app node --no-warnings --input-type=module -e '
    import { DatabaseSync } from "node:sqlite";
    const f = (process.env.DATA_DIR || "/data") + "/octopus.db", db = new DatabaseSync(f);
    db.exec("PRAGMA busy_timeout=5000");
    const n = t => db.prepare("SELECT COUNT(*) n FROM " + t).get().n;
    const bak = f.replace(/octopus\.db$/, "before-switch-" + Date.now() + ".db");
    db.exec("VACUUM INTO \x27" + bak + "\x27");
    console.log("清除前：家長綁定 " + n("bindings") + " 筆、管理員／老師 " + n("admins") + " 位（已另存備份 " + bak + "）");
    db.exec("BEGIN IMMEDIATE; DELETE FROM bindings; DELETE FROM admins; UPDATE bookings SET user_id=\x27\x27 WHERE user_id<>\x27\x27; UPDATE signups SET status=\x27已婉拒\x27 WHERE status=\x27待審核\x27; DELETE FROM meta WHERE key IN (\x27bot_basic_id\x27,\x27richmenu_id\x27); COMMIT;");
    console.log("已清除。學生 " + n("students") + " 位、課程 " + n("courses") + " 門、上課卡 " + n("cards") + " 張都保留。");
  ' || echo "⚠ 清除失敗，資料沒有變動，請把這段訊息傳給協助您的人"
  docker compose restart app >/dev/null
  echo "請用 LINE 開啟後台，輸入安裝碼重新成為管理員。安裝碼：$(cur SETUP_CODE)"
fi
DOMAIN=$(cur DOMAIN || true)
cat <<MSG

完成，服務已用新的設定重新啟動。接下來請到 LINE Developers 的「新」官方帳號：
  1. Messaging API → Webhook URL 填 https://${DOMAIN:-您的網域}/webhook，按 Verify，並開啟 Use webhook
  2. 官方帳號管理後台 → 回應設定：關閉「自動回應訊息」
  3. 回到系統後台「設定 → LINE 圖文選單」按「重新套用圖文選單」
MSG
