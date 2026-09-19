#!/bin/sh
set -eu

# 宿主可能在长构建期间继续编辑脚本；shell 必须执行自身的固定快照。
if [ "${LZC_INTERNAL_HELPER_SNAPSHOT:-0}" != "1" ]; then
  helper_snapshot=$(mktemp)
  cp "$0" "$helper_snapshot"
  LZC_INTERNAL_HELPER_SNAPSHOT=1 exec sh "$helper_snapshot" "$@"
fi
trap 'rm -f "$0"' EXIT

SOURCE_ROOT="$1"
CACHE_ROOT="$2"
OUTPUT_ROOT="$3"
BUILD_ROOT="$CACHE_ROOT/src"

# 文件锁随容器退出自动释放，避免同时修改同一依赖/编译缓存。
exec 9>"$CACHE_ROOT/build.lock"
if ! flock -n 9; then
  echo "当前项目已有 LPK 容器构建正在使用缓存。" >&2
  exit 1
fi

if [ "${LZC_CLEAN_BUILD:-0}" = "1" ]; then
  echo "[LPK] 强制干净构建：清理当前项目的依赖、npm 和 Next 缓存"
  rm -rf "$BUILD_ROOT" "$CACHE_ROOT/npm"
  rm -f "$CACHE_ROOT/content.key" "$CACHE_ROOT/content.digest"
fi
mkdir -p "$BUILD_ROOT/notus" "$CACHE_ROOT/npm"
export npm_config_cache="$CACHE_ROOT/npm"

copy_started=$(date +%s)
# 清理上轮源码和 Next 输出；保留依赖、编译缓存及待校验的成功内容。
find "$BUILD_ROOT" -mindepth 1 -maxdepth 1 ! -name notus ! -name lzc-dist -exec rm -rf {} +
find "$BUILD_ROOT/notus" -mindepth 1 -maxdepth 1 ! -name node_modules ! -name .next -exec rm -rf {} +
if [ -d "$BUILD_ROOT/notus/.next" ]; then
  find "$BUILD_ROOT/notus/.next" -mindepth 1 -maxdepth 1 ! -name cache -exec rm -rf {} +
fi

# 使用中间 tar 文件，让任一复制步骤失败都停止构建（POSIX sh 无 pipefail）。
snapshot="$CACHE_ROOT/source.tar"
trap 'rm -f "$snapshot" "$0"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
tar -C "$SOURCE_ROOT" \
  --exclude=node_modules \
  --exclude=notus/node_modules \
  --exclude=notus/.next \
  --exclude=notus/.session \
  --exclude=notus/.notus-desktop-data \
  --exclude=notus/notes \
  --exclude=notus/assets \
  --exclude=notus/logs \
  --exclude=notus/agent \
  --exclude=notus/secrets \
  --exclude=notus/.npm-cache \
  --exclude=notus/.tmp-home \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*.db' \
  --exclude='*.db-*' \
  --exclude='*.sqlite' \
  --exclude='*.pem' \
  --exclude=credentials.json \
  --exclude='*.lpk' \
  -cf "$snapshot" notus lzc desktop/scripts package.json package.yml
source_digest=$(sha256sum "$snapshot" | cut -d ' ' -f 1)
build_key=$(printf '%s\n' "$source_digest" "${LZC_BUILD_IMAGE_ID:-local}" | sha256sum | cut -d ' ' -f 1)
tar -C "$BUILD_ROOT" -xf "$snapshot"
rm -f "$snapshot"
echo "[LPK] 源码同步: $(($(date +%s) - copy_started)) 秒"

cd "$BUILD_ROOT"
content_reusable=0
if [ -f "$CACHE_ROOT/content.key" ] && [ -f "$CACHE_ROOT/content.digest" ] &&
   [ "$(cat "$CACHE_ROOT/content.key")" = "$build_key" ] && [ -d lzc-dist ]; then
  if current_digest=$(node desktop/scripts/lpk-content-digest.js lzc-dist) &&
     [ "$current_digest" = "$(cat "$CACHE_ROOT/content.digest")" ]; then
    content_reusable=1
  fi
fi
if [ "$content_reusable" = "1" ]; then
  echo "[LPK] 构建输入与产物校验一致，复用上次成功内容，跳过依赖安装和 Next 构建"
else
  rm -f "$CACHE_ROOT/content.key" "$CACHE_ROOT/content.digest"
  LZC_BUILD_IN_CONTAINER=1 LZC_BUILD_CACHE=1 sh lzc/build-package.sh
  node desktop/scripts/lpk-content-digest.js lzc-dist > "$CACHE_ROOT/content.digest"
  printf '%s\n' "$build_key" > "$CACHE_ROOT/content.key"
fi

export_started=$(date +%s)
# 内容构建成功后才更新宿主导出目录；正式 LPK 由外层 staging 规则保护。
find "$OUTPUT_ROOT" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -R "$BUILD_ROOT/lzc-dist/." "$OUTPUT_ROOT/"
echo "[LPK] 导出内容: $(($(date +%s) - export_started)) 秒"
