export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;

  APP_BASE_URL: string;
  JWT_SECRET: string;

  AI: Ai;
  LLM_PROVIDER?: "workers-ai" | "anthropic" | "openai";
  LLM_DAILY_LIMIT?: string;
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;

  SENDGRID_API_KEY?: string;
  EMAIL_FROM?: string;

  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REDIRECT_URI?: string;
};

export type Variables = {
  userId: string;
  userRole: "patient" | "doctor" | "admin";
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };
