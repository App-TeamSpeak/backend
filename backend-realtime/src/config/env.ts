import 'dotenv/config';
import { z } from 'zod';

const list = z.string().optional().transform((value) =>
  value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [],
);

const optionalSetting = (schema: z.ZodType<string>) => z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value, schema.optional(),
);

export const env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(10000),
  CORS_ORIGINS: list,
  FIREBASE_EXPECTED_PROJECT_ID: optionalSetting(z.string().min(1)),
  TEAMSPEAK_ENABLE_REALTIME_EMULATOR_TESTS: optionalSetting(z.enum(['true', 'false'])),
  FIREBASE_PROJECT_ID: optionalSetting(z.string().min(1)),
  FIREBASE_CLIENT_EMAIL: optionalSetting(z.string().email()),
  FIREBASE_PRIVATE_KEY: optionalSetting(z.string().min(1)),
  TURN_SERVER_URL: z.string().url().optional(),
  TURN_SERVER_USERNAME: z.string().optional(),
  TURN_SERVER_CREDENTIAL: z.string().optional(),
}).parse(process.env);
