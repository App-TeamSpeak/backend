import 'dotenv/config';
import { z } from 'zod';

const list = z.string().optional().transform((value) =>
  value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
);

export const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(10000),
  CORS_ORIGINS: list,
  FIREBASE_PROJECT_ID: z.string().min(1).optional(),
  FIREBASE_CLIENT_EMAIL: z.string().email().optional(),
  FIREBASE_PRIVATE_KEY: z.string().min(1).optional(),
  TURN_SERVER_URL: z.string().url().optional(),
  TURN_SERVER_USERNAME: z.string().optional(),
  TURN_SERVER_CREDENTIAL: z.string().optional(),
}).parse(process.env);
