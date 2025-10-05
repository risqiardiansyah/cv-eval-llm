// llm-client.js (ESM)
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

if (!OPENAI_API_KEY)
  console.warn("WARNING: OPENAI_API_KEY not set — LLM calls will fail");

async function backoffDelay(attempt) {
  return new Promise((r) =>
    setTimeout(r, Math.min(16000, 500 * Math.pow(2, attempt)))
  );
}

async function callCompletion(payload, opts = { retries: 3 }) {
  const url = `${BASE_URL}/chat/completions`;
  let attempt = 0;
  while (true) {
    try {
      const resp = await axios.post(url, payload, {
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        timeout: 20000,
      });
      return resp.data;
    } catch (err) {
      attempt++;
      const status = err.response?.status;
      const retryable = !status || status >= 500 || status === 429;
      if (!retryable || attempt > opts.retries) throw err;
      await backoffDelay(attempt);
    }
  }
}

export async function callLLM(
  messages,
  { model = "gpt-4o-mini", temperature = 0.2, max_tokens = 800 } = {}
) {
  const payload = { model, temperature, max_tokens, messages };
  const raw = await callCompletion(payload);
  const choice = raw.choices && raw.choices[0];
  const content = choice?.message?.content || choice?.text || "";
  return { raw, content };
}
