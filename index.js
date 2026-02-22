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

const BOT_TOKEN = process.env.BOT_TOKEN;
const GAS_WEB_APP_URL = process.env.GAS_WEB_APP_URL;
const PORT = Number(process.env.PORT || 3000);

if (!BOT_TOKEN) throw new Error("환경변수 BOT_TOKEN이 비어 있습니다.");
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
  console.log("[BOT]", ...args);
}

async function postToGas(payload) {
  const res = await fetch(GAS_WEB_APP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`GAS 응답 오류: ${res.status} ${text}`);
  return text;
}

function buildAssignEmbed({ project, language, file_link, assignee_real_name, pm_real_name, row_id }) {
  return new EmbedBuilder()
    .setTitle("📌 번역 작업 배정 요청")
    .addFields(
      { name: "프로젝트", value: String(project || "-"), inline: true },
      { name: "언어", value: String(language || "-"), inline: true },
      { name: "담당자", value: String(assignee_real_name || "-"), inline: true },
      { name: "PM", value: String(pm_real_name || "-"), inline: true },
      { name: "파일 링크", value: file_link ? String(file_link) : "-", inline: false },
      { name: "row_id", value: String(row_id || "-"), inline: false },
    )
    .setFooter({ text: "✅ 수락 / ❌ 거절 버튼으로 응답해 주세요." });
}

function extractRowId(customId) {
  const parts = String(customId).split("_");
  return parts.slice(1).join("_");
}

function buildButtons(row_id, disabled = false) {
  const accept = new ButtonBuilder()
    .setCustomId(`accept_${row_id}`)
    .setLabel("✅ 수락")
    .setStyle(ButtonStyle.Success)
    .setDisabled(disabled);

  const reject = new ButtonBuilder()
    .setCustomId(`reject_${row_id}`)
    .setLabel("❌ 거절")
    .setStyle(ButtonStyle.Danger)
    .setDisabled(disabled);

  return new ActionRowBuilder().addComponents(accept, reject);
}

async function sendDmToUser(discord_user_id, embed, row_id) {
  const user = await client.users.fetch(String(discord_user_id));
  return user.send({ embeds: [embed], components: [buildButtons(row_id, false)] });
}

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
    } = req.body || {};

    if (!row_id || !discord_user_id) {
      return res.status(400).json({ ok: false, error: "row_id/discord_user_id 누락" });
    }

    const embed = buildAssignEmbed({ project, language, file_link, assignee_real_name, pm_real_name, row_id });
    await sendDmToUser(discord_user_id, embed, row_id);

    log(`DM 전송 성공 row_id=${row_id} to=${discord_user_id}`);
    return res.json({ ok: true });
  } catch (e) {
    log("DM 전송 실패:", e?.message || e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

client.once(Events.ClientReady, () => {
  log(`봇 준비 완료: ${client.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      const rowId = extractRowId(interaction.customId);

      if (interaction.customId.startsWith("accept_")) {
        await interaction.deferReply({ ephemeral: true });
        await postToGas({ row_id: rowId, action: "ACCEPTED" });
        await interaction.editReply("✅ 수락 처리 완료. 감사합니다.");
        return;
      }

      if (interaction.customId.startsWith("reject_")) {
        const modal = new ModalBuilder()
          .setCustomId(`rejectModal_${rowId}`)
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
    }

    if (interaction.isModalSubmit()) {
      if (!interaction.customId.startsWith("rejectModal_")) return;

      const rowId = interaction.customId.replace("rejectModal_", "");
      const reason = interaction.fields.getTextInputValue("reject_reason");

      await interaction.deferReply({ ephemeral: true });
      await postToGas({ row_id: rowId, action: "REJECTED", reject_reason: reason });
      await interaction.editReply("❌ 거절 처리 완료. 사유가 기록되었습니다.");
      return;
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

app.listen(PORT, () => log(`HTTP 서버 시작: :${PORT}`));
client.login(BOT_TOKEN).catch((e) => {
  log("로그인 실패:", e?.message || e);
  process.exit(1);
});