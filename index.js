require("dotenv").config();

const express = require("express");
const {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");

const GAS_WEB_APP_URL     = process.env.GAS_WEB_APP_URL;
const PORT                = Number(process.env.PORT || 3000);
const ANNOUNCE_CHANNEL_ID = process.env.ANNOUNCE_CHANNEL_ID || "";
const announcedGroups     = new Set();
const announceMessageIds  = new Map();
const translationStarted  = new Set();
const startedRows         = new Set();

if (!process.env.BOT_TOKEN) throw new Error("환경변수 BOT_TOKEN이 비어 있습니다.");
if (!GAS_WEB_APP_URL)       throw new Error("환경변수 GAS_WEB_APP_URL이 비어 있습니다.");

const app = express();
app.use(express.json({ limit: "1mb" }));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const LANG_DISPLAY = {
  ko: "한국어", ja: "일본어", en: "영어",
  cn: "중국어(간체)", zh: "대만어",
  es: "스페인어", fr: "프랑스어", de: "독일어",
  id: "인도네시아어", th: "태국어", vi: "베트남어", ru: "러시아어",
};
function displayLang(code) {
  if (!code) return "-";
  return LANG_DISPLAY[code] || code;
}

function log(...args) {
  console.log(new Date().toISOString(), "[BOT]", ...args);
}

async function postToGas(payload, retriesLeft = 1) {
  const controller = new AbortController();
  const tid        = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(GAS_WEB_APP_URL, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(payload),
      signal : controller.signal,
    });
    clearTimeout(tid);
    const text = await res.text().catch(() => "");
    if (!res.ok) throw new Error(`GAS HTTP ${res.status}`);
    log(`GAS OK row_id=${payload.row_id} action=${payload.action} status=${res.status}`);
    return text;
  } catch (e) {
    clearTimeout(tid);
    const isAbort = e.name === "AbortError";
    if (retriesLeft > 0) {
      log(`GAS 재시도 (${isAbort ? "타임아웃" : e.message}) row_id=${payload.row_id}`);
      await new Promise((r) => setTimeout(r, 2000));
      return postToGas(payload, retriesLeft - 1);
    }
    throw e;
  }
}

function parseCustomId(customId) {
  const str = String(customId);
  const idx = str.indexOf(":");
  if (idx === -1) return { action: str, rowId: "" };
  return { action: str.slice(0, idx), rowId: str.slice(idx + 1) };
}

function makeId(action, rowId) { return `${action}:${rowId}`; }

const STAGE_FOOTER = {
  ACK             : "수락 / 거절 버튼으로 응답해 주세요.",
  KO_WORKER_WAIT  : "작업 준비가 되면 [시작] 버튼을 눌러주세요.",
  KO_QA_WAIT      : "원어 자막 작업이 완료되면 다시 안내드리겠습니다.",
  LANG_WORKER_WAIT: "원어 자막 검수가 완료되면 다시 안내드리겠습니다.",
  LANG_QA_WAIT    : "번역 작업이 완료되면 다시 안내드리겠습니다.",
  KO_QA_REVIEW    : "원어 자막 검수 준비가 되면 [시작] 버튼을 눌러주세요.",
  LANG_WORKER_WORK: "번역 작업 준비가 되면 [시작] 버튼을 눌러주세요.",
  LANG_QA_REVIEW  : "번역물 검수 준비가 되면 [시작] 버튼을 눌러주세요.",
};

// ── ✅ buildAssignEmbed: 마감일시 필드 추가 ──────────────────────────────────
function buildAssignEmbed({
  title, project, artist, language, file_link, runtime,
  stage, note, is_ko, assignee_type,
  deadline_date, deadline_time,
}) {
  const deadlineValue = (deadline_date || deadline_time)
    ? `${deadline_date || ""}${deadline_time ? " " + deadline_time : ""}`.trim()
    : null;

  const embed = new EmbedBuilder()
    .setTitle(title || "📌 번역 작업 배정")
    .addFields(
      { name: "언어",      value: String(language || "-"), inline: true },
      { name: "영상 길이", value: String(runtime  || "-"), inline: true },
      { name: "아티스트",  value: String(artist   || "-"), inline: false },
      { name: "제목",      value: String(project  || "-"), inline: false },
      { name: "파일 링크", value: file_link ? String(file_link) : "-", inline: false },
    )
    .setFooter({
      text: (STAGE_FOOTER[stage] || "")
        + "\u200b" + String(is_ko ?? "")
        + "\u200b" + String(assignee_type ?? ""),
    });

  if (deadlineValue) {
    embed.addFields({ name: "⏰ 마감일시", value: deadlineValue, inline: false }); // ✅ 추가
  }
  if (note) {
    embed.addFields({ name: "📝 특이사항", value: String(note), inline: false });
  }
  return embed;
}

// ── ✅ parseEmbedFields: 마감일시 파싱 추가 ──────────────────────────────────
function parseEmbedFields(embed) {
  const get  = (name) => embed.fields?.find((f) => f.name === name)?.value || "";
  const link = get("파일 링크");
  const footerParts = (embed.footer?.text || "").split("\u200b");
  const isKoVal     = footerParts[1] ?? "";
  const assigneeVal = footerParts[2] ?? "WORKER";

  const deadlineRaw = get("⏰ 마감일시"); // ✅ 추가
  const deadlineParts = deadlineRaw ? deadlineRaw.split(" ") : [];
  const deadline_date = deadlineParts[0] || "";
  const deadline_time = deadlineParts.slice(1).join(" ") || "";

  return {
    project       : get("제목"),
    artist        : get("아티스트"),
    language      : get("언어"),
    runtime       : get("영상 길이"),
    file_link     : link === "-" ? "" : link,
    title         : embed.title || "",
    is_ko         : isKoVal === "true",
    assignee_type : assigneeVal || "WORKER",
    deadline_date,  // ✅ 추가
    deadline_time,  // ✅ 추가
  };
}

function buildAckButtons(row_id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(makeId("accept", row_id)).setLabel("✅ 수락").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(makeId("reject", row_id)).setLabel("❌ 거절").setStyle(ButtonStyle.Danger),
  );
}

function buildStartDoneButtons(row_id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(makeId("start", row_id)).setLabel("▶️ 시작").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(makeId("done",  row_id)).setLabel("🏁 완료").setStyle(ButtonStyle.Success),
  );
}

function buildReviewButtons(row_id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(makeId("review_start", row_id)).setLabel("▶️ 시작").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(makeId("review_done",  row_id)).setLabel("🏁 완료").setStyle(ButtonStyle.Success),
  );
}

function buildDoneOnlyButton(row_id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(makeId("done", row_id)).setLabel("🏁 완료").setStyle(ButtonStyle.Success),
  );
}

function buildReviewDoneButton(row_id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(makeId("review_done", row_id)).setLabel("🏁 완료").setStyle(ButtonStyle.Success),
  );
}

async function sendDm(discord_user_id, embedData, stage) {
  const user  = await client.users.fetch(String(discord_user_id));
  const embed = buildAssignEmbed({ ...embedData, stage });
  const buttonMap = {
    ACK             : [buildAckButtons(embedData.row_id)],
    KO_WORKER_WAIT  : [buildStartDoneButtons(embedData.row_id)],
    KO_QA_WAIT      : [],
    LANG_WORKER_WAIT: [],
    LANG_QA_WAIT    : [],
    KO_QA_REVIEW    : [buildReviewButtons(embedData.row_id)],
    LANG_WORKER_WORK: [buildStartDoneButtons(embedData.row_id)],
    LANG_QA_REVIEW  : [buildReviewButtons(embedData.row_id)],
  };
  return user.send({ embeds: [embed], components: buttonMap[stage] || [] });
}

async function postToAnnounceChannel(content) {
  if (!ANNOUNCE_CHANNEL_ID) return null;
  try {
    const ch = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
    if (!ch || !ch.isTextBased()) return null;
    const msg = await ch.send({ content });
    return msg;
  } catch (e) {
    log("공지 채널 전송 실패:", e?.message || e);
    return null;
  }
}

app.post("/webhook", async (req, res) => {
  try {
    const {
      row_id, project, language, file_link,
      assignee_real_name, discord_user_id,
      stage = "ACK", dm_title, note, no, artist, title,
      reviewer_discord_user_ids, group_key, runtime,
      assignee_type, is_ko,
      deadline_date, deadline_time,  // ✅ 추가
    } = req.body || {};

    if (stage === "ALL_ACCEPTED") {
      if (announcedGroups.has(group_key)) {
        log(`ALL_ACCEPTED 중복 무시 group=${group_key}`);
        return res.json({ ok: true });
      }
      announcedGroups.add(group_key);
      const tags    = (reviewer_discord_user_ids || []).map(id => `<@${id}>`).join(" ");
      const content = `${tags}\nNo.${no} ${artist} ${title}\n영상 입고되었습니다.`;
      const msg     = await postToAnnounceChannel(content);
      if (msg && group_key) announceMessageIds.set(group_key, msg.id);
      log(`ALL_ACCEPTED 공지 발송 group=${group_key} msg=${msg?.id}`);
      return res.json({ ok: true });
    }

    if (!row_id)          return res.status(400).json({ ok: false, error: "row_id 누락" });
    if (!discord_user_id) return res.status(400).json({ ok: false, error: "discord_user_id 누락" });

    const langDisplay = displayLang(language);
    const embedData = {
      row_id,
      title             : dm_title || "📌 번역 작업 배정",
      project, artist,
      language          : langDisplay,
      runtime, file_link,
      assignee_real_name,
      note,
      is_ko             : is_ko ?? (language === "ko"),
      assignee_type     : assignee_type || "WORKER",
      deadline_date     : deadline_date || "",  // ✅ 추가
      deadline_time     : deadline_time || "",  // ✅ 추가
    };

    let resolvedStage = stage;
    if (stage === "WORK")             resolvedStage = is_ko ? "KO_WORKER_WAIT"  : "LANG_WORKER_WORK";
    else if (stage === "REVIEW")      resolvedStage = is_ko ? "KO_QA_REVIEW"    : "LANG_QA_REVIEW";
    else if (stage === "REVIEW_WAIT") resolvedStage = is_ko ? "KO_QA_WAIT"      : "LANG_QA_WAIT";

    await sendDm(discord_user_id, embedData, resolvedStage);
    log(`DM 전송 성공 row_id=${row_id} to=${discord_user_id} stage=${resolvedStage}`);
    return res.json({ ok: true });

  } catch (e) {
    log("DM 전송 실패:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

client.once(Events.ClientReady, () => log(`봇 준비 완료: ${client.user.tag}`));

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== 1) return;
  if (message.content.trim() !== "배정 공지 진행") return;
  await message.reply("✅ 배정 공지를 시작합니다...");
  try {
    const res  = await fetch(GAS_WEB_APP_URL, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ action: "ADMIN_SCAN" }),
    });
    const text = await res.text();
    log(`[TRIGGER] ADMIN_SCAN 완료: ${text}`);
  } catch (e) {
    log(`[TRIGGER] ADMIN_SCAN 실패: ${e.message}`);
    await message.reply("❌ 오류: " + e.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  const actorId = interaction.user?.id;
  try {
    if (interaction.isButton()) {
      const { action, rowId } = parseCustomId(interaction.customId);

      if (action === "accept") {
        await interaction.deferReply({ flags: 64 });
        await postToGas({ row_id: rowId, action: "ACCEPTED", actor_discord_user_id: actorId });
        await interaction.message.edit({ components: [] }).catch(() => {});
        const origEmbed   = interaction.message.embeds[0];
        log("RAW embed fields:", JSON.stringify(origEmbed?.fields || []));
        const embedFields = origEmbed ? parseEmbedFields(origEmbed) : {};
        log("parseEmbedFields 결과:", JSON.stringify(embedFields));
        const isKo         = embedFields.is_ko;
        const assigneeType = embedFields.assignee_type || "WORKER";
        const isQa         = assigneeType === "QA";
        let nextStage;
        if (isKo && !isQa)       nextStage = "KO_WORKER_WAIT";
        else if (isKo && isQa)   nextStage = "KO_QA_WAIT";
        else if (!isKo && !isQa) nextStage = "LANG_WORKER_WAIT";
        else                     nextStage = "LANG_QA_WAIT";
        log(`accept 분기 isKo=${isKo} assigneeType=${assigneeType} nextStage=${nextStage}`);
        await sendDm(actorId, { ...embedFields, row_id: rowId }, nextStage);
        await interaction.editReply("✅ 수락 완료!");
        return;
      }

      if (action === "reject") {
        const modal = new ModalBuilder().setCustomId(makeId("rejectModal", rowId)).setTitle("거절 사유 입력");
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("reject_reason").setLabel("거절 사유를 입력해 주세요")
            .setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(500)
        ));
        await interaction.showModal(modal);
        return;
      }

      if (action === "start") {
        await interaction.deferReply({ flags: 64 });
        const gasResText = await postToGas({ row_id: rowId, action: "IN_PROGRESS", actor_discord_user_id: actorId });
        await interaction.message.edit({ components: [buildDoneOnlyButton(rowId)] }).catch(() => {});
        try {
          const gasRes = JSON.parse(gasResText || "{}");
          const gKey   = gasRes.group_key || "";
          const lang   = gasRes.lang      || "";
          const isKo   = gasRes.is_ko     || false;
          const msgId  = gKey ? announceMessageIds.get(gKey) : null;
          if (msgId) {
            const ch          = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
            const announceMsg = await ch.messages.fetch(msgId);
            let threadMsg = null;
            if (isKo) {
              threadMsg = "원어 자막 작업이 시작되었습니다.";
            } else if (!translationStarted.has(gKey)) {
              translationStarted.add(gKey);
              threadMsg = "번역 작업이 시작되었습니다.";
            }
            if (threadMsg) {
              if (announceMsg.thread) {
                await announceMsg.thread.send(threadMsg);
              } else {
                const thread = await announceMsg.startThread({ name: `No.${gasRes.no || ""} 작업 현황` });
                await thread.send(threadMsg);
              }
              log(`IN_PROGRESS 스레드 group=${gKey} lang=${lang}`);
            }
          }
        } catch (threadErr) {
          log("IN_PROGRESS 스레드 오류:", threadErr?.message || threadErr);
        }
        startedRows.add(rowId);
        await interaction.editReply("▶️ 시작 처리 완료!");
        return;
      }

      if (action === "done") {
        if (!startedRows.has(rowId)) {
          await interaction.reply({ content: "⚠️ 먼저 [▶️ 시작] 버튼을 눌러주세요.", flags: 64 });
          return;
        }
        const modal = new ModalBuilder().setCustomId(makeId("doneModal", rowId)).setTitle("작업 완료 메모");
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("done_note").setLabel("완료 메모 또는 파일 링크 (선택 사항)")
            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
        ));
        await interaction.showModal(modal);
        return;
      }

      if (action === "review_start") {
        await interaction.deferReply({ flags: 64 });
        await postToGas({ row_id: rowId, action: "REVIEW_START", actor_discord_user_id: actorId });
        await interaction.message.edit({ components: [buildReviewDoneButton(rowId)] }).catch(() => {});
        await interaction.editReply("🔍 검수를 시작합니다. 완료 후 [✅ 검수 완료] 버튼을 눌러주세요.");
        return;
      }

      if (action === "review_done") {
        const modal = new ModalBuilder().setCustomId(makeId("reviewDoneModal", rowId)).setTitle("검수 완료 메모");
        modal.addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("review_note").setLabel("특이사항 또는 메모 (선택 사항)")
            .setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(500)
        ));
        await interaction.showModal(modal);
        return;
      }
    }

    if (interaction.isModalSubmit()) {
      const { action, rowId } = parseCustomId(interaction.customId);

      if (action === "rejectModal") {
        const reason = interaction.fields.getTextInputValue("reject_reason");
        await interaction.deferReply({ flags: 64 });
        await postToGas({ row_id: rowId, action: "REJECTED", reject_reason: reason, actor_discord_user_id: actorId });
        await interaction.message?.edit({ components: [] }).catch(() => {});
        await interaction.editReply("❌ 거절 처리 완료. 사유가 시트에 기록되었습니다.");
        return;
      }

      if (action === "doneModal") {
        const workerNote = interaction.fields.getTextInputValue("done_note").trim();
        await interaction.deferReply({ flags: 64 });
        const gasResText = await postToGas({
          row_id               : rowId,
          action               : "DONE",
          done_note            : workerNote || undefined,
          actor_discord_user_id: actorId,
        });
        await interaction.message?.edit({ components: [] }).catch(() => {});
        await interaction.editReply("🏁 완료 처리되었습니다. 수고하셨습니다!");
        try {
          const gasRes     = JSON.parse(gasResText || "{}");
          const reviewerId = gasRes.reviewer_discord_user_id || "";
          const lang       = gasRes.lang                     || "";
          const isKo       = gasRes.is_ko                    || false;
          if (reviewerId) {
            const origEmbed   = interaction.message.embeds[0];
            const embedFields = origEmbed ? parseEmbedFields(origEmbed) : {};
            const reviewStage = isKo ? "KO_QA_REVIEW" : "LANG_QA_REVIEW";
            await sendDm(reviewerId, {
              ...embedFields,       // ✅ deadline_date/time 자동 포함 (parseEmbedFields에서 파싱됨)
              row_id       : rowId,
              language     : displayLang(lang),
              note         : workerNote || undefined,
              is_ko        : isKo,
              assignee_type: "QA",
            }, reviewStage);
            log(`검수자 DM 발송 row_id=${rowId} lang=${lang} reviewer=${reviewerId}`);
          }
        } catch (dmErr) {
          log("검수자 DM/스레드 오류:", dmErr?.message || dmErr);
        }
        return;
      }

      if (action === "reviewDoneModal") {
        const reviewNote = interaction.fields.getTextInputValue("review_note").trim();
        await interaction.deferReply({ flags: 64 });
        const gasResText = await postToGas({
          row_id               : rowId,
          action               : "REVIEW_DONE",
          note                 : reviewNote || undefined,
          actor_discord_user_id: actorId,
        });
        await interaction.message?.edit({ components: [] }).catch(() => {});
        await interaction.editReply("✅ 검수 완료 처리되었습니다. 수고하셨습니다!");
        try {
          const gasRes  = JSON.parse(gasResText || "{}");
          const allDone = gasRes.all_review_done || false;
          const gKey    = gasRes.group_key       || "";
          const msgId   = gKey ? announceMessageIds.get(gKey) : null;
          if (msgId && allDone) {
            const ch          = await client.channels.fetch(ANNOUNCE_CHANNEL_ID);
            const announceMsg = await ch.messages.fetch(msgId);
            const threadMsg   = "모든 작업이 마무리되었습니다.";
            if (announceMsg.thread) {
              await announceMsg.thread.send(threadMsg);
            } else {
              const thread = await announceMsg.startThread({ name: `No.${gasRes.no || ""} 작업 현황` });
              await thread.send(threadMsg);
            }
            log(`REVIEW_DONE 스레드 group=${gKey} allDone=${allDone}`);
          }
        } catch (threadErr) {
          log("REVIEW_DONE 스레드 오류:", threadErr?.message || threadErr);
        }
        return;
      }
    }

  } catch (e) {
    log("Interaction 처리 오류:", e?.message || e);
    if (interaction.isRepliable()) {
      try { await interaction.reply({ content: `오류: ${String(e?.message || e)}`, flags: 64 }); } catch (_) {}
    }
  }
});

app.listen(PORT, () => log(`HTTP 서버 시작: :${PORT}`));
client.login(process.env.BOT_TOKEN).catch((e) => {
  log("로그인 실패:", e?.message || e);
  process.exit(1);
});