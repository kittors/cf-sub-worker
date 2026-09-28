#!/bin/bash
# 部署到 Cloudflare Workers（Service Worker 格式 + KV 绑定）
#
#   export CF_API_TOKEN=...     需要 Workers Scripts Edit + Workers KV Storage Edit
#   export CF_ACCOUNT_ID=...    Cloudflare 控制台右侧栏可见
#   bash deploy.sh
#
#   DRY_RUN=1 bash deploy.sh    只核对：打印将要提交的绑定，不真的部署
#   SKIP_TESTS=1 bash deploy.sh 跳过部署前的测试
#   KV_NAMESPACE_ID=... bash deploy.sh  明确指定 KV namespace（默认沿用已绑定的，首次部署按名字找或新建）
#
# 脚本不含任何账号信息，凭据只从环境变量读取。
# 首次部署会生成一个初始化令牌并注入为 Worker secret，用于设置管理密码。
#
# 注意：PUT scripts 接口若 metadata 不带 bindings，会清空 Worker 现有绑定，
# 所以每次部署都必须把绑定重新声明一遍。控制台里另加的 secret 也一样，
# 这里会逐个以 inherit 带上 —— secret 的值读不回来，删了就再也找不回。

set -uo pipefail
cd "$(dirname "$0")"

SCRIPT="${WORKER_NAME:-sub-worker}"
KV_TITLE="${KV_TITLE:-sub-worker-conf}"
BINDING="CONF"

: "${CF_API_TOKEN:?请先 export CF_API_TOKEN}"
: "${CF_ACCOUNT_ID:?请先 export CF_ACCOUNT_ID}"
API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/$CF_ACCOUNT_ID"

api() { curl -s -H "Authorization: Bearer $CF_API_TOKEN" "$@"; }

# --- 0. 部署前先跑测试：线上配置是真人在用的，别把一个跑不通的版本推上去 ---
if [ -z "${SKIP_TESTS:-}" ]; then
  if command -v node >/dev/null 2>&1 && [ -d test/node_modules/js-yaml ]; then
    echo "→ 运行测试"
    if ! (cd test && node run.cjs > /tmp/cf-sub-worker-test.log 2>&1); then
      tail -5 /tmp/cf-sub-worker-test.log
      echo "❌ 测试没通过，已中止部署（完整输出见 /tmp/cf-sub-worker-test.log；确要跳过用 SKIP_TESTS=1）"
      exit 1
    fi
    echo "  $(grep -E '通过 [0-9]+' /tmp/cf-sub-worker-test.log | tail -1 | tr -s ' ')"
  else
    echo "→ 跳过测试（没装依赖：cd test && npm install）"
  fi
fi

# --- 1. 读 Worker 现有设置：绑定、secret 都从这一份里取 ---
# 三种结果必须分清：读到了（沿用现有绑定）、Worker 不存在（首次部署）、读失败。
# 读失败绝不能当成首次部署 —— 那样会新建一个空 KV 绑上去、换掉初始化令牌、
# 丢掉控制台里另加的 secret，线上配置当场清空。网络抖一下、被限流一次就够触发。
SETTINGS=$(api -w '\n%{http_code}' "$API/workers/scripts/$SCRIPT/settings")
STATE=$(SETTINGS="$SETTINGS" python3 -c "
import os, json
raw, _, code = os.environ['SETTINGS'].rpartition('\n')
try: d = json.loads(raw)
except Exception: d = {}
if d.get('success'): print('ok')
elif code == '404' and any(e.get('code') == 10007 for e in d.get('errors', [])): print('new')
else: print('err:' + code + ' ' + json.dumps(d.get('errors', raw[:200]), ensure_ascii=False))
")
case "$STATE" in
  ok)  echo "→ 读到 Worker [$SCRIPT] 的现有设置" ;;
  new) echo "→ Worker [$SCRIPT] 还不存在，按首次部署处理" ;;
  *)   echo "❌ 读取 Worker 现有设置失败（${STATE#err:}）"
       echo "   为免把线上绑定当成空的覆盖掉，已中止。稍后重试即可。"
       exit 1 ;;
esac
field() {
  SETTINGS="$SETTINGS" python3 -c "
import os, json, sys
raw = os.environ['SETTINGS'].rpartition('\n')[0]
try: d = json.loads(raw)
except Exception: d = {}
b = d.get('result', {}).get('bindings', []) if d.get('success') else []
k = sys.argv[1]
if k == 'kv':
    print(next((x.get('namespace_id', '') for x in b if x.get('type') == 'kv_namespace' and x.get('name') == '$BINDING'), ''))
elif k == 'setup':
    print('yes' if any(x.get('name') == 'SETUP_TOKEN' for x in b) else '')
elif k == 'keep':
    # 脚本自己管的只有 CONF 与 SETUP_TOKEN。其余绑定（控制台里另加的 secret、变量、别的 KV……）
    # 一律原样继承 —— secret 的值读不回来，丢了就再也找不回
    print(' '.join(x['name'] for x in b if x.get('name') not in ('$BINDING', 'SETUP_TOKEN')))
elif k == 'all':
    print(' '.join(x['name'] for x in b))
" "$1"
}
BOUND_NS=$(field kv)
HAS_SETUP=$(field setup)
KEEP_BINDINGS=$(field keep)
BEFORE_ALL=$(field all)

# --- 2. KV namespace：优先沿用已绑定的那个 ---
# 按名字找只是首次部署的办法。已经在跑的 Worker 必须继续用它现在绑着的 namespace ——
# 名字对不上、或者账号里 namespace 太多一页列不全时，按名字找会「找不到」，
# 接着新建一个空的绑上去，线上全部配置就这么没了。
if [ -n "${KV_NAMESPACE_ID:-}" ]; then
  NS="$KV_NAMESPACE_ID"
  echo "→ 使用指定的 KV namespace（KV_NAMESPACE_ID）"
  if [ -n "$BOUND_NS" ] && [ "$BOUND_NS" != "$NS" ]; then
    echo "   ⚠️  和现在绑着的 $BOUND_NS 不同：部署后 Worker 将读写新指定的这个"
  fi
elif [ -n "$BOUND_NS" ]; then
  NS="$BOUND_NS"
  echo "→ 沿用已绑定的 KV namespace"
else
  echo "→ 查找 KV namespace [$KV_TITLE]"
  NS=""
  PAGE=1
  while :; do
    R=$(api "$API/storage/kv/namespaces?per_page=100&page=$PAGE" | KV_TITLE="$KV_TITLE" python3 -c "
import sys, json, os
try: d = json.load(sys.stdin)
except Exception: print('ERR'); sys.exit()
if not d.get('success'): print('ERR'); sys.exit()
r = d.get('result', [])
hit = next((n['id'] for n in r if n.get('title') == os.environ['KV_TITLE']), '')
print(hit or ('MORE' if len(r) == 100 else ''))
")
    if [ "$R" = "ERR" ]; then
      echo "❌ 无法访问 KV API"
      echo "   token 需包含权限：Account | Workers KV Storage | Edit"
      exit 1
    fi
    if [ "$R" = "MORE" ]; then PAGE=$((PAGE + 1)); continue; fi
    NS="$R"
    break
  done
  if [ -z "$NS" ]; then
    if [ -n "${DRY_RUN:-}" ]; then
      NS="（将新建 $KV_TITLE）"
    else
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
  fi
fi
echo "  namespace_id = $NS"

# --- 3. 初始化令牌 ---
# 已注入过就沿用，否则每次部署都会让旧令牌失效
if [ -n "$HAS_SETUP" ] && [ -z "${SETUP_TOKEN:-}" ]; then
  KEEP=1
else
  KEEP=0
  export SETUP_TOKEN="${SETUP_TOKEN:-$(head -c 16 /dev/urandom | xxd -p | tr -d '\n')}"
fi

# --- 4. 部署 ---
METADATA=$(KEEP="$KEEP" NS="$NS" BINDING="$BINDING" KEEP_BINDINGS="$KEEP_BINDINGS" python3 -c "
import json, os
b = [{'type': 'kv_namespace', 'name': os.environ['BINDING'], 'namespace_id': os.environ['NS']}]
if os.environ['KEEP'] == '1':
    b.append({'type': 'inherit', 'name': 'SETUP_TOKEN'})
else:
    b.append({'type': 'secret_text', 'name': 'SETUP_TOKEN', 'text': os.environ.get('SETUP_TOKEN', '')})
for n in os.environ.get('KEEP_BINDINGS', '').split():
    b.append({'type': 'inherit', 'name': n})
print(json.dumps({
  'body_part': 'script',
  'compatibility_date': '2025-04-01',
  'compatibility_flags': ['nodejs_compat'],
  'bindings': b
}))
")

if [ -n "${DRY_RUN:-}" ]; then
  echo "→ 空跑：将提交以下绑定（secret 的值已隐去）"
  METADATA="$METADATA" python3 -c "
import os, json
for b in json.loads(os.environ['METADATA'])['bindings']:
    extra = b.get('namespace_id') or ('<新生成的令牌>' if b['type'] == 'secret_text' else '')
    print('   %-14s %-14s %s' % (b['name'], b['type'], extra))
"
  echo "  未部署。去掉 DRY_RUN 即正式部署。"
  exit 0
fi

echo "→ 部署 $SCRIPT"
# bindings_inherit=strict：继承不到的绑定直接报错，而不是被静默丢掉
# 脚本直接从仓库里读（上面已 cd 到脚本所在目录），不经过 /tmp 里可能被人预先放好的同名文件
api -X PUT "$API/workers/scripts/$SCRIPT?bindings_inherit=strict" \
  -F "metadata=$METADATA;type=application/json" \
  -F "script=@worker.js;type=application/javascript" | python3 -c "
import sys, json
try: d = json.load(sys.stdin)
except Exception: print('❌ 部署接口返回的不是 JSON'); sys.exit(1)
if not d.get('success'):
    print('❌ 失败:', json.dumps(d.get('errors'), ensure_ascii=False)); sys.exit(1)
print('✅ 部署成功')
" || exit 1

echo "→ 校验绑定"
# 和部署前完整的绑定清单比：之前有的，现在一个都不能少
api "$API/workers/scripts/$SCRIPT/settings" | NS="$NS" BEFORE_ALL="$BEFORE_ALL" python3 -c "
import sys, json, os
try: d = json.load(sys.stdin)
except Exception: d = {}
if not d.get('success'):
    print('   ⚠️  部署后读不到设置，没能校验绑定，请到控制台确认'); sys.exit(1)
b = d.get('result', {}).get('bindings', [])
names = {x.get('name'): x.get('type') for x in b}
print('   绑定:', ', '.join(f'{k}({v})' for k, v in names.items()) or '(无)')
kv = next((x for x in b if x.get('name') == '$BINDING'), None)
if not kv:
    print('   ❌ KV 绑定缺失，管理端将无法读写配置'); sys.exit(1)
if kv.get('namespace_id') and kv.get('namespace_id') != os.environ['NS']:
    print('   ❌ KV 绑到了别的 namespace：', kv.get('namespace_id')); sys.exit(1)
lost = [n for n in os.environ.get('BEFORE_ALL', '').split() if n not in names]
if lost:
    print('   ❌ 这些绑定部署前还在、现在没了：', ', '.join(lost)); sys.exit(1)
"

if [ "$KEEP" = "0" ]; then
  echo
  echo "初始化令牌：$SETUP_TOKEN"
  echo "首次打开 /admin 用它验证身份并设置管理密码，之后不再需要。"
fi
echo
echo "部署后边缘节点要几十秒才全部更新，验证前先等一会儿。"
