#!/bin/bash
# /opt/addpilot/external-ping.sh
# Cron: */15 * * * * TELEGRAM_BOT_TOKEN=<token> /opt/addpilot/external-ping.sh
#
# Independent uptime monitor — works even if Convex is down.
# Alerts on 2 consecutive failures to avoid false positives.

TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
ADMIN_CHAT_ID="325307765"
STATE_FILE="/tmp/addpilot_ping_state"

# Create state file if missing
touch "$STATE_FILE"

URLS=(
  "https://convex.aipilot.by"
  "https://aipilot.by"
)

for url in "${URLS[@]}"; do
  status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null)
  key=$(echo "$url" | md5sum 2>/dev/null | cut -c1-8 || echo "$url" | md5 -q 2>/dev/null | cut -c1-8)

  prev_fail=$(grep "^${key}=" "$STATE_FILE" 2>/dev/null | cut -d= -f2)

  if [ "$status" -lt 200 ] 2>/dev/null || [ "$status" -ge 500 ] 2>/dev/null || [ -z "$status" ]; then
    if [ "$prev_fail" = "1" ]; then
      # Second consecutive failure — send alert
      if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
        curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
          -d chat_id="$ADMIN_CHAT_ID" \
          -d "text=🔴 Сервис недоступен: ${url} (HTTP ${status:-timeout})" \
          > /dev/null 2>&1
      fi
    fi
    # Mark as failed
    if grep -q "^${key}=" "$STATE_FILE" 2>/dev/null; then
      sed -i "s/^${key}=.*/${key}=1/" "$STATE_FILE" 2>/dev/null || \
        sed -i '' "s/^${key}=.*/${key}=1/" "$STATE_FILE"
    else
      echo "${key}=1" >> "$STATE_FILE"
    fi
  else
    # Mark as ok
    if grep -q "^${key}=" "$STATE_FILE" 2>/dev/null; then
      sed -i "s/^${key}=.*/${key}=0/" "$STATE_FILE" 2>/dev/null || \
        sed -i '' "s/^${key}=.*/${key}=0/" "$STATE_FILE"
    else
      echo "${key}=0" >> "$STATE_FILE"
    fi
  fi
done
