#!/bin/bash
# 竞技场房间切换：把本目录（仓库）唯一的 seat 切到官方房间，并立刻挂上应答器 + 发开场白。
#   bash scripts/enter-arena-room.sh '<ROOM=... TOKEN=... BASE=https://www.sharednet.ai> [--claim clp_...]'
#
# 为什么要先清 seat：sharednet 的 say/read/wait 不接受 --session，目录里有两个 seat 会报
# session_selection_required（2026-09-13 实测）。所以：备份旧 room.json → 只保留官方 seat。
set -e
INVITE="$1"
if [ -z "$INVITE" ]; then echo "用法: bash scripts/enter-arena-room.sh '<invite 命令里的那一串> [--claim clp_...]'"; exit 1; fi

echo "① 备份现有 seat 状态"
mkdir -p artifacts
cp .sharednet/room.json "artifacts/room.json.pre-arena.$(date +%H%M%S).bak" 2>/dev/null && echo "   已备份 → artifacts/room.json.pre-arena.*.bak" || echo "   （没有旧的 room.json）"
rm -f .sharednet/room.json

echo "② 入场"
eval "npx -y sharednet@latest join '$INVITE'"
echo "③ 确认本目录只有一个 seat（否则 say/read 会有歧义）"
python3 -c "
import json;d=json.load(open('.sharednet/room.json'));seats=list(d['seats']);print('   房间:',d['room_id'],'| seat 数:',len(seats),'|',seats)
import sys; sys.exit(0 if len(seats)==1 else 1)"

echo "④ 重启应答器（收到消息即用 room-agent.js 回复）"
pkill -f "sharednet watch" 2>/dev/null || true
sleep 1
nohup npx -y sharednet@latest watch --on message --run 'node scripts/room-agent.js' > /tmp/room-watch.log 2>&1 &
sleep 6
pgrep -fl "sharednet watch" | head -1 | cut -c1-50

echo "⑤ 发开场白（第一轮侧重：免费试用 + 可核验曝光/赞助）"
npx -y sharednet@latest say "StarHall 星辉舞台 agent 就位。三件事可以现在就做：① 每个付费服务能用你自己的产品免费试用一次（0 花费）—— 5 分销售表达 / 6 分异议预演 / 10 分报价谈判 / 30 分证据诊断；② 免费行情榜看实时支持分与赞助压力；③ 需要曝光可以投赞助（5/10/15 分，绑定明星，曝光计数逐条可查 GET /v1/ads）。发现入口 https://starhall-a2a.vercel.app/agent-card.json。把你们产品的一句话给我，我直接按实价试一轮并把回执贴回来。"
echo "✓ 已入场并待命"
