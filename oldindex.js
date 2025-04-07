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
  PermissionsBitField
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
  // 必要に応じて追加のエラーレポート処理
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

// データ保存用のファイルパス
const RENDER_DISK_MOUNT_PATH = process.env.DATA_PATH || '/data/botdata'; // Render永続ディスクパス等
const DATA_FILE_PATH = path.join(RENDER_DISK_MOUNT_PATH, 'recruitment_data.json');

// グローバル変数
let activeRecruitments = new Map(); // 現在進行中の募集を保持
const tempUserData = new Map(); // 一時的なユーザーデータ保存用 (モーダル連携用)
const attributes = ['火', '水', '土', '風', '光', '闇']; // グラブルの属性
const raidTypes = ['天元', 'ルシゼロ', '参加者希望']; // レイドタイプ
const NG_WORDS = ["死ね", "殺す", "馬鹿", "アホ", "氏ね", "ころす", "バカ", /* ... 他の不適切な単語を追加 ... */ ]; // NGワードリスト
const MAX_REMARKS_LENGTH = 100; // 備考の最大文字数

// 時間オプションを初期化 (00:00 - 23:00)
const timeOptions = [];
for (let i = 0; i < 24; i++) {
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
      const parsedData = JSON.parse(data);

      // 読み込んだデータをMapに変換
      const loadedRecruitments = new Map();
      let activeCount = 0;

      Object.entries(parsedData).forEach(([id, recruitment]) => {
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
  // activeRecruitments が Map でない場合や空の場合、処理を中断
  if (!(activeRecruitments instanceof Map)) {
     console.log('保存対象のデータ(activeRecruitments)がMapではありません。処理をスキップします。');
     return;
  }
   // 空の場合でも空のJSONを保存するように変更（ファイルをクリアするため）
  // if (activeRecruitments.size === 0) {
  //   console.log('保存対象のアクティブな募集データがないため、保存処理をスキップします。');
  //   return;
  // }

  try {
    const dataDir = path.dirname(DATA_FILE_PATH); // グローバル変数を使用

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
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(dataToSave, null, 2), 'utf8');
    console.log(`${activeRecruitments.size}件の募集データを保存しました (${DATA_FILE_PATH})`);

  } catch (error) {
    console.error('募集データの保存中にエラーが発生しました:', error);
  }
}

// 古い募集のクリーンアップ処理
function cleanupOldRecruitments() {
  const now = new Date();
  let cleanupCount = 0;
  const recruitmentsToDelete = []; // 削除対象のIDを一時保存

  activeRecruitments.forEach((recruitment, id) => {
    // createdAt がない古いデータへの対応
    const creationTimestamp = recruitment.createdAt ? new Date(recruitment.createdAt).getTime() : new Date(recruitment.date).getTime(); // dateをフォールバック
    if (isNaN(creationTimestamp)) {
        console.warn(`古い募集 ${id} の作成日時が無効です。削除対象とします。`);
        recruitmentsToDelete.push(id);
        return;
    }

    const recruitmentDate = new Date(creationTimestamp);
    const daysSinceCreation = (now.getTime() - recruitmentDate.getTime()) / (1000 * 60 * 60 * 24);

    // 状態ごとに保持期間を設定
    // - 終了した募集(closed, assigned): 3日後に削除
    // - 全ての募集: 7日以上経過したら削除（安全措置）
    const isVeryOld = daysSinceCreation > 7;
    const isClosedAndOld = (recruitment.status === 'closed' || recruitment.status === 'assigned') && daysSinceCreation > 3;

    if (isVeryOld || isClosedAndOld) {
      recruitmentsToDelete.push(id);
      console.log(`古い募集を削除対象に追加: ID=${id}, タイプ=${recruitment.type}, 状態=${recruitment.status}, 経過日数=${daysSinceCreation.toFixed(1)}日`);
    }
  });

  // 削除実行
  recruitmentsToDelete.forEach(id => {
      activeRecruitments.delete(id);
      cleanupCount++;
  });

  if (cleanupCount > 0) {
      console.log(`古い募集 ${cleanupCount}件をクリーンアップしました。残り: ${activeRecruitments.size}件`);
      // クリーンアップ後にデータを保存
      saveRecruitmentData();
  } else {
      console.log(`クリーンアップ対象の古い募集はありませんでした。現在の募集数: ${activeRecruitments.size}件`);
  }
}

// ボット準備完了時の処理
client.once('ready', () => {
  console.log(`${client.user.tag} でログインしました！`);
  console.log('Discord.js バージョン:', require('discord.js').version);

  // 保存済みデータがあればロード
  const loadedData = loadRecruitmentData();
  if (loadedData instanceof Map && loadedData.size > 0) {
    activeRecruitments = loadedData;
  }

  // 定期的な処理の開始
  setInterval(saveRecruitmentData, 2 * 60 * 1000);     // 2分ごとにデータ保存
  setInterval(checkAutomaticClosing, 5 * 60 * 1000);   // 5分ごとに自動締め切りチェック
  setInterval(cleanupOldRecruitments, 24 * 60 * 60 * 1000); // 24時間ごとに古い募集をクリーンアップ

  // 初回のクリーンアップを実行
  cleanupOldRecruitments();
  // 初回の保存を実行
  saveRecruitmentData();
});

// エラー応答ヘルパー関数
async function handleErrorReply(interaction, error, customMessage = 'エラーが発生しました。') {
  const errorCode = error?.code; // エラーコードを取得 (存在すれば)
  const errorMessage = error instanceof Error ? error.message : String(error); // エラーメッセージ

  console.error(`エラー応答試行 (コード: ${errorCode}): ${errorMessage}`);
  if (error instanceof Error) {
      console.error(error.stack); // スタックトレースもログに出力
  }

  // 無視するエラーコード
  if (errorCode === 10062 /* Unknown interaction */ || errorCode === 40060 /* Already acknowledged */) {
    console.log(`無視するインタラクションエラー (コード: ${errorCode}) - 応答しません`);
    return;
  }

  const replyOptions = {
    content: `${customMessage} (${errorCode ? `コード: ${errorCode}` : '詳細不明'})`,
    ephemeral: true // 基本的にエラーは本人にだけ見せる
  };

  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(replyOptions).catch(e => console.error('followUpでのエラー応答失敗:', e.message));
    } else {
      await interaction.reply(replyOptions).catch(e => console.error('replyでのエラー応答失敗:', e.message));
    }
  } catch (replyErr) {
    // ここでさらにエラーが発生した場合 (例: interactionオブジェクトが無効)
    console.error('最終的なエラー応答処理中に致命的なエラー:', replyErr);
  }
}

// メインのinteractionCreateイベントハンドラ (統合版)
client.on('interactionCreate', async interaction => {
  // DMからのインタラクションは無視 (GuildMemberが必要な処理が多いため)
  if (!interaction.guild || !interaction.member) {
      if(interaction.isRepliable()) {
         await interaction.reply({ content: 'このボットはサーバー内でのみ利用可能です。', ephemeral: true }).catch(() => {});
      }
      return;
  }
  // ボットからのインタラクションも無視
  if (interaction.user.bot) return;

  try {
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelectMenuInteraction(interaction);
    } else if (interaction.type === InteractionType.ModalSubmit) {
      await handleModalSubmit(interaction);
    }
    // 他のインタラクションタイプが必要な場合はここに追加
    // else if (interaction.isCommand()) { ... }

  } catch (error) {
    console.error(`インタラクション処理中に予期せぬエラーが発生 (ID: ${interaction.id}, CustomID: ${interaction.customId || 'N/A'}):`);
    console.error(error);
    // 汎用的なエラーメッセージで応答
    await handleErrorReply(interaction, error, 'コマンドの処理中に予期せぬエラーが発生しました。');
  }
});

// メッセージコマンドハンドラ
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return; // ボットとDMを無視

  // コマンドプレフィックスを持つメッセージのみ処理 (例: !)
  if (!message.content.startsWith('!')) return;

  // コマンドと引数をパース
  const args = message.content.slice(1).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  try {
      // !募集コマンド
      if (command === '募集') {
        await startRecruitment(message);
      }
      // !募集リストコマンド
      else if (command === '募集リスト') {
        await showActiveRecruitments(message);
      }
      // !募集ヘルプコマンド
      else if (command === '募集ヘルプ') {
        await showHelp(message);
      }
      // !テストモード開始コマンド
      else if (command === 'テストモード開始') {
        // 管理者チェック
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return message.reply('このコマンドはサーバー管理者のみ使用できます。');
        }
        await startTestMode(message); // 関数呼び出しに変更
      }
      // !テストモード終了コマンド
      else if (command === 'テストモード終了') {
        // 管理者チェック
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return message.reply('このコマンドはサーバー管理者のみ使用できます。');
        }
        await endTestMode(message);
      }
      // !テスト参加者追加コマンド (!testadd でも可)
      else if (command === 'テスト参加者追加' || command === 'testadd') {
        // 管理者チェック
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return message.reply('このコマンドはサーバー管理者のみ使用できます。');
        }
        if (args.length < 2 || isNaN(parseInt(args[1], 10))) {
          return message.reply('使用方法: `!テスト参加者追加 [募集ID] [人数]`');
        }
        const recruitmentId = args[0];
        const count = parseInt(args[1], 10);
        await addTestParticipants(message, recruitmentId, count);
      }
      // !IDリストコマンド
      else if (command === 'idリスト') {
          const ids = Array.from(activeRecruitments.keys());
          if (ids.length === 0) {
            return message.reply('現在アクティブな募集データはありません。');
          }

          let response = '**募集ID一覧**\n\n';
          ids.forEach((id, index) => {
            const recruitment = activeRecruitments.get(id);
            if (recruitment) { // 念のため存在確認
                response += `${index + 1}. \`${id}\` (${recruitment.type || 'タイプ不明'} - ${recruitment.status || '状態不明'})\n`;
            }
          });

          // 長すぎる場合は分割して送信
         if (response.length > 2000) {
             for (let i = 0; i < response.length; i += 2000) {
                 await message.reply(response.substring(i, i + 2000));
             }
         } else {
             await message.reply(response);
         }
      }
      // !追加コマンド (テスト参加者3人追加)
      else if (command === '追加') {
        // 管理者チェック
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return message.reply('このコマンドはサーバー管理者のみ使用できます。');
        }
         if (args.length < 1) {
             return message.reply('使用方法: `!追加 [募集ID]`');
         }
         const id = args[0];
         console.log(`追加コマンド実行: ID=${id}`);

         const recruitment = activeRecruitments.get(id);
         if (!recruitment) {
           return message.reply(`ID "${id}" の募集は存在しません。`);
         }
          if (recruitment.status !== 'active') {
             return message.reply(`ID "${id}" の募集は現在アクティブではありません（状態: ${recruitment.status}）。`);
          }

         // 3人のテスト参加者を追加
         const countToAdd = 3;
         let addedCount = 0;
         for (let i = 0; i < countToAdd; i++) {
           let joinType;
           if (recruitment.type === '参加者希望') {
             const types = ['天元', 'ルシゼロ', 'なんでも可'];
             joinType = types[Math.floor(Math.random() * types.length)];
           } else {
             joinType = recruitment.type;
           }

           const possibleAttributes = ['火', '水', '土', '風', '光', '闇'];
           const selectedAttributes = [];
           possibleAttributes.forEach(attr => {
             if (Math.random() < 0.4) { selectedAttributes.push(attr); }
           });
           if (selectedAttributes.length === 0) {
             selectedAttributes.push(possibleAttributes[Math.floor(Math.random() * possibleAttributes.length)]);
           }

           const possibleTimes = ['今すぐ', '19:00', '20:00', '21:00', '22:00', '23:00'];
           const selectedTime = possibleTimes[Math.floor(Math.random() * possibleTimes.length)];

           const participant = {
             userId: `test-${i}-${Date.now()}`,
             username: `[TEST] 参加者${i+1}`,
             joinType: joinType,
             attributes: selectedAttributes,
             timeAvailability: selectedTime,
             remarks: '', // テスト参加者は備考なし
             assignedAttribute: null,
             isTestParticipant: true
           };

           recruitment.participants.push(participant);
           addedCount++;
           console.log(`テスト参加者を追加: ${participant.username}, タイプ=${joinType}, 属性=[${selectedAttributes.join(',')}], 時間=${selectedTime}`);
         }

         await updateRecruitmentMessage(recruitment);
         await message.reply(`ID "${id}" の募集に${addedCount}名のテスト参加者を追加しました。\n現在の参加者数: ${recruitment.participants.length}名`);

         // 7人以上でも自動で締め切らず、プレビュー表示
         if (recruitment.participants.length >= 7 && recruitment.status === 'active') {
           await message.channel.send(`参加者が7人以上になったため、ID "${id}" の属性割り振りをプレビュー表示します...`);
           await autoAssignAttributes(recruitment, true); // プレビューモードで実行
           await updateRecruitmentMessage(recruitment); // プレビュー結果を反映して更新
         }
      }
      // !募集削除コマンド
      else if (command === '募集削除') {
        if (args.length < 1) {
            return message.reply('使用方法: `!募集削除 [募集ID]`');
        }
        const recruitmentId = args[0];
        await deleteRecruitment(message, recruitmentId);
      }
      // !募集確認コマンド (デバッグ用)
      else if (command === '募集確認') {
         if (args.length < 1) {
            return message.reply('使用方法: `!募集確認 [募集ID]`');
         }
         const recruitmentId = args[0];
         await showRecruitmentDetails(message, recruitmentId);
      }
      // !募集詳細確認コマンド (デバッグ用)
      else if (command === '募集詳細確認') {
         await showAllRecruitmentDetails(message);
      }
      // !再起動テストコマンド
      else if (command === '再起動テスト') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return message.reply('このコマンドはサーバー管理者のみが使用できます。');
        }
        await message.reply('テスト用の再起動を行います。データが正しく保存・復元されるか確認してください...');
        console.log(`${message.author.tag}がテスト用再起動をリクエストしました`);
        saveRecruitmentData(); // 保存を実行
        setTimeout(() => {
          console.log('テスト用再起動を実行します');
          process.exit(0); // クリーンな終了
        }, 3000);
      }
      // !直接テストコマンド (!directtest でも可)
      else if (command === '直接テスト' || command === 'directtest') {
        // 管理者チェック
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return message.reply('このコマンドはサーバー管理者のみ使用できます。');
        }
        if (args.length < 1) {
            return message.reply('使用方法: `!直接テスト [募集ID] (人数 デフォルト:5)`');
        }
        const recruitmentId = args[0];
        const count = args.length >= 2 ? parseInt(args[1], 10) : 5;
         if (isNaN(count) || count <= 0) {
             return message.reply('人数には正の整数を指定してください。');
         }

        const recruitment = activeRecruitments.get(recruitmentId);
        if (!recruitment) {
          return message.reply(`ID "${recruitmentId}" の募集は存在しません。`);
        }
         if (recruitment.status !== 'active') {
             return message.reply(`ID "${recruitmentId}" の募集は現在アクティブではありません（状態: ${recruitment.status}）。`);
         }

        // テスト参加者を追加
        let addedCount = 0;
        for (let i = 0; i < count; i++) {
          let joinType;
          if (recruitment.type === '参加者希望') {
            const types = ['天元', 'ルシゼロ', 'なんでも可'];
            joinType = types[Math.floor(Math.random() * types.length)];
          } else {
            joinType = recruitment.type;
          }

          const possibleAttributes = ['火', '水', '土', '風', '光', '闇'];
          const selectedAttributes = [];
          const attributeCounts = {};
          possibleAttributes.forEach(attr => attributeCounts[attr] = 0);
          recruitment.participants.forEach(p => {
            p.attributes.forEach(attr => { if (attributeCounts[attr] !== undefined) { attributeCounts[attr]++; } });
          });
          possibleAttributes.forEach(attr => {
            const selectionProbability = 0.3 + (0.3 / (attributeCounts[attr] + 1));
            if (Math.random() < selectionProbability) { selectedAttributes.push(attr); }
          });
          if (selectedAttributes.length === 0) {
            const rareAttributes = [...possibleAttributes].sort((a, b) => attributeCounts[a] - attributeCounts[b]);
            selectedAttributes.push(rareAttributes[0]);
          }

          const possibleTimes = ['今すぐ', '19:00', '20:00', '21:00', '22:00', '23:00'];
          const selectedTime = possibleTimes[Math.floor(Math.random() * possibleTimes.length)];

          const testParticipant = {
            userId: `test-${Date.now()}-${i}`,
            username: `テスト参加者${i+1}`,
            joinType: joinType,
            attributes: selectedAttributes,
            timeAvailability: selectedTime,
            remarks: '',
            assignedAttribute: null,
            isTestParticipant: true
          };

          recruitment.participants.push(testParticipant);
          addedCount++;
          console.log(`直接テスト: ${testParticipant.username}, タイプ=${joinType}, 属性=[${selectedAttributes.join(',')}], 時間=${selectedTime}`);
        }

        await updateRecruitmentMessage(recruitment);
        await message.reply(`ID "${recruitmentId}" の募集に${addedCount}名のテスト参加者を追加しました`);

        // 7人以上でも自動で締め切らず、プレビュー表示
        if (recruitment.participants.length >= 7 && recruitment.status === 'active') {
          await message.channel.send(`参加者が7人以上になったため、ID "${recruitmentId}" の属性割り振りをプレビュー表示します...`);
          await autoAssignAttributes(recruitment, true); // プレビューモードで実行
          await updateRecruitmentMessage(recruitment); // プレビュー結果を反映
        }
      }
      // !v14test コマンド
      else if (command === 'v14test') {
          console.log('v14testコマンドを受信');
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
      }
      // 他のメッセージコマンドが必要な場合はここに追加
      // else if (command === '...') { ... }

   } catch (error) {
       console.error(`コマンド "${command}" の処理中にエラーが発生:`, error);
       await message.reply('コマンドの実行中にエラーが発生しました。').catch(() => {}); // エラー応答に失敗しても無視
   }
});

// ボタンインタラクション処理関数
async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;
  console.log(`ボタン処理開始: ${customId}, User: ${interaction.user.tag}`);

  try {
    // レイドタイプ選択
    if (customId.startsWith('raid_type_')) {
      const raidType = customId.replace('raid_type_', '');
      await showDateSelection(interaction, raidType);
    }
    // 日付選択
    else if (customId.startsWith('date_select_')) { // date_select_ に修正
      const parts = customId.split('_'); // [date, select, raidType, dateString]
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
    // 募集キャンセルボタン
    else if (customId === 'cancel_recruitment') {
      await interaction.update({
        content: '募集作成をキャンセルしました。',
        embeds: [],
        components: []
      }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) }); // Unknown interaction は無視
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
     // 備考入力モーダルを開くボタン
    else if (customId.startsWith('open_remarks_modal_')) {
        const recruitmentId = customId.replace('open_remarks_modal_', '');
        await showRemarksModal(interaction, recruitmentId);
    }
    // 参加申込キャンセルボタン (参加フロー中)
    else if (customId === 'cancel_join') {
      // 一時データを削除
      tempUserData.delete(interaction.user.id);
      await interaction.update({
        content: '参加申込をキャンセルしました。',
        embeds: [],
        components: []
      }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
    }
    // テストボタン
    else if (customId === 'simple_test') {
      await interaction.reply({
        content: 'テストボタンが正常に動作しています！',
        ephemeral: true
      });
    }
    // テスト参加者追加ボタン (募集メッセージ上のボタン)
    else if (customId.startsWith('add_test_participants_')) {
      // 管理者チェック
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          return interaction.reply({ content: 'この操作はサーバー管理者のみ可能です。', ephemeral: true });
      }
      const recruitmentId = customId.replace('add_test_participants_', '');
      await showTestParticipantAddOptions(interaction, recruitmentId);
    }
    // テスト参加者確定ボタン (確認UI上のボタン)
    else if (customId.startsWith('confirm_test_participants_')) {
      // 管理者チェック
      if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
          // ボタンを押したのが非管理者だった場合 (UIが表示された後)
          return interaction.update({ content: 'この操作はサーバー管理者のみ可能です。', embeds:[], components:[], ephemeral: true });
      }
      const parts = customId.split('_'); // ["confirm", "test", "participants", recruitmentId, count]
      if (parts.length < 5) throw new Error(`不正なテスト参加者確定ID: ${customId}`);
      const recruitmentId = parts[3];
      const count = parseInt(parts[4], 10);
       if (isNaN(count)) throw new Error(`テスト参加者数解析エラー: ${parts[4]}`);
      await confirmAddTestParticipants(interaction, recruitmentId, count);
    }
    // テスト参加者キャンセルボタン (確認UI上のボタン)
    else if (customId === 'cancel_test_participants') {
      await interaction.update({
        content: 'テスト参加者の追加をキャンセルしました。',
        embeds: [],
        components: []
      }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
    }
    // その他の未処理ボタン
    else {
      console.warn(`未処理のボタンID: ${customId}`);
      await interaction.reply({
        content: 'このボタンは現在処理できません。',
        ephemeral: true
      }).catch(() => {}); // 応答失敗は無視
    }
  } catch (error) {
    console.error(`ボタン処理エラー (ID: ${customId}, User: ${interaction.user.tag}):`, error);
    await handleErrorReply(interaction, error, `ボタン (${customId}) の処理中にエラーが発生しました。`);
  } finally {
      console.log(`ボタン処理終了: ${customId}, User: ${interaction.user.tag}`);
  }
}

// 備考入力モーダル表示関数
async function showRemarksModal(interaction, recruitmentId) {
  const userData = tempUserData.get(interaction.user.id);
  // ユーザーデータがない、またはIDが一致しない場合はエラー応答
  if (!userData || userData.recruitmentId !== recruitmentId) {
      return await interaction.reply({ content: 'エラー: 参加情報が見つからないか、情報が古くなっています。お手数ですが、再度「参加申込」ボタンから操作してください。', ephemeral: true });
  }

  const modal = new ModalBuilder()
    .setCustomId(`submit_remarks_${recruitmentId}`) // モーダル送信時のID
    .setTitle('参加に関する備考 (任意)');

  const remarksInput = new TextInputBuilder()
    .setCustomId('remarks_input') // モーダル送信時にこのIDで値を取得
    .setLabel(`希望/遅刻/早退など (${MAX_REMARKS_LENGTH}文字以内)`)
    .setStyle(TextInputStyle.Paragraph) // 複数行入力可
    .setPlaceholder('例: 22時まで参加希望です。初心者です。空欄でもOK。')
    .setMaxLength(MAX_REMARKS_LENGTH) // 文字数制限
    .setValue(userData.remarks || '') // 以前入力した備考があれば表示 (再編集の場合)
    .setRequired(false); // 任意入力

  const firstActionRow = new ActionRowBuilder().addComponents(remarksInput);
  modal.addComponents(firstActionRow);

  try {
      await interaction.showModal(modal);
  } catch (error) {
       console.error("モーダル表示エラー:", error);
       // showModalが失敗した場合、ユーザーに応答する必要がある
       if (!interaction.replied && !interaction.deferred) {
           await interaction.reply({ content: "備考入力画面の表示に失敗しました。", ephemeral: true }).catch(() => {});
       } else {
           await interaction.followUp({ content: "備考入力画面の表示に失敗しました。", ephemeral: true }).catch(() => {});
       }
  }
}

// モーダル送信処理関数
async function handleModalSubmit(interaction) {
  const customId = interaction.customId;
  console.log(`モーダル送信処理開始: ${customId}, User: ${interaction.user.tag}`);

  try {
    if (!customId.startsWith('submit_remarks_')) {
        console.warn(`不明なモーダルID: ${customId}`);
        return await interaction.reply({ content: '不明なフォームデータを受信しました。', ephemeral: true });
    }

    const recruitmentId = customId.replace('submit_remarks_', '');
    const recruitment = activeRecruitments.get(recruitmentId);

    if (!recruitment || recruitment.status !== 'active') {
      return await interaction.reply({
        content: 'この募集は既に終了しているか、存在しません。',
        ephemeral: true
      });
    }

    // 一時データから参加情報を取得
    const userData = tempUserData.get(interaction.user.id);
    if (!userData || userData.recruitmentId !== recruitmentId) {
      return await interaction.reply({
        content: 'エラー: 参加情報が見つからないか、情報が古くなっています。お手数ですが、再度「参加申込」ボタンから操作してください。',
        ephemeral: true
      });
    }

    // モーダルから備考を取得
    const remarks = interaction.fields.getTextInputValue('remarks_input')?.trim() || ''; // 前後の空白削除

    // NGワードチェック
    const foundNgWord = NG_WORDS.find(ngWord => remarks.toLowerCase().includes(ngWord.toLowerCase()));
    if (foundNgWord) {
      return await interaction.reply({
        content: `エラー: 備考に不適切な単語「${foundNgWord}」が含まれています。修正してください。\n（送信内容: ${remarks.substring(0, 50)}${remarks.length > 50 ? '...' : ''}）`,
        ephemeral: true
      });
    }

    // 文字数チェック (ModalBuilderで設定済みだが念のため)
    if (remarks.length > MAX_REMARKS_LENGTH) {
         return await interaction.reply({
           content: `エラー: 備考が長すぎます (${remarks.length}/${MAX_REMARKS_LENGTH}文字)。修正してください。`,
           ephemeral: true
       });
    }

    // 参加確定処理を呼び出し (備考データを渡す)
    await confirmParticipation(
      interaction,
      recruitmentId,
      userData.joinType,
      userData.attributes,
      userData.timeAvailability,
      remarks // 備考を渡す
    );

    // 一時データを削除
    tempUserData.delete(interaction.user.id);

    // confirmParticipation内で応答するので、ここでは不要

  } catch (error) {
    console.error(`モーダル送信処理エラー (ID: ${customId}, User: ${interaction.user.tag}):`, error);
    // モーダル送信後のエラーは followUp で応答するのが安全
    const replyOptions = { content: '備考の処理中にエラーが発生しました。', ephemeral: true };
    if (!interaction.replied && !interaction.deferred) {
      // 通常、モーダル送信は deferred 状態のはず
      console.warn("モーダル送信インタラクションが reply/deferred されていませんでした。");
      await interaction.reply(replyOptions).catch(e => console.error("Modal Error Reply Failed:", e.message));
    } else {
       await interaction.followUp(replyOptions).catch(e => console.error("Modal Error FollowUp Failed:", e.message));
    }
  } finally {
      console.log(`モーダル送信処理終了: ${customId}, User: ${interaction.user.tag}`);
  }
}


// セレクトメニュー処理関数
async function handleSelectMenuInteraction(interaction) {
  const customId = interaction.customId;
  console.log(`セレクトメニュー処理開始: ${customId}, User: ${interaction.user.tag}, Values: ${interaction.values.join(',')}`);

  try {
    // 時間選択メニュー (募集作成用)
    if (customId.startsWith('time_select_')) {
      const parts = customId.split('_'); // [time, select, raidType, date]
      if (parts.length < 4) throw new Error(`不正な時間選択ID: ${customId}`);
      const raidType = parts[2];
      const date = parts[3];
      const selectedTime = interaction.values[0];
      await confirmRecruitment(interaction, raidType, date, selectedTime);
    }
    // 参加タイプ選択
    else if (customId.startsWith('join_type_')) {
      const parts = customId.split('_'); // [join, type, recruitmentId]
       if (parts.length < 3) throw new Error(`不正な参加タイプID: ${customId}`);
      const recruitmentId = parts[2];
      const selectedType = interaction.values[0];
      await showAttributeSelection(interaction, recruitmentId, selectedType);
    }
    // 属性選択
    else if (customId.startsWith('attribute_select_')) {
      const parts = customId.split('_'); // [attribute, select, recruitmentId, joinType]
       if (parts.length < 4) throw new Error(`不正な属性選択ID: ${customId}`);
      const recruitmentId = parts[2];
      const joinType = parts[3];
      const selectedAttributes = interaction.values;
      await showTimeAvailabilitySelection(interaction, recruitmentId, joinType, selectedAttributes);
    }
    // 参加可能時間選択
    else if (customId.startsWith('time_availability_')) {
      const parts = customId.split('_'); // [time, availability, recruitmentId, joinType, attributesJoined]
      if (parts.length < 5) {
          // IDが長すぎて切り捨てられた可能性。一時データから復元。
          console.warn(`参加可能時間選択IDが短い(${customId})。一時データを使用します。`);
          const userData = tempUserData.get(interaction.user.id);
          if (!userData || !userData.recruitmentId || !userData.joinType || !userData.attributes) {
              throw new Error('参加可能時間選択で一時データが見つからないか、不完全です。');
          }
          const recruitmentId = userData.recruitmentId;
          const joinType = userData.joinType;
          const selectedAttributes = userData.attributes;
          const selectedTime = interaction.values[0];
          await showJoinConfirmation(interaction, recruitmentId, joinType, selectedAttributes, selectedTime);
      } else {
          const recruitmentId = parts[2];
          const joinType = parts[3];
          const attributesStr = parts[4];
          const selectedTime = interaction.values[0];
          const selectedAttributes = attributesStr.split(',');
          await showJoinConfirmation(interaction, recruitmentId, joinType, selectedAttributes, selectedTime);
      }
    }
     // テスト参加者数選択メニュー
    else if (customId.startsWith('test_participant_count_')) {
       // 管理者チェック
       if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
           return interaction.update({ content: 'この操作はサーバー管理者のみ可能です。', embeds:[], components:[], ephemeral: true });
       }
       const recruitmentId = customId.replace('test_participant_count_', '');
       const count = parseInt(interaction.values[0], 10);
        if (isNaN(count)) throw new Error(`テスト参加者数解析エラー: ${interaction.values[0]}`);
       await showTestParticipantConfirmation(interaction, recruitmentId, count);
    }
    // その他のセレクトメニュー
    else {
      console.warn(`未処理のセレクトメニューID: ${customId}`);
      await interaction.update({
        content: 'このメニューは現在処理できません。',
        components: []
      }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
    }
  } catch (error) {
    console.error(`セレクトメニュー処理エラー (ID: ${customId}, User: ${interaction.user.tag}):`, error);
    await handleErrorReply(interaction, error, `メニュー (${customId}) の処理中にエラーが発生しました。`);
  } finally {
      console.log(`セレクトメニュー処理終了: ${customId}, User: ${interaction.user.tag}`);
  }
}

// 募集開始処理
async function startRecruitment(messageOrInteraction) {
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

  // messageCreate または interactionCreate から呼び出されることを想定
  const replyMethod = messageOrInteraction.reply ? messageOrInteraction.reply.bind(messageOrInteraction) : messageOrInteraction.followUp.bind(messageOrInteraction);
  const editMethod = messageOrInteraction.editReply ? messageOrInteraction.editReply.bind(messageOrInteraction) : messageOrInteraction.editFollowUp.bind(messageOrInteraction); // followUpにはeditFollowUpがないので注意 -> interaction.message.edit を使う必要があるかも

   let responseMessage;
   try {
       responseMessage = await replyMethod({
           embeds: [embed],
           components: [row],
           fetchReply: true // メッセージオブジェクトを取得するため
       });
   } catch (error) {
       console.error("募集開始メッセージ送信エラー:", error);
       // 応答に失敗した場合、フォールバックを試みるか、エラーログを残す
       try {
           await messageOrInteraction.channel.send({ embeds: [embed], components: [row] });
       } catch (sendError) {
           console.error("募集開始メッセージ送信フォールバックも失敗:", sendError);
       }
       return; // メッセージが送れないと後続処理ができない
   }


  // 30分後に募集作成UIのボタンを無効化
  setTimeout(() => {
    const disabledRow = new ActionRowBuilder()
      .addComponents(
        ...raidTypes.map(type =>
          new ButtonBuilder()
            .setCustomId(`raid_type_${type}_disabled`) // ID変更推奨
            .setLabel(type)
            .setStyle(ButtonStyle.Secondary) //見た目を変更
            .setDisabled(true)
        )
      );

    const timeoutEmbed = new EmbedBuilder()
      .setTitle('🔰 高難易度募集作成（期限切れ）')
      .setDescription('この募集作成セッションは期限切れになりました。\n新しく募集を開始するには `!募集` コマンドを使用してください。')
      .setColor('#FF6B6B')
      .setTimestamp(); // タイムアウトした時刻

     // responseMessage が取得できているか確認
     if (responseMessage && responseMessage.editable) {
        responseMessage.edit({
          embeds: [timeoutEmbed],
          components: [disabledRow]
        }).catch(error => {
          // 編集に失敗した場合（メッセージが削除されたなど）
          if (error.code !== 10008 /* Unknown Message */ && error.code !== 10062 /* Unknown interaction */) {
             console.error('募集作成UI無効化エラー:', error);
          } else {
             console.log("募集作成UIメッセージが見つからないため、無効化をスキップしました。");
          }
        });
        debugLog('RecruitmentUI', `募集作成UI(${responseMessage.id})を無効化しました（タイムアウト）`);
     } else {
         console.warn("募集作成UIメッセージの編集ができませんでした（メッセージが見つからないか、編集不可）。");
     }
  }, 30 * 60 * 1000); // 30分後
}

// 日付選択UI表示
async function showDateSelection(interaction, raidType) {
  // 今日から7日分の日付ボタンを作成
  const dateButtons = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0); // 今日の0時0分0秒にする

  for (let i = 0; i < 7; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);

    const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const displayDate = `${date.getMonth() + 1}/${date.getDate()}(${['日', '月', '火', '水', '木', '金', '土'][date.getDay()]})`; // 曜日追加

    dateButtons.push(
      new ButtonBuilder()
        .setCustomId(`date_select_${raidType}_${dateString}`) // `date_select_` に修正
        .setLabel(displayDate)
        .setStyle(ButtonStyle.Secondary)
    );
  }

  // ボタンを行に分ける（1行に最大5つまで）
  const rows = [];
  for (let i = 0; i < dateButtons.length; i += 5) {
    rows.push(
        new ActionRowBuilder().addComponents(
            dateButtons.slice(i, Math.min(i + 5, dateButtons.length))
        )
    );
  }

  const embed = new EmbedBuilder()
    .setTitle(`📅 ${raidType}募集 - 日付選択`)
    .setDescription('開催したい日付を選択してください。')
    .setColor('#0099ff');

  await interaction.update({
    embeds: [embed],
    components: rows
  }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
}

// 時間選択UI表示
async function showTimeSelection(interaction, raidType, date) {
  // 時間選択用セレクトメニュー
  const row = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`time_select_${raidType}_${date}`)
        .setPlaceholder('開催時間を選択してください')
        .addOptions(timeOptions) // グローバル変数を使用
    );

  // 日付のフォーマット（曜日も）
  const dateObj = new Date(date + 'T00:00:00Z'); // UTCとして解釈し、日本の日付に変換
   const formattedDate = dateObj.toLocaleDateString('ja-JP', {
       timeZone: 'Asia/Tokyo', // 日本時間で表示
       year: 'numeric',
       month: 'long',
       day: 'numeric',
       weekday: 'short' // (日) など
   });


  const embed = new EmbedBuilder()
    .setTitle(`⏰ ${raidType}募集 - 時間選択`)
    .setDescription(`選択した日付: ${formattedDate}\n開催時間を選択してください。`)
    .setColor('#0099ff');

  await interaction.update({
    embeds: [embed],
    components: [row]
  }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
}

// 募集確認UI表示
async function confirmRecruitment(interaction, raidType, date, time) {
   const formattedDate = new Date(date + 'T00:00:00Z').toLocaleDateString('ja-JP', {
       timeZone: 'Asia/Tokyo',
       year: 'numeric',
       month: 'long',
       day: 'numeric',
       weekday: 'short'
   });


  const recruitmentId = generateUniqueId(); // ユーティリティ関数を使用
  debugLog('RecruitmentConfirm', `募集確認UI表示 - 生成ID: ${recruitmentId}`);

  const embed = new EmbedBuilder()
    .setTitle('🔍 募集内容確認')
    .setDescription('以下の内容で募集を開始しますか？')
    .setColor('#0099ff')
    .addFields(
      { name: 'レイドタイプ', value: raidType, inline: true },
      { name: '開催日', value: formattedDate, inline: true },
      { name: '開催時間', value: time, inline: true },
      { name: '募集者', value: interaction.user.toString(), inline: false } // falseにして募集者を少し目立たせる
    )
    .setFooter({text: `この内容でよろしければ「確定」を押してください。`});

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

  // 一時データをMapに保存
  const recruitmentData = {
    id: recruitmentId,
    type: raidType,
    date: date, // YYYY-MM-DD 形式
    time: time, // HH:MM 形式
    creator: interaction.user.id,
    creatorUsername: interaction.user.username,
    participants: [],
    status: 'pending', // 作成中ステータス
    channel: interaction.channelId,
    messageId: null, // 確定時に設定
    createdAt: new Date().toISOString(), // 作成日時
    finalTime: null, // 割り当て後の時間
    finalRaidType: null // 割り当て後のタイプ
  };

  activeRecruitments.set(recruitmentId, recruitmentData);
  debugLog('RecruitmentConfirm', `一時的な募集データを保存: ${recruitmentId}`);

  await interaction.update({
    embeds: [embed],
    components: [row]
  }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
}

// 募集確定処理 (新規メッセージとして投稿)
async function finalizeRecruitment(interaction, recruitmentId) {
  debugLog('RecruitmentFinalize', `募集確定処理開始: ${recruitmentId}`);

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'pending') { // pending状態か確認
    console.error(`募集データが見つからないか、状態が不正です: ${recruitmentId}, Status: ${recruitment?.status}`);
    return await interaction.update({
      content: 'エラー: 募集データが見つからないか、既に処理済みです。',
      embeds: [], components: []
    }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
  }

  // ステータスを active に変更
  recruitment.status = 'active';

  const dateObj = new Date(recruitment.date + 'T00:00:00Z');
  const formattedDate = dateObj.toLocaleDateString('ja-JP', {
       timeZone: 'Asia/Tokyo',
       year: 'numeric',
       month: 'long',
       day: 'numeric',
       weekday: 'short'
   });

  // 募集用エンベッドを作成
  const embed = createRecruitmentEmbed(recruitment, formattedDate); // ヘルパー関数使用

  // ボタンを作成
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
        .setLabel('募集締め切り (募集者用)')
        .setStyle(ButtonStyle.Danger)
    );

    // テストモード用ボタン (条件付きで追加)
    const components = [joinRow];
    if (testMode.active) {
        const testRow = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`add_test_participants_${recruitmentId}`)
                    .setLabel('🧪 テスト参加者追加 (管理者用)')
                    .setStyle(ButtonStyle.Secondary)
            );
        components.push(testRow);
    }


  try {
    // 元の確認UIを更新して完了メッセージを表示
    await interaction.update({
      content: '募集を作成しました！',
      embeds: [],
      components: [] // ボタンは消す
    }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });

    // チャンネルを取得して新しいメッセージとして募集を送信
    const channel = await client.channels.fetch(interaction.channelId);
    if (!channel || !channel.isTextBased()) {
        throw new Error(`チャンネルが見つからないか、テキストチャンネルではありません: ${interaction.channelId}`);
    }

    const recruitMessage = await channel.send({
      content: `**【${recruitment.type} 募集中】** <@&YOUR_ROLE_ID> ` + // ★★★ 通知したいロールIDに変更 ★★★
               `${formattedDate} ${recruitment.time} 開始予定 ` +
               `(募集者: <@${recruitment.creator}>)`, // メンションを追加
      embeds: [embed],
      components: components, // joinRow または [joinRow, testRow]
      allowedMentions: { roles: ['YOUR_ROLE_ID'] } // ★★★ ロールメンションを許可 ★★★ (IDは上記と合わせる)
    });

    // 新しいメッセージIDを保存
    recruitment.messageId = recruitMessage.id;
    activeRecruitments.set(recruitmentId, recruitment); // Mapを更新

    debugLog('RecruitmentFinalize', `募集確定完了: ID=${recruitmentId}, MessageID=${recruitment.messageId}`);

    // データ保存をトリガー (任意、定期保存もある)
    saveRecruitmentData();

  } catch (error) {
    console.error('募集確定エラー:', error);
    // エラーが発生した場合、元の確認UIにエラーを表示しようと試みる
    await interaction.followUp({ // update は既に使用済みなので followUp
      content: '募集メッセージの作成中にエラーが発生しました。もう一度お試しください。',
      ephemeral: true
    }).catch(e => console.error("Finalize Error FollowUp Failed:", e.message));
    // 作成途中のデータを削除するなどのリカバリ処理が必要な場合がある
    activeRecruitments.delete(recruitmentId); // 失敗したらデータ削除
    debugLog('RecruitmentFinalize', `エラーのため募集データ削除: ${recruitmentId}`);
  }
}

// 募集用エンベッド作成ヘルパー関数
function createRecruitmentEmbed(recruitment, formattedDate) {
  const embed = new EmbedBuilder()
    .setTitle(`📢 【${recruitment.type}】${formattedDate} ${recruitment.time}`)
    .setDescription(`募集者: <@${recruitment.creator}>\n\n参加希望の方は下の「参加申込」ボタンからどうぞ！`)
    .setColor('#3498DB') // 色を変更
    .setFooter({ text: `募集ID: ${recruitment.id} | 開催日 朝8時に自動締切` });

  // 属性フィールドを追加
  attributes.forEach(attr => {
    embed.addFields({ name: `【${attr}】`, value: '?', inline: true }); // 初期値は '?'
  });

  return embed;
}

// 参加オプション表示
async function showJoinOptions(interaction, recruitmentId) {
  debugLog('JoinOptions', `参加オプション表示: ${recruitmentId}, User: ${interaction.user.tag}`);

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.reply({
      content: 'この募集は現在参加を受け付けていないか、存在しません。',
      ephemeral: true
    });
  }

  // すでに参加している場合
  const existingParticipation = recruitment.participants.find(p => p.userId === interaction.user.id);
  if (existingParticipation) {
    return await interaction.reply({
      content: `✅ あなたは既にこの募集に参加を表明済みです。\n` +
               `タイプ: ${existingParticipation.joinType}\n` +
               `属性: ${existingParticipation.attributes.join(', ')}\n` +
               `時間: ${existingParticipation.timeAvailability}\n` +
               `${existingParticipation.remarks ? `備考: ${existingParticipation.remarks}\n` : ''}` +
               `参加内容を変更する場合は、一度「参加キャンセル」してから再度申し込んでください。`,
      ephemeral: true
    });
  }

   const dateObj = new Date(recruitment.date + 'T00:00:00Z');
   const formattedDate = dateObj.toLocaleDateString('ja-JP', {
       timeZone: 'Asia/Tokyo',
       month: 'long',
       day: 'numeric',
       weekday: 'short'
   });

  let selectOptions = [];
  let embedDescription = `【${recruitment.type}】${formattedDate} ${recruitment.time}\n\n`;

  // 募集タイプに応じた参加オプションを設定
  if (recruitment.type === '参加者希望') {
    selectOptions = [
      { label: '天元 のみ希望', value: '天元', description: '天元の戦闘に参加希望' },
      { label: 'ルシゼロ のみ希望', value: 'ルシゼロ', description: 'ルシファーHL(ゼロ)に参加希望' },
      { label: 'どちらでも可', value: 'なんでも可', description: '天元/ルシゼロどちらでも参加可能' }
    ];
    embedDescription += '参加したいコンテンツの種類を選択してください。';
  } else {
    // 天元またはルシゼロ募集の場合は自動的にそのタイプに設定
    selectOptions = [
      { label: `${recruitment.type} に参加`, value: recruitment.type, description: `${recruitment.type}の戦闘に参加` }
    ];
    embedDescription += `この募集 (${recruitment.type}) に参加しますか？\n（タイプは自動的に選択されます）`;
  }

  const row = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`join_type_${recruitmentId}`)
        .setPlaceholder(recruitment.type === '参加者希望' ? '参加タイプを選択' : `${recruitment.type} に参加する`)
        .addOptions(selectOptions)
        // 「参加者希望」でない場合は、選択肢が1つなので最小/最大を1にする
        .setMinValues(recruitment.type === '参加者希望' ? 1 : 1)
        .setMaxValues(recruitment.type === '参加者希望' ? 1 : 1)
        // 「参加者希望」でない場合は、デフォルトで選択されているように見せる (実際はUIのみ)
        // .setDefaultOptions(recruitment.type !== '参加者希望' ? [selectOptions[0]] : []) // Discord UIのバグで効かないことがあるのでコメントアウト
    );

  const embed = new EmbedBuilder()
    .setTitle('🎮 参加申込')
    .setDescription(embedDescription)
    .setColor('#2ECC71'); // 色を変更

  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true
  });
}

// 属性選択UI表示
async function showAttributeSelection(interaction, recruitmentId, joinType) {
  debugLog('AttributeSelection', `属性選択UI表示: ${recruitmentId}, Type: ${joinType}, User: ${interaction.user.tag}`);

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.update({ // update を使う
      content: 'この募集は現在参加を受け付けていないか、存在しません。',
      embeds: [], components: []
    }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
  }

  const attributeOptions = attributes.map(attr => ({
    label: attr, value: attr, description: `${attr}属性で参加可能`
  }));

  const row = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`attribute_select_${recruitmentId}_${joinType}`)
        .setPlaceholder('担当可能な属性を選択 (複数選択可)')
        .setMinValues(1) // 最低1つは選択
        .setMaxValues(attributes.length) // 最大で全属性
        .addOptions(attributeOptions)
    );

  const embed = new EmbedBuilder()
    .setTitle('🔮 属性選択')
    .setDescription(`参加タイプ: **${joinType}**\n\n担当できる属性をすべて選択してください。`)
    .setColor('#2ECC71');

  await interaction.update({
    embeds: [embed],
    components: [row]
  }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
}

// 参加可能時間選択UI表示
async function showTimeAvailabilitySelection(interaction, recruitmentId, joinType, selectedAttributes) {
  debugLog('TimeSelection', `時間選択UI表示: ${recruitmentId}, Type: ${joinType}, Attr: [${selectedAttributes.join(',')}], User: ${interaction.user.tag}`);

  const recruitment = activeRecruitments.get(recruitmentId); // 募集情報の取得はここでも行う（安全のため）
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.update({
      content: 'この募集は現在参加を受け付けていないか、存在しません。',
      embeds: [], components: []
    }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
  }


  // 24時間対応の時間選択肢 + 「今すぐ」
  const timeSelectOptions = [
      { label: '今すぐ参加可能', value: 'now', description: '募集開始時刻に関わらず参加できます' }
  ];
  for (let i = 0; i < 24; i++) {
    const hour = i.toString().padStart(2, '0');
    // 募集開始時刻より後の時間のみ表示するオプション (必要ならコメント解除)
    // const recruitmentHour = parseInt(recruitment.time.split(':')[0], 10);
    // if (i < recruitmentHour) continue;
    timeSelectOptions.push({
      label: `${hour}:00 以降参加可能`,
      value: `${hour}:00`,
      description: `${hour}:00から参加できます`
    });
  }


  // 一時データに保存 (カスタムIDが長すぎる場合に備える)
  const attributesJoined = selectedAttributes.join(',');
  tempUserData.set(interaction.user.id, {
      recruitmentId,
      joinType,
      attributes: selectedAttributes,
      timeAvailability: null, // 時間はまだ未選択
      remarks: null // 備考もまだ
  });
  // カスタムID (一時データを使うので、IDが短くても動作するはず)
  // IDが256文字を超えないように注意が必要だが、通常は問題ないはず
  const customId = `time_availability_${recruitmentId}_${joinType}_${attributesJoined}`;
  if (customId.length > 100) { // Discordの customId 上限は100文字
       console.warn(`生成されたCustomIDが長すぎます(${customId.length}文字)。一時データに依存します。`);
       // IDを短縮する (例: ハッシュ化など) か、一時データ依存で進める
       // ここでは一時データ依存で進める方針
  }


  const row = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(customId.substring(0, 100)) // 念のため100文字に切り詰める
        .setPlaceholder('参加可能な最も早い時間を選択')
        .addOptions(timeSelectOptions)
    );

  const embed = new EmbedBuilder()
    .setTitle('⏰ 参加可能時間の選択')
    .setDescription(
        `参加タイプ: **${joinType}**\n` +
        `選択した属性: **${selectedAttributes.join(', ')}**\n\n` +
        `参加可能な最も早い時間を選択してください。\n(募集開始時刻: ${recruitment.time})`
    )
    .setColor('#2ECC71');

  await interaction.update({
    embeds: [embed],
    components: [row]
  }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
}

// 参加確認UI表示 (備考入力ボタン付き)
async function showJoinConfirmation(interaction, recruitmentId, joinType, selectedAttributes, timeAvailability) {
  debugLog('JoinConfirm', `参加確認UI表示: ${recruitmentId}, Type: ${joinType}, Attr: [${selectedAttributes.join(',')}], Time: ${timeAvailability}, User: ${interaction.user.tag}`);

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.update({
      content: 'この募集は現在参加を受け付けていないか、存在しません。',
      embeds: [], components: []
    }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
  }

  // 一時データに参加可能時間も保存
  const currentData = tempUserData.get(interaction.user.id) || {};
  tempUserData.set(interaction.user.id, {
      ...currentData, // 以前のデータ(ID, Type, Attr)を引き継ぐ
      recruitmentId, // 再確認
      joinType,
      attributes: selectedAttributes,
      timeAvailability: timeAvailability,
      remarks: currentData.remarks || '' // 備考は維持
  });
   debugLog('JoinConfirm', `一時データを更新: ${interaction.user.id}`, tempUserData.get(interaction.user.id));


  const embed = new EmbedBuilder()
    .setTitle('✅ 参加申込内容 確認')
    .setDescription('以下の内容で参加を申し込みます。よろしければ下のボタンを押してください。')
    .setColor('#2ECC71')
    .addFields(
      { name: '募集', value: `${recruitment.type} (${recruitment.date} ${recruitment.time})`, inline: false },
      { name: 'あなたの参加タイプ', value: joinType, inline: true },
      { name: '担当可能属性', value: selectedAttributes.join(', '), inline: true },
      { name: '参加可能時間', value: timeAvailability, inline: true }
    )
    .setFooter({text: '備考がある場合は「備考入力して参加確定」を、なければ「参加確定(備考なし)」を押してください。'});


   const openRemarksModalBtnId = `open_remarks_modal_${recruitmentId}`;
   // 備考なしで確定するボタンも追加する（モーダルを開かずに確定）
   const confirmDirectlyBtnId = `confirm_direct_${recruitmentId}`; // 新しいID


    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
         .setCustomId(openRemarksModalBtnId)
         .setLabel('備考入力して参加確定')
         .setStyle(ButtonStyle.Primary) // 主要アクション
         .setEmoji('📝'), // 絵文字追加
        new ButtonBuilder()
          .setCustomId(confirmDirectlyBtnId) // ★ 備考なし確定ボタン
          .setLabel('参加確定 (備考なし)')
          .setStyle(ButtonStyle.Success), // 成功スタイル
        new ButtonBuilder()
          .setCustomId('cancel_join')
          .setLabel('キャンセル')
          .setStyle(ButtonStyle.Danger)
      );

    // handleButtonInteraction に confirm_direct_ の処理を追加する必要がある
    // -> confirmParticipation を直接呼び出す処理を追加

    await interaction.update({
      embeds: [embed],
      components: [row]
    }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
}

// handleButtonInteraction に confirm_direct_ の処理を追加
// (既存の handleButtonInteraction 関数内に以下を追加)
/*
    // 参加確定ボタン (備考なし)
    else if (customId.startsWith('confirm_direct_')) {
      const recruitmentId = customId.replace('confirm_direct_', '');
      const userData = tempUserData.get(interaction.user.id);
      if (!userData || userData.recruitmentId !== recruitmentId) {
         return await interaction.reply({ content: 'エラー: 参加情報が見つからないか、情報が古くなっています。再度申込してください。', ephemeral: true });
      }
      // confirmParticipation を備考なしで呼び出す
      await confirmParticipation(
         interaction,
         recruitmentId,
         userData.joinType,
         userData.attributes,
         userData.timeAvailability,
         '' // 備考は空文字
      );
      // 一時データ削除
      tempUserData.delete(interaction.user.id);
    }
*/
// 上記を handleButtonInteraction 関数内に追記します。
// 場所は `else if (customId.startsWith('open_remarks_modal_')) { ... }` の後などが良いでしょう。
// --- ここから追記 ---
async function handleButtonInteraction(interaction) {
  const customId = interaction.customId;
  console.log(`ボタン処理開始: ${customId}, User: ${interaction.user.tag}`);

  try {
    // (既存の if/else if は省略) ...

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
        await interaction.update({
            content: '募集作成をキャンセルしました。',
            embeds: [], components: []
        }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
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
    // ★★★ 参加確定ボタン (備考なし) ★★★
    else if (customId.startsWith('confirm_direct_')) {
      const recruitmentId = customId.replace('confirm_direct_', '');
      const userData = tempUserData.get(interaction.user.id);
      if (!userData || userData.recruitmentId !== recruitmentId) {
         // update で応答 (ボタンを押した画面を更新)
         return await interaction.update({ content: 'エラー: 参加情報が見つからないか、情報が古くなっています。再度申込してください。', embeds: [], components: [], ephemeral: true })
                .catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
      }
      // confirmParticipation を備考なしで呼び出す
      await confirmParticipation(
         interaction,
         recruitmentId,
         userData.joinType,
         userData.attributes,
         userData.timeAvailability,
         '' // 備考は空文字
      );
      // 一時データ削除 (confirmParticipation内でエラーが起きても削除されるようにtry...finallyも検討)
      tempUserData.delete(interaction.user.id);
    }
    // 参加申込キャンセルボタン (参加フロー中)
    else if (customId === 'cancel_join') {
        tempUserData.delete(interaction.user.id);
        await interaction.update({
            content: '参加申込をキャンセルしました。',
            embeds: [], components: []
        }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
    }
    // テストボタン
    else if (customId === 'simple_test') {
        await interaction.reply({ content: 'テストボタンが正常に動作しています！', ephemeral: true });
    }
    // テスト参加者追加ボタン (募集メッセージ上)
    else if (customId.startsWith('add_test_participants_')) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: 'この操作はサーバー管理者のみ可能です。', ephemeral: true });
        }
        const recruitmentId = customId.replace('add_test_participants_', '');
        await showTestParticipantAddOptions(interaction, recruitmentId);
    }
    // テスト参加者確定ボタン (確認UI上)
    else if (customId.startsWith('confirm_test_participants_')) {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.update({ content: 'この操作はサーバー管理者のみ可能です。', embeds:[], components:[], ephemeral: true });
        }
        const parts = customId.split('_');
        if (parts.length < 5) throw new Error(`不正なテスト参加者確定ID: ${customId}`);
        const recruitmentId = parts[3];
        const count = parseInt(parts[4], 10);
        if (isNaN(count)) throw new Error(`テスト参加者数解析エラー: ${parts[4]}`);
        await confirmAddTestParticipants(interaction, recruitmentId, count);
    }
    // テスト参加者キャンセルボタン (確認UI上)
    else if (customId === 'cancel_test_participants') {
        await interaction.update({
            content: 'テスト参加者の追加をキャンセルしました。',
            embeds: [], components: []
        }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
    }
    // その他の未処理ボタン
    else {
      console.warn(`未処理のボタンID: ${customId}`);
      await interaction.reply({ content: 'このボタンは現在処理できません。', ephemeral: true }).catch(() => {});
    }
  } catch (error) {
    console.error(`ボタン処理エラー (ID: ${customId}, User: ${interaction.user.tag}):`, error);
    await handleErrorReply(interaction, error, `ボタン (${customId}) の処理中にエラーが発生しました。`);
  } finally {
      console.log(`ボタン処理終了: ${customId}, User: ${interaction.user.tag}`);
  }
}
// --- 追記ここまで ---


// 参加確定処理 (備考パラメータ対応, モーダル/直接ボタン両対応)
async function confirmParticipation(interaction, recruitmentId, joinType, selectedAttributes, timeAvailability, remarks = '') {
  debugLog('ConfirmParticipation', `参加確定処理: ${recruitmentId}, Type: ${joinType}, Attr: [${selectedAttributes.join(',')}], Time: ${timeAvailability}, Remarks: '${remarks}', User: ${interaction.user.tag}`);

  const recruitment = activeRecruitments.get(recruitmentId);

  // 募集が存在し、アクティブかチェック
  if (!recruitment || recruitment.status !== 'active') {
    const replyOptions = { content: 'この募集は既に終了しているか、存在しません。', embeds: [], components: [], ephemeral: true };
    try {
        if (interaction.replied || interaction.deferred) {
            // モーダル送信後やボタンクリック後は deferred or replied 状態
            await interaction.followUp(replyOptions);
        } else {
            // これは通常発生しないはずだが念のため
            await interaction.reply(replyOptions);
        }
    } catch (e) {
        console.error("参加確定前チェックエラー応答失敗:", e.message);
    }
    return; // 処理中断
  }

  // 参加者データを作成
  const participantData = {
    userId: interaction.user.id,
    username: interaction.user.username,
    joinType: joinType,
    attributes: selectedAttributes,
    timeAvailability: timeAvailability,
    remarks: remarks || '', // 空文字を保証
    assignedAttribute: null,
    isTestParticipant: false // 通常参加者
  };

  // すでに参加している場合は情報を更新 (キャンセル->再申込を促す仕様なら不要)
  const existingIndex = recruitment.participants.findIndex(p => p.userId === interaction.user.id);
  if (existingIndex >= 0) {
    // ここで更新するか、エラーを返すか
    // return await interaction.reply({ content: '既に参加済みです。変更する場合はキャンセルしてから再度申込してください。', ephemeral: true });
    recruitment.participants[existingIndex] = participantData;
    debugLog('ConfirmParticipation', `既存参加者情報を更新: ${interaction.user.username}`);
  } else {
     // 参加上限チェック (例: 7人 -> 6人まで参加可能)
     if (recruitment.participants.length >= 6) { // ★上限を6人に変更
        const replyOptions = { content: '募集は既に満員（6名）のため、参加できません。', ephemeral: true };
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(replyOptions);
            } else {
                await interaction.reply(replyOptions);
            }
        } catch (e) { console.error("満員エラー応答失敗:", e.message); }
        return; // 処理中断
     }
    recruitment.participants.push(participantData);
    debugLog('ConfirmParticipation', `新規参加者を追加: ${interaction.user.username}`);
  }

  // 募集メッセージの更新 (非同期だが待機)
  try {
      await updateRecruitmentMessage(recruitment);
  } catch (updateError) {
      console.error("参加確定後のメッセージ更新エラー:", updateError);
      // 更新に失敗しても参加自体は完了したことにするかもしれない
  }

  // 参加完了メッセージ
  const replyOptions = {
    content: '✅ 参加申込が完了しました！\n' +
             `タイプ: ${joinType}, 属性: ${selectedAttributes.join('/')}, 時間: ${timeAvailability}` +
             (remarks ? `\n📝 備考: ${remarks}` : ''),
    embeds: [],
    components: [],
    ephemeral: true // 完了メッセージは本人にだけ見せる
  };

  try {
    if (interaction.type === InteractionType.ModalSubmit || interaction.replied || interaction.deferred) {
      // モーダル送信後、または既に update/reply 済みの場合 (confirm_direct ボタンなど)
      await interaction.followUp(replyOptions);
    } else {
      // ボタンクリック直後など、まだ応答していない場合
       await interaction.update(replyOptions); // update を使う（元の確認UIを消す）
    }
  } catch (error) {
    console.error("参加完了メッセージ送信エラー:", error);
    // 失敗した場合、チャンネルに通知するなどのフォールバックも検討
    try {
        await interaction.channel.send({ content: `<@${interaction.user.id}> 参加申込は処理されましたが、完了メッセージの表示に失敗しました。` }).catch(() => {});
    } catch {}
  }

  // 参加者が7人以上になった場合、自動割り振りプレビュー (7人目が入った時)
  // ★上限を6人に変更したので、6人目が参加した時にプレビュー
  if (recruitment.participants.length === 6 && recruitment.status === 'active') {
    console.log("参加者が6人になったため、属性割り振りをプレビューします。");
    // プレビュー通知をチャンネルに送信
    try {
        const channel = await client.channels.fetch(recruitment.channel);
        if (channel && channel.isTextBased()) {
            await channel.send({ content: `**[${recruitment.type}]** 参加者が6名になりました。属性割り振りのプレビューを行います。\n（まだ募集は締め切られていません）` });
        }
        // プレビュー実行とメッセージ更新
        await autoAssignAttributes(recruitment, true); // プレビューモードで実行
        await updateRecruitmentMessage(recruitment); // プレビュー結果を反映して更新
    } catch (e) {
        console.error("自動割り振りプレビューエラー:", e);
        // エラーが発生しても処理は続行
    }
  }

  // データ保存をトリガー (任意)
  saveRecruitmentData();
}


// 参加キャンセル処理
async function cancelParticipation(interaction, recruitmentId) {
  debugLog('CancelParticipation', `参加キャンセル処理: ${recruitmentId}, User: ${interaction.user.tag}`);

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) {
    return await interaction.reply({ content: 'キャンセル対象の募集が見つかりません。', ephemeral: true });
  }

  const participantIndex = recruitment.participants.findIndex(p => p.userId === interaction.user.id);

  if (participantIndex === -1) {
    return await interaction.reply({ content: 'あなたはこの募集に参加していません。', ephemeral: true });
  }

  // 参加者リストから削除
  const removedParticipant = recruitment.participants.splice(participantIndex, 1)[0];
  debugLog('CancelParticipation', `参加者を削除: ${removedParticipant.username}, 残り参加者数: ${recruitment.participants.length}`);

  // 割り振りが行われていた場合 (closed または assigned)、再割り振りプレビューを行うか、メッセージを更新するだけか
  // ここでは、締め切り後のキャンセルは基本的に不可とするか、管理者に通知する方が良いかもしれない
  // 現状: 締め切り後でもキャンセルできてしまう -> 締め切り後はキャンセルボタンを無効化するべき
  // updateRecruitmentMessage でボタン無効化は行われているので、ここでの追加チェックは不要か？念のため追加
  if (recruitment.status === 'closed' || recruitment.status === 'assigned') {
      // 参加者を戻すか、エラーメッセージを表示
      recruitment.participants.splice(participantIndex, 0, removedParticipant); // 削除を取り消し
      return await interaction.reply({ content: '募集は既に締め切られているため、参加キャンセルできません。募集者に連絡してください。', ephemeral: true });
  }

  // 募集メッセージの更新 (参加者リスト更新のため)
  try {
      await updateRecruitmentMessage(recruitment);
  } catch (updateError) {
      console.error("参加キャンセル後のメッセージ更新エラー:", updateError);
  }

  await interaction.reply({
    content: '参加表明をキャンセルしました。',
    ephemeral: true
  });

  // データ保存
  saveRecruitmentData();
}

// 募集締め切り処理
async function closeRecruitment(interaction, recruitmentId) {
  debugLog('CloseRecruitment', `募集締め切り処理: ${recruitmentId}, User: ${interaction.user.tag}`);

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) {
    return await interaction.reply({ content: '締め切り対象の募集が見つかりません。', ephemeral: true });
  }

  // 募集者以外は締め切れないようにする
  if (interaction.user.id !== recruitment.creator) {
    // 管理者も締め切れるようにする場合
     if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
         return await interaction.reply({ content: '募集者またはサーバー管理者のみが募集を締め切ることができます。', ephemeral: true });
     }
     debugLog('CloseRecruitment', `管理者(${interaction.user.tag})による強制締め切り`);
  }

  // 既に締め切られている場合
  if (recruitment.status === 'closed' || recruitment.status === 'assigned') {
     return await interaction.reply({ content: 'この募集は既に締め切られています。', ephemeral: true });
  }

  // 参加者が0人の場合でも締め切れるようにする (割り振りはスキップされる)
  // if (recruitment.participants.length < 6) { // 6人未満の場合
  //    return await interaction.reply({ content: `参加者が6人に満たないため、まだ締め切れません。（現在 ${recruitment.participants.length}人）`, ephemeral: true });
  // }

  recruitment.status = 'closed'; // まず closed にする
  debugLog('CloseRecruitment', `募集ステータスを 'closed' に変更: ${recruitmentId}, 参加者数: ${recruitment.participants.length}`);

  // 属性の自動割り振りを実行 (プレビューモードではなく、実際に割り振る)
  try {
    await autoAssignAttributes(recruitment, false); // false = 実際の割り振り
  } catch (assignError) {
      console.error(`属性割り振りエラー (ID: ${recruitmentId}):`, assignError);
      // エラーが発生した場合でも、メッセージ更新は試みる
      await interaction.reply({ content: '募集を締め切りましたが、属性の自動割り振りに失敗しました。手動で調整してください。', ephemeral: true }).catch(()=>{});
      // ステータスは closed のまま
      activeRecruitments.set(recruitmentId, recruitment); // 念のためMap更新
      await updateRecruitmentMessage(recruitment); // メッセージ更新は試みる
      saveRecruitmentData();
      return; // 処理中断
  }


  // 募集メッセージの更新
  try {
      await updateRecruitmentMessage(recruitment); // 割り振り結果を反映
  } catch (updateError) {
      console.error("締め切り後のメッセージ更新エラー:", updateError);
      // 更新に失敗しても締め切り自体は完了している
  }

  await interaction.reply({
    content: '募集を締め切り、参加者の割り振りを行いました。',
    ephemeral: true
  });

  // 割り振り結果をチャンネルに通知
  try {
      const channel = await client.channels.fetch(recruitment.channel);
      if (channel && channel.isTextBased()) {
          let assignedText = `**【${recruitment.finalRaidType || recruitment.type} 募集締切】**\n` +
                             `ID: ${recruitment.id}\n` +
                             `開催予定: ${recruitment.finalTime || recruitment.time}\n` +
                             `参加者 (${recruitment.participants.length}名) の割り振りが完了しました。\n`;
           attributes.forEach(attr => {
              const p = recruitment.participants.find(pt => pt.assignedAttribute === attr);
              assignedText += `【${attr}】: ${p ? `<@${p.userId}>` : '空き'}\n`;
           });
           await channel.send({ content: assignedText, allowedMentions: { users: recruitment.participants.map(p => p.userId) } }); // 参加者にメンション
      }
  } catch (notifyError) {
      console.error("割り振り結果通知エラー:", notifyError);
  }


  // データ保存
  saveRecruitmentData();
}

// 募集メッセージ更新処理 (改善版)
async function updateRecruitmentMessage(recruitment) {
  if (!recruitment || !recruitment.channel || !recruitment.messageId) {
      console.error("メッセージ更新に必要な情報が不足しています:", recruitment);
      return;
  }
  debugLog('UpdateMessage', `募集メッセージ更新開始: ${recruitment.id}, Channel: ${recruitment.channel}, Message: ${recruitment.messageId}, Status: ${recruitment.status}`);

  try {
    const channel = await client.channels.fetch(recruitment.channel);
    if (!channel || !channel.isTextBased()) {
      console.error(`チャンネルが見つからないかテキストチャンネルではありません: ${recruitment.channel}`);
      // チャンネルが見つからない場合、募集データを無効化するなどの措置も検討
      // recruitment.status = 'error';
      // activeRecruitments.set(recruitment.id, recruitment);
      return;
    }

    // メッセージを取得 (fetch)
    let message;
    try {
        message = await channel.messages.fetch(recruitment.messageId);
    } catch (fetchError) {
        // メッセージが見つからない場合 (削除されたなど)
        if (fetchError.code === 10008 /* Unknown Message */) {
            console.warn(`募集メッセージが見つかりません (削除された可能性): ${recruitment.messageId}`);
            // 募集データを削除または非アクティブ化する
            activeRecruitments.delete(recruitment.id);
            console.log(`存在しないメッセージ ${recruitment.messageId} に紐づく募集データ ${recruitment.id} を削除しました。`);
            saveRecruitmentData(); // データ変更を保存
            return; // 更新処理中断
        }
        // その他のfetchエラー
        console.error(`メッセージ取得エラー (ID: ${recruitment.messageId}):`, fetchError);
        return; // 更新処理中断
    }


    const dateObj = new Date(recruitment.date + 'T00:00:00Z');
    const formattedDate = dateObj.toLocaleDateString('ja-JP', {
       timeZone: 'Asia/Tokyo',
       year: 'numeric',
       month: 'long',
       day: 'numeric',
       weekday: 'short'
    });

    let description = `募集者: <@${recruitment.creator}>\n\n`;
    let contentText = ''; // メッセージ本文

    // 募集ステータスに応じた表示
    if (recruitment.status === 'active') {
      contentText = `**【${recruitment.type} 募集中】** ${formattedDate} ${recruitment.time} 開始予定`;
      description += `🟢 **募集中** (現在 ${recruitment.participants.length} / 6 名)\n` + // ★上限表示
                     `参加希望の方は下の「参加申込」ボタンからどうぞ！\n\n`;
    } else if (recruitment.status === 'closed' || recruitment.status === 'assigned') {
      contentText = `**【${recruitment.finalRaidType || recruitment.type} 募集終了】** ${formattedDate} ${recruitment.finalTime || recruitment.time} 開始予定`;
      description += `🔴 **募集終了** (参加者: ${recruitment.participants.length}名)\n`;
      if (recruitment.type === '参加者希望' && recruitment.finalRaidType) {
        description += `**実施コンテンツ: ${recruitment.finalRaidType}**\n`;
      }
      if (recruitment.finalTime && recruitment.finalTime !== recruitment.time) {
        description += `**最終的な開始時間: ${recruitment.finalTime}**\n`;
      }
      description += '\n参加者の割り振りは以下の通りです。\n\n';
    } else {
        // pending や error 状態など
        contentText = `**【${recruitment.type} 準備中/エラー】**`;
        description += `⚠️ 現在の状態: ${recruitment.status}\n`;
    }

    // 参加者の詳細リスト（募集中の場合）
    if (recruitment.status === 'active' && recruitment.participants.length > 0) {
      description += '**【現在の参加表明者】**\n';
      // 時間帯でグループ化せず、単純にリスト表示（シンプル化）
      recruitment.participants.forEach(p => {
        description += `- <@${p.userId}> [${p.joinType}] ${p.attributes.join('/')} (${p.timeAvailability})`;
        if (p.remarks) {
            description += ` *備考: ${p.remarks.substring(0, 30)}${p.remarks.length > 30 ? '...': ''}*`; // 備考も短く表示
        }
        description += '\n';
      });
       description += '\n'; // 末尾に改行
    }

    // エンベッド作成
    const embed = new EmbedBuilder()
      .setTitle(`${recruitment.status === 'active' ? '📢' : '🏁'} 【${recruitment.type}】${formattedDate} ${recruitment.time}`)
      .setDescription(description)
      .setColor(recruitment.status === 'active' ? '#3498DB' : (recruitment.status === 'assigned' || recruitment.status === 'closed' ? '#E74C3C' : '#F1C40F')) // assigned/closed は赤、他は黄色
      .setTimestamp() // メッセージ更新時刻
      .setFooter({ text: `募集ID: ${recruitment.id} | ${recruitment.status === 'active' ? `開催日 朝8時に自動締切 (${recruitment.participants.length}/6名)` : `募集終了 (${recruitment.participants.length}名)`}` }); // フッターにも人数表示

    // 各属性のフィールドを設定
    const fields = [];
    attributes.forEach(attr => {
      let value = '－'; // デフォルトはハイフン
      let assignedParticipant = null;

      if (recruitment.status === 'closed' || recruitment.status === 'assigned') {
        // 締め切り/割り当て済みの場合: 割り当てられた参加者を表示
        assignedParticipant = recruitment.participants.find(p => p.assignedAttribute === attr);
        if (assignedParticipant) {
          value = `<@${assignedParticipant.userId}>`;
           if (assignedParticipant.remarks) {
               value += ` 📝`; // 備考ありアイコン
           }
        } else {
           value = '空き';
        }
      } else if (recruitment.status === 'active') {
        // 募集中の場合: その属性を希望している参加者リスト (短縮表示)
        const hopefuls = recruitment.participants.filter(p => p.attributes.includes(attr));
        if (hopefuls.length > 0) {
           // 2名まで名前表示、それ以上は人数
           if (hopefuls.length <= 2) {
               value = hopefuls.map(p => `<@${p.userId}>`).join('\n');
           } else {
               value = `${hopefuls.length}名`;
           }
        } else {
           value = '－'; // 希望者なし
        }
      }

      fields.push({ name: `【${attr}】`, value: value, inline: true });
    });

    embed.addFields(fields);


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
          .setDisabled(recruitment.status !== 'active'), // キャンセルも募集中の時だけ
        new ButtonBuilder()
          .setCustomId(`close_recruitment_${recruitment.id}`)
          .setLabel('募集締め切り')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(recruitment.status !== 'active') // 締め切りも募集中の時だけ
      );

    // components変数を定義
    const components = [joinRow];

    // テストモードがアクティブな場合のみテスト参加者追加ボタンを表示
    if (testMode.active && recruitment.status === 'active') {
      const testRow = new ActionRowBuilder()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`add_test_participants_${recruitment.id}`)
            .setLabel('🧪 テスト参加者追加 (管理)')
            .setStyle(ButtonStyle.Secondary)
             .setDisabled(recruitment.status !== 'active') // 念のため無効化条件
        );
      components.push(testRow);
    }

    // メッセージを編集
    await message.edit({
      content: contentText, // メッセージ本文を更新
      embeds: [embed],
      components: components // 更新されたボタン
    });

    debugLog('UpdateMessage', `募集メッセージ更新完了: ${recruitment.id}`);
  } catch (error) {
     // edit でのエラー処理 (Unknown Message 以外)
     if (error.code !== 10008 /* Unknown Message */) {
        console.error(`募集メッセージ ${recruitment?.messageId} の更新中にエラーが発生:`, error);
     }
     // Unknown Message の場合は上で処理済みのはず
  }
}

// 属性自動割り振り処理 (プレビューモード対応)
async function autoAssignAttributes(recruitment, previewOnly = false) {
  debugLog('AutoAssign', `属性自動割り振り開始: ${recruitment.id}, Participants: ${recruitment.participants.length}, Preview: ${previewOnly}`);

  // 参加者が0人の場合は割り振りスキップ
  if (recruitment.participants.length === 0) {
    debugLog('AutoAssign', '参加者がいないため、割り振りをスキップします');
     if (!previewOnly) {
         recruitment.status = 'closed'; // 0人でも締め切り状態にはする
         recruitment.finalTime = recruitment.time;
         recruitment.finalRaidType = recruitment.type;
     }
    return recruitment; // recruitmentオブジェクトを返す
  }

  // ステータス変更はプレビューモードでない場合のみ行う
  if (!previewOnly) {
    recruitment.status = 'assigned'; // 'assigned' に変更
    debugLog('AutoAssign', `ステータスを 'assigned' に変更しました`);
  } else {
    debugLog('AutoAssign', `プレビューモード: ステータスは変更しません (現在のステータス: ${recruitment.status})`);
    // プレビューの場合でも、一時的に割り当て結果を見るために participant.assignedAttribute はクリアする
     recruitment.participants.forEach(p => p.assignedAttribute = null);
  }


  // 時間帯ごとに参加者をグループ化 -> 時間は考慮せず、全員を対象にする方がシンプルで確実かも
  // 最も遅い時間に合わせるロジックは複雑化しやすい

  // --- 時間帯を考慮しないシンプルな割り当てロジック ---

  // 1. 最終的なレイドタイプを決定（「参加者希望」の場合）
  let finalRaidType = recruitment.type;
  if (recruitment.type === '参加者希望') {
    let tengenVotes = 0;
    let luciZeroVotes = 0;
    recruitment.participants.forEach(p => {
      if (p.joinType === '天元') tengenVotes++;
      else if (p.joinType === 'ルシゼロ') luciZeroVotes++;
      else if (p.joinType === 'なんでも可') {
        tengenVotes += 0.5; // どちらでも良い場合は0.5票ずつ
        luciZeroVotes += 0.5;
      }
    });
    finalRaidType = tengenVotes >= luciZeroVotes ? '天元' : 'ルシゼロ'; // 同数の場合は天元優先（または任意）
    debugLog('AutoAssign', `決定したレイドタイプ: ${finalRaidType} (天元: ${tengenVotes}, ルシゼロ: ${luciZeroVotes})`);
  }
  recruitment.finalRaidType = finalRaidType; // 募集データに保存

  // 2. 決定したレイドタイプに参加可能な参加者を抽出
  const eligibleParticipants = recruitment.participants.filter(p => {
      if (finalRaidType === '天元') return p.joinType === '天元' || p.joinType === 'なんでも可';
      if (finalRaidType === 'ルシゼロ') return p.joinType === 'ルシゼロ' || p.joinType === 'なんでも可';
      return false; // ここには来ないはず
  }).map(p => ({ ...p, assignedAttribute: null })); // コピーを作成し、割り当てをリセット

  debugLog('AutoAssign', `割り振り対象参加者数: ${eligibleParticipants.length}名 (タイプ: ${finalRaidType})`);
  if (eligibleParticipants.length === 0) {
      debugLog('AutoAssign', '割り振り対象の参加者がいません。処理を終了します。');
       if (!previewOnly) {
           recruitment.status = 'closed'; // 参加者がいてもタイプ不一致なら closed
           recruitment.finalTime = recruitment.time; // 時間は元のまま
       }
      return recruitment;
  }

  // 3. 参加可能時間を決定 (最も遅い時間を選択)
   const timeOrder = { /* ... (前述の時間順序マップ) ... */
       'now': 0, '00:00': 1, '01:00': 2, '02:00': 3, '03:00': 4, '04:00': 5, '05:00': 6,
       '06:00': 7, '07:00': 8, '08:00': 9, '09:00': 10, '10:00': 11, '11:00': 12, '12:00': 13,
       '13:00': 14, '14:00': 15, '15:00': 16, '16:00': 17, '17:00': 18, '18:00': 19, '19:00': 20,
       '20:00': 21, '21:00': 22, '22:00': 23, '23:00': 24
   };
   let latestTimeSlot = 'now'; // デフォルトは 'now'
   let latestTimeValue = 0;
   eligibleParticipants.forEach(p => {
       const timeValue = timeOrder[p.timeAvailability] ?? -1; // 不明な時間は -1
       if (timeValue > latestTimeValue) {
           latestTimeValue = timeValue;
           latestTimeSlot = p.timeAvailability;
       }
   });
   recruitment.finalTime = latestTimeSlot; // 募集データに保存
   debugLog('AutoAssign', `決定した開催時間: ${latestTimeSlot}`);


  // 4. 属性割り振り (改善版: スコアリングと優先度)
  const assignments = {}; // { attr: participant }
  const attributeCounts = {}; // { attr: count }
  attributes.forEach(attr => attributeCounts[attr] = 0);

  // 各属性の希望者数をカウント
  eligibleParticipants.forEach(p => {
    p.attributes.forEach(attr => { if (attributeCounts[attr] !== undefined) attributeCounts[attr]++; });
  });
  debugLog('AutoAssign', '属性希望者数:', attributeCounts);

  // 参加者のスコアリング
  eligibleParticipants.forEach(p => {
    p.attributeScores = {};
    p.attributes.forEach(attr => {
      p.attributeScores[attr] = 1 / Math.max(1, attributeCounts[attr]); // 希少性スコア
    });
    // 優先スコア = (希望属性の少なさ) + (最も希少な希望属性のスコア)
    p.priorityScore = (10 / Math.max(1, p.attributes.length)) +
                       Math.max(0, ...p.attributes.map(attr => p.attributeScores[attr] || 0));
  });

  // 優先スコアでソート (降順、スコア高い人が先)
  eligibleParticipants.sort((a, b) => b.priorityScore - a.priorityScore);
  debugLog('AutoAssign', 'ソート済み参加者:', eligibleParticipants.map(p=>({u:p.username, s:p.priorityScore.toFixed(2)})));

  // 優先順に割り当て試行
  const assignedUserIds = new Set(); // 割り当て済みユーザーID
  attributes.forEach(attr => {
      // この属性を希望し、まだ割り当てられていない参加者を探す
      const candidates = eligibleParticipants.filter(p =>
          !assignedUserIds.has(p.userId) && p.attributes.includes(attr)
      );

      if (candidates.length > 0) {
          // 候補者の中で最も優先スコアが高い人を選ぶ
          candidates.sort((a, b) => b.priorityScore - a.priorityScore);
          const chosenParticipant = candidates[0];
          assignments[attr] = chosenParticipant;
          chosenParticipant.assignedAttribute = attr; // 一時オブジェクトに記録
          assignedUserIds.add(chosenParticipant.userId);
          debugLog('AutoAssign', `${chosenParticipant.username} を ${attr} に割り当て (優先スコア: ${chosenParticipant.priorityScore.toFixed(2)})`);
      } else {
           debugLog('AutoAssign', `${attr} 属性の希望者がいないか、全員割り当て済み`);
      }
  });

   // 割り当てられなかった参加者を確認
   const unassignedParticipants = eligibleParticipants.filter(p => !assignedUserIds.has(p.userId));
   if (unassignedParticipants.length > 0) {
       debugLog('AutoAssign', `未割り当て参加者: ${unassignedParticipants.map(p => p.username).join(', ')}`);
   }
    // 空いている属性を確認
   const emptyAttributes = attributes.filter(attr => !assignments[attr]);
    if (emptyAttributes.length > 0) {
        debugLog('AutoAssign', `空き属性: ${emptyAttributes.join(', ')}`);
    }


  // 5. 最終結果を recruitment.participants に反映 (プレビューでない場合のみ永続化)
  if (!previewOnly) {
      recruitment.participants.forEach(p => {
          const assignedInfo = eligibleParticipants.find(ep => ep.userId === p.userId);
          p.assignedAttribute = assignedInfo ? assignedInfo.assignedAttribute : null; // 割り当て結果を反映
      });
      debugLog('AutoAssign', '最終的な割り当て結果を募集データに反映しました。');
  } else {
      // プレビューの場合は、元の recruitment.participants は変更せず、
      // eligibleParticipants の割り当て結果を updateRecruitmentMessage に渡すか、
      // 一時的に recruitment.participants を書き換えて updateRecruitmentMessage を呼び、その後元に戻す。
      // → ここでは、updateRecruitmentMessage が recruitment.participants を直接読むことを想定し、
      //   プレビュー表示のために一時的に割り当てる。
      const originalAssignments = recruitment.participants.map(p => p.assignedAttribute); // 元の状態を保存
      recruitment.participants.forEach(p => {
          const assignedInfo = eligibleParticipants.find(ep => ep.userId === p.userId);
           p.assignedAttribute = assignedInfo ? assignedInfo.assignedAttribute : null;
      });
      debugLog('AutoAssign', 'プレビュー用に一時的な割り当てを行いました。');
      // updateRecruitmentMessage が呼ばれた後、元に戻す処理が必要 -> updateRecruitmentMessage後に行うべき
      // ただし、updateRecruitmentMessage は非同期なので注意が必要
      // より安全なのは、updateRecruitmentMessage にプレビュー結果を渡すことだが、関数のインターフェース変更が必要。
      // ここでは、プレビュー後は元に戻らない可能性があるリスクを許容する。
       // --- 元に戻す処理の例 (非同期に注意) ---
       /*
       setTimeout(() => {
           recruitment.participants.forEach((p, index) => {
               p.assignedAttribute = originalAssignments[index];
           });
           debugLog('AutoAssign', 'プレビュー用の一時割り当てを元に戻しました。');
       }, 1000); // 1秒後など (updateが終わっていることを期待)
       */
       // --- ここまで ---
  }


  return recruitment; // 更新されたrecruitmentオブジェクトを返す
}


// 自動締め切りチェック処理
function checkAutomaticClosing() {
  const now = new Date();
  const activeRecruitmentEntries = Array.from(activeRecruitments.entries())
                                     .filter(([id, r]) => r.status === 'active');

  // アクティブな募集がない場合はログだけ出して終了
  if (activeRecruitmentEntries.length === 0) {
      // 定期的にログを出すのは冗長なので、変化があった時だけ出すようにするなど工夫も可
      // console.log(`[AutoCloseCheck] アクティブな募集はありません。`);
      return;
  }

  debugLog('AutoCloseCheck', `チェック開始 - アクティブ募集数: ${activeRecruitmentEntries.length}`);


  activeRecruitmentEntries.forEach(async ([id, recruitment]) => {
    try {
        const raidDateStr = recruitment.date; // YYYY-MM-DD
        // 開催日の朝8時 (JST) を Date オブジェクトで表現
        // 注意: new Date('YYYY-MM-DD') は環境によって UTC or Local time になるため、明示的に扱う
        const [year, month, day] = raidDateStr.split('-').map(Number);
        // 日本時間の朝8時を指定
        const closingTime = new Date(Date.UTC(year, month - 1, day, 8, 0, 0) - (9 * 60 * 60 * 1000)); // UTCの8時から9時間引く = JSTの8時

        // 日付比較
        if (now >= closingTime) {
          debugLog('AutoCloseCheck', `募集ID: ${id} - 自動締切時刻 (${closingTime.toISOString()} JST) を過ぎました。`);

          // ステータスを closed に変更
          recruitment.status = 'closed';
          debugLog('AutoCloseCheck', `ステータスを 'closed' に変更`);

          // 属性割り振り実行
          debugLog('AutoCloseCheck', `属性割り振り開始`);
          await autoAssignAttributes(recruitment, false); // 実際の割り振り

          // メッセージ更新
          debugLog('AutoCloseCheck', `メッセージ更新`);
          await updateRecruitmentMessage(recruitment);

          // 終了通知をチャンネルに送信
          debugLog('AutoCloseCheck', `終了通知送信`);
          const channel = await client.channels.fetch(recruitment.channel);
          if (channel && channel.isTextBased()) {
             let assignedText = `**【${recruitment.finalRaidType || recruitment.type} 自動締切】**\n` +
                                `ID: ${recruitment.id} (募集者: <@${recruitment.creator}>)\n` +
                                `募集が自動的に締め切られ、参加者(${recruitment.participants.length}名)が割り振られました。\n` +
                                `開催予定: ${recruitment.finalTime || recruitment.time}\n`;
              attributes.forEach(attr => {
                 const p = recruitment.participants.find(pt => pt.assignedAttribute === attr);
                 assignedText += `【${attr}】: ${p ? `<@${p.userId}>` : '空き'}\n`;
              });
              await channel.send({ content: assignedText, allowedMentions: { users: recruitment.participants.map(p => p.userId) } });
              debugLog('AutoCloseCheck', `自動締め切り完了 - ID: ${id}`);
          } else {
             console.warn(`[AutoCloseCheck] ID ${id} の通知チャンネルが見つかりません。`);
          }

          // データ保存
          saveRecruitmentData();

        } else {
          // 締切時刻までまだ時間がある場合 (ログは頻繁に出さない)
          const minutes = now.getMinutes();
           if (minutes % 15 === 0) { // 15分ごとに出力
               const remainingMinutes = Math.round((closingTime.getTime() - now.getTime()) / (60 * 1000));
               debugLog('AutoCloseCheck', `募集ID ${id} - 締切まであと約 ${remainingMinutes} 分 (予定: ${closingTime.toISOString()} JST)`);
           }
        }
    } catch (error) {
        console.error(`[AutoCloseCheck] 募集ID ${id} の処理中にエラーが発生:`, error);
        // エラーが発生した募集を 'error' ステータスにするなどの処理も検討
        recruitment.status = 'error';
        activeRecruitments.set(id, recruitment);
        saveRecruitmentData(); // エラー状態を保存
    }
  });
}

// 募集リスト表示機能
async function showActiveRecruitments(message) {
  const activeList = Array.from(activeRecruitments.values())
    .filter(r => r.status === 'active');

  if (activeList.length === 0) {
    return message.reply('現在、募集中の高難易度レイドはありません。 `!募集` コマンドで作成できます！');
  }

  const embed = new EmbedBuilder()
    .setTitle('🔍 現在募集中のレイド一覧')
    .setDescription(`現在 ${activeList.length} 件の募集があります。\n参加するには各募集のメッセージで「参加申込」ボタンを押してください。`)
    .setColor('#3498DB')
    .setTimestamp();

  // 募集情報を整理してフィールドに追加
  activeList.forEach((recruitment, index) => {
     const dateObj = new Date(recruitment.date + 'T00:00:00Z');
     const formattedDate = dateObj.toLocaleDateString('ja-JP', {
         timeZone: 'Asia/Tokyo',
         month: 'numeric', // 短縮表示
         day: 'numeric',
         weekday: 'short'
     });

    const participantCount = recruitment.participants.length;
    const jumpLink = recruitment.messageId && recruitment.channel && message.guildId
      ? `[ここをクリック](https://discord.com/channels/${message.guildId}/${recruitment.channel}/${recruitment.messageId})`
      : 'メッセージリンク不明';

    embed.addFields({
      name: `${index + 1}. ${recruitment.type} - ${formattedDate} ${recruitment.time}`,
      value: `募集者: <@${recruitment.creator}>\n参加者: ${participantCount} / 6 名\n${jumpLink}`
    });
  });

  await message.reply({ embeds: [embed] });
}

// 募集削除処理
async function deleteRecruitment(message, recruitmentId) {
  const recruitment = activeRecruitments.get(recruitmentId);

  if (!recruitment) {
    return message.reply(`ID「${recruitmentId}」の募集データが見つかりません。`);
  }

  // 募集者またはサーバー管理者のみ削除可能
  if (recruitment.creator !== message.author.id && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    return message.reply('募集者本人またはサーバー管理者のみが募集を削除できます。');
  }

  try {
    // 募集メッセージを削除または編集
    if (recruitment.channel && recruitment.messageId) {
        const channel = await client.channels.fetch(recruitment.channel).catch(() => null);
        if (channel && channel.isTextBased()) {
          const recruitMessage = await channel.messages.fetch(recruitment.messageId).catch(() => null);
          if (recruitMessage) {
             // 削除する代わりに編集して履歴を残す
             await recruitMessage.edit({
               content: `**【募集削除】** この募集 (ID: ${recruitmentId}) は ${message.author.tag} によって削除されました。`,
               embeds: [],
               components: [] // ボタンも消す
             });
             // または完全に削除する場合
             // await recruitMessage.delete();
          } else {
              console.warn(`削除対象の募集メッセージが見つかりません: ${recruitment.messageId}`);
          }
        } else {
            console.warn(`削除対象の募集チャンネルが見つかりません: ${recruitment.channel}`);
        }
    }


    // 募集データをMapから削除
    const deleted = activeRecruitments.delete(recruitmentId);

    if (deleted) {
        await message.reply(`募集ID: \`${recruitmentId}\` の募集データを削除しました。`);
        debugLog('DeleteRecruitment', `募集削除成功: ${recruitmentId}, 実行者: ${message.author.tag}`);
        saveRecruitmentData(); // データ変更を保存
    } else {
         // Mapからの削除に失敗した場合 (通常は起こらないはず)
         throw new Error("Mapからのデータ削除に失敗しました。");
    }

  } catch (error) {
    console.error('募集削除エラー:', error);
    await message.reply('募集の削除中にエラーが発生しました。');
    debugLog('DeleteRecruitment', `募集削除失敗: ${recruitmentId}, Error: ${error.message}`);
  }
}

// ヘルプ表示機能
async function showHelp(message) {
  const embed = new EmbedBuilder()
    .setTitle('📚 グラブル高難易度募集Bot ヘルプ')
    .setDescription('天元・ルシゼロ等の高難易度レイド募集を支援するBotです。')
    .setColor('#1ABC9C') // 色変更
    .addFields(
      {
        name: '🌟 基本コマンド',
        value: '`!募集` - 新しいレイド募集を開始します。\n' +
               '`!募集リスト` - 現在アクティブな募集一覧を表示します。\n' +
               '`!募集ヘルプ` - このヘルプを表示します。\n' +
               '`!IDリスト` - アクティブな募集のIDと状態を表示します。'
      },
      {
        name: '⚙️ 募集の流れ',
        value: '1. `!募集` を実行\n' +
               '2. ボタンでレイドタイプ、日付、時間を選択\n' +
               '3. 確認画面で「確定」を押すと、募集メッセージが投稿されます。'
      },
      {
        name: '🎮 参加の流れ',
        value: '1. 参加したい募集メッセージの「参加申込」ボタンを押す。\n' +
               '2. （募集タイプが「参加者希望」の場合）参加したいコンテンツを選択。\n' +
               '3. 担当可能な属性を複数選択。\n' +
               '4. 参加可能な最も早い時間を選択。\n' +
               '5. 確認画面で「備考入力して参加確定」または「参加確定(備考なし)」を押す。\n' +
               '6. （備考入力の場合）モーダルに備考を入力して送信。'
      },
       {
        name: '👥 割り振りと締切',
        value: '- 参加者が**6名**に達すると、自動的に属性割り振りの**プレビュー**が行われます。\n' +
               '- 募集メッセージに表示される属性担当者は、このプレビュー結果です。\n' +
               '- 開催日当日の**朝8時**に募集は**自動的に締め切られ**、その時点の参加者で最終的な割り振りが行われます。\n' +
               '- 募集者は「募集締め切り」ボタンで手動で締め切ることもできます（6人に満たなくても可）。\n' +
               '- 最終的な割り振り結果は、締め切り時にチャンネルに通知されます。'
      },
       {
        name: '🔧 管理者用コマンド',
        value: '`!募集削除 [募集ID]` - 指定した募集を削除します。\n' +
               '`!テストモード開始` / `!テストモード終了` - テスト機能の有効/無効化。\n' +
               '`!テスト参加者追加 [募集ID] [人数]` (`!testadd`) - テスト用参加者を追加。\n' +
               '`!追加 [募集ID]` - テスト参加者を3名追加。\n' +
               '`!直接テスト [募集ID] (人数)` (`!directtest`) - テスト参加者を指定人数追加。\n' +
               '`!募集確認 [募集ID]` - 募集の詳細データを表示 (デバッグ用)。\n' +
               '`!募集詳細確認` - 全募集の概要データを表示 (デバッグ用)。\n' +
               '`!再起動テスト` - Botを再起動します（データ保存テスト用）。'
      }
    )
    .setFooter({ text: '不明な点があれば管理者に問い合わせてください。' });

  await message.reply({ embeds: [embed] });
}

// 募集詳細表示機能（デバッグ用）
async function showRecruitmentDetails(message, recruitmentId) {
   // 管理者チェック (デバッグ情報は管理者のみ)
   if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
       return message.reply('このコマンドはサーバー管理者のみ使用できます。');
   }

  const recruitment = activeRecruitments.get(recruitmentId);

  if (!recruitment) {
    return message.reply(`指定された募集ID「${recruitmentId}」は存在しません。`);
  }

  // 募集データの詳細を表示 (JSON形式で見やすく)
  let details = `**募集ID: ${recruitmentId} の詳細データ**\n\`\`\`json\n`;
  details += JSON.stringify(recruitment, (key, value) => {
      // participants は数が多くなりがちなので、ここでは除外する
      if (key === 'participants') return `[${value.length} 名]`;
      return value;
  }, 2);
  details += '\n```';

  // 参加者情報も表示
  let participantsInfo = '**参加者情報:**\n';
  if (recruitment.participants.length > 0) {
      participantsInfo += '```json\n';
      participantsInfo += JSON.stringify(recruitment.participants.map(p => ({
          // 表示項目を絞る
          username: p.username,
          userId: p.userId,
          joinType: p.joinType,
          attributes: p.attributes,
          time: p.timeAvailability,
          assigned: p.assignedAttribute || '未',
          remarks: p.remarks || '',
          isTest: p.isTestParticipant || false
      })), null, 2);
      participantsInfo += '\n```';
  } else {
      participantsInfo += '参加者はいません。';
  }


  // 長すぎる場合は分割して送信
  const combined = details + '\n' + participantsInfo;
  if (combined.length > 2000) {
      // details をまず送信
      if (details.length <= 2000) {
          await message.reply(details);
      } else {
          for (let i = 0; i < details.length; i += 1950) { // 少し余裕を持たせる
              await message.reply(details.substring(i, i + 1950));
          }
      }
      // participantsInfo を送信
       if (participantsInfo.length <= 2000) {
           await message.channel.send(participantsInfo); // replyではなくsend
       } else {
            for (let i = 0; i < participantsInfo.length; i += 1950) {
               await message.channel.send(participantsInfo.substring(i, i + 1950));
            }
       }

  } else {
      await message.reply(combined);
  }

}

// 全募集データ表示機能（デバッグ用）
async function showAllRecruitmentDetails(message) {
  // 管理者チェック
  if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('このコマンドはサーバー管理者のみ使用できます。');
  }

  const allRecruitments = Array.from(activeRecruitments.entries());

  if (allRecruitments.length === 0) {
    return message.reply('現在アクティブな募集データはありません。');
  }

  let debugInfo = `**現在の全募集データ (${allRecruitments.length}件)**\n\n`;

  allRecruitments.forEach(([id, data]) => {
    debugInfo += `**ID**: \`${id}\`\n`;
    debugInfo += `- タイプ: ${data.type || 'N/A'}\n`;
    debugInfo += `- 状態: ${data.status || 'N/A'}\n`;
    debugInfo += `- 日時: ${data.date || 'N/A'} ${data.time || 'N/A'}\n`;
    debugInfo += `- MsgID: ${data.messageId || 'N/A'}\n`;
    debugInfo += `- 参加者: ${data.participants?.length || 0}名\n`;
    debugInfo += `- 作成日時: ${data.createdAt ? new Date(data.createdAt).toLocaleString('ja-JP') : 'N/A'}\n\n`;
  });

  // 長さ制限があるので、2000文字以上なら分割
  if (debugInfo.length > 1950) {
    const parts = [];
    for (let i = 0; i < debugInfo.length; i += 1950) {
      parts.push(debugInfo.substring(i, i + 1950));
    }
    await message.reply(`全 ${allRecruitments.length} 件の募集データ（分割送信）:`);
    for (const part of parts) {
      await message.channel.send(part); // 分割分は send で
    }
  } else {
    await message.reply(debugInfo);
  }
}

//==========================================================================
// テストモード機能ブロック
//==========================================================================

// テストモード開始処理
async function startTestMode(message) {
  // 管理者チェックは呼び出し元で行う想定
  testMode.active = true;
  testMode.testParticipants = []; // 開始時にリセット

  const embed = new EmbedBuilder()
    .setTitle('🧪 テストモード開始')
    .setDescription('テストモードが**有効**になりました。\n' +
      '募集メッセージにテスト参加者追加ボタンが表示されます。\n' +
      '管理者用コマンド (`!テスト参加者追加` など) が利用可能です。\n\n' +
      '`!テストモード終了` で無効化できます。')
    .setColor('#FF9800')
    .setTimestamp();

  await message.reply({ embeds: [embed] });
  debugLog('TestMode', `テストモード開始, 実行者: ${message.author.tag}`);

  // 既存のアクティブな募集メッセージにテストボタンを追加するために更新
   const activeList = Array.from(activeRecruitments.values()).filter(r => r.status === 'active');
   for (const recruitment of activeList) {
       try {
           await updateRecruitmentMessage(recruitment);
       } catch (e) {
           console.error(`テストモード開始時のメッセージ更新エラー (ID: ${recruitment.id}):`, e);
       }
   }
}

// テストモード終了処理
async function endTestMode(message) {
  // 管理者チェックは呼び出し元で行う想定
  if (!testMode.active) {
    return await message.reply('テストモードは現在有効ではありません。');
  }

  testMode.active = false;
  const removedCount = await clearAllTestParticipants(); // テスト参加者削除関数を呼ぶ

  const embed = new EmbedBuilder()
    .setTitle('✅ テストモード終了')
    .setDescription(`テストモードが**無効**になりました。\n` +
      `追加されていた ${removedCount} 名のテスト参加者は自動的に削除されました。`)
    .setColor('#4CAF50')
    .setTimestamp();

  await message.reply({ embeds: [embed] });
  debugLog('TestMode', `テストモード終了, 実行者: ${message.author.tag}, 削除参加者: ${removedCount}`);

  // テストボタンを消すためにアクティブな募集メッセージを更新
   const activeList = Array.from(activeRecruitments.values()).filter(r => r.status === 'active');
   for (const recruitment of activeList) {
       try {
           await updateRecruitmentMessage(recruitment);
       } catch (e) {
           console.error(`テストモード終了時のメッセージ更新エラー (ID: ${recruitment.id}):`, e);
       }
   }
}

// 全てのテスト参加者を削除するヘルパー関数
async function clearAllTestParticipants() {
    let removedCount = 0;
    const affectedRecruitmentIds = new Set();

    activeRecruitments.forEach((recruitment, id) => {
        const initialCount = recruitment.participants.length;
        recruitment.participants = recruitment.participants.filter(p => !p.isTestParticipant);
        const currentCount = recruitment.participants.length;
        if (initialCount !== currentCount) {
            removedCount += (initialCount - currentCount);
            affectedRecruitmentIds.add(id);
             // 参加者が減ったことで割り当てが変わる可能性があるので、プレビューし直すか？
             // -> 簡略化のため、ここでは再プレビューはしない。必要なら手動で !追加 などを行う。
        }
    });

    // testMode.testParticipants 配列もクリア
    testMode.testParticipants = [];

    // 影響を受けた募集メッセージの更新は呼び出し元 (endTestMode) で行う

    return removedCount;
}


// ランダムな属性を生成
function getRandomAttributes() {
  const shuffled = [...attributes].sort(() => 0.5 - Math.random());
  const count = Math.floor(Math.random() * attributes.length) + 1; // 1〜6個
  return shuffled.slice(0, count);
}

// ランダムな参加可能時間を生成
function getRandomTimeAvailability() {
  const times = ['now', '19:00', '20:00', '21:00', '22:00', '23:00'];
  // now の出現率を少し上げる (例)
  if (Math.random() < 0.3) return 'now';
  return times[Math.floor(Math.random() * times.length)];
}

// テスト参加者名を生成
function generateTestParticipantName(index) {
  const prefixes = ['Test', 'Dummy', 'Bot', 'Sample', 'Mock'];
  const roles = ['Knight', 'Ace', 'Support', 'DPS', 'Healer', 'Tank'];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const role = roles[Math.floor(Math.random() * roles.length)];
  return `[${prefix}${index}]${role}`;
}

// テスト参加者追加処理 (!テスト参加者追加 コマンドから)
async function addTestParticipants(message, recruitmentId, count) {
  // 管理者チェックは呼び出し元で行う想定
  if (!testMode.active) {
    return await message.reply('テストモードが有効ではありません。`!テストモード開始` で有効にしてください。');
  }

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment) {
    return await message.reply(`指定された募集ID「${recruitmentId}」が見つかりません。`);
  }
  if (recruitment.status !== 'active') {
    return await message.reply(`この募集 (ID: ${recruitmentId}) は現在アクティブではありません（状態: ${recruitment.status}）。テスト参加者は追加できません。`);
  }

   // 参加者上限チェック (テスト参加者含めて6人まで)
   if (recruitment.participants.length + count > 6) {
       const canAdd = 6 - recruitment.participants.length;
       if (canAdd <= 0) {
            return await message.reply(`募集 (ID: ${recruitmentId}) は既に満員(6名)のため、テスト参加者を追加できません。`);
       } else {
           count = canAdd; // 追加可能な最大数に調整
           await message.reply(`募集の上限(6名)に達するため、追加するテスト参加者を ${count} 名に調整しました。`);
       }
   }


  const addedParticipants = [];
  for (let i = 0; i < count; i++) {
    const testUserId = `test-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 5)}`;
    const testUsername = generateTestParticipantName(recruitment.participants.length + i + 1); // 連番になるように

    let joinType;
    if (recruitment.type === '参加者希望') {
      const types = ['天元', 'ルシゼロ', 'なんでも可'];
      joinType = types[Math.floor(Math.random() * types.length)];
    } else {
      joinType = recruitment.type;
    }

    const testParticipant = {
      userId: testUserId,
      username: testUsername,
      joinType: joinType,
      attributes: getRandomAttributes(),
      timeAvailability: getRandomTimeAvailability(),
      remarks: '',
      assignedAttribute: null,
      isTestParticipant: true // フラグ
    };

    recruitment.participants.push(testParticipant);
    testMode.testParticipants.push(testParticipant); // グローバルリストにも追加
    addedParticipants.push(testParticipant);
  }

  try {
    // メッセージ更新
    await updateRecruitmentMessage(recruitment);

    // 確認メッセージ
    const embed = new EmbedBuilder()
      .setTitle('🧪 テスト参加者 追加完了')
      .setDescription(`募集ID: \`${recruitmentId}\` に ${addedParticipants.length} 名のテスト参加者を追加しました。\n現在の参加者数: ${recruitment.participants.length} / 6 名`)
      .setColor('#2196F3')
      .setTimestamp();
    // 追加した参加者の簡易情報を表示 (多すぎるとEmbedが見づらくなるので絞る)
    addedParticipants.slice(0, 5).forEach((p, index) => { // 最大5名まで表示
        embed.addFields({
            name: `${index + 1}. ${p.username}`,
            value: `Type: ${p.joinType}, Attr: ${p.attributes.join('/')}, Time: ${p.timeAvailability}`,
            inline: false
        });
    });
     if (addedParticipants.length > 5) {
         embed.addFields({ name: '...', value: `他 ${addedParticipants.length - 5} 名`, inline: false });
     }

    await message.reply({ embeds: [embed] });

    // 参加者が6人になった場合、自動割り振りプレビュー
    if (recruitment.participants.length === 6 && recruitment.status === 'active') {
      await message.channel.send(`参加者が6名になったため、ID "${recruitmentId}" の属性割り振りをプレビュー表示します...`);
      await autoAssignAttributes(recruitment, true); // プレビュー
      await updateRecruitmentMessage(recruitment); // プレビュー結果反映
    }

    debugLog('TestMode', `${message.author.tag} が募集ID ${recruitmentId} に ${addedParticipants.length} 名のテスト参加者を追加 (コマンド)`);
    saveRecruitmentData(); // データ保存

  } catch (error) {
    console.error(`テスト参加者追加コマンド処理エラー:`, error);
    await message.reply('テスト参加者の追加処理中にエラーが発生しました。');
  }
}

// テスト参加者追加オプション表示 (ボタンから)
async function showTestParticipantAddOptions(interaction, recruitmentId) {
  // 管理者チェックは呼び出し元(handleButtonInteraction)で行う想定
  if (!testMode.active) {
    return await interaction.reply({ content: 'テストモードが有効ではありません。', ephemeral: true });
  }

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.reply({ content: 'この募集は既に終了しているか、存在しません。', ephemeral: true });
  }

   // 現在の参加者数に基づいて追加可能な人数を計算
   const currentCount = recruitment.participants.length;
   const remainingSlots = 6 - currentCount;

   if (remainingSlots <= 0) {
        return await interaction.reply({ content: '募集は既に満員(6名)のため、テスト参加者を追加できません。', ephemeral: true });
   }

    // 選択肢を動的に生成
   const options = [];
   [1, 2, 3, 4, 5].forEach(num => { // 1から5人までの選択肢
       if (num <= remainingSlots) {
           options.push({
               label: `${num}人 追加`,
               value: String(num),
               description: `テスト参加者を${num}人追加 (合計 ${currentCount + num} / 6 名)`
           });
       }
   });
    if (options.length === 0) { // 1人も追加できない場合 (通常は上のifで弾かれるはず)
         return await interaction.reply({ content: '募集は既に満員(6名)のため、テスト参加者を追加できません。', ephemeral: true });
    }


  // 参加者数選択用セレクトメニュー
  const row = new ActionRowBuilder()
    .addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`test_participant_count_${recruitmentId}`)
        .setPlaceholder('追加するテスト参加者の人数を選択')
        .addOptions(options) // 動的に生成した選択肢
    );

  const embed = new EmbedBuilder()
    .setTitle('🧪 テスト参加者 追加')
    .setDescription(`募集ID: \`${recruitmentId}\` (現在 ${currentCount} / 6 名)\n追加するテスト参加者の人数を選択してください。\n参加タイプ、属性、時間はランダムに設定されます。`)
    .setColor('#2196F3');

  await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true
  });
}

// テスト参加者追加確認UI表示 (セレクトメニューから)
async function showTestParticipantConfirmation(interaction, recruitmentId, count) {
 // 管理者チェックは呼び出し元(handleSelectMenuInteraction)で行う想定
  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.update({ content: 'この募集は既に終了しているか、存在しません。', embeds: [], components: [], ephemeral: true })
           .catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
  }

  const currentPCount = recruitment.participants.length;
   // 再度上限チェック
   if (currentPCount + count > 6) {
       return await interaction.update({ content: `エラー: テスト参加者を${count}名追加すると上限(6名)を超えてしまいます。(現在${currentPCount}名)`, embeds: [], components: [], ephemeral: true })
               .catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
   }

  const embed = new EmbedBuilder()
    .setTitle('🧪 テスト参加者 追加確認')
    .setDescription(`募集ID: \`${recruitmentId}\` に **${count} 名** のテスト参加者を追加します。\n\n` +
      `現在の参加者数: ${currentPCount} / 6 名\n` +
      `追加後の参加者数: ${currentPCount + count} / 6 名`)
    .setColor('#2196F3');

  const row = new ActionRowBuilder()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(`confirm_test_participants_${recruitmentId}_${count}`)
        .setLabel(`${count}名 追加する`)
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('cancel_test_participants') // キャンセルボタンID
        .setLabel('キャンセル')
        .setStyle(ButtonStyle.Danger)
    );

  await interaction.update({ // update を使う (セレクトメニューの応答)
    embeds: [embed],
    components: [row]
  }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
}

// テスト参加者追加確定処理 (確認ボタンから)
async function confirmAddTestParticipants(interaction, recruitmentId, count) {
  // 管理者チェックは呼び出し元(handleButtonInteraction)で行う想定
  if (!testMode.active) {
    return await interaction.update({ content: 'テストモードが有効ではありません。', embeds: [], components: [], ephemeral: true })
           .catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
  }

  const recruitment = activeRecruitments.get(recruitmentId);
  if (!recruitment || recruitment.status !== 'active') {
    return await interaction.update({ content: 'この募集は既に終了しているか、存在しません。', embeds: [], components: [], ephemeral: true })
           .catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
  }

  // 再度上限チェック
  const currentPCount = recruitment.participants.length;
  if (currentPCount + count > 6) {
      return await interaction.update({ content: `エラー: テスト参加者を${count}名追加すると上限(6名)を超えてしまいます。(現在${currentPCount}名)`, embeds: [], components: [], ephemeral: true })
              .catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });
  }

  const addedParticipants = [];
  for (let i = 0; i < count; i++) {
    const testUserId = `test-${Date.now()}-${i}-${Math.random().toString(36).substring(2, 5)}`;
    const testUsername = generateTestParticipantName(recruitment.participants.length + i + 1);

    let joinType;
    if (recruitment.type === '参加者希望') {
      const types = ['天元', 'ルシゼロ', 'なんでも可'];
      joinType = types[Math.floor(Math.random() * types.length)];
    } else { joinType = recruitment.type; }

    const testParticipant = {
      userId: testUserId, username: testUsername, joinType: joinType,
      attributes: getRandomAttributes(), timeAvailability: getRandomTimeAvailability(),
      remarks: '', assignedAttribute: null, isTestParticipant: true
    };
    recruitment.participants.push(testParticipant);
    testMode.testParticipants.push(testParticipant);
    addedParticipants.push(testParticipant);
  }

  try {
    // 募集メッセージの更新
    await updateRecruitmentMessage(recruitment);

    // 参加者が6人になった場合の自動割り振りプレビュー
    let autoAssignTriggered = false;
    if (recruitment.participants.length === 6 && recruitment.status === 'active') {
      await autoAssignAttributes(recruitment, true); // プレビュー
      await updateRecruitmentMessage(recruitment); // プレビュー結果反映
      autoAssignTriggered = true;
    }

    // 完了メッセージ
    await interaction.update({ // update を使う (ボタン応答)
      content: `✅ ${addedParticipants.length} 名のテスト参加者を追加しました。\n現在の参加者: ${recruitment.participants.length} / 6 名` +
        (autoAssignTriggered ? '\n\n参加者が6名になったため、自動割り振りを**プレビュー表示**しました。' : ''),
      embeds: [],
      components: [] // ボタン消去
    }).catch(e => { if(e.code !== 10062) console.error("Update Error:", e) });

    debugLog('TestMode', `${interaction.user.tag} が募集ID ${recruitmentId} に ${addedParticipants.length} 名のテスト参加者を追加 (ボタン)`);
    saveRecruitmentData(); // データ保存

  } catch (error) {
    console.error(`テスト参加者追加確定エラー:`, error);
    await interaction.followUp({ // update後のエラーは followUp
        content: 'テスト参加者の追加処理中にエラーが発生しました。',
        ephemeral: true
    }).catch(()=>{});
  }
}


//==========================================================================
// Expressサーバー (Keep-alive用)
//==========================================================================
const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000; // Renderが指定するポート or デフォルト

// ルートパス
app.get('/', (req, res) => {
  res.status(200).send('Discord Bot is Active!');
});

// 健康状態チェック用エンドポイント
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'up',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    discordClientStatus: client.ws.status, // 0:READY, 1:CONNECTING, ...
    activeRecruitments: activeRecruitments.size,
    memoryUsage: process.memoryUsage()
  });
});

// シンプルなpingエンドポイント (UptimeRobot等向け)
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// その他の未定義ルートへのアクセス
app.use((req, res) => {
  res.status(404).send('Not Found');
});

// Expressエラーハンドリング
app.use((err, req, res, next) => {
  console.error('Expressサーバーエラー:', err);
  res.status(500).send('Internal Server Error');
});

// サーバーを起動
app.listen(PORT, () => {
  console.log(`監視用HTTPサーバーがポート ${PORT} で起動しました。`);
});


//==========================================================================
// プロセス監視とグレースフルシャットダウン
//==========================================================================

// 未処理の例外をキャッチ
process.on('uncaughtException', (err, origin) => {
  console.error('致命的な未処理例外:', origin, err);
  // エラー発生時にデータを保存試行
  console.log('データを保存試行...');
  saveRecruitmentData();
  // 深刻なエラーなので、少し待ってからプロセスを終了させる
  setTimeout(() => {
    console.log('安全なシャットダウンを実行します...');
    process.exit(1); // エラー終了
  }, 2000); // 2秒待つ
});

// プロセス終了シグナルをハンドリング
const shutdown = (signal) => {
  console.log(`${signal} を受信しました。グレースフルシャットダウンを開始します...`);
  // 終了前にデータを保存
  saveRecruitmentData();
  // Discordクライアントを破棄
  client.destroy();
  console.log('Discordクライアントを停止しました。');
  // 他のクリーンアップ処理があればここに追加
  // プロセス終了
  setTimeout(() => {
      console.log("シャットダウン完了。");
      process.exit(0); // 正常終了
  }, 1500); // 少し待つ
};

process.on('SIGTERM', () => shutdown('SIGTERM')); // Renderなどからの終了シグナル
process.on('SIGINT', () => shutdown('SIGINT')); // Ctrl+C

// 定期的な自己ヘルスチェック (メモリ監視)
setInterval(() => {
  try {
    const memoryUsage = process.memoryUsage();
    const usedMemoryMB = Math.round(memoryUsage.rss / 1024 / 1024);
    debugLog('HealthCheck', `メモリ使用量: ${usedMemoryMB}MB`);

    // メモリ使用量が閾値を超えたら警告/再起動
    const MEMORY_LIMIT_MB = 450; // 例: 450MB (Renderの無料枠は約512MB)
    if (usedMemoryMB > MEMORY_LIMIT_MB) {
      console.warn(`メモリ使用量が閾値 (${MEMORY_LIMIT_MB}MB) を超えました: ${usedMemoryMB}MB`);
      console.log('データを保存して安全な再起動を試みます...');
      shutdown('MemoryLimit'); // グレースフルシャットダウンを実行
    }
  } catch (error) {
    console.error('自己ヘルスチェックエラー:', error);
  }
}, 10 * 60 * 1000); // 10分ごと

//==========================================================================
// Discord Bot ログイン
//==========================================================================
client.login(process.env.TOKEN)
  .then(() => {
    console.log('Discord Botが正常にログインしました。');
  })
  .catch(error => {
    console.error('!!! Discord Botログインエラー !!!:', error);
    // ログイン失敗は致命的なのでプロセスを終了させる
    process.exit(1);
  });