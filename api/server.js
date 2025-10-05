import express from "express";
import fs from "fs";
import path from "path";
import formidable from "formidable";
import { v4 as uuidv4 } from "uuid";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
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
const JWT_SECRET = process.env.JWT_SECRET || "supersecretkey";

async function initDefaultUser() {
  const existing = await redis.hgetall("users");
  if (Object.keys(existing).length === 0) {
    const passwordHash = await bcrypt.hash("password", 10);
    await redis.hset(
      "users",
      "admin",
      JSON.stringify({
        username: "admin",
        password: passwordHash,
        role: "admin",
        createdAt: new Date().toISOString(),
      })
    );
    console.log("Default user created: admin / password");
  } else {
    console.log("Users already initialized in Redis");
  }
}

function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Unauthorized" });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Invalid token" });
    req.user = user;
    next();
  });
}

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Missing username or password" });

  const userStr = await redis.hget("users", username);
  if (!userStr) return res.status(401).json({ error: "Invalid credentials" });

  const user = JSON.parse(userStr);
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });

  const token = jwt.sign(
    { username: user.username, role: user.role },
    JWT_SECRET,
    {
      expiresIn: "2h",
    }
  );
  res.json({ token });
});

app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Missing username or password" });

  const exists = await redis.hexists("users", username);
  if (exists) return res.status(400).json({ error: "User already exists" });

  const hash = await bcrypt.hash(password, 10);
  await redis.hset(
    "users",
    username,
    JSON.stringify({
      username,
      password: hash,
      role: "user",
      createdAt: new Date().toISOString(),
    })
  );

  res.json({ message: "User registered successfully" });
});

app.post("/upload", authenticateToken, (req, res) => {
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

app.post("/evaluate", authenticateToken, async (req, res) => {
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

app.get("/result/:id", authenticateToken, async (req, res) => {
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
app.listen(PORT, async () => {
  console.log(`API listening on ${PORT}`);
  await initDefaultUser();
});

export { jobs };
