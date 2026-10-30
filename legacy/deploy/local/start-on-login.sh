#!/bin/bash
# 登录后等待实际外置盘和 Docker；本次启动成功后不干预手动停止。
set -eu
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
runtime_dir="${MEDIA_MARSHAL_RUNTIME_DIR:-$HOME/Library/Application Support/MediaMarshal}"
boot_id=$(/usr/sbin/sysctl -n kern.bootsessionuuid)
marker="$runtime_dir/started-boot-id"
if [ -f "$marker" ] && [ "$(cat "$marker")" = "$boot_id" ]; then exit 0; fi
case "$(/sbin/mount)" in
  *" on /Volumes/Seagate ("*) ;;
  *) exit 0 ;;
esac
if ! docker info --format '{{.ServerVersion}}' >/dev/null 2>&1; then
  /usr/bin/open -gj -a /Applications/Docker.app
  exit 0
fi
repo_dir=$(cat "$runtime_dir/project-path")
"$repo_dir/scripts/local-service.sh" start
printf '%s\n' "$boot_id" > "$marker"
printf '%s Media Marshal 自动启动完成\n' "$(date '+%Y-%m-%d %H:%M:%S')"
