// 偽のDiscord（チャンネル・メッセージ・インタラクション）で、募集の流れを通しで動かすテスト
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'raidbot-test-'));
process.env.NODE_ENV = 'production';
process.env.DATA_PATH = dataDir;
delete process.env.MENTION_ROLE_ID;

const { InteractionType, MessageFlags, PermissionsBitField } = require('discord.js');
const bot = require('../index');
const rc = require('../recruitment');

const GUILD = '900000000000000001';
const CHANNEL = '900000000000000002';
let nextMessageId = 1000;

// 送信内容をDiscord.jsの検証にかける（文字数・選択肢数などの制限違反を検出）
function validate(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  (payload.embeds || []).forEach(embed => {
    const json = embed.toJSON();
    assert.ok(!json.title || json.title.length <= 256, `タイトルが長すぎる: ${json.title}`);
    assert.ok(!json.description || json.description.length <= 4096, '本文が長すぎる');
    (json.fields || []).forEach(field => assert.ok(field.value.length <= 1024 && field.value.length > 0, `フィールドが不正: ${field.name}`));
  });
  (payload.components || []).forEach(rowBuilder => {
    const json = rowBuilder.toJSON();
    assert.ok(json.components.length >= 1 && json.components.length <= 5, '1行のコンポーネント数が不正');
    json.components.forEach(component => {
      assert.ok(component.custom_id.length <= 100, `customIdが長すぎる: ${component.custom_id}`);
      if (component.options) {
        assert.ok(component.options.length >= 1 && component.options.length <= 25, '選択肢の数が不正');
        assert.ok(component.options.filter(o => o.default).length <= (component.max_values || 1), 'default が多すぎる');
      }
    });
  });
  assert.ok((payload.components || []).length <= 5, '行数が多すぎる');
  if (typeof payload.content === 'string') assert.ok(payload.content.length <= 2000, '本文が2000文字を超える');
  return payload;
}

class FakeMessage {
  constructor(channel, payload) {
    this.id = String(nextMessageId++);
    this.channel = channel;
    this.payload = payload;
    this.pinned = false;
    this.deleted = false;
  }
  async edit(payload) { this.payload = { ...this.payload, ...validate(payload) }; return this; }
  async delete() { this.deleted = true; this.channel.store.delete(this.id); }
  async pin() { this.pinned = true; }
  async startThread({ name }) {
    assert.ok(name.length <= 100, 'スレッド名が長すぎる');
    this.thread = new FakeThread(`${this.id}-thread`, this.channel.guildId, name);
    channels.set(this.thread.id, this.thread);
    return this.thread;
  }
}

class FakeChannel {
  constructor(id, guildId) {
    this.id = id;
    this.guildId = guildId;
    this.store = new Map();
    this.sent = [];
    this.messages = {
      fetch: async messageId => {
        const message = this.store.get(messageId);
        if (!message) { const error = new Error('Unknown Message'); error.code = 10008; throw error; }
        return message;
      }
    };
  }
  isTextBased() { return true; }
  get lastMessageId() { return [...this.store.keys()].pop() || null; }
  async send(payload) {
    const message = new FakeMessage(this, validate(payload));
    this.store.set(message.id, message);
    this.sent.push(message);
    return message;
  }
}

class FakeThread extends FakeChannel {
  constructor(id, guildId, name) {
    super(id, guildId);
    this.name = name;
    this.memberIds = [];
    this.members = { add: async userId => { this.memberIds.push(userId); } };
  }
  async delete() { this.deleted = true; channels.delete(this.id); }
  async setArchived() { this.archived = true; }
}

const channels = new Map();
const channel = new FakeChannel(CHANNEL, GUILD);
channels.set(CHANNEL, channel);
bot.client.channels.fetch = async id => channels.get(id) || null;

function makeUser(id, name, admin = false) {
  return { id, username: name, globalName: name, tag: name, bot: false, admin, toString: () => `<@${id}>` };
}

class FakeInteraction {
  constructor(user, kind, { customId = null, values = [], commandName = null, remarks = '' } = {}) {
    this.id = `i-${Math.random()}`;
    this.user = user;
    this.kind = kind;
    this.customId = customId;
    this.values = values;
    this.commandName = commandName;
    this.guildId = GUILD;
    this.channelId = CHANNEL;
    this.member = { displayName: user.username, permissions: { has: () => user.admin } };
    this.guild = { id: GUILD, members: { fetch: async () => this.member } };
    this.fields = { getTextInputValue: () => remarks };
    this.replied = false;
    this.deferred = false;
    this.calls = [];
    this.view = null;
  }
  get type() { return this.kind === 'modal' ? InteractionType.ModalSubmit : InteractionType.MessageComponent; }
  isChatInputCommand() { return this.kind === 'command'; }
  isButton() { return this.kind === 'button'; }
  isStringSelectMenu() { return this.kind === 'select'; }
  isRepliable() { return true; }
  isFromMessage() { return true; }
  async reply(payload) { validate(payload); this.replied = true; this.calls.push(['reply', payload]); this.view = payload; }
  async update(payload) { validate(payload); this.replied = true; this.calls.push(['update', payload]); this.view = payload; }
  async deferUpdate() { this.deferred = true; this.calls.push(['deferUpdate']); }
  async deferReply(payload) { this.deferred = true; this.calls.push(['deferReply', payload]); }
  async editReply(payload) { validate(payload); this.calls.push(['editReply', payload]); this.view = { ...this.view, ...payload }; }
  async followUp(payload) { this.calls.push(['followUp', payload]); }
  async showModal(modal) { modal.toJSON(); this.calls.push(['showModal', modal]); this.modal = modal; }
}

const creator = makeUser('100000000000000001', 'Creator');
const admin = makeUser('100000000000000009', 'Admin', true);
const userA = makeUser('100000000000000011', 'Alice');
const userB = makeUser('100000000000000012', 'Bob');
const userC = makeUser('100000000000000013', 'Carol');
const userD = makeUser('100000000000000014', 'Dave');
const outsider = makeUser('100000000000000099', 'Eve');

async function run(user, kind, options) {
  const interaction = new FakeInteraction(user, kind, options);
  await bot.handleInteraction(interaction);
  const errors = interaction.calls.filter(([, payload]) => typeof payload?.content === 'string' && payload.content.includes('エラーが発生'));
  assert.deepStrictEqual(errors, [], `エラー応答: ${JSON.stringify(errors)}`);
  return interaction;
}
const command = (user, commandName) => run(user, 'command', { commandName });
const click = (user, customId) => run(user, 'button', { customId });
const choose = (user, customId, values) => run(user, 'select', { customId, values });
const submitModal = (user, customId, remarks) => run(user, 'modal', { customId, remarks });

// ペイロードの中のボタン・メニューの customId 一覧
function customIds(payload) {
  return (payload?.components || []).flatMap(rowBuilder => rowBuilder.toJSON().components.map(c => c.custom_id));
}
function findId(payload, prefix) {
  const id = customIds(payload).find(customId => customId.startsWith(prefix));
  assert.ok(id, `${prefix} が見つかりません: ${customIds(payload)}`);
  return id;
}
function embedOf(payload) {
  return payload.embeds[0].toJSON();
}
function isEphemeral(payload) {
  return payload.flags === MessageFlags.Ephemeral;
}

function recruitments() { return Array.from(bot.activeRecruitments().values()); }
function card(r) { return channel.store.get(r.messageId); }
function cardText(r) { const e = embedOf(card(r).payload); return `${e.title}\n${e.description}`; }

// 属性 → 得意な属性（2つ以上選んだとき）→ 時間 → 確認 まで進める（id は募集IDか 'bulk'）
async function fillJoinSteps(user, id, view, { attrs, prefs = [], time, leave = null }) {
  if (customIds(view).includes(`attribute_select_per_raid_${id}`)) {
    view = (await choose(user, `attribute_select_per_raid_${id}`, attrs)).view;
  }
  if (customIds(view).includes(`join_pref_select_${id}`)) {
    view = (await choose(user, `join_pref_select_${id}`, prefs.length > 0 ? prefs : ['none'])).view;
  }
  view = (await choose(user, `time_availability_select_${id}`, [time])).view;
  if (leave) view = (await choose(user, `join_leave_${id}`, [leave])).view;
  assert.ok(embedOf(view).fields.some(f => f.name === '割り振りの見込み'), '確認画面に見込みが出る');
  return view;
}

// 参加申込を最後まで進める
async function join(user, recruitmentId, attrs, time, { remarks = null, prefs = [], leave = null } = {}) {
  const start = await click(user, `join_recruitment_${recruitmentId}`);
  assert.ok(isEphemeral(start.view), '参加画面は本人だけに表示');
  await fillJoinSteps(user, recruitmentId, start.view, { attrs, prefs, time, leave });
  if (remarks === null) return click(user, `confirm_direct_${recruitmentId}`);
  await click(user, `open_remarks_modal_${recruitmentId}`);
  return submitModal(user, `submit_remarks_${recruitmentId}`, remarks);
}

// 募集を作成する（dates を複数渡すとまとめて作成）。作成した募集を日付順に返す
async function createRecruitments(user, raid, time, dates = [rc.jstDateString(2)]) {
  const start = await command(user, '募集');
  assert.ok(isEphemeral(start.view), '作成画面は本人だけに表示');
  const dateStep = await click(user, `raid_type_${raid}`);
  const dateMenu = dateStep.view.components[0].toJSON().components[0];
  assert.strictEqual(dateMenu.custom_id, 'create_dates');
  assert.strictEqual(dateMenu.options[0].value, rc.jstDateString(1), '最初の候補は日本時間の翌日');
  assert.strictEqual(dateMenu.max_values, 7, '日付は複数選べる');
  const timeStep = await choose(user, 'create_dates', dates);
  // 戻る → 日付選択に戻ると、選んだ日付が残っていて「このまま次へ」で進める
  const back = await click(user, 'create_back_dates');
  assert.match(embedOf(back.view).title, /日付選択/u);
  assert.deepStrictEqual(back.view.components[0].toJSON().components[0].options.filter(o => o.default).map(o => o.value), [...dates].sort());
  await click(user, 'create_next_dates');
  assert.ok(customIds(timeStep.view).includes('create_time'));
  const confirmStep = await choose(user, 'create_time', [time]);
  assert.match(embedOf(confirmStep.view).description, dates.length > 1 ? new RegExp(`${dates.length}件`, 'u') : /募集を開始しますか/u);
  const before = channel.sent.length;
  const done = await click(user, 'create_confirm');
  assert.match(done.view.content, /募集を作成しました/u);
  const cards = channel.sent.slice(before).filter(m => !customIds(m.payload).includes('board_create')); // ボードの貼り直しは除く
  assert.strictEqual(cards.length, dates.length, '日付ごとに募集カードが投稿される');
  const cardIds = cards.map(m => m.id);
  return recruitments().filter(r => cardIds.includes(r.messageId)).sort((a, b) => a.date.localeCompare(b.date));
}

async function createRecruitment(user, raid, time) {
  return (await createRecruitments(user, raid, time))[0];
}

test('スラッシュコマンドは日本語名と英語名の両方があり、Discordの名前の規則を満たす', () => {
  const commands = bot.buildSlashCommands();
  const names = commands.map(c => c.name);
  ['recruit', '募集', 'list', '募集リスト', 'help', '募集ヘルプ', 'participants', '参加者一覧', '募集ボード'].forEach(name => assert.ok(names.includes(name), name));
  commands.forEach(c => {
    assert.match(c.name, /^[-_'\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u);
    assert.strictEqual(c.name, c.name.toLowerCase());
    assert.ok(c.description.length >= 1 && c.description.length <= 100);
  });
  assert.strictEqual(commands.find(c => c.name === '募集ボード').default_member_permissions, String(PermissionsBitField.Flags.ManageMessages));
});

let realNow;
function setNow(ms) { Date.now = () => ms; }
function restoreNow() { Date.now = realNow; }

test('募集の流れ（作成→参加→変更→仮確定→枠編集→本確定→キャンセル繰り上げ→掃除）', async () => {
  realNow = Date.now;

  // 募集ボードを設置
  const boardSetup = await command(admin, '募集ボード');
  assert.match(boardSetup.view.content, /募集ボードを設置しました/u);
  const board = bot.boards()[GUILD];
  assert.ok(board && channel.store.get(board.messageId), 'ボードが設置される');
  assert.strictEqual(channel.lastMessageId, board.messageId);

  // 権限のない人はボードを設置できない
  const denied = await command(outsider, '募集ボード');
  assert.match(denied.view.content, /権限が必要/u);

  const r = await createRecruitment(creator, '天元', '21:00');
  assert.strictEqual(r.status, 'active');

  // 同じチャンネルに募集が出ると、ボードが募集の下に貼り直される
  await bot.updateBoard(GUILD);
  const movedBoardId = bot.boards()[GUILD].messageId;
  assert.notStrictEqual(movedBoardId, board.messageId, 'ボードが貼り直される');
  assert.ok(!channel.store.has(board.messageId), '古いボードは消える');
  assert.strictEqual(channel.lastMessageId, movedBoardId, 'ボードが一番下にある');
  assert.ok(JSON.parse(fs.readFileSync(bot.BOARD_FILE_PATH, 'utf8'))[GUILD].messageId === movedBoardId);
  // 参加などの更新では貼り直さず、その場で書き換える
  await bot.updateBoard(GUILD);
  assert.strictEqual(bot.boards()[GUILD].messageId, movedBoardId);
  assert.match(cardText(r), /🟢/u);
  assert.match(cardText(r), /まだ参加者はいません/u);

  // 旧ロジックでは1人あぶれていた組み合わせ
  await join(userA, r.id, ['火', '水'], 'now');
  await join(userB, r.id, ['火', '水'], 'now');
  const lastJoin = await join(userC, r.id, ['水', '土'], 'now');
  assert.match(lastJoin.view.content, /参加を受け付けました/u);
  assert.ok(r.participants.every(p => p.assignedAttribute), '3人とも割り振られる');
  assert.match(cardText(r), /割り振り（仮）/u);

  // 参加内容の変更：今の内容が入った状態から始まり「このまま次へ」で進める
  const edit = await click(userB, `join_recruitment_${r.id}`);
  assert.match(embedOf(edit.view).title, /参加内容の変更/u);
  const attrMenu = edit.view.components[0].toJSON().components[0];
  assert.deepStrictEqual(attrMenu.options.filter(o => o.default).map(o => o.value), ['火', '水']);
  const prefStep = await click(userB, findId(edit.view, `join_next_${r.id}`));
  assert.ok(customIds(prefStep.view).includes(`join_pref_select_${r.id}`), '属性を2つ以上選ぶと得意な属性を聞かれる');
  const backToAttrs = await click(userB, `join_back_${r.id}`);
  assert.ok(customIds(backToAttrs.view).includes(`attribute_select_per_raid_${r.id}`), '戻るで属性選択へ');
  await click(userB, `join_next_${r.id}`);
  const timeStep = await click(userB, `join_next_${r.id}`);
  assert.ok(customIds(timeStep.view).includes(`time_availability_select_${r.id}`));
  await choose(userB, `time_availability_select_${r.id}`, ['22:00']);
  await click(userB, `open_remarks_modal_${r.id}`);
  const changed = await submitModal(userB, `submit_remarks_${r.id}`, '22時から');
  assert.match(changed.view.content, /参加内容を変更しました/u);
  assert.strictEqual(r.participants.length, 3, '変更しても人数は増えない');
  assert.strictEqual(r.participants.find(p => p.userId === userB.id).remarks, '22時から');
  assert.strictEqual(rc.effectiveStartTime(r), '22:00', '割り振られた人の都合で開始が遅れる');
  assert.match(cardText(r), /21:00 → 22:00/u);

  // 募集者以外は確定・編集できない
  const notCreator = await click(outsider, `close_recruitment_${r.id}`);
  assert.match(notCreator.view.content, /募集者または管理者のみ/u);

  // ボードに載る
  await bot.updateBoard(GUILD);
  const boardEmbed = embedOf(channel.store.get(bot.boards()[GUILD].messageId).payload);
  assert.match(boardEmbed.description, /天元/u);
  assert.match(boardEmbed.description, /3\/6/u);

  // 当日8:00 → 仮確定。調整用スレッドを作り、参加者を追加してお知らせ（メンションなし）
  setNow(rc.provisionalAtMs(r) + 60 * 1000);
  await bot.checkSchedules();
  assert.strictEqual(r.status, 'provisional');
  const thread = channels.get(r.threadId);
  assert.ok(thread, '調整用スレッドができる');
  assert.deepStrictEqual([...thread.memberIds].sort(), [userA.id, userB.id, userC.id].sort());
  const provisionalNotice = thread.store.get(r.provisionalNoticeId);
  assert.ok(provisionalNotice, '仮確定のお知らせはスレッドに出る');
  assert.deepStrictEqual(provisionalNotice.payload.allowedMentions.users, [], '仮確定はメンションしない');
  assert.match(cardText(r), /🟡/u);
  assert.match(cardText(r), new RegExp(`<#${r.threadId}>`, 'u'));

  // 仮確定中に後から参加 → 入れる枠がなければ補欠。スレッドにも追加される
  await join(userD, r.id, ['火'], 'now');
  assert.strictEqual(r.participants.find(p => p.userId === userD.id).assignedAttribute, null);
  assert.match(cardText(r), /補欠/u);
  assert.ok(thread.memberIds.includes(userD.id));

  // 参加者が枠を編集：D を火に入れる → 元の火の人は補欠へ
  const fireBefore = r.participants.find(p => p.assignedAttribute === '火');
  const editor = await click(userC, `edit_slots_${r.id}`);
  assert.ok(isEphemeral(editor.view));
  const candidates = await choose(userC, `slot_pick_${r.id}`, ['火']);
  assert.ok(customIds(candidates.view).includes(`slot_assign_${r.id}_火`));
  const assigned = await choose(userC, `slot_assign_${r.id}_火`, [userD.id]);
  assert.match(embedOf(assigned.view).description, /火】を <@100000000000000014> にしました/u);
  assert.strictEqual(r.participants.find(p => p.userId === userD.id).assignedAttribute, '火');
  assert.strictEqual(fireBefore.assignedAttribute, null);
  assert.strictEqual(r.lastEditedBy, userC.id);

  // 参加していない人は枠を編集できない
  const noEdit = await click(outsider, `edit_slots_${r.id}`);
  assert.match(noEdit.view.content, /参加者・募集者・管理者のみ/u);

  // 開始1時間前 → 本確定（割り振られた人だけメンション。スレッド内の仮確定のお知らせは経緯として残す）
  setNow(rc.finalizeAtMs(r) + 60 * 1000);
  await bot.checkSchedules();
  assert.strictEqual(r.status, 'finalized');
  assert.ok(!provisionalNotice.deleted, 'スレッド内の仮確定のお知らせは残る');
  const finalNotice = thread.store.get(r.finalNoticeId);
  const assignedIds = r.participants.filter(p => p.assignedAttribute).map(p => p.userId).sort();
  assert.deepStrictEqual([...finalNotice.payload.allowedMentions.users].sort(), assignedIds);
  assert.match(finalNotice.payload.content, /本確定/u);
  assert.match(cardText(r), /🏁/u);
  assert.deepStrictEqual(customIds(card(r).payload), [`cancel_participation_${r.id}`, `participants_detail_${r.id}`]);

  // 本確定後に D がキャンセル → 補欠（元の火の人）が繰り上がりメンション
  const askCancel = await click(userD, `cancel_participation_${r.id}`);
  assert.match(askCancel.view.content, /空きになり/u);
  await click(userD, `confirm_cancel_participation_${r.id}`);
  assert.strictEqual(fireBefore.assignedAttribute, '火');
  const promotion = thread.sent[thread.sent.length - 1];
  assert.match(promotion.payload.content, /繰り上がりました/u);
  assert.deepStrictEqual(promotion.payload.allowedMentions.users, [fireBefore.userId]);

  // 参加者詳細は本人だけに
  const detail = await click(outsider, `participants_detail_${r.id}`);
  assert.ok(isEphemeral(detail.view));
  assert.match(embedOf(detail.view).fields[0].value, /申告/u);

  // 開始時間を過ぎたらキャンセルできない
  setNow(rc.startAtMs(r) + 60 * 1000);
  const late = await click(userA, `cancel_participation_${r.id}`);
  assert.match(late.view.content, /開始時間を過ぎている/u);

  // 開始から24時間以上たつとカードとお知らせが消える
  setNow(rc.startAtMs(r) + 25 * 60 * 60 * 1000);
  await bot.cleanupOldRecruitments();
  assert.ok(!bot.activeRecruitments().has(r.id));
  assert.ok(!channel.store.has(r.messageId), 'カードが消える');
  assert.ok(thread.deleted, 'スレッドも消える');
  restoreNow();
});

test('募集の編集（日付変更で募集中に戻る・中止）と参加者希望', async () => {
  realNow = Date.now;
  const r = await createRecruitment(creator, '天元', '20:00');
  await join(userA, r.id, ['光'], 'now');

  // 仮確定させてから日付を先に延ばすと募集中に戻る
  setNow(rc.provisionalAtMs(r) + 60 * 1000);
  await bot.checkSchedules();
  assert.strictEqual(r.status, 'provisional');
  restoreNow();
  const menu = await click(creator, `edit_recruitment_${r.id}`);
  assert.ok(isEphemeral(menu.view));
  await click(creator, `edit_date_${r.id}`);
  const newDate = rc.jstDateString(5);
  const edited = await click(creator, `edit_set_date_${r.id}_${newDate}`);
  assert.match(embedOf(edited.view).description, /変更しました/u);
  assert.strictEqual(r.date, newDate);
  assert.strictEqual(r.status, 'active', '仮確定前の日付に戻ったので募集中');
  const editThread = channels.get(r.threadId);
  const changeNotice = editThread.sent[editThread.sent.length - 1];
  assert.match(changeNotice.payload.content, /募集内容が変更されました/u);
  assert.deepStrictEqual(changeNotice.payload.allowedMentions.users, [userA.id]);

  // 時間の変更
  await click(creator, `edit_time_${r.id}`);
  await choose(creator, `edit_set_time_${r.id}`, ['23:00']);
  assert.strictEqual(r.time, '23:00');

  // レイドの変更：担当属性は引き継ぐ
  await click(creator, `edit_raid_${r.id}`);
  await click(creator, `edit_set_raid_${r.id}_ルシゼロ`);
  assert.strictEqual(r.type, 'ルシゼロ');
  assert.deepStrictEqual(r.participants[0].attributesByRaid, { ルシゼロ: ['光'] });
  assert.strictEqual(r.participants[0].assignedAttribute, '光');

  // 中止：カードが消えて参加者に通知
  await click(creator, `abort_recruitment_${r.id}`);
  const cardId = r.messageId;
  await click(creator, `confirm_abort_${r.id}`);
  assert.ok(!bot.activeRecruitments().has(r.id));
  assert.ok(!channel.store.has(cardId));
  assert.ok(editThread.deleted, '中止するとスレッドも消える');
  assert.match(channel.sent[channel.sent.length - 1].payload.content, /中止になりました/u);

  // 参加者希望：「どれでも可」は属性選択が1回だけ
  const flex = await createRecruitment(creator, rc.FLEX_RAID, '21:00');
  const start = await click(userA, `join_recruitment_${flex.id}`);
  assert.ok(customIds(start.view).includes(`join_type_${flex.id}`));
  const attrStep = await choose(userA, `join_type_${flex.id}`, [rc.ANY_RAID]);
  assert.match(embedOf(attrStep.view).description, /どのレイドでも/u);
  const prefStep = await choose(userA, `attribute_select_per_raid_${flex.id}`, ['all_attributes']);
  assert.ok(customIds(prefStep.view).includes(`join_pref_select_${flex.id}`));
  const timeStep = await choose(userA, `join_pref_select_${flex.id}`, ['none']);
  assert.ok(customIds(timeStep.view).includes(`time_availability_select_${flex.id}`), '属性選択1回で時間選択へ');
  await choose(userA, `time_availability_select_${flex.id}`, ['now']);
  await click(userA, `confirm_direct_${flex.id}`);
  const anyParticipant = flex.participants[0];
  assert.strictEqual(anyParticipant.joinType, rc.ANY_RAID);
  assert.strictEqual(Object.keys(anyParticipant.attributesByRaid).length, rc.selectableRaids().length);

  // 2人目はルシゼロだけ希望 → ルシゼロに決まる
  await click(userB, `join_recruitment_${flex.id}`);
  await choose(userB, `join_type_${flex.id}`, ['ルシゼロ']);
  await choose(userB, `attribute_select_per_raid_${flex.id}`, ['水']);
  await choose(userB, `time_availability_select_${flex.id}`, ['now']);
  await click(userB, `confirm_direct_${flex.id}`);
  assert.strictEqual(flex.finalRaidType, 'ルシゼロ');
  assert.match(cardText(flex), /参加者希望→ルシゼロ/u);

  // ボードから参加画面を開ける
  await bot.updateBoard(GUILD);
  const boardMessage = channel.store.get(bot.boards()[GUILD].messageId);
  assert.ok(customIds(boardMessage.payload).includes('board_join'));
  const fromBoard = await choose(userC, 'board_join', [flex.id]);
  assert.ok(isEphemeral(fromBoard.view));
  assert.match(embedOf(fromBoard.view).title, /参加申込/u);
  const createFromBoard = await click(userC, 'board_create');
  assert.ok(isEphemeral(createFromBoard.view));

  // ヘルプ・一覧・参加者確認は本人だけに表示
  const help = await command(userA, '募集ヘルプ');
  assert.ok(isEphemeral(help.view));
  const list = await command(userA, '募集リスト');
  assert.match(embedOf(list.view).description, /参加者希望/u);
  const pick = await command(userA, '参加者一覧');
  const shown = await choose(userA, findId(pick.view, 'select_recruitment_for_participants_'), [flex.id]);
  assert.match(embedOf(shown.view).fields[0].value, /どれでも 全属性/u);

  // データがファイルに保存されている
  const saved = JSON.parse(fs.readFileSync(bot.DATA_FILE_PATH, 'utf8'));
  assert.ok(saved[flex.id]);
  assert.ok(JSON.parse(fs.readFileSync(bot.BOARD_FILE_PATH, 'utf8'))[GUILD]);
});

test('まとめて作成・まとめて参加・前回の内容・得意な属性・抜ける時間', async () => {
  // 3日分をまとめて作成
  const days = [rc.jstDateString(3), rc.jstDateString(4), rc.jstDateString(6)];
  const created = await createRecruitments(creator, 'スパバハ', '21:00', days);
  assert.deepStrictEqual(created.map(r => r.date), days);
  assert.ok(created.every(r => r.type === 'スパバハ' && r.time === '21:00' && r.status === 'active'));

  // ボードで2件選んでまとめて参加（得意な属性・抜ける時間つき）
  await bot.updateBoard(GUILD);
  const boardMenu = channel.store.get(bot.boards()[GUILD].messageId).payload.components[0].toJSON().components[0];
  assert.ok(boardMenu.max_values >= 3, 'ボードは複数選べる');
  const bulk = await choose(userD, 'board_join', [created[0].id, created[2].id]);
  assert.ok(isEphemeral(bulk.view));
  assert.match(embedOf(bulk.view).title, /まとめて参加（2件）/u);
  const confirm = await fillJoinSteps(userD, 'bulk', bulk.view, { attrs: ['火', '水', '土'], prefs: ['土'], time: 'now', leave: '23:00' });
  const preview = embedOf(confirm).fields.find(f => f.name === '割り振りの見込み').value;
  assert.strictEqual(preview.split('\n').filter(line => line.startsWith('・')).length, 2, '見込みは募集ごとに出る');
  const done = await click(userD, 'confirm_direct_bulk');
  assert.match(done.view.content, /2件の募集に参加しました/u);
  for (const r of [created[0], created[2]]) {
    const d = r.participants.find(p => p.userId === userD.id);
    assert.deepStrictEqual(d.attributesByRaid, { スパバハ: ['火', '水', '土'] });
    assert.deepStrictEqual(d.preferredByRaid, { スパバハ: ['土'] });
    assert.strictEqual(d.leaveTime, '23:00');
    assert.strictEqual(d.assignedAttribute, '土', '得意な属性に入る');
  }
  assert.ok(!created[1].participants.some(p => p.userId === userD.id), '選ばなかった募集には入らない');

  // 前回の内容を覚えている：別の募集では最初から入っていて「このまま次へ」だけで参加できる
  const target = created[1];
  const again = await click(userD, `join_recruitment_${target.id}`);
  assert.match(embedOf(again.view).description, /前回の内容/u);
  assert.deepStrictEqual(again.view.components[0].toJSON().components[0].options.filter(o => o.default).map(o => o.value), ['火', '水', '土']);
  let view = (await click(userD, `join_next_${target.id}`)).view;
  assert.deepStrictEqual(view.components[0].toJSON().components[0].options.filter(o => o.default).map(o => o.value), ['土'], '得意な属性も覚えている');
  view = (await click(userD, `join_next_${target.id}`)).view;
  view = (await click(userD, `join_next_${target.id}`)).view;
  assert.strictEqual(embedOf(view).fields.find(f => f.name === '参加できる時間').value, '今すぐ〜23:00');
  await click(userD, `confirm_direct_${target.id}`);
  assert.strictEqual(target.participants[0].leaveTime, '23:00');
  assert.ok(JSON.parse(fs.readFileSync(bot.PROFILE_FILE_PATH, 'utf8'))[userD.id], '参加内容がファイルに保存される');

  // 抜ける時間：先に入った人が22:00に抜けるなら、22:00から来る人は補欠（開始を遅らせない）
  await join(userA, target.id, ['光'], 'now', { leave: '22:00' });
  await join(userB, target.id, ['闇'], '22:00');
  assert.strictEqual(target.participants.find(p => p.userId === userA.id).assignedAttribute, '光');
  assert.strictEqual(target.participants.find(p => p.userId === userB.id).assignedAttribute, null);
  assert.strictEqual(rc.effectiveStartTime(target), '21:00');
  assert.match(cardText(target), /22:00からのため/u);
  const bob = await click(userB, `participants_detail_${target.id}`);
  assert.match(embedOf(bob.view).fields[0].value, /今すぐ〜22:00/u);
});

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 100).unref(); // ボード更新のタイマーを待たずに終了
});
