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

// 仮確定後：全属性の人が火、火闇の人が闇、土風水が埋まり、光が空き
function shiftScenario() {
  const all = ['火', '水', '土', '風', '光', '闇'];
  const r = recruitment([
    participant('全', all),
    { ...participant('火闇', ['火', '闇']), preferredByRaid: { 天元: ['火', '闇'] } },
    participant('土', ['土']), participant('風', ['風']), participant('水', ['水'])
  ]);
  rc.autoAssign(r);
  r.status = 'provisional';
  r.participants[0].assignedAttribute = '火';
  r.participants[1].assignedAttribute = '闇';
  return r;
}
const slotsOf = r => r.participants.map(p => `${p.userId}:${p.assignedAttribute}`).join(' ');

test('仮確定後：入っている人をずらせば入れるなら玉突きで入れる', () => {
  const r = shiftScenario();
  r.participants.push(participant('闇1', ['闇']));
  const moved = [];
  const promoted = rc.fillEmptySlots(r, moved);
  assert.deepStrictEqual(promoted.map(p => `${p.userId}:${p.assignedAttribute}`), ['闇1:闇']);
  assert.strictEqual(slotsOf(r), '全:光 火闇:火 土:土 風:風 水:水 闇1:闇');
  assert.deepStrictEqual(moved.map(m => `${m.participant.userId}:${m.from}→${m.to}`), ['全:火→光', '火闇:闇→火']);

  // もう1人闇しかできない人が来ても、闇は1枠なので補欠
  r.participants.push(participant('闇2', ['闇']));
  const moved2 = [];
  assert.deepStrictEqual(rc.fillEmptySlots(r, moved2), []);
  assert.deepStrictEqual(moved2, [], '入れないなら誰も動かさない');
  assert.strictEqual(slotsOf(r), '全:光 火闇:火 土:土 風:風 水:水 闇1:闇 闇2:null');

  // 闇1 が抜けると 闇2 が繰り上がる
  r.participants.splice(5, 1);
  assert.deepStrictEqual(rc.fillEmptySlots(r).map(p => `${p.userId}:${p.assignedAttribute}`), ['闇2:闇']);
});

test('仮確定後の玉突き：空き枠に直接入れるなら誰も動かさない', () => {
  const r = shiftScenario();
  r.participants.push(participant('光闇', ['光', '闇']));
  const moved = [];
  rc.fillEmptySlots(r, moved);
  assert.deepStrictEqual(moved, []);
  assert.strictEqual(r.participants[5].assignedAttribute, '光');
});

test('仮確定後の玉突き：2段階ずらす', () => {
  const r = recruitment([participant('A', ['火', '水']), participant('B', ['水', '土'])], { status: 'provisional' });
  r.participants[0].assignedAttribute = '火';
  r.participants[1].assignedAttribute = '水';
  r.participants.push(participant('C', ['火']));
  const moved = [];
  rc.fillEmptySlots(r, moved);
  assert.strictEqual(slotsOf(r), 'A:水 B:土 C:火');
  assert.strictEqual(moved.length, 2);
});

test('仮確定後の玉突き：手動で入れた人・申告外の枠にいる人は動かさない', () => {
  const r = shiftScenario();
  rc.setSlot(r, '火', '全'); // 手動で火に（すでに火なので変化なし）
  rc.setSlot(r, '光', '全'); // 手動で光へ → 火が空く
  rc.setSlot(r, '火', '全'); // 手動で火に戻す
  assert.ok(r.participants[0].manualSlot);
  r.participants.push(participant('闇1', ['闇']));
  assert.deepStrictEqual(rc.fillEmptySlots(r), [], '手動で入れた全属性の人は光へ動かさない');
  assert.strictEqual(slotsOf(r), '全:火 火闇:闇 土:土 風:風 水:水 闇1:null');

  // 申告外の枠（話し合いで入った）にいる人も動かさない
  const r2 = shiftScenario();
  r2.participants[1].assignedAttribute = '光'; // 火闇の人が申告外の光に
  r2.participants[0].assignedAttribute = '闇';
  r2.participants.push(participant('火のみ', ['火']));
  r2.participants.push(participant('闇のみ', ['闇']));
  rc.fillEmptySlots(r2);
  assert.strictEqual(slotsOf(r2), '全:闇 火闇:光 土:土 風:風 水:水 火のみ:火 闇のみ:null');
});

test('募集中に計算し直すと手動の印は消える', () => {
  const r = shiftScenario();
  rc.setSlot(r, '光', '全');
  r.status = 'active';
  rc.autoAssign(r);
  assert.ok(r.participants.every(p => !p.manualSlot));
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
