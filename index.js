// Discord.jsの必要なクラスをインポート
const {
  Client,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  UserSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonStyle,
  GatewayIntentBits,
  InteractionType,
  MessageFlags,
  PermissionsBitField,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

// 環境変数をロード
require('dotenv').config();

// ファイルシステムモジュールをインポート
const fs = require('fs');
const path = require('path');

// 募集の計算・表示テキスト（Discordに依存しない部分）
const {
  ATTRIBUTES,
  ATTRIBUTE_EMOJI,
  RAID_TYPES,
  FLEX_RAID,
  ANY_RAID,
  START_HOURS,
  LEAVE_HOURS,
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
  isOpen,
  isFinalized,
  statusKey,
  shortId,
  attributesFor,
  preferredFor,
  fitsStart,
  reserveReason,
  who,
  realUserIds,
  timeLabel,
  declarationSummary,
  autoAssign,
  computeStartTime,
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
} = require('./recruitment');

// テストモード用のグローバル変数
const testMode = {
  active: false
};

// ボットの基本設定
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// 本番環境のパス（Renderなど）
const PRODUCTION_DATA_PATH = process.env.DATA_PATH || '/data/botdata';
// ローカルテスト用のパス (プロジェクト内に data フォルダを作成)
const LOCAL_DATA_PATH = path.join(__dirname, 'data');

// NODE_ENV 環境変数で本番かローカルかを判定 (なければローカルとみなす)
const isProduction = process.env.NODE_ENV === 'production';

const RENDER_DISK_MOUNT_PATH = isProduction ? PRODUCTION_DATA_PATH : LOCAL_DATA_PATH;
const DATA_FILE_PATH = path.join(RENDER_DISK_MOUNT_PATH, 'recruitment_data.json');
const BOARD_FILE_PATH = path.join(RENDER_DISK_MOUNT_PATH, 'board_data.json');
const PROFILE_FILE_PATH = path.join(RENDER_DISK_MOUNT_PATH, 'user_profiles.json');

console.log(`[Config] Environment: ${isProduction ? 'Production' : 'Development'}`);
console.log(`[Config] Data Path: ${DATA_FILE_PATH}`);

// グローバル変数
let activeRecruitments = new Map(); // 募集データ (募集ID → 募集)
const tempUserData = new Map(); // 参加申込の入力途中データ (ユーザーID → 入力状態)
let boards = {}; // 募集ボード (サーバーID → { channelId, messageId })
let userProfiles = {}; // 前回の参加内容 (ユーザーID → 属性・時間など)
const NG_WORDS = ["死ね", "殺す", "馬鹿", "アホ", "氏ね", "ころす", "バカ", /* ... 他の不適切な単語を追加 ... */]; // NGワードリスト
const MAX_REMARKS_LENGTH = 25; // 備考の最大文字数
const EPHEMERAL = MessageFlags.Ephemeral; // 本人にだけ見えるメッセージ
const CARD_COLORS = { active: '#3498DB', provisional: '#F1C40F', finalized: '#2ECC71' };
const RECRUITMENT_RETENTION_MS = 24 * 60 * 60 * 1000; // 開始からこの時間が過ぎた募集は削除
const JOIN_STATE_TTL_MS = 60 * 60 * 1000; // 参加申込の入力途中データの保持時間
const BOARD_UPDATE_DELAY_MS = 1500; // 募集ボード更新をまとめる待ち時間

// ユーティリティ関数
function generateUniqueId() {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function debugLog(tag, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${tag}] ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

function isAdmin(member) {
  return Boolean(member?.permissions?.has(PermissionsBitField.Flags.Administrator));
}

// 募集者または管理者か
function canManage(interaction, recruitment) {
  return interaction.user.id === recruitment.creator || isAdmin(interaction.member);
}

// 枠を編集できるのは、参加者・募集者・管理者
function canEditSlots(interaction, recruitment) {
  return canManage(interaction, recruitment) || recruitment.participants.some(p => p.userId === interaction.user.id);
}

// 代理登録・代理キャンセルも、枠の編集と同じ範囲
function canProxy(interaction, recruitment) {
  return canEditSlots(interaction, recruitment);
}

// 完全なIDでも、表示用の短いIDでも募集を探す
function findRecruitment(idOrShort) {
  if (activeRecruitments.has(idOrShort)) return activeRecruitments.get(idOrShort);
  return Array.from(activeRecruitments.values()).find(r => r && shortId(r.id) === idOrShort) || null;
}

function messageLink(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

// UI部品の作成ヘルパー
function row(...components) {
  return new ActionRowBuilder().addComponents(...components);
}

function button(customId, label, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

function backButton(customId) {
  return button(customId, '◀ 戻る');
}

function cancelButton(customId) {
  return button(customId, 'キャンセル', ButtonStyle.Danger);
}

function closeButton() {
  return button('dismiss', '閉じる');
}

function selectMenu(customId, placeholder, options, minValues = 1, maxValues = 1) {
  return new StringSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .addOptions(options)
    .setMinValues(minValues)
    .setMaxValues(maxValues);
}

function userSelect(customId, placeholder) {
  return new UserSelectMenuBuilder()
    .setCustomId(customId)
    .setPlaceholder(placeholder)
    .setMinValues(1)
    .setMaxValues(1);
}

// ボタンを1行5個ずつに分ける
function chunkRows(buttons) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push(row(...buttons.slice(i, i + 5)));
  return rows;
}

// スラッシュコマンド・ボタンからは本人だけに、!コマンドからは通常の返信で応答する
async function respond(source, payload) {
  if (source.isRepliable?.()) return source.reply({ ...payload, flags: EPHEMERAL });
  return source.reply(payload);
}

//==========================================================================
// データの保存・読み込み
//==========================================================================

// 募集データのロード処理
function loadRecruitmentData() {
  try {
    const dataDir = path.dirname(DATA_FILE_PATH);
    if (!fs.existsSync(dataDir)) {
      console.log(`データディレクトリが見つからないため作成します: ${dataDir}`);
      fs.mkdirSync(dataDir, { recursive: true });
    }

    if (!fs.existsSync(DATA_FILE_PATH)) {
      console.log('保存された募集データはありません。新規に開始します。');
      return new Map();
    }

    console.log('保存されていた募集データをロードします...');
    const data = fs.readFileSync(DATA_FILE_PATH, 'utf8');
    if (data.trim() === '') {
      console.log('データファイルが空です。新規に開始します。');
      return new Map();
    }
    const parsedData = JSON.parse(data);

    const loadedRecruitments = new Map();
    let openCount = 0;
    Object.entries(parsedData).forEach(([id, recruitment]) => {
      if (!recruitment || typeof recruitment !== 'object') {
        console.warn(`不正な募集データが見つかりました (ID: ${id})。スキップします。`);
        return;
      }
      if (!recruitment.status) recruitment.status = 'unknown';
      if (!Array.isArray(recruitment.participants)) recruitment.participants = [];
      loadedRecruitments.set(id, recruitment);
      if (isOpen(recruitment)) openCount++;
    });

    console.log(`${loadedRecruitments.size}件の募集データをロードしました（受付中: ${openCount}件）`);
    return loadedRecruitments;
  } catch (error) {
    console.error('募集データのロード中にエラーが発生しました:', error);
    return new Map();
  }
}

// JSONファイルを書き込む（書き込み途中で落ちても壊れないよう、一時ファイルから置き換える）
function writeJsonFile(filePath, data) {
  const dataDir = path.dirname(filePath);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tempPath, filePath);
}

// 募集データの保存処理
function saveRecruitmentData() {
  try {
    writeJsonFile(DATA_FILE_PATH, Object.fromEntries(activeRecruitments));
  } catch (error) {
    console.error('募集データの保存中にエラーが発生しました:', error);
  }
}

// 募集ボード・前回の参加内容などのJSONファイルを読み込む（なければ空）
function loadJsonObject(filePath, label) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const data = fs.readFileSync(filePath, 'utf8');
    return data.trim() === '' ? {} : JSON.parse(data);
  } catch (error) {
    console.error(`${label}のロード中にエラーが発生しました:`, error);
    return {};
  }
}

function saveJsonObject(filePath, data, label) {
  try {
    writeJsonFile(filePath, data);
  } catch (error) {
    console.error(`${label}の保存中にエラーが発生しました:`, error);
  }
}

function loadBoards() {
  return loadJsonObject(BOARD_FILE_PATH, '募集ボードデータ');
}

function saveBoards() {
  saveJsonObject(BOARD_FILE_PATH, boards, '募集ボードデータ');
}

function loadProfiles() {
  return loadJsonObject(PROFILE_FILE_PATH, '参加内容の記録');
}

function saveProfiles() {
  saveJsonObject(PROFILE_FILE_PATH, userProfiles, '参加内容の記録');
}

//==========================================================================
// メッセージ操作
//==========================================================================

async function deleteMessage(channelId, messageId) {
  if (!channelId || !messageId) return;
  try {
    const channel = await client.channels.fetch(channelId).catch(() => null);
    const message = await channel?.messages.fetch(messageId).catch(() => null);
    if (message) await message.delete();
  } catch (error) {
    console.error(`メッセージ削除失敗 (ID: ${messageId}):`, error.message);
  }
}

// お知らせを投稿する（userIds の人だけメンション）。調整用スレッドがあればスレッドに、なければ募集カードへの返信として
async function postNotice(recruitment, content, userIds = []) {
  try {
    const allowedMentions = { users: userIds, roles: [], repliedUser: false };
    const thread = await fetchThread(recruitment);
    if (thread) return await thread.send({ content, allowedMentions });
    const channel = await client.channels.fetch(recruitment.channel).catch(() => null);
    if (!channel || !channel.isTextBased()) return null;
    const payload = { content, allowedMentions };
    if (recruitment.messageId) payload.reply = { messageReference: recruitment.messageId, failIfNotExists: false };
    return await channel.send(payload);
  } catch (error) {
    console.error(`お知らせ投稿エラー (ID: ${recruitment.id}):`, error);
    return null;
  }
}

// 仮確定時に募集カードから調整用スレッドを作り、参加者を追加する（話し合いとお知らせをまとめる）
async function createThread(recruitment) {
  if (recruitment.threadId) return;
  try {
    const channel = await client.channels.fetch(recruitment.channel).catch(() => null);
    const message = await channel?.messages.fetch(recruitment.messageId).catch(() => null);
    if (!message) return;
    const thread = message.thread || await message.startThread({ name: truncate(`${headline(recruitment)} 調整`, 100), autoArchiveDuration: 1440 });
    recruitment.threadId = thread.id;
    saveRecruitmentData();
    for (const userId of realUserIds(recruitment.participants)) {
      await thread.members.add(userId).catch(() => { });
    }
  } catch (error) {
    console.warn(`調整用スレッドを作成できませんでした（カードへの返信で続行）(ID: ${recruitment.id}):`, error.message);
  }
}

async function fetchThread(recruitment) {
  if (!recruitment.threadId) return null;
  return client.channels.fetch(recruitment.threadId).catch(() => null);
}

async function addToThread(recruitment, userId) {
  if (!recruitment.threadId || !/^\d+$/.test(userId)) return;
  const thread = await fetchThread(recruitment);
  await thread?.members.add(userId).catch(() => { });
}

// スレッドを削除する（権限がなければアーカイブ）
async function deleteThread(recruitment) {
  const thread = await fetchThread(recruitment);
  if (thread) await thread.delete().catch(() => thread.setArchived(true).catch(() => { }));
  recruitment.threadId = null;
}

// 古い募集のクリーンアップ処理（開始から24時間たった募集のカードとお知らせを削除）
async function cleanupOldRecruitments() {
  const now = Date.now();
  const expiredIds = [];
  activeRecruitments.forEach((recruitment, id) => {
    if (!recruitment || typeof recruitment.date !== 'string' || !recruitment.time || Number.isNaN(startAtMs(recruitment))) {
      expiredIds.push(id);
    } else if (now > startAtMs(recruitment) + RECRUITMENT_RETENTION_MS) {
      expiredIds.push(id);
    }
  });

  for (const id of expiredIds) {
    const recruitment = activeRecruitments.get(id);
    if (recruitment?.channel) {
      await deleteThread(recruitment);
      for (const messageId of [recruitment.messageId, recruitment.provisionalNoticeId, recruitment.finalNoticeId]) {
        await deleteMessage(recruitment.channel, messageId);
      }
    }
    activeRecruitments.delete(id);
    debugLog('Cleanup', `古い募集を削除: ID=${id}, Type=${recruitment?.type || 'N/A'}, Status=${recruitment?.status || 'N/A'}`);
  }

  for (const drafts of [tempUserData, createDrafts]) {
    drafts.forEach((state, userId) => {
      if (now - (state.updatedAt || 0) > JOIN_STATE_TTL_MS) drafts.delete(userId);
    });
  }

  if (expiredIds.length > 0) {
    console.log(`古い募集 ${expiredIds.length}件をクリーンアップしました。残り: ${activeRecruitments.size}件`);
    saveRecruitmentData();
    Object.keys(boards).forEach(guildId => requestBoardUpdate(guildId));
  }
}

//==========================================================================
// スラッシュコマンド
//==========================================================================

// スラッシュコマンドの定義（日本語名と英語名の両方）
function buildSlashCommands() {
  return [
    new SlashCommandBuilder().setName('recruit').setDescription('新しい募集を開始します (募集)'),
    new SlashCommandBuilder().setName('募集').setDescription('新しい募集を開始します'),
    new SlashCommandBuilder().setName('list').setDescription('現在の募集一覧を表示します (募集リスト)'),
    new SlashCommandBuilder().setName('募集リスト').setDescription('現在の募集一覧を表示します'),
    new SlashCommandBuilder().setName('help').setDescription('ボットのヘルプを表示します (募集ヘルプ)'),
    new SlashCommandBuilder().setName('募集ヘルプ').setDescription('ボットのヘルプを表示します'),
    new SlashCommandBuilder().setName('participants').setDescription('募集の参加者一覧を表示します (参加者一覧)'),
    new SlashCommandBuilder().setName('参加者一覧').setDescription('募集の参加者一覧を表示します'),
    new SlashCommandBuilder().setName('募集ボード').setDescription('全募集をまとめた募集ボードをこのチャンネルに設置します'),
  ].map(command => command.toJSON());
}

// スラッシュコマンド登録関数
async function registerCommands() {
  const commands = buildSlashCommands();
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

  try {
    console.log('スラッシュコマンドの登録を開始します...');
    // ギルドIDがあればギルドコマンドとして、なければグローバルコマンドとして登録
    const guildId = process.env.GUILD_ID;
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
      console.log(`スラッシュコマンドをギルド (${guildId}) に登録しました。`);
    } else {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('スラッシュコマンドをグローバルに登録しました (反映に時間がかかる場合があります)。');
    }
  } catch (error) {
    console.error('スラッシュコマンドの登録中にエラーが発生しました:', error);
  }
}

async function handleSlashCommand(interaction) {
  switch (interaction.commandName) {
    case 'recruit':
    case '募集':
      return startRecruitment(interaction);
    case 'list':
    case '募集リスト':
      return showActiveRecruitments(interaction);
    case 'help':
    case '募集ヘルプ':
      return showHelp(interaction);
    case 'participants':
    case '参加者一覧':
      return showRecruitmentSelectionForParticipants(interaction);
    case '募集ボード':
      return setupBoard(interaction);
    default:
      return interaction.reply({ content: '不明なコマンドです。', flags: EPHEMERAL });
  }
}

// ボット準備完了時の処理
client.once('ready', async () => {
  console.log(`${client.user.tag} でログインしました！`);
  console.log('Discord.js バージョン:', require('discord.js').version);

  registerCommands();

  // 保存済みデータがあればロード
  const loadedData = loadRecruitmentData();
  if (loadedData instanceof Map && loadedData.size > 0) {
    activeRecruitments = loadedData;
  }
  boards = loadBoards();
  userProfiles = loadProfiles();

  // 定期的な処理の開始
  setInterval(saveRecruitmentData, 2 * 60 * 1000); // 2分ごとにデータ保存
  setInterval(checkSchedules, 60 * 1000); // 1分ごとに仮確定・本確定をチェック
  setInterval(cleanupOldRecruitments, 60 * 60 * 1000); // 1時間ごとに古い募集をクリーンアップ
  setInterval(() => Object.keys(boards).forEach(guildId => requestBoardUpdate(guildId)), 10 * 60 * 1000); // 開始した募集をボードから外す

  await cleanupOldRecruitments();
  await refreshAllCards();
  await checkSchedules();
  saveRecruitmentData();
});

// 起動時に全募集カードを最新の表示に更新する（旧バージョンの募集も新しい表示に切り替わる）
async function refreshAllCards() {
  for (const recruitment of Array.from(activeRecruitments.values())) {
    if (!isOpen(recruitment) && !isFinalized(recruitment)) continue;
    try {
      if (recruitment.status === 'active') autoAssign(recruitment);
      await updateRecruitmentMessage(recruitment);
    } catch (error) {
      console.error(`起動時の募集カード更新エラー (ID: ${recruitment.id}):`, error);
    }
  }
  saveRecruitmentData();
}

// エラー応答ヘルパー関数
async function handleErrorReply(interaction, error, customMessage = 'エラーが発生しました。') {
  const errorCode = error?.code;
  const errorMessage = error instanceof Error ? error.message : String(error);

  console.error(`エラー応答試行 (Interaction ID: ${interaction?.id}, CustomID: ${interaction?.customId || 'N/A'}, Code: ${errorCode}): ${errorMessage}`);
  if (error instanceof Error) console.error(error.stack);

  // 無視するエラーコード
  if (errorCode === 10062 /* Unknown interaction */ || errorCode === 40060 /* Already acknowledged */) {
    console.log(`無視するインタラクションエラー (コード: ${errorCode}) - 応答しません`);
    return;
  }
  if (!interaction || !interaction.isRepliable()) {
    console.error('エラー応答不可: Interactionオブジェクトが無効または応答不可能です。');
    return;
  }

  const replyOptions = {
    content: `${customMessage} (詳細: ${errorMessage.substring(0, 100)}${errorMessage.length > 100 ? '...' : ''}${errorCode ? ` / コード: ${errorCode}` : ''})`,
    flags: EPHEMERAL
  };

  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(replyOptions).catch(e => console.error('followUpでのエラー応答失敗:', e.message));
    } else {
      await interaction.reply(replyOptions).catch(e => console.error('replyでのエラー応答失敗:', e.message));
    }
  } catch (replyErr) {
    console.error('最終的なエラー応答処理中に致命的なエラー:', replyErr);
  }
}

// メインのinteractionCreateイベントハンドラ
async function handleInteraction(interaction) {
  if (!interaction.guild || !interaction.member) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: 'このボットはサーバー内でのみ利用可能です。', flags: EPHEMERAL }).catch(() => { });
    }
    return;
  }
  if (interaction.user.bot) return;

  try {
    if (interaction.isChatInputCommand()) {
      await handleSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelectMenuInteraction(interaction);
    } else if (interaction.isUserSelectMenu?.()) {
      await handleUserSelectInteraction(interaction);
    } else if (interaction.type === InteractionType.ModalSubmit) {
      await handleModalSubmit(interaction);
    }
  } catch (error) {
    console.error(`インタラクション処理中に予期せぬエラーが発生 (ID: ${interaction.id}, CustomID: ${interaction.customId || 'N/A'}):`);
    console.error(error);
    await handleErrorReply(interaction, error, '処理中に予期せぬエラーが発生しました。');
  }
}
client.on('interactionCreate', handleInteraction);

// !コマンド（管理者向け。募集の作成・参加はスラッシュコマンドとボタンで行う）
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();
  const requireAdmin = () => {
    if (isAdmin(message.member)) return true;
    message.reply('管理者権限が必要です。').catch(() => { });
    return false;
  };

  try {
    if (command === '募集') {
      await startRecruitment(message);
    } else if (command === '募集リスト') {
      await showActiveRecruitments(message);
    } else if (command === '募集ヘルプ') {
      await showHelp(message);
    } else if (command === 'テストモード開始') {
      if (requireAdmin()) await startTestMode(message);
    } else if (command === 'テストモード終了') {
      if (requireAdmin()) await endTestMode(message);
    } else if (command === 'テスト参加者追加') {
      if (!requireAdmin()) return;
      const count = parseInt(args[1], 10);
      if (args.length < 2 || Number.isNaN(count) || count <= 0) {
        return message.reply('使用方法: `!テスト参加者追加 [募集ID] [人数]`');
      }
      await addTestParticipantsByCommand(message, args[0], count);
    } else if (command === 'idリスト') {
      await showIdList(message);
    } else if (command === '募集削除') {
      if (args.length < 1) return message.reply('使用方法: `!募集削除 [募集ID]`');
      await deleteRecruitment(message, args[0]); // 権限チェックは deleteRecruitment 内で行う
    } else if (command === '募集確認') {
      if (!requireAdmin()) return;
      if (args.length < 1) return message.reply('使用方法: `!募集確認 [募集ID]`');
      await showRecruitmentDetails(message, args[0]);
    } else if (command === '募集詳細確認') {
      if (requireAdmin()) await showAllRecruitmentDetails(message);
    }
  } catch (error) {
    console.error(`コマンド "${command}" の処理中にエラーが発生:`, error);
    await message.reply('コマンドの実行中にエラーが発生しました。').catch(() => { });
  }
});

//==========================================================================
// ボタン・セレクトメニュー・モーダルの振り分け
//==========================================================================

// customId が prefix で始まっていれば、その後ろの部分を返す
function after(customId, prefix) {
  return customId.startsWith(prefix) ? customId.slice(prefix.length) : null;
}

async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;
  let rest;

  // --- 募集作成 ---
  if ((rest = after(customId, 'raid_type_')) !== null) return selectCreateRaid(interaction, rest);
  if (customId === 'create_back_raid') return interaction.update(raidSelectionPayload());
  if (customId === 'create_back_dates') return showCreateStep(interaction, 'dates');
  if (customId === 'create_next_dates' || customId === 'create_back_time') return showCreateStep(interaction, 'time');
  if (customId === 'create_next_time') return showCreateStep(interaction, 'confirm');
  if (customId === 'create_confirm') return publishRecruitments(interaction);
  if (customId === 'cancel_recruitment') {
    createDrafts.delete(interaction.user.id);
    return interaction.update({ content: '募集作成をキャンセルしました。', embeds: [], components: [] });
  }

  // --- 参加申込 ---
  if ((rest = after(customId, 'join_recruitment_')) !== null) return showJoinOptions(interaction, rest);
  if ((rest = after(customId, 'join_next_')) !== null) return moveJoinStep(interaction, rest, 1);
  if ((rest = after(customId, 'join_back_')) !== null) return moveJoinStep(interaction, rest, -1);
  if ((rest = after(customId, 'open_remarks_modal_')) !== null) return showRemarksModal(interaction, rest);
  if ((rest = after(customId, 'confirm_direct_')) !== null) {
    await interaction.deferUpdate();
    return commitJoin(interaction, rest);
  }
  if (customId === 'cancel_join') {
    tempUserData.delete(interaction.user.id);
    return interaction.update({ content: '参加申込をキャンセルしました。', embeds: [], components: [] });
  }

  // --- 参加キャンセル・参加者詳細 ---
  if ((rest = after(customId, 'confirm_cancel_participation_')) !== null) return cancelParticipation(interaction, rest);
  if ((rest = after(customId, 'cancel_participation_')) !== null) return askCancelParticipation(interaction, rest);
  if ((rest = after(customId, 'participants_detail_')) !== null) return showParticipantDetail(interaction, rest);

  // --- 代理登録・代理キャンセル（仮確定中。長い prefix を先に見る） ---
  if ((rest = after(customId, 'proxy_cancel_do_')) !== null) {
    const sep = rest.indexOf('_');
    if (sep === -1) return interaction.reply({ content: 'このボタンは現在処理できません。', flags: EPHEMERAL });
    return executeProxyCancel(interaction, rest.slice(0, sep), rest.slice(sep + 1));
  }
  if ((rest = after(customId, 'proxy_register_')) !== null) return showProxyRegister(interaction, rest);
  if ((rest = after(customId, 'proxy_cancel_')) !== null) return showProxyCancel(interaction, rest);

  // --- 仮確定・本確定 ---
  if ((rest = after(customId, 'close_recruitment_')) !== null) return askAdvance(interaction, rest, 'provisional');
  if ((rest = after(customId, 'finalize_recruitment_')) !== null) return askAdvance(interaction, rest, 'final');
  if ((rest = after(customId, 'confirm_close_')) !== null) return advanceNow(interaction, rest, 'provisional');
  if ((rest = after(customId, 'confirm_finalize_')) !== null) return advanceNow(interaction, rest, 'final');

  // --- 枠の編集 ---
  if ((rest = after(customId, 'edit_slots_')) !== null) return showSlotEditor(interaction, rest);
  if ((rest = after(customId, 'slot_back_')) !== null) return showSlotEditor(interaction, rest, { update: true });

  // --- 募集の編集（募集者） ---
  if ((rest = after(customId, 'edit_set_date_')) !== null) {
    const [id, date] = rest.split('_');
    return applyEdit(interaction, id, 'date', date);
  }
  if ((rest = after(customId, 'edit_set_raid_')) !== null) {
    const [id, raidType] = rest.split('_');
    return applyEdit(interaction, id, 'raid', raidType);
  }
  if ((rest = after(customId, 'edit_date_')) !== null) return showEditDate(interaction, rest);
  if ((rest = after(customId, 'edit_time_')) !== null) return showEditTime(interaction, rest);
  if ((rest = after(customId, 'edit_raid_')) !== null) return showEditRaid(interaction, rest);
  if ((rest = after(customId, 'edit_menu_')) !== null) return showEditMenu(interaction, rest, { update: true });
  if ((rest = after(customId, 'edit_recruitment_')) !== null) return showEditMenu(interaction, rest);
  if ((rest = after(customId, 'abort_recruitment_')) !== null) return askAbort(interaction, rest);
  if ((rest = after(customId, 'confirm_abort_')) !== null) return abortRecruitmentByButton(interaction, rest);

  // --- 募集ボード ---
  if (customId === 'board_create') return startRecruitment(interaction);

  // --- テストモード ---
  if ((rest = after(customId, 'add_test_participants_')) !== null) {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: '管理者権限が必要です。', flags: EPHEMERAL });
    return showTestParticipantAddOptions(interaction, rest);
  }
  if ((rest = after(customId, 'confirm_test_participants_')) !== null) {
    if (!isAdmin(interaction.member)) return interaction.update({ content: '管理者権限が必要です。', embeds: [], components: [] });
    const [id, countText] = rest.split('_');
    const count = parseInt(countText, 10);
    if (Number.isNaN(count)) throw new Error(`テスト参加者数解析エラー: ${countText}`);
    return confirmAddTestParticipants(interaction, id, count);
  }
  if (customId === 'cancel_test_participants') {
    return interaction.update({ content: 'テスト参加者の追加をキャンセルしました。', embeds: [], components: [] });
  }

  if (customId === 'dismiss') return interaction.update({ content: '閉じました。', embeds: [], components: [] });

  console.warn(`未処理のボタンID: ${customId}`);
  return interaction.reply({ content: 'このボタンは現在処理できません。', flags: EPHEMERAL });
}

async function handleSelectMenuInteraction(interaction) {
  const customId = interaction.customId;
  const value = interaction.values[0];
  let rest;

  // --- 募集作成 ---
  if (customId === 'create_dates') return selectCreateDates(interaction, interaction.values);
  if (customId === 'create_time') return selectCreateTime(interaction, value);

  // --- 参加申込 ---
  if ((rest = after(customId, 'join_type_')) !== null) return selectJoinRaids(interaction, rest, interaction.values);
  if ((rest = after(customId, 'attribute_select_per_raid_')) !== null) return selectJoinAttributes(interaction, rest, interaction.values);
  if ((rest = after(customId, 'join_pref_select_')) !== null) return selectJoinPreferences(interaction, rest, interaction.values);
  if ((rest = after(customId, 'time_availability_select_')) !== null) return selectJoinTime(interaction, rest, value);
  if ((rest = after(customId, 'join_leave_')) !== null) return selectJoinLeave(interaction, rest, value);

  // --- 代理キャンセル（仮確定中） ---
  if ((rest = after(customId, 'proxy_cancel_pick_')) !== null) return askProxyCancel(interaction, rest, value);

  // --- 枠の編集 ---
  if ((rest = after(customId, 'slot_pick_')) !== null) return showSlotCandidates(interaction, rest, value);
  if ((rest = after(customId, 'slot_assign_')) !== null) {
    const [id, attr] = rest.split('_');
    return assignSlot(interaction, id, attr, value);
  }

  // --- 募集の編集（募集者） ---
  if ((rest = after(customId, 'edit_set_time_')) !== null) return applyEdit(interaction, rest, 'time', value);

  // --- 募集ボード・参加者確認 ---
  if (customId === 'board_join') {
    await showBulkJoin(interaction, interaction.values); // 1件だけ選んだ場合は通常の参加画面
    requestBoardUpdate(interaction.guildId); // ボード側の選択表示を元に戻す
    return;
  }
  if (customId.startsWith('select_recruitment_for_participants_')) return showParticipantsList(interaction, value);

  // --- テストモード ---
  if ((rest = after(customId, 'test_participant_count_')) !== null) {
    if (!isAdmin(interaction.member)) return interaction.update({ content: '管理者権限が必要です。', embeds: [], components: [] });
    const count = parseInt(value, 10);
    if (Number.isNaN(count)) throw new Error(`テスト参加者数解析エラー: ${value}`);
    return showTestParticipantConfirmation(interaction, rest, count);
  }

  console.warn(`未処理のセレクトメニューID: ${customId}`);
  return interaction.update({ content: 'このメニューは現在処理できません。', components: [] });
}

async function handleUserSelectInteraction(interaction) {
  const rest = after(interaction.customId, 'proxy_register_pick_');
  if (rest !== null) return beginProxyRegister(interaction, rest, interaction.values[0]);
  console.warn(`未処理のユーザー選択ID: ${interaction.customId}`);
  return interaction.update({ content: 'このメニューは現在処理できません。', components: [] });
}

async function handleModalSubmit(interaction) {
  const id = after(interaction.customId, 'submit_remarks_');
  if (id === null) {
    console.warn(`不明なモーダルID: ${interaction.customId}`);
    return interaction.reply({ content: '不明なフォームデータを受信しました。', flags: EPHEMERAL });
  }

  const remarks = interaction.fields.getTextInputValue('remarks_input')?.trim() || '';
  const foundNgWord = NG_WORDS.find(ngWord => remarks.toLowerCase().includes(ngWord.toLowerCase()));
  if (foundNgWord) {
    return interaction.reply({ content: `エラー: 備考に不適切な単語「${foundNgWord}」が含まれています。修正してください。`, flags: EPHEMERAL });
  }
  if (remarks.length > MAX_REMARKS_LENGTH) {
    return interaction.reply({ content: `エラー: 備考が長すぎます (${remarks.length}/${MAX_REMARKS_LENGTH}文字)。`, flags: EPHEMERAL });
  }

  const state = getJoinState(interaction, id);
  if (state) {
    state.remarks = remarks;
    state.remarksTouched = true;
  }
  await interaction.deferUpdate();
  return commitJoin(interaction, id);
}

//==========================================================================
// 募集作成（レイド → 日付（複数可）→ 時間 → 確認。各画面に「戻る」あり）
//==========================================================================

const createDrafts = new Map(); // 募集作成の入力途中データ (ユーザーID → { raidType, dates, time })
const STALE_CREATE_MESSAGE = { content: 'この作成画面は古くなっています。もう一度 `/募集` から作成してください。', embeds: [], components: [] };

function raidSelectionPayload() {
  const embed = new EmbedBuilder()
    .setTitle('🔰 高難易度募集作成')
    .setDescription('募集するレイドタイプを選択してください。')
    .setColor('#0099ff');
  const raidButtons = RAID_TYPES.map(type => button(`raid_type_${type}`, type, ButtonStyle.Primary));
  return { content: '', embeds: [embed], components: [...chunkRows(raidButtons), row(cancelButton('cancel_recruitment'))] };
}

// 募集開始処理
async function startRecruitment(source) {
  const payload = raidSelectionPayload();
  if (source.isRepliable?.()) {
    // スラッシュコマンド・ボードのボタンからは、本人にだけ見える画面で作成する
    return source.reply({ ...payload, flags: EPHEMERAL });
  }

  // !募集（メッセージコマンド）は従来どおり返信で表示し、30分後に無効化
  let responseMessage;
  try {
    responseMessage = await source.reply(payload);
  } catch (error) {
    console.error('募集開始メッセージ送信エラー:', error);
    return;
  }
  setTimeout(() => {
    const timeoutEmbed = new EmbedBuilder()
      .setTitle('🔰 高難易度募集作成（期限切れ）')
      .setDescription('この募集作成セッションは期限切れになりました。\n新しく募集を開始するには `/募集` を使用してください。')
      .setColor('#FF6B6B');
    responseMessage.edit({ embeds: [timeoutEmbed], components: [] }).catch(error => {
      if (error.code !== 10008) console.error('募集作成UI無効化エラー:', error);
    });
  }, 30 * 60 * 1000);
}

// 翌日から7日分の日付（日本時間）
function upcomingDates() {
  const dates = [];
  for (let i = 1; i <= 7; i++) dates.push(jstDateString(i));
  return dates;
}

// 日付ボタン（募集の編集で使う）
function dateButtons(customIdPrefix, currentDate = null) {
  return upcomingDates().map(date => button(`${customIdPrefix}${date}`, formatDateShort(date), date === currentDate ? ButtonStyle.Primary : ButtonStyle.Secondary));
}

function hourOptions(currentTime = null) {
  return START_HOURS.map(hour => ({ label: formatHour(hour), value: formatHour(hour), default: formatHour(hour) === currentTime }));
}

function getCreateDraft(interaction) {
  const draft = createDrafts.get(interaction.user.id);
  if (draft) draft.updatedAt = Date.now();
  return draft || null;
}

function createDatePayload(draft) {
  const options = upcomingDates().map(date => ({ label: formatDateShort(date), value: date, default: draft.dates.includes(date) }));
  const embed = new EmbedBuilder()
    .setTitle(`📅 ${draft.raidType}募集 - 日付選択`)
    .setDescription('開催したい日付を選択してください。\n**複数選ぶと、同じレイド・時間の募集を日付ごとにまとめて作成します。**')
    .setColor('#0099ff');
  const buttons = [backButton('create_back_raid')];
  if (draft.dates.some(date => options.some(o => o.value === date))) buttons.push(button('create_next_dates', 'このまま次へ ▶', ButtonStyle.Primary));
  buttons.push(cancelButton('cancel_recruitment'));
  return { content: '', embeds: [embed], components: [row(selectMenu('create_dates', '開催日を選択 (複数可)', options, 1, options.length)), row(...buttons)] };
}

function createTimePayload(draft) {
  const embed = new EmbedBuilder()
    .setTitle(`⏰ ${draft.raidType}募集 - 時間選択`)
    .setDescription(`選択した日付: ${draft.dates.map(formatDateShort).join('、')}\n開催時間を選択してください。`)
    .setColor('#0099ff');
  const buttons = [backButton('create_back_dates')];
  if (draft.time) buttons.push(button('create_next_time', 'このまま次へ ▶', ButtonStyle.Primary));
  buttons.push(cancelButton('cancel_recruitment'));
  return { content: '', embeds: [embed], components: [row(selectMenu('create_time', '開催時間を選択', hourOptions(draft.time))), row(...buttons)] };
}

function createConfirmPayload(draft, interaction) {
  const count = draft.dates.length;
  const embed = new EmbedBuilder()
    .setTitle('🔍 募集内容確認')
    .setDescription(`以下の内容で${count > 1 ? `**${count}件の**` : ''}募集を開始しますか？`)
    .setColor('#0099ff')
    .addFields(
      { name: 'レイド', value: draft.raidType, inline: true },
      { name: '開催日', value: draft.dates.map(formatDateShort).join('\n'), inline: true },
      { name: '時間', value: draft.time, inline: true },
      { name: '募集者', value: interaction.user.toString(), inline: false },
      { name: 'この後の流れ', value: '当日 8:00 に仮確定 → 開始1時間前に本確定（割り振られた人にメンション）', inline: false }
    )
    .setFooter({ text: 'よろしければ「確定」を押してください。' });
  return {
    content: '',
    embeds: [embed],
    components: [row(
      button('create_confirm', count > 1 ? `確定（${count}件作成）` : '確定', ButtonStyle.Success),
      backButton('create_back_time'),
      cancelButton('cancel_recruitment')
    )]
  };
}

// 作成画面の表示（step: 'dates' | 'time' | 'confirm'）
async function showCreateStep(interaction, step) {
  const draft = getCreateDraft(interaction);
  if (!draft) return interaction.update(STALE_CREATE_MESSAGE);
  // 画面を開いたまま日付が変わった場合に備えて、選べる範囲外になった日付は外す
  draft.dates = draft.dates.filter(date => upcomingDates().includes(date));
  if (step === 'time' && draft.dates.length === 0) step = 'dates';
  if (step === 'confirm' && !draft.time) step = 'time';
  if (step === 'dates') return interaction.update(createDatePayload(draft));
  if (step === 'time') return interaction.update(createTimePayload(draft));
  return interaction.update(createConfirmPayload(draft, interaction));
}

async function selectCreateRaid(interaction, raidType) {
  if (!RAID_TYPES.includes(raidType)) throw new Error(`不正なレイドタイプ: ${raidType}`);
  const previous = createDrafts.get(interaction.user.id);
  // 「戻る」でレイドを選び直した場合は、選んでいた日付・時間を引き継ぐ
  createDrafts.set(interaction.user.id, { raidType, dates: previous?.dates || [], time: previous?.time || null, updatedAt: Date.now() });
  return showCreateStep(interaction, 'dates');
}

async function selectCreateDates(interaction, dates) {
  const draft = getCreateDraft(interaction);
  if (draft) draft.dates = [...dates].sort();
  return showCreateStep(interaction, 'time');
}

async function selectCreateTime(interaction, time) {
  const draft = getCreateDraft(interaction);
  if (draft) draft.time = time;
  return showCreateStep(interaction, 'confirm');
}

// 募集確定処理 (日付ごとに募集カードをチャンネルに投稿)
async function publishRecruitments(interaction) {
  const draft = getCreateDraft(interaction);
  if (draft) draft.dates = draft.dates.filter(date => upcomingDates().includes(date));
  const valid = draft
    && RAID_TYPES.includes(draft.raidType)
    && draft.dates.length > 0
    && START_HOURS.includes(hourOf(draft.time));
  if (!valid) return interaction.update(STALE_CREATE_MESSAGE);
  createDrafts.delete(interaction.user.id);

  await interaction.update({ content: '⏳ 募集を作成しています...', embeds: [], components: [] });

  const created = [];
  try {
    const channel = await client.channels.fetch(interaction.channelId);
    if (!channel || !channel.isTextBased()) throw new Error(`チャンネル取得失敗: ${interaction.channelId}`);
    for (const date of draft.dates) {
      const recruitment = {
        id: generateUniqueId(),
        type: draft.raidType,
        date,
        time: draft.time,
        creator: interaction.user.id,
        creatorUsername: interaction.user.username,
        participants: [],
        status: 'active',
        channel: interaction.channelId,
        guildId: interaction.guildId,
        messageId: null,
        createdAt: new Date().toISOString(),
        finalTime: null,
        finalRaidType: null,
        mentionRoleId: process.env.MENTION_ROLE_ID || null // 作成時にメンションするロール (任意)
      };
      autoAssign(recruitment);
      // まとめて作成したときは、ロールへのメンションは最初の1件だけ
      const mentionRole = recruitment.mentionRoleId && created.length === 0;
      const recruitMessage = await channel.send({
        ...buildCardMessage(recruitment),
        allowedMentions: { roles: mentionRole ? [recruitment.mentionRoleId] : [], users: [] }
      });
      recruitment.messageId = recruitMessage.id;
      activeRecruitments.set(recruitment.id, recruitment);
      created.push(recruitment);
      debugLog('RecruitmentPublish', `募集作成: ID=${recruitment.id}, MsgID=${recruitment.messageId}`);
    }
  } catch (error) {
    console.error('募集作成エラー:', error);
  }
  saveRecruitmentData();
  // ボードと同じチャンネルに募集が出たら、ボードを募集の下に貼り直す
  requestBoardUpdate(interaction.guildId, { moveToBottom: created.length > 0 && boards[interaction.guildId]?.channelId === interaction.channelId });

  if (created.length === 0) {
    return interaction.editReply({ content: '募集メッセージ作成中にエラーが発生しました。' }).catch(() => { });
  }
  const links = created.map(r => `・${headline(r)} [開く](${messageLink(interaction.guildId, r.channel, r.messageId)})`);
  const failed = draft.dates.length - created.length;
  await interaction.editReply({
    content: `✅ ${created.length > 1 ? `${created.length}件の` : ''}募集を作成しました！\n${links.join('\n')}${failed > 0 ? `\n⚠️ ${failed}件は作成できませんでした。` : ''}`
  });
}

//==========================================================================
// 募集カード
//==========================================================================

function cardComponents(recruitment) {
  const key = statusKey(recruitment);
  const id = recruitment.id;
  if (key === 'active' || key === 'provisional') {
    const rows = [row(
      button(`join_recruitment_${id}`, '参加・変更', ButtonStyle.Primary),
      button(`cancel_participation_${id}`, '参加キャンセル'),
      button(`participants_detail_${id}`, '参加者詳細')
    )];
    if (key === 'provisional') {
      rows.push(row(
        button(`proxy_register_${id}`, '代理登録'),
        button(`proxy_cancel_${id}`, '代理キャンセル')
      ));
    }
    rows.push(key === 'active'
      ? row(button(`edit_recruitment_${id}`, '募集を編集'), button(`close_recruitment_${id}`, '今すぐ仮確定', ButtonStyle.Danger))
      : row(button(`edit_slots_${id}`, '枠を編集', ButtonStyle.Primary), button(`edit_recruitment_${id}`, '募集を編集'), button(`finalize_recruitment_${id}`, '今すぐ本確定', ButtonStyle.Danger)));
    if (testMode.active) rows.push(row(button(`add_test_participants_${id}`, '🧪テスト参加者追加(管理)')));
    return rows;
  }
  if (key === 'finalized') {
    return [row(button(`cancel_participation_${id}`, '参加キャンセル'), button(`participants_detail_${id}`, '参加者詳細'))];
  }
  return [];
}

function cardFooter(recruitment) {
  const idText = `ID: ${shortId(recruitment.id)}`;
  if (!isOpen(recruitment)) return idText;
  return `${idText}｜募集の編集・確定は募集者と管理者のみ｜仮確定中の枠編集・代理登録・代理キャンセルは参加者・募集者・管理者`;
}

function buildCardMessage(recruitment) {
  const key = statusKey(recruitment);
  const embed = new EmbedBuilder()
    .setTitle(cardTitle(recruitment))
    .setDescription(cardDescription(recruitment))
    .setColor(CARD_COLORS[key] || '#95A5A6')
    .setFooter({ text: cardFooter(recruitment) });
  return {
    content: recruitment.mentionRoleId ? `<@&${recruitment.mentionRoleId}>` : '',
    embeds: [embed],
    components: cardComponents(recruitment)
  };
}

// 募集メッセージ更新処理
async function updateRecruitmentMessage(recruitment) {
  if (!recruitment || !recruitment.channel || !recruitment.messageId) {
    console.error('メッセージ更新に必要な情報が不足:', recruitment?.id);
    return;
  }
  try {
    const channel = await client.channels.fetch(recruitment.channel).catch(() => null);
    if (!channel || !channel.isTextBased()) {
      console.error(`チャンネル取得失敗: ${recruitment.channel}`);
      return;
    }
    if (!recruitment.guildId && channel.guildId) recruitment.guildId = channel.guildId;
    const message = await channel.messages.fetch(recruitment.messageId);
    await message.edit(buildCardMessage(recruitment));
  } catch (error) {
    if (error.code === 10008) {
      console.warn(`募集メッセージが見つからないため、募集データ ${recruitment.id} を削除します`);
      activeRecruitments.delete(recruitment.id);
      saveRecruitmentData();
    } else {
      console.error(`募集メッセージ ${recruitment.messageId} 更新エラー:`, error);
    }
  }
  requestBoardUpdate(recruitment.guildId);
}

//==========================================================================
// 参加申込（レイド → 属性 → 得意な属性 → 時間 → 確認。参加済みなら今の内容から変更できる）
// ボードから複数の募集を選ぶと、同じ内容でまとめて参加できる（customId の募集IDが 'bulk'）
//==========================================================================

const BULK_ID = 'bulk';
const BULK_KEY = '__bulk__'; // まとめて参加のときに属性を入れておくキー
const STALE_JOIN_MESSAGE = { content: '入力内容が見つからないか古くなっています。もう一度「参加・変更」から操作してください。', embeds: [], components: [] };
const CLOSED_JOIN_MESSAGE = { content: 'この募集は現在参加を受け付けていません。', embeds: [], components: [] };

function getJoinState(interaction, recruitmentId) {
  const state = tempUserData.get(interaction.user.id);
  if (!state) return null;
  const matches = recruitmentId === BULK_ID ? state.mode === 'bulk' : state.recruitmentId === recruitmentId;
  if (!matches) return null;
  state.updatedAt = Date.now();
  return state;
}

// 入力中の参加先（受付中の募集だけ）
function joinTargets(state) {
  const ids = state.mode === 'bulk' ? state.recruitmentIds : [state.recruitmentId];
  return ids.map(id => activeRecruitments.get(id)).filter(isOpen);
}

function displayNameOf(interaction) {
  return interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
}

// ['火','水'] + 得意['火'] → '火・水（得意: 火）'
function attrNames(attrs, prefs = []) {
  if (!attrs || attrs.length === 0) return 'なし';
  const base = ATTRIBUTES.every(a => attrs.includes(a)) ? '全属性' : ATTRIBUTES.filter(a => attrs.includes(a)).join('・');
  const preferred = ATTRIBUTES.filter(a => prefs.includes(a) && attrs.includes(a));
  return preferred.length > 0 ? `${base}（得意: ${preferred.join('・')}）` : base;
}

function keyLabel(key) {
  if (key === ANY_RAID) return 'どのレイドでも';
  if (key === BULK_KEY) return '選んだ募集すべて';
  return key;
}

// 入力の手順。属性を2つ以上選んだときだけ「得意な属性」を聞く
function joinSteps(state) {
  const steps = state.needsRaidStep ? ['raids'] : [];
  state.selectedRaids.forEach((key, index) => {
    steps.push(`attrs:${index}`);
    if ((state.attributesByRaid[key] || []).length >= 2) steps.push(`prefs:${index}`);
  });
  steps.push('time', 'confirm');
  return steps;
}

function moveStep(state, direction) {
  const steps = joinSteps(state);
  const index = steps.indexOf(state.step);
  state.step = index === -1 ? steps[0] : steps[Math.min(Math.max(index + direction, 0), steps.length - 1)];
}

function currentKey(state) {
  return state.selectedRaids[Number(state.step.split(':')[1]) || 0];
}

// 前回の参加内容を入れておく（まだ入っていない項目だけ）
function prefillFromProfile(state, userId) {
  const profile = userProfiles[userId];
  if (!profile) return;
  state.selectedRaids.forEach(key => {
    if (state.attributesByRaid[key]?.length) return;
    const attrs = profile.attributesByRaid?.[key] || profile.lastAttributes;
    if (!attrs?.length) return;
    state.attributesByRaid[key] = [...attrs];
    state.preferredByRaid[key] = (profile.preferredByRaid?.[key] || profile.lastPreferred || []).filter(a => attrs.includes(a));
    state.prefilled = true;
  });
  if (!state.timeAvailability && profile.timeAvailability) {
    state.timeAvailability = profile.timeAvailability;
    state.leaveTime = profile.leaveTime || null;
    state.prefilled = true;
  }
}

// 次の参加で使えるよう、今回の内容を覚えておく
function rememberChoice(userId, state) {
  const profile = userProfiles[userId] || {};
  profile.attributesByRaid = profile.attributesByRaid || {};
  profile.preferredByRaid = profile.preferredByRaid || {};
  state.selectedRaids.forEach(key => {
    const attrs = state.attributesByRaid[key];
    if (!attrs?.length) return;
    const prefs = (state.preferredByRaid[key] || []).filter(a => attrs.includes(a));
    if (key !== BULK_KEY) {
      profile.attributesByRaid[key] = [...attrs];
      profile.preferredByRaid[key] = prefs;
    }
    profile.lastAttributes = [...attrs];
    profile.lastPreferred = prefs;
  });
  if (state.needsRaidStep) profile.flexRaids = [...state.selectedRaids];
  profile.timeAvailability = state.timeAvailability;
  profile.leaveTime = state.leaveTime || null;
  profile.updatedAt = new Date().toISOString();
  userProfiles[userId] = profile;
  saveProfiles();
}

// 入力状態から、その募集に入れる参加者データを作る
function buildParticipantData(recruitment, state, userId, username, remarks) {
  const pick = key => {
    const attrs = [...(state.attributesByRaid[key] || [])];
    return { attrs, prefs: (state.preferredByRaid[key] || []).filter(a => attrs.includes(a)) };
  };
  let isAny = false;
  let entries;
  if (state.mode === 'bulk') {
    // まとめて参加では「参加者希望」の募集には「どれでも可」で参加する
    isAny = recruitment.type === FLEX_RAID;
    entries = isAny ? selectableRaids().map(raid => [raid, pick(BULK_KEY)]) : [[recruitment.type, pick(BULK_KEY)]];
  } else if (state.selectedRaids.includes(ANY_RAID)) {
    isAny = true;
    entries = selectableRaids().map(raid => [raid, pick(ANY_RAID)]);
  } else {
    entries = state.selectedRaids.map(raid => [raid, pick(raid)]);
  }
  let joinType = recruitment.type;
  if (recruitment.type === FLEX_RAID) joinType = isAny ? ANY_RAID : FLEX_RAID;
  return {
    userId,
    username,
    joinType,
    attributesByRaid: Object.fromEntries(entries.map(([raid, choice]) => [raid, choice.attrs])),
    preferredByRaid: Object.fromEntries(entries.filter(([, choice]) => choice.prefs.length > 0).map(([raid, choice]) => [raid, choice.prefs])),
    timeAvailability: state.timeAvailability,
    leaveTime: state.leaveTime || null,
    remarks: remarks || '',
    assignedAttribute: null,
    isTestParticipant: false
  };
}

// まとめて参加で備考を入力しなかった場合、参加済みの募集の備考はそのまま
function remarksFor(state, existing) {
  if (state.mode !== 'bulk' || state.remarksTouched) return state.remarks;
  return existing?.remarks || '';
}

// 参加者を追加・更新して割り振りを計算し直す
function applyParticipation(recruitment, data) {
  const index = recruitment.participants.findIndex(p => p.userId === data.userId);
  const previous = index >= 0 ? recruitment.participants[index] : null;
  const entry = { ...data, assignedAttribute: previous?.assignedAttribute || null };
  if (recruitment.status !== 'active' && entry.assignedAttribute) {
    // 自分で申告から外した属性の枠にいた場合や、時間が今の開始時間に合わなくなった場合は外す
    // （話し合いで申告外の枠に入った場合はそのまま。開始時間は動かさない）
    const raid = recruitment.finalRaidType || recruitment.type;
    const removedFromDeclaration = attributesFor(previous, raid).includes(entry.assignedAttribute) && !attributesFor(entry, raid).includes(entry.assignedAttribute);
    if (removedFromDeclaration || !fitsStart(recruitment, entry)) entry.assignedAttribute = null;
  }
  if (index >= 0) recruitment.participants[index] = entry;
  else recruitment.participants.push(entry);

  // 参加者0人のまま仮確定した「参加者希望」は、最初の参加者が来た時点で実施レイドを決める
  if (recruitment.status === 'active' || (recruitment.type === FLEX_RAID && !recruitment.finalRaidType)) autoAssign(recruitment);
  else fillEmptySlots(recruitment);
  return recruitment.participants.find(p => p.userId === data.userId);
}

// 割り振り上の今の位置を説明する
function placementText(recruitment, participant, prospective) {
  const tentative = recruitment.status === 'active';
  if (participant.assignedAttribute) {
    return `${ATTRIBUTE_EMOJI[participant.assignedAttribute]}【${participant.assignedAttribute}】${tentative ? '（仮）' : ''}${prospective ? 'に入る見込みです' : 'に入っています'}`;
  }
  const suffix = prospective ? 'になる見込みです' : 'です';
  if (attributesFor(participant, recruitment.finalRaidType).length === 0) {
    return `実施レイドが${recruitment.finalRaidType || '未定'}のため、今回は対象外${suffix}`;
  }
  const reason = reserveReason(recruitment, participant);
  return `${reason ? `${reason}、` : '今のところ'}補欠${suffix}`;
}

// 確認画面の「割り振りの見込み」（実際に入れた場合を試算する）
function joinPreviewLines(state, interaction) {
  const subjectId = state.proxyFor?.userId || interaction.user.id;
  const subjectName = state.proxyFor?.username || displayNameOf(interaction);
  return joinTargets(state).map(recruitment => {
    const simulated = JSON.parse(JSON.stringify(recruitment));
    const existing = simulated.participants.find(p => p.userId === subjectId);
    const data = buildParticipantData(simulated, state, subjectId, subjectName, remarksFor(state, existing));
    const text = placementText(simulated, applyParticipation(simulated, data), true);
    return state.mode === 'bulk' ? `・${formatDateShort(recruitment.date)} ${raidLabel(recruitment)}：${text}` : text;
  });
}

function joinStepPayload(state, interaction) {
  const targets = joinTargets(state);
  const id = state.mode === 'bulk' ? BULK_ID : state.recruitmentId;
  const single = state.mode === 'bulk' ? null : targets[0];
  const embed = new EmbedBuilder()
    .setTitle(state.proxyFor ? '🤝 代理登録' : (single ? (state.isEdit ? '✏️ 参加内容の変更' : '🎮 参加申込') : `🎮 まとめて参加（${targets.length}件）`))
    .setColor(state.proxyFor ? CARD_COLORS.provisional : '#2ECC71');
  const summary = single ? headline(single) : targets.map(r => `・${headline(r)}`).join('\n');
  const prefilledNote = state.prefilled && !state.isEdit
    ? (state.proxyFor
      ? `\n（${state.proxyFor.username}さんの前回の内容を入れてあります。そのままでよければ「このまま次へ」）`
      : '\n（前回の内容を入れてあります。そのままでよければ「このまま次へ」）')
    : '';
  const nextButton = button(`join_next_${id}`, 'このまま次へ ▶', ButtonStyle.Primary);
  const components = [];
  const navButtons = [];
  if (joinSteps(state).indexOf(state.step) > 0) navButtons.push(backButton(`join_back_${id}`));
  const stepName = state.step.split(':')[0];
  const key = currentKey(state);

  if (stepName === 'raids') {
    embed.setDescription(`${summary}\n\n参加したいレイドを**すべて**選んでください。\n「どれでも可」を選ぶと、ほかの選択に関係なくどのレイドでも参加する扱いになります。${prefilledNote}`);
    const options = selectableRaids().map(raid => ({ label: raid, value: raid, default: state.selectedRaids.includes(raid) }));
    options.push({ label: 'どれでも可', value: ANY_RAID, default: state.selectedRaids.includes(ANY_RAID) });
    components.push(row(selectMenu(`join_type_${id}`, '参加したいレイドを選択 (複数可)', options, 1, options.length)));
    if (state.selectedRaids.length > 0) navButtons.push(nextButton);
  } else if (stepName === 'attrs') {
    const total = state.selectedRaids.length;
    const index = state.selectedRaids.indexOf(key);
    embed.setDescription(`${summary}\n\n${total > 1 ? `【${index + 1}/${total}】` : ''}**${keyLabel(key)}** で担当できる属性をすべて選んでください。${prefilledNote}`);
    const current = state.attributesByRaid[key] || [];
    const all = ATTRIBUTES.every(a => current.includes(a));
    const options = [
      { label: '全属性', value: 'all_attributes', description: 'すべての属性で参加できます', default: all },
      ...ATTRIBUTES.map(attr => ({ label: `${ATTRIBUTE_EMOJI[attr]} ${attr}`, value: attr, default: !all && current.includes(attr) }))
    ];
    components.push(row(selectMenu(`attribute_select_per_raid_${id}`, '担当できる属性を選択 (複数可)', options, 1, options.length)));
    if (current.length > 0) navButtons.push(nextButton);
  } else if (stepName === 'prefs') {
    const attrs = state.attributesByRaid[key] || [];
    const prefs = state.preferredByRaid[key] || [];
    embed.setDescription(`${summary}\n\n**${keyLabel(key)}** で特に得意な属性（◎）があれば選んでください。割り振りで優先して入れます。\nなければ「特になし」のまま次へ進んでください。`);
    const options = [
      { label: '特になし', value: 'none', default: prefs.length === 0 },
      ...ATTRIBUTES.filter(a => attrs.includes(a)).map(attr => ({ label: `◎ ${ATTRIBUTE_EMOJI[attr]} ${attr}`, value: attr, default: prefs.includes(attr) }))
    ];
    components.push(row(selectMenu(`join_pref_select_${id}`, '得意な属性を選択 (複数可・任意)', options, 1, options.length)));
    navButtons.push(nextButton);
  } else if (stepName === 'time') {
    embed.setDescription(`${summary}\n\n参加できる一番早い時間を選んでください。${single ? `（募集開始: ${single.time}）` : ''}${prefilledNote}\n早めに抜ける場合は、次の確認画面で選べます。`);
    const options = [
      { label: '今すぐ参加可能', value: 'now', description: '募集開始時刻から参加できます', default: state.timeAvailability === 'now' },
      ...START_HOURS.map(hour => ({ label: `${formatHour(hour)} 以降参加可能`, value: formatHour(hour), default: state.timeAvailability === formatHour(hour) }))
    ];
    components.push(row(selectMenu(`time_availability_select_${id}`, '参加できる一番早い時間を選択', options)));
    if (state.timeAvailability) navButtons.push(nextButton);
  } else {
    const selection = state.selectedRaids
      .map(k => `${state.selectedRaids.length > 1 || k === ANY_RAID ? `${keyLabel(k)}：` : ''}${attrNames(state.attributesByRaid[k], state.preferredByRaid[k])}`)
      .join('\n');
    const joinedSome = state.mode === 'bulk' && targets.some(r => r.participants.some(p => p.userId === interaction.user.id));
    const remarksText = state.mode === 'bulk' && !state.remarksTouched ? 'なし（参加済みの募集は今の備考のまま）' : (state.remarks || 'なし');
    const note = targets.some(r => r.status === 'active') ? '\n（ほかの人の参加・キャンセルで変わることがあります）' : '';
    const verb = state.proxyFor ? `${state.proxyFor.username}さんを登録します` : (state.isEdit ? '変更します' : '申し込みます');
    embed.setDescription(`${summary}\n\nこの内容で${verb}。よろしければ確定してください。${joinedSome ? '\n参加済みの募集は、この内容に変更されます。' : ''}`)
      .addFields(
        { name: '担当できる属性', value: truncate(selection, 1024), inline: false },
        { name: '参加できる時間', value: timeLabel(state.timeAvailability, state.leaveTime), inline: true },
        { name: '備考', value: remarksText, inline: true },
        { name: '割り振りの見込み', value: truncate(joinPreviewLines(state, interaction).join('\n') + note, 1024), inline: false }
      );
    const fromHour = hourOf(state.timeAvailability);
    const leaveOptions = [
      { label: '最後まで参加できる', value: 'end', default: !state.leaveTime },
      ...LEAVE_HOURS.filter(hour => hour > fromHour).map(hour => ({ label: `${formatHour(hour)} に抜ける`, value: formatHour(hour), default: state.leaveTime === formatHour(hour) }))
    ];
    components.push(row(selectMenu(`join_leave_${id}`, '早めに抜ける場合は時間を選択', leaveOptions)));
    const hasRemarks = state.mode === 'bulk' ? state.remarksTouched && state.remarks : state.remarks;
    navButtons.push(
      button(`confirm_direct_${id}`, hasRemarks || state.mode === 'bulk' ? '確定' : '確定（備考なし）', ButtonStyle.Success),
      button(`open_remarks_modal_${id}`, hasRemarks ? '📝 備考を変えて確定' : '📝 備考を書いて確定', ButtonStyle.Primary)
    );
  }

  if (state.proxyFor && embed.data.description) {
    embed.setDescription(`🤝 **${state.proxyFor.username}** さんの代理登録です。\n${embed.data.description}`);
  }

  navButtons.push(cancelButton('cancel_join'));
  components.push(row(...navButtons));
  return { content: '', embeds: [embed], components };
}

// 参加オプション表示（参加済みの人は今の内容を、初めての人は前回の内容を入れて始める）
async function showJoinOptions(interaction, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || !isOpen(recruitment)) return interaction.reply({ ...CLOSED_JOIN_MESSAGE, flags: EPHEMERAL });

  const existing = recruitment.participants.find(p => p.userId === interaction.user.id);
  const state = {
    mode: 'single',
    recruitmentId,
    isEdit: Boolean(existing),
    needsRaidStep: recruitment.type === FLEX_RAID,
    step: '',
    selectedRaids: [],
    attributesByRaid: {},
    preferredByRaid: {},
    timeAvailability: existing?.timeAvailability || null,
    leaveTime: existing?.leaveTime || null,
    remarks: existing?.remarks || '',
    prefilled: false,
    updatedAt: Date.now()
  };
  const copyFromExisting = (key, raid) => {
    state.attributesByRaid[key] = attributesFor(existing, raid);
    state.preferredByRaid[key] = preferredFor(existing, raid);
  };
  if (recruitment.type !== FLEX_RAID) {
    state.selectedRaids = [recruitment.type];
    if (existing) copyFromExisting(recruitment.type, recruitment.type);
  } else if (existing?.joinType === ANY_RAID) {
    state.selectedRaids = [ANY_RAID];
    copyFromExisting(ANY_RAID, Object.keys(existing.attributesByRaid || {})[0]);
  } else if (existing) {
    state.selectedRaids = Object.keys(existing.attributesByRaid || {}).filter(raid => selectableRaids().includes(raid));
    state.selectedRaids.forEach(raid => copyFromExisting(raid, raid));
  } else {
    const remembered = userProfiles[interaction.user.id]?.flexRaids || [];
    state.selectedRaids = remembered.includes(ANY_RAID) ? [ANY_RAID] : remembered.filter(raid => selectableRaids().includes(raid));
    if (state.selectedRaids.length > 0) state.prefilled = true;
  }
  if (!existing) prefillFromProfile(state, interaction.user.id);
  state.step = joinSteps(state)[0];
  tempUserData.set(interaction.user.id, state);
  await interaction.reply({ ...joinStepPayload(state, interaction), flags: EPHEMERAL });
}

// まとめて参加（ボードで複数の募集を選んだとき）
async function showBulkJoin(interaction, recruitmentIds) {
  const targets = recruitmentIds.map(id => activeRecruitments.get(id)).filter(isOpen);
  if (targets.length === 0) return interaction.reply({ ...CLOSED_JOIN_MESSAGE, flags: EPHEMERAL });
  if (targets.length === 1) return showJoinOptions(interaction, targets[0].id);

  const state = {
    mode: 'bulk',
    recruitmentIds: targets.map(r => r.id),
    isEdit: false,
    needsRaidStep: false,
    step: 'attrs:0',
    selectedRaids: [BULK_KEY],
    attributesByRaid: {},
    preferredByRaid: {},
    timeAvailability: null,
    leaveTime: null,
    remarks: '',
    remarksTouched: false,
    prefilled: false,
    updatedAt: Date.now()
  };
  prefillFromProfile(state, interaction.user.id);
  tempUserData.set(interaction.user.id, state);
  await interaction.reply({ ...joinStepPayload(state, interaction), flags: EPHEMERAL });
}

async function updateJoinStep(interaction, recruitmentId) {
  const state = getJoinState(interaction, recruitmentId);
  if (!state) return interaction.update(STALE_JOIN_MESSAGE);
  if (joinTargets(state).length === 0) return interaction.update(CLOSED_JOIN_MESSAGE);
  return interaction.update(joinStepPayload(state, interaction));
}

// 「このまま次へ」(direction=1) と「戻る」(direction=-1)
async function moveJoinStep(interaction, recruitmentId, direction) {
  const state = getJoinState(interaction, recruitmentId);
  if (state) moveStep(state, direction);
  return updateJoinStep(interaction, recruitmentId);
}

async function selectJoinRaids(interaction, recruitmentId, values) {
  const state = getJoinState(interaction, recruitmentId);
  if (state) {
    state.selectedRaids = values.includes(ANY_RAID) ? [ANY_RAID] : selectableRaids().filter(raid => values.includes(raid));
    prefillFromProfile(state, interaction.user.id);
    state.step = 'raids';
    moveStep(state, 1);
  }
  return updateJoinStep(interaction, recruitmentId);
}

async function selectJoinAttributes(interaction, recruitmentId, values) {
  const state = getJoinState(interaction, recruitmentId);
  if (state) {
    const key = currentKey(state);
    const attrs = values.includes('all_attributes') ? [...ATTRIBUTES] : ATTRIBUTES.filter(a => values.includes(a));
    state.attributesByRaid[key] = attrs;
    state.preferredByRaid[key] = (state.preferredByRaid[key] || []).filter(a => attrs.includes(a));
    moveStep(state, 1);
  }
  return updateJoinStep(interaction, recruitmentId);
}

async function selectJoinPreferences(interaction, recruitmentId, values) {
  const state = getJoinState(interaction, recruitmentId);
  if (state) {
    const key = currentKey(state);
    const attrs = state.attributesByRaid[key] || [];
    state.preferredByRaid[key] = ATTRIBUTES.filter(a => values.includes(a) && attrs.includes(a));
    moveStep(state, 1);
  }
  return updateJoinStep(interaction, recruitmentId);
}

async function selectJoinTime(interaction, recruitmentId, value) {
  const state = getJoinState(interaction, recruitmentId);
  if (state) {
    state.timeAvailability = value;
    if (state.leaveTime && hourOf(state.leaveTime) <= hourOf(value)) state.leaveTime = null;
    state.step = 'confirm';
  }
  return updateJoinStep(interaction, recruitmentId);
}

async function selectJoinLeave(interaction, recruitmentId, value) {
  const state = getJoinState(interaction, recruitmentId);
  if (state) state.leaveTime = value === 'end' ? null : value;
  return updateJoinStep(interaction, recruitmentId);
}

// 備考入力モーダル表示関数
async function showRemarksModal(interaction, recruitmentId) {
  const state = getJoinState(interaction, recruitmentId);
  if (!state) return interaction.update(STALE_JOIN_MESSAGE);

  const remarksInput = new TextInputBuilder()
    .setCustomId('remarks_input')
    .setLabel(`希望/遅刻/早退など (${MAX_REMARKS_LENGTH}文字以内)`)
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('例: 22時まで。初心者です。25文字まで。')
    .setMaxLength(MAX_REMARKS_LENGTH)
    .setRequired(false);
  if (state.remarks) remarksInput.setValue(state.remarks);

  const modal = new ModalBuilder()
    .setCustomId(`submit_remarks_${recruitmentId}`)
    .setTitle(state.mode === 'bulk' ? '参加に関する備考 (選んだ募集すべてに入ります)' : '参加に関する備考 (任意)')
    .addComponents(row(remarksInput));
  await interaction.showModal(modal);
}

// 参加確定（呼び出し前に deferUpdate 済みであること）
async function commitJoin(interaction, recruitmentId) {
  const state = getJoinState(interaction, recruitmentId);
  if (!state || !state.timeAvailability) return interaction.editReply(STALE_JOIN_MESSAGE);
  if (state.proxyFor) {
    const recruitment = activeRecruitments.get(state.recruitmentId);
    const reason = proxyBlockReason(interaction, recruitment);
    if (reason) return interaction.editReply({ content: reason, embeds: [], components: [] });
    if (recruitment.participants.some(p => p.userId === state.proxyFor.userId)) {
      return interaction.editReply({ content: 'その人は既にこの募集に参加しています。属性や時間の変更は、本人の「参加・変更」から行えます。', embeds: [], components: [] });
    }
  }
  const targets = joinTargets(state);
  if (targets.length === 0) return interaction.editReply(CLOSED_JOIN_MESSAGE);

  const subjectId = state.proxyFor?.userId || interaction.user.id;
  let username = state.proxyFor?.username;
  if (!username) {
    let member = interaction.member;
    if (!member?.displayName) member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    username = member?.displayName || interaction.user.username;
  }

  const results = targets.map(recruitment => {
    const existing = recruitment.participants.find(p => p.userId === subjectId);
    const me = applyParticipation(recruitment, buildParticipantData(recruitment, state, subjectId, username, remarksFor(state, existing)));
    return { recruitment, me, wasJoined: Boolean(existing) };
  });
  tempUserData.delete(interaction.user.id);
  if (!state.proxyFor) rememberChoice(interaction.user.id, state);
  saveRecruitmentData();
  debugLog('ConfirmParticipation', `${username} → ${results.map(({ recruitment, wasJoined }) => `${recruitment.id}${wasJoined ? '(変更)' : ''}`).join(', ')}`);

  let content;
  if (state.proxyFor) {
    const { recruitment, me } = results[0];
    content = `✅ ${username}さんを代理登録しました。\n${placementText(recruitment, me, false)}`;
  } else if (state.mode === 'bulk') {
    const lines = results.map(({ recruitment, me }) => `・${formatDateShort(recruitment.date)} ${raidLabel(recruitment)}：${placementText(recruitment, me, false)}`);
    const skipped = state.recruitmentIds.length - targets.length;
    content = `✅ ${results.length}件の募集に参加しました！\n${lines.join('\n')}${skipped > 0 ? `\n⚠️ ${skipped}件は受付が終わっていたため参加していません。` : ''}`;
  } else {
    const { recruitment, me, wasJoined } = results[0];
    content = `${wasJoined ? '✅ 参加内容を変更しました！' : '✅ 参加を受け付けました！'}\n${placementText(recruitment, me, false)}`;
  }
  await interaction.editReply({ content: truncate(content, 2000), embeds: [], components: [] });
  for (const { recruitment } of results) {
    await updateRecruitmentMessage(recruitment);
    await addToThread(recruitment, subjectId);
    if (state.proxyFor) await announceProxy(recruitment, interaction, state.proxyFor, 'register');
  }
}

//==========================================================================
// 参加キャンセル（仮確定・本確定後は補欠が自動で繰り上がる）
//==========================================================================

async function askCancelParticipation(interaction, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || !(isOpen(recruitment) || isFinalized(recruitment))) {
    return interaction.reply({ content: 'この募集は既に終了しているか、存在しません。', flags: EPHEMERAL });
  }
  const me = recruitment.participants.find(p => p.userId === interaction.user.id);
  if (!me) return interaction.reply({ content: 'あなたはこの募集に参加していません。', flags: EPHEMERAL });
  if (Date.now() >= startAtMs(recruitment)) {
    return interaction.reply({ content: '開始時間を過ぎているため、キャンセルできません。', flags: EPHEMERAL });
  }

  let note = '';
  if (recruitment.status !== 'active' && me.assignedAttribute) {
    note = `\nあなたの枠（${ATTRIBUTE_EMOJI[me.assignedAttribute]}【${me.assignedAttribute}】）は空きになり、入れる補欠の人がいれば繰り上がります。`;
  }
  return interaction.reply({
    content: `${headline(recruitment)} への参加をキャンセルしますか？${note}`,
    components: [row(button(`confirm_cancel_participation_${recruitmentId}`, 'キャンセルする', ButtonStyle.Danger), button('dismiss', 'やめる'))],
    flags: EPHEMERAL
  });
}

async function cancelParticipation(interaction, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || !(isOpen(recruitment) || isFinalized(recruitment))) {
    return interaction.update({ content: 'この募集は既に終了しているか、存在しません。', components: [] });
  }
  const index = recruitment.participants.findIndex(p => p.userId === interaction.user.id);
  if (index === -1) return interaction.update({ content: 'あなたはこの募集に参加していません。', components: [] });
  if (Date.now() >= startAtMs(recruitment)) return interaction.update({ content: '開始時間を過ぎているため、キャンセルできません。', components: [] });

  await interaction.deferUpdate();
  const [removed] = recruitment.participants.splice(index, 1);
  let promoted = [];
  if (recruitment.status === 'active') autoAssign(recruitment);
  else if (removed.assignedAttribute) promoted = fillEmptySlots(recruitment);
  saveRecruitmentData();
  debugLog('CancelParticipation', `参加キャンセル: ${removed.username} (${recruitmentId}), 残り: ${recruitment.participants.length}`);

  await interaction.editReply({ content: '参加をキャンセルしました。', components: [] });
  await updateRecruitmentMessage(recruitment);

  // 本確定後のキャンセルはお知らせする
  if (isFinalized(recruitment) && removed.assignedAttribute) {
    if (promoted.length > 0) {
      const promotedText = promoted.map(p => `${who(p)} さんが${ATTRIBUTE_EMOJI[p.assignedAttribute]}【${p.assignedAttribute}】`).join('、');
      await postNotice(recruitment, `📣 ${promotedText}に繰り上がりました（${who(removed)} さんが参加キャンセル）`, realUserIds(promoted));
    } else {
      await postNotice(recruitment, `⚠️ ${who(removed)} さんが参加キャンセルしたため、${ATTRIBUTE_EMOJI[removed.assignedAttribute]}【${removed.assignedAttribute}】が空きになりました（募集者: <@${recruitment.creator}>）`, [recruitment.creator]);
    }
  }
}

//==========================================================================
// 代理登録・代理キャンセル（仮確定中だけ。参加者・募集者・管理者）
// 参加済みの人の属性・時間は変えない。登録時に一度だけ入力する。
//==========================================================================

function proxyBlockReason(interaction, recruitment) {
  if (!recruitment) return 'この募集は存在しないか削除されました。';
  if (recruitment.status !== 'provisional') return '代理登録・代理キャンセルは仮確定中（当日8:00〜本確定まで）のみできます。';
  if (!canProxy(interaction, recruitment)) return 'この募集の参加者・募集者・管理者のみ操作できます。';
  if (Date.now() >= startAtMs(recruitment)) return '開始時間を過ぎているため、操作できません。';
  return null;
}

function readDisplayName(entity) {
  if (!entity) return null;
  return entity.displayName || entity.nick || entity.globalName || entity.username || entity.user?.globalName || entity.user?.username || null;
}

async function resolveProxyTarget(interaction, userId) {
  const member = interaction.members?.get?.(userId) || null;
  const user = member?.user || interaction.users?.get?.(userId) || null;
  if (user?.bot || member?.user?.bot) return { error: 'ボットは登録できません。' };
  let username = readDisplayName(member) || readDisplayName(user);
  if (!username) {
    const fetched = await interaction.guild?.members?.fetch?.(userId).catch(() => null);
    const fetchedId = fetched?.id || fetched?.user?.id;
    if (fetched && fetchedId === userId) {
      if (fetched.user?.bot) return { error: 'ボットは登録できません。' };
      username = readDisplayName(fetched);
    }
  }
  return { userId, username: username || 'メンバー' };
}

// まだ参加していない人向けの入力状態（代理登録で使う。本人の参加画面とは分けておく）
function newJoinState(recruitment, subjectUserId) {
  const state = {
    mode: 'single',
    recruitmentId: recruitment.id,
    isEdit: false,
    needsRaidStep: recruitment.type === FLEX_RAID,
    step: '',
    selectedRaids: [],
    attributesByRaid: {},
    preferredByRaid: {},
    timeAvailability: null,
    leaveTime: null,
    remarks: '',
    prefilled: false,
    updatedAt: Date.now()
  };
  if (recruitment.type !== FLEX_RAID) {
    state.selectedRaids = [recruitment.type];
  } else {
    const remembered = userProfiles[subjectUserId]?.flexRaids || [];
    state.selectedRaids = remembered.includes(ANY_RAID) ? [ANY_RAID] : remembered.filter(raid => selectableRaids().includes(raid));
    if (state.selectedRaids.length > 0) state.prefilled = true;
  }
  prefillFromProfile(state, subjectUserId);
  state.step = joinSteps(state)[0];
  return state;
}

async function announceProxy(recruitment, interaction, target, kind) {
  const actorName = displayNameOf(interaction);
  const registered = kind === 'register';
  const sentence = registered
    ? `${actorName}さんがあなたを登録しました`
    : `${actorName}さんがあなたの参加をキャンセルしました`;
  const targetId = target.userId;
  const ping = /^\d+$/.test(String(targetId)) ? [targetId] : [];
  const notice = ping.length ? `<@${targetId}> ${sentence}` : `${target.username}さん、${sentence}`;
  const log = registered
    ? `<@${interaction.user.id}> さんが ${who(target)} さんを代理登録しました`
    : `<@${interaction.user.id}> さんが ${who(target)} さんの参加をキャンセルしました`;
  await postNotice(recruitment, notice, ping);
  await postNotice(recruitment, log, []);
}

async function showProxyRegister(interaction, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  const reason = proxyBlockReason(interaction, recruitment);
  if (reason) return interaction.reply({ content: reason, flags: EPHEMERAL });
  const embed = new EmbedBuilder()
    .setTitle('🤝 代理登録')
    .setDescription(`${headline(recruitment)}\n\n登録するメンバーを選んでください。\n選んだあと、その人の属性と参加時間を入力します。\n登録すると相手にメンションし、調整スレッドにも残します。`)
    .setColor(CARD_COLORS.provisional);
  return interaction.reply({
    embeds: [embed],
    components: [
      row(userSelect(`proxy_register_pick_${recruitmentId}`, '登録するメンバーを選択')),
      row(closeButton())
    ],
    flags: EPHEMERAL
  });
}

async function beginProxyRegister(interaction, recruitmentId, targetId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  const reason = proxyBlockReason(interaction, recruitment);
  if (reason) return interaction.update({ content: reason, embeds: [], components: [] });
  if (!targetId) return interaction.update({ content: '登録するメンバーを選んでください。', embeds: [], components: [] });
  if (targetId === interaction.user.id) {
    return interaction.update({ content: '自分の参加は「参加・変更」から行ってください。', embeds: [], components: [] });
  }
  if (recruitment.participants.some(p => p.userId === targetId)) {
    return interaction.update({ content: 'その人は既にこの募集に参加しています。属性や時間の変更は、本人の「参加・変更」から行えます。', embeds: [], components: [] });
  }
  const resolved = await resolveProxyTarget(interaction, targetId);
  if (resolved.error) return interaction.update({ content: resolved.error, embeds: [], components: [] });

  const state = newJoinState(recruitment, resolved.userId);
  state.proxyFor = { userId: resolved.userId, username: resolved.username };
  tempUserData.set(interaction.user.id, state);
  return interaction.update(joinStepPayload(state, interaction));
}

async function showProxyCancel(interaction, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  const reason = proxyBlockReason(interaction, recruitment);
  if (reason) return interaction.reply({ content: reason, flags: EPHEMERAL });
  const others = recruitment.participants.filter(p => p.userId !== interaction.user.id);
  if (others.length === 0) {
    return interaction.reply({ content: 'キャンセルできる他の参加者がいません。', flags: EPHEMERAL });
  }
  const raid = recruitment.finalRaidType || recruitment.type;
  const options = others.slice(0, 25).map(p => {
    let place = '補欠';
    if (p.assignedAttribute) place = `${ATTRIBUTE_EMOJI[p.assignedAttribute]}【${p.assignedAttribute}】`;
    else if (attributesFor(p, raid).length === 0) place = '対象外';
    return {
      label: truncate(p.username || p.userId, 100),
      value: p.userId,
      description: truncate(place, 100)
    };
  });
  const extra = others.length > 25 ? '\n（先頭25人まで表示しています）' : '';
  const embed = new EmbedBuilder()
    .setTitle('🚫 代理キャンセル')
    .setDescription(`${headline(recruitment)}\n\n参加をキャンセルする人を選んでください。\nキャンセルすると相手にメンションし、調整スレッドにも残します。${extra}`)
    .setColor(CARD_COLORS.provisional);
  return interaction.reply({
    embeds: [embed],
    components: [
      row(selectMenu(`proxy_cancel_pick_${recruitmentId}`, 'キャンセルする参加者を選択', options)),
      row(closeButton())
    ],
    flags: EPHEMERAL
  });
}

async function askProxyCancel(interaction, recruitmentId, targetId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  const reason = proxyBlockReason(interaction, recruitment);
  if (reason) return interaction.update({ content: reason, embeds: [], components: [] });
  if (targetId === interaction.user.id) {
    return interaction.update({ content: '自分のキャンセルは「参加キャンセル」から行ってください。', embeds: [], components: [] });
  }
  const target = recruitment.participants.find(p => p.userId === targetId);
  if (!target) return interaction.update({ content: 'その人はこの募集に参加していません。', embeds: [], components: [] });

  let note = '';
  if (target.assignedAttribute) {
    note = `\n${ATTRIBUTE_EMOJI[target.assignedAttribute]}【${target.assignedAttribute}】は空きになり、入れる補欠の人がいれば繰り上がります。`;
  }
  const embed = new EmbedBuilder()
    .setTitle('🚫 代理キャンセルの確認')
    .setDescription(`${headline(recruitment)}\n\n**${target.username}** さんの参加をキャンセルしますか？${note}\nキャンセルされた人は、あとから「参加・変更」で自分で参加し直せます。`)
    .setColor('#E74C3C');
  return interaction.update({
    content: '',
    embeds: [embed],
    components: [row(
      button(`proxy_cancel_do_${recruitmentId}_${targetId}`, 'キャンセルする', ButtonStyle.Danger),
      button('dismiss', 'やめる')
    )]
  });
}

async function executeProxyCancel(interaction, recruitmentId, targetId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  const reason = proxyBlockReason(interaction, recruitment);
  if (reason) return interaction.update({ content: reason, embeds: [], components: [] });
  if (targetId === interaction.user.id) {
    return interaction.update({ content: '自分のキャンセルは「参加キャンセル」から行ってください。', embeds: [], components: [] });
  }
  const index = recruitment.participants.findIndex(p => p.userId === targetId);
  if (index === -1) return interaction.update({ content: 'その人はこの募集に参加していません。', embeds: [], components: [] });

  await interaction.deferUpdate();
  const [removed] = recruitment.participants.splice(index, 1);
  if (removed.assignedAttribute) fillEmptySlots(recruitment);
  saveRecruitmentData();
  debugLog('ProxyCancel', `${displayNameOf(interaction)} が ${removed.username} をキャンセル (${recruitmentId})`);

  await interaction.editReply({ content: `✅ ${removed.username}さんの参加をキャンセルしました。`, embeds: [], components: [] });
  await updateRecruitmentMessage(recruitment);
  await announceProxy(recruitment, interaction, removed, 'cancel');
}

//==========================================================================
// 参加者一覧
//==========================================================================

function buildParticipantsEmbed(recruitment) {
  const embed = new EmbedBuilder()
    .setTitle('📋 参加者一覧')
    .setDescription(`${headline(recruitment)}\n募集者: <@${recruitment.creator}>\n参加者数: ${recruitment.participants.length}名`)
    .setColor('#2ECC71')
    .setFooter({ text: `ID: ${shortId(recruitment.id)}` });

  if (recruitment.participants.length === 0) {
    embed.addFields({ name: '​', value: '現在参加希望はありません。' });
    return embed;
  }

  // Discordのフィールド値制限(1024文字)を考慮して分割
  const chunks = [];
  let current = '';
  participantDetailLines(recruitment).forEach(line => {
    if (current && (current + line + '\n').length > 1024) {
      chunks.push(current);
      current = '';
    }
    current += truncate(line, 1000) + '\n';
  });
  if (current) chunks.push(current);
  chunks.slice(0, 24).forEach((chunk, index) => {
    embed.addFields({ name: index === 0 ? '━━━━━━━━━━━━━━━━' : '​', value: chunk });
  });
  return embed;
}

async function showParticipantDetail(interaction, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) return interaction.reply({ content: 'この募集は存在しないか削除されました。', flags: EPHEMERAL });
  return interaction.reply({ embeds: [buildParticipantsEmbed(recruitment)], flags: EPHEMERAL });
}

// 参加者確認用: 募集選択UI表示
async function showRecruitmentSelectionForParticipants(source) {
  const list = boardRecruitments(source.guildId);
  if (list.length === 0) return respond(source, { content: '現在募集がありません。' });

  const options = list.slice(0, 25).map(r => ({
    label: truncate(`${formatDateShort(r.date)} ${effectiveStartTime(r)}〜 ${raidLabel(r)} (${r.participants.length}名)`, 100),
    value: r.id,
    description: truncate(`募集者: ${r.creatorUsername || 'Unknown'}`, 100)
  }));
  const embed = new EmbedBuilder()
    .setTitle('🔍 参加者を確認したい募集を選択してください')
    .setDescription(`下のメニューから募集を選んでください。\n現在の募集: ${list.length}件`)
    .setColor('#3498DB');
  return respond(source, { embeds: [embed], components: [row(selectMenu('select_recruitment_for_participants_', '確認したい募集を選択してください', options))] });
}

// 参加者確認用: 選択された募集の参加者リスト表示
async function showParticipantsList(interaction, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) return interaction.update({ content: 'この募集は存在しないか削除されました。', embeds: [], components: [] });
  return interaction.update({ embeds: [buildParticipantsEmbed(recruitment)], components: [] });
}

//==========================================================================
// 仮確定・本確定
//==========================================================================

// 仮確定: 割り振りを固定してお知らせ（メンションなし）。本確定までは「枠を編集」で入れ替えできる
async function toProvisional(recruitment) {
  autoAssign(recruitment);
  recruitment.status = 'provisional';
  recruitment.lastEditedBy = null;
  saveRecruitmentData();
  debugLog('Schedule', `仮確定: ${recruitment.id}`);
  await createThread(recruitment);
  await updateRecruitmentMessage(recruitment);
  const notice = await postNotice(recruitment, provisionalNotice(recruitment));
  if (notice) {
    recruitment.provisionalNoticeId = notice.id;
    saveRecruitmentData();
  }
}

// 本確定: 割り振られた人にメンション。仮確定のお知らせは消して置き換える
async function toFinalized(recruitment) {
  if (recruitment.status === 'active') autoAssign(recruitment);
  recruitment.status = 'finalized';
  saveRecruitmentData();
  debugLog('Schedule', `本確定: ${recruitment.id}`);
  await updateRecruitmentMessage(recruitment);
  // 仮確定のお知らせは、チャンネルに出していた場合だけ消す（スレッド内は経緯として残す）
  if (!recruitment.threadId) await deleteMessage(recruitment.channel, recruitment.provisionalNoticeId);
  recruitment.provisionalNoticeId = null;
  const assigned = recruitment.participants.filter(p => p.assignedAttribute);
  const notice = await postNotice(recruitment, finalNotice(recruitment), realUserIds(assigned));
  if (notice) recruitment.finalNoticeId = notice.id;
  saveRecruitmentData();
}

// 1分ごとに、当日8:00の仮確定と開始1時間前の本確定を行う
let scheduleRunning = false;
async function checkSchedules() {
  if (scheduleRunning) return;
  scheduleRunning = true;
  try {
    const now = Date.now();
    for (const recruitment of Array.from(activeRecruitments.values())) {
      if (!recruitment || typeof recruitment.date !== 'string') continue;
      try {
        if (recruitment.status === 'active' && now >= provisionalAtMs(recruitment)) await toProvisional(recruitment);
        if (recruitment.status === 'provisional' && now >= finalizeAtMs(recruitment)) await toFinalized(recruitment);
      } catch (error) {
        console.error(`[Schedule] 募集ID ${recruitment.id} 処理中にエラー:`, error);
      }
    }
  } finally {
    scheduleRunning = false;
  }
}

async function askAdvance(interaction, recruitmentId, kind) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) return interaction.reply({ content: 'この募集は存在しないか削除されました。', flags: EPHEMERAL });
  if (!canManage(interaction, recruitment)) return interaction.reply({ content: '募集者または管理者のみ操作できます。', flags: EPHEMERAL });

  if (kind === 'provisional') {
    if (recruitment.status !== 'active') return interaction.reply({ content: 'この募集は既に仮確定済みです。', flags: EPHEMERAL });
    return interaction.reply({
      content: '今すぐ仮確定しますか？\n今の割り振りで固定し、本確定（開始1時間前）までは「枠を編集」で入れ替えできるようになります。',
      components: [row(button(`confirm_close_${recruitmentId}`, '仮確定する', ButtonStyle.Danger), button('dismiss', 'やめる'))],
      flags: EPHEMERAL
    });
  }
  if (recruitment.status !== 'provisional') return interaction.reply({ content: 'この募集は今は本確定できません。', flags: EPHEMERAL });
  return interaction.reply({
    content: '今すぐ本確定しますか？\n割り振られた人にメンションでお知らせし、以降は枠を編集できなくなります。',
    components: [row(button(`confirm_finalize_${recruitmentId}`, '本確定する', ButtonStyle.Danger), button('dismiss', 'やめる'))],
    flags: EPHEMERAL
  });
}

async function advanceNow(interaction, recruitmentId, kind) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || !canManage(interaction, recruitment)) {
    return interaction.update({ content: 'この操作はできません。', components: [] });
  }
  const expected = kind === 'provisional' ? 'active' : 'provisional';
  if (recruitment.status !== expected) return interaction.update({ content: 'この募集の状態が変わったため、操作を取りやめました。', components: [] });

  await interaction.update({ content: '⏳ 処理しています...', components: [] });
  if (kind === 'provisional') {
    await toProvisional(recruitment);
    await interaction.editReply({ content: '🟡 仮確定しました。' });
  } else {
    await toFinalized(recruitment);
    await interaction.editReply({ content: '🏁 本確定しました。割り振られた人にメンションでお知らせしました。' });
  }
}

//==========================================================================
// 枠の編集（仮確定中。参加者・募集者・管理者が入れ替えできる）
//==========================================================================

function slotEditorPayload(recruitment, notice = '') {
  const reserves = reservesOf(recruitment);
  const lines = [];
  if (notice) lines.push(notice, '');
  lines.push(headline(recruitment), '', ...slotLines(recruitment));
  if (reserves.length > 0) lines.push(`補欠：${reserves.map(who).join('、')}`);
  lines.push('', '変更したい枠を選んでください。');
  const embed = new EmbedBuilder().setTitle('🛠️ 枠の編集').setDescription(truncate(lines.join('\n'), 4000)).setColor(CARD_COLORS.provisional);
  const options = ATTRIBUTES.map(attr => {
    const occupant = recruitment.participants.find(p => p.assignedAttribute === attr);
    return { label: `${ATTRIBUTE_EMOJI[attr]} ${attr}`, value: attr, description: truncate(occupant ? occupant.username || occupant.userId : '空き', 100) };
  });
  return { content: '', embeds: [embed], components: [row(selectMenu(`slot_pick_${recruitment.id}`, '変更する枠を選択', options)), row(closeButton())] };
}

// 枠編集の前提チェック。問題があれば応答してから null を返す
async function slotEditTarget(interaction, recruitmentId, update) {
  const recruitment = activeRecruitments.get(recruitmentId);
  let error = null;
  if (!recruitment || recruitment.status !== 'provisional') error = '枠の編集は仮確定中（当日8:00〜本確定まで）のみできます。';
  else if (!canEditSlots(interaction, recruitment)) error = 'この募集の参加者・募集者・管理者のみ編集できます。';
  if (!error) return recruitment;
  if (update) await interaction.update({ content: error, embeds: [], components: [] });
  else await interaction.reply({ content: error, flags: EPHEMERAL });
  return null;
}

async function showSlotEditor(interaction, recruitmentId, { update = false } = {}) {
  const recruitment = await slotEditTarget(interaction, recruitmentId, update);
  if (!recruitment) return;
  const payload = slotEditorPayload(recruitment);
  if (update) return interaction.update(payload);
  return interaction.reply({ ...payload, flags: EPHEMERAL });
}

async function showSlotCandidates(interaction, recruitmentId, attr) {
  const recruitment = await slotEditTarget(interaction, recruitmentId, true);
  if (!recruitment) return;
  if (!ATTRIBUTES.includes(attr)) throw new Error(`不正な属性: ${attr}`);

  const raid = recruitment.finalRaidType || recruitment.type;
  const declares = p => attributesFor(p, raid).includes(attr);
  const prefers = p => preferredFor(p, raid).includes(attr);
  // 得意な人 → できる人 → それ以外 の順に並べる
  const rank = p => (prefers(p) ? 0 : declares(p) ? 1 : 2);
  const candidates = [...recruitment.participants].sort((a, b) => rank(a) - rank(b)).slice(0, 24);
  const options = candidates.map(p => {
    const position = p.assignedAttribute ? `【${p.assignedAttribute}】` : (attributesFor(p, raid).length > 0 ? '補欠' : '対象外');
    return {
      label: truncate(`${prefers(p) ? '◎ ' : declares(p) ? '○ ' : ''}${p.username || p.userId}`, 100),
      value: p.userId,
      description: truncate(`今: ${position}｜申告: ${declarationSummary(p, recruitment)}`, 100),
      default: p.assignedAttribute === attr
    };
  });
  options.push({ label: '空きにする', value: '__empty__' });

  const embed = new EmbedBuilder()
    .setTitle(`🛠️ ${ATTRIBUTE_EMOJI[attr]}【${attr}】に入れる人`)
    .setDescription(`◎ は${attr}が得意な人、○ は${attr}ができる人です。\n別の枠にいる人を選ぶと入れ替わり、補欠の人を選ぶと今の人が補欠に回ります。`)
    .setColor(CARD_COLORS.provisional);
  return interaction.update({
    content: '',
    embeds: [embed],
    components: [row(selectMenu(`slot_assign_${recruitmentId}_${attr}`, '入れる人を選択', options)), row(backButton(`slot_back_${recruitmentId}`), closeButton())]
  });
}

async function assignSlot(interaction, recruitmentId, attr, value) {
  const recruitment = await slotEditTarget(interaction, recruitmentId, true);
  if (!recruitment) return;
  const targetId = value === '__empty__' ? null : value;
  if (!ATTRIBUTES.includes(attr) || !setSlot(recruitment, attr, targetId)) {
    return interaction.update(slotEditorPayload(recruitment, '⚠️ 変更できませんでした。もう一度選んでください。'));
  }
  recruitment.lastEditedBy = interaction.user.id;
  saveRecruitmentData();

  const target = recruitment.participants.find(p => p.userId === targetId);
  const notice = target ? `✅ ${ATTRIBUTE_EMOJI[attr]}【${attr}】を ${who(target)} にしました。` : `✅ ${ATTRIBUTE_EMOJI[attr]}【${attr}】を空きにしました。`;
  debugLog('SlotEdit', `${interaction.user.tag}: ${recruitmentId} ${attr} → ${targetId || '空き'}`);
  await interaction.update(slotEditorPayload(recruitment, notice));
  await updateRecruitmentMessage(recruitment);
}

//==========================================================================
// 募集の編集・中止（募集者・管理者）
//==========================================================================

async function editTarget(interaction, recruitmentId, update) {
  const recruitment = activeRecruitments.get(recruitmentId);
  let error = null;
  if (!recruitment || !isOpen(recruitment)) error = 'この募集は編集できません（確定済みか、存在しません）。';
  else if (!canManage(interaction, recruitment)) error = '募集者または管理者のみ編集できます。';
  if (!error) return recruitment;
  if (update) await interaction.update({ content: error, embeds: [], components: [] });
  else await interaction.reply({ content: error, flags: EPHEMERAL });
  return null;
}

async function showEditMenu(interaction, recruitmentId, { update = false, notice = '' } = {}) {
  const recruitment = await editTarget(interaction, recruitmentId, update);
  if (!recruitment) return;
  const embed = new EmbedBuilder()
    .setTitle('⚙️ 募集の編集')
    .setDescription(`${notice ? `${notice}\n\n` : ''}${headline(recruitment)}\n\n変更したい項目を選んでください。\n日付・時間・レイドを変えると、参加者にメンションでお知らせします。`)
    .setColor('#0099ff');
  const payload = {
    content: '',
    embeds: [embed],
    components: [
      row(
        button(`edit_date_${recruitmentId}`, '📅 日付'),
        button(`edit_time_${recruitmentId}`, '⏰ 時間'),
        button(`edit_raid_${recruitmentId}`, '⚔️ レイド'),
        button(`abort_recruitment_${recruitmentId}`, '🚫 募集を中止', ButtonStyle.Danger)
      ),
      row(closeButton())
    ]
  };
  if (update) return interaction.update(payload);
  return interaction.reply({ ...payload, flags: EPHEMERAL });
}

async function showEditDate(interaction, recruitmentId) {
  const recruitment = await editTarget(interaction, recruitmentId, true);
  if (!recruitment) return;
  const embed = new EmbedBuilder().setTitle('📅 日付の変更').setDescription(`今の日付: ${formatDateShort(recruitment.date)}\n新しい日付を選んでください。`).setColor('#0099ff');
  const buttons = [...dateButtons(`edit_set_date_${recruitmentId}_`, recruitment.date), backButton(`edit_menu_${recruitmentId}`)];
  return interaction.update({ content: '', embeds: [embed], components: chunkRows(buttons) });
}

async function showEditTime(interaction, recruitmentId) {
  const recruitment = await editTarget(interaction, recruitmentId, true);
  if (!recruitment) return;
  const embed = new EmbedBuilder().setTitle('⏰ 時間の変更').setDescription(`今の募集時間: ${recruitment.time}\n新しい時間を選んでください。`).setColor('#0099ff');
  return interaction.update({
    content: '',
    embeds: [embed],
    components: [row(selectMenu(`edit_set_time_${recruitmentId}`, '新しい時間を選択', hourOptions(recruitment.time))), row(backButton(`edit_menu_${recruitmentId}`))]
  });
}

// 変更できるレイドの候補
function editableRaids(recruitment) {
  if (recruitment.type === FLEX_RAID && recruitment.status === 'provisional') {
    return selectableRaids().filter(raid => raid !== recruitment.finalRaidType);
  }
  if (recruitment.participants.length === 0) return RAID_TYPES.filter(raid => raid !== recruitment.type);
  if (recruitment.type === FLEX_RAID) return [];
  return selectableRaids().filter(raid => raid !== recruitment.type);
}

async function showEditRaid(interaction, recruitmentId) {
  const recruitment = await editTarget(interaction, recruitmentId, true);
  if (!recruitment) return;
  const raids = editableRaids(recruitment);
  let description;
  if (recruitment.type === FLEX_RAID && recruitment.status === 'provisional') {
    description = `今の実施レイド: ${recruitment.finalRaidType || '未定'}\n実施するレイドを選ぶと、その希望者で割り振り直します。`;
  } else if (raids.length === 0) {
    description = '参加者がいる「参加者希望」の募集は、仮確定後に実施レイドを変更できます。';
  } else {
    description = `今のレイド: ${recruitment.type}\n新しいレイドを選んでください。${recruitment.participants.length > 0 ? '\n参加者の担当属性はそのまま引き継ぎます。' : ''}`;
  }
  const embed = new EmbedBuilder().setTitle('⚔️ レイドの変更').setDescription(description).setColor('#0099ff');
  const buttons = [...raids.map(raid => button(`edit_set_raid_${recruitmentId}_${raid}`, raid, ButtonStyle.Primary)), backButton(`edit_menu_${recruitmentId}`)];
  return interaction.update({ content: '', embeds: [embed], components: chunkRows(buttons) });
}

async function applyEdit(interaction, recruitmentId, field, value) {
  const recruitment = await editTarget(interaction, recruitmentId, true);
  if (!recruitment) return;

  let change;
  if (field === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value === recruitment.date) return showEditMenu(interaction, recruitmentId, { update: true });
    change = `📅 日付：${formatDateShort(recruitment.date)} → ${formatDateShort(value)}`;
    recruitment.date = value;
    // 仮確定より前の日付に戻ったら募集中に戻す
    if (recruitment.status === 'provisional' && Date.now() < provisionalAtMs(recruitment)) {
      recruitment.status = 'active';
      recruitment.lastEditedBy = null;
      if (!recruitment.threadId) await deleteMessage(recruitment.channel, recruitment.provisionalNoticeId);
      recruitment.provisionalNoticeId = null;
    }
  } else if (field === 'time') {
    if (!START_HOURS.includes(hourOf(value)) || value === recruitment.time) return showEditMenu(interaction, recruitmentId, { update: true });
    change = `⏰ 募集時間：${recruitment.time} → ${value}`;
    recruitment.time = value;
  } else if (field === 'raid') {
    if (!editableRaids(recruitment).includes(value)) return showEditMenu(interaction, recruitmentId, { update: true });
    if (recruitment.type === FLEX_RAID && recruitment.status === 'provisional') {
      change = `🎯 実施レイド：${recruitment.finalRaidType || '未定'} → ${value}`;
      autoAssign(recruitment, value);
    } else {
      change = `⚔️ レイド：${recruitment.type} → ${value}`;
      // 参加者の担当属性を新しいレイドに引き継ぐ
      recruitment.participants.forEach(p => {
        const attrs = attributesFor(p, recruitment.type);
        p.attributesByRaid = { [value]: attrs };
        p.joinType = value;
      });
      recruitment.type = value;
      recruitment.finalRaidType = value === FLEX_RAID ? null : value;
    }
  } else {
    throw new Error(`不明な編集項目: ${field}`);
  }

  if (recruitment.status === 'active') autoAssign(recruitment);
  else recruitment.finalTime = computeStartTime(recruitment);
  saveRecruitmentData();
  debugLog('EditRecruitment', `${interaction.user.tag}: ${recruitmentId} ${change}`);

  await showEditMenu(interaction, recruitmentId, { update: true, notice: `✅ 変更しました：${change}` });
  await updateRecruitmentMessage(recruitment);
  const participantIds = realUserIds(recruitment.participants);
  if (participantIds.length > 0) {
    await postNotice(recruitment, `📝 **募集内容が変更されました** ${headline(recruitment)}\n${change}（変更: <@${interaction.user.id}>）`, participantIds);
  }
}

async function askAbort(interaction, recruitmentId) {
  const recruitment = await editTarget(interaction, recruitmentId, true);
  if (!recruitment) return;
  return interaction.update({
    content: `${headline(recruitment)} の募集を中止しますか？\n募集カードは削除され、参加者にはメンションでお知らせします。`,
    embeds: [],
    components: [row(button(`confirm_abort_${recruitmentId}`, '中止する', ButtonStyle.Danger), backButton(`edit_menu_${recruitmentId}`))]
  });
}

// 募集を中止して、カードを削除し参加者に知らせる
async function abortRecruitment(recruitment, actorId) {
  activeRecruitments.delete(recruitment.id);
  saveRecruitmentData();
  await deleteThread(recruitment);
  await deleteMessage(recruitment.channel, recruitment.provisionalNoticeId);
  await deleteMessage(recruitment.channel, recruitment.messageId);
  const participantIds = realUserIds(recruitment.participants);
  if (participantIds.length > 0) {
    recruitment.messageId = null; // カードは消したので返信にしない
    await postNotice(recruitment, `🚫 ${headline(recruitment)} の募集は中止になりました（<@${actorId}>）`, participantIds);
  }
  requestBoardUpdate(recruitment.guildId);
  debugLog('AbortRecruitment', `募集中止: ${recruitment.id}, By: ${actorId}`);
}

async function abortRecruitmentByButton(interaction, recruitmentId) {
  const recruitment = await editTarget(interaction, recruitmentId, true);
  if (!recruitment) return;
  await interaction.update({ content: '🚫 募集を中止しました。', embeds: [], components: [] });
  await abortRecruitment(recruitment, interaction.user.id);
}

//==========================================================================
// 募集ボード（全募集を日付順にまとめた1枚のメッセージ。変更のたびに自動更新）
//==========================================================================

// ボードに載せる募集（開始前のもの、開始順）
function boardRecruitments(guildId, now = Date.now()) {
  return Array.from(activeRecruitments.values())
    .filter(r => r && r.guildId === guildId && (isOpen(r) || isFinalized(r)) && typeof r.date === 'string' && now < startAtMs(r))
    .sort((a, b) => startAtMs(a) - startAtMs(b));
}

function buildBoardMessage(guildId) {
  const list = boardRecruitments(guildId);
  const embed = new EmbedBuilder()
    .setTitle('📋 募集ボード')
    .setDescription(boardDescription(list, guildId))
    .setColor('#1ABC9C')
    .setFooter({ text: '🟢募集中 🟡仮確定（枠の調整中） 🏁本確定｜自動で更新されます' })
    .setTimestamp();
  const components = [];
  const joinable = list.filter(isOpen).slice(0, 25);
  if (joinable.length > 0) {
    const options = joinable.map(r => ({
      label: truncate(`${formatDateShort(r.date)} ${effectiveStartTime(r)}〜 ${raidLabel(r)}`, 100),
      value: r.id,
      description: `${r.status === 'active' ? '募集中' : '仮確定'}・参加${r.participants.length}人`
    }));
    components.push(row(selectMenu('board_join', '参加する募集を選ぶ（複数選ぶとまとめて参加）', options, 1, options.length)));
  }
  components.push(row(button('board_create', '＋ 募集を作成', ButtonStyle.Success)));
  return { content: '', embeds: [embed], components };
}

const boardUpdateTimers = new Map();
const boardMoveRequests = new Set(); // 次の更新でボードを一番下に貼り直すサーバー
// 短時間に続く更新をまとめてボードに反映する。moveToBottom なら、ボードが埋もれていれば一番下に貼り直す
function requestBoardUpdate(guildId, { moveToBottom = false } = {}) {
  if (!guildId || !boards[guildId]) return;
  if (moveToBottom) boardMoveRequests.add(guildId);
  if (boardUpdateTimers.has(guildId)) return;
  boardUpdateTimers.set(guildId, setTimeout(() => {
    boardUpdateTimers.delete(guildId);
    updateBoard(guildId).catch(error => console.error('募集ボード更新エラー:', error));
  }, BOARD_UPDATE_DELAY_MS));
}

async function updateBoard(guildId) {
  const board = boards[guildId];
  if (!board) return;
  const moveToBottom = boardMoveRequests.delete(guildId);
  try {
    const channel = await client.channels.fetch(board.channelId);
    if (moveToBottom && channel.lastMessageId !== board.messageId) return await repostBoard(guildId, channel);
    const message = await channel.messages.fetch(board.messageId);
    await message.edit(buildBoardMessage(guildId));
  } catch (error) {
    // ボードのメッセージ・チャンネルが削除された（貼り直しで別のメッセージに替わっていれば何もしない）
    if ((error.code === 10008 || error.code === 10003) && boards[guildId]?.messageId === board.messageId) {
      console.warn(`募集ボードが見つからないため登録を解除します (Guild: ${guildId})`);
      delete boards[guildId];
      saveBoards();
      return;
    }
    throw error;
  }
}

// 新しいボードを一番下に投稿してから、古いボードを消す
async function repostBoard(guildId, channel) {
  const old = boards[guildId];
  const message = await channel.send(buildBoardMessage(guildId));
  boards[guildId] = { channelId: channel.id, messageId: message.id };
  saveBoards();
  await deleteMessage(old.channelId, old.messageId);
  debugLog('Board', `募集ボードを一番下に貼り直し: Guild=${guildId}`);
}

async function setupBoard(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });

  const guildId = interaction.guildId;
  const old = boards[guildId];
  if (old) await deleteMessage(old.channelId, old.messageId);

  const channel = await client.channels.fetch(interaction.channelId);
  const message = await channel.send(buildBoardMessage(guildId));
  boards[guildId] = { channelId: channel.id, messageId: message.id };
  saveBoards();

  debugLog('Board', `募集ボード設置: Guild=${guildId}, Channel=${channel.id}`);
  await interaction.editReply({
    content: `📋 募集ボードを設置しました。\n募集の作成・参加・確定のたびに自動で更新され、このチャンネルに新しい募集が出ると一番下に貼り直されます。${old ? '\n前のボードは削除しました。' : ''}`
  });
}

//==========================================================================
// 一覧・ヘルプ・管理者用コマンド
//==========================================================================

// 募集リスト表示機能
async function showActiveRecruitments(source) {
  const list = boardRecruitments(source.guildId);
  if (list.length === 0) return respond(source, { content: '現在、募集中のレイドはありません。 `/募集` で作成できます！' });
  const embed = new EmbedBuilder()
    .setTitle('🔍 現在の募集一覧')
    .setDescription(boardDescription(list, source.guildId))
    .setColor('#3498DB')
    .setTimestamp();
  return respond(source, { embeds: [embed] });
}

// ヘルプ表示機能
async function showHelp(source) {
  const embed = new EmbedBuilder()
    .setTitle('📚 グラブル高難易度募集Bot ヘルプ')
    .setDescription('天元・ルシゼロ等の高難易度レイド募集支援Bot')
    .setColor('#1ABC9C')
    .addFields(
      { name: '🌟 コマンド', value: '`/募集`（`/recruit`）- 新規募集\n`/募集リスト`（`/list`）- 募集一覧\n`/参加者一覧`（`/participants`）- 参加者の詳細\n`/募集ヘルプ`（`/help`）- このヘルプ\n`/募集ボード` - 全募集をまとめたボードをこのチャンネルに設置（前のボードは消えます）' },
      { name: '⚙️ 募集の流れ', value: '1. `/募集` でレイド・日付・時間を選ぶ（本人にだけ表示、「戻る」で修正可）。日付を複数選ぶと日ごとにまとめて作成\n2. **募集中**：参加のたびに割り振りを自動計算して（仮）表示\n3. **当日 8:00 に仮確定**：割り振りを固定し、調整用スレッドを作成。参加者同士で話し合いながら「枠を編集」で入れ替え可（代理登録・代理キャンセルも同じ人が使えます）\n4. **開始1時間前に本確定**：割り振られた人にメンション' },
      { name: '🎮 参加', value: '募集カードの「参加・変更」か、ボードのメニューから。ボードで複数選ぶと同じ内容でまとめて参加できます。\n前回の内容が最初から入っているので、変更がなければ「このまま次へ」で進めます。参加後も同じボタンで内容を変更できます。\n得意な属性（◎）を選ぶと優先して割り振られます。早めに抜ける場合は確認画面で抜ける時間を選んでください。\n仮確定中は、参加者・募集者・管理者が「代理登録」でほかのメンバーを追加できます。' },
      { name: '🔁 キャンセル・補欠', value: '- 割り振りは「入れる人を全員入れる」ように属性を自動調整します。あふれた人は補欠です。\n- 仮確定・本確定の後にキャンセルが出ると、入れる補欠が自動で繰り上がります（本確定後はメンションでお知らせ）。\n- 仮確定中の「代理キャンセル」では、参加者・募集者・管理者がほかの参加者を外せます。外された人は「参加・変更」から再度参加できます。' },
      { name: '🛠️ 募集者', value: '「募集を編集」で日付・時間・レイドの変更や中止ができます（参加者にお知らせ）。\n「今すぐ仮確定」「今すぐ本確定」で予定より早く確定することもできます。' },
      { name: '🔧 管理者用コマンド', value: '`!募集削除 [ID]`\n`!IDリスト`\n`!募集確認 [ID]` / `!募集詳細確認`\n`!テストモード開始` / `!テストモード終了`\n`!テスト参加者追加 [ID] [人数]`' }
    )
    .setFooter({ text: '不明点は管理者へ' });
  return respond(source, { embeds: [embed] });
}

async function showIdList(message) {
  const list = Array.from(activeRecruitments.values()).filter(Boolean);
  if (list.length === 0) return message.reply('現在募集データはありません。');
  let response = '**募集ID一覧**\n\n';
  list.forEach((r, index) => {
    response += `${index + 1}. \`${shortId(r.id)}\` ${r.type || '?'} ${r.date ? formatDateShort(r.date) : '?'} ${r.time || '?'} - ${r.status || '?'}\n`;
  });
  for (let i = 0; i < response.length; i += 1990) await message.reply(response.substring(i, i + 1990));
}

// 募集削除処理（!募集削除）
async function deleteRecruitment(message, recruitmentId) {
  const recruitment = findRecruitment(recruitmentId);
  if (!recruitment) return message.reply(`ID「${recruitmentId}」の募集データが見つかりません。`);
  if (recruitment.creator !== message.author.id && !isAdmin(message.member)) return message.reply('募集者本人または管理者のみ削除できます。');
  try {
    await abortRecruitment(recruitment, message.author.id);
    await message.reply(`募集ID: \`${shortId(recruitment.id)}\` を削除しました。`);
  } catch (error) {
    console.error('募集削除エラー:', error);
    await message.reply('募集の削除中にエラーが発生しました。');
  }
}

// 募集詳細表示機能（デバッグ用）
async function showRecruitmentDetails(message, recruitmentId) {
  const recruitment = findRecruitment(recruitmentId);
  if (!recruitment) return message.reply(`ID「${recruitmentId}」は存在しません。`);
  let details = `**募集ID: ${recruitment.id} 詳細**\n\`\`\`json\n`;
  details += JSON.stringify(recruitment, (key, value) => key === 'participants' ? `[${value.length} 名]` : value, 2);
  details += '\n```';
  let participantsInfo = '**参加者情報:**\n';
  if (recruitment.participants.length > 0) {
    participantsInfo += '```json\n';
    participantsInfo += JSON.stringify(recruitment.participants.map(p => ({ u: p.username, id: p.userId, type: p.joinType, attr: p.attributesByRaid, time: p.timeAvailability, assigned: p.assignedAttribute || '-', rmk: p.remarks || '', test: p.isTestParticipant || false })), null, 2);
    participantsInfo += '\n```';
  } else participantsInfo += '参加者なし';

  try {
    for (const text of [details, participantsInfo]) {
      for (let i = 0; i < text.length; i += 1950) await message.channel.send({ content: text.substring(i, i + 1950) });
    }
  } catch (e) {
    console.error('詳細表示エラー:', e);
    await message.reply('詳細情報の表示中にエラーが発生しました。').catch(() => { });
  }
}

// 全募集データ表示機能（デバッグ用）
async function showAllRecruitmentDetails(message) {
  const allRecruitments = Array.from(activeRecruitments.values()).filter(Boolean);
  if (allRecruitments.length === 0) return message.reply('現在募集データはありません。');
  let debugInfo = `**全募集データ (${allRecruitments.length}件)**\n\n`;
  allRecruitments.forEach(data => {
    debugInfo += `**ID**: \`${shortId(data.id)}\` | タイプ: ${data.type || '?'} | 状態: ${data.status || '?'} | 日時: ${data.date || '?'} ${data.time || '?'} → ${data.date ? effectiveStartTime(data) : '?'} | Msg: ${data.messageId || '?'} | 参加者: ${data.participants?.length || 0}名\n`;
  });
  for (let i = 0; i < debugInfo.length; i += 1950) await message.channel.send({ content: debugInfo.substring(i, i + 1950) });
}

//==========================================================================
// テストモード機能ブロック
//==========================================================================

async function refreshOpenCards() {
  for (const recruitment of Array.from(activeRecruitments.values()).filter(isOpen)) {
    try { await updateRecruitmentMessage(recruitment); } catch (e) { console.error(`テストモード切替時Msg更新エラー(ID:${recruitment.id}):`, e); }
  }
}

// テストモード開始処理
async function startTestMode(message) {
  testMode.active = true;
  const embed = new EmbedBuilder().setTitle('🧪 テストモード開始').setDescription('テストモード**有効**。\n募集カードにテスト参加者追加ボタンが表示されます。\n`!テストモード終了` で無効化。').setColor('#FF9800').setTimestamp();
  await message.reply({ embeds: [embed] });
  debugLog('TestMode', `テストモード開始, By: ${message.author.tag}`);
  await refreshOpenCards();
}

// テストモード終了処理
async function endTestMode(message) {
  if (!testMode.active) return message.reply('テストモードは有効ではありません。');
  testMode.active = false;
  let removedCount = 0;
  activeRecruitments.forEach(recruitment => {
    if (!recruitment?.participants) return;
    const before = recruitment.participants.length;
    recruitment.participants = recruitment.participants.filter(p => !p.isTestParticipant);
    removedCount += before - recruitment.participants.length;
    if (before !== recruitment.participants.length) {
      if (recruitment.status === 'active') autoAssign(recruitment);
      else fillEmptySlots(recruitment);
    }
  });
  saveRecruitmentData();
  const embed = new EmbedBuilder().setTitle('✅ テストモード終了').setDescription(`テストモード**無効**。\n追加されていた ${removedCount} 名のテスト参加者を削除。`).setColor('#4CAF50').setTimestamp();
  await message.reply({ embeds: [embed] });
  debugLog('TestMode', `テストモード終了, By: ${message.author.tag}, 削除: ${removedCount}`);
  await refreshOpenCards();
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

// ランダム属性生成
function getRandomAttributes() {
  const shuffled = [...ATTRIBUTES].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, Math.floor(Math.random() * ATTRIBUTES.length) + 1);
}

// テスト参加者を追加して割り振りを計算し直す
function addTestParticipants(recruitment, count) {
  const added = [];
  for (let i = 0; i < count; i++) {
    let joinType = recruitment.type;
    const attributesByRaid = {};
    if (recruitment.type === FLEX_RAID) {
      joinType = randomItem([...selectableRaids(), ANY_RAID]);
      const attrs = getRandomAttributes();
      if (joinType === ANY_RAID) selectableRaids().forEach(raid => { attributesByRaid[raid] = attrs; });
      else attributesByRaid[joinType] = attrs;
      if (joinType !== ANY_RAID) joinType = FLEX_RAID;
    } else {
      attributesByRaid[joinType] = getRandomAttributes();
    }
    const participant = {
      userId: `test-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 5)}`,
      username: `[Test${recruitment.participants.length + 1}]${randomItem(['Knight', 'Ace', 'Support', 'DPS', 'Healer', 'Tank'])}`,
      joinType,
      attributesByRaid,
      timeAvailability: Math.random() < 0.3 ? 'now' : randomItem(['now', ...START_HOURS.map(formatHour)]),
      remarks: '',
      assignedAttribute: null,
      isTestParticipant: true
    };
    recruitment.participants.push(participant);
    added.push(participant);
  }
  if (recruitment.status === 'active') autoAssign(recruitment);
  else fillEmptySlots(recruitment);
  saveRecruitmentData();
  return added;
}

// テスト参加者追加処理（!テスト参加者追加）
async function addTestParticipantsByCommand(message, recruitmentId, count) {
  if (!testMode.active) return message.reply('テストモードが有効ではありません。`!テストモード開始` で有効にしてください。');
  const recruitment = findRecruitment(recruitmentId);
  if (!recruitment) return message.reply(`ID「${recruitmentId}」が見つかりません。`);
  if (!isOpen(recruitment)) return message.reply(`募集 (ID: ${recruitmentId}) は受付中ではありません（状態: ${recruitment.status}）。`);

  const added = addTestParticipants(recruitment, count);
  await updateRecruitmentMessage(recruitment);
  const embed = new EmbedBuilder()
    .setTitle('🧪 テスト参加者 追加完了')
    .setDescription(`募集ID: \`${shortId(recruitment.id)}\` に ${added.length} 名のテスト参加者を追加しました。\n現在の参加者数: ${recruitment.participants.length} 名`)
    .setColor('#2196F3')
    .setTimestamp();
  added.slice(0, 5).forEach((p, index) => {
    embed.addFields({ name: `${index + 1}. ${p.username}`, value: `${declarationSummary(p, recruitment)}`, inline: false });
  });
  if (added.length > 5) embed.addFields({ name: '...', value: `他 ${added.length - 5} 名`, inline: false });
  await message.reply({ embeds: [embed] });
  debugLog('TestMode', `${message.author.tag} が募集ID ${recruitment.id} に ${added.length} 名追加 (コマンド)`);
}

// テスト参加者追加オプション表示
async function showTestParticipantAddOptions(interaction, recruitmentId) {
  if (!testMode.active) return interaction.reply({ content: 'テストモードが有効ではありません。', flags: EPHEMERAL });
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || !isOpen(recruitment)) return interaction.reply({ content: 'この募集は既に終了しているか、存在しません。', flags: EPHEMERAL });
  const currentCount = recruitment.participants.length;
  const options = [1, 3, 5, 7, 10].map(num => ({
    label: `${num}人 追加`,
    value: String(num),
    description: `テスト参加者を${num}人追加 (合計 ${currentCount + num} 名)`
  }));
  const embed = new EmbedBuilder()
    .setTitle('🧪 テスト参加者 追加')
    .setDescription(`募集ID: \`${shortId(recruitmentId)}\` (現在 ${currentCount} 名)\n追加する人数を選択してください。\nタイプ、属性、時間はランダム設定。`)
    .setColor('#2196F3');
  await interaction.reply({ embeds: [embed], components: [row(selectMenu(`test_participant_count_${recruitmentId}`, '追加するテスト参加者の人数を選択', options))], flags: EPHEMERAL });
}

// テスト参加者追加確認UI表示
async function showTestParticipantConfirmation(interaction, recruitmentId, count) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || !isOpen(recruitment)) return interaction.update({ content: 'この募集は既に終了しているか、存在しません。', embeds: [], components: [] });
  const currentCount = recruitment.participants.length;
  const embed = new EmbedBuilder()
    .setTitle('🧪 テスト参加者 追加確認')
    .setDescription(`募集ID: \`${shortId(recruitmentId)}\` に **${count} 名** のテスト参加者を追加します。\n\n現在の参加者数: ${currentCount} 名\n追加後の参加者数: ${currentCount + count} 名`)
    .setColor('#2196F3');
  await interaction.update({
    embeds: [embed],
    components: [row(button(`confirm_test_participants_${recruitmentId}_${count}`, `${count}名 追加`, ButtonStyle.Success), button('cancel_test_participants', 'キャンセル', ButtonStyle.Danger))]
  });
}

// テスト参加者追加確定処理
async function confirmAddTestParticipants(interaction, recruitmentId, count) {
  if (!testMode.active) return interaction.update({ content: 'テストモードが有効ではありません。', embeds: [], components: [] });
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || !isOpen(recruitment)) return interaction.update({ content: 'この募集は既に終了しているか、存在しません。', embeds: [], components: [] });

  const added = addTestParticipants(recruitment, count);
  await interaction.update({ content: `✅ ${added.length} 名のテスト参加者を追加しました。\n現在の参加者: ${recruitment.participants.length} 名`, embeds: [], components: [] });
  await updateRecruitmentMessage(recruitment);
  debugLog('TestMode', `${interaction.user.tag} が募集ID ${recruitmentId} に ${added.length} 名追加 (ボタン)`);
}

//==========================================================================
// 起動処理（Expressサーバー、プロセス監視、Discordログイン）
//==========================================================================

function start() {
  // グローバルなエラーハンドリング
  process.on('unhandledRejection', (reason) => {
    console.error('未処理のPromise拒否:');
    console.error(reason instanceof Error ? reason.stack : reason);
  });

  // Expressサーバー (Keep-alive用)
  const express = require('express');
  const app = express();
  const PORT = process.env.PORT || 10000;

  app.get('/', (req, res) => res.status(200).send('Discord Bot is Active!'));
  app.get('/health', (req, res) => res.status(200).json({ status: 'up', timestamp: new Date().toISOString(), uptime: process.uptime(), discordClientStatus: client.ws.status, activeRecruitments: activeRecruitments.size, memoryUsage: process.memoryUsage().rss }));
  app.get('/ping', (req, res) => res.status(200).send('pong'));
  app.use((req, res) => res.status(404).send('Not Found'));
  app.use((err, req, res, next) => { console.error('Expressサーバーエラー:', err); res.status(500).send('Internal Server Error'); });
  app.listen(PORT, () => console.log(`監視用HTTPサーバーがポート ${PORT} で起動しました。`));

  // プロセス監視とグレースフルシャットダウン
  process.on('uncaughtException', (err, origin) => {
    console.error('致命的な未処理例外:', origin, err);
    console.log('データを保存試行...');
    saveRecruitmentData();
    setTimeout(() => { console.log('安全なシャットダウンを実行...'); process.exit(1); }, 2000);
  });

  const shutdown = (signal) => {
    console.log(`${signal} 受信。グレースフルシャットダウン開始...`);
    saveRecruitmentData();
    client.destroy();
    console.log('Discordクライアント停止。');
    setTimeout(() => { console.log('シャットダウン完了。'); process.exit(0); }, 1500);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // 定期的なメモリ監視
  setInterval(() => {
    try {
      const usedMemoryMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
      const MEMORY_LIMIT_MB = process.env.MEMORY_LIMIT_MB || 450;
      if (usedMemoryMB > MEMORY_LIMIT_MB) {
        console.warn(`メモリ使用量 (${usedMemoryMB}MB) が閾値 (${MEMORY_LIMIT_MB}MB) 超過。`);
        shutdown('MemoryLimit');
      }
    } catch (error) { console.error('自己ヘルスチェックエラー:', error); }
  }, 10 * 60 * 1000);

  // Discord Bot ログイン
  client.login(process.env.TOKEN)
    .then(() => console.log('Discord Bot 正常ログイン'))
    .catch(error => { console.error('!!! Discord Botログインエラー !!!:', error); process.exit(1); });
}

if (require.main === module) {
  start();
}

// テスト用に内部の関数を公開
module.exports = {
  client,
  activeRecruitments: () => activeRecruitments,
  boards: () => boards,
  userProfiles: () => userProfiles,
  tempUserData,
  testMode,
  handleInteraction,
  buildSlashCommands,
  checkSchedules,
  cleanupOldRecruitments,
  buildCardMessage,
  buildBoardMessage,
  updateBoard,
  saveRecruitmentData,
  loadRecruitmentData,
  DATA_FILE_PATH,
  BOARD_FILE_PATH,
  PROFILE_FILE_PATH
};
