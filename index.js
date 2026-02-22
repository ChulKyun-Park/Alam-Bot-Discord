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

const BOT_TOKEN      = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT           = Number(process.env.PORT || 3000);

if (!BOT_TOKEN)       throw new Error("환경변수 BOT_TOKEN이 비어 있습니다.");
if (!GAS_WEB_APP_URL) throw new Error("환경변수 GAS_WEB_APP_URL이 비어 있습니다.");

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

function log(...args) {
  console.log(new Date().toISOString(), "[BOT]", ...args);
}

// ── GAS 연동 ────────────────────────────────────────────────────────────────
async function postToGas(payload) {
  const res = await fetch(GAS_WEB_APP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`GAS 응답 오류: ${res.status} ${text}`);
  log("GAS 응답:", text.slice(0, 200));
  return text;
}

// ── customId 파서 / 빌더 ─────────────────────────────────────────────────────
// 규격: "<action>:<row_id>"  (예: "accept:ROW-003")
function parseCustomId(customId) {
  const str = String(customId);
  const idx = str.indexOf(":");
  if (idx === -1) return { action: str, rowId: "" };
  return { action: str.slice(0, idx), rowId: str.slice(idx + 1) };
}

function makeId(action, rowId) {
  return `${action}:${rowId}`;
}

// ── Embed 빌더 ───────────────────────────────────────────────────────────────
const STAGE_FOOTER = {
  ACK      : "✅ 수락 / ❌ 거절 버튼으로 응답해 주세요.",
  PROGRESS : "▶️ 작업 준비가 되면 [시작] 버튼을 눌러주세요.",
  DONE     : "🏁 작업 완료 후 [완료] 버튼을 눌러 완료 처리해 주세요.",
};

function buildAssignEmbed({ project, language, file_link, assignee_real_name, pm_real_name, row_id, stage }) {
  return new EmbedBuilder()
    .setTitle("📌 번역 작업 배정")
    .addFields(
      { name: "프로젝트",  value: String(project             || "-"), inline: true  },
      { name: "언어",      value: String(language            || "-"), inline: true  },
      { name: "담당자",    value: String(assignee_real_name  || "-"), inline: true  },
      { name: "PM",        value: String(pm_real_name        || "-"), inline: true  },
      { name: "파일 링크", value: file_link ? String(file_link) : "-", inline: false },
      { name: "row_id",    value: String(row_id              || "-"), inline: false },
    )
    .setFooter({ text: STAGE_FOOTER[stage] || "" });
}

// Embed 필드에서 작업 정보 역파싱 (연속 DM 전송용)
function parseEmbedFields(embed) {
  const get = (name) => embed.fields?.find((f) => f.name === name)?.value || "-";
  const link = get("파일 링크");
  return {
    project            : get("프로젝트"),
    language           : get("언어"),
    assignee_real_name : get("담당자"),
    pm_real_name       : get("PM"),
    file_link          : link === "-" ? "" : link,
  };
}

// ── 버튼 세트 ────────────────────────────────────────────────────────────────
function buildAckButtons(row_id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(makeId("accept", row_id))
      .setLabel("✅ 수락")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(makeId("reject", row_id))
      .setLabel("❌ 거절")
      .setStyle(ButtonStyle.Danger),
  );
}

function buildProgressButtons(row_id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(makeId("start", row_id))
      .setLabel("▶️ 시작")
      .setStyle(ButtonStyle.Primary),
  );
}

function buildDoneButtons(row_id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(makeId("done", row_id))
      .setLabel("🏁 완료")
      .setStyle(ButtonStyle.Success),
  );
}

// ── DM 전송 헬퍼 ─────────────────────────────────────────────────────────────
async function sendDm(discord_user_id, embedData, stage) {
  const user  = await client.users.fetch(String(discord_user_id));
  const embed = buildAssignEmbed({ ...embedData, stage });
  const componentMap = {
    ACK      : [buildAckButtons(embedData.row_id)],
    PROGRESS : [buildProgressButtons(embedData.row_id)],
    DONE     : [buildDoneButtons(embedData.row_id)],
  };
  return user.send({ embeds: [embed], components: componentMap[stage] || [] });
}

// ── /webhook ─────────────────────────────────────────────────────────────────
// GAS → Bot: 작업 배정 DM 전송 요청
// stage: "ACK" | "PROGRESS" | "DONE"  (기본값 "ACK")
app.post("/webhook", async (req, res) => {
  try {
    const {
      row_id,
      project,
      language,
      file_link,
      assignee_real_name,
      discord_user_id,
      pm_real_name,
      stage = "ACK",
    } = req.body || {};

    if (!row_id || !discord_user_id) {
      return res.status(400).json({ ok: false, error: "row_id 또는 discord_user_id 누락" });
    }

    await sendDm(
      discord_user_id,
      { row_id, project, language, file_link, assignee_real_name, pm_real_name },
      stage,
    );

    log(`DM 전송 성공 row_id=${row_id} to=${discord_user_id} stage=${stage}`);
    return res.json({ ok: true });
  } catch (e) {
    log("DM 전송 실패:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ── /healthz ─────────────────────────────────────────────────────────────────
app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ── Discord Interaction 핸들러 ───────────────────────────────────────────────
client.once(Events.ClientReady, () => {
  log(`봇 준비 완료: ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  const actorId = interaction.user?.id;

  try {
    // ── 버튼 클릭 ──────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const { action, rowId } = parseCustomId(interaction.customId);

      // 수락 (ACK → ACCEPTED → 다음 DM: PROGRESS)
      if (action === "accept") {
        await interaction.deferReply({ ephemeral: true });
        await postToGas({
          row_id               : rowId,
          action               : "ACCEPTED",
          actor_discord_user_id: actorId,
        });
        await interaction.message.edit({ components: [] }).catch(() => {});

        // 동일 사용자에게 시작 버튼 DM 전송
        const origEmbed = interaction.message.embeds[0];
        if (origEmbed) {
          const taskData = parseEmbedFields(origEmbed);
          await sendDm(actorId, { ...taskData, row_id: rowId }, "PROGRESS");
        }

        await interaction.editReply("✅ 수락 완료! 준비가 되면 [▶️ 시작] 버튼을 눌러주세요.");
        return;
      }

      // 거절 → 모달 표시
      if (action === "reject") {
        const modal = new ModalBuilder()
          .setCustomId(makeId("rejectModal", rowId))
          .setTitle("거절 사유 입력");
        const input = new TextInputBuilder()
          .setCustomId("reject_reason")
          .setLabel("거절 사유를 입력해 주세요")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }

      // 시작 (ACCEPTED → IN_PROGRESS → 다음 DM: DONE)
      if (action === "start") {
        await interaction.deferReply({ ephemeral: true });
        await postToGas({
          row_id               : rowId,
          action               : "IN_PROGRESS",
          actor_discord_user_id: actorId,
        });
        await interaction.message.edit({ components: [] }).catch(() => {});

        // 완료 버튼 DM 전송
        const origEmbed = interaction.message.embeds[0];
        if (origEmbed) {
          const taskData = parseEmbedFields(origEmbed);
          await sendDm(actorId, { ...taskData, row_id: rowId }, "DONE");
        }

        await interaction.editReply("▶️ 시작 처리 완료! 작업 후 [🏁 완료] 버튼을 눌러주세요.");
        return;
      }

      // 완료 → 메모 모달
      if (action === "done") {
        const modal = new ModalBuilder()
          .setCustomId(makeId("doneModal", rowId))
          .setTitle("작업 완료 메모");
        const input = new TextInputBuilder()
          .setCustomId("done_note")
          .setLabel("완료 메모 (선택 사항)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(500);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return;
      }
    }

    // ── 모달 제출 ──────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      const { action, rowId } = parseCustomId(interaction.customId);

      // 거절 사유 확정
      if (action === "rejectModal") {
        const reason = interaction.fields.getTextInputValue("reject_reason");
        await interaction.deferReply({ ephemeral: true });
        await postToGas({
          row_id               : rowId,
          action               : "REJECTED",
          reject_reason        : reason,
          actor_discord_user_id: actorId,
        });
        await interaction.message?.edit({ components: [] }).catch(() => {});
        await interaction.editReply("❌ 거절 처리 완료. 사유가 시트에 기록되었습니다.");
        return;
      }

      // 완료 메모 확정
      if (action === "doneModal") {
        const note = interaction.fields.getTextInputValue("done_note").trim();
        await interaction.deferReply({ ephemeral: true });
        await postToGas({
          row_id               : rowId,
          action               : "DONE",
          done_note            : note || undefined,
          actor_discord_user_id: actorId,
        });
        await interaction.message?.edit({ components: [] }).catch(() => {});
        await interaction.editReply("🏁 완료 처리되었습니다. 수고하셨습니다!");
        return;
      }
    }
  } catch (e) {
    log("Interaction 처리 오류:", e?.message || e);
    if (interaction.isRepliable()) {
      try {
        await interaction.reply({ content: `오류: ${String(e?.message || e)}`, ephemeral: true });
      } catch (_) {}
    }
  }
});

// ── 서버 기동 ────────────────────────────────────────────────────────────────
app.listen(PORT, () => log(`HTTP 서버 시작: :${PORT}`));
client.login(BOT_TOKEN).catch((e) => {
  log("로그인 실패:", e?.message || e);
  process.exit(1);
});
