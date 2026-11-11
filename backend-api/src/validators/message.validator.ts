import { z } from 'zod';

export const messageBodySchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
});

export type MessageBody = z.infer<typeof messageBodySchema>;
