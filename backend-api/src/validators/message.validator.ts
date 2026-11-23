import { z } from 'zod';

export const messageBodySchema = z.strictObject({
  text: z.string().trim().min(1).max(2000),
});

export type MessageBody = z.infer<typeof messageBodySchema>;

const cursorSchema = z.tuple([
  z.number().int().min(-62135596800).max(253402300799),
  z.number().int().min(0).max(999999999),
  z.string().min(1).refine(id => Buffer.byteLength(id) <= 1500 && !/\/|^\.{1,2}$|^__.*__$/.test(id)),
]);

export const messageHistoryQuerySchema = z.object({
  limit: z.string().regex(/^[0-9]{1,3}$/).transform(Number)
    .pipe(z.number().int().min(1).max(100)).optional(),
  cursor: z.string().max(4096).regex(/^[A-Za-z0-9_-]+$/).transform((value, context) => {
    try {
      const bytes = Buffer.from(value, 'base64url');
      if (bytes.toString('base64url') === value) return JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      // Invalid base64url or JSON is a validation error.
    }
    context.addIssue({ code: 'custom', message: 'El cursor del historial no es válido.' });
    return z.NEVER;
  }).pipe(cursorSchema).optional(),
});

export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;
