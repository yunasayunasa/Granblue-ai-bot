// Discord.jsの必要なクラスをインポート
const {
  Client,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonStyle,
  GatewayIntentBits,
  InteractionType,
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

// テストモード用のグローバル変数
const testMode = {
  active: false,
  testParticipants: [] // テスト用参加者データを保存
};

// グローバルなエラーハンドリングを追加
process.on('unhandledRejection', (reason, promise) => {
  console.error('未処理のPromise拒否:');
  console.error(reason instanceof Error ? reason.stack : reason); // スタックトレースも表示
});

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

console.log(`[Config] Environment: ${isProduction ? 'Production' : 'Development'}`);
console.log(`[Config] Data Path: ${DATA_FILE_PATH}`);

// グローバル変数
let activeRecruitments = new Map(); // 現在進行中の募集を保持
const tempUserData = new Map(); // 一時的なユーザーデータ保存用 (モーダル連携用)
const attributes = ['火', '水', '土', '風', '光', '闇']; // グラブルの属性
// ★★★ ご要望に応じてレイドタイプを追加・変更できます ★★★
const raidTypes = ['天元', 'ルシゼロ', 'スパバハ', 'ヴェルサシア', '参加者希望']; // レイドタイプ
const NG_WORDS = ["死ね", "殺す", "馬鹿", "アホ", "氏ね", "ころす", "バカ", /* ... 他の不適切な単語を追加 ... */]; // NGワードリスト
// ★★★ ご要望に応じて備考の最大文字数を25に変更 ★★★
const MAX_REMARKS_LENGTH = 25; // 備考の最大文字数

// ★★★ ご要望に応じて時間オプションを19時～23時に変更 ★★★
const timeOptions = [];
for (let i = 19; i <= 23; i++) {
  const hour = i.toString().padStart(2, '0');
  timeOptions.push({
    label: `${hour}:00`,
    value: `${hour}:00`
  });
}

// ユーティリティ関数
function generateUniqueId() {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function debugLog(tag, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${tag}] ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// 募集データのロード処理
function loadRecruitmentData() {
  try {
    const dataDir = path.dirname(DATA_FILE_PATH); // グローバル変数を使用

    // ディレクトリが存在しない場合は作成 (読み込み時には通常不要だが、初回起動時などを考慮)
    if (!fs.existsSync(dataDir)) {
      console.log(`データディレクトリが見つからないため作成します: ${dataDir}`);
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // ファイルが存在するか確認
    if (fs.existsSync(DATA_FILE_PATH)) {
      console.log('保存されていた募集データをロードします...');
      const data = fs.readFileSync(DATA_FILE_PATH, 'utf8');
      // 空ファイルの場合の対策
      if (data.trim() === '') {
        console.log('データファイルが空です。新規に開始します。');
        return new Map();
      }
      const parsedData = JSON.parse(data);

      // 読み込んだデータをMapに変換
      const loadedRecruitments = new Map();
      let activeCount = 0;

      Object.entries(parsedData).forEach(([id, recruitment]) => {
        if (!recruitment || typeof recruitment !== 'object') {
          console.warn(`不正な募集データが見つかりました (ID: ${id})。スキップします。`);
          return;
        }
        // データの互換性を保つための処理 (例: 古いデータに status がない場合など)
        if (!recruitment.status) recruitment.status = 'unknown'; // 例
        loadedRecruitments.set(id, recruitment);
        if (recruitment.status === 'active') activeCount++;
      });

      console.log(`${loadedRecruitments.size}件の募集データをロードしました（アクティブ: ${activeCount}件）`);
      return loadedRecruitments;
    } else {
      console.log('保存された募集データはありません。新規に開始します。');
      return new Map();
    }
  } catch (error) {
    console.error('募集データのロード中にエラーが発生しました:', error);
    return new Map(); // エラー時は空のMapを返す
  }
}

// 募集データの保存処理
function saveRecruitmentData() {
  if (!(activeRecruitments instanceof Map)) {
    console.log('保存対象のデータ(activeRecruitments)がMapではありません。処理をスキップします。');
    return;
  }

  try {
    const dataDir = path.dirname(DATA_FILE_PATH); // グローバル変数を使用

    if (!fs.existsSync(dataDir)) {
      console.log(`データディレクトリが見つからないため作成します: ${dataDir}`);
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const dataToSave = {};
    activeRecruitments.forEach((recruitment, id) => {
      dataToSave[id] = recruitment;
    });

    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(dataToSave, null, 2), 'utf8');
    // 保存成功時のログは頻繁に出力されるので、デバッグ時以外は抑制しても良いかも
    // console.log(`${activeRecruitments.size}件の募集データを保存しました (${DATA_FILE_PATH})`);

  } catch (error) {
    console.error('募集データの保存中にエラーが発生しました:', error);
  }
}

// 古い募集のクリーンアップ処理
async function cleanupOldRecruitments() {
  const now = new Date();
  let cleanupCount = 0;
  const recruitmentsToDelete = [];

  activeRecruitments.forEach((recruitment, id) => {
    // recruitment が null や undefined でないことを確認
    if (!recruitment) {
      console.warn(`ID ${id} に対応する募集データが null または undefined です。削除対象とします。`);
      recruitmentsToDelete.push(id);
      return;
    }

    // createdAt または date が存在し、有効な日付か確認
    let creationTimestamp;
    if (recruitment.createdAt && !isNaN(new Date(recruitment.createdAt).getTime())) {
      creationTimestamp = new Date(recruitment.createdAt).getTime();
    } else if (recruitment.date && !isNaN(new Date(recruitment.date).getTime())) {
      // createdAt がない古いデータのためのフォールバック
      creationTimestamp = new Date(recruitment.date).getTime();
    } else {
      console.warn(`古い募集 ${id} の作成日時が無効または存在しません。削除対象とします。`);
      recruitmentsToDelete.push(id);
      return;
    }


    const recruitmentDate = new Date(creationTimestamp);
    const daysSinceCreation = (now.getTime() - recruitmentDate.getTime()) / (1000 * 60 * 60 * 24);

    const isVeryOld = daysSinceCreation > 7;
    const isClosedAndOld = (recruitment.status === 'closed' || recruitment.status === 'assigned' || recruitment.status === 'error') && daysSinceCreation > 3; // error状態もクリーンアップ対象に

    if (isVeryOld || isClosedAndOld) {
      recruitmentsToDelete.push(id);
      debugLog('Cleanup', `古い募集を削除対象に追加: ID=${id}, Type=${recruitment.type || 'N/A'}, Status=${recruitment.status || 'N/A'}, Days=${daysSinceCreation.toFixed(1)}`);
    }
  });

  for (const id of recruitmentsToDelete) {
    const recruitment = activeRecruitments.get(id);
    if (recruitment && recruitment.channel && recruitment.messageId) {
      try {
        const channel = await client.channels.fetch(recruitment.channel).catch(() => null);
        if (channel && channel.isTextBased()) {
          const message = await channel.messages.fetch(recruitment.messageId).catch(() => null);
          if (message) {
            await message.delete().catch(e => console.error(`メッセージ削除失敗 (ID: ${id}):`, e.message));
            debugLog('Cleanup', `募集メッセージを削除: ${id}`);
          }
        }
      } catch (error) {
        console.error(`クリーンアップ時のメッセージ削除エラー (ID: ${id}):`, error);
      }
    }
    activeRecruitments.delete(id);
    cleanupCount++;
  }

  if (cleanupCount > 0) {
    console.log(`古い募集 ${cleanupCount}件をクリーンアップしました。残り: ${activeRecruitments.size}件`);
    saveRecruitmentData();
  } else {
    // 定期的なログは抑制しても良い
    // console.log(`クリーンアップ対象の古い募集はありませんでした。現在の募集数: ${activeRecruitments.size}件`);
  }
}

// スラッシュコマンド登録関数
async function registerCommands() {
  const commands = [
    new SlashCommandBuilder().setName('recruit').setDescription('新しい募集を開始します (募集)'),
    new SlashCommandBuilder().setName('list').setDescription('現在のアクティブな募集一覧を表示します (募集リスト)'),
    new SlashCommandBuilder().setName('help').setDescription('ボットのヘルプを表示します (募集ヘルプ)'),
    new SlashCommandBuilder().setName('participants').setDescription('募集の参加者一覧を表示します'),
  ].map(command => command.toJSON());

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

// ボット準備完了時の処理
client.once('ready', () => {
  console.log(`${client.user.tag} でログインしました！`);
  console.log('Discord.js バージョン:', require('discord.js').version);

  // スラッシュコマンド登録
  registerCommands();

  // 保存済みデータがあればロード
  const loadedData = loadRecruitmentData();
  if (loadedData instanceof Map && loadedData.size > 0) {
    activeRecruitments = loadedData;
  }

  // 定期的な処理の開始
  setInterval(saveRecruitmentData, 2 * 60 * 1000);     // 2分ごとにデータ保存
  setInterval(checkAutomaticClosing, 5 * 60 * 1000);   // 5分ごとに自動締め切りチェック
  setInterval(cleanupOldRecruitments, 60 * 60 * 1000); // 1時間ごとに古い募集をクリーンアップ (頻度を上げる)

  // 初回のクリーンアップを実行
  cleanupOldRecruitments();
  // 初回の保存を実行
  saveRecruitmentData();
});

// エラー応答ヘルパー関数
async function handleErrorReply(interaction, error, customMessage = 'エラーが発生しました。') {
  const errorCode = error?.code;
  const errorMessage = error instanceof Error ? error.message : String(error);

  console.error(`エラー応答試行 (Interaction ID: ${interaction?.id}, CustomID: ${interaction?.customId || 'N/A'}, Code: ${errorCode}): ${errorMessage}`);
  if (error instanceof Error) {
    console.error(error.stack);
  }

  // 無視するエラーコード
  if (errorCode === 10062 /* Unknown interaction */ || errorCode === 40060 /* Already acknowledged */) {
    console.log(`無視するインタラクションエラー (コード: ${errorCode}) - 応答しません`);
    return;
  }
  // Interaction が応答可能かチェック
  if (!interaction || !interaction.isRepliable()) {
    console.error("エラー応答不可: Interactionオブジェクトが無効または応答不可能です。");
    return;
  }


  const replyOptions = {
    content: `${customMessage} (詳細: ${errorMessage.substring(0, 100)}${errorMessage.length > 100 ? '...' : ''}${errorCode ? ` / コード: ${errorCode}` : ''})`,
    ephemeral: true
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
client.on('interactionCreate', async interaction => {
  if (!interaction.guild || !interaction.member) {
    if (interaction.isRepliable()) {
      await interaction.reply({ content: 'このボットはサーバー内でのみ利用可能です。', ephemeral: true }).catch(() => { });
    }
    return;
  }
  if (interaction.user.bot) return;

  try {
    if (interaction.isChatInputCommand()) {
      const commandName = interaction.commandName;
      if (commandName === 'recruit') {
        await startRecruitment(interaction);
      } else if (commandName === 'list') {
        await showActiveRecruitments(interaction);
      } else if (commandName === 'help') {
        await showHelp(interaction);
      } else if (commandName === 'participants') {
        await showRecruitmentSelectionForParticipants(interaction);
      }
    } else if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelectMenuInteraction(interaction);
    } else if (interaction.type === InteractionType.ModalSubmit) {
      await handleModalSubmit(interaction);
    }
  } catch (error) {
    console.error(`インタラクション処理中に予期せぬエラーが発生 (ID: ${interaction.id}, CustomID: ${interaction.customId || 'N/A'}):`);
    console.error(error);
    await handleErrorReply(interaction, error, 'コマンドの処理中に予期せぬエラーが発生しました。');
  }
});

// メッセージコマンドハンドラ
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // 権限チェック用ヘルパー関数
  const isAdmin = () => message.member.permissions.has(PermissionsBitField.Flags.Administrator);

  try {
    if (command === '募集') {
      await startRecruitment(message);
    }
    else if (command === '募集リスト') {
      await showActiveRecruitments(message);
    }
    else if (command === '募集ヘルプ') {
      await showHelp(message);
    }
    else if (command === 'テストモード開始') {
      if (!isAdmin()) return message.reply('管理者権限が必要です。');
      await startTestMode(message);
    }
    else if (command === 'テストモード終了') {
      if (!isAdmin()) return message.reply('管理者権限が必要です。');
      await endTestMode(message);
    }
    else if (command === 'テスト参加者追加' || command === 'testadd') {
      if (!isAdmin()) return message.reply('管理者権限が必要です。');
      if (args.length < 2 || isNaN(parseInt(args[1], 10))) {
        return message.reply('使用方法: `!テスト参加者追加 [募集ID] [人数]`');
      }
      const recruitmentId = args[0];
      const count = parseInt(args[1], 10);
      if (count <= 0) return message.reply('人数には1以上の整数を指定してください。');
      await addTestParticipants(message, recruitmentId, count);
    }
    else if (command === 'idリスト') {
      const ids = Array.from(activeRecruitments.keys());
      if (ids.length === 0) {
        return message.reply('現在アクティブな募集データはありません。');
      }
      let response = '**募集ID一覧**\n\n';
      ids.forEach((id, index) => {
        const r = activeRecruitments.get(id);
        if (r) response += `${index + 1}. \`${id}\` (${r.type || '?'} - ${r.status || '?'})\n`;
      });
      // 長文分割
      if (response.length > 2000) {
        for (let i = 0; i < response.length; i += 1990) { await message.reply(response.substring(i, i + 1990)); }
      } else { await message.reply(response); }
    }
    else if (command === '追加') {
      if (!isAdmin()) return message.reply('管理者権限が必要です。');
      if (args.length < 1) return message.reply('使用方法: `!追加 [募集ID]`');
      const id = args[0];
      const recruitment = activeRecruitments.get(id);
      if (!recruitment) return message.reply(`ID "${id}" の募集は存在しません。`);
      if (recruitment.status !== 'active') return message.reply(`ID "${id}" の募集はアクティブではありません（状態: ${recruitment.status}）。`);
      // !テスト参加者追加 を 3 人で呼び出す
      await addTestParticipants(message, id, 3);
    }
    else if (command === '募集削除') {
      if (args.length < 1) return message.reply('使用方法: `!募集削除 [募集ID]`');
      const recruitmentId = args[0];
      await deleteRecruitment(message, recruitmentId); // 権限チェックは deleteRecruitment 内で行う
    }
    else if (command === '募集確認') {
      if (!isAdmin()) return message.reply('管理者権限が必要です。');
      if (args.length < 1) return message.reply('使用方法: `!募集確認 [募集ID]`');
      const recruitmentId = args[0];
      await showRecruitmentDetails(message, recruitmentId);
    }
    else if (command === '募集詳細確認') {
      if (!isAdmin()) return message.reply('管理者権限が必要です。');
      await showAllRecruitmentDetails(message);
    }
    else if (command === '再起動テスト') {
      if (!isAdmin()) return message.reply('管理者権限が必要です。');
      await message.reply('テスト用の再起動を行います...');
      console.log(`${message.author.tag}がテスト用再起動をリクエスト`);
      saveRecruitmentData();
      setTimeout(() => { console.log('テスト用再起動実行'); process.exit(0); }, 3000);
    }
    else if (command === '直接テスト' || command === 'directtest') {
      if (!isAdmin()) return message.reply('管理者権限が必要です。');
      if (args.length < 1) return message.reply('使用方法: `!直接テスト [募集ID] (人数 デフォルト:5)`');
      const recruitmentId = args[0];
      const count = args.length >= 2 ? parseInt(args[1], 10) : 5;
      if (isNaN(count) || count <= 0) return message.reply('人数には1以上の整数を指定してください。');
      const recruitment = activeRecruitments.get(recruitmentId);
      if (!recruitment) return message.reply(`ID "${recruitmentId}" の募集は存在しません。`);
      if (recruitment.status !== 'active') return message.reply(`ID "${recruitmentId}" の募集はアクティブではありません（状態: ${recruitment.status}）。`);
      // !テスト参加者追加 を指定人数で呼び出す
      await addTestParticipants(message, recruitmentId, count);
    }
    else if (command === 'v14test') {
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('simple_test').setLabel('テストボタン').setStyle(ButtonStyle.Primary));
      await message.reply({ content: 'v14テストボタン', components: [row] });
    }

  } catch (error) {
    console.error(`コマンド "${command}" の処理中にエラーが発生:`, error);
    await message.reply('コマンドの実行中にエラーが発生しました。').catch(() => { });
  }
});

// ボタンインタラクション処理関数
async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;
  // 頻繁なログは抑制しても良い
  // console.log(`ボタン処理開始: ${customId}, User: ${interaction.user.tag}`);

  try {
    // レイドタイプ選択
    if (customId.startsWith('raid_type_')) {
      const raidType = customId.replace('raid_type_', '');
      await showDateSelection(interaction, raidType);
    }
    // 日付選択
    else if (customId.startsWith('date_select_')) {
      const parts = customId.split('_');
      if (parts.length < 4) throw new Error(`不正な日付選択ID: ${customId}`);
      const raidType = parts[2];
      const dateStr = parts[3];
      await showTimeSelection(interaction, raidType, dateStr);
    }
    // 募集確定ボタン
    else if (customId.startsWith('confirm_recruitment_')) {
      const recruitmentId = customId.replace('confirm_recruitment_', '');
      await finalizeRecruitment(interaction, recruitmentId);
    }
    // 募集キャンセルボタン (作成時)
    else if (customId === 'cancel_recruitment') {
      await interaction.update({ content: '募集作成をキャンセルしました。', embeds: [], components: [] }).catch(e => { if (e.code !== 10062) console.error("Cancel Recruitment Update Error:", e) });
    }
    // 参加申込ボタン
    else if (customId.startsWith('join_recruitment_')) {
      const recruitmentId = customId.replace('join_recruitment_', '');
      await showJoinOptions(interaction, recruitmentId);
    }
    // 参加キャンセルボタン (参加後)
    else if (customId.startsWith('cancel_participation_')) {
      const recruitmentId = customId.replace('cancel_participation_', '');
      await cancelParticipation(interaction, recruitmentId);
    }
    // 募集締め切りボタン
    else if (customId.startsWith('close_recruitment_')) {
      const recruitmentId = customId.replace('close_recruitment_', '');
      await closeRecruitment(interaction, recruitmentId);
    }
    // 備考入力モーダルを開くボタン
    else if (customId.startsWith('open_remarks_modal_')) {
      const recruitmentId = customId.replace('open_remarks_modal_', '');
      await showRemarksModal(interaction, recruitmentId);
    }
    // 参加確定ボタン (備考なし)
    else if (customId.startsWith('confirm_direct_')) {
      const recruitmentId = customId.replace('confirm_direct_', '');
      const userData = tempUserData.get(interaction.user.id);
      if (!userData || userData.recruitmentId !== recruitmentId) {
        return await interaction.update({ content: 'エラー: 参加情報が見つからないか古くなっています。再度申込してください。', embeds: [], components: [], ephemeral: true }).catch(e => { if (e.code !== 10062) console.error("Confirm Direct Update Error:", e) });
      }
      await confirmParticipation(interaction, recruitmentId, userData.joinType, userData.attributesByRaid, userData.timeAvailability, '');
      tempUserData.delete(interaction.user.id);
    }
    // 参加申込キャンセルボタン (参加フロー中)
    else if (customId === 'cancel_join') {
      tempUserData.delete(interaction.user.id);
      await interaction.update({ content: '参加申込をキャンセルしました。', embeds: [], components: [] }).catch(e => { if (e.code !== 10062) console.error("Cancel Join Update Error:", e) });
    }
    // テストボタン
    else if (customId === 'simple_test') {
      await interaction.reply({ content: 'テストボタン動作OK！', ephemeral: true });
    }
    // テスト参加者追加ボタン (募集メッセージ上)
    else if (customId.startsWith('add_test_participants_')) {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: '管理者権限が必要です。', ephemeral: true });
      const recruitmentId = customId.replace('add_test_participants_', '');
      await showTestParticipantAddOptions(interaction, recruitmentId);
    }
    // テスト参加者確定ボタン (確認UI上)
    else if (customId.startsWith('confirm_test_participants_')) {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.update({ content: '管理者権限が必要です。', embeds: [], components: [], ephemeral: true });
      const parts = customId.split('_');
      if (parts.length < 5) throw new Error(`不正なテスト参加者確定ID: ${customId}`);
      const recruitmentId = parts[3];
      const count = parseInt(parts[4], 10);
      if (isNaN(count)) throw new Error(`テスト参加者数解析エラー: ${parts[4]}`);
      await confirmAddTestParticipants(interaction, recruitmentId, count);
    }
    // テスト参加者キャンセルボタン (確認UI上)
    else if (customId === 'cancel_test_participants') {
      await interaction.update({ content: 'テスト参加者の追加をキャンセルしました。', embeds: [], components: [] }).catch(e => { if (e.code !== 10062) console.error("Cancel Test Update Error:", e) });
    }
    // その他の未処理ボタン
    else {
      console.warn(`未処理のボタンID: ${customId}`);
      await interaction.reply({ content: 'このボタンは現在処理できません。', ephemeral: true }).catch(() => { });
    }
  } catch (error) {
    console.error(`ボタン処理エラー (ID: ${customId}, User: ${interaction.user.tag}):`, error);
    await handleErrorReply(interaction, error, `ボタン (${customId}) の処理中にエラーが発生しました。`);
  }
}

// 備考入力モーダル表示関数
async function showRemarksModal(interaction, recruitmentId) {
  const userData = tempUserData.get(interaction.user.id);
  if (!userData || userData.recruitmentId !== recruitmentId) {
    return await interaction.reply({ content: 'エラー: 参加情報が見つからないか古くなっています。再度「参加申込」ボタンから操作してください。', ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId(`submit_remarks_${recruitmentId}`)
    .setTitle('参加に関する備考 (任意)');

  const remarksInput = new TextInputBuilder()
    .setCustomId('remarks_input')
    .setLabel(`希望/遅刻/早退など (${MAX_REMARKS_LENGTH}文字以内)`)
    .setStyle(TextInputStyle.Paragraph)
    // ★★★ ご要望に応じてプレースホルダーを修正 ★★★
    .setPlaceholder('例: 22時まで。初心者です。25文字まで。')
    .setMaxLength(MAX_REMARKS_LENGTH)
    .setValue(userData.remarks || '')
    .setRequired(false);

  modal.addComponents(new ActionRowBuilder().addComponents(remarksInput));

  try {
    await interaction.showModal(modal);
  } catch (error) {
    console.error("モーダル表示エラー:", error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "備考入力画面の表示に失敗しました。", ephemeral: true }).catch(() => { });
    } else {
      // モーダル表示失敗時に followUp は通常できない
      console.error("モーダル表示失敗後の応答不可");
    }
  }
}

// モーダル送信処理関数
async function handleModalSubmit(interaction) {
  const customId = interaction.customId;
  // console.log(`モーダル送信処理開始: ${customId}, User: ${interaction.user.tag}`);

  try {
    // ★★★ 最初に deferReply で応答を保留 ★★★
    await interaction.deferReply({ ephemeral: true }); // ephemeral: true で本人にのみ「考え中」表示

    if (!customId.startsWith('submit_remarks_')) {
      console.warn(`不明なモーダルID: ${customId}`);
      // deferReplyした後なので editReply でエラーメッセージを返す
      return await interaction.editReply({ content: '不明なフォームデータを受信しました。', ephemeral: true });
    }

    const recruitmentId = customId.replace('submit_remarks_', '');
    const recruitment = activeRecruitments.get(recruitmentId);

    if (!recruitment || recruitment.status !== 'active') {
      // editReply でエラーメッセージを返す
      return await interaction.editReply({ content: 'この募集は既に終了しているか、存在しません。', ephemeral: true });
    }

    const userData = tempUserData.get(interaction.user.id);
    if (!userData || userData.recruitmentId !== recruitmentId) {
      // editReply でエラーメッセージを返す
      return await interaction.editReply({ content: 'エラー: 参加情報が見つからないか古くなっています。再度「参加申込」ボタンから操作してください。', ephemeral: true });
    }


    const remarks = interaction.fields.getTextInputValue('remarks_input')?.trim() || '';

    const foundNgWord = NG_WORDS.find(ngWord => remarks.toLowerCase().includes(ngWord.toLowerCase()));
    if (foundNgWord) {
      // editReply でエラーメッセージを返す
      return await interaction.editReply({ content: `エラー: 備考に不適切な単語「${foundNgWord}」が含まれています。修正してください。`, ephemeral: true });
    }
    if (remarks.length > MAX_REMARKS_LENGTH) {
      // editReply でエラーメッセージを返す
      return await interaction.editReply({ content: `エラー: 備考が長すぎます (${remarks.length}/${MAX_REMARKS_LENGTH}文字)。`, ephemeral: true });
    }


    // ★★★ 呼び出し方を修正 ★★★
    await confirmParticipation(interaction, recruitmentId, userData.joinType, userData.attributesByRaid, userData.timeAvailability, remarks);

    // 一時データ削除
    tempUserData.delete(interaction.user.id);

  } catch (error) {
    console.error(`モーダル送信処理エラー (ID: ${customId}, User: ${interaction.user.tag}):`, error);
    // deferReply 後なので editReply でエラー応答
    try {
      await interaction.editReply({ content: '備考の処理中にエラーが発生しました。', ephemeral: true });
    } catch (e) {
      console.error("Modal Error editReply Failed:", e.message);
      // editReply も失敗した場合、チャンネルに通知するなど
      try { await interaction.channel.send({ content: `<@${interaction.user.id}> サーバー側再起動中のエラーです。時間を空けて再度登録するか、備考なしで登録後、手動でコメントをお願いします。` }).catch(() => { }); } catch { }
    }
  }
}



// セレクトメニュー処理関数
async function handleSelectMenuInteraction(interaction) {
  const customId = interaction.customId;

  try {
    // 時間選択メニュー (募集作成用)
    if (customId.startsWith('time_select_')) {
      const parts = customId.split('_');
      if (parts.length < 4) throw new Error(`不正な時間選択ID: ${customId}`);
      const raidType = parts[2];
      const date = parts[3];
      const selectedTime = interaction.values[0];
      await confirmRecruitment(interaction, raidType, date, selectedTime);
    }
    // 参加タイプ選択
    else if (customId.startsWith('join_type_')) {
      const recruitmentId = customId.replace('join_type_', '');
      const selectedValues = interaction.values;

      const recruitment = activeRecruitments.get(recruitmentId);
      if (!recruitment || recruitment.status !== 'active') {
        return interaction.update({ content: 'この募集は現在参加を受け付けていません。', embeds: [], components: [] });
      }

      tempUserData.set(interaction.user.id, {
        recruitmentId,
        joinType: '参加者希望',
        attributesByRaid: {},
        raidsToSelect: [],
        selectionIndex: 0,
      });

      const userData = tempUserData.get(interaction.user.id);

      if (selectedValues.includes('なんでも可')) {
        userData.joinType = 'なんでも可';
        userData.raidsToSelect = raidTypes.filter(type => type !== '参加者希望');
      } else {
        userData.joinType = recruitment.type === '参加者希望' ? '参加者希望' : selectedValues[0];
        userData.raidsToSelect = selectedValues;
      }

      await startAttributeSelectionForRaids(interaction, recruitmentId);
    }
    // ★★★ 廃止: attribute_select_ (単一フロー用) は不要になったため削除 ★★★

    // 時間選択 (参加フローの最終段階)
    else if (customId.startsWith('time_availability_select_')) {
      const recruitmentId = customId.replace('time_availability_select_', '');
      const selectedTime = interaction.values[0];
      const userData = tempUserData.get(interaction.user.id);
      if (!userData || userData.recruitmentId !== recruitmentId) {
        throw new Error('時間選択プロセスでユーザーデータが見つかりません。最初からやり直してください。');
      }
      await showJoinConfirmation(interaction, recruitmentId, userData.joinType, [], selectedTime);
    }
    // テスト参加者数選択メニュー
    else if (customId.startsWith('test_participant_count_')) {
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.update({ content: '管理者権限が必要です。', embeds: [], components: [], ephemeral: true });
      const recruitmentId = customId.replace('test_participant_count_', '');
      const count = parseInt(interaction.values[0], 10);
      if (isNaN(count)) throw new Error(`テスト参加者数解析エラー: ${interaction.values[0]}`);
      await showTestParticipantConfirmation(interaction, recruitmentId, count);
    }
    // レイドごとの属性選択メニュー (★すべてのフローがここに統合される★)
    else if (customId.startsWith('attribute_select_per_raid_')) {
      const recruitmentId = customId.replace('attribute_select_per_raid_', '');
      const userData = tempUserData.get(interaction.user.id);
      if (!userData) throw new Error('ユーザーデータが見つかりません');

      const currentRaid = userData.raidsToSelect[userData.selectionIndex];
      let selectedAttrs = interaction.values;
      if (selectedAttrs.includes('all_attributes')) {
        selectedAttrs = [...attributes];
      }

      userData.attributesByRaid[currentRaid] = selectedAttrs;
      userData.selectionIndex++;
      tempUserData.set(interaction.user.id, userData);

      await showNextAttributeSelection(interaction, recruitmentId);
    }
    // 参加者確認用の募集選択
    else if (customId.startsWith('select_recruitment_for_participants_')) {
      const recruitmentId = interaction.values[0];
      await showParticipantsList(interaction, recruitmentId);
    }
    // その他のセレクトメニュー
    else {
      console.warn(`未処理のセレクトメニューID: ${customId}`);
      await interaction.update({ content: 'このメニューは現在処理できません。', components: [] }).catch(e => { if (e.code !== 10062) console.error("Update Error:", e) });
    }
  } catch (error) {
    console.error(`セレクトメニュー処理エラー (ID: ${customId}, User: ${interaction.user.tag}):`, error);
    await handleErrorReply(interaction, error, `メニュー (${customId}) の処理中にエラーが発生しました。`);
  }
}

// 募集開始処理
async function startRecruitment(messageOrInteraction) {
  const row = new ActionRowBuilder()
    .addComponents(
      ...raidTypes.map(type =>
        new ButtonBuilder().setCustomId(`raid_type_${type}`).setLabel(type).setStyle(ButtonStyle.Primary)
      )
    );
  const embed = new EmbedBuilder()
    .setTitle('🔰 高難易度募集作成')
    .setDescription('募集するレイドタイプを選択してください。')
    .setColor('#0099ff');

  const replyMethod = messageOrInteraction.reply || messageOrInteraction.followUp; // メソッドを決定
  let responseMessage;
  try {
    responseMessage = await replyMethod.call(messageOrInteraction, { // callでコンテキストをバインド
      embeds: [embed], components: [row], fetchReply: true
    });
  } catch (error) {
    console.error("募集開始メッセージ送信エラー:", error);
    try {
      await messageOrInteraction.channel.send({ embeds: [embed], components: [row] });
    } catch (sendError) { console.error("募集開始メッセージ送信フォールバックも失敗:", sendError); }
    return;
  }

  // 30分後にボタン無効化
  setTimeout(() => {
    const disabledRow = new ActionRowBuilder()
      .addComponents(
        ...raidTypes.map(type =>
          new ButtonBuilder().setCustomId(`raid_type_${type}_disabled`).setLabel(type).setStyle(ButtonStyle.Secondary).setDisabled(true)
        )
      );
    const timeoutEmbed = new EmbedBuilder()
      .setTitle('🔰 高難易度募集作成（期限切れ）')
      .setDescription('この募集作成セッションは期限切れになりました。\n新しく募集を開始するには `!募集` コマンドを使用してください。')
      .setColor('#FF6B6B').setTimestamp();

    if (responseMessage && responseMessage.editable) {
      responseMessage.edit({ embeds: [timeoutEmbed], components: [disabledRow] }).catch(error => {
        if (error.code !== 10008 && error.code !== 10062) console.error('募集作成UI無効化エラー:', error);
        else console.log("募集作成UIメッセージが見つからないか操作不能のため、無効化をスキップ。");
      });
      // debugLog('RecruitmentUI', `募集作成UI(${responseMessage.id})を無効化（タイムアウト）`);
    } else {
      console.warn("募集作成UIメッセージの編集不可。");
    }
  }, 30 * 60 * 1000);
}

// 日付選択UI表示
async function showDateSelection(interaction, raidType) {
  const dateButtons = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  // ★★★ ご要望に応じて当日を除外し、翌日以降の募集にする ★★★
  for (let i = 1; i <= 7; i++) {
    const date = new Date(today); date.setDate(today.getDate() + i);
    const dateString = date.toISOString().split('T')[0];
    const displayDate = `${date.getMonth() + 1}/${date.getDate()}(${['日', '月', '火', '水', '木', '金', '土'][date.getDay()]})`;
    dateButtons.push(new ButtonBuilder().setCustomId(`date_select_${raidType}_${dateString}`).setLabel(displayDate).setStyle(ButtonStyle.Secondary));
  }
  const rows = [];
  for (let i = 0; i < dateButtons.length; i += 5) rows.push(new ActionRowBuilder().addComponents(dateButtons.slice(i, Math.min(i + 5, dateButtons.length))));
  const embed = new EmbedBuilder().setTitle(`📅 ${raidType}募集 - 日付選択`).setDescription('開催したい日付を選択してください。').setColor('#0099ff');
  await interaction.update({ embeds: [embed], components: rows }).catch(e => { if (e.code !== 10062) console.error("Date Selection Update Error:", e) });
}

// 時間選択UI表示
async function showTimeSelection(interaction, raidType, date) {
  const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`time_select_${raidType}_${date}`).setPlaceholder('開催時間を選択').addOptions(timeOptions));
  // JSTで日付表示
  const dateObj = new Date(date + 'T00:00:00Z'); // UTCとしてパース
  const formattedDate = dateObj.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const embed = new EmbedBuilder().setTitle(`⏰ ${raidType}募集 - 時間選択`).setDescription(`選択した日付: ${formattedDate}\n開催時間を選択してください。`).setColor('#0099ff');
  await interaction.update({ embeds: [embed], components: [row] }).catch(e => { if (e.code !== 10062) console.error("Time Selection Update Error:", e) });
}

// 募集確認UI表示
async function confirmRecruitment(interaction, raidType, date, time) {
  const dateObj = new Date(date + 'T00:00:00Z');
  const formattedDate = dateObj.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const recruitmentId = generateUniqueId();
  debugLog('RecruitmentConfirm', `募集確認UI表示 - ID: ${recruitmentId}`);
  const embed = new EmbedBuilder().setTitle('🔍 募集内容確認').setDescription('以下の内容で募集を開始しますか？').setColor('#0099ff')
    .addFields({ name: 'レイド', value: raidType, inline: true }, { name: '開催日', value: formattedDate, inline: true }, { name: '時間', value: time, inline: true }, { name: '募集者', value: interaction.user.toString(), inline: false })
    .setFooter({ text: `よろしければ「確定」を押してください。` });
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_recruitment_${recruitmentId}`).setLabel('確定').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('cancel_recruitment').setLabel('キャンセル').setStyle(ButtonStyle.Danger));
  const recruitmentData = { id: recruitmentId, type: raidType, date: date, time: time, creator: interaction.user.id, creatorUsername: interaction.user.username, participants: [], status: 'pending', channel: interaction.channelId, messageId: null, createdAt: new Date().toISOString(), finalTime: null, finalRaidType: null };
  activeRecruitments.set(recruitmentId, recruitmentData);
  await interaction.update({ embeds: [embed], components: [row] }).catch(e => { if (e.code !== 10062) console.error("Confirm Recruitment Update Error:", e) });
}

// 募集確定処理 (新規メッセージとして投稿)
async function finalizeRecruitment(interaction, recruitmentId) {
  debugLog('RecruitmentFinalize', `処理開始: ${recruitmentId}`);
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'pending') {
    console.error(`募集データ不備: ${recruitmentId}, Status: ${recruitment?.status}`);
    return await interaction.update({ content: 'エラー: 募集データが見つからないか処理済みです。', embeds: [], components: [] }).catch(e => { if (e.code !== 10062) console.error("Finalize Update Error:", e) });
  }
  recruitment.status = 'active';
  const dateObj = new Date(recruitment.date + 'T00:00:00Z');
  const formattedDate = dateObj.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
  const embed = createRecruitmentEmbed(recruitment, formattedDate);
  const joinRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`join_recruitment_${recruitmentId}`).setLabel('参加申込').setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`cancel_participation_${recruitmentId}`).setLabel('参加キャンセル').setStyle(ButtonStyle.Secondary), new ButtonBuilder().setCustomId(`close_recruitment_${recruitmentId}`).setLabel('締切(募集者用)').setStyle(ButtonStyle.Danger));
  const components = [joinRow];
  if (testMode.active) components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`add_test_participants_${recruitmentId}`).setLabel('🧪テスト参加者追加(管理)').setStyle(ButtonStyle.Secondary)));
  try {
    await interaction.update({ content: '募集を作成しました！', embeds: [], components: [] }).catch(e => { if (e.code !== 10062) console.error("Finalize Interaction Update Error:", e) });
    const channel = await client.channels.fetch(interaction.channelId);
    if (!channel || !channel.isTextBased()) throw new Error(`チャンネル取得失敗: ${interaction.channelId}`);
    // ★★★ ロールIDを設定 ★★★ (不要なら null または削除)
    const mentionRoleId = process.env.MENTION_ROLE_ID || null; // 環境変数から取得、なければ null
    const contentText = `**【${recruitment.type} 募集中】** ${mentionRoleId ? `<@&${mentionRoleId}> ` : ''}` +
      `${formattedDate} ${recruitment.time} 開始予定 ` +
      `(募集者: <@${recruitment.creator}>)`;
    const recruitMessage = await channel.send({
      content: contentText,
      embeds: [embed],
      components: components,
      allowedMentions: mentionRoleId ? { roles: [mentionRoleId] } : { parse: ['users'] } // ロールメンション許可
    });
    recruitment.messageId = recruitMessage.id;
    activeRecruitments.set(recruitmentId, recruitment);
    debugLog('RecruitmentFinalize', `募集確定完了: ID=${recruitmentId}, MsgID=${recruitment.messageId}`);
    saveRecruitmentData();
  } catch (error) {
    console.error('募集確定エラー:', error);
    await interaction.followUp({ content: '募集メッセージ作成中にエラーが発生しました。', ephemeral: true }).catch(e => console.error("Finalize Error FollowUp Failed:", e.message));
    activeRecruitments.delete(recruitmentId);
    debugLog('RecruitmentFinalize', `エラーのため募集データ削除: ${recruitmentId}`);
  }
}

// 募集用エンベッド作成ヘルパー関数
function createRecruitmentEmbed(recruitment, formattedDate) {
  const embed = new EmbedBuilder()
    .setTitle(`📢 【${recruitment.type}】${formattedDate} ${recruitment.time}`)
    .setDescription(`募集者: <@${recruitment.creator}>\n\n参加希望者は「参加申込」ボタンからどうぞ！`)
    .setColor('#3498DB')
    .setFooter({ text: `募集ID: ${recruitment.id} | 開催日 朝8時に自動締切` });
  attributes.forEach(attr => embed.addFields({ name: `【${attr}】`, value: '?', inline: true }));
  return embed;
}

// 参加オプション表示
async function showJoinOptions(interaction, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') return interaction.reply({ content: 'この募集は現在参加を受け付けていません。', ephemeral: true });

  const existingParticipation = recruitment.participants.find(p => p.userId === interaction.user.id);
  // ★★★ エラーメッセージをより具体的に修正 ★★★
  if (existingParticipation) return interaction.reply({ content: `✅ 参加表明済みです。\n変更したい場合は、一度「参加キャンセル」ボタンでキャンセルしてから、再度申込してください。`, ephemeral: true });

  const dateObj = new Date(recruitment.date + 'T00:00:00Z');
  const formattedDate = dateObj.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'long', day: 'numeric', weekday: 'short' });

  let components;
  let embedDescription = `【${recruitment.type}】${formattedDate} ${recruitment.time}\n\n`;

  // ★★★ 「参加者希望」の場合のロジックを全面的に書き換え ★★★
  if (recruitment.type === '参加者希望') {
    embedDescription += '参加を希望するレイドを**すべて選択**してください。\n「どれでも可」を選択した場合は、他のレイドも選択している場合でも「どれでも可」として扱われます。';

    const availableRaids = raidTypes.filter(type => type !== '参加者希望');
    const selectOptions = availableRaids.map(type => ({
      label: type,
      value: type
    }));
    // 「どちらでも可」の選択肢をリストの最後に追加
    selectOptions.push({ label: 'どれでも可', value: 'なんでも可' });

    const menu = new StringSelectMenuBuilder()
      .setCustomId(`join_type_${recruitmentId}`)
      .setPlaceholder('参加したいレイドを選択 (複数可)')
      .addOptions(selectOptions)
      .setMinValues(1)
      .setMaxValues(selectOptions.length); // 選択肢の数だけ選択可能にする

    components = [new ActionRowBuilder().addComponents(menu)];

  } else {
    embedDescription += `この募集 (${recruitment.type}) に参加しますか？`;
    const selectOptions = [{ label: `${recruitment.type} に参加`, value: recruitment.type }];
    const menu = new StringSelectMenuBuilder()
      .setCustomId(`join_type_${recruitmentId}`)
      .setPlaceholder(`${recruitment.type} に参加`)
      .addOptions(selectOptions);
    components = [new ActionRowBuilder().addComponents(menu)];
  }

  const embed = new EmbedBuilder().setTitle('🎮 参加申込').setDescription(embedDescription).setColor('#2ECC71');
  await interaction.reply({ embeds: [embed], components: components, ephemeral: true });
}
// レイドごとの属性選択プロセスを開始する関数
async function startAttributeSelectionForRaids(interaction, recruitmentId) {
  const userData = tempUserData.get(interaction.user.id);
  if (!userData || userData.raidsToSelect.length === 0) {
    return interaction.update({ content: 'エラー: 希望レイドが選択されていません。', embeds: [], components: [] });
  }
  // 最初のレイドの属性選択画面を呼び出す
  await showNextAttributeSelection(interaction, recruitmentId);
}

// 次のレイドの属性選択UIを表示する関数
async function showNextAttributeSelection(interaction, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: 'この募集は処理中に締め切られました。', ephemeral: true });
    } else {
      await interaction.editReply({ content: 'この募集は処理中に締め切られました。', embeds: [], components: [] });
    }
    return;
  }

  const userData = tempUserData.get(interaction.user.id);
  const { selectionIndex, raidsToSelect } = userData;

  if (selectionIndex >= raidsToSelect.length) {
    // 全ての属性選択が完了したので、時間選択に進む
    await showTimeAvailabilitySelection(interaction, recruitmentId);
    return;
  }

  const currentRaid = raidsToSelect[selectionIndex];
  const attributeOptions = [
    { label: '全属性', value: 'all_attributes', description: 'すべての属性で参加可能です' },
    ...attributes.map(attr => ({ label: attr, value: attr }))
  ];

  const embed = new EmbedBuilder()
    .setTitle(`【${selectionIndex + 1}/${raidsToSelect.length}】 ${currentRaid} の希望属性`)
    .setDescription(`**${currentRaid}** で担当可能な属性をすべて選択してください。`)
    .setColor('#2ECC71');

  const menu = new StringSelectMenuBuilder()
    .setCustomId(`attribute_select_per_raid_${recruitmentId}`)
    .setPlaceholder('担当可能な属性を選択 (複数可)')
    .addOptions(attributeOptions)
    .setMinValues(1)
    .setMaxValues(attributeOptions.length);

  if (!interaction.replied && !interaction.deferred) {
    await interaction.reply({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
  } else {
    await interaction.update({ embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] });
  }
}


// 参加可能時間選択UI表示
async function showTimeAvailabilitySelection(interaction, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return interaction.update({ content: 'この募集は現在参加を受け付けていません。', embeds: [], components: [] }).catch(e => { if (e.code !== 10062) console.error("Time Select Update Error:", e) });
  }

  // ★★★ 不要な引数を削除し、tempUserData を正として処理 ★★★
  const userData = tempUserData.get(interaction.user.id);
  if (!userData) {
    throw new Error('時間選択プロセスでユーザーデータが見つかりません。');
  }
  // recruitmentId を念のため更新
  userData.recruitmentId = recruitmentId;
  tempUserData.set(interaction.user.id, userData);

  const timeSelectOptions = [{ label: '今すぐ参加可能', value: 'now', description: '募集開始時刻に関わらず参加' }];
  for (let i = 19; i <= 23; i++) {
    const hour = i.toString().padStart(2, '0');
    timeSelectOptions.push({ label: `${hour}:00 以降参加可能`, value: `${hour}:00` });
  }

  let descriptionText = `選択した希望レイド:\n`;
  descriptionText += Object.keys(userData.attributesByRaid).map(raid => `- ${raid}`).join('\n');
  descriptionText += `\n\n参加可能な最も早い時間を選択してください。(募集開始: ${recruitment.time})`;

  const customId = `time_availability_select_${recruitmentId}`;
  const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder('参加可能な最も早い時間を選択').addOptions(timeSelectOptions));
  const embed = new EmbedBuilder()
    .setTitle('⏰ 参加可能時間の選択')
    .setDescription(descriptionText)
    .setColor('#2ECC71');

  await interaction.update({ embeds: [embed], components: [row] }).catch(e => { if (e.code !== 10062) console.error("Time Select Update Error:", e) });
}

// 参加確認UI表示 (備考入力ボタン付き)
async function showJoinConfirmation(interaction, recruitmentId, joinType, selectedAttributes, timeAvailability) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') return interaction.update({ content: 'この募集は現在参加を受け付けていません。', embeds: [], components: [] }).catch(e => { if (e.code !== 10062) console.error("Join Confirm Update Error:", e) });

  // ★★★ userData の取得と表示を修正 ★★★
  const currentData = tempUserData.get(interaction.user.id) || {};
  tempUserData.set(interaction.user.id, { ...currentData, timeAvailability: timeAvailability, remarks: currentData.remarks || '' });

  const userData = tempUserData.get(interaction.user.id);
  const finalJoinType = userData.joinType;
  const finalAttributesByRaid = userData.attributesByRaid;

  const embed = new EmbedBuilder().setTitle('✅ 参加申込内容 確認').setDescription('以下の内容で参加を申し込みます。よろしければ下のボタンを押してください。').setColor('#2ECC71')
    .addFields(
      { name: '募集', value: `${recruitment.type} (${recruitment.date} ${recruitment.time})`, inline: false },
      { name: '参加タイプ', value: finalJoinType, inline: true },
      { name: '参加可能時間', value: timeAvailability, inline: true }
    );

  let attrDescription = Object.entries(finalAttributesByRaid)
    .map(([raid, attrs]) => `**${raid}**: ${attrs.join(', ')}`)
    .join('\n');
  if (attrDescription.length > 1024) attrDescription = attrDescription.substring(0, 1021) + '...';
  if (attrDescription) {
    embed.addFields({ name: '担当可能属性', value: attrDescription, inline: false });
  }

  embed.setFooter({ text: '備考は「備考入力～」、なければ「参加確定(備考なし)」を' });
  const openRemarksModalBtnId = `open_remarks_modal_${recruitmentId}`;
  const confirmDirectlyBtnId = `confirm_direct_${recruitmentId}`;
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(openRemarksModalBtnId).setLabel('備考入力して参加確定').setStyle(ButtonStyle.Primary).setEmoji('📝'), new ButtonBuilder().setCustomId(confirmDirectlyBtnId).setLabel('参加確定 (備考なし)').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('cancel_join').setLabel('キャンセル').setStyle(ButtonStyle.Danger));
  await interaction.update({ embeds: [embed], components: [row] }).catch(e => { if (e.code !== 10062) console.error("Join Confirm Update Error:", e) });
}


// ★★★【重要】参加者データ構造を修正した関数 ★★★
async function confirmParticipation(interaction, recruitmentId, joinType, attributesByRaid, timeAvailability, remarks = '') {
  debugLog('ConfirmParticipation', `参加確定処理: ${recruitmentId}, User: ${interaction.user.tag}`);

  const recruitment = activeRecruitments.get(recruitmentId);

  if (!recruitment || recruitment.status !== 'active') {
    const replyOptions = { content: 'この募集は既に終了しているか、存在しません。', ephemeral: true };
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply(replyOptions);
      else await interaction.reply(replyOptions);
    } catch (e) { console.error("参加確定前チェックエラー応答失敗:", e.message); }
    return;
  }

  try {
    let member = interaction.member;
    const user = interaction.user;

    if (interaction.guild && (!member || !member.displayName)) {
      console.log(`[User Info] Member data for ${user.id} might be incomplete. Fetching from guild...`);
      try {
        member = await interaction.guild.members.fetch(user.id);
      } catch (fetchError) {
        console.error(`[User Info] Failed to fetch member ${user.id}:`, fetchError);
      }
    }

    const usernameToSave = member?.displayName || user.username;
    console.log(`[User Info] User: ${user.username}, Determined display name: ${usernameToSave}`);

    const participantData = {
      userId: user.id,
      username: usernameToSave,
      joinType: joinType,
      attributesByRaid: attributesByRaid, // ← 新しいデータ構造
      timeAvailability: timeAvailability,
      remarks: remarks || '',
      assignedAttribute: null,
      isTestParticipant: false
    };

    const existingIndex = recruitment.participants.findIndex(p => p.userId === user.id);
    if (existingIndex >= 0) {
      recruitment.participants[existingIndex] = participantData;
      debugLog('ConfirmParticipation', `既存参加者情報を更新: ${usernameToSave}`);
    } else {
      recruitment.participants.push(participantData);
      debugLog('ConfirmParticipation', `新規参加者を追加: ${usernameToSave}`);
    }

  } catch (error) {
    console.error(`Error during confirmParticipation for user ${interaction.user.id}:`, error);
    await handleErrorReply(interaction, error, '参加情報の登録中にサーバーエラーが発生しました。');
    return;
  }

  await updateRecruitmentMessage(recruitment);

  let replyContent = '✅ 参加申込が完了しました！\n';
  let attrText = Object.entries(attributesByRaid).map(([raid, attrs]) => `${raid}: ${attrs.join('/')}`).join(', ');
  replyContent += `タイプ: ${joinType}, 属性: ${attrText}, 時間: ${timeAvailability}` + (remarks ? `\n📝 備考: ${remarks}` : '');

  const replyOptions = {
    content: replyContent,
    embeds: [], components: [], ephemeral: true
  };
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(replyOptions);
    } else {
      console.warn("[ConfirmParticipation] Interaction was not deferred/replied before sending completion message.");
      await interaction.reply(replyOptions);
    }
  } catch (error) {
    console.error("参加完了メッセージ送信(editReply/reply)エラー:", error);
    try { await interaction.channel.send({ content: `<@${interaction.user.id}> 参加申込は処理されましたが、完了メッセージの表示に失敗しました。(${error.code || '詳細不明'})` }).catch(() => { }); } catch { }
  }

  saveRecruitmentData();
}





// 参加キャンセル処理
async function cancelParticipation(interaction, recruitmentId) {
  debugLog('CancelParticipation', `参加キャンセル処理: ${recruitmentId}, User: ${interaction.user.tag}`);
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) return interaction.reply({ content: 'キャンセル対象の募集が見つかりません。', ephemeral: true });
  const participantIndex = recruitment.participants.findIndex(p => p.userId === interaction.user.id);
  if (participantIndex === -1) return interaction.reply({ content: 'あなたはこの募集に参加していません。', ephemeral: true });
  const removedParticipant = recruitment.participants.splice(participantIndex, 1)[0];
  debugLog('CancelParticipation', `参加者を削除: ${removedParticipant.username}, 残り: ${recruitment.participants.length}`);
  // 締め切り後のキャンセルは不可にする
  if (recruitment.status === 'closed' || recruitment.status === 'assigned') {
    recruitment.participants.splice(participantIndex, 0, removedParticipant); // 戻す
    return await interaction.reply({ content: '募集は既に締め切られているため、参加キャンセルできません。', ephemeral: true });
  }
  try { await updateRecruitmentMessage(recruitment); }
  catch (updateError) { console.error("参加キャンセル後のメッセージ更新エラー:", updateError); }
  await interaction.reply({ content: '参加表明をキャンセルしました。', ephemeral: true });
  saveRecruitmentData();
}

// 未割り当て参加者の詳細リスト生成ヘルパー
function formatUnassignedList(participants) {
  if (!participants || participants.length === 0) return '';

  return participants.map(p => {
    let info = `- <@${p.userId}>`;

    // 希望レイドと属性の表示
    let requestInfo = [];
    if (p.joinType === 'なんでも可') {
      requestInfo.push('なんでも可');
    } else if (p.attributesByRaid) {
      Object.entries(p.attributesByRaid).forEach(([raid, attrs]) => {
        requestInfo.push(`${raid}:[${attrs.join('/')}]`);
      });
    } else if (p.attributes) {
      requestInfo.push(`[${p.attributes.join('/')}]`);
    }

    if (requestInfo.length > 0) info += ` (希望: ${requestInfo.join(', ')})`;

    // 備考の表示
    if (p.remarks && p.remarks.trim() !== '') {
      info += ` (📝 ${p.remarks})`;
    }

    return info;
  }).join('\n');
}

// 募集締め切り処理
async function closeRecruitment(interaction, recruitmentId) {
  debugLog('CloseRecruitment', `募集締め切り処理: ${recruitmentId}, User: ${interaction.user.tag}`);
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) {
    debugLog('CloseRecruitment', `エラー: ID ${recruitmentId} がMapに見つかりません。`);
    return await interaction.reply({ content: `締め切り対象の募集(ID: ${recruitmentId})が見つかりません。IDが正しいか、募集が削除されていないか確認してください。`, ephemeral: true });
  }
  const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
  if (interaction.user.id !== recruitment.creator && !isAdmin) return interaction.reply({ content: '募集者または管理者のみ締め切れます。', ephemeral: true });
  if (recruitment.status === 'closed' || recruitment.status === 'assigned') return interaction.reply({ content: 'この募集は既に締め切られています。', ephemeral: true });

  if (isAdmin && interaction.user.id !== recruitment.creator) debugLog('CloseRecruitment', `管理者(${interaction.user.tag})による強制締め切り`);

  recruitment.status = 'closed';
  debugLog('CloseRecruitment', `ステータスを 'closed' に変更: ${recruitmentId}, 参加者数: ${recruitment.participants.length}`);
  try {
    await autoAssignAttributes(recruitment, false); // 実際の割り振り
  } catch (assignError) {
    console.error(`属性割り振りエラー (ID: ${recruitmentId}):`, assignError);
    await interaction.reply({ content: '募集を締め切りましたが、属性の自動割り振りに失敗しました。手動調整してください。', ephemeral: true }).catch(() => { });
    activeRecruitments.set(recruitmentId, recruitment);
    await updateRecruitmentMessage(recruitment);
    saveRecruitmentData();
    return;
  }
  try { await updateRecruitmentMessage(recruitment); }
  catch (updateError) { console.error("締め切り後のメッセージ更新エラー:", updateError); }
  await interaction.reply({ content: '募集を締め切り、参加者の割り振りを行いました。', ephemeral: true });

  try {
    const channel = await client.channels.fetch(recruitment.channel).catch(() => null);
    if (channel && channel.isTextBased()) {
      let assignedText = `**【${recruitment.finalRaidType || recruitment.type} 募集締切】**\n` +
        `ID: ${recruitment.id}\n` +
        `開催予定: ${recruitment.finalTime || recruitment.time}\n` +
        `参加者 (${recruitment.participants.length}名) の割り振りが完了しました。\n`;

      const assignedParticipants = recruitment.participants.filter(p => p?.assignedAttribute);
      const unassignedParticipants = recruitment.participants.filter(p => !p?.assignedAttribute);

      attributes.forEach(attr => {
        const p = assignedParticipants.find(pt => pt?.assignedAttribute === attr);
        let participantText = '空き';
        if (p) {
          participantText = `<@${p.userId}>`;
          if (p.remarks) {
            participantText += ` (📝 ${p.remarks})`; // 備考を全文表示
          }
        }
        assignedText += `【${attr}】: ${participantText}\n`;
      });

      if (unassignedParticipants.length > 0) {
        assignedText += `\n**※以下の参加者は今回割り当てられませんでした:**\n`;
        assignedText += formatUnassignedList(unassignedParticipants);
      }

      const realUserIdsToMention = assignedParticipants.map(p => p.userId).filter(userId => /^\d+$/.test(userId));
      await channel.send({ content: assignedText, allowedMentions: { users: realUserIdsToMention } });
    }
  } catch (notifyError) { console.error("割り振り結果通知エラー:", notifyError); }

  saveRecruitmentData();
}

// 募集メッセージ更新処理
async function updateRecruitmentMessage(recruitment) {
  if (!recruitment || !recruitment.channel || !recruitment.messageId) {
    console.error("メッセージ更新に必要な情報が不足:", recruitment); return;
  }
  try {
    const channel = await client.channels.fetch(recruitment.channel);
    if (!channel || !channel.isTextBased()) {
      console.error(`チャンネル取得失敗: ${recruitment.channel}`); return;
    }
    let message;
    try { message = await channel.messages.fetch(recruitment.messageId); }
    catch (fetchError) {
      if (fetchError.code === 10008) {
        console.warn(`募集メッセージが見つかりません: ${recruitment.messageId}`);
        activeRecruitments.delete(recruitment.id);
        console.log(`存在しないメッセージの募集データ ${recruitment.id} を削除`);
        saveRecruitmentData(); return;
      }
      console.error(`メッセージ取得エラー (ID: ${recruitment.messageId}):`, fetchError); return;
    }
    const dateObj = new Date(recruitment.date + 'T00:00:00Z');
    const formattedDate = dateObj.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
    let description = `募集者: <@${recruitment.creator}>\n\n`; let contentText = '';

    if (recruitment.status === 'active') {
      contentText = `**【${recruitment.type} 募集中】** ${formattedDate} ${recruitment.time} 開始予定`;
      description += `🟢 **募集中** (現在 ${recruitment.participants.length} 名)\n` +
        `参加希望者は「参加申込」ボタンからどうぞ！\n\n`;
    } else if (recruitment.status === 'closed' || recruitment.status === 'assigned') {
      contentText = `**【${recruitment.finalRaidType || recruitment.type} 募集終了】** ${formattedDate} ${recruitment.finalTime || recruitment.time} 開始予定`;
      description += `🔴 **募集終了** (参加者: ${recruitment.participants.length}名)\n`;
      if (recruitment.type === '参加者希望' && recruitment.finalRaidType) description += `**実施コンテンツ: ${recruitment.finalRaidType}**\n`;
      if (recruitment.finalTime && recruitment.finalTime !== recruitment.time) description += `**最終開始時間: ${recruitment.finalTime}**\n`;
      description += '\n参加者の割り振りは以下の通りです。\n\n';
    } else {
      contentText = `**【${recruitment.type} 準備中/エラー】**`;
      description += `⚠️ 状態: ${recruitment.status}\n`;
    }

    if (recruitment.status === 'active' && recruitment.participants.length > 0) {
      description += '**【現在の参加表明者】**\n';
      recruitment.participants.forEach(p => {
        // ★★★ 表示方法を修正 ★★★
        let attrText = '';
        if (p.joinType === 'なんでも可' && p.attributesByRaid) {
          const firstKey = Object.keys(p.attributesByRaid)[0];
          if (firstKey) attrText = `[${p.attributesByRaid[firstKey].join('/')}]`;
        } else if (p.attributesByRaid) {
          attrText = `[${Object.keys(p.attributesByRaid).join('/')}]`;
        } else if (p.attributes) { // 古いデータ形式のためのフォールバック
          attrText = `[${p.attributes.join('/')}]`
        }

        description += `- <@${p.userId}> ${p.joinType} ${attrText} (${p.timeAvailability})`;
        if (p.remarks) description += ` *備考: ${p.remarks}*`;
        description += '\n';
      });
      description += '\n';
    }

    const embed = new EmbedBuilder()
      .setTitle(`${recruitment.status === 'active' ? '📢' : '🏁'} 【${recruitment.type}】${formattedDate} ${recruitment.time}`)
      .setDescription(description)
      .setColor(recruitment.status === 'active' ? '#3498DB' : (recruitment.status === 'assigned' || recruitment.status === 'closed' ? '#E74C3C' : '#F1C40F'))
      .setTimestamp()
      .setFooter({ text: `募集ID: ${recruitment.id} | ${recruitment.status === 'active' ? `開催日 朝8時に自動締切 (${recruitment.participants.length}名)` : `募集終了 (${recruitment.participants.length}名)`}` });

    const fields = [];
    attributes.forEach(attr => {
      let value = '－'; let assignedParticipant = null;
      if (recruitment.status === 'closed' || recruitment.status === 'assigned') {
        assignedParticipant = recruitment.participants.find(p => p.assignedAttribute === attr);
        if (assignedParticipant) value = `<@${assignedParticipant.userId}>${assignedParticipant.remarks ? ' 📝' : ''}`;
        else value = '空き';
      } else if (recruitment.status === 'active') {
        // ★★★ 希望者カウントのロジックを修正 ★★★
        const hopefuls = recruitment.participants.filter(p => {
          if (!p.attributesByRaid) { // 古いデータ形式のフォールバック
            return p.attributes && p.attributes.includes(attr);
          }
          return Object.values(p.attributesByRaid).some(attrs => attrs.includes(attr));
        });
        if (hopefuls.length > 0) value = hopefuls.length <= 2 ? hopefuls.map(p => `<@${p.userId}>`).join('\n') : `${hopefuls.length}名`;
        else value = '－';
      }
      fields.push({ name: `【${attr}】`, value: value, inline: true });
    });
    embed.addFields(fields);

    const joinRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`join_recruitment_${recruitment.id}`).setLabel('参加申込').setStyle(ButtonStyle.Primary).setDisabled(recruitment.status !== 'active'), new ButtonBuilder().setCustomId(`cancel_participation_${recruitment.id}`).setLabel('参加キャンセル').setStyle(ButtonStyle.Secondary).setDisabled(recruitment.status !== 'active'), new ButtonBuilder().setCustomId(`close_recruitment_${recruitment.id}`).setLabel('募集締め切り').setStyle(ButtonStyle.Danger).setDisabled(recruitment.status !== 'active'));
    const components = [joinRow];
    if (testMode.active && recruitment.status === 'active') {
      components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`add_test_participants_${recruitment.id}`).setLabel('🧪テスト追加(管理)').setStyle(ButtonStyle.Secondary).setDisabled(recruitment.status !== 'active')));
    }
    await message.edit({ content: contentText, embeds: [embed], components: components });
  } catch (error) {
    if (error.code !== 10008) console.error(`募集メッセージ ${recruitment?.messageId} 更新エラー:`, error);
  }
}

// 属性自動割り振り処理
async function autoAssignAttributes(recruitment, previewOnly = false) {
  debugLog('AutoAssign', `属性自動割り振り開始: ${recruitment.id}, Participants: ${recruitment.participants.length}, Preview: ${previewOnly}`);

  if (recruitment.participants.length === 0) {
    debugLog('AutoAssign', '参加者0名、スキップ');
    if (!previewOnly) { recruitment.status = 'closed'; recruitment.finalTime = recruitment.time; recruitment.finalRaidType = recruitment.type; }
    return recruitment;
  }

  if (!previewOnly) { recruitment.status = 'assigned'; debugLog('AutoAssign', `ステータスを 'assigned' に変更`); }
  else { debugLog('AutoAssign', `プレビューモード (ステータス: ${recruitment.status})`); }

  recruitment.participants.forEach(p => p.assignedAttribute = null);

  let finalRaidType = recruitment.type;
  if (recruitment.type === '参加者希望') {
    const votes = {};
    const availableRaids = raidTypes.filter(type => type !== '参加者希望');
    availableRaids.forEach(raid => { votes[raid] = 0; });

    recruitment.participants.forEach(p => {
      if (p.joinType === 'なんでも可') {
        availableRaids.forEach(raid => { votes[raid] += 0.5; });
      } else if (p.attributesByRaid) {
        Object.keys(p.attributesByRaid).forEach(raidKey => {
          if (votes.hasOwnProperty(raidKey)) {
            votes[raidKey] += 1 / Object.keys(p.attributesByRaid).length; // 複数希望の場合は票を分割
          }
        })
      }
    });

    let maxVotes = -1;
    let winningRaids = [];
    for (const raid in votes) {
      if (votes[raid] > maxVotes) {
        maxVotes = votes[raid];
        winningRaids = [raid];
      } else if (votes[raid] === maxVotes) {
        winningRaids.push(raid);
      }
    }

    if (maxVotes <= 0) {
      finalRaidType = availableRaids[0] || recruitment.type;
    } else {
      finalRaidType = winningRaids[0];
    }

    const voteLog = Object.entries(votes).map(([k, v]) => `${k}: ${v.toFixed(2)}`).join(', ');
    debugLog('AutoAssign', `決定レイドタイプ: ${finalRaidType} (投票結果: ${voteLog})`);
  }
  recruitment.finalRaidType = finalRaidType;

  // ★★★ 割り振り対象者と属性の選定ロジックを修正 ★★★
  const eligibleParticipants = recruitment.participants.filter(p => {
    if (p.joinType === 'なんでも可') return true;
    if (p.attributesByRaid && p.attributesByRaid[finalRaidType]) return true;
    return false;
  }).map(p => {
    const targetAttributes = (p.joinType === 'なんでも可' && p.attributesByRaid)
      ? (Object.values(p.attributesByRaid)[0] || [])
      : (p.attributesByRaid ? p.attributesByRaid[finalRaidType] : p.attributes) || [];

    return { ...p, attributes: targetAttributes, originalAttributes: targetAttributes, assignedAttribute: null };
  });

  debugLog('AutoAssign', `割り振り対象者数: ${eligibleParticipants.length}名 (タイプ: ${finalRaidType})`);
  if (eligibleParticipants.length === 0) {
    debugLog('AutoAssign', '割り振り対象者なし');
    if (!previewOnly) { recruitment.status = 'closed'; recruitment.finalTime = recruitment.time; }
    return recruitment;
  }

  const timeOrder = { 'now': 0, '00:00': 1, '01:00': 2, '02:00': 3, '03:00': 4, '04:00': 5, '05:00': 6, '06:00': 7, '07:00': 8, '08:00': 9, '09:00': 10, '10:00': 11, '11:00': 12, '12:00': 13, '13:00': 14, '14:00': 15, '15:00': 16, '16:00': 17, '17:00': 18, '18:00': 19, '19:00': 20, '20:00': 21, '21:00': 22, '22:00': 23, '23:00': 24 };
  let latestTimeSlot = 'now'; let latestTimeValue = 0;
  eligibleParticipants.forEach(p => { const timeValue = timeOrder[p.timeAvailability] ?? -1; if (timeValue > latestTimeValue) { latestTimeValue = timeValue; latestTimeSlot = p.timeAvailability; } });
  recruitment.finalTime = latestTimeSlot;
  debugLog('AutoAssign', `決定開催時間: ${latestTimeSlot}`);

  const assignments = {}; const attributeCounts = {};
  attributes.forEach(attr => attributeCounts[attr] = 0);
  eligibleParticipants.forEach(p => p.attributes.forEach(attr => { if (attributeCounts[attr] !== undefined) attributeCounts[attr]++; }));

  eligibleParticipants.forEach(p => {
    p.attributeScores = {}; p.attributes.forEach(attr => p.attributeScores[attr] = 1 / Math.max(1, attributeCounts[attr]));
    p.priorityScore = (10 / Math.max(1, p.attributes.length)) + Math.max(0, ...p.attributes.map(attr => p.attributeScores[attr] || 0));
  });
  eligibleParticipants.sort((a, b) => b.priorityScore - a.priorityScore);

  const assignedUserIds = new Set();
  attributes.forEach(attr => {
    const candidates = eligibleParticipants.filter(p => !assignedUserIds.has(p.userId) && p.attributes.includes(attr));
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.priorityScore - a.priorityScore);
      const chosenParticipant = candidates[0];
      assignments[attr] = chosenParticipant;
      chosenParticipant.assignedAttribute = attr;
      assignedUserIds.add(chosenParticipant.userId);
      debugLog('AutoAssign', `${chosenParticipant.username} -> ${attr}`);
    }
  });

  const unassignedParticipants = eligibleParticipants.filter(p => !assignedUserIds.has(p.userId));
  if (unassignedParticipants.length > 0) {
    debugLog('AutoAssign', `※未割り当て参加者 (${unassignedParticipants.length}名): ${unassignedParticipants.map(p => p.username).join(', ')}`);
  }
  const emptyAttributes = attributes.filter(attr => !assignments[attr]);
  if (emptyAttributes.length > 0) {
    debugLog('AutoAssign', `空き属性: ${emptyAttributes.join(', ')}`);
  }

  if (!previewOnly) {
    recruitment.participants.forEach(p => {
      const assignedInfo = eligibleParticipants.find(ep => ep.userId === p.userId);
      p.assignedAttribute = assignedInfo?.assignedAttribute || null;
    });
    debugLog('AutoAssign', '最終割り当て結果を反映しました。');
  } else {
    recruitment.participants.forEach(p => {
      const assignedInfo = eligibleParticipants.find(ep => ep.userId === p.userId);
      p.assignedAttribute = assignedInfo?.assignedAttribute || null;
    });
    debugLog('AutoAssign', 'プレビュー用に一時割り当て。');
  }
  return recruitment;
}


// 自動締め切りチェック処理
function checkAutomaticClosing() {
  const now = new Date();
  const activeRecruitmentEntries = Array.from(activeRecruitments.entries()).filter(([id, r]) => r?.status === 'active');

  if (activeRecruitmentEntries.length === 0) return;

  activeRecruitmentEntries.forEach(async ([id, recruitment]) => {
    try {
      if (!recruitment || !recruitment.date) {
        console.warn(`[AutoCloseCheck] ID ${id} のデータが無効です。スキップします。`);
        return;
      }
      const raidDateStr = recruitment.date;
      const [year, month, day] = raidDateStr.split('-').map(Number);
      const closingTimeJST = new Date(Date.UTC(year, month - 1, day, 8, 0, 0) - (9 * 60 * 60 * 1000));

      if (now >= closingTimeJST) {
        debugLog('AutoCloseCheck', `募集ID: ${id} - 自動締切時刻 (${closingTimeJST.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })} JST) 超過`);

        if (recruitment.status === 'closed' || recruitment.status === 'assigned') {
          return;
        }

        recruitment.status = 'closed';
        debugLog('AutoCloseCheck', `ステータスを 'closed' に変更`);

        await autoAssignAttributes(recruitment, false);
        await updateRecruitmentMessage(recruitment);

        const channel = await client.channels.fetch(recruitment.channel).catch(() => null);
        if (channel && channel.isTextBased()) {
          let assignedText = `**【${recruitment.finalRaidType || recruitment.type} 自動締切】**\n` +
            `ID: ${recruitment.id} (募集者: <@${recruitment.creator}>)\n` +
            `募集が自動的に締め切られ、参加者(${recruitment.participants.length}名)が割り振られました。\n` +
            `開催予定: ${recruitment.finalTime || recruitment.time}\n`;
          const assignedP = recruitment.participants.filter(p => p?.assignedAttribute);
          const unassignedP = recruitment.participants.filter(p => !p?.assignedAttribute);

          attributes.forEach(attr => {
            const p = assignedP.find(pt => pt?.assignedAttribute === attr);
            let participantText = '空き';
            if (p) {
              participantText = `<@${p.userId}>`;
              if (p.remarks && p.remarks.trim() !== '') {
                participantText += ` (📝 ${p.remarks})`;
              }
            }
            assignedText += `【${attr}】: ${participantText}\n`;
          });

          if (unassignedP.length > 0) {
            assignedText += `\n**※未割り当て (${unassignedP.length}名):**\n`;
            assignedText += formatUnassignedList(unassignedP);
          }

          try {
            if (assignedText.length > 2000) {
              console.warn(`[AutoCloseCheck] 通知メッセージが長すぎるため(${assignedText.length}文字)、短縮します。`);
              assignedText = assignedText.substring(0, 1950) + '... (メッセージ省略)';
            }

            const realUserIdsToMention = assignedP
              .map(p => p.userId)
              .filter(userId => /^\d+$/.test(userId));

            await channel.send({
              content: assignedText,
              allowedMentions: {
                users: realUserIdsToMention
              }
            });
            debugLog('AutoCloseCheck', `自動締め切り通知完了 - ID: ${id}`);
          } catch (sendError) {
            console.error(`[AutoCloseCheck] ID ${id} の通知メッセージ送信エラー:`);
            console.error(sendError);
          }

        } else {
          console.warn(`[AutoCloseCheck] ID ${id} の通知チャンネルが見つからないか、テキストチャンネルではありません。 (Channel ID: ${recruitment.channel})`);
        }
        saveRecruitmentData();
      }
    } catch (error) {
      console.error(`[AutoCloseCheck] 募集ID ${id} 処理中に予期せぬエラー:`, error);
      if (recruitment) {
        try {
          recruitment.status = 'error';
          activeRecruitments.set(id, recruitment);
          saveRecruitmentData();
        } catch (e) {
          console.error("Error status setting/saving failed:", e);
        }
      }
    }
  });
}

// 募集リスト表示機能
async function showActiveRecruitments(message) {
  const activeList = Array.from(activeRecruitments.values()).filter(r => r?.status === 'active');
  if (activeList.length === 0) return message.reply('現在、募集中のレイドはありません。 `!募集` で作成できます！');
  const embed = new EmbedBuilder().setTitle('🔍 現在募集中のレイド一覧').setDescription(`現在 ${activeList.length} 件の募集があります。\n参加するには各募集の「参加申込」ボタンを押してください。`).setColor('#3498DB').setTimestamp();
  activeList.forEach((recruitment, index) => {
    const dateObj = new Date(recruitment.date + 'T00:00:00Z');
    const formattedDate = dateObj.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short' });
    const participantCount = recruitment.participants.length;
    const jumpLink = recruitment.messageId && recruitment.channel && message.guildId ? `[ここをクリック](https://discord.com/channels/${message.guildId}/${recruitment.channel}/${recruitment.messageId})` : 'リンク不明';
    embed.addFields({ name: `${index + 1}. ${recruitment.type} - ${formattedDate} ${recruitment.time}`, value: `募集者: <@${recruitment.creator}>\n参加者: ${participantCount} 名\n${jumpLink}` });
  });
  await message.reply({ embeds: [embed] });
}

// 募集削除処理
async function deleteRecruitment(message, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) return message.reply(`ID「${recruitmentId}」の募集データが見つかりません。`);
  const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);
  if (recruitment.creator !== message.author.id && !isAdmin) return message.reply('募集者本人または管理者のみ削除できます。');
  try {
    if (recruitment.channel && recruitment.messageId) {
      const channel = await client.channels.fetch(recruitment.channel).catch(() => null);
      if (channel && channel.isTextBased()) {
        const recruitMessage = await channel.messages.fetch(recruitment.messageId).catch(() => null);
        if (recruitMessage) await recruitMessage.edit({ content: `**【募集削除】** (ID: ${recruitmentId}) ${message.author.tag} により削除`, embeds: [], components: [] });
        else console.warn(`削除対象メッセージが見つかりません: ${recruitment.messageId}`);
      } else console.warn(`削除対象チャンネルが見つかりません: ${recruitment.channel}`);
    }
    const deleted = activeRecruitments.delete(recruitmentId);
    if (deleted) {
      await message.reply(`募集ID: \`${recruitmentId}\` を削除しました。`);
      debugLog('DeleteRecruitment', `削除成功: ${recruitmentId}, By: ${message.author.tag}`);
      saveRecruitmentData();
    } else throw new Error("Mapからの削除失敗");
  } catch (error) {
    console.error('募集削除エラー:', error);
    await message.reply('募集の削除中にエラーが発生しました。');
    debugLog('DeleteRecruitment', `削除失敗: ${recruitmentId}, Error: ${error.message}`);
  }
}

// ヘルプ表示機能
async function showHelp(message) {
  const embed = new EmbedBuilder().setTitle('📚 グラブル高難易度募集Bot ヘルプ').setDescription('天元・ルシゼロ等の高難易度レイド募集支援Bot').setColor('#1ABC9C')
    .addFields(
      { name: '🌟 基本コマンド', value: '`!募集` - 新規募集開始\n`!募集リスト` - アクティブ募集一覧\n`!募集ヘルプ` - このヘルプ\n`!IDリスト` - 全募集IDと状態' },
      { name: '⚙️ 募集の流れ', value: '1. `!募集`\n2. ボタンでレイドタイプ、日付、時間を選択\n3. 確認画面で「確定」→ 募集メッセージ投稿' },
      { name: '🎮 参加の流れ', value: '1. 募集メッセージの「参加申込」\n2. （参加者希望の場合）希望コンテンツを1つ以上選択\n3. 選択したコンテンツごとに担当可能属性を選択（「全属性」も選択可）\n4. 参加可能時間を選択\n5. 確認画面で「備考入力して参加確定」or「参加確定(備考なし)」\n6. （備考入力の場合）モーダルに入力して送信' },
      { name: '👥 割り振りと締切', value: '- 参加者が**7名**に達すると、自動的に属性割り振りの**プレビュー**が行われます。\n- 募集メッセージの担当者表示はプレビュー結果です。\n- 開催日当日の**朝8時**に自動的に締め切られ、最終的な割り振りが行われます。\n- 募集者は「募集締め切り」ボタンで手動締め切りも可能です。\n- 最終割り振り結果は締切時に通知され、**6属性分が埋まらなかったり、参加者が溢れた場合は未割り当て**となります。' },
      { name: '🔧 管理者用コマンド', value: '`!募集削除 [ID]`\n`!テストモード開始/終了`\n`!テスト参加者追加 [ID] [人数]` (`!testadd`)\n`!追加 [ID]` (3名追加)\n`!直接テスト [ID] (人数)` (`!directtest`)\n`!募集確認 [ID]` (詳細デバッグ)\n`!募集詳細確認` (全概要デバッグ)\n`!再起動テスト`' }
    ).setFooter({ text: '不明点は管理者へ' });
  await message.reply({ embeds: [embed] });
}

// 参加者確認用: 募集選択UI表示
async function showRecruitmentSelectionForParticipants(messageOrInteraction) {
  const activeList = Array.from(activeRecruitments.values()).filter(r => r?.status === 'active');

  if (activeList.length === 0) {
    const replyOptions = { content: '現在募集がありません。', ephemeral: true };
    if (messageOrInteraction.reply) {
      return await messageOrInteraction.reply(replyOptions);
    } else {
      return await messageOrInteraction.channel.send(replyOptions);
    }
  }

  // セレクトメニュー用のオプションを作成（最大25件）
  const recruitmentOptions = activeList.slice(0, 25).map(r => {
    const dateObj = new Date(r.date + 'T00:00:00Z');
    const formattedDate = dateObj.toLocaleDateString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      month: 'numeric',
      day: 'numeric',
      weekday: 'short'
    });
    const label = `[${r.type}] ${formattedDate} ${r.time} (${r.participants.length}名)`;
    const description = `募集者: ${r.creatorUsername || 'Unknown'}`;

    return {
      label: label.length > 100 ? label.substring(0, 97) + '...' : label,
      value: r.id,
      description: description.length > 100 ? description.substring(0, 97) + '...' : description
    };
  });

  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId('select_recruitment_for_participants_')
    .setPlaceholder('確認したい募集を選択してください')
    .addOptions(recruitmentOptions);

  const row = new ActionRowBuilder().addComponents(selectMenu);

  const embed = new EmbedBuilder()
    .setTitle('🔍 参加者を確認したい募集を選択してください')
    .setDescription(`下のメニューから募集を選んでください。\n現在アクティブな募集: ${activeList.length}件`)
    .setColor('#3498DB');

  const replyOptions = { embeds: [embed], components: [row], ephemeral: true };

  if (messageOrInteraction.reply) {
    await messageOrInteraction.reply(replyOptions);
  } else {
    await messageOrInteraction.channel.send(replyOptions);
  }
}

// 参加者確認用: 選択された募集の参加者リスト表示
async function showParticipantsList(interaction, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);

  if (!recruitment) {
    return await interaction.update({
      content: 'この募集は存在しないか削除されました。',
      embeds: [],
      components: [],
      ephemeral: true
    });
  }

  const dateObj = new Date(recruitment.date + 'T00:00:00Z');
  const formattedDate = dateObj.toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'short'
  });

  const embed = new EmbedBuilder()
    .setTitle('📋 募集の参加者一覧')
    .setDescription(
      `**【${recruitment.type}】** ${formattedDate} ${recruitment.time}\n` +
      `募集者: <@${recruitment.creator}>\n` +
      `参加者数: ${recruitment.participants.length}名`
    )
    .setColor('#2ECC71')
    .setTimestamp()
    .setFooter({ text: `募集ID: ${recruitment.id}` });

  if (recruitment.participants.length === 0) {
    embed.addFields({
      name: '\u200b',
      value: '現在参加希望はありません。'
    });
  } else {
    let participantsList = '';
    recruitment.participants.forEach((p, index) => {
      const testMark = p.isTestParticipant ? ' 🧪' : '';
      participantsList += `**${index + 1}.** <@${p.userId}>${testMark}\n`;
      participantsList += `   希望: ${p.joinType}\n`;

      // 属性の表示
      let attrText = '';
      if (p.joinType === 'なんでも可' && p.attributesByRaid) {
        const firstRaid = Object.keys(p.attributesByRaid)[0];
        if (firstRaid) {
          attrText = `全属性`;
        }
      } else if (p.attributesByRaid) {
        const attrParts = [];
        for (const [raid, attrs] of Object.entries(p.attributesByRaid)) {
          attrParts.push(`${raid}[${attrs.join('/')}]`);
        }
        attrText = attrParts.join(', ');
      } else if (p.attributes) {
        // 古いデータ形式のフォールバック
        attrText = p.attributes.join('/');
      }
      participantsList += `   属性: ${attrText || '不明'}\n`;

      participantsList += `   時間: ${p.timeAvailability}\n`;
      participantsList += `   備考: ${p.remarks || 'なし'}\n`;
      participantsList += '\n';
    });

    // Discordのフィールド値制限(1024文字)を考慮して分割
    if (participantsList.length > 1024) {
      const chunks = [];
      let currentChunk = '';
      const lines = participantsList.split('\n');

      for (const line of lines) {
        if ((currentChunk + line + '\n').length > 1024) {
          chunks.push(currentChunk);
          currentChunk = line + '\n';
        } else {
          currentChunk += line + '\n';
        }
      }
      if (currentChunk) chunks.push(currentChunk);

      chunks.forEach((chunk, idx) => {
        embed.addFields({
          name: idx === 0 ? '━━━━━━━━━━━━━━━━' : '\u200b',
          value: chunk
        });
      });
    } else {
      embed.addFields({
        name: '━━━━━━━━━━━━━━━━',
        value: participantsList
      });
    }
  }

  await interaction.update({
    embeds: [embed],
    components: [],
    ephemeral: true
  });
}


// 募集詳細表示機能（デバッグ用）
async function showRecruitmentDetails(message, recruitmentId) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('管理者権限が必要です。');
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) return message.reply(`ID「${recruitmentId}」は存在しません。`);
  let details = `**募集ID: ${recruitmentId} 詳細**\n\`\`\`json\n`;
  details += JSON.stringify(recruitment, (key, value) => key === 'participants' ? `[${value.length} 名]` : value, 2);
  details += '\n```';
  let participantsInfo = '**参加者情報:**\n';
  if (recruitment.participants.length > 0) {
    participantsInfo += '```json\n';
    participantsInfo += JSON.stringify(recruitment.participants.map(p => ({ u: p.username, id: p.userId, type: p.joinType, attr: p.attributesByRaid || p.attributes, time: p.timeAvailability, assigned: p.assignedAttribute || '-', rmk: p.remarks || '', test: p.isTestParticipant || false })), null, 2);
    participantsInfo += '\n```';
  } else participantsInfo += '参加者なし';
  const combined = details + '\n' + participantsInfo;

  try {
    if (combined.length <= 2000) await message.reply(combined);
    else {
      if (details.length <= 2000) await message.reply(details);
      else for (let i = 0; i < details.length; i += 1950) await message.reply({ content: details.substring(i, i + 1950) });
      if (participantsInfo.length <= 2000) await message.channel.send(participantsInfo);
      else for (let i = 0; i < participantsInfo.length; i += 1950) await message.channel.send({ content: participantsInfo.substring(i, i + 1950) });
    }
  } catch (e) { console.error("詳細表示エラー:", e); await message.reply("詳細情報の表示中にエラーが発生しました。").catch(() => { }); }
}

// 全募集データ表示機能（デバッグ用）
async function showAllRecruitmentDetails(message) {
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('管理者権限が必要です。');
  const allRecruitments = Array.from(activeRecruitments.entries());
  if (allRecruitments.length === 0) return message.reply('現在募集データはありません。');
  let debugInfo = `**全募集データ (${allRecruitments.length}件)**\n\n`;
  allRecruitments.forEach(([id, data]) => {
    debugInfo += `**ID**: \`${id}\` | `;
    debugInfo += `タイプ: ${data?.type || '?'} | `;
    debugInfo += `状態: ${data?.status || '?'} | `;
    debugInfo += `日時: ${data?.date || '?'} ${data?.time || '?'} | `;
    debugInfo += `Msg: ${data?.messageId || '?'} | `;
    debugInfo += `参加者: ${data?.participants?.length || 0}名 | `;
    debugInfo += `作成: ${data?.createdAt ? new Date(data.createdAt).toLocaleTimeString('ja-JP') : '?'}\n`;
  });

  if (debugInfo.length > 1950) {
    const parts = []; for (let i = 0; i < debugInfo.length; i += 1950) parts.push(debugInfo.substring(i, i + 1950));
    await message.reply(`全 ${allRecruitments.length} 件募集データ（分割）:`);
    for (const part of parts) await message.channel.send({ content: part });
  } else await message.reply({ content: debugInfo });
}

//==========================================================================
// テストモード機能ブロック
//==========================================================================

// テストモード開始処理
async function startTestMode(message) {
  testMode.active = true; testMode.testParticipants = [];
  const embed = new EmbedBuilder().setTitle('🧪 テストモード開始').setDescription('テストモード**有効**。\nテスト参加者追加ボタン表示、管理者コマンド利用可。\n`!テストモード終了` で無効化。').setColor('#FF9800').setTimestamp();
  await message.reply({ embeds: [embed] });
  debugLog('TestMode', `テストモード開始, By: ${message.author.tag}`);
  for (const recruitment of Array.from(activeRecruitments.values()).filter(r => r?.status === 'active')) { try { await updateRecruitmentMessage(recruitment); } catch (e) { console.error(`テストモード開始時Msg更新エラー(ID:${recruitment.id}):`, e); } }
}

// テストモード終了処理
async function endTestMode(message) {
  if (!testMode.active) return message.reply('テストモードは有効ではありません。');
  testMode.active = false;
  const removedCount = await clearAllTestParticipants();
  const embed = new EmbedBuilder().setTitle('✅ テストモード終了').setDescription(`テストモード**無効**。\n追加されていた ${removedCount} 名のテスト参加者を削除。`).setColor('#4CAF50').setTimestamp();
  await message.reply({ embeds: [embed] });
  debugLog('TestMode', `テストモード終了, By: ${message.author.tag}, 削除: ${removedCount}`);
  for (const recruitment of Array.from(activeRecruitments.values()).filter(r => r?.status === 'active')) { try { await updateRecruitmentMessage(recruitment); } catch (e) { console.error(`テストモード終了時Msg更新エラー(ID:${recruitment.id}):`, e); } }
}

// 全てのテスト参加者を削除
async function clearAllTestParticipants() {
  let removedCount = 0;
  activeRecruitments.forEach((recruitment) => {
    if (!recruitment?.participants) return;
    const initialCount = recruitment.participants.length;
    recruitment.participants = recruitment.participants.filter(p => !p.isTestParticipant);
    removedCount += (initialCount - recruitment.participants.length);
  });
  testMode.testParticipants = [];
  return removedCount;
}

// ランダム属性生成
function getRandomAttributes() {
  const shuffled = [...attributes].sort(() => 0.5 - Math.random());
  const count = Math.floor(Math.random() * attributes.length) + 1;
  return shuffled.slice(0, count);
}

// ランダム時間生成
function getRandomTimeAvailability() {
  const times = ['now', '19:00', '20:00', '21:00', '22:00', '23:00'];
  if (Math.random() < 0.3) return 'now';
  return times[Math.floor(Math.random() * times.length)];
}

// テスト参加者名生成
function generateTestParticipantName(index) {
  const prefixes = ['Test', 'Dummy', 'Bot', 'Sample', 'Mock'];
  const roles = ['Knight', 'Ace', 'Support', 'DPS', 'Healer', 'Tank'];
  return `[${prefixes[Math.floor(Math.random() * prefixes.length)]}${index}]${roles[Math.floor(Math.random() * roles.length)]}`;
}

// テスト参加者追加処理
async function addTestParticipants(message, recruitmentId, count) {
  if (!testMode.active) return message.reply('テストモードが有効ではありません。`!テストモード開始` で有効にしてください。');
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) return message.reply(`ID「${recruitmentId}」が見つかりません。`);
  if (recruitment.status !== 'active') return message.reply(`募集 (ID: ${recruitmentId}) はアクティブではありません（状態: ${recruitment.status}）。`);

  const addedParticipants = [];
  for (let i = 0; i < count; i++) {
    const testUserId = `test-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 5)}`;
    const testUsername = generateTestParticipantName(recruitment.participants.length + i + 1);
    let joinType, attributesByRaid = {};

    if (recruitment.type === '参加者希望') {
      const types = ['天元', 'ルシゼロ', 'なんでも可'];
      joinType = types[Math.floor(Math.random() * types.length)];
      const availableRaids = raidTypes.filter(t => t !== '参加者希望');
      if (joinType === 'なんでも可') {
        const attrs = getRandomAttributes();
        availableRaids.forEach(r => attributesByRaid[r] = attrs);
      } else {
        attributesByRaid[joinType] = getRandomAttributes();
      }
    } else {
      joinType = recruitment.type;
      attributesByRaid[joinType] = getRandomAttributes();
    }

    const testParticipant = {
      userId: testUserId,
      username: testUsername,
      joinType: joinType,
      attributesByRaid: attributesByRaid,
      timeAvailability: getRandomTimeAvailability(),
      remarks: '',
      assignedAttribute: null,
      isTestParticipant: true
    };
    recruitment.participants.push(testParticipant);
    testMode.testParticipants.push(testParticipant);
    addedParticipants.push(testParticipant);
  }

  try {
    await updateRecruitmentMessage(recruitment);
    const embed = new EmbedBuilder().setTitle('🧪 テスト参加者 追加完了').setDescription(`募集ID: \`${recruitmentId}\` に ${addedParticipants.length} 名のテスト参加者を追加しました。\n現在の参加者数: ${recruitment.participants.length} 名`).setColor('#2196F3').setTimestamp();
    addedParticipants.slice(0, 5).forEach((p, index) => {
      const attrText = Object.entries(p.attributesByRaid).map(([r, a]) => `${r}:${a.join('/')}`).join(' ');
      embed.addFields({ name: `${index + 1}. ${p.username}`, value: `Type:${p.joinType}, Attr:${attrText}, Time:${p.timeAvailability}`, inline: false });
    });
    if (addedParticipants.length > 5) embed.addFields({ name: '...', value: `他 ${addedParticipants.length - 5} 名`, inline: false });
    await message.reply({ embeds: [embed] });

    if (recruitment.participants.length === 7 && recruitment.status === 'active') {
      await message.channel.send(`参加者が7名になったため、ID "${recruitmentId}" の属性割り振りをプレビュー表示します...`);
      await autoAssignAttributes(recruitment, true);
      await updateRecruitmentMessage(recruitment);
    } else if (recruitment.participants.length > 7 && recruitment.status === 'active' && count > 0) {
      await message.channel.send(`テスト参加者追加により、ID "${recruitmentId}" の属性割り振りプレビューを更新します...`);
      await autoAssignAttributes(recruitment, true);
      await updateRecruitmentMessage(recruitment);
    }

    debugLog('TestMode', `${message.author.tag} が募集ID ${recruitmentId} に ${addedParticipants.length} 名追加 (コマンド)`);
    saveRecruitmentData();
  } catch (error) {
    console.error(`テスト参加者追加コマンド処理エラー:`, error);
    await message.reply('テスト参加者の追加処理中にエラーが発生しました。');
  }
}

// テスト参加者追加オプション表示
// テスト参加者追加オプション表示
async function showTestParticipantAddOptions(interaction, recruitmentId) {
  if (!testMode.active) return interaction.reply({ content: 'テストモードが有効ではありません。', ephemeral: true });
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') return interaction.reply({ content: 'この募集は既に終了しているか、存在しません。', ephemeral: true });
  const currentCount = recruitment.participants.length;

  const options = [];
  // ★★★ ここを修正: [1, 3, 5, 7, 10] という配列に対して forEach を実行するように修正しました ★★★
  [1, 3, 5, 7, 10].forEach(num => {
    options.push({
      label: `${num}人 追加`,
      value: String(num),
      description: `テスト参加者を${num}人追加 (合計 ${currentCount + num} 名)`
    });
  });

  const row = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`test_participant_count_${recruitmentId}`).setPlaceholder('追加するテスト参加者の人数を選択').addOptions(options));
  const embed = new EmbedBuilder().setTitle('🧪 テスト参加者 追加').setDescription(`募集ID: \`${recruitmentId}\` (現在 ${currentCount} 名)\n追加する人数を選択してください。\nタイプ、属性、時間はランダム設定。`).setColor('#2196F3');
  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

// テスト参加者追加確認UI表示
async function showTestParticipantConfirmation(interaction, recruitmentId, count) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') return interaction.update({ content: 'この募集は既に終了しているか、存在しません。', embeds: [], components: [], ephemeral: true }).catch(e => { if (e.code !== 10062) console.error("Update Error:", e) });
  const currentPCount = recruitment.participants.length;

  const embed = new EmbedBuilder().setTitle('🧪 テスト参加者 追加確認').setDescription(`募集ID: \`${recruitmentId}\` に **${count} 名** のテスト参加者を追加します。\n\n` + `現在の参加者数: ${currentPCount} 名\n` + `追加後の参加者数: ${currentPCount + count} 名`).setColor('#2196F3');
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_test_participants_${recruitmentId}_${count}`).setLabel(`${count}名 追加`).setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId('cancel_test_participants').setLabel('キャンセル').setStyle(ButtonStyle.Danger));
  await interaction.update({ embeds: [embed], components: [row] }).catch(e => { if (e.code !== 10062) console.error("Update Error:", e) });
}

// テスト参加者追加確定処理
async function confirmAddTestParticipants(interaction, recruitmentId, count) {
  if (!testMode.active) return interaction.update({ content: 'テストモードが有効ではありません。', embeds: [], components: [], ephemeral: true }).catch(e => { if (e.code !== 10062) console.error("Update Error:", e) });
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') return interaction.update({ content: 'この募集は既に終了しているか、存在しません。', embeds: [], components: [], ephemeral: true }).catch(e => { if (e.code !== 10062) console.error("Update Error:", e) });

  const addedParticipants = [];
  for (let i = 0; i < count; i++) {
    const testUserId = `test-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 5)}`;
    const testUsername = generateTestParticipantName(recruitment.participants.length + i + 1);
    let joinType, attributesByRaid = {};

    if (recruitment.type === '参加者希望') {
      const types = ['天元', 'ルシゼロ', 'なんでも可'];
      joinType = types[Math.floor(Math.random() * types.length)];
      const availableRaids = raidTypes.filter(t => t !== '参加者希望');
      if (joinType === 'なんでも可') {
        const attrs = getRandomAttributes();
        availableRaids.forEach(r => attributesByRaid[r] = attrs);
      } else {
        attributesByRaid[joinType] = getRandomAttributes();
      }
    } else {
      joinType = recruitment.type;
      attributesByRaid[joinType] = getRandomAttributes();
    }

    const testParticipant = {
      userId: testUserId,
      username: testUsername,
      joinType: joinType,
      attributesByRaid: attributesByRaid,
      timeAvailability: getRandomTimeAvailability(),
      remarks: '',
      assignedAttribute: null,
      isTestParticipant: true
    };
    recruitment.participants.push(testParticipant);
    testMode.testParticipants.push(testParticipant);
    addedParticipants.push(testParticipant);
  }

  try {
    await updateRecruitmentMessage(recruitment);

    let autoAssignTriggered = false;
    if (recruitment.participants.length >= 7 && (recruitment.participants.length - addedParticipants.length < 7) && recruitment.status === 'active') {
      await autoAssignAttributes(recruitment, true);
      await updateRecruitmentMessage(recruitment);
      autoAssignTriggered = true;
    } else if (recruitment.participants.length > 7 && addedParticipants.length > 0 && recruitment.status === 'active') {
      await autoAssignAttributes(recruitment, true);
      await updateRecruitmentMessage(recruitment);
      autoAssignTriggered = true;
    }


    await interaction.update({ content: `✅ ${addedParticipants.length} 名のテスト参加者を追加しました。\n現在の参加者: ${recruitment.participants.length} 名` + (autoAssignTriggered ? '\n\n属性割り振りを**プレビュー表示**しました。' : ''), embeds: [], components: [] }).catch(e => { if (e.code !== 10062) console.error("Update Error:", e) });
    debugLog('TestMode', `${interaction.user.tag} が募集ID ${recruitmentId} に ${addedParticipants.length} 名追加 (ボタン)`);
    saveRecruitmentData();
  } catch (error) {
    console.error(`テスト参加者追加確定エラー:`, error);
    await interaction.followUp({ content: 'テスト参加者の追加処理中にエラーが発生しました。', ephemeral: true }).catch(() => { });
  }
}


//==========================================================================
// Expressサーバー (Keep-alive用)
//==========================================================================
const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => res.status(200).send('Discord Bot is Active!'));
app.get('/health', (req, res) => res.status(200).json({ status: 'up', timestamp: new Date().toISOString(), uptime: process.uptime(), discordClientStatus: client.ws.status, activeRecruitments: activeRecruitments.size, memoryUsage: process.memoryUsage() }));
app.get('/ping', (req, res) => res.status(200).send('pong'));
app.use((req, res) => res.status(404).send('Not Found'));
app.use((err, req, res, next) => { console.error('Expressサーバーエラー:', err); res.status(500).send('Internal Server Error'); });
app.listen(PORT, () => console.log(`監視用HTTPサーバーがポート ${PORT} で起動しました。`));

//==========================================================================
// プロセス監視とグレースフルシャットダウン
//==========================================================================
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
  setTimeout(() => { console.log("シャットダウン完了。"); process.exit(0); }, 1500);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// 定期的なメモリ監視
setInterval(() => {
  try {
    const memoryUsage = process.memoryUsage(); const usedMemoryMB = Math.round(memoryUsage.rss / 1024 / 1024);
    // debugLog('HealthCheck', `メモリ使用量: ${usedMemoryMB}MB`); // ログ抑制
    const MEMORY_LIMIT_MB = process.env.MEMORY_LIMIT_MB || 450;
    if (usedMemoryMB > MEMORY_LIMIT_MB) {
      console.warn(`メモリ使用量 (${usedMemoryMB}MB) が閾値 (${MEMORY_LIMIT_MB}MB) 超過。`);
      shutdown('MemoryLimit');
    }
  } catch (error) { console.error('自己ヘルスチェックエラー:', error); }
}, 10 * 60 * 1000);

//==========================================================================
// Discord Bot ログイン
//==========================================================================
client.login(process.env.TOKEN)
  .then(() => console.log('Discord Bot 正常ログイン'))
  .catch(error => { console.error('!!! Discord Botログインエラー !!!:', error); process.exit(1); });
