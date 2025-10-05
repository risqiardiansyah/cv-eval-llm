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
          content: `"You are an expert hiring manager evaluating a candidate's CV for a software engineering position. 
              Use the rubric provided below to assign numeric scores (1-5) for each parameter. 
              Return ONLY valid JSON (no text before or after it). 
              Follow the weighting and output schema precisely.

              Rubric:
              - technical_skills (weight 0.40): Alignment with job requirements (backend, databases, APIs, cloud, AI/LLM).
                1 = Irrelevant skills, 2 = Few overlaps, 3 = Partial match, 4 = Strong match, 5 = Excellent match + AI/LLM exposure.
              - experience_level (weight 0.25): Years of experience and project complexity.
                1 = <1 yr / trivial projects, 2 = 1-2 yrs small projects, 3 = 2-3 yrs mid-scale, 4 = 3-4 yrs solid track record, 5 = 5+ yrs / high-impact.
              - achievements (weight 0.20): Impact of past work (scaling, performance, adoption).
                1 = None, 2 = Minimal, 3 = Some measurable outcomes, 4 = Significant, 5 = Major measurable impact.
              - cultural_fit (weight 0.15): Communication, learning mindset, teamwork/leadership.
                1 = Not demonstrated, 2 = Minimal, 3 = Average, 4 = Good, 5 = Excellent.

              Compute:
              cv_match_rate = ((technical_skills * 0.40) + (experience_level * 0.25) + (achievements * 0.20) + (cultural_fit * 0.15)) / 5.

              Include a feedback summary of 80-200 characters explaining key strengths and gaps.

              Output schema:
              {
                "technical_skills": <1-5>,
                "experience_level": <1-5>,
                "achievements": <1-5>,
                "cultural_fit": <1-5>,
                "cv_match_rate": <0.0-1.0>,
                "cv_feedback": "<80-200 chars feedback>"
              }

              Return ONLY JSON starting with { and ending with }."`,
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
          content: `"You are an expert software evaluator reviewing a candidate’s technical project submission. 
              Score the project strictly using the rubric below. 
              Return ONLY valid JSON (no extra text).

              Rubric:
              - correctness (weight 0.30): Implements prompt design, LLM chaining, RAG context injection.
                1 = Not implemented, 2 = Minimal attempt, 3 = Works partially, 4 = Works correctly, 5 = Fully correct + thoughtful.
              - code_quality (weight 0.25): Clean, modular, reusable, tested.
                1 = Poor, 2 = Some structure, 3 = Decent modularity, 4 = Good structure + tests, 5 = Excellent quality + strong tests.
              - resilience (weight 0.20): Handles long jobs, retries, randomness, API failures.
                1 = Missing, 2 = Minimal, 3 = Partial handling, 4 = Solid handling, 5 = Robust and production-ready.
              - documentation (weight 0.15): README clarity, setup instructions, trade-offs.
                1 = Missing, 2 = Minimal, 3 = Adequate, 4 = Clear, 5 = Excellent + insightful.
              - creativity (weight 0.10): Extra features beyond requirements.
                1 = None, 2 = Basic, 3 = Useful extras, 4 = Strong enhancements, 5 = Outstanding creativity.

              Compute:
              project_score = weighted average of all parameters (1-5 scale).

              Include a concise feedback summary of 80-300 characters on project strengths and improvement points.

              Output schema:
              {
                "correctness": <1-5>,
                "code_quality": <1-5>,
                "resilience": <1-5>,
                "documentation": <1-5>,
                "creativity": <1-5>,
                "project_score": <1-5>,
                "project_feedback": "<80-300 chars feedback>"
              }

              Return ONLY JSON starting with { and ending with }.
              "`,
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
        cv_feedback: finalCvJson?.cv_feedback || "",
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
