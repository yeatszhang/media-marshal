#!/bin/bash
# macOS 本机构建与部署。运行数据、密钥和活动版本放在用户运行目录。
set -euo pipefail
umask 077
repo_dir=$(cd "$(dirname "$0")/.." && pwd)
runtime_dir="${MEDIA_MARSHAL_RUNTIME_DIR:-$HOME/Library/Application Support/MediaMarshal}"
export MEDIA_MARSHAL_DATA_DIR="${MEDIA_MARSHAL_DATA_DIR:-$runtime_dir/data}"
export MEDIA_MARSHAL_MEDIA_ROOT="${MEDIA_MARSHAL_MEDIA_ROOT:-/Volumes/Seagate}"
artifacts="$repo_dir/build-artifacts/local"
env_file="$runtime_dir/deployment.env"
mkdir -p "$runtime_dir" "$artifacts"

compose() {
  if [ -f "$env_file" ]; then
    docker compose --env-file "$env_file" -f "$repo_dir/deploy/local/compose.yaml" "$@"
  else
    docker compose -f "$repo_dir/deploy/local/compose.yaml" "$@"
  fi
}

build() {
  command -v node >/dev/null
  command -v npm >/dev/null
  command -v python3 >/dev/null
  docker info >/dev/null
  local revision
  revision=$(git -C "$repo_dir" rev-parse --short HEAD)
  if [ -n "$(git -C "$repo_dir" status --porcelain --untracked-files=normal)" ]; then revision="$revision-dirty"; fi
  export MEDIA_MARSHAL_LOCAL_TAG="${MEDIA_MARSHAL_LOCAL_TAG:-$revision}"
  mkdir -p "$repo_dir/build-artifacts/maven" "$artifacts/docker"
  printf '构建后端并运行测试……\n'
  if ! docker run --rm -v "$repo_dir:/build" -v "$repo_dir/build-artifacts/maven:/root/.m2" \
      -w /build/backend maven:3.9-eclipse-temurin-21 mvn -q package > "$artifacts/backend-build.log" 2>&1; then
    tail -60 "$artifacts/backend-build.log"
    return 1
  fi
  printf '验证 Codex 桥接……\n'
  python3 -m unittest discover -s "$repo_dir/scripts" -p test_codex_bridge.py
  printf '构建前端……\n'
  if ! (cd "$repo_dir/frontend" && npm ci --no-audit --no-fund && npm run build) > "$artifacts/frontend-build.log" 2>&1; then
    tail -60 "$artifacts/frontend-build.log"
    return 1
  fi
  # 只把打包产物送入 Docker，避免将源码缓存或私有数据带入构建上下文。
  python3 - "$repo_dir" "$artifacts/docker" <<'PY'
from pathlib import Path
import shutil, sys
root, output = map(Path, sys.argv[1:])
jars = [p for p in (root/'backend/target').glob('media-marshal-*.jar') if p.is_file()]
if len(jars) != 1:
    raise SystemExit('无法确定唯一后端构建产物')
shutil.copy2(jars[0], output/'app.jar')
if (output/'dist').exists(): shutil.rmtree(output/'dist')
shutil.copytree(root/'frontend/dist', output/'dist')
shutil.copy2(root/'frontend/nginx.conf', output/'nginx.conf')
for name in ('backend.Dockerfile', 'frontend.Dockerfile'):
    shutil.copy2(root/'deploy/local'/name, output/name)
PY
  compose build
  printf 'MEDIA_MARSHAL_LOCAL_TAG=%s\n' "$MEDIA_MARSHAL_LOCAL_TAG" > "$env_file.tmp"
  mv "$env_file.tmp" "$env_file"
  printf '构建完成：%s\n' "$MEDIA_MARSHAL_LOCAL_TAG"
}

backup_data() {
  python3 - "$MEDIA_MARSHAL_DATA_DIR" "$runtime_dir/backups" <<'PY'
from pathlib import Path
import datetime, sqlite3, sys
data, backups = map(Path, sys.argv[1:])
source = data/'media-marshal.db'
if source.exists():
    target = backups/datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
    target.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(source) as src, sqlite3.connect(target/source.name) as dst: src.backup(dst)
    (target/source.name).chmod(0o600)
    print('已备份当前数据库')
PY
}

start() {
  [ -d "$MEDIA_MARSHAL_DATA_DIR" ] || { printf '运行数据目录不存在：%s\n' "$MEDIA_MARSHAL_DATA_DIR" >&2; return 1; }
  [ -d "$MEDIA_MARSHAL_MEDIA_ROOT" ] || { printf '媒体卷不存在：%s\n' "$MEDIA_MARSHAL_MEDIA_ROOT" >&2; return 1; }
  printf '%s\n' "$repo_dir" > "$runtime_dir/project-path"
  install -m 700 "$repo_dir/deploy/local/start-on-login.sh" "$runtime_dir/start-on-login.sh"
  if ! cmp -s "$repo_dir/scripts/codex-bridge.py" "$runtime_dir/codex-bridge.py"; then
    install -m 700 "$repo_dir/scripts/codex-bridge.py" "$runtime_dir/codex-bridge.py"
    if launchctl print "gui/$(id -u)/com.zhangyichi.media-marshal.codex" >/dev/null 2>&1; then
      launchctl kickstart -k "gui/$(id -u)/com.zhangyichi.media-marshal.codex"
    fi
  fi
  compose up -d --no-build
  python3 - <<'PY'
import time, urllib.request
for attempt in range(30):
    try:
        for url in ['http://127.0.0.1:8080/api/watch-rules', 'http://127.0.0.1:3000/']:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status != 200: raise RuntimeError('服务未就绪')
        print('Media Marshal 网页及 API 已就绪')
        break
    except Exception:
        if attempt == 29: raise SystemExit('健康检查未通过，请查看容器日志')
        time.sleep(2)
PY
}

case "${1:-deploy}" in
  deploy) build; backup_data; start ;;
  build) build ;;
  start) start ;;
  stop) compose stop ;;
  status) compose ps ;;
  logs) compose logs --tail 100 ;;
  *) printf '用法：%s [deploy|build|start|stop|status|logs]\n' "$0" >&2; exit 2 ;;
esac
