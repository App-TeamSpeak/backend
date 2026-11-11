import { z } from 'zod';

// Username visible conserva mayúsculas; la reserva usa una clave en minúsculas.
export const usernameSchema = z.string().trim()
  .min(8).max(30).regex(/^[A-Za-z0-9_-]+$/);

const editableFields = {
  nombre: z.string().trim().min(1).max(100),
  apellido: z.string().trim().min(1).max(100),
  username: usernameSchema,
  avatarUrl: z.string().trim().max(2048).url()
    .refine((value) => {
      try { return new URL(value).protocol === 'https:'; } catch { return false; }
    }, 'El avatar debe usar HTTPS.')
    .nullable(),
};

export const userBodySchema = z.strictObject({
  ...editableFields,
  avatarUrl: editableFields.avatarUrl.optional().transform((value) => value ?? null),
});

export const userPatchSchema = z.strictObject(editableFields).partial()
  .refine((value) => Object.values(value).some((field) => field !== undefined),
    'Envía al menos un campo editable.');

export type UserPatch = z.infer<typeof userPatchSchema>;

export type UserBody = z.infer<typeof userBodySchema>;
