# AI CV & Project Evaluator — Integrate LLM & Qdrant

A modular backend system for evaluating CVs and project portfolios using **OpenAI LLM** and **Qdrant vector database**.  
The system extracts text embeddings, stores them as vectors, and performs semantic search to evaluate candidates skills and experiences.

---

## Tech Stack

- **Backend**: Node.js (Express)
- **Vector DB**: Qdrant
- **Worker Queue**: BullMQ + Redis
- **LLM Integration**: OpenAI GPT
- **Containerization**: Docker Compose

---

## Quickstart (Local)

1. **Clone Repository**
   ```bash
   git clone https://github.com/risqiardiansyah/cv-eval-llm
   cd cv-eval-llm
2. **Setup Environment**    
   ```bash
   cp api/.env.example api/.env
   ```
   Simply fill
   ```bash
   OPENAI_API_KEY=your_api_key_here
4. **Install API Dependencies**
   ```bash
   cd api
   npm install
   cd ..
5. **Run with Docker Compose**
   ```bash
   docker compose up --build
6. Test the Flow
   - Upload sample files:
     ```bash
     POST /upload
   - Start evaluation:
     ```bash
     POST /evaluate
   - Check result:
     ```bash
     GET /result/{id}

## How It Works
1. **Upload Phase**
   - PDF Documents (CV & Project) are uploaded via /upload.
   - The system extracts text and stores embeddings in Qdrant.

2. **Evaluation Phase**
   - The worker retrieves vectors from Qdrant using cosine similarity.
   - It passes the context to the LLM for semantic scoring.
   - Results are stored and retrievable via /result/{id}.
     
3. **Result**
   - Returns a structured JSON CV & Project score.
  
## API Endpoints
| Method | Endpoint      | Description                    |
| ------ | ------------- | ------------------------------ |
| `POST` | `/upload`     | Upload CV and project documents |
| `POST` | `/evaluate`   | Trigger evaluation process     |
| `GET`  | `/result/:id` | Retrieve evaluation result     |

## Environment Variables
| Variable            | Description                                                 | Example                                    |
| ------------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `PORT`              | Port number for the API server                              | `3000`                                     |
| `UPLOAD_DIR`        | Directory path where uploaded files are stored              | `./uploads`                                |
| `REDIS_URL`         | Redis connection URL used by BullMQ                         | `redis://redis:6379`                       |
| `QDRANT_URL`        | Base URL of the Qdrant vector database                      | `http://qdrant:6333`                       |
| `OPENAI_API_BASE`   | Optional custom base URL for OpenAI-compatible API endpoint | `https://api.openai.com/v1`                |
| `OPENAI_API_KEY`    | OpenAI API key used for LLM requests                        | `sk-xxxxxxxxxxxxxxxxxxxxx`                 |
| `QDRANT_COLLECTION` | Qdrant collection name for storing vector embeddings        | `system_docs`                              |

## Notes
The worker extracts embeddings and queries Qdrant for context,
then calls the LLM to generate semantic scores for each uploaded CV and project.
