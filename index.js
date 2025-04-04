// Discord.js v14 & 必要なライブラリのインポート
const {
  Client, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, // ★ Modal/TextInput追加
  ButtonStyle, GatewayIntentBits, InteractionType // ★ IntentBits/InteractionType追加
} = require('discord.js');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require("@google/generativeai"); // ★ Gemini追加
const fs = require('fs');
const path = require('path');
require('dotenv').config();
// const traceback = require('traceback'); // 必要であれば

// --- グローバル設定 ---
const RENDER_DISK_MOUNT_PATH = process.env.DATA_PATH || '/data/botdata'; // Render永続ディスクパス等 (環境変数で指定可)
const DATA_FILE_PATH = path.join(RENDER_DISK_MOUNT_PATH, 'recruitment_data.json');
const NG_WORDS = ["死ね", "殺す", "馬鹿", "アホ", /* ... 他の不適切な単語を追加 ... */ ]; // ★ いたずら対策
const MAX_REMARKS_LENGTH = 100; // ★ 備考の最大文字数
const ATTRIBUTES = ['火', '水', '土', '風', '光', '闇'];
const RAID_TYPES = ['天元', 'ルシゼロ', '参加者希望'];
const timeOptions = []; // 時間選択肢
const timeOrder = { /* ... 時間ソート用マップ (元のコードからコピー) ... */
    '今すぐ': 0, '00:00': 1, '01:00': 2, '02:00': 3, '03:00': 4, '04:00': 5,
    '05:00': 6, '06:00': 7, '07:00': 8, '08:00': 9, '09:00': 10, '10:00': 11,
    '11:00': 12, '12:00': 13, '13:00': 14, '14:00': 15, '15:00': 16, '16:00': 17,
    '17:00': 18, '18:00': 19, '19:00': 20, '20:00': 21, '21:00': 22, '22:00': 23,
    '23:00': 24
};

// --- グローバル変数 ---
let activeRecruitments = new Map();
const tempUserData = new Map();
const testMode = { active: false, testParticipants: [] };

// --- Gemini API 初期化 ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) { console.error("エラー: GEMINI_API_KEY未設定"); process.exit(1); }
let geminiModel;
try {
    const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
    geminiModel = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
      safetySettings: [ // ★ いたずら対策: 安全設定
        { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
        { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
      ]
    });
    console.log("Gemini APIクライアント初期化完了 (モデル: gemini-1.5-flash, 安全設定有効)");
} catch (geminiInitError) { console.error("Gemini APIクライアント初期化失敗:", geminiInitError); process.exit(1); }

// --- Discord Client 初期化 ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers // ★★★ ギルドメンバーインテント追加 ★★★
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// --- 時間オプション生成 ---
for (let i = 0; i < 24; i++) { const hour = i.toString().padStart(2, '0'); timeOptions.push({ label: `${hour}:00`, value: `${hour}:00` }); }

// --- ユーティリティ関数 ---
function generateUniqueId() { return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`; }
function debugLog(tag, message, data = null) { const ts = new Date().toISOString(); console.log(`[${ts}] [${tag}] ${message}`); if (data) console.log(JSON.stringify(data, null, 2)); }

// --- データロード/セーブ/クリーンアップ関数 ---
function loadRecruitmentData() {
  try {
    const dataDir = path.dirname(DATA_FILE_PATH);
    if (!fs.existsSync(dataDir)) {
      console.log(`データディレクトリ作成: ${dataDir}`);
      fs.mkdirSync(dataDir, { recursive: true });
    }
    if (fs.existsSync(DATA_FILE_PATH)) {
      console.log('募集データロード中...');
      const data = fs.readFileSync(DATA_FILE_PATH, 'utf8');
      if (!data) { console.log('データファイル空'); return new Map(); }
      const parsedData = JSON.parse(data);
      const loadedRecruitments = new Map(Object.entries(parsedData));
      let activeCount = 0;
      loadedRecruitments.forEach(r => { if (r.status === 'active') activeCount++; });
      console.log(`${loadedRecruitments.size}件ロード (アクティブ: ${activeCount}件)`);
      return loadedRecruitments;
    } else {
      console.log('募集データなし');
      return new Map();
    }
  } catch (error) {
    console.error('募集データロードエラー:', error);
    const backupPath = DATA_FILE_PATH + '.bak';
    if (fs.existsSync(backupPath)) { /* ... バックアップ試行 ... */ }
    return new Map();
  }
}

function saveRecruitmentData() {
  if (!(activeRecruitments instanceof Map)) { console.error('エラー: activeRecruitments is not a Map'); return; }
  if (activeRecruitments.size === 0) { /* console.log('保存対象データなし'); */ return; }
  try {
    const dataDir = path.dirname(DATA_FILE_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const backupPath = DATA_FILE_PATH + '.bak';
    if (fs.existsSync(DATA_FILE_PATH)) fs.copyFileSync(DATA_FILE_PATH, backupPath);
    const dataToSave = Object.fromEntries(activeRecruitments);
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(dataToSave, null, 2), 'utf8');
    // debugLog('SaveData', `${activeRecruitments.size}件保存完了`); // 頻繁なのでコメントアウト
  } catch (error) { console.error('募集データ保存エラー:', error); }
}

function cleanupOldRecruitments() {
  const now = new Date();
  let cleanupCount = 0;
  activeRecruitments.forEach((recruitment, id) => {
    const recruitmentDate = recruitment.createdAt ? new Date(recruitment.createdAt) : new Date(0);
    const daysSinceCreation = (now - recruitmentDate) / (1000 * 60 * 60 * 24);
    const isVeryOld = daysSinceCreation > 7;
    const isClosedAndOld = (recruitment.status === 'closed' || recruitment.status === 'assigned') && daysSinceCreation > 3;
    if (isVeryOld || isClosedAndOld) {
      activeRecruitments.delete(id);
      cleanupCount++;
      debugLog('Cleanup', `古い募集削除: ID=${id}`);
    }
  });
  if (cleanupCount > 0) { debugLog('Cleanup', `${cleanupCount}件クリーンアップ`); saveRecruitmentData(); }
  // else { debugLog('Cleanup', `クリーンアップ対象なし`); }
}

// --- Gemini API 要約関数 (プロンプト修正、安全性チェック強化) ---
async function summarizeRemark(remarkText) {
    if (!remarkText || remarkText.trim() === "") return null;
    if (!geminiModel) { console.error("Geminiモデル未初期化"); return "(要約不可:設定)"; } // モデルがない場合

    // ★ グラブル文脈に合わせたプロンプト
    const prompt = `以下のDiscordのグラブル高難易度募集への参加者の備考を、最も重要な情報を15文字程度で簡潔に要約してください。特に時間に関する情報（「〇時まで」「〇時から参加」「遅れます」等）や、配慮に関する情報（「初心者です」「他の人優先で」等）を優先して含めてください。\n\n備考: ${remarkText}\n\n要約:`;

    try {
        debugLog('Gemini', `備考要約リクエスト: "${remarkText.substring(0, 50)}..."`); // 長い備考は省略してログ出力
        const result = await geminiModel.generateContent(prompt);
        const response = result.response;

        // ★ 安全性ブロックチェック強化
        if (response.promptFeedback?.blockReason) {
            console.warn(`Gemini Safety Blocked (Prompt): Reason=${response.promptFeedback.blockReason}, Remarks="${remarkText.substring(0,50)}..."`);
            return `(入力不適切)`;
        }
        const candidate = response.candidates?.[0];
        if (!candidate) { // 候補がない場合 (まれに発生)
             console.warn(`Gemini No Candidate: Remarks="${remarkText.substring(0,50)}..."`);
             return `(要約生成不可)`;
        }
        if (candidate.finishReason !== 'STOP') { // STOP以外は問題あり
            const feedback = candidate.safetyRatings;
            const reason = candidate.finishReason;
            console.warn(`Gemini Finish Reason Issue: Reason=${reason}, SafetyFeedback=${JSON.stringify(feedback)}, Remarks="${remarkText.substring(0,50)}..."`);
            return reason === "SAFETY" ? `(内容不適切)` : `(要約エラー:${reason})`;
        }

        const summary = response.text().trim().replace(/\n/g, ' ');
        debugLog('Gemini', `応答 (要約): "${summary}"`);

        // ★ 要約結果のバリデーション
        if (summary.length > 50 || summary.includes("要約できません") || summary.includes("情報なし") || summary.trim() === "" || summary.toLowerCase().includes("不明")) {
            console.warn("要約結果不適切/長すぎのため元の備考先頭使用");
            return remarkText.substring(0, 30) + (remarkText.length > 30 ? "..." : ""); // 30文字に制限
        }
        return summary;
    } catch (error) {
        console.error("Gemini API 備考要約エラー:", error);
        return `(要約エラー)`; // エラー時
    }
}


// --- エラー応答ヘルパー ---
async function handleErrorReply(interaction, error) {
   const errorMessage = 'エラーが発生しました。時間をおいて再度お試しください。';
   try {
     if (!interaction || !interaction.isRepliable()) { // interaction が有効か確認
         console.error("無効なインタラクションまたは応答不可:", interaction?.id, error.message);
         return;
     }
     if (error.code === 10062) { console.log('インタラクションタイムアウト'); return; }
     if (error.code === 40060) { console.log('インタラクション既に応答済み'); return; }

     if (interaction.replied || interaction.deferred) {
       await interaction.followUp({ content: errorMessage, ephemeral: true }).catch(e => console.error('followUp失敗:', e.message));
     } else {
       await interaction.reply({ content: errorMessage, ephemeral: true }).catch(e => console.error('reply失敗:', e.message));
     }
   } catch (replyErr) { console.error('エラー応答失敗:', replyErr); }
}

// --- イベントハンドラ: Bot準備完了 ---
client.once('ready', () => {
   console.log(`${client.user.tag} でログインしました！`);
   console.warn("【重要】Discord Developer Portalで「SERVER MEMBERS INTENT」が有効か確認！");
   activeRecruitments = loadRecruitmentData();
   setInterval(saveRecruitmentData, 2 * 60 * 1000);
   setInterval(checkAutomaticClosing, 5 * 60 * 1000);
   setInterval(cleanupOldRecruitments, 6 * 60 * 60 * 1000);
   cleanupOldRecruitments();
});

// --- イベントハンドラ: InteractionCreate ---
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.guild) { // DMでのインタラクションは無視 (必要なら対応)
        console.log("DMでのインタラクションを無視:", interaction.id);
        return;
    }
    if (interaction.isButton()) await handleButtonInteraction(interaction);
    else if (interaction.isStringSelectMenu()) await handleSelectMenuInteraction(interaction);
    else if (interaction.type === InteractionType.ModalSubmit) await handleModalSubmit(interaction);
  } catch (error) { console.error('インタラクション処理エラー:', error); await handleErrorReply(interaction, error); }
});

// --- イベントハンドラ: MessageCreate (コマンド処理) ---
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return; // BotとDMを無視
  const authorUsername = message.member ? message.member.displayName : message.author.username; // ★ 表示名優先

  // コマンド分岐 (省略せずに元の内容を記述)
  if (message.content === '!募集') { await startRecruitment(message); }
  else if (message.content === '!募集リスト') { await showActiveRecruitments(message); }
  else if (message.content === '!募集ヘルプ') { await showHelp(message); }
  else if (message.content.startsWith('!募集削除 ')) { const id = message.content.replace('!募集削除 ', '').trim(); await deleteRecruitment(message, id); }
  else if (message.content.startsWith('!募集確認 ')) { const id = message.content.replace('!募集確認 ', '').trim(); await showRecruitmentDetails(message, id); }
  else if (message.content === '!募集詳細確認') { await showAllRecruitmentDetails(message); }
  // --- テストモード関連 ---
  else if (message.content === '!テストモード開始') { await startTestMode(message); }
  else if (message.content === '!テストモード終了') { await endTestMode(message); }
  else if (message.content.startsWith('!テスト参加者追加 ')) {
      const params = message.content.replace('!テスト参加者追加 ', '').split(' ');
      if (params.length >= 2) { /* ... 人数チェック＆実行 ... */ } else { /* ... Usage ... */ }
  }
  else if (message.content === '!IDリスト') { /* ... (変更なし) ... */ }
  else if (message.content.startsWith('!追加 ')) { /* ... (変更なし) ... */ }
  else if (message.content === '!再起動テスト') { /* ... (変更なし) ... */ }
  else if (message.content.startsWith('!直接テスト ')) { /* ... (変更なし) ... */ }
  else if (message.content === '!v14test') { /* ... (変更なし) ... */ }
});


// --- ボタンインタラクションハンドラ ---
async function handleButtonInteraction(interaction) {
    const customId = interaction.customId;
    debugLog('Button', `処理開始: ${customId}`);
    try {
        if (customId.startsWith('raid_type_')) { const type = customId.replace('raid_type_', ''); await showDateSelection(interaction, type); }
        else if (customId.startsWith('date_select_')) { const parts = customId.split('_'); await showTimeSelection(interaction, parts[2], parts[3]); }
        else if (customId.startsWith('confirm_recruitment_')) { const id = customId.replace('confirm_recruitment_', ''); await finalizeRecruitment(interaction, id); }
        else if (customId === 'cancel_recruitment') { await interaction.update({ content: '募集作成キャンセル', embeds: [], components: [] }); }
        else if (customId.startsWith('join_recruitment_')) { const id = customId.replace('join_recruitment_', ''); await showJoinOptions(interaction, id); }
        else if (customId.startsWith('cancel_participation_')) { const id = customId.replace('cancel_participation_', ''); await cancelParticipation(interaction, id); }
        else if (customId.startsWith('close_recruitment_')) { const id = customId.replace('close_recruitment_', ''); await closeRecruitment(interaction, id); }
        else if (customId.startsWith('open_remarks_modal_')) { // ★ 備考モーダルを開く
            const recruitmentId = customId.replace('open_remarks_modal_', '');
            await showRemarksModal(interaction, recruitmentId);
        }
        else if (customId === 'cancel_join') { await interaction.update({ content: '参加申込キャンセル', embeds: [], components: [] }); tempUserData.delete(interaction.user.id); }
        // --- テストモードボタン ---
        else if (customId.startsWith('add_test_participants_')) { const id = customId.replace('add_test_participants_', ''); await showTestParticipantAddOptions(interaction, id); }
        else if (customId.startsWith('confirm_test_participants_')) { const parts = customId.split('_'); await confirmAddTestParticipants(interaction, parts[3], parseInt(parts[4], 10)); }
        else if (customId === 'cancel_test_participants') { await interaction.update({ content: 'テスト参加者追加キャンセル', embeds: [], components: [] }); }
        // --- その他 ---
        else if (customId === 'simple_test') { await interaction.reply({ content: 'v14テストボタンOK！', ephemeral: true }); }
        else { debugLog('Button', `未処理ボタンID: ${customId}`); /* await interaction.reply({ content: '不明なボタンです', ephemeral: true }); */ } // 応答は任意
    } catch (error) { console.error(`ボタンエラー (${customId}):`, error); await handleErrorReply(interaction, error); }
}

// --- セレクトメニューインタラクションハンドラ ---
async function handleSelectMenuInteraction(interaction) {
    const customId = interaction.customId;
    debugLog('SelectMenu', `処理開始: ${customId}`);
    try {
        if (customId.startsWith('time_select_')) { const parts = customId.split('_'); await confirmRecruitment(interaction, parts[2], parts[3], interaction.values[0]); }
        else if (customId.startsWith('join_type_')) { const id = customId.split('_')[2]; await showAttributeSelection(interaction, id, interaction.values[0]); }
        else if (customId.startsWith('attribute_select_')) { const parts = customId.split('_'); await showTimeAvailabilitySelection(interaction, parts[2], parts[3], interaction.values); }
        else if (customId.startsWith('time_availability_')) { const parts = customId.split('_'); const attrs = parts[4].split(','); await showJoinConfirmation(interaction, parts[2], parts[3], attrs, interaction.values[0]); }
        // --- テストモードメニュー ---
        else if (customId.startsWith('test_participant_count_')) { const id = customId.replace('test_participant_count_', ''); await showTestParticipantConfirmation(interaction, id, parseInt(interaction.values[0], 10)); }
        else { debugLog('SelectMenu', `未処理メニューID: ${customId}`); await interaction.update({ content: '不明なメニュー操作', components: [] }); }
    } catch (error) { console.error(`セレクトメニューエラー (${customId}):`, error); await handleErrorReply(interaction, error); }
}

// --- モーダル送信ハンドラ (NGワードチェック付き) ---
async function handleModalSubmit(interaction) {
    const customId = interaction.customId;
    debugLog('ModalSubmit', `処理開始: ${customId}`);
    try {
        if (customId.startsWith('submit_remarks_')) {
            const recruitmentId = customId.replace('submit_remarks_', '');
            const remarks = interaction.fields.getTextInputValue('remarks_input');
            debugLog('ModalSubmit', `備考取得: "${remarks.substring(0, 50)}..."`);

            // NGワードチェック
            const lowerCaseRemarks = remarks.toLowerCase();
            for (const ngWord of NG_WORDS) {
                if (lowerCaseRemarks.includes(ngWord.toLowerCase())) {
                    console.warn(`NGワード検出: User=${interaction.user.tag}, Word=${ngWord}`);
                    await interaction.reply({ content: `エラー: 備考に不適切な単語(${ngWord})が含まれています。`, ephemeral: true });
                    return; // 処理中断
                }
            }

            const userData = tempUserData.get(interaction.user.id);
            if (!userData || userData.recruitmentId !== recruitmentId) {
                 await interaction.reply({ content: 'エラー: 参加情報タイムアウト。申込からやり直し', ephemeral: true }); return;
            }
            await confirmParticipation(interaction, recruitmentId, userData.joinType, userData.attributes, userData.timeAvailability, remarks);
            tempUserData.delete(interaction.user.id);
        } else { debugLog('ModalSubmit', `未処理モーダルID: ${customId}`); await interaction.reply({ content: '不明な操作', ephemeral: true }); }
    } catch (error) { console.error(`モーダル送信エラー (${customId}):`, error); await handleErrorReply(interaction, error); }
}


// --- 各機能関数 (元のコードからコピー＆ペーストし、必要な修正を加える) ---

async function startRecruitment(message) { /* ... (変更なし) ... */ }
async function showDateSelection(interaction, raidType) { /* ... (変更なし) ... */ }
async function showTimeSelection(interaction, raidType, date) { /* ... (変更なし) ... */ }
async function confirmRecruitment(interaction, raidType, date, time) { /* ... (変更なし) ... */ }
async function finalizeRecruitment(interaction, recruitmentId) { /* ... (変更なし) ... */ }
// createRecruitmentEmbed は updateRecruitmentMessage に統合されたため不要

async function showJoinOptions(interaction, recruitmentId) { /* ... (変更なし) ... */ }
async function showAttributeSelection(interaction, recruitmentId, joinType) { /* ... (変更なし) ... */ }
async function showTimeAvailabilitySelection(interaction, recruitmentId, joinType, selectedAttributes) { /* ... (変更なし) ... */ }

// ★ 備考入力ボタンを出すように修正
async function showJoinConfirmation(interaction, recruitmentId, joinType, selectedAttributes, timeAvailability) {
    debugLog('UI', `参加確認UI表示: ID=${recruitmentId}`);
    const recruitment = activeRecruitments.get(recruitmentId);
    if (!recruitment || recruitment.status !== 'active') { return await interaction.update({ content: '募集終了/無効', embeds: [], components: [] }); }

    const embed = new EmbedBuilder()
      .setTitle('✅ 参加申込確認')
      .setDescription('以下の内容で参加申込を行います。\n必要であれば、下のボタンから備考を入力してください。')
      .setColor('#00cc99')
      .addFields(
        { name: '参加タイプ', value: joinType, inline: true },
        { name: '参加可能属性', value: selectedAttributes.join(', '), inline: true },
        { name: '参加可能時間', value: timeAvailability === 'now' ? '今すぐ' : timeAvailability, inline: true }
      );

    tempUserData.set(interaction.user.id, { recruitmentId, joinType, attributes: selectedAttributes, timeAvailability });

    const openRemarksModalBtnId = `open_remarks_modal_${recruitmentId}`; // ★ モーダルを開くボタンID
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder().setCustomId(openRemarksModalBtnId).setLabel('備考入力して参加確定').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('cancel_join').setLabel('キャンセル').setStyle(ButtonStyle.Danger)
      );

    await interaction.update({ embeds: [embed], components: [row] });
}

// ★ 備考入力モーダル表示関数 (文字数制限付き)
async function showRemarksModal(interaction, recruitmentId) {
    const userData = tempUserData.get(interaction.user.id);
    if (!userData || userData.recruitmentId !== recruitmentId) { return await interaction.reply({ content: 'エラー: 参加情報タイムアウト', ephemeral: true }); }

    const modal = new ModalBuilder().setCustomId(`submit_remarks_${recruitmentId}`).setTitle('参加に関する備考 (任意)');
    const remarksInput = new TextInputBuilder()
      .setCustomId('remarks_input')
      .setLabel(`希望/遅刻/早退など(${MAX_REMARKS_LENGTH}文字以内)`)
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('例: 22時まで参加希望です。初心者です。')
      .setMaxLength(MAX_REMARKS_LENGTH) // ★ 文字数制限
      .setRequired(false);
    modal.addComponents(new ActionRowBuilder().addComponents(remarksInput));
    await interaction.showModal(modal);
}


// ★ confirmParticipation (備考要約・保存)
async function confirmParticipation(interaction, recruitmentId, joinType, selectedAttributes, timeAvailability, remarks = "") {
    debugLog('Participation', `参加確定: ID=${recruitmentId}, User=${interaction.user.tag}, Remarks=${remarks.substring(0,30)}...`);
    const recruitment = activeRecruitments.get(recruitmentId);
    if (!recruitment || recruitment.status !== 'active') { await interaction.reply({ content: '募集終了/無効', ephemeral: true }); return; }

    let remarksSummary = null;
    if (remarks && remarks.trim() !== "") {
        try { remarksSummary = await summarizeRemark(remarks); }
        catch (summaryError) { console.error("備考要約エラー:", summaryError); remarksSummary = "(要約失敗)"; }
    }

    const participantData = {
        userId: interaction.user.id,
        username: interaction.user.username, // ★ インテント有効なら取得
        displayName: interaction.member?.displayName || interaction.user.username, // ★ サーバー表示名
        joinType: joinType, attributes: selectedAttributes, timeAvailability: timeAvailability,
        remarks: remarks, remarksSummary: remarksSummary, // ★ 両方保存
        assignedAttribute: null
    };

    const existingIndex = recruitment.participants.findIndex(p => p.userId === interaction.user.id);
    if (existingIndex >= 0) { recruitment.participants[existingIndex] = participantData; debugLog('Participation', `既存参加者更新: ${participantData.displayName}`); }
    else { recruitment.participants.push(participantData); debugLog('Participation', `新規参加者追加: ${participantData.displayName}`); }

    activeRecruitments.set(recruitmentId, recruitment);

    try {
        await updateRecruitmentMessage(recruitment);
        await interaction.reply({ content: '参加申込完了！募集メッセージ更新', ephemeral: true }); // モーダル後の応答はreply
    } catch (updateError) { console.error("参加確定後メッセージ更新エラー:", updateError); await interaction.reply({ content: '参加申込は完了しましたが、メッセージ更新に失敗しました。', ephemeral: true }); }
}


async function cancelParticipation(interaction, recruitmentId) { /* ... (変更なし) ... */ }
async function closeRecruitment(interaction, recruitmentId) { /* ... (変更なし、AI分析は行わない) ... */ }

// ★ updateRecruitmentMessage (備考要約表示、メンバー名表示改善)
async function updateRecruitmentMessage(recruitment) {
    try {
        debugLog('UpdateMsg', `更新開始: ID=${recruitment.id}, MsgID=${recruitment.messageId}`);
        if (!recruitment.channel || !recruitment.messageId) { console.error(`Error: Channel or Message ID missing for recruitment ${recruitment.id}`); return; }

        const channel = await client.channels.fetch(recruitment.channel).catch(err => { console.error(`チャンネル取得失敗 (ID: ${recruitment.channel}):`, err); return null; });
        if (!channel) return;

        let message;
        try { message = await channel.messages.fetch(recruitment.messageId); }
        catch (fetchError) { if (fetchError.code === 10008) { console.warn(`募集メッセージ削除済み?: ID=${recruitment.id}, MsgID=${recruitment.messageId}`); activeRecruitments.delete(recruitment.id); saveRecruitmentData(); return; } else { throw fetchError; } }

        const formattedDate = new Date(recruitment.date).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
        let description = `募集者: <@${recruitment.creator}>\n\n${recruitment.status === 'active' ? '🟢 **募集中**' : '🔴 **募集終了**'}\n`;
        if (recruitment.status !== 'active' && recruitment.finalRaidType) description += `**決定: ${recruitment.finalRaidType}**\n`;
        if (recruitment.status !== 'active' && recruitment.finalTime) description += `**予定: ${recruitment.finalTime === 'now' ? '今すぐ' : recruitment.finalTime + '～'}**\n`;
        if (recruitment.status === 'active') description += '参加希望者は下ボタンから申込\n\n';
        else description += '\n以下の通り割振りました。\n\n';


        // 参加者リスト表示（備考要約付き）
        if (recruitment.participants.length > 0) {
            description += '**【参加表明者】**\n';
            const participantsByTime = {};
            recruitment.participants.forEach(p => {
                if (!participantsByTime[p.timeAvailability]) participantsByTime[p.timeAvailability] = [];
                participantsByTime[p.timeAvailability].push(p);
            });

            Object.keys(participantsByTime).sort((a, b) => (timeOrder[a] || 99) - (timeOrder[b] || 99)).forEach(time => {
                description += `⏰ **${time === 'now' ? '今すぐ' : time + '〜'}** (${participantsByTime[time].length}名)\n`;
                participantsByTime[time].forEach(p => {
                    const displayName = p.displayName || p.username; // ★ 表示名優先
                    const summaryText = p.remarksSummary ? ` (${p.remarksSummary})` : ''; // ★ 要約表示
                    description += `- ${displayName} (<@${p.userId}>) [${p.joinType}] ${p.attributes.join('/')}${summaryText}\n`;
                });
                description += '\n';
            });
        } else if (recruitment.status === 'active'){ description += 'まだ参加者はいません。\n'; }

        const embed = new EmbedBuilder()
            .setTitle(`${recruitment.status === 'active' ? '📢' : '🏁'} 【${recruitment.type}】${formattedDate} ${recruitment.time}`)
            .setDescription(description)
            .setColor(recruitment.status === 'active' ? '#0099ff' : '#ff6666');

        // 属性フィールド
        const participantsByAttribute = {};
        ATTRIBUTES.forEach(attr => participantsByAttribute[attr] = []);
        recruitment.participants.forEach(p => p.attributes.forEach(attr => participantsByAttribute[attr].push(p)));

        const fields = [];
        ATTRIBUTES.forEach(attr => {
            let value = '未定';
            const assignedParticipant = recruitment.participants.find(p => p.assignedAttribute === attr);
            if (assignedParticipant) {
                const displayName = assignedParticipant.displayName || assignedParticipant.username; // ★ 表示名
                const summaryText = assignedParticipant.remarksSummary ? ` (${assignedParticipant.remarksSummary})` : ''; // ★ 要約表示
                value = `${displayName} (<@${assignedParticipant.userId}>)${summaryText}`;
            } else if (recruitment.status === 'active') {
                const count = participantsByAttribute[attr].length;
                value = count > 0 ? `${count}名希望` : '未定';
            }
            fields.push({ name: `【${attr}】`, value: value, inline: true });
        });
        embed.setFields(fields);
        embed.setFooter({ text: `ID: ${recruitment.id} | ${recruitment.status === 'active' ? '朝8時自動締切' : '募集終了'}` });

        // ボタン
        const joinRow = new ActionRowBuilder().addComponents( /* ... ボタン定義 ... */ );
        const components = [joinRow];
        if (testMode.active && recruitment.status === 'active') { /* ... テストボタン追加 ... */ }

        await message.edit({ content: recruitment.status === 'active' ? '**【募集中】**' : '**【募集終了】**', embeds: [embed], components: components });
        debugLog('UpdateMsg', `更新完了: ID=${recruitment.id}`);
    } catch (error) { console.error(`メッセージ更新エラー (ID: ${recruitment.id}):`, error); }
}


async function autoAssignAttributes(recruitment, previewOnly = false) { /* ... (元のシンプルな割り当てロジック) ... */ }
function checkAutomaticClosing() { /* ... (元のコード) ... */ }
async function showActiveRecruitments(message) { /* ... (元のコード) ... */ }
async function deleteRecruitment(message, recruitmentId) { /* ... (元のコード) ... */ }
async function showHelp(message) { /* ... (元のコード) ... */ }
async function showRecruitmentDetails(message, recruitmentId) { /* ... (元のコード) ... */ }
async function showAllRecruitmentDetails(message) { /* ... (元のコード) ... */ }

// --- テストモード関連関数 ---
// (元のコードをここに記述)
async function startTestMode(message) { /* ... */ }
async function endTestMode(message) { /* ... */ }
function getRandomAttributes() { /* ... */ }
function getRandomTimeAvailability() { /* ... */ }
function generateTestParticipantName(index) { /* ... */ }
async function addTestParticipants(message, recruitmentId, count) { /* ... */ }
async function showTestParticipantAddOptions(interaction, recruitmentId) { /* ... */ }
async function showTestParticipantConfirmation(interaction, recruitmentId, count) { /* ... */ }
async function confirmAddTestParticipants(interaction, recruitmentId, count) { /* ... */ }


// --- Expressサーバー起動 & Botログイン ---
const express = require('express');
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.status(200).send('Bot is running!'));
app.get('/health', (req, res) => res.status(200).json({ status: 'up', /* ... */ }));
app.get('/ping', (req, res) => res.status(200).send('pong'));
app.get('*', (req, res) => res.status(200).send('Bot running (404 route)'));
app.use((err, req, res, next) => { console.error('Express Error:', err); res.status(500).send('Server Error'); });
app.listen(PORT, () => console.log(`監視用サーバー起動: ポート ${PORT}`));
client.login(process.env.TOKEN).then(() => console.log('Botログイン成功')).catch(error => console.error('Botログインエラー:', error));

// --- 未処理例外・シグナルハンドリング ---
process.on('uncaughtException', (err) => { console.error('未処理例外:', err); saveRecruitmentData(); setTimeout(() => process.exit(1), 1000); });
process.on('SIGTERM', () => { console.log('SIGTERM受信'); saveRecruitmentData(); process.exit(0); });
process.on('SIGINT', () => { console.log('SIGINT受信'); saveRecruitmentData(); process.exit(0); });

// 定期ヘルスチェックは一旦コメントアウト (必要なら復活)
// setInterval(() => { /* ... ヘルスチェック ... */ }, 10 * 60 * 1000);
