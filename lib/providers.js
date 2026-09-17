import { execSync } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { CopilotClient } from "@github/copilot-sdk";

export const ANTHROPIC_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";
export const COPILOT_MODEL = process.env.COPILOT_MODEL || "auto";

export class ProviderError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

export function currentProvider() {
  const p = (process.env.AI_PROVIDER || "").toLowerCase();
  if (p === "anthropic" || p === "copilot") return p;
  return process.env.ANTHROPIC_API_KEY ? "anthropic" : "copilot";
}

function extractJson(text) {
  let t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t);
}

/* ---------------- Anthropic (Claude) ---------------- */
let anthropicClient = null;
export function resetAnthropic() {
  anthropicClient = null;
}
function getAnthropic() {
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

export async function verifyAnthropicKey(key) {
  await new Anthropic({ apiKey: key }).models.retrieve(ANTHROPIC_MODEL);
}

async function askAnthropic({ system, text, image, schema, effort, maxTokens }) {
  const content = image
    ? [
        { type: "image", source: { type: "base64", media_type: image.type, data: image.data } },
        { type: "text", text },
      ]
    : text;
  const stream = getAnthropic().messages.stream({
    model: ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content }],
    thinking: { type: "adaptive" },
    output_config: { effort, format: { type: "json_schema", schema } },
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === "refusal") {
    throw new ProviderError(`رفض النموذج تنفيذ الطلب. ${msg.stop_details?.explanation || ""}`.trim(), 422);
  }
  return JSON.parse(msg.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
}

/* ---------------- GitHub Copilot ---------------- */
let copilotClient = null;
let copilotStarting = null;
let copilotReady = false;

function ghCliToken() {
  try {
    return execSync("gh auth token", { stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).toString().trim() || null;
  } catch {
    return null;
  }
}

async function startCopilot(opts) {
  const client = new CopilotClient(opts);
  await client.start();
  try {
    await client.listModels();
  } catch (e) {
    await client.stop().catch(() => {});
    throw e;
  }
  return client;
}

export async function getCopilot() {
  if (copilotClient && copilotReady) return copilotClient;
  if (copilotStarting) return copilotStarting;
  copilotStarting = (async () => {
    const attempts = [{}];
    const token = process.env.COPILOT_GITHUB_TOKEN || ghCliToken();
    if (token) attempts.push({ gitHubToken: token });
    let lastErr;
    for (const opts of attempts) {
      try {
        copilotClient = await startCopilot(opts);
        copilotReady = true;
        return copilotClient;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new ProviderError(
      `تعذر الاتصال بـ GitHub Copilot. تأكد من تسجيل الدخول إلى GitHub بحساب لديه اشتراك Copilot (شغّل: gh auth login). التفاصيل: ${String(lastErr?.message || lastErr).slice(0, 200)}`,
      503,
    );
  })().finally(() => (copilotStarting = null));
  return copilotStarting;
}

export async function copilotStatus() {
  try {
    await getCopilot();
    return { ready: true };
  } catch (e) {
    return { ready: false, error: e.message };
  }
}

export async function stopCopilot() {
  if (copilotClient) await copilotClient.stop().catch(() => {});
  copilotClient = null;
  copilotReady = false;
}

async function askCopilot({ system, text, image, schema }) {
  const client = await getCopilot();
  const sysMsg =
    `${system}\n\n` +
    `تعليمات الإخراج الإلزامية: أجب بكائن JSON واحد فقط يطابق المخطط التالي تمامًا، دون أي نص قبله أو بعده، ودون أسوار كود (\`\`\`), ودون شرح.\n` +
    `المخطط (JSON Schema):\n${JSON.stringify(schema)}`;
  let session;
  try {
    session = await client.createSession({
      model: COPILOT_MODEL,
      availableTools: [],
      systemMessage: { mode: "replace", content: sysMsg },
    });
  } catch (e) {
    copilotReady = false;
    throw new ProviderError(`تعذر بدء جلسة Copilot: ${String(e.message || e).slice(0, 200)}`, 503);
  }
  try {
    const attachments = image ? [{ type: "blob", data: image.data, mimeType: image.type, displayName: "photo" }] : undefined;
    let reply = await session.sendAndWait({ prompt: text, attachments }, 240000);
    let content = reply?.data?.content || "";
    try {
      return extractJson(content);
    } catch {
      reply = await session.sendAndWait({ prompt: "الإخراج السابق ليس JSON صالحًا. أعد الإخراج نفسه بصيغة JSON صالحة فقط تطابق المخطط، دون أي نص آخر." }, 120000);
      content = reply?.data?.content || "";
      try {
        return extractJson(content);
      } catch {
        throw new ProviderError("استجابة غير مفهومة من Copilot. أعد المحاولة.", 502);
      }
    }
  } finally {
    await session.disconnect().catch(() => {});
  }
}

/* ---------------- الواجهة الموحدة ---------------- */
export async function askJson({ system, text, image = null, schema, effort = "medium", maxTokens = 8000 }) {
  const provider = currentProvider();
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new ProviderError("لم يُضبط مفتاح Claude. اختر مزوّدًا من شريط الإعداد أعلى الصفحة.", 401);
    }
    return askAnthropic({ system, text, image, schema, effort, maxTokens });
  }
  return askCopilot({ system, text, image, schema });
}
