import { z } from 'zod';

export const roomBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
});
