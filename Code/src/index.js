// src/index.js
import 'dotenv/config';
import { createSupabaseClient } from './db/client.js';
import { createOpenRouterExtractor } from './llm/extractClaims.js';
import { createDuplicateJudge } from './llm/judgeDuplicate.js';
import { createContradictionJudge } from './llm/judgeContradiction.js';
import { createGeminiEmbedder } from './embeddings/embedText.js';
import { createDeepParsingClient } from './mcp-clients/deepParsingClient.js';
import { createGlobalSynthesisJudge } from './llm/globalSynthesis.js';
import { createRedisStateStore } from './scheduler/redisStateStore.js';
import { createAnalysisGraph } from './graph/index.js';
import { createScheduler } from './scheduler/index.js';

const POLL_INTERVAL_MS = 60_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`index.js: missing required environment variable ${name}`);
  }
  return value;
}

(async () => {
  const db = createSupabaseClient({
    url: requireEnv('SUPABASE_URL'),
    serviceKey: requireEnv('SUPABASE_SERVICE_KEY')
  });

  const heliconeApiKey = process.env.HELICONE_API_KEY || undefined;

  const extractClaims = createOpenRouterExtractor({ apiKey: requireEnv('OPENROUTER_API_KEY'), heliconeApiKey });
  const judgeDuplicate = createDuplicateJudge({ apiKey: requireEnv('OPENROUTER_API_KEY'), heliconeApiKey });
  const judgeContradiction = createContradictionJudge({ apiKey: requireEnv('OPENROUTER_API_KEY'), heliconeApiKey });
  const embedText = createGeminiEmbedder({ apiKey: requireEnv('GEMINI_API_KEY'), heliconeApiKey });
  const retryParse = createDeepParsingClient({ baseUrl: requireEnv('DEEP_PARSING_AGENT_URL') });
  const synthesizeDigest = createGlobalSynthesisJudge({ apiKey: requireEnv('OPENROUTER_API_KEY'), heliconeApiKey });
  const stateStore = createRedisStateStore({ redisUrl: requireEnv('REDIS_URL') });

  try {
    await stateStore.get('__startup_healthcheck__');
  } catch (err) {
    console.error('index.js: Redis unreachable at startup:', err.message);
    process.exit(1);
  }

  const runAnalysis = createAnalysisGraph({ db, extractClaims, embedText, judgeDuplicate, judgeContradiction, retryParse, synthesizeDigest });

  const telegramId = process.env.TELEGRAM_ALLOWED_USER_ID
    ? Number(process.env.TELEGRAM_ALLOWED_USER_ID)
    : undefined;

  const scheduler = createScheduler({
    db,
    stateStore,
    onBatchReady: runAnalysis,
    telegramId
  });

  console.log(`Information Analysis Agent: scheduler starting, polling every ${POLL_INTERVAL_MS}ms`);
  scheduler.start(POLL_INTERVAL_MS);
})();
