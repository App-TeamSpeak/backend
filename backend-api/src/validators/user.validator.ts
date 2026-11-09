import { z } from 'zod';

// Username visible conserva mayúsculas; la reserva usa una clave en minúsculas.
export const usernameSchema = z.string().trim()
  .min(8).max(30).regex(/^[A-Za-z0-9_-]+$/);

export const userBodySchema = z.strictObject({
  nombre: z.string().trim().min(1).max(100),
  apellido: z.string().trim().min(1).max(100),
  username: usernameSchema,
  avatarUrl: z.string().trim().max(2048).url()
    .refine((value) => {
      try { return new URL(value).protocol === 'https:'; } catch { return false; }
    }, 'El avatar debe usar HTTPS.')
    .nullable().optional().transform((value) => value ?? null),
});

export type UserBody = z.infer<typeof userBodySchema>;
