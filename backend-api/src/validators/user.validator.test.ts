import { describe, expect, it } from 'vitest';
import { userBodySchema } from './user.validator';
const valid = { nombre: ' Ana ', apellido: ' Pérez ', username: ' ANA_User1 ' };
describe('user profile validation', () => {
  it('trims names, preserves username case and defaults avatar', () => {
    expect(userBodySchema.parse(valid)).toEqual({ nombre: 'Ana', apellido: 'Pérez', username: 'ANA_User1', avatarUrl: null });
  });
  it.each([
    { ...valid, avatarUrl: '' }, { ...valid, avatarUrl: 'not-a-url' }, {}, { ...valid, nombre: '' }, { ...valid, apellido: ' ' }, { ...valid, nombre: 3 },
    { ...valid, username: 'a'.repeat(7) }, { ...valid, username: 'a'.repeat(31) }, { ...valid, username: '../abc' },
    { ...valid, username: 'ana pérez' }, { ...valid, uid: 'other' }, { ...valid, email: 'other@example.com' },
    { ...valid, avatarUrl: 'javascript:alert(1)' }, { ...valid, avatarUrl: 'http://example.com/a.png' },
  ])('rejects invalid or unauthorized input %j', (value) => expect(userBodySchema.safeParse(value).success).toBe(false));
  it.each(['abcdefgh', '12345678', 'Abcd-123', 'a'.repeat(30)])('accepts valid usernames without mandatory combinations: %s', (username) => {
    expect(userBodySchema.parse({ ...valid, username }).username).toBe(username);
  });
  it('accepts an optional HTTPS avatar', () => expect(userBodySchema.parse({ ...valid, avatarUrl: 'https://example.com/a.png' }).avatarUrl).toBe('https://example.com/a.png'));
});
