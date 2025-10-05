import express from "express";
import fs from "fs";
import path from "path";
import formidable from "formidable";
import { v4 as uuidv4 } from "uuid";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import dotenv from "dotenv";
import { redis } from "./lib/redis.js";

dotenv.config();

const app = express();
app.use(express.json());

const UPLOAD_DIR = process.env.UPLOAD_DIR || "./uploads";
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const jobs = {};

const connection = new IORedis(
  process.env.REDIS_URL || "redis://localhost:6379"
);
const queue = new Queue("evaluation", { connection });

app.post("/upload", (req, res) => {
  const form = formidable({
    multiples: false,
    uploadDir: UPLOAD_DIR,
    keepExtensions: true,
  });

  form.parse(req, (err, fields, files) => {
    if (err) return res.status(500).json({ error: err.message });

    const saved = {};
    ["cv", "project"].forEach((key) => {
      if (files[key]) {
        const file = Array.isArray(files[key]) ? files[key][0] : files[key];
        const id = uuidv4();
        const ext = path.extname(file.originalFilename || file.name) || ".pdf";
        const dest = path.join(UPLOAD_DIR, `${id}${ext}`);

        fs.copyFileSync(file.filepath, dest);

        saved[`${key}_id`] = id;

        fs.writeFileSync(
          path.join(UPLOAD_DIR, `${id}.meta.json`),
          JSON.stringify({
            originalName: file.originalFilename || file.name,
            path: dest,
          })
        );
      }
    });

    res.json(saved);
  });
});

app.post("/evaluate", async (req, res) => {
  const { job_title, cv_id, project_id } = req.body;

  const jobId = `job_${Date.now()}`;

  const meta = {
    status: "queued",
    input: { job_title, cv_id, project_id },
    createdAt: new Date().toISOString(),
  };

  await redis.set(jobId, JSON.stringify(meta));

  await queue.add("evaluate", { jobId });

  res.status(202).json({ id: jobId, status: "queued" });
});

app.get("/result/:id", async (req, res) => {
  const id = req.params.id;
  let jobStr = await redis.get(id);
  if (!jobStr) return res.status(404).json({ error: "job missing" });

  let job = JSON.parse(jobStr);
  if (!job) return res.status(404).json({ error: "job not found" });

  let data = {
    id,
    status: job.status,
  };
  if (job.status === "completed") {
    data.result = job.result;
  }
  if (job.status === "failed") {
    data.error = job.error;
  }
  res.json(data);
});

app.get("/", (req, res) => res.send("AI CV Evaluator API"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API listening on ${PORT}`));

export { jobs };
