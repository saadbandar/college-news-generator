import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  GENERATE_SYSTEM,
  TRANSLATE_SYSTEM,
  ALT_TEXT_SYSTEM,
  NEWS_SCHEMA,
  TRANSLATION_SCHEMA,
  ALT_TEXT_SCHEMA,
  buildGenerateUserMessage,
  buildTranslateUserMessage,
  buildAltTextContext,
} from "./lib/prompts.js";
import { buildNewsDocx } from "./lib/docx.js";
import {
  askJson,
  currentProvider,
  copilotStatus,
  stopCopilot,
  verifyAnthropicKey,
  resetAnthropic,
  ProviderError,
  ANTHROPIC_MODEL,
  COPILOT_MODEL,
} from "./lib/providers.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3210;
const ENV_PATH = path.join(here, ".env");

const app = express();
app.use(express.json({ limit: "40mb" }));
app.use(express.static(path.join(here, "public")));

function writeEnv(updates) {
  let lines = [];
  try {
    lines = fs.readFileSync(ENV_PATH, "utf8").split(/\r?\n/);
  } catch {}
  for (const [k, v] of Object.entries(updates)) {
    lines = lines.filter((l) => !l.startsWith(`${k}=`));
    if (v != null) lines.unshift(`${k}=${v}`);
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  const body = lines.filter((l, i, a) => l.trim() || i < a.length - 1).join("\n").replace(/\n+$/, "") + "\n";
  fs.writeFileSync(ENV_PATH, body, { mode: 0o600 });
}

function apiError(res, err) {
  console.error(err);
  let status = err.status || 500;
  let message = err.message || "خطأ غير متوقع";
  if (err instanceof ProviderError) {
    // message already user-facing
  } else if (err instanceof Anthropic.AuthenticationError) {
    status = 401;
    message = "مفتاح Claude غير صالح. أعد ضبطه من شريط الإعداد.";
  } else if (err instanceof Anthropic.RateLimitError) {
    status = 429;
    message = "تم تجاوز حد الطلبات مؤقتًا. حاول مرة أخرى بعد قليل.";
  } else if (err instanceof Anthropic.APIConnectionError) {
    status = 503;
    message = "تعذر الاتصال بخدمة الذكاء الاصطناعي. تحقق من الاتصال بالإنترنت.";
  } else if (err instanceof SyntaxError) {
    status = 502;
    message = "استجابة غير مفهومة من النموذج. أعد المحاولة.";
  }
  res.status(status).json({ error: message });
}

app.get("/api/status", async (_req, res) => {
  const provider = currentProvider();
  const anthropicReady = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
  let ready = anthropicReady;
  let detail = "";
  if (provider === "copilot") {
    const s = await copilotStatus();
    ready = s.ready;
    detail = s.error || "";
  }
  res.json({
    ok: true,
    provider,
    ready,
    detail,
    model: provider === "copilot" ? COPILOT_MODEL : ANTHROPIC_MODEL,
    providers: { anthropic: anthropicReady },
  });
});

app.post("/api/setup", async (req, res) => {
  const { provider, key } = req.body || {};
  try {
    if (provider === "copilot") {
      await stopCopilot();
      const s = await copilotStatus();
      if (!s.ready) return res.status(503).json({ error: s.error });
      writeEnv({ AI_PROVIDER: "copilot" });
      return res.json({ ok: true, provider: "copilot" });
    }
    if (provider === "anthropic") {
      const k = String(key || "").trim();
      if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) return res.status(400).json({ error: "صيغة المفتاح غير صحيحة. يبدأ المفتاح بـ sk-ant-" });
      try {
        await verifyAnthropicKey(k);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) return res.status(401).json({ error: "المفتاح غير صالح أو منتهي." });
        if (err instanceof Anthropic.PermissionDeniedError) return res.status(403).json({ error: "المفتاح صالح لكنه لا يملك صلاحية استخدام النموذج." });
        throw err;
      }
      writeEnv({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: k });
      resetAnthropic();
      return res.json({ ok: true, provider: "anthropic" });
    }
    res.status(400).json({ error: "مزوّد غير معروف." });
  } catch (err) {
    apiError(res, err);
  }
});

app.post("/api/generate", async (req, res) => {
  try {
    const { input = {}, previous } = req.body || {};
    const hasAny = Object.values(input).some((v) => typeof v === "string" && v.trim());
    if (!hasAny) return res.status(400).json({ error: "أدخل معلومات الفعالية أولًا." });
    const result = await askJson({
      system: GENERATE_SYSTEM,
      text: buildGenerateUserMessage(input, previous),
      schema: NEWS_SCHEMA,
      effort: "high",
    });
    res.json(result);
  } catch (err) {
    apiError(res, err);
  }
});

app.post("/api/translate", async (req, res) => {
  try {
    const { ar_title = "", ar_body = "", prev_en_title = "", prev_en_body = "" } = req.body || {};
    if (!ar_title.trim() || !ar_body.trim()) return res.status(400).json({ error: "النص العربي فارغ." });
    const result = await askJson({
      system: TRANSLATE_SYSTEM,
      text: buildTranslateUserMessage({ ar_title, ar_body, prev_en_title, prev_en_body }),
      schema: TRANSLATION_SCHEMA,
      effort: "medium",
    });
    res.json(result);
  } catch (err) {
    apiError(res, err);
  }
});

app.post("/api/alt-text", async (req, res) => {
  try {
    const { image, context = {} } = req.body || {};
    if (!image?.data || !image?.type) return res.status(400).json({ error: "لم تُرفع صورة." });
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(image.type)) return res.status(400).json({ error: "صيغة الصورة غير مدعومة (JPG, PNG, WEBP, GIF)." });
    const result = await askJson({
      system: ALT_TEXT_SYSTEM,
      text: `السياق:\n${buildAltTextContext(context)}\n\nاكتب النص البديل للصورة المرفقة بالعربية والإنجليزية.`,
      image: { type: image.type, data: image.data },
      schema: ALT_TEXT_SCHEMA,
      effort: "medium",
      maxTokens: 2000,
    });
    res.json(result);
  } catch (err) {
    apiError(res, err);
  }
});

app.post("/api/export", async (req, res) => {
  try {
    const { lang, title, body, altText, image } = req.body || {};
    if (!["ar", "en"].includes(lang)) return res.status(400).json({ error: "لغة غير صالحة." });
    if (!title?.trim() || !body?.trim()) return res.status(400).json({ error: "العنوان أو النص فارغ." });
    const buf = await buildNewsDocx({ lang, title: title.trim(), body: body.trim(), altText, image });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.send(buf);
  } catch (err) {
    apiError(res, err);
  }
});

const server = app.listen(PORT, () => {
  console.log(`أداة أخبار الكلية تعمل على: http://localhost:${PORT}`);
  console.log(`المزوّد الحالي: ${currentProvider() === "copilot" ? "GitHub Copilot" : "Claude"}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, async () => {
    await stopCopilot();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
