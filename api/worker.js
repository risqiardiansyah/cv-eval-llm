// worker.js - integrated worker: embeddings -> Qdrant retrieval -> LLM scoring (ESM version)

import { Worker } from "bullmq";
import IORedis from "ioredis";
import fs from "fs";
import path from "path";
import { jobs } from "./server.js";
import { callLLM } from "./lib/llm-client.js";
import { getEmbedding } from "./lib/embeddings.js";
import * as qdrant from "./lib/qdrant-client.js";
import dotenv from "dotenv";
import { redis } from "./lib/redis.js";
import { PDFParse } from "pdf-parse";

dotenv.config();

const connection = new IORedis(
  process.env.REDIS_URL || "redis://localhost:6379"
);
const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
const COLLECTION = process.env.QDRANT_COLLECTION || "system_docs";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readMeta(id) {
  try {
    const p = path.join(UPLOAD_DIR, `${id}.meta.json`);
    if (!fs.existsSync(p)) {
      console.log("Meta file not found:", p);

      return null;
    }
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    return null;
  }
}

async function extractTextFromPdf(filePath) {
  const buffer = fs.readFileSync(filePath);
  const parser = new PDFParse({ data: buffer });
  const textResult = await parser.getText();

  return textResult.text;
}

async function retrieveContext(text, top = 5) {
  const vec = await getEmbedding(text.slice(0, 2000));
  const hits = await qdrant.search(COLLECTION, vec, top);
  return hits.map((h) => h.payload);
}

async function safeParseJSON(str) {
  try {
    console.log("Attempting to parse JSON:", str);

    return JSON.parse(str);
  } catch (e) {
    console.log("JSON parse error:", e);

    return null;
  }
}

const worker = new Worker(
  "evaluation",
  async (job) => {
    const { jobId } = job.data;
    let metaStr = await redis.get(jobId);
    if (!metaStr) throw new Error("meta missing");

    let meta = JSON.parse(metaStr);
    meta.status = "processing";
    await redis.set(jobId, JSON.stringify(meta));

    try {
      meta.step = "parse_files";
      const { cv_id, project_id, job_title } = meta.input;

      const cvMeta = readMeta(cv_id);
      const projMeta = readMeta(project_id);
      if (!cvMeta || !projMeta) throw new Error("uploaded files missing");

      const cvText = await extractTextFromPdf(cvMeta.path);
      const projText = await extractTextFromPdf(projMeta.path);

      // =======================
      // ==== CV evaluation ====
      // =======================
      meta.step = "retrieve_cv_context";
      const cvContext = await retrieveContext(job_title + " " + cvText, 5);

      meta.step = "cv_llm";
      const cvPrompt = [
        {
          role: "system",
          content:
            "You are an expert hiring manager. Return ONLY valid JSON start with { and ended with } with numeric scores 1-5 for technical_skills, experience_level, achievements, cultural_fit; compute cv_match_rate (0-1) using weights technical:0.35, experience:0.25, achievements:0.2, cultural:0.2, and include cv_feedback (80-200 chars).",
        },
        {
          role: "user",
          content: `Job title: ${job_title}\nContext excerpts: ${cvContext
            .map((c) => c.text || c)
            .slice(0, 5)
            .join("\n---\n")}\n\nCandidate CV:\n${cvText}`,
        },
      ];

      const cvResp = await callLLM(cvPrompt, { temperature: 0.1 });
      let cvJson = null;
      let cvJsonParsed = safeParseJSON(cvResp.content.trim());

      if (cvJsonParsed === null) {
        const retry = await callLLM(
          [
            {
              role: "system",
              content: "Return only valid JSON",
            },
            { role: "user", content: cvResp.content.trim() },
          ],
          { temperature: 0.0 }
        );
        cvJson = safeParseJSON(retry.content.trim());
      } else {
        cvJson = cvJsonParsed;
      }

      // ============================
      // ==== Project evaluation ====
      // ============================
      meta.step = "retrieve_proj_context";
      const projContext = await retrieveContext(projText + " " + job_title, 5);

      meta.step = "project_llm";
      const projPrompt = [
        {
          role: "system",
          content:
            "You are an expert evaluator. Return ONLY JSON start with { and ended with } with correctness, code_quality, resilience, documentation, creativity (1-5), project_score (1-5), project_feedback (80-300 chars).",
        },
        {
          role: "user",
          content: `Case brief excerpts: ${projContext
            .map((c) => c.text || c)
            .slice(0, 5)
            .join("\n---\n")}\n\nProject text:\n${projText}`,
        },
      ];

      const projResp = await callLLM(projPrompt, { temperature: 0.1 });
      let projJson = safeParseJSON(projResp.content.trim());

      if (!projJson) {
        const retry = await callLLM(
          [
            { role: "system", content: "Return only valid JSON" },
            { role: "user", content: projPrompt[1].content },
          ],
          { temperature: 0.0 }
        );
        projJson = safeParseJSON(retry.content.trim());
      }

      // =========================
      // ==== Final synthesis ====
      // =========================
      let contentForSynthesis = "";
      cvJson.then((resolvedCv) => {
        projJson.then((resolvedProj) => {
          contentForSynthesis = `CV: ${JSON.stringify(
            resolvedCv
          )}\nProject: ${JSON.stringify(resolvedProj)}`;
          console.log("CONTENT FOR SYNTHESIS", contentForSynthesis);
        });
      });

      meta.step = "synthesis";
      const synthPrompt = [
        {
          role: "system",
          content:
            "Synthesize the CV and project JSON into overall_summary (1-2 paras) and recommendation (Hire|Interview|Reject). Return JSON only start with { and ended with }.",
        },
        {
          role: "user",
          content: contentForSynthesis,
        },
      ];

      const synthResp = await callLLM(synthPrompt, { temperature: 0.2 });
      let synthJson = safeParseJSON(synthResp.content.trim());

      let [finalCvJson, finalprojJson, finalsynthJson] = await Promise.all([
        cvJson,
        projJson,
        synthJson,
      ]);
      console.log("FINAL CvJson", finalCvJson);
      console.log("FINAL projJson", finalprojJson);
      console.log("FINAL synthJson", finalsynthJson);

      meta.status = "completed";
      meta.result = {
        cv_match_rate: finalCvJson?.cv_match_rate || 0,
        cv_feedback: finalCvJson?.cd_feedback || "",
        project_score: finalprojJson?.project_score || 0,
        project_feedback: finalprojJson?.project_feedback || "",
        overall_summary: finalsynthJson?.overall_summary || "",
      };
      meta.completedAt = new Date().toISOString();

      await redis.set(jobId, JSON.stringify(meta));

      return meta.result;
    } catch (err) {
      meta.status = "failed";
      meta.error = err.message;
      throw err;
    }
  },
  {
    connection,
    lockDuration: 300000, // locking process
    stalledInterval: 30000, // retying stalled interval
    maxStalledCount: 3, // max stalled retires
  }
);

worker.on("failed", (job, err) =>
  console.error("Worker job failed", job.id, err)
);
console.log("Worker started (LLM + Qdrant)");
