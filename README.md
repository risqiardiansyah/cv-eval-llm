# AI CV & Project Evaluator — Skeleton Repo (Integrated LLM & Qdrant)

## Quickstart (local)

1. Copy `api/.env.example` to `api/.env` and fill values (OPENAI_API_KEY, QDRANT_URL, etc).
2. Build and run with Docker Compose: `docker compose up --build`
3. Install API deps: `cd api && npm install`
4. Install ingestion deps: `pip install -r ingest/requirements.txt`
5. Upload sample documents via `/upload`, then call `/evaluate` and poll `/result/{id}`.

## Notes
- The worker extracts embeddings and queries Qdrant for context, then calls LLM to score.
- Replace placeholder PDF extraction with a real extractor if desired.
