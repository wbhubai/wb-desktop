#!/usr/bin/env bash
# wb-desktop 控制面快捷封装（WB_PORT 可覆盖，默认 3081）
set -euo pipefail
BASE="http://127.0.0.1:${WB_PORT:-3081}"
cmd="${1:-status}"
case "$cmd" in
  status)   curl -sf "$BASE/api/status" ;;
  accounts) curl -sf "$BASE/api/accounts" ;;
  credits)  curl -sf "$BASE/api/credits" ;;
  checkin)  curl -sf -X POST "$BASE/api/checkin/run" ;;
  growth)   curl -sf -X POST "$BASE/api/growth/run" ;;
  travel)   curl -sf "$BASE/api/travel/status" ;;
  dispatch) curl -sf -X POST "$BASE/api/travel/run" ;;
  claim)    curl -sf -X POST "$BASE/api/travel/claim" ;;
  sync-models) curl -sf -X POST "$BASE/api/gateway/models/sync" ;;
  logs)     curl -sf "$BASE/api/logs" ;;
  usage)    curl -sf "$BASE/api/gateway/config" ;;
  key)      curl -sf "$BASE/api/gateway/config" | python -c "import json,sys; print(json.load(sys.stdin).get('virtualKey',''))" ;;
  switch)   # switch <accountId>
    [ $# -ge 2 ] || { echo '用法: wb.sh switch <accountId>' >&2; exit 2; }
    curl -sf -X POST "$BASE/api/gateway/config" -H 'content-type: application/json' -d "{\"activeAccountId\":\"$2\"}" ;;
  *)
    echo "用法: wb.sh {status|accounts|credits|checkin|growth|travel|dispatch|claim|sync-models|logs|usage|key|switch <id>}" >&2
    exit 2 ;;
esac
