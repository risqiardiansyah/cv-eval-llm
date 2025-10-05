import "dotenv/config";
import { QdrantClient } from "@qdrant/js-client-rest";

const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || undefined;

const client = new QdrantClient({
  url: QDRANT_URL || "http://localhost:6333",
  apiKey: QDRANT_API_KEY || "",
});
// const client = new QdrantClient({ url: QDRANT_URL, apiKey: QDRANT_API_KEY });

export async function initCollection(COLLECTION, vectorSize = 1536) {
  const exists = await client.getCollections();
  const names = exists.collections.map((c) => c.name);

  if (!names.includes(COLLECTION)) {
    console.log(`Creating collection '${COLLECTION}'...`);
    await client.createCollection(COLLECTION, {
      vectors: {
        size: vectorSize,
        distance: "Cosine",
      },
    });
    console.log(`Collection '${COLLECTION}' created.`);
  } else {
    console.log(`Collection '${COLLECTION}' already exists.`);
  }
}

async function upsert(collection, points) {
  // points: [{id, vector, payload}]
  await client.upsert({ collection, points });
}

async function search(collection, vector, opts = { top: 5 }) {
  await initCollection(collection, vector.length);
  const res = await client.search(collection, {
    vector,
    limit: opts.top,
    with_payload: true,
  });
  return res;
}

export { client, upsert, search };
