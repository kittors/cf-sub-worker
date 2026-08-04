#!/bin/bash
# 部署到 Cloudflare Workers（Service Worker 格式 + KV 绑定）
#
#   export CF_API_TOKEN=...     需要 Workers Scripts Edit + Workers KV Storage Edit
#   export CF_ACCOUNT_ID=...    Cloudflare 控制台右侧栏可见
#   bash deploy.sh
#
# 脚本不含任何账号信息，凭据只从环境变量读取。
# 首次部署会生成一个初始化令牌并注入为 Worker secret，用于设置管理密码。
#
# 注意：PUT scripts 接口若 metadata 不带 bindings，会清空 Worker 现有绑定，
# 所以每次部署都必须把绑定重新声明一遍。

set -uo pipefail

SCRIPT="${WORKER_NAME:-sub-worker}"
KV_TITLE="${KV_TITLE:-sub-worker-conf}"
BINDING="CONF"

: "${CF_API_TOKEN:?请先 export CF_API_TOKEN}"
: "${CF_ACCOUNT_ID:?请先 export CF_ACCOUNT_ID}"
API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID"

api() { curl -s -H "Authorization: Bearer $CF_API_TOKEN" "$@"; }

# --- 1. 找或建 KV namespace ---
echo "→ 查找 KV namespace [$KV_TITLE]"
NS=$(api "$API/storage/kv/namespaces?per_page=100" | python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception: print('ERR'); sys.exit()
if not d.get('success'): print('ERR'); sys.exit()
print(next((n['id'] for n in d.get('result', []) if n.get('title') == '$KV_TITLE'), ''))
")

if [ "$NS" = "ERR" ]; then
  echo "❌ 无法访问 KV API"
  echo "   token 需包含权限：Account | Workers KV Storage | Edit"
  exit 1
fi

if [ -z "$NS" ]; then
  echo "→ 创建 KV namespace [$KV_TITLE]"
  NS=$(api -X POST "$API/storage/kv/namespaces" \
    -H "Content-Type: application/json" \
    -d "{\"title\":\"$KV_TITLE\"}" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(d['result']['id'] if d.get('success') else 'ERR')
")
  if [ "$NS" = "ERR" ] || [ -z "$NS" ]; then echo "❌ 创建 KV namespace 失败"; exit 1; fi
fi
echo "  namespace_id = $NS"

# --- 2. 初始化令牌 ---
# 已注入过就沿用，否则每次部署都会让旧令牌失效
HAS_SETUP=$(api "$API/workers/scripts/$SCRIPT/settings" | python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception: print(''); sys.exit()
b = d.get('result', {}).get('bindings', []) if d.get('success') else []
print('yes' if any(x.get('name') == 'SETUP_TOKEN' for x in b) else '')
")
if [ -n "$HAS_SETUP" ] && [ -z "${SETUP_TOKEN:-}" ]; then
  KEEP=1
else
  KEEP=0
  export SETUP_TOKEN="${SETUP_TOKEN:-$(head -c 16 /dev/urandom | xxd -p | tr -d '\n')}"
fi

# --- 3. 部署 ---
cp worker.js "/tmp/${SCRIPT}.js"

METADATA=$(KEEP="$KEEP" NS="$NS" BINDING="$BINDING" python3 -c "
import json, os
b = [{'type': 'kv_namespace', 'name': os.environ['BINDING'], 'namespace_id': os.environ['NS']}]
if os.environ['KEEP'] == '1':
    b.append({'type': 'inherit', 'name': 'SETUP_TOKEN'})
else:
    b.append({'type': 'secret_text', 'name': 'SETUP_TOKEN', 'text': os.environ.get('SETUP_TOKEN', '')})
print(json.dumps({
  'body_part': 'script',
  'compatibility_date': '2025-04-01',
  'compatibility_flags': ['nodejs_compat'],
  'bindings': b
}))
")

echo "→ 部署 $SCRIPT"
api -X PUT "$API/workers/scripts/$SCRIPT" \
  -F "metadata=$METADATA;type=application/json" \
  -F "script=@/tmp/${SCRIPT}.js;type=application/javascript" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if not d.get('success'):
    print('❌ 失败:', json.dumps(d.get('errors'), ensure_ascii=False)); sys.exit(1)
print('✅ 部署成功')
" || exit 1

echo "→ 校验绑定"
api "$API/workers/scripts/$SCRIPT/settings" | python3 -c "
import sys, json
d = json.load(sys.stdin)
b = d.get('result', {}).get('bindings', []) if d.get('success') else []
names = {x.get('name'): x.get('type') for x in b}
print('   绑定:', ', '.join(f'{k}({v})' for k, v in names.items()) or '(无)')
if '$BINDING' not in names:
    print('   ❌ KV 绑定缺失，管理端将无法读写配置'); sys.exit(1)
"

if [ "$KEEP" = "0" ]; then
  echo
  echo "初始化令牌：$SETUP_TOKEN"
  echo "首次打开 /admin 用它验证身份并设置管理密码，之后不再需要。"
fi
