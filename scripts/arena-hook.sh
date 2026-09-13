#!/bin/bash
# 竞技场房间钩子：一条 watch 同时做两件事
#   ① 把收到的消息落盘到 artifacts/arena/inbox.jsonl（供人/监视器复盘）
#   ② 交给 room-agent.js 生成并发送应答（卖方 agent 在场）
# 用法（由 sharednet watch 调用，消息 JSON 走 stdin）：
#   npx -y sharednet@latest watch --on message --run 'bash scripts/arena-hook.sh'
# 额外参数会透传给 room-agent.js（例如 --dry 用于离线自测）。
set -u
cd "$(dirname "$0")/.." || exit 0

PAYLOAD="$(cat)"
[ -n "$PAYLOAD" ] || exit 0
printf '%s\n' "$PAYLOAD" >> artifacts/arena/inbox.jsonl

TMP="$(mktemp -t arena-hook.XXXXXX)"
printf '%s' "$PAYLOAD" > "$TMP"
node --env-file-if-exists=.env scripts/room-agent.js "$@" < "$TMP" >> artifacts/arena/room-agent-arena.log 2>&1
rm -f "$TMP"
