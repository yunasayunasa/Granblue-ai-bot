// 募集の計算・表示テキストまわり（Discordに依存しない処理をまとめたモジュール）

const ATTRIBUTES = ['火', '水', '土', '風', '光', '闇']; // グラブルの属性
const ATTRIBUTE_EMOJI = { 火: '🔥', 水: '💧', 土: '⛰️', 風: '🌪️', 光: '✨', 闇: '🌑' };
// ★★★ レイドタイプを追加・変更する場合はここを編集 ★★★
const RAID_TYPES = ['天元', 'ルシゼロ', 'スパバハ', 'ヴェルサシア', '参加者希望'];
const FLEX_RAID = '参加者希望'; // 参加者の希望でレイドを決める募集
const ANY_RAID = 'なんでも可'; // 「どれでも可」を選んだ参加者の joinType
const START_HOURS = [19, 20, 21, 22, 23]; // 募集・参加可能時間の選択肢
const PROVISIONAL_HOUR_JST = 8; // 開催日のこの時刻に仮確定
const FINALIZE_BEFORE_MS = 60 * 60 * 1000; // 開始のこの時間前に本確定
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
const STATUS_EMOJI = { active: '🟢', provisional: '🟡', finalized: '🏁' };

function selectableRaids() {
  return RAID_TYPES.filter(type => type !== FLEX_RAID);
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.substring(0, max - 3)}...`;
}

//==========================================================================
// 日時（サーバーのタイムゾーンに関係なく、すべて日本時間で扱う）
//==========================================================================

// 日本時間で今日から offsetDays 日後の日付 (YYYY-MM-DD)
function jstDateString(offsetDays = 0, now = Date.now()) {
  const d = new Date(now + JST_OFFSET_MS);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().split('T')[0];
}

// '21:00' → 21。'now'（今すぐ参加可能）や不正な値は -1
function hourOf(time) {
  const hour = parseInt(time, 10);
  return Number.isNaN(hour) ? -1 : hour;
}

function formatHour(hour) {
  return `${String(hour).padStart(2, '0')}:00`;
}

function jstToEpochMs(dateStr, hour) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hour) - JST_OFFSET_MS;
}

// '2026-10-18' → '10/18(日)'
function formatDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${m}/${d}(${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}

// 実際の開始時間（募集時間より早くはならない）
function effectiveStartTime(r) {
  return formatHour(Math.max(hourOf(r.time), hourOf(r.finalTime)));
}

function startAtMs(r) {
  return jstToEpochMs(r.date, hourOf(effectiveStartTime(r)));
}

function provisionalAtMs(r) {
  return jstToEpochMs(r.date, PROVISIONAL_HOUR_JST);
}

function finalizeAtMs(r) {
  return startAtMs(r) - FINALIZE_BEFORE_MS;
}

// Discordのタイムスタンプ表記（見る人の環境で日時・カウントダウン表示される）
function discordTime(ms, style) {
  return `<t:${Math.floor(ms / 1000)}:${style}>`;
}

//==========================================================================
// 募集の状態
//==========================================================================

function isOpen(r) {
  return r?.status === 'active' || r?.status === 'provisional';
}

// closed / assigned は旧バージョンで締め切った募集。本確定と同じ扱いにする
function isFinalized(r) {
  return r?.status === 'finalized' || r?.status === 'closed' || r?.status === 'assigned';
}

function statusKey(r) {
  return isFinalized(r) ? 'finalized' : r.status;
}

function shortId(id) {
  return String(id).split('-').pop();
}

//==========================================================================
// 参加者
//==========================================================================

function attributesFor(p, raid) {
  if (!p?.attributesByRaid || !raid) return [];
  const attrs = p.attributesByRaid[raid] || (p.joinType === ANY_RAID ? Object.values(p.attributesByRaid)[0] : null);
  return Array.isArray(attrs) ? attrs.filter(a => ATTRIBUTES.includes(a)) : [];
}

function isTestUser(p) {
  return Boolean(p.isTestParticipant) || !/^\d+$/.test(p.userId);
}

function who(p) {
  return isTestUser(p) ? `🧪${p.username}` : `<@${p.userId}>`;
}

function realUserIds(participants) {
  return participants.filter(p => !isTestUser(p)).map(p => p.userId);
}

// ['火','水'] → '🔥💧'、6属性すべてなら '全属性'
function attrSummary(attrs) {
  if (!attrs || attrs.length === 0) return 'なし';
  if (ATTRIBUTES.every(a => attrs.includes(a))) return '全属性';
  return ATTRIBUTES.filter(a => attrs.includes(a)).map(a => ATTRIBUTE_EMOJI[a]).join('');
}

function timeLabel(time) {
  return time === 'now' ? '今すぐ' : `${time}〜`;
}

function wantedRaids(p) {
  return p.joinType === ANY_RAID ? 'どれでも' : Object.keys(p.attributesByRaid || {}).join('・');
}

// 参加者の申告内容を1行で（例: 全属性・21:00〜 / 天元 🔥💧 / ルシゼロ 全属性・今すぐ）
function declarationSummary(p, r) {
  let text;
  if (r.type !== FLEX_RAID) text = attrSummary(attributesFor(p, r.type));
  else if (p.joinType === ANY_RAID) text = `どれでも ${attrSummary(Object.values(p.attributesByRaid || {})[0])}`;
  else text = Object.entries(p.attributesByRaid || {}).map(([raid, attrs]) => `${raid} ${attrSummary(attrs)}`).join(' / ');
  return `${text}・${timeLabel(p.timeAvailability)}`;
}

//==========================================================================
// 割り振り
//==========================================================================

// 参加者希望の募集で実施するレイドを決める（希望の多い順。同数なら RAID_TYPES の順）
function decideRaid(r) {
  if (r.type !== FLEX_RAID) return r.type;
  const raids = selectableRaids();
  const votes = Object.fromEntries(raids.map(raid => [raid, 0]));
  r.participants.forEach(p => {
    if (p.joinType === ANY_RAID) {
      raids.forEach(raid => { votes[raid] += 0.5; });
      return;
    }
    const wanted = Object.keys(p.attributesByRaid || {}).filter(raid => raid in votes);
    wanted.forEach(raid => { votes[raid] += 1 / wanted.length; }); // 複数希望の場合は票を分割
  });
  let best = null;
  raids.forEach(raid => {
    if (votes[raid] > 0 && (best === null || votes[raid] > votes[best])) best = raid;
  });
  return best;
}

// 属性の割り振り（二部マッチング）。
// 参加順に「入れる人は全員入れる」よう、必要なら先に入った人の属性をずらして枠を最大限埋める。
// 前回の割り振り (assignedAttribute) があれば、なるべくそのままにする。
function matchSlots(participants, raid, slots = ATTRIBUTES) {
  const owner = {}; // 属性 → userId
  const byId = new Map(participants.map(p => [p.userId, p]));
  const tryPlace = (p, visited) => {
    const attrs = attributesFor(p, raid).filter(a => slots.includes(a));
    const ordered = attrs.includes(p.assignedAttribute)
      ? [p.assignedAttribute, ...attrs.filter(a => a !== p.assignedAttribute)]
      : attrs;
    for (const attr of ordered) {
      if (visited.has(attr)) continue;
      visited.add(attr);
      if (!owner[attr] || tryPlace(byId.get(owner[attr]), visited)) {
        owner[attr] = p.userId;
        return true;
      }
    }
    return false;
  };
  participants.forEach(p => tryPlace(p, new Set()));
  const result = {}; // userId → 属性
  Object.entries(owner).forEach(([attr, userId]) => { result[userId] = attr; });
  return result;
}

// 開始時間 = 募集時間と「割り振られた人」の参加可能時間のうち一番遅いもの
function computeStartTime(r) {
  let hour = hourOf(r.time);
  r.participants.forEach(p => {
    if (p.assignedAttribute) hour = Math.max(hour, hourOf(p.timeAvailability));
  });
  return formatHour(hour);
}

// 募集中の自動割り振り（参加・キャンセルのたびに計算し直す）
function autoAssign(r, raid = decideRaid(r)) {
  const result = raid ? matchSlots(r.participants, raid) : {};
  r.participants.forEach(p => { p.assignedAttribute = result[p.userId] || null; });
  r.finalRaidType = raid;
  r.finalTime = computeStartTime(r);
}

// 仮確定・本確定後に空いた枠を補欠から埋める（手動で入れ替えた人はそのまま）。繰り上がった人を返す
function fillEmptySlots(r) {
  const raid = r.finalRaidType || r.type;
  const empty = ATTRIBUTES.filter(attr => !r.participants.some(p => p.assignedAttribute === attr));
  const reserves = r.participants.filter(p => !p.assignedAttribute);
  const result = matchSlots(reserves, raid, empty);
  const promoted = [];
  reserves.forEach(p => {
    if (result[p.userId]) {
      p.assignedAttribute = result[p.userId];
      promoted.push(p);
    }
  });
  r.finalTime = computeStartTime(r);
  return promoted;
}

// 枠の手動編集。targetUserId を attr に入れる（別の枠にいれば入れ替え、補欠からなら元の人が補欠へ）。
// targetUserId が null なら空きにする
function setSlot(r, attr, targetUserId) {
  const occupant = r.participants.find(p => p.assignedAttribute === attr) || null;
  if (targetUserId === null) {
    if (occupant) occupant.assignedAttribute = null;
  } else {
    const target = r.participants.find(p => p.userId === targetUserId);
    if (!target) return false;
    if (occupant !== target) {
      const previous = target.assignedAttribute;
      target.assignedAttribute = attr;
      if (occupant) occupant.assignedAttribute = previous;
    }
  }
  r.finalTime = computeStartTime(r);
  return true;
}

//==========================================================================
// 表示テキスト
//==========================================================================

function raidLabel(r) {
  if (r.type !== FLEX_RAID) return r.type;
  return r.finalRaidType ? `${FLEX_RAID}→${r.finalRaidType}` : FLEX_RAID;
}

function headline(r) {
  return `【${raidLabel(r)}】${formatDateShort(r.date)} ${effectiveStartTime(r)}〜`;
}

function cardTitle(r) {
  return `${STATUS_EMOJI[statusKey(r)] || '⚠️'} ${headline(r)}`;
}

function slotLines(r) {
  return ATTRIBUTES.map(attr => {
    const p = r.participants.find(pt => pt.assignedAttribute === attr);
    return `${ATTRIBUTE_EMOJI[attr]} ${attr}　${p ? `${who(p)}${p.remarks ? ' 📝' : ''}` : '空き'}`;
  });
}

function compactSlots(r) {
  return ATTRIBUTES.map(attr => {
    const p = r.participants.find(pt => pt.assignedAttribute === attr);
    return `${ATTRIBUTE_EMOJI[attr]}${p ? who(p) : '空き'}`;
  }).join('　');
}

function reservesOf(r) {
  return r.participants.filter(p => !p.assignedAttribute && attributesFor(p, r.finalRaidType).length > 0);
}

function outsidersOf(r) {
  return r.participants.filter(p => !p.assignedAttribute && attributesFor(p, r.finalRaidType).length === 0);
}

// 募集カードの本文
function cardDescription(r) {
  const key = statusKey(r);
  const start = startAtMs(r);
  const lines = [`募集者 <@${r.creator}>・参加 ${r.participants.length}名`];
  lines.push(`🕘 開始 ${discordTime(start, 'f')}（${discordTime(start, 'R')}）`);
  if (effectiveStartTime(r) !== r.time) lines.push(`　※参加者の都合で ${r.time} → ${effectiveStartTime(r)} 開始`);
  if (key === 'active') {
    lines.push(`🟢 **募集中**｜当日 ${PROVISIONAL_HOUR_JST}:00 に仮確定・開始1時間前に本確定`);
  } else if (key === 'provisional') {
    const fin = finalizeAtMs(r);
    lines.push(`🟡 **仮確定**｜本確定 ${discordTime(fin, 't')}（${discordTime(fin, 'R')}）までは「枠を編集」で入れ替えできます`);
    if (r.lastEditedBy) lines.push(`✏️ 最終編集 <@${r.lastEditedBy}>`);
  } else if (key === 'finalized') {
    lines.push('🏁 **本確定**');
  }
  if (r.type === FLEX_RAID) {
    const raid = r.finalRaidType ? `${r.finalRaidType}${key === 'active' ? '（希望の多い順で仮決定）' : ''}` : '未定';
    lines.push(`🎯 実施レイド：${raid}`);
  }

  if (r.participants.length === 0) {
    lines.push('', 'まだ参加者はいません。「参加・変更」から申し込めます。');
    return lines.join('\n');
  }

  lines.push('', `**割り振り${key === 'active' ? '（仮）' : ''}**`, ...slotLines(r));
  const reserves = reservesOf(r);
  const outsiders = outsidersOf(r);
  if (reserves.length > 0) lines.push('', `**補欠**：${reserves.map(p => `${who(p)}（${attrSummary(attributesFor(p, r.finalRaidType))}）`).join('、')}`);
  if (outsiders.length > 0) lines.push(`**今回は対象外**：${outsiders.map(p => `${who(p)}（${wantedRaids(p)}希望）`).join('、')}`);
  return truncate(lines.join('\n'), 4000);
}

// 参加者詳細（本人だけに見える一覧）の各行
function participantDetailLines(r) {
  const key = statusKey(r);
  return r.participants.map((p, index) => {
    let slot;
    if (p.assignedAttribute) slot = `${ATTRIBUTE_EMOJI[p.assignedAttribute]}【${p.assignedAttribute}】${key === 'active' ? '（仮）' : ''}`;
    else slot = attributesFor(p, r.finalRaidType).length > 0 ? '補欠' : '対象外';
    let line = `**${index + 1}.** ${who(p)}　${slot}\n　申告: ${declarationSummary(p, r)}`;
    if (p.remarks) line += `\n　📝 ${p.remarks}`;
    return line;
  });
}

// 募集ボードの1行
function boardLine(r, guildId) {
  const key = statusKey(r);
  const filled = r.participants.filter(p => p.assignedAttribute).length;
  let state;
  if (key === 'active') state = `${filled}/6・参加${r.participants.length}人`;
  else if (key === 'provisional') state = `仮確定 ${filled}/6・本確定 ${discordTime(finalizeAtMs(r), 't')}`;
  else state = `本確定 ${filled}/6`;
  const link = r.messageId ? `[開く](https://discord.com/channels/${guildId}/${r.channel}/${r.messageId})` : '';
  return `${STATUS_EMOJI[key]} **${effectiveStartTime(r)}** ${raidLabel(r)}　${state}　${link}`;
}

// 募集ボードの本文（list は開始順に並んでいること）
function boardDescription(list, guildId) {
  if (list.length === 0) return '現在の募集はありません。\n下の「＋ 募集を作成」か `/募集` から作成できます。';
  const lines = [];
  let currentDate = null;
  list.forEach(r => {
    if (r.date !== currentDate) {
      if (currentDate) lines.push('');
      lines.push(`**📅 ${formatDateShort(r.date)}**`);
      currentDate = r.date;
    }
    lines.push(boardLine(r, guildId));
  });
  return truncate(lines.join('\n'), 4000);
}

// 仮確定のお知らせ（メンションなし）
function provisionalNotice(r) {
  const fin = finalizeAtMs(r);
  return truncate([
    `🟡 **仮確定** ${headline(r)}`,
    compactSlots(r),
    `本確定は ${discordTime(fin, 't')}（開始1時間前）です。それまでは募集の「枠を編集」から入れ替えできます。`
  ].join('\n'), 2000);
}

// 本確定のお知らせ（割り振られた人にメンション）
function finalNotice(r) {
  const lines = [`🏁 **本確定** ${headline(r)}（${discordTime(startAtMs(r), 'R')}）`];
  if (!r.participants.some(p => p.assignedAttribute)) {
    lines.push('参加者がいなかったため、割り振りはありません。');
  } else {
    lines.push(...slotLines(r));
    const reserves = r.participants.filter(p => !p.assignedAttribute);
    if (reserves.length > 0) lines.push(`補欠：${reserves.map(who).join('、')}`);
    lines.push('よろしくお願いします！');
  }
  return truncate(lines.join('\n'), 2000);
}

module.exports = {
  ATTRIBUTES,
  ATTRIBUTE_EMOJI,
  RAID_TYPES,
  FLEX_RAID,
  ANY_RAID,
  START_HOURS,
  PROVISIONAL_HOUR_JST,
  STATUS_EMOJI,
  selectableRaids,
  truncate,
  jstDateString,
  hourOf,
  formatHour,
  formatDateShort,
  effectiveStartTime,
  startAtMs,
  provisionalAtMs,
  finalizeAtMs,
  discordTime,
  isOpen,
  isFinalized,
  statusKey,
  shortId,
  attributesFor,
  isTestUser,
  who,
  realUserIds,
  attrSummary,
  timeLabel,
  wantedRaids,
  declarationSummary,
  decideRaid,
  matchSlots,
  computeStartTime,
  autoAssign,
  fillEmptySlots,
  setSlot,
  raidLabel,
  headline,
  cardTitle,
  slotLines,
  reservesOf,
  cardDescription,
  participantDetailLines,
  boardDescription,
  provisionalNotice,
  finalNotice
};
