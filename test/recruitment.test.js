// 割り振り・時間計算のテスト（node --test で実行）
const test = require('node:test');
const assert = require('node:assert');
const rc = require('../recruitment');

function participant(userId, attrs, time = 'now', raid = '天元') {
  return { userId, username: userId, joinType: raid, attributesByRaid: { [raid]: attrs }, timeAvailability: time, remarks: '', assignedAttribute: null };
}

function recruitment(participants, extra = {}) {
  return { id: '1700000000000-abc1234', type: '天元', date: '2026-10-18', time: '21:00', creator: '1', status: 'active', participants, finalTime: null, finalRaidType: null, ...extra };
}

test('属性をずらして全員入れる（旧ロジックでは1人あぶれていたケース）', () => {
  const r = recruitment([participant('A', ['火', '水']), participant('B', ['火', '水']), participant('C', ['水', '土'])]);
  rc.autoAssign(r);
  const assigned = r.participants.map(p => p.assignedAttribute);
  assert.ok(assigned.every(Boolean), `全員割り振られること: ${assigned}`);
  assert.strictEqual(new Set(assigned).size, 3);
  assert.strictEqual(r.participants[2].assignedAttribute, '土');
});

test('定員を超えたら参加が早い人から入り、あとの人は補欠になる', () => {
  const all = ['火', '水', '土', '風', '光', '闇'];
  const r = recruitment(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(id => participant(id, all)));
  rc.autoAssign(r);
  assert.deepStrictEqual(r.participants.filter(p => !p.assignedAttribute).map(p => p.userId), ['G']);
  assert.deepStrictEqual(rc.reservesOf(r).map(p => p.userId), ['G']);
});

test('計算し直しても、なるべく前の属性のまま', () => {
  const r = recruitment([participant('A', ['火', '水', '土']), participant('B', ['水', '土'])]);
  rc.autoAssign(r);
  const before = r.participants.map(p => p.assignedAttribute);
  r.participants.push(participant('C', ['風']));
  rc.autoAssign(r);
  assert.deepStrictEqual(r.participants.slice(0, 2).map(p => p.assignedAttribute), before);
});

test('開始時間は募集時間より早くならない', () => {
  const r = recruitment([participant('A', ['火'], '19:00'), participant('B', ['水'], '19:00')], { time: '22:00' });
  rc.autoAssign(r);
  assert.strictEqual(r.finalTime, '22:00');
  assert.strictEqual(rc.effectiveStartTime(r), '22:00');
});

test('全員「今すぐ参加可能」なら募集時間で開始（now にならない）', () => {
  const r = recruitment([participant('A', ['火']), participant('B', ['水'])]);
  rc.autoAssign(r);
  assert.strictEqual(r.finalTime, '21:00');
});

test('割り振られた人が遅い時間なら開始が遅れる。補欠の都合は関係しない', () => {
  const all = ['火', '水', '土', '風', '光', '闇'];
  const ps = ['A', 'B', 'C', 'D', 'E', 'F'].map(id => participant(id, all, id === 'B' ? '22:00' : 'now'));
  ps.push(participant('G', all, '23:00')); // 補欠
  const r = recruitment(ps);
  rc.autoAssign(r);
  assert.strictEqual(r.finalTime, '22:00');
});

test('旧データの finalTime（now や早すぎる時間）でも正しい開始時間を表示する', () => {
  assert.strictEqual(rc.effectiveStartTime(recruitment([], { finalTime: 'now' })), '21:00');
  assert.strictEqual(rc.effectiveStartTime(recruitment([], { time: '22:00', finalTime: '19:00' })), '22:00');
});

test('日付は日本時間で計算する（UTC 23:00 = 日本時間 翌8:00）', () => {
  const utc2300 = Date.UTC(2026, 9, 16, 23, 0); // 日本時間 10/17 08:00
  assert.strictEqual(rc.jstDateString(0, utc2300), '2026-10-17');
  assert.strictEqual(rc.jstDateString(1, utc2300), '2026-10-18');
  assert.strictEqual(rc.formatDateShort('2026-10-18'), '10/18(日)');
});

test('仮確定は当日8:00、本確定は開始1時間前', () => {
  const r = recruitment([], { date: '2026-10-18', time: '21:00' });
  assert.strictEqual(new Date(rc.provisionalAtMs(r)).toISOString(), '2026-10-17T23:00:00.000Z');
  assert.strictEqual(new Date(rc.finalizeAtMs(r)).toISOString(), '2026-10-18T11:00:00.000Z');
});

test('枠が空いたら入れる補欠が繰り上がる', () => {
  const r = recruitment([participant('A', ['火']), participant('B', ['火', '水'])], { status: 'provisional' });
  rc.autoAssign(r);
  r.status = 'provisional';
  // B が水に入っているところに、火しかできない C が補欠で入る
  r.participants.push(participant('C', ['火']));
  assert.deepStrictEqual(rc.fillEmptySlots(r), []);
  // A が抜けると C が火に繰り上がる
  r.participants.splice(0, 1);
  const promoted = rc.fillEmptySlots(r);
  assert.deepStrictEqual(promoted.map(p => `${p.userId}:${p.assignedAttribute}`), ['C:火']);
});

test('枠の手動編集：入れ替え・補欠と交代・空きにする', () => {
  const r = recruitment([participant('A', ['火']), participant('B', ['水']), participant('C', ['火'])]);
  rc.autoAssign(r); // A=火, B=水, C=補欠
  rc.setSlot(r, '火', 'B'); // B が火へ、A は B の元の枠（水）へ
  assert.deepStrictEqual(r.participants.map(p => p.assignedAttribute), ['水', '火', null]);
  rc.setSlot(r, '水', 'C'); // 補欠の C が水へ、A は補欠へ
  assert.deepStrictEqual(r.participants.map(p => p.assignedAttribute), [null, '火', '水']);
  rc.setSlot(r, '火', null);
  assert.deepStrictEqual(r.participants.map(p => p.assignedAttribute), [null, null, '水']);
});

test('参加者希望は希望の多いレイドに決まり、対象外の人は分けて表示', () => {
  const any = { userId: 'X', username: 'X', joinType: rc.ANY_RAID, attributesByRaid: Object.fromEntries(rc.selectableRaids().map(raid => [raid, ['火']])), timeAvailability: 'now' };
  const r = recruitment([participant('A', ['水'], 'now', 'ルシゼロ'), participant('B', ['土'], 'now', 'ルシゼロ'), participant('C', ['風'], 'now', '天元'), any], { type: rc.FLEX_RAID });
  rc.autoAssign(r);
  assert.strictEqual(r.finalRaidType, 'ルシゼロ');
  assert.strictEqual(r.participants.find(p => p.userId === 'X').assignedAttribute, '火');
  const description = rc.cardDescription(r);
  assert.match(description, /今回は対象外\*\*：🧪C/u);
});

test('カードは名前を1回ずつだけ表示する', () => {
  const all = ['火', '水', '土', '風', '光', '闇'];
  const r = recruitment([{ ...participant('111', all) }, { ...participant('222', all) }]);
  rc.autoAssign(r);
  const description = rc.cardDescription(r);
  assert.strictEqual(description.split('<@111>').length - 1, 1);
  assert.strictEqual(description.split('<@222>').length - 1, 1);
});

test('得意な属性（◎）を優先して並べる', () => {
  const a = { ...participant('A', ['火', '水']), preferredByRaid: { 天元: ['水'] } };
  const b = participant('B', ['火', '水']);
  const r = recruitment([a, b]);
  rc.autoAssign(r);
  assert.deepStrictEqual(r.participants.map(p => p.assignedAttribute), ['水', '火']);
});

test('得意な属性があっても、入れる人は参加順で決まる', () => {
  const all = ['火', '水', '土', '風', '光', '闇'];
  const ps = ['A', 'B', 'C', 'D', 'E', 'F'].map(id => participant(id, all));
  ps.push({ ...participant('G', all), preferredByRaid: { 天元: ['火'] } });
  const r = recruitment(ps);
  rc.autoAssign(r);
  assert.strictEqual(r.participants[6].assignedAttribute, null);
});

test('先に入った人が抜ける時間にかかるなら、遅く来る人は補欠で開始は遅らせない', () => {
  const a = { ...participant('A', ['火']), leaveTime: '22:00' };
  const b = participant('B', ['水'], '22:00');
  const r = recruitment([a, b]);
  rc.autoAssign(r);
  assert.deepStrictEqual(r.participants.map(p => p.assignedAttribute), ['火', null]);
  assert.strictEqual(r.finalTime, '21:00');
  assert.strictEqual(rc.reserveReason(r, b), '22:00からのため');
});

test('開始時間までに抜ける人は補欠', () => {
  const a = { ...participant('A', ['火']), leaveTime: '22:00' };
  const r = recruitment([a], { time: '22:00' });
  rc.autoAssign(r);
  assert.strictEqual(a.assignedAttribute, null);
  assert.strictEqual(rc.reserveReason(r, a), '22:00に抜けるため');
});

test('確定後の繰り上げは、今の開始時間に参加できる人だけ。本確定後は開始時間を変えない', () => {
  const r = recruitment([participant('A', ['火'], '22:00'), participant('B', ['火'], '23:00'), participant('C', ['火'])]);
  rc.autoAssign(r); // A=火、開始22:00
  r.status = 'finalized';
  assert.strictEqual(r.finalTime, '22:00');
  r.participants.splice(0, 1); // A がキャンセル
  const promoted = rc.fillEmptySlots(r);
  assert.deepStrictEqual(promoted.map(p => p.userId), ['C'], '23:00からの B ではなく C が繰り上がる');
  assert.strictEqual(r.finalTime, '22:00', '本確定後は開始時間をそのままにする');
});

test('得意な属性と時間帯の表示', () => {
  assert.strictEqual(rc.attrSummary(['火', '水', '土'], ['土']), '◎⛰️ 🔥💧');
  assert.strictEqual(rc.attrSummary(['火', '水', '土', '風', '光', '闇'], ['光']), '全属性（◎✨）');
  assert.strictEqual(rc.timeLabel('now', '23:00'), '今すぐ〜23:00');
  assert.strictEqual(rc.timeLabel('21:00'), '21:00〜');
});
