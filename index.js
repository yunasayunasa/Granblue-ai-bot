// Discord.jsの必要なクラスをインポート
const {
  Client,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  StringSelectMenuBuilder,
  ModalBuilder, // ★ 追加
  TextInputBuilder, // ★ 追加
  TextInputStyle, // ★ 追加
  ButtonStyle,
  GatewayIntentBits,
  InteractionType, // ★ 追加
  PermissionsBitField // ★ 追加 (管理者チェック用)
} = require('discord.js');

// ★ Google Generative AIライブラリをインポート
 
//const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generativeai");

// 環境変数をロード
require('dotenv').config();

// ファイルシステムモジュールをインポート (ここに追加)
const fs = require('fs');
const path = require('path');

// ここに追加：テストモード用のグローバル変数
const testMode = {
  active: false,
  testParticipants: [] // テスト用参加者データを保存
};

// グローバルなエラーハンドリングを追加
process.on('unhandledRejection', (reason, promise) => {
  console.error('未処理のPromise拒否:');
  console.error(reason);
});



// ボットの基本設定
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers, // ★★★ ギルドメンバーインテントを追加 ★★★
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// データ保存用のファイルパス (グローバル変数の近くに追加)
const RENDER_DISK_MOUNT_PATH = process.env.DATA_PATH || '/data/botdata'; // Render永続ディスクパス等
const DATA_FILE_PATH = path.join(RENDER_DISK_MOUNT_PATH, 'recruitment_data.json'); // ★ パスを確認・修正

// グローバル変数
let activeRecruitments = new Map(); // 現在進行中の募集を保持
const tempUserData = new Map(); // 一時的なユーザーデータ保存用
const attributes = ['火', '水', '土', '風', '光', '闇']; // グラブルの属性
const raidTypes = ['天元', 'ルシゼロ', '参加者希望']; // レイドタイプ
// ★ NGワードリストを追加
 const NG_WORDS = ["死ね", "殺す", "馬鹿", "アホ", /* ... 他の不適切な単語を追加 ... */ ];
// ★ 備考の最大文字数を追加
 const MAX_REMARKS_LENGTH = 100;

// 時間オプションを初期化
const timeOptions = [];
for (let i = 0; i < 24; i++) {
  const hour = i.toString().padStart(2, '0');
  timeOptions.push({
    label: `${hour}:00`,
    value: `${hour}:00`
  });
}

// ユーティリティ関数 - この位置に正しく配置
function generateUniqueId() {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function debugLog(tag, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${tag}] ${message}`);
  if (data) console.log(JSON.stringify(data, null, 2));
}

// 募集データのロード処理 - client.onceの外に正しく配置
function loadRecruitmentData() {
  try {
    // fsモジュールを関数内でrequire
    const fs = require('fs');
    const path = require('path');
    
     // --- ▼▼▼ ここから修正 ▼▼▼ ---

    // ★★ Renderで設定したMount Pathに合わせてください ★★
    const RENDER_DISK_MOUNT_PATH = '/data/botdata'; // 例: Renderで設定したパス
    const dataFilePath = path.join(RENDER_DISK_MOUNT_PATH, 'recruitment_data.json');
    const dataDir = path.dirname(dataFilePath); // ディレクトリパスを取得

    // ディレクトリが存在しない場合は作成 (読み込み時には通常不要だが念のため)
    if (!fs.existsSync(dataDir)) {
      console.log(`データディレクトリが見つからないため作成します: ${dataDir}`);
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // --- ▲▲▲ ここまで修正 ▲▲▲ ---
    
    // ファイルが存在するか確認
    if (fs.existsSync(dataFilePath)) {
      console.log('保存されていた募集データをロードします...');
      const data = fs.readFileSync(dataFilePath, 'utf8');
      const parsedData = JSON.parse(data);
      
      // 読み込んだデータをMapに変換
      const loadedRecruitments = new Map();
      let activeCount = 0;
      
      Object.entries(parsedData).forEach(([id, recruitment]) => {
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

// 古い募集のクリーンアップ処理 - client.onceの外に正しく配置
function cleanupOldRecruitments() {
  const now = new Date();
  let cleanupCount = 0;
  
  activeRecruitments.forEach((recruitment, id) => {
    // 状態ごとに保持期間を設定
    // - 終了した募集: 3日後に削除
    // - 全ての募集: 7日以上経過したら削除（安全措置）
    const recruitmentDate = new Date(recruitment.date);
    const daysSinceCreation = (now - recruitmentDate) / (1000 * 60 * 60 * 24);
    
    const isVeryOld = daysSinceCreation > 7;
    const isClosedAndOld = (recruitment.status === 'closed' || recruitment.status === 'assigned') && daysSinceCreation > 3;
    
    if (isVeryOld || isClosedAndOld) {
      activeRecruitments.delete(id);
      cleanupCount++;
      console.log(`古い募集を削除: ID=${id}, タイプ=${recruitment.type}, 状態=${recruitment.status}, 経過日数=${daysSinceCreation.toFixed(1)}日`);
    }
  });
  
  console.log(`古い募集 ${cleanupCount}件をクリーンアップしました。残り: ${activeRecruitments.size}件`);
  
  // クリーンアップ後にデータを保存
  saveRecruitmentData();
}

client.once('ready', () => {
  console.log(`${client.user.tag} でログインしました！`);
  console.log('Discord.js バージョン:', require('discord.js').version);
  
  // 保存済みデータがあればロード
  const loadedData = loadRecruitmentData();
  if (loadedData.size > 0) {
    // グローバル変数を上書き
    activeRecruitments = loadedData;
  }
  
  // 定期的な処理の開始
  setInterval(saveRecruitmentData, 2 * 60 * 1000);     // 2分ごとにデータ保存
  setInterval(checkAutomaticClosing, 5 * 60 * 1000);   // 5分ごとに自動締め切りチェック
  setInterval(cleanupOldRecruitments, 24 * 60 * 60 * 1000); // 24時間ごとに古い募集をクリーンアップ
  
  // 初回のクリーンアップを実行
  cleanupOldRecruitments();
});


// 募集データの保存処理
function saveRecruitmentData() {
  // activeRecruitments が Map でない場合や空の場合、処理を中断
  if (!(activeRecruitments instanceof Map) || activeRecruitments.size === 0) {
    console.log('保存対象のデータがないため、保存処理をスキップします。');
    return;
  }
  try {
    // fsモジュールを関数内でrequire
    const fs = require('fs');
    const path = require('path');
    
    // --- ▼▼▼ ここから修正 ▼▼▼ ---

    // ★★ Renderで設定したMount Pathに合わせてください ★★
    const RENDER_DISK_MOUNT_PATH = '/data/botdata'; // 例: Renderで設定したパス
    const dataFilePath = path.join(RENDER_DISK_MOUNT_PATH, 'recruitment_data.json');
    const dataDir = path.dirname(dataFilePath); // ディレクトリパスを取得

    // 保存前にディレクトリが存在するか確認し、なければ作成
    if (!fs.existsSync(dataDir)) {
      console.log(`データディレクトリが見つからないため作成します: ${dataDir}`);
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // MapをJSONに変換可能なオブジェクトに変換
    const dataToSave = {};
    activeRecruitments.forEach((recruitment, id) => {
      dataToSave[id] = recruitment;
    });
    
    // ファイルに保存
    fs.writeFileSync(dataFilePath, JSON.stringify(dataToSave, null, 2), 'utf8');
    console.log(`${activeRecruitments.size}件の募集データを保存しました`);
  } catch (error) {
    console.error('募集データの保存中にエラーが発生しました:', error);
  }
}

// エラー応答ヘルパー関数
async function handleErrorReply(interaction, error) {
  try {
    // 10062 (Unknown interaction) エラーの場合は単にログ出力
    if (error.code === 10062) {
      console.log('インタラクションタイムアウトまたは未知のインタラクション - 無視します');
      return;
    }
    // 40060 (Already acknowledged) エラーの場合も単にログ出力
    if (error.code === 40060) {
      console.log('インタラクションは既に応答済み - 無視します');
      return;
    }

    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ 
        content: 'エラーが発生しました。もう一度お試しください。' 
      }).catch(e => console.log('editReply 失敗:', e.message));
    } else {
      await interaction.reply({ 
        content: 'エラーが発生しました。', 
        ephemeral: true 
      }).catch(e => console.log('reply 失敗:', e.message));
    }
  } catch (replyErr) {
    console.error('エラー応答失敗:', replyErr);
  }
}

// メインのinteractionCreateイベントハンドラ
client.on('ate', async interaction => {
  try {
    // ボタンインタラクション
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    }
    // セレクトメニューインタラクション
    else if (interaction.isStringSelectMenu()) {
      await handleSelectMenuInteraction(interaction);
    }
    
   client.on('interactionCreate', async interaction => {
     try {
       if (!interaction.guild) return; // DM無視
       if (interaction.isButton()) {
         await handleButtonInteraction(interaction);
       } else if (interaction.isStringSelectMenu()) {
         await handleSelectMenuInteraction(interaction);
       }
     else if (interaction.type === InteractionType.ModalSubmit) { // ★ モーダル送信処理を追加
       await handleModalSubmit(interaction); // ★ 新しい関数を呼び出す
      }
     } catch (error) {
       console.error('インタラクション処理エラー:', error);
       await handleErrorReply(interaction, error);
     }
   });
  } catch (error) {
    console.error('インタラクション処理エラー:', error);
    handleErrorReply(interaction, error);
  }
});

// メッセージコマンドハンドラ
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  // !募集コマンドで募集作成開始
  if (message.content === '!募集') {
    await startRecruitment(message);
  }
  // !募集リストコマンドで現在の募集一覧を表示
  else if (message.content === '!募集リスト') {
    await showActiveRecruitments(message);
  }
  // !募集ヘルプコマンドでヘルプを表示
  else if (message.content === '!募集ヘルプ') {
    await showHelp(message);
  }
  // !テストモード開始コマンド
else if (message.content === '!テストモード開始') {
  try {
    testMode.active = true;
    testMode.testParticipants = [];
    
    const embed = new EmbedBuilder()
      .setTitle('🧪 テストモード開始')
      .setDescription('テストモードが開始されました。以下の機能が利用できます：\n\n' +
        '`!テスト参加者追加 [募集ID] [人数]` - 指定した募集に指定した人数のテスト参加者を追加\n' +
        '`!直接テスト [募集ID] [人数]` - シンプルなテスト参加者追加コマンド\n' +
        '`!テストモード終了` - テストモードを終了する')
      .setColor('#FF9800');

    await message.reply({ embeds: [embed] });
    console.log(`テストモードが ${message.author.tag} によって開始されました`);
  } catch (error) {
    console.error('テストモード開始エラー:', error);
    await message.reply('エラーが発生しました: ' + error.message);
  }
}
// !テストモード終了コマンド
else if (message.content === '!テストモード終了') {
  await endTestMode(message);
}
// !テスト参加者追加コマンド
else if (message.content.startsWith('!テスト参加者追加 ')) {
  const params = message.content.replace('!テスト参加者追加 ', '').split(' ');
  if (params.length >= 2) {
    const recruitmentId = params[0];
    const count = parseInt(params[1], 10);
    await addTestParticipants(message, recruitmentId, count);
  } else {
    await message.reply('使用方法: `!テスト参加者追加 [募集ID] [人数]`');
  }
}
// client.on('messageCreate')のハンドラに追加
else if (message.content === '!IDリスト') {
  try {
    const ids = Array.from(activeRecruitments.keys());
    if (ids.length === 0) {
      return message.reply('現在募集データはありません。');
    }
    
    let response = '**募集ID一覧**\n\n';
    ids.forEach((id, index) => {
      const recruitment = activeRecruitments.get(id);
      response += `${index + 1}. \`${id}\` (${recruitment.type})\n`;
    });
    
    await message.reply(response);
  } catch (error) {
    console.error('IDリスト表示エラー:', error);
    await message.reply(`エラーが発生しました: ${error.message}`);
  }
}
// !追加 コマンドの処理部分を修正
else if (message.content.startsWith('!追加 ')) {
  try {
    // 入力からIDを取得
    const id = message.content.replace('!追加 ', '').trim();
    console.log(`追加コマンド実行: ID=${id}`);
    
    // 募集データの取得
    const recruitment = activeRecruitments.get(id);
    if (!recruitment) {
      return message.reply(`ID "${id}" の募集は存在しません。`);
    }
    
    // 3人のテスト参加者を追加（より多様な設定で）
    for (let i = 0; i < 3; i++) {
      // 参加タイプをランダムに設定
      let joinType;
      if (recruitment.type === '参加者希望') {
        const types = ['天元', 'ルシゼロ', 'なんでも可'];
        joinType = types[Math.floor(Math.random() * types.length)];
      } else {
        joinType = recruitment.type;
      }
      
      // 属性を多様にする
      const possibleAttributes = ['火', '水', '土', '風', '光', '闇'];
      const selectedAttributes = [];
      
      // 各属性について30%〜50%の確率で選択する
      possibleAttributes.forEach(attr => {
        if (Math.random() < 0.4) {
          selectedAttributes.push(attr);
        }
      });
      
      // 少なくとも1つは選択されるようにする
      if (selectedAttributes.length === 0) {
        selectedAttributes.push(possibleAttributes[Math.floor(Math.random() * possibleAttributes.length)]);
      }
      
      // 時間もランダムに設定
      const possibleTimes = ['今すぐ', '19:00', '20:00', '21:00', '22:00', '23:00'];
      const selectedTime = possibleTimes[Math.floor(Math.random() * possibleTimes.length)];
      
      // 参加者データを作成
      const participant = {
        userId: `test-${i}-${Date.now()}`,
        username: `[TEST] 参加者${i+1}`,
        joinType: joinType,
        attributes: selectedAttributes,
        timeAvailability: selectedTime,
        assignedAttribute: null,
        isTestParticipant: true
      };
      
      recruitment.participants.push(participant);
      console.log(`テスト参加者を追加: ${participant.username}, 参加タイプ=${joinType}, 属性=[${selectedAttributes.join(',')}], 時間=${selectedTime}`);
    }
    
    // メッセージ更新
    await updateRecruitmentMessage(recruitment);
    
    // 確認メッセージ
    await message.reply(`ID "${id}" の募集に3名のテスト参加者を追加しました。\n現在の参加者数: ${recruitment.participants.length}名`);
    
    // 7人以上でも自動で締め切らないように修正（プレビューモードで実行）
    if (recruitment.participants.length >= 7 && recruitment.status === 'active') {
      await message.channel.send('参加者が7人以上になったため、属性割り振りをプレビュー表示します...');
      // プレビューモードで実行（true を渡す）
      await autoAssignAttributes(recruitment, true);
      await updateRecruitmentMessage(recruitment);
    }
  } catch (error) {
    console.error('テスト参加者追加エラー:', error);
    await message.reply(`エラーが発生しました: ${error.message}`);
  }
}
  // !募集削除コマンドで募集を削除
  else if (message.content.startsWith('!募集削除 ')) {
    const recruitmentId = message.content.replace('!募集削除 ', '');
    await deleteRecruitment(message, recruitmentId);
  }
  // !募集確認コマンドで募集の詳細を表示（デバッグ用）
  else if (message.content.startsWith('!募集確認 ')) {
    const recruitmentId = message.content.replace('!募集確認 ', '');
    await showRecruitmentDetails(message, recruitmentId);
  }
  // !募集詳細確認コマンドで全募集の詳細を表示（デバッグ用）
  else if (message.content === '!募集詳細確認') {
    await showAllRecruitmentDetails(message);
  }
  // 再起動テストコマンド
  else if (message.content === '!再起動テスト') {
    // 管理者権限を持つユーザーのみ実行可能
    if (message.member.permissions.has('Administrator')) {
      await message.reply('テスト用の再起動を行います。データが正しく保存・復元されるか確認してください...');
      
      // データを保存
      saveRecruitmentData();
      
      console.log(`${message.author.tag}がテスト用再起動をリクエストしました`);
      
      // 少し待ってからプロセスを終了
      setTimeout(() => {
        console.log('テスト用再起動を実行します');
        process.exit(0);  // クリーンな終了（Renderが自動的に再起動）
      }, 3000);
    } else {
      await message.reply('このコマンドは管理者権限を持つユーザーのみが使用できます。');
    }
  }
  // !直接テスト コマンドの処理部分を修正
else if (message.content.startsWith('!直接テスト ')) {
  try {
    const params = message.content.replace('!直接テスト ', '').split(' ');
    const recruitmentId = params[0];
    const count = params.length >= 2 ? parseInt(params[1], 10) : 5;
    
    const recruitment = activeRecruitments.get(recruitmentId);
    if (!recruitment) {
      return await message.reply('指定された募集IDは存在しません。');
    }
    
    // テスト参加者を追加
    let addedCount = 0;
    for (let i = 0; i < count; i++) {
      // 参加タイプをランダムに設定
      let joinType;
      if (recruitment.type === '参加者希望') {
        const types = ['天元', 'ルシゼロ', 'なんでも可'];
        joinType = types[Math.floor(Math.random() * types.length)];
      } else {
        joinType = recruitment.type;
      }
      
      // 属性を多様にする（強化版）
      const possibleAttributes = ['火', '水', '土', '風', '光', '闇'];
      const selectedAttributes = [];
      
      // 既存の参加者にない属性を選びやすくする（属性の均等分布を促進）
      const attributeCounts = {};
      possibleAttributes.forEach(attr => attributeCounts[attr] = 0);
      
      // 現在の参加者の属性分布を集計
      recruitment.participants.forEach(p => {
        p.attributes.forEach(attr => {
          if (attributeCounts[attr] !== undefined) {
            attributeCounts[attr]++;
          }
        });
      });
      
      // 希少属性をより選びやすくする
      possibleAttributes.forEach(attr => {
        // 希少な属性ほど選ばれやすくする
        const selectionProbability = 0.3 + (0.3 / (attributeCounts[attr] + 1));
        if (Math.random() < selectionProbability) {
          selectedAttributes.push(attr);
        }
      });
      
      // 少なくとも1つは選択されるようにする
      if (selectedAttributes.length === 0) {
        // 最も希少な属性を選ぶ
        const rareAttributes = [...possibleAttributes].sort((a, b) => attributeCounts[a] - attributeCounts[b]);
        selectedAttributes.push(rareAttributes[0]);
      }
      
      // 時間もランダムに設定
      const possibleTimes = ['今すぐ', '19:00', '20:00', '21:00', '22:00', '23:00'];
      const selectedTime = possibleTimes[Math.floor(Math.random() * possibleTimes.length)];
      
      const testParticipant = {
        userId: `test-${Date.now()}-${i}`,
        username: `テスト参加者${i+1}`,
        joinType: joinType,
        attributes: selectedAttributes,
        timeAvailability: selectedTime,
        assignedAttribute: null,
        isTestParticipant: true
      };
      
      recruitment.participants.push(testParticipant);
      addedCount++;
      
      console.log(`テスト参加者を追加: ${testParticipant.username}, 参加タイプ=${joinType}, 属性=[${selectedAttributes.join(',')}], 時間=${selectedTime}`);
    }
    
    await updateRecruitmentMessage(recruitment);
    await message.reply(`${addedCount}名のテスト参加者を追加しました`);
    
    // 7人以上でも自動で締め切らないように修正（プレビューモードで実行）
    if (recruitment.participants.length >= 7 && recruitment.status === 'active') {
      await message.reply('参加者が7人以上になったため、属性割り振りをプレビュー表示します...');
      // プレビューモードで実行（true を渡す）
      await autoAssignAttributes(recruitment, true);
      await updateRecruitmentMessage(recruitment);
    }
  } catch (error) {
    console.error('直接テスト追加エラー:', error);
    await message.reply('エラーが発生しました: ' + error.message);
  }
}
  
  // Discord.js v14テストコマンド
  else if (message.content === '!v14test') {
    try {
      console.log('テストコマンドを受信');

      // V14でのボタン作成
      const row = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('simple_test')
            .setLabel('テストボタン')
            .setStyle(ButtonStyle.Primary)
        );

      await message.reply({
        content: 'Discord.js v14テスト - このボタンをクリックしてください',
        components: [row]
      });

      console.log('テストメッセージを送信しました');
    } catch (error) {
      console.error('テストコマンドエラー:', error);
      await message.reply(`エラーが発生しました: ${error.message}`);
    }
  }
});

// ボタンインタラクション処理関数
async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;
  console.log(`ボタン処理: ${customId}`);

  try {
    // レイドタイプ選択
    if (customId.startsWith('raid_type_')) {
      const raidType = customId.replace('raid_type_', '');
      await showDateSelection(interaction, raidType);
    }
    // 日付選択
    else if (customId.startsWith('date_')) {
      const parts = customId.split('_');
      const raidType = parts[2];
      const dateStr = parts[3];
      await showTimeSelection(interaction, raidType, dateStr);
    }
    // 募集確定ボタン
    else if (customId.startsWith('confirm_recruitment_')) {
      const recruitmentId = customId.replace('confirm_recruitment_', '');
      await finalizeRecruitment(interaction, recruitmentId);
    }
    // 募集キャンセルボタン
    else if (customId === 'cancel_recruitment') {
      await interaction.update({
        content: '募集作成をキャンセルしました。',
        embeds: [],
        components: []
      });
    }
    // 参加申込ボタン
    else if (customId.startsWith('join_recruitment_')) {
      const recruitmentId = customId.replace('join_recruitment_', '');
      await showJoinOptions(interaction, recruitmentId);
    }
    // 参加キャンセルボタン
    else if (customId.startsWith('cancel_participation_')) {
      const recruitmentId = customId.replace('cancel_participation_', '');
      await cancelParticipation(interaction, recruitmentId);
    }
    // 募集締め切りボタン
    else if (customId.startsWith('close_recruitment_')) {
      const recruitmentId = customId.replace('close_recruitment_', '');
      await closeRecruitment(interaction, recruitmentId);
    }
     // ★ 備考入力モーダルを開くボタンの処理を追加
       else if (customId.startsWith('open_remarks_modal_')) {
           const recruitmentId = customId.replace('open_remarks_modal_', '');
           await showRemarksModal(interaction, recruitmentId); // ★ 新しい関数を呼び出す
       }
    // 参加確定ボタン
    else if (customId.startsWith('confirm_join_')) {
      const parts = customId.split('_');
      const recruitmentId = parts[2];
      const joinType = parts[3];
      const attributesStr = parts[4];
      const timeAvailability = parts.length > 5 ? parts[5] : 'now';
      
      const selectedAttributes = attributesStr.split(',');
      await confirmParticipation(interaction, recruitmentId, joinType, selectedAttributes, timeAvailability);
    }
    // 参加申込キャンセルボタン
    else if (customId === 'cancel_join') {
      await interaction.update({
        content: '参加申込をキャンセルしました。',
        embeds: [],
        components: []
      });
    }
    // 参加確認ボタン
    else if (customId.startsWith('confirm_')) {
      // テスト参加者確認ボタンとの区別
  if (customId.startsWith('confirm_test_participants_')) {
    // ここでは何もしない - 上の条件ですでに処理済み
  } else {
    // 通常の参加確認処理
      const recruitmentId = customId.replace('confirm_', '');
      await processConfirmation(interaction, recruitmentId);
    }
  }
    // テストボタン
    else if (customId === 'simple_test') {
      await interaction.reply({
        content: 'テストボタンが正常に動作しています！',
        ephemeral: true
      });
    }
    // テスト参加者追加ボタン
else if (customId.startsWith('add_test_participants_')) {
  const recruitmentId = customId.replace('add_test_participants_', '');
  await showTestParticipantAddOptions(interaction, recruitmentId);
}

// テスト参加者確定ボタン
else if (customId.startsWith('confirm_test_participants_')) {
  try {
    const parts = customId.split('_');
    // 正しいインデックスを使う
    // parts = ["confirm", "test", "participants", "1742922570965-l5exczb", "10"]
    const recruitmentId = parts[3];
    const count = parseInt(parts[4], 10);
    
    console.log(`テスト参加者追加処理を開始します: ID=${recruitmentId}, 人数=${count}`);
    
    // 関数が存在することを確認
    if (typeof confirmAddTestParticipants !== 'function') {
      console.error('confirmAddTestParticipants 関数が見つかりません');
      return await interaction.update({ content: '内部エラーが発生しました' });
    }
    
    await confirmAddTestParticipants(interaction, recruitmentId, count);
  } catch (error) {
    console.error('テスト参加者確定処理エラー:', error);
    await interaction.update({ content: 'エラーが発生しました: ' + error.message });
  }
}

// テスト参加者キャンセルボタン
else if (customId === 'cancel_test_participants') {
  await interaction.update({
    content: 'テスト参加者の追加をキャンセルしました。',
    embeds: [],
    components: []
  });
}
    // その他の未処理ボタン
    else {
      console.log(`未処理のボタンID: ${customId}`);
      await interaction.reply({ 
        content: 'このボタンは現在サポートされていません', 
        ephemeral: true 
      });
    }
  } catch (error) {
    console.error(`ボタン処理エラー (${customId}):`, error);
    handleErrorReply(interaction, error);
  }
}

// ★ 備考入力モーダル表示関数 (文字数制限付き)
async function showRemarksModal(interaction, recruitmentId) {
  const userData = tempUserData.get(interaction.user.id);
  // ユーザーデータがない、またはIDが一致しない場合はエラー応答
  if (!userData || userData.recruitmentId !== recruitmentId) {
      return await interaction.reply({ content: 'エラー: 参加情報が見つからないか、情報が古くなっています。お手数ですが、再度「参加申込」ボタンから操作してください。', ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId(`submit_remarks_${recruitmentId}`) // ★ モーダル送信時のID
    .setTitle('参加に関する備考 (任意)');

  const remarksInput = new TextInputBuilder()
    .setCustomId('remarks_input') // ★ モーダル送信時にこのIDで値を取得
    .setLabel(`希望/遅刻/早退など(${MAX_REMARKS_LENGTH}文字以内)`) // ★ ラベルに文字数表示
    .setStyle(TextInputStyle.Paragraph) // 複数行入力可
    .setPlaceholder('例: 22時まで参加希望です。初心者です。空欄でもOK。')
    .setMaxLength(MAX_REMARKS_LENGTH) // ★ 文字数制限
    .setRequired(false); // 任意入力

  const firstActionRow = new ActionRowBuilder().addComponents(remarksInput);
  modal.addComponents(firstActionRow);

  try {
      await interaction.showModal(modal);
  } catch (error) {
       console.error("モーダル表示エラー:", error);
       // showModalが失敗した場合、ユーザーに応答する必要があるかもしれない
       await interaction.followUp({ content: "備考入力画面の表示に失敗しました。", ephemeral: true }).catch(() => {});
  }
}

// セレクトメニュー処理関数
async function handleSelectMenuInteraction(interaction) {
  const customId = interaction.customId;
  console.log(`セレクトメニュー処理: ${customId}`);

  try {
    // 時間選択メニュー (募集作成用)
    if (customId.startsWith('time_select_')) {
      const parts = customId.split('_');
      const raidType = parts[2];
      const date = parts[3];
      const selectedTime = interaction.values[0];
      await confirmRecruitment(interaction, raidType, date, selectedTime);
    }
    // 参加タイプ選択
    else if (customId.startsWith('join_type_')) {
      const recruitmentId = customId.split('_')[2];
      const selectedType = interaction.values[0];
      await showAttributeSelection(interaction, recruitmentId, selectedType);
    }
    // 属性選択
    else if (customId.startsWith('attribute_select_')) {
      const parts = customId.split('_');
      const recruitmentId = parts[2];
      const joinType = parts[3];
      const selectedAttributes = interaction.values;
      await showTimeAvailabilitySelection(interaction, recruitmentId, joinType, selectedAttributes);
    }
    // テスト参加者数選択メニュー
else if (customId.startsWith('test_participant_count_')) {
  const recruitmentId = customId.replace('test_participant_count_', '');
  const count = parseInt(interaction.values[0], 10);
  await showTestParticipantConfirmation(interaction, recruitmentId, count);
}
    // 参加可能時間選択
    else if (customId.startsWith('time_availability_')) {
      const parts = customId.split('_');
      const recruitmentId = parts[2];
      const joinType = parts[3];
      const attributesStr = parts[4];
      const selectedTime = interaction.values[0];
      const selectedAttributes = attributesStr.split(',');
      
      await showJoinConfirmation(
        interaction,
        recruitmentId,
        joinType,
        selectedAttributes,
        selectedTime
      );
    }
    // その他のセレクトメニュー
    else {
      console.log(`未処理のセレクトメニューID: ${customId}`);
      await interaction.update({
        content: 'このメニューは現在サポートされていません',
        components: []
      });
    }
  } catch (error) {
    console.error(`セレクトメニュー処理エラー (${customId}):`, error);
    handleErrorReply(interaction, error);
  }
}

// 募集開始処理を完全修正
async function startRecruitment(message) {
  // レイドタイプ選択ボタン
  const row = new ActionRowBuilder()
    .addComponents(
      ...raidTypes.map(type =>
        new ButtonBuilder()
          .setCustomId(`raid_type_${type}`)
          .setLabel(type)
          .setStyle(ButtonStyle.Primary)
      )
    );

  const embed = new EmbedBuilder()
    .setTitle('🔰 高難易度募集作成')
    .setDescription('募集するレイドタイプを選択してください。')
    .setColor('#0099ff');

  const response = await message.reply({
    embeds: [embed],
    components: [row]
  });

  // 30分後に募集作成UIのボタンを無効化（募集自体ではなく、作成UIだけ）
  setTimeout(() => {
    const disabledRow = new ActionRowBuilder()
      .addComponents(
        ...raidTypes.map(type =>
          new ButtonBuilder()
            .setCustomId(`raid_type_${type}`)
            .setLabel(type)
            .setStyle(ButtonStyle.Primary)
            .setDisabled(true)
        )
      );

    // 新しいEmbedBuilderを作成
    const timeoutEmbed = new EmbedBuilder()
      .setTitle('🔰 高難易度募集作成（期限切れ）')
      .setDescription('この募集作成セッションは期限切れになりました。新しく募集を開始するには `!募集` コマンドを使用してください。')
      .setColor('#FF6B6B');

    response.edit({
      embeds: [timeoutEmbed],
      components: [disabledRow]
    }).catch(error => {
      console.error('募集作成UI無効化エラー:', error);
    });
    
    console.log(`[募集作成UI] ${message.author.tag}の募集作成UIを無効化しました（タイムアウト）`);
    console.log(`[募集作成UI] アクティブな募集数: ${activeRecruitments.size}`);
  }, 30 * 60 * 1000); // 30分後
}

// 募集確定処理を修正 - 新規メッセージとして作成する
async function finalizeRecruitment(interaction, recruitmentId) {
  console.log(`募集確定処理開始: ${recruitmentId}`);

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) {
    console.error(`募集データが見つかりません: ${recruitmentId}`);
    return await interaction.update({
      content: 'エラー: 募集データが見つかりません。',
      embeds: [],
      components: []
    });
  }

  recruitment.status = 'active';
  
  const formattedDate = new Date(recruitment.date).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const embed = createRecruitmentEmbed(recruitment, formattedDate);

  const joinRow = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`join_recruitment_${recruitmentId}`)
        .setLabel('参加申込')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`cancel_participation_${recruitmentId}`)
        .setLabel('参加キャンセル')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`close_recruitment_${recruitmentId}`)
        .setLabel('募集締め切り')
        .setStyle(ButtonStyle.Danger)
    );

  try {
    // 募集作成UIには完了メッセージを表示
    await interaction.update({
      content: '募集を作成しました！以下に作成された募集が表示されます。',
      embeds: [],
      components: []
    });

    // チャンネルを取得
    const channel = await client.channels.fetch(interaction.channelId);
    
    // 新しいメッセージとして募集を送信
    const recruitMessage = await channel.send({
      content: '**【募集中】**',
      embeds: [embed],
      components: [joinRow]
    });

    // 新しいメッセージIDを保存
    recruitment.messageId = recruitMessage.id;
    
    // デバッグログ
    console.log(`募集確定完了: ID=${recruitmentId}, メッセージID=${recruitment.messageId}`);
    console.log(`募集作成UIのメッセージID: ${interaction.message.id} (別物)`);
    
    // 更新された募集データを保存
    activeRecruitments.set(recruitmentId, recruitment);
  } catch (error) {
    console.error('募集確定エラー:', error);
    await interaction.update({
      content: '募集の作成中にエラーが発生しました。もう一度お試しください。',
      embeds: [],
      components: []
    });
  }
}



// 日付選択UI表示
async function showDateSelection(interaction, raidType) {
  // 今日から7日分の日付ボタンを作成
  const dateButtons = [];
  const today = new Date();

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const displayDate = `${date.getMonth() + 1}/${date.getDate()}`;

    dateButtons.push(
      new ButtonBuilder()
        .setCustomId(`date_select_${raidType}_${dateString}`)
        .setLabel(displayDate)
        .setStyle(ButtonStyle.Secondary)
    );
  }

  // ボタンを行に分ける（1行に最大5つまで）
  const rows = [];
  for (let i = 0; i < dateButtons.length; i += 5) {
    const row = new ActionRowBuilder()
      .addComponents(dateButtons.slice(i, Math.min(i + 5, dateButtons.length)));
    rows.push(row);
  }

  const embed = new EmbedBuilder()
    .setTitle(`📅 ${raidType}募集 - 日付選択`)
    .setDescription('開催したい日付を選択してください。')
    .setColor('#0099ff');

  await interaction.update({
    embeds: [embed],
    components: rows
  });
}

// 時間選択UI表示
async function showTimeSelection(interaction, raidType, date) {
  // 時間選択用セレクトメニュー
  const row = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`time_select_${raidType}_${date}`)
        .setPlaceholder('開催時間を選択してください')
        .addOptions(timeOptions)
    );

  const formattedDate = new Date(date).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const embed = new EmbedBuilder()
    .setTitle(`⏰ ${raidType}募集 - 時間選択`)
    .setDescription(`選択した日付: ${formattedDate}\n開催時間を選択してください。`)
    .setColor('#0099ff');

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

// 募集確認UI表示
async function confirmRecruitment(interaction, raidType, date, time) {
  const formattedDate = new Date(date).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  // 一貫したIDを生成 (Math.randomによる不一致を防ぐ)
  const timestamp = Date.now();
  const recruitmentId = `${timestamp}-${Math.random().toString(36).substring(2, 9)}`;
  
  // IDをログ出力して追跡しやすくする
  console.log(`募集確認 - ID生成: ${recruitmentId}`);

  const embed = new EmbedBuilder()
    .setTitle('🔍 募集内容確認')
    .setDescription('以下の内容で募集を開始します。よろしければ「確定」ボタンを押してください。')
    .setColor('#0099ff')
    .addFields(
      { name: 'レイドタイプ', value: raidType, inline: true },
      { name: '開催日', value: formattedDate, inline: true },
      { name: '開催時間', value: time, inline: true },
      { name: '募集者', value: interaction.user.toString(), inline: true }
    );

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_recruitment_${recruitmentId}`)
        .setLabel('確定')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('cancel_recruitment')
        .setLabel('キャンセル')
        .setStyle(ButtonStyle.Danger)
    );

  // 一時データを保存
  const recruitmentData = {
    id: recruitmentId,
    type: raidType,
    date: date,
    time: time,
    creator: interaction.user.id,
    creatorUsername: interaction.user.username,
    participants: [],
    status: 'pending',
    channel: interaction.channelId,
    messageId: null,
    createdAt: new Date().toISOString(),
   //%20%E9%96%8B%E5%82%AC%E6%97%A5%E3%81%AE%E6%9C%9D8%E6%99%82%E3%82%92%E6%98%8E%E7%A4%BA%E7%9A%84%E3%81%AB%E8%A8%AD%E5%AE%9A
  };

  activeRecruitments.set(recruitmentId, recruitmentData);
  console.log(`募集データ作成: ${recruitmentId}`);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}


// 募集用エンベッド作成ヘルパー関数
function createRecruitmentEmbed(recruitment, formattedDate) {
  const embed = new EmbedBuilder()
    .setTitle(`📢 【募集】${recruitment.type} - ${formattedDate} ${recruitment.time}`)
    .setDescription(`募集者: <@${recruitment.creator}>\n\n参加希望の方は下のボタンから申し込んでください。`)
    .setColor('#0099ff')
    .addFields(
      ...attributes.map(attr => {
        return { name: `【${attr}】`, value: '未定', inline: true };
      })
    )
    .setFooter({ text: `募集ID: ${recruitment.id} | 開催日の夕方5時に自動締め切り` });
  
  return embed;
}
// 参加オプション表示
async function showJoinOptions(interaction, recruitmentId) {
  console.log(`参加オプション表示: ${recruitmentId}`);
  
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.reply({
      content: 'この募集は既に終了しているか、存在しません。',
      ephemeral: true
    });
  }

  // すでに参加している場合
  const existingParticipation = recruitment.participants.find(p => p.userId === interaction.user.id);
  if (existingParticipation) {
    return await interaction.reply({
      content: `あなたはすでにこの募集に参加しています。\n選択した属性: ${existingParticipation.attributes.join(', ')}\n参加可能時間: ${existingParticipation.timeAvailability}`,
      ephemeral: true
    });
  }

  const formattedDate = new Date(recruitment.date).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  let selectOptions = [];

  // 募集タイプに応じた参加オプションを設定
  if (recruitment.type === '参加者希望') {
    selectOptions = [
      { label: '天元', value: '天元', description: '天元の戦闘に参加希望' },
      { label: 'ルシゼロ', value: 'ルシゼロ', description: 'ルシファーHL、ゼロ討滅戦に参加希望' },
      { label: 'なんでも可', value: 'なんでも可', description: 'どちらでも参加可能' }
    ];
  } else {
    // 天元またはルシゼロ募集の場合は自動的にそのタイプに設定
    selectOptions = [
      { label: recruitment.type, value: recruitment.type, description: `${recruitment.type}の戦闘に参加` }
    ];
  }

  const row = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`join_type_${recruitmentId}`)
        .setPlaceholder('参加タイプを選択してください')
        .addOptions(selectOptions)
    );

  const embed = new EmbedBuilder()
    .setTitle('🎮 参加申込')
    .setDescription(`【${recruitment.type}】${formattedDate} ${recruitment.time}\n\n参加タイプを選択してください。`)
    .setColor('#00cc99');

  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true
  });
}

// 属性選択UI表示
async function showAttributeSelection(interaction, recruitmentId, joinType) {
  console.log(`属性選択UI表示: ${recruitmentId}, ${joinType}`);
  
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.update({
      content: 'この募集は既に終了しているか、存在しません。',
      embeds: [],
      components: []
    });
  }

  const attributeOptions = attributes.map(attr => {
    return {
      label: attr,
      value: attr,
      description: `${attr}属性で参加`
    };
  });

  const row = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`attribute_select_${recruitmentId}_${joinType}`)
        .setPlaceholder('参加可能な属性を選択してください（複数選択可）')
        .setMinValues(1)
        .setMaxValues(attributes.length)
        .addOptions(attributeOptions)
    );

  const embed = new EmbedBuilder()
    .setTitle('🔮 属性選択')
    .setDescription(`参加タイプ: ${joinType}\n\n参加可能な属性を選択してください（複数選択可）。`)
    .setColor('#00cc99');

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

// 時間選択UI表示
async function showTimeAvailabilitySelection(interaction, recruitmentId, joinType, selectedAttributes) {
  console.log(`時間選択UI表示: ${recruitmentId}, ${joinType}, 属性=[${selectedAttributes.join(',')}]`);

  try {
    // 時間選択肢
    // 24時間対応の時間選択肢
const timeSelectOptions = [];
for (let i = 0; i < 24; i++) {
  const hour = i.toString().padStart(2, '0');
  timeSelectOptions.push({
    label: `${hour}:00`,
    value: `${hour}:00`,
    description: `${hour}:00から参加可能`
  });
}
// 「今すぐ」オプションも追加
timeSelectOptions.push({
  label: '今すぐ',
  value: 'now',
  description: '今すぐ参加可能'
});
    
    //const timeSelectOptions = [
      //{ label: '19:00', value: '19:00', description: '19:00から参加可能' },
    //  { label: '20:00', value: '20:00', description: '20:00から参加可能' },
  //    { label: '21:00', value: '21:00', description: '21:00から参加可能' },
    //  { label: '22:00', value: '22:00', description: '22:00から参加可能' },
    //  { label: '23:00', value: '23:00', description: '23:00から参加可能' },
     // { label: '今すぐ', value: 'now', description: '今すぐ参加可能' }
   // ];

    // カスタムID (安全に作成)
    const attributesJoined = selectedAttributes.join(',');
    
    // 一時データに保存（IDが長すぎる場合に備えて）
    tempUserData.set(interaction.user.id, {
      recruitmentId,
      joinType,
      attributes: selectedAttributes
    });
    
    const customId = `time_availability_${recruitmentId}_${joinType}_${attributesJoined}`;

    // UIコンポーネント
    const row = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(customId)
          .setPlaceholder('参加可能な時間を選択')
          .addOptions(timeSelectOptions)
      );

    const embed = new EmbedBuilder()
      .setTitle('⏰ 参加可能時間の選択')
      .setDescription(`参加タイプ: ${joinType}\n選択した属性: ${selectedAttributes.join(', ')}`)
      .setColor('#00cc99');

    // 更新送信
    await interaction.update({
      embeds: [embed],
      components: [row]
    });

    console.log('時間選択UI表示成功');
  } catch (error) {
    console.error('時間選択UI表示エラー:', error);
    
    // エラー表示
    await interaction.update({
      content: '時間選択の表示中にエラーが発生しました。もう一度お試しください。',
      embeds: [],
      components: []
    }).catch(e => console.error('エラー応答失敗:', e));
  }
}

// 参加確認UI表示
async function showJoinConfirmation(interaction, recruitmentId, joinType, selectedAttributes, timeAvailability) {
  console.log(`参加確認UI表示: ${recruitmentId}, ${joinType}, 時間=${timeAvailability}`);
  
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.update({
      content: 'この募集は既に終了しているか、存在しません。',
      embeds: [],
      components: []
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('✅ 参加申込確認')
    .setDescription('以下の内容で参加申込を確定します。')
    .setColor('#00cc99')
    .addFields(
      { name: '参加タイプ', value: joinType, inline: true },
      { name: '参加可能属性', value: selectedAttributes.join(', '), inline: true },
      { name: '参加可能時間', value: timeAvailability, inline: true }
    );

  // 一時データに保存
  tempUserData.set(interaction.user.id, { recruitmentId, joinType, attributes: selectedAttributes, timeAvailability });

   // 安全なカスタムID
   const confirmBtnId = `confirm_${recruitmentId}`;
   // ★ 備考モーダルを開くボタンIDに変更
   const openRemarksModalBtnId = `open_remarks_modal_${recruitmentId}`;

    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
         .setCustomId(confirmBtnId)
        .setLabel('参加確定')
         .setCustomId(openRemarksModalBtnId) // ★ 変更
        .setLabel('備考入力して参加確定') // ★ 変更
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('cancel_join')
          .setLabel('キャンセル')
          .setStyle(ButtonStyle.Danger)
      );

    await interaction.update({
      embeds: [embed],
      components: [row]
    });
  }

// 参加確認ボタン処理
async function processConfirmation(interaction, recruitmentId) {
  console.log(`参加確認ボタン処理: ${recruitmentId}`);
  
  // 一時データから参加情報を取得
  const userData = tempUserData.get(interaction.user.id);
  
  if (!userData || userData.recruitmentId !== recruitmentId) {
    return await interaction.update({
      content: 'エラー: 参加情報が見つかりません。もう一度参加申込をしてください。',
      embeds: [],
      components: []
    });
  }
  
  // 参加確定処理に渡す
  await confirmParticipation(
    interaction, 
    recruitmentId, 
    userData.joinType, 
    userData.attributes, 
    userData.timeAvailability
  );
  
  // 一時データを削除
  tempUserData.delete(interaction.user.id);
}

// 重複している関数を1つだけにする
// 以下の関数を使用

// 参加確定処理
async function confirmParticipation(interaction, recruitmentId, joinType, selectedAttributes, timeAvailability) {
  console.log(`参加確定処理: ${recruitmentId}, ${joinType}, 時間=${timeAvailability}`);
  
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.update({
      content: 'この募集は既に終了しているか、存在しません。',
      embeds: [],
      components: []
    });
  }

  // 参加者データを作成
  const participantData = {
    userId: interaction.user.id,
    username: interaction.user.username,
    joinType: joinType,
    attributes: selectedAttributes,
    timeAvailability: timeAvailability,
    assignedAttribute: null // 割り当ては後で行う
  };

  // すでに参加している場合は情報を更新
  const existingIndex = recruitment.participants.findIndex(p => p.userId === interaction.user.id);

  if (existingIndex >= 0) {
    recruitment.participants[existingIndex] = participantData;
    console.log(`既存参加者情報を更新: ${interaction.user.username}`);
  } else {
    recruitment.participants.push(participantData);
    console.log(`新規参加者を追加: ${interaction.user.username}`);
  }

  // デバッグ用に確認
  console.log(`現在の参加者数: ${recruitment.participants.length}`);
  
  // 募集メッセージの更新
  await updateRecruitmentMessage(recruitment);

  await interaction.update({
    content: '参加申込が完了しました！',
    embeds: [],
    components: []
  });
}

// 参加キャンセル処理
async function cancelParticipation(interaction, recruitmentId) {
  console.log(`参加キャンセル処理: ${recruitmentId}`);
  
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) {
    return await interaction.reply({
      content: 'この募集は存在しません。',
      ephemeral: true
    });
  }

  const participantIndex = recruitment.participants.findIndex(p => p.userId === interaction.user.id);

  if (participantIndex === -1) {
    return await interaction.reply({
      content: 'あなたはこの募集に参加していません。',
      ephemeral: true
    });
  }

  // 参加者リストから削除
  recruitment.participants.splice(participantIndex, 1);
  console.log(`参加者を削除: ${interaction.user.username}, 残り参加者数: ${recruitment.participants.length}`);

  // 割り振りが行われていた場合、再割り振り
  if (recruitment.status === 'assigned') {
    await autoAssignAttributes(recruitment);
  }

  // 募集メッセージの更新
  await updateRecruitmentMessage(recruitment);

  await interaction.reply({
    content: '参加をキャンセルしました。',
    ephemeral: true
  });
}
// 募集締め切り処理
async function closeRecruitment(interaction, recruitmentId) {
  console.log(`募集締め切り処理: ${recruitmentId}`);
  
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) {
    return await interaction.reply({
      content: 'この募集は存在しません。',
      ephemeral: true
    });
  }

  // 募集者以外は締め切れないようにする
  if (interaction.user.id !== recruitment.creator) {
    return await interaction.reply({
      content: '募集者のみが募集を締め切ることができます。',
      ephemeral: true
    });
  }
  
  recruitment.status = 'closed';
  console.log(`募集を締め切り: ${recruitmentId}, 参加者数: ${recruitment.participants.length}`);

  // 属性の自動割り振りを実行 (プレビューモードではなく、実際に割り振る)
  await autoAssignAttributes(recruitment, false);

  // 募集メッセージの更新
  await updateRecruitmentMessage(recruitment);

  await interaction.reply({
    content: '募集を締め切り、属性の割り振りを行いました。',
    ephemeral: true
  });
}

// 募集メッセージ更新処理
async function updateRecruitmentMessage(recruitment) {
  try {
    console.log(`募集メッセージ更新: ${recruitment.id}, チャンネル=${recruitment.channel}, メッセージ=${recruitment.messageId}`);
    
    const channel = await client.channels.fetch(recruitment.channel);
    if (!channel) {
      console.error(`チャンネルが見つかりません: ${recruitment.channel}`);
      return;
    }

    const message = await channel.messages.fetch(recruitment.messageId);
    if (!message) {
      console.error(`メッセージが見つかりません: ${recruitment.messageId}`);
      return;
    }

    const formattedDate = new Date(recruitment.date).toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    // 参加者情報を集計
    const participantsByAttribute = {};
    attributes.forEach(attr => {
      participantsByAttribute[attr] = [];
    });

    // 参加者を属性ごとに分類
    recruitment.participants.forEach(participant => {
      participant.attributes.forEach(attr => {
        if (!participantsByAttribute[attr].includes(participant)) {
          participantsByAttribute[attr].push(participant);
        }
      });
    });

    let description = `募集者: <@${recruitment.creator}>\n\n`;

    // 募集ステータスに応じた表示
    if (recruitment.status === 'active') {
      description += '🟢 **募集中**\n参加希望の方は下のボタンから申し込んでください。\n\n';
    } else if (recruitment.status === 'closed' || recruitment.status === 'assigned') {
      description += '🔴 **募集終了**\n';
      
      // 参加者希望の場合、選ばれたコンテンツを表示
      if (recruitment.type === '参加者希望' && recruitment.finalRaidType) {
        description += `**選択されたコンテンツ: ${recruitment.finalRaidType}**\n`;
      }

      // 最終的な開催時間と日付を表示
      if (recruitment.finalTime) {
        description += `**開催予定時間: ${recruitment.finalTime}**\n`;
      }
      
      description += '以下の通り参加者を割り振りました。\n\n';
    }

    // 参加者の詳細リスト（募集中の場合）
    if (recruitment.status === 'active' && recruitment.participants.length > 0) {
      description += '**【参加表明者】**\n';
      const participantsByTime = {};

      recruitment.participants.forEach(p => {
        if (!participantsByTime[p.timeAvailability]) {
          participantsByTime[p.timeAvailability] = [];
        }
        participantsByTime[p.timeAvailability].push(p);
      });

      // 時間帯ごとに表示
      Object.keys(participantsByTime).sort().forEach(time => {
        description += `⏰ **${time}〜** (${participantsByTime[time].length}名)\n`;
        participantsByTime[time].forEach(p => {
          description += `- <@${p.userId}> [${p.joinType}] ${p.attributes.join('/')}\n`;
        });
        description += '\n';
      });
    }

    // エンベッド作成
    const embed = new EmbedBuilder()
      .setTitle(`${recruitment.status === 'active' ? '📢' : '🏁'} 【${recruitment.type}】${formattedDate} ${recruitment.time}`)
      .setDescription(description)
      .setColor(recruitment.status === 'active' ? '#0099ff' : '#ff6666');

    // 各属性のフィールドを設定
    const fields = [];
    attributes.forEach(attr => {
      let value = '未定';

      // 割り振り済みの場合
      if (recruitment.status === 'closed' || recruitment.status === 'assigned') {
        const assignedParticipant = recruitment.participants.find(p => p.assignedAttribute === attr);
        if (assignedParticipant) {
          value = `<@${assignedParticipant.userId}>`;
        }
      } else {
        // 通常の募集中の場合は各属性の希望者数を表示
        const count = participantsByAttribute[attr].length;
        value = count > 0 ? `${count}名が希望` : '未定';
      }

      fields.push({ name: `【${attr}】`, value: value, inline: true });
    });

    embed.addFields(fields);
    embed.setFooter({ text: `募集ID: ${recruitment.id} | ${recruitment.status === 'active' ? '開催日の朝8時に自動締め切り' : '募集終了'}` });

    // ボタン行を作成（募集中の場合のみ有効）
    const joinRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`join_recruitment_${recruitment.id}`)
          .setLabel('参加申込')
          .setStyle(ButtonStyle.Primary)
          .setDisabled(recruitment.status !== 'active'),
        new ButtonBuilder()
          .setCustomId(`cancel_participation_${recruitment.id}`)
          .setLabel('参加キャンセル')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(recruitment.status !== 'active'),
        new ButtonBuilder()
          .setCustomId(`close_recruitment_${recruitment.id}`)
          .setLabel('募集締め切り')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(recruitment.status !== 'active')
      );

    // components変数を定義（現時点ではjoinRowだけ）
    const components = [joinRow];

    // テストモードがアクティブな場合のみテスト参加者追加ボタンを表示
    if (testMode.active && recruitment.status === 'active') {
      const testRow = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`add_test_participants_${recruitment.id}`)
            .setLabel('🧪 テスト参加者追加')
            .setStyle(ButtonStyle.Secondary)
        );
      components.push(testRow);
    }

    // メッセージを更新
    await message.edit({
      content: recruitment.status === 'active' ? '**【募集中】**' : '**【募集終了】**',
      embeds: [embed],
      components: components
    });
    
    console.log(`募集メッセージ更新完了: ${recruitment.id}`);
  } catch (error) {
    console.error('募集メッセージ更新エラー:', error);
  }
}
// previewOnlyパラメータを追加
async function autoAssignAttributes(recruitment, previewOnly = false) {
  console.log(`属性自動割り振り処理: ${recruitment.id}, 参加者数=${recruitment.participants.length}, プレビューモード=${previewOnly}`);
  
  // 割り振りが必要ない場合
  if (recruitment.participants.length === 0) {
    console.log('参加者がいないため、割り振りをスキップします');
    return;
  }

  // ステータス変更はプレビューモードでない場合のみ行う
  if (!previewOnly) {
    recruitment.status = 'assigned';
    console.log(`ステータスを'assigned'に変更しました`);
  } else {
    console.log(`プレビューモード: ステータスは変更しません`);
  }

  // 時間帯ごとに参加者をグループ化
  const participantsByTime = {};
  recruitment.participants.forEach(p => {
    if (!participantsByTime[p.timeAvailability]) {
      participantsByTime[p.timeAvailability] = [];
    }
    participantsByTime[p.timeAvailability].push({ ...p });
  });

  // 各時間帯の参加者に対して属性割り振りを実行
  const timeSlots = Object.keys(participantsByTime).sort();
  console.log(`利用可能な時間枠: ${timeSlots.join(', ')}`);

  // 時間枠の順序マップを作成（数値が大きいほど遅い時間）
  const timeOrder = {
    '今すぐ': 0,
    '00:00': 1, '01:00': 2, '02:00': 3, '03:00': 4, '04:00': 5,
    '05:00': 6, '06:00': 7, '07:00': 8, '08:00': 9, '09:00': 10,
    '10:00': 11, '11:00': 12, '12:00': 13, '13:00': 14, '14:00': 15,
    '15:00': 16, '16:00': 17, '17:00': 18, '18:00': 19, '19:00': 20,
    '20:00': 21, '21:00': 22, '22:00': 23, '23:00': 24
  };

  // 最も遅い時間帯を見つける
  let latestTimeSlot = timeSlots[0] || 'デフォルト';
  let latestTimeValue = timeOrder[latestTimeSlot] || 0;

  // レイドタイプに適合するすべての参加者を収集
  let allEligibleParticipants = [];

  timeSlots.forEach(timeSlot => {
    // 参加タイプによるフィルタリング
    const filteredParticipants = participantsByTime[timeSlot].filter(p => {
      if (recruitment.type === '天元') {
        return p.joinType === '天元' || p.joinType === 'なんでも可';
      } else if (recruitment.type === 'ルシゼロ') {
        return p.joinType === 'ルシゼロ' || p.joinType === 'なんでも可';
      } else {
        // 参加者希望の場合は全員対象
        return true;
      }
    });
    
    console.log(`時間枠 ${timeSlot}: ${filteredParticipants.length}名が参加可能`);

    // すべての対象参加者を集める
    allEligibleParticipants = allEligibleParticipants.concat(filteredParticipants);

    // 時間枠の値を取得（定義されていなければ0）
    const timeValue = timeOrder[timeSlot] || 0;
  
    // より遅い時間枠を見つけた場合に更新
    if (timeValue > latestTimeValue && filteredParticipants.length > 0) {
      latestTimeValue = timeValue;
      latestTimeSlot = timeSlot;
    }
  });

  console.log(`最適な時間枠: ${latestTimeSlot} (最も遅い時間)`);
  console.log(`合計の対象参加者数: ${allEligibleParticipants.length}名 (全時間帯合計)`);
  
  // 一番参加者が多い時間帯のレイドタイプを決定（参加者希望の場合のみ）
  let raidTypeToAssign = recruitment.type;
  if (recruitment.type === '参加者希望') {
    // レイドタイプのカウント
    let tengenCount = 0;
    let luciZeroCount = 0;

    allEligibleParticipants.forEach(p => {
      if (p.joinType === '天元') tengenCount++;
      else if (p.joinType === 'ルシゼロ') luciZeroCount++;
      else if (p.joinType === 'なんでも可') {
        // なんでも可の場合は両方にカウント（若干少なめに）
        tengenCount += 0.5; // 半分ずつカウント
        luciZeroCount += 0.5;
      }
    });

    raidTypeToAssign = tengenCount > luciZeroCount ? '天元' : 'ルシゼロ';
    console.log(`決定したレイドタイプ: ${raidTypeToAssign} (天元=${tengenCount}名, ルシゼロ=${luciZeroCount}名)`);
  }

  // 最終的なレイドタイプに基づいて参加者をフィルタリング
  const eligibleParticipants = allEligibleParticipants.filter(p => {
    if (raidTypeToAssign === '天元') {
      return p.joinType === '天元' || p.joinType === 'なんでも可';
    } else {
      return p.joinType === 'ルシゼロ' || p.joinType === 'なんでも可';
    }
  });
  
  console.log(`割り振り対象参加者数: ${eligibleParticipants.length}名 (全時間帯から適合者)`);

  // ユーザーごとと対象の参加者をデバッグ出力
  eligibleParticipants.forEach(p => {
    console.log(`対象参加者: ${p.username}, 参加タイプ=${p.joinType}, 属性=[${p.attributes.join(',')}], 時間=${p.timeAvailability}`);
  });

  // 属性の割り振り処理 (改善版)
  const assignments = {};
  const attributeCounts = {};
  
  // 各属性の希望者数をカウント初期化
  attributes.forEach(attr => {
    attributeCounts[attr] = 0;
  });
  
  // 各属性の希望者をカウント
  eligibleParticipants.forEach(p => {
    p.attributes.forEach(attr => {
      attributeCounts[attr]++;
    });
  });
  
  console.log('各属性の希望者数:', attributeCounts);
  
  // 各参加者の属性選択と、各属性の人気度を掛け合わせてスコア計算
  eligibleParticipants.forEach(p => {
    // 各属性のスコアを計算（希望者が少ない属性ほど高スコア）
    p.attributeScores = {};
    p.attributes.forEach(attr => {
      // 希望者が少ないほど高スコア = 1/希望者数
      // 例: 希望者1人→スコア1.0、希望者2人→スコア0.5
      p.attributeScores[attr] = 1 / Math.max(1, attributeCounts[attr]);
    });
    
    // 参加者の優先スコア = 選択属性の少なさ + 属性の希少性
    p.priorityScore = (10 / Math.max(1, p.attributes.length)) + 
                       (p.attributes.length > 0 ? Math.max(...Object.values(p.attributeScores)) : 0);
  });
  
  // 参加者を優先スコア降順でソート (スコアが高い人から割り当て)
  eligibleParticipants.sort((a, b) => b.priorityScore - a.priorityScore);
  
  // 各参加者用のデバッグ情報
  eligibleParticipants.forEach((p, index) => {
    console.log(`参加者${index + 1}: ${p.username}, 希望属性: [${p.attributes.join(', ')}], 優先スコア: ${p.priorityScore.toFixed(2)}, 時間枠: ${p.timeAvailability}`);
  });
  
  // 各参加者について処理
  for (const participant of eligibleParticipants) {
    // この参加者が選択した属性で、まだ割り当てられていないものを探す
    const availableAttributes = participant.attributes.filter(attr => !assignments[attr]);
    
    if (availableAttributes.length > 0) {
      // 利用可能な属性でスコアが最も高い（希望者が少ない）ものを選択
      availableAttributes.sort((a, b) => {
        return participant.attributeScores[b] - participant.attributeScores[a];
      });
      
      const chosenAttribute = availableAttributes[0];
      assignments[chosenAttribute] = participant;
      participant.assignedAttribute = chosenAttribute;
      console.log(`${participant.username}を${chosenAttribute}属性に割り当てました (希望者${attributeCounts[chosenAttribute]}人中)`);
    } else {
      console.log(`${participant.username}に割り当て可能な属性がありません`);
    }
  }

  // autoAssignAttributes 関数内の該当部分を置き換え

  // 埋まっていない属性を、まだ割り当てられていない参加者で埋める
  const unassignedParticipants = eligibleParticipants.filter(p => !p.assignedAttribute);
  const emptyAttributes = attributes.filter(attr => !assignments[attr]);
  
  console.log(`未割り当て参加者: ${unassignedParticipants.length}名`);
  console.log(`空の属性: [${emptyAttributes.join(', ')}]`);

  // 希望属性が一致する参加者のみを割り当てる
  for (let i = 0; i < unassignedParticipants.length; i++) {
    if (emptyAttributes.length === 0) break;
    
    const participant = unassignedParticipants[i];
    
    // 参加者の希望属性と一致する未割り当ての属性を探す
    const matchingAttrs = emptyAttributes.filter(attr => 
      participant.attributes.includes(attr)
    );
    
    if (matchingAttrs.length > 0) {
      // 希望属性と一致する場合のみ割り当てる
      const attr = matchingAttrs[0];
      assignments[attr] = participant;
      participant.assignedAttribute = attr;
      
      // 処理済みの属性をリストから削除
      const attrIndex = emptyAttributes.indexOf(attr);
      if (attrIndex !== -1) {
        emptyAttributes.splice(attrIndex, 1);
      }
      
      console.log(`未割り当て参加者 ${participant.username} を ${attr} に割り当てました (希望一致)`);
    } else {
      console.log(`未割り当て参加者 ${participant.username} は希望属性と一致する空き属性がないため、割り当てません`);
    }
  }

  // 空属性が残った場合は未定のままにする（希望外には割り当てない）
  if (emptyAttributes.length > 0) {
    console.log(`${emptyAttributes.length}個の属性は希望者がいないため未定のままにします: [${emptyAttributes.join(', ')}]`);
  }

  // 割り当て結果を元の参加者リストに反映
  for (const participant of recruitment.participants) {
    const assignedParticipant = eligibleParticipants.find(p => p.userId === participant.userId);
    if (assignedParticipant && assignedParticipant.assignedAttribute) {
      participant.assignedAttribute = assignedParticipant.assignedAttribute;
      console.log(`元のリストで ${participant.username} を ${participant.assignedAttribute} に設定しました (時間枠: ${participant.timeAvailability})`);
    } else {
      participant.assignedAttribute = null;
      console.log(`${participant.username} は割り当てられませんでした`);
    }
  }

  // 割り当て結果を元の参加者リストに反映
  for (const participant of recruitment.participants) {
    const assignedParticipant = eligibleParticipants.find(p => p.userId === participant.userId);
    if (assignedParticipant && assignedParticipant.assignedAttribute) {
      participant.assignedAttribute = assignedParticipant.assignedAttribute;
      console.log(`元のリストで ${participant.username} を ${participant.assignedAttribute} に設定しました (時間枠: ${participant.timeAvailability})`);
    } else {
      participant.assignedAttribute = null;
      console.log(`${participant.username} は割り当てられませんでした`);
    }
  }

  // 時間とレイドタイプを更新
  recruitment.finalTime = latestTimeSlot;
  recruitment.finalRaidType = raidTypeToAssign;
  console.log(`最終開催時間: ${latestTimeSlot}, 最終レイドタイプ: ${raidTypeToAssign}`);

  return recruitment;
}

// 自動締め切りチェック処理も修正して明確にする
function checkAutomaticClosing() {
  const now = new Date();

  // 現在のアクティブな募集数をログ
  const activeCount = Array.from(activeRecruitments.values())
    .filter(r => r.status === 'active').length;
  console.log(`[自動締め切り] チェック開始 - アクティブ募集数: ${activeCount}`);

  
  activeRecruitments.forEach(async (recruitment, id) => {
    // activeな募集のみ処理
    if (recruitment.status !== 'active') return;

    const raidDate = new Date(recruitment.date);
    raidDate.setHours(8, 0, 0, 0); // 開催日の朝8時
    
    
    // 日付比較のデバッグ
    const isTimeToClose = now >= raidDate;
    if (isTimeToClose) {
      console.log(`[自動締め切り] 募集ID: ${id} - 締切時刻を過ぎています`);
      console.log(`[自動締め切り] 募集日: ${recruitment.date}, 締切時刻: ${raidDate.toISOString()}`);
      console.log(`[自動締め切り] 現在時刻: ${now.toISOString()}`);
      
      try {
        // 状態を変更
        console.log(`[自動締め切り] ステータスを closed に変更`);
        recruitment.status = 'closed';
        activeRecruitments.set(id, recruitment);
        
        // 属性割り振り
        console.log(`[自動締め切り] 属性割り振り開始`);
        await autoAssignAttributes(recruitment);
        
        // メッセージ更新
        console.log(`[自動締め切り] メッセージ更新`);
        await updateRecruitmentMessage(recruitment);

        // 終了メッセージ
        console.log(`[自動締め切り] 終了メッセージ送信`);
        const channel = await client.channels.fetch(recruitment.channel);
        if (channel) {
          await channel.send({
            content: `<@${recruitment.creator}> **【自動締め切り】** ${recruitment.type}募集が締め切られ、参加者が割り振られました。`
          });
          console.log(`[自動締め切り] 完了 - ID: ${id}`);
        }
      } catch (error) {
        console.error(`[自動締め切り] エラー発生: ${error.message}`);
      }
    } else {
      // 一定の間隔でデバッグ情報を出力（すべての募集で毎回出力すると多すぎるので）
      const minutes = now.getMinutes();
      if (minutes % 10 === 0) { // 10分ごとに出力
        console.log(`[自動締め切り] 募集ID ${id} - まだ締切時刻ではありません`);
        console.log(`[自動締め切り] 締切予定: ${raidDate.toISOString()}`);
      }
    }
  });
}

// 募集リスト表示機能
async function showActiveRecruitments(message) {
  const activeList = Array.from(activeRecruitments.values())
    .filter(r => r.status === 'active');

  if (activeList.length === 0) {
    return message.reply('現在募集中の高難易度レイドはありません。');
  }

  const embed = new EmbedBuilder()
    .setTitle('🔍 現在募集中のレイド一覧')
    .setDescription('参加するには該当の募集メッセージで「参加申込」ボタンを押してください。')
    .setColor('#0099ff');

  // 募集情報を整理
  activeList.forEach((recruitment, index) => {
    const formattedDate = new Date(recruitment.date).toLocaleDateString('ja-JP', {
      month: 'long',
      day: 'numeric'
    });

    const participantCount = recruitment.participants.length;

    embed.addFields({
      name: `${index + 1}. ${recruitment.type} - ${formattedDate} ${recruitment.time}`,
      value: `募集者: <@${recruitment.creator}>\n参加者数: ${participantCount}名\n[募集ページへジャンプ](https://discord.com/channels/${message.guildId}/${recruitment.channel}/${recruitment.messageId})`
    });
  });

  await message.reply({ embeds: [embed] });
}

// 募集削除処理
async function deleteRecruitment(message, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);

  if (!recruitment) {
    return message.reply('指定された募集IDは存在しません。');
  }

  // 募集者またはサーバー管理者のみ削除可能
  if (recruitment.creator !== message.author.id && !message.member.permissions.has('ADMINISTRATOR')) {
    return message.reply('募集者またはサーバー管理者のみが募集を削除できます。');
  }

  try {
    // 募集メッセージを更新
    const channel = await client.channels.fetch(recruitment.channel);
    if (channel) {
      const recruitMessage = await channel.messages.fetch(recruitment.messageId);
      if (recruitMessage) {
        await recruitMessage.edit({
          content: '**【募集削除】** この募集は削除されました。',
          embeds: [],
          components: []
        });
      }
    }

    // 募集データを削除
    activeRecruitments.delete(recruitmentId);

    await message.reply(`募集ID: ${recruitmentId} の募集を削除しました。`);
  } catch (error) {
    console.error('募集削除エラー:', error);
    await message.reply('募集の削除中にエラーが発生しました。');
  }
}

// ヘルプ表示機能
async function showHelp(message) {
  const embed = new EmbedBuilder()
    .setTitle('📚 グラブル高難易度募集Bot ヘルプ')
    .setDescription('グランブルーファンタジーの高難易度レイド（天元/ルシゼロ）募集を簡単に行うためのボットです。')
    .setColor('#00cc99')
    .addFields(
      {
        name: '基本コマンド',
        value: '`!募集` - 新しいレイド募集を開始します\n`!募集リスト` - 現在進行中の募集一覧を表示します\n`!募集ヘルプ` - このヘルプを表示します'
      },
      {
        name: '募集作成の流れ',
        value: '1. `!募集` コマンドを入力\n2. レイドタイプを選択（天元/ルシゼロ/参加者希望）\n3. 開催日を選択\n4. 開催時間を選択\n5. 内容を確認して募集開始'
      },
      {
        name: '参加申込の流れ',
        value: '1. 募集メッセージの「参加申込」ボタンをクリック\n2. 参加タイプを選択（参加者希望の場合のみ）\n3. 参加可能な属性を選択（複数選択可）\n4. 参加可能時間を選択\n5. 内容を確認して参加確定'
      },
      {
        name: '属性割り振りについて',
        value: '- 7人以上の参加表明があった場合、自動的に割り振りが行われます\n- 開催日の朝8時に自動的に締め切られ、割り振りが確定します\n- 募集者は「募集締め切り」ボタンで手動締め切りも可能です'
      },
      {
        name: '管理コマンド',
        value: '`!募集削除 [募集ID]` - 指定した募集を削除します（募集者または管理者のみ）'
      }
    )
    .setFooter({ text: 'ボタン操作だけで簡単に募集・参加ができます！' });

  await message.reply({ embeds: [embed] });
}

// 募集詳細表示機能（デバッグ用）
async function showRecruitmentDetails(message, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);

  if (!recruitment) {
    return message.reply('指定された募集IDは存在しません。');
  }

  // 募集データの詳細を表示
  const details = {
    id: recruitment.id,
    type: recruitment.type,
    status: recruitment.status,
    参加者数: recruitment.participants.length,
    メッセージID: recruitment.messageId,
    チャンネルID: recruitment.channel
  };

  // 参加者情報
  const participantsInfo = recruitment.participants.map(p => {
    return {
      ユーザー名: p.username,
      参加タイプ: p.joinType,
      属性: p.attributes.join(','),
      割り当て属性: p.assignedAttribute || '未割り当て'
    };
  });

  await message.reply({
    content: '```json\n' + JSON.stringify(details, null, 2) + '\n```\n' +
             '**参加者情報:**\n```json\n' + JSON.stringify(participantsInfo, null, 2) + '\n```',
    allowedMentions: { users: [] }
  });
}

// 全募集データ表示機能（デバッグ用）
async function showAllRecruitmentDetails(message) {
  const allRecruitments = Array.from(activeRecruitments.entries());

  if (allRecruitments.length === 0) {
    return message.reply('現在募集データはありません。');
  }

  let debugInfo = '**現在の募集データ**\n\n';

  allRecruitments.forEach(([id, data]) => {
    debugInfo += `**募集ID**: \`${id}\`\n`;
    debugInfo += `- タイプ: ${data.type}\n`;
    debugInfo += `- 状態: ${data.status}\n`;
    debugInfo += `- 日付: ${data.date}\n`;
    debugInfo += `- 時間: ${data.time}\n`;
    debugInfo += `- メッセージID: ${data.messageId}\n`;
    debugInfo += `- 参加者数: ${data.participants.length}名\n\n`;
  });
  
  

  // 長さ制限があるので、2000文字以上なら分割
  if (debugInfo.length > 1900) {
    const parts = [];
    for (let i = 0; i < debugInfo.length; i += 1900) {
      parts.push(debugInfo.substring(i, i + 1900));
    }

    for (const part of parts) {
      await message.channel.send(part);
    }
  } else {
    await message.reply(debugInfo);
  }
}

// 未処理のエラーをキャッチ
process.on('unhandledRejection', error => {
  console.error('未処理のPromise拒否:', error);
});

// まず監視サーバーを起動
const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;

// ルートパス
app.get('/', (req, res) => {
  res.status(200).send('Bot is running!');
});

// 健康状態チェック用エンドポイント
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'up',
    message: 'Bot is operational',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    activeRecruitments: activeRecruitments.size
  });
});

// ping用シンプルエンドポイント (UptimeRobot推奨)
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// 他のルートへのアクセスをキャッチするフォールバック
app.get('*', (req, res) => {
  res.status(200).send('Bot is running! (Unknown route)');
});

// エラーハンドリング
app.use((err, req, res, next) => {
  console.error('Expressサーバーエラー:', err);
  res.status(500).send('サーバーエラーが発生しました');
});

app.use((err, req, res, next) => {
  console.error('Expressサーバーエラー:', err);
  res.status(500).send('サーバーエラーが発生しました');
});

// 未処理の例外をキャッチ
process.on('uncaughtException', (err) => {
  console.error('未処理の例外:', err);
  // エラー発生時にデータを保存
  saveRecruitmentData();
  // 深刻なエラーの場合は安全に再起動
  setTimeout(() => {
    console.log('安全なシャットダウンを実行します...');
    process.exit(1);  // 終了コード1でプロセス終了（サーバーは自動的に再起動）
  }, 1000);
});

// プロセスシグナルをハンドリング
process.on('SIGTERM', () => {
  console.log('SIGTERMを受信しました。グレースフルシャットダウンを開始します...');
  // 終了前にデータを保存
  saveRecruitmentData();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINTを受信しました。グレースフルシャットダウンを開始します...');
  // 終了前にデータを保存
  saveRecruitmentData();
  process.exit(0);
});

// 定期的なヘルスチェックを追加
// 10分ごとに自己ヘルスチェックを実施
setInterval(() => {
  try {
    // 自己ヘルスチェック - メモリ使用量など
    const memoryUsage = process.memoryUsage();
    console.log(`ヘルスチェック: メモリ使用量 ${Math.round(memoryUsage.rss / 1024 / 1024)}MB`);
    
    // もしメモリ使用量が基準値を超えた場合は保存して再起動
    if (memoryUsage.rss > 450 * 1024 * 1024) { // 450MBを超えたら
      console.log('メモリ使用量が高いため、データを保存して再起動します...');
      saveRecruitmentData();
      setTimeout(() => process.exit(1), 1000);
    }
  } catch (error) {
    console.error('ヘルスチェックエラー:', error);
  }
}, 10 * 60 * 1000); // 10分ごと
//==========================================================================
// テストモード機能ブロック
//==========================================================================

// テストモード開始処理
async function startTestMode(message) {
  // 管理者権限の確認
  if (!message.member.permissions.has('Administrator')) {
    return await message.reply('テストモードは管理者のみが開始できます。');
  }

  testMode.active = true;
  testMode.testParticipants = [];

  const embed = new EmbedBuilder()
    .setTitle('🧪 テストモード開始')
    .setDescription('テストモードが開始されました。以下の機能が利用できます：\n\n' +
      '`!テスト参加者追加 [募集ID] [人数]` - 指定した募集に指定した人数のテスト参加者を追加\n' +
      '`!テストモード終了` - テストモードを終了する')
    .setColor('#FF9800');

  await message.reply({ embeds: [embed] });

  console.log(`テストモードが ${message.author.tag} によって開始されました`);
}

// テストモード終了処理
async function endTestMode(message) {
  if (!testMode.active) {
    return await message.reply('テストモードは現在開始されていません。');
  }

  testMode.active = false;
  const testParticipantCount = testMode.testParticipants.length;
  testMode.testParticipants = [];

  const embed = new EmbedBuilder()
    .setTitle('🧪 テストモード終了')
    .setDescription(`テストモードが終了しました。\n追加されたテスト参加者 ${testParticipantCount} 名は削除されました。`)
    .setColor('#4CAF50');

  await message.reply({ embeds: [embed] });

  // 関連する募集メッセージを更新
  const affectedRecruitments = new Set();
  
  // テスト参加者を削除し、影響を受けた募集を収集
  activeRecruitments.forEach((recruitment, id) => {
    const initialCount = recruitment.participants.length;
    
    // テスト参加者を削除
    recruitment.participants = recruitment.participants.filter(p => !p.isTestParticipant);
    
    if (initialCount !== recruitment.participants.length) {
      affectedRecruitments.add(id);
      activeRecruitments.set(id, recruitment);
    }
  });

  // 影響を受けた募集メッセージを更新
  for (const recruitmentId of affectedRecruitments) {
    const recruitment = activeRecruitments.get(recruitmentId);
    if (recruitment) {
      try {
        await updateRecruitmentMessage(recruitment);
      } catch (err) {
        console.error(`メッセージ更新エラー (ID: ${recruitmentId}):`, err);
      }
    }
  }

  console.log(`テストモードが ${message.author.tag} によって終了されました（テスト参加者 ${testParticipantCount} 名を削除）`);
}

// ランダムな属性を生成
function getRandomAttributes() {
  const allAttributes = ['火', '水', '土', '風', '光', '闇'];
  const shuffled = [...allAttributes].sort(() => 0.5 - Math.random());
  // 1〜6個の属性をランダムに選択
  const count = Math.floor(Math.random() * 6) + 1;
  return shuffled.slice(0, count);
}

// ランダムな参加可能時間を生成
function getRandomTimeAvailability() {
  const times = ['今すぐ', '19:00', '20:00', '21:00', '22:00', '23:00'];
  return times[Math.floor(Math.random() * times.length)];
}

// テスト参加者名を生成
function generateTestParticipantName(index) {
  const prefixes = ['テスト', 'Test', 'Bot', 'ダミー', 'Sample'];
  const roles = ['騎空士', 'エース', 'サポーター', 'アタッカー', 'ヒーラー'];
  
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const role = roles[Math.floor(Math.random() * roles.length)];
  
  return `[TEST${index}]${prefix}${role}`;
}

// テスト参加者追加処理
async function addTestParticipants(message, recruitmentId, count) {
  if (!testMode.active) {
    return await message.reply('テストモードが開始されていません。`!テストモード開始` で開始してください。');
  }

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) {
    return await message.reply('指定された募集IDは存在しません。');
  }

  if (recruitment.status !== 'active') {
    return await message.reply('この募集は既に終了しています。アクティブな募集にのみテスト参加者を追加できます。');
  }

  const addedParticipants = [];

  // テスト参加者を追加
  for (let i = 0; i < count; i++) {
    const testUserId = `test-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 9)}`;
    const testUsername = generateTestParticipantName(i + 1);
    
    // 参加タイプを決定
    let joinType;
    if (recruitment.type === '参加者希望') {
      const types = ['天元', 'ルシゼロ', 'なんでも可'];
      joinType = types[Math.floor(Math.random() * types.length)];
    } else {
      joinType = recruitment.type;
    }

    // 参加者データを作成
    const testParticipant = {
      userId: testUserId,
      username: testUsername,
      joinType: joinType,
      attributes: getRandomAttributes(),
      timeAvailability: getRandomTimeAvailability(),
      assignedAttribute: null,
      isTestParticipant: true // テスト参加者フラグ
    };

    recruitment.participants.push(testParticipant);
    testMode.testParticipants.push(testParticipant);
    addedParticipants.push(testParticipant);
  }

  try {
    await updateRecruitmentMessage(recruitment);

    // テスト参加者の詳細を表示
    const embed = new EmbedBuilder()
      .setTitle('🧪 テスト参加者が追加されました')
      .setDescription(`募集ID: ${recruitmentId} に ${count} 名のテスト参加者を追加しました。`)
      .setColor('#2196F3');

    // 追加した参加者の詳細を表示
    addedParticipants.forEach((p, index) => {
      embed.addFields({
        name: `${index + 1}. ${p.username}`,
        value: `参加タイプ: ${p.joinType}\n属性: ${p.attributes.join(', ')}\n参加可能時間: ${p.timeAvailability}`
      });
    });

    await message.reply({ embeds: [embed] });
    
    // 参加者が7人以上になった場合、自動割り振りを行う
    if (recruitment.participants.length >= 7 && recruitment.status === 'active') {
      await message.reply('参加者が7人以上になったため、自動割り振りを実行します...');
      await autoAssignAttributes(recruitment);
      await updateRecruitmentMessage(recruitment);
    }

    console.log(`${message.author.tag} が募集ID ${recruitmentId} に ${count} 名のテスト参加者を追加しました`);
  } catch (error) {
    console.error(`テスト参加者追加エラー: ${error.message}`);
    await message.reply('テスト参加者の追加中にエラーが発生しました。');
  }
}

// テスト参加者追加オプション表示
async function showTestParticipantAddOptions(interaction, recruitmentId) {
  if (!testMode.active) {
    return await interaction.reply({
      content: 'テストモードが有効ではありません。`!テストモード開始` で開始してください。',
      ephemeral: true
    });
  }

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.reply({
      content: 'この募集は既に終了しているか、存在しません。',
      ephemeral: true
    });
  }

  // 参加者数選択用セレクトメニュー
  const row = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`test_participant_count_${recruitmentId}`)
        .setPlaceholder('追加するテスト参加者の人数を選択')
        .addOptions([
          { label: '1人', value: '1', description: 'テスト参加者を1人追加' },
          { label: '3人', value: '3', description: 'テスト参加者を3人追加' },
          { label: '5人', value: '5', description: 'テスト参加者を5人追加' },
          { label: '7人', value: '7', description: 'テスト参加者を7人追加（自動割り振り閾値）' },
          { label: '10人', value: '10', description: 'テスト参加者を10人追加' }
        ])
    );

  const embed = new EmbedBuilder()
    .setTitle('🧪 テスト参加者追加')
    .setDescription('追加するテスト参加者の人数を選択してください。\n参加タイプ、属性、参加可能時間はランダムに設定されます。')
    .setColor('#2196F3');

  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true
  });
}

// テスト参加者追加確認UI表示
async function showTestParticipantConfirmation(interaction, recruitmentId, count) {
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.update({
      content: 'この募集は既に終了しているか、存在しません。',
      embeds: [],
      components: []
    });
  }

  const embed = new EmbedBuilder()
    .setTitle('🧪 テスト参加者追加確認')
    .setDescription(`募集ID: ${recruitmentId} に ${count} 名のテスト参加者を追加します。\n\n` +
      `現在の参加者数: ${recruitment.participants.length}名\n` +
      `追加後の参加者数: ${recruitment.participants.length + count}名`)
    .setColor('#2196F3');

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_test_participants_${recruitmentId}_${count}`)
        .setLabel('追加する')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('cancel_test_participants')
        .setLabel('キャンセル')
        .setStyle(ButtonStyle.Danger)
    );

  await interaction.update({
    embeds: [embed],
    components: [row]
  });
}

// テスト参加者追加確定処理
async function confirmAddTestParticipants(interaction, recruitmentId, count) {
  if (!testMode.active) {
    return await interaction.update({
      content: 'テストモードが有効ではありません。',
      embeds: [],
      components: []
    });
  }

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.update({
      content: 'この募集は既に終了しているか、存在しません。',
      embeds: [],
      components: []
    });
  }

  const addedParticipants = [];

  // テスト参加者を追加
  for (let i = 0; i < count; i++) {
    const testUserId = `test-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 9)}`;
    const testUsername = generateTestParticipantName(i + 1);
    
    // 参加タイプを決定
    let joinType;
    if (recruitment.type === '参加者希望') {
      const types = ['天元', 'ルシゼロ', 'なんでも可'];
      joinType = types[Math.floor(Math.random() * types.length)];
    } else {
      joinType = recruitment.type;
    }

    // 参加者データを作成
    const testParticipant = {
      userId: testUserId,
      username: testUsername,
      joinType: joinType,
      attributes: getRandomAttributes(),
      timeAvailability: getRandomTimeAvailability(),
      assignedAttribute: null,
      isTestParticipant: true // テスト参加者フラグ
    };

    recruitment.participants.push(testParticipant);
    testMode.testParticipants.push(testParticipant);
    addedParticipants.push(testParticipant);
  }

  try {
    // 募集メッセージの更新
    await updateRecruitmentMessage(recruitment);

    // 参加者が7人以上になった場合の自動割り振り
    let autoAssignTriggered = false;
    if (recruitment.participants.length >= 7 && recruitment.status === 'active') {
      await autoAssignAttributes(recruitment, true); // trueを追加);
      await updateRecruitmentMessage(recruitment);
      autoAssignTriggered = true;
    }

    await interaction.update({
      content: `${count} 名のテスト参加者を追加しました。` + 
        (autoAssignTriggered ? '\n\n**参加者が7人以上になったため、自動割り振りが実行されました。**' : ''),
      embeds: [],
      components: []
    });

    console.log(`${interaction.user.tag} が募集ID ${recruitmentId} に ${count} 名のテスト参加者を追加しました`);
  } catch (error) {
    console.error(`テスト参加者追加エラー: ${error.message}`);
    await interaction.update({
      content: 'テスト参加者の追加中にエラーが発生しました。',
      embeds: [],
      components: []
    });
  }
}


  

// サーバーを起動
app.listen(PORT, () => {
  console.log(`監視用サーバーが起動しました: ポート ${PORT}`);
});

// その後Botをログイン（サーバー起動とは独立して）
client.login(process.env.TOKEN)
  .then(() => {
    console.log('Botが正常にログインしました');
  })
  .catch(error => {
    console.error('Botログインエラー:', error);
  });
