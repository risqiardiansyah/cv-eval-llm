// embeddings.js - OpenAI embeddings wrapper (ESM)
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BASE_URL = process.env.OPENAI_API_BASE || "https://api.openai.com/v1";

if (!OPENAI_API_KEY)
  console.warn("WARNING: OPENAI_API_KEY not set — embeddings will fail");

export async function getEmbedding(
  text,
  { model = "text-embedding-3-small" } = {}
) {
  try {
    const url = `${BASE_URL}/embeddings`;
    const resp = await axios.post(
      url,
      { input: text, model },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 20000,
      }
    );
    console.log("Embedding response:", resp.data);

    const emb = resp.data?.data?.[0]?.embedding;
    return emb;
  } catch (err) {
    if (err.response) {
      console.error("OpenAI Error:", err.response.status, err.response.data);
    } else {
      console.error("Request Error:", err.message);
    }
    throw err;
  }
}
