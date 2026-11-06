import 'dotenv/config';
import { z } from 'zod';

const optionalUrlList = z.string().optional().transform((value) =>
  value
    ?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? [],
);

const optionalSetting = (schema: z.ZodType<string>) => z.preprocess(
  (value) => typeof value === 'string' && !value.trim() ? undefined : value,
  schema.optional(),
);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(10000),
  CORS_ORIGINS: optionalUrlList,
  FIREBASE_PROJECT_ID: optionalSetting(z.string().min(1)),
  FIREBASE_CLIENT_EMAIL: optionalSetting(z.string().email()),
  FIREBASE_PRIVATE_KEY: optionalSetting(z.string().min(1)),
});

export const env = schema.parse(process.env);
