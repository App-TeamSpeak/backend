import { describe, expect, it } from 'vitest';
import { openapi } from './openapi';
import { userBodySchema } from '../validators/user.validator';

// Checks the subset of OpenAPI used by these examples, without adding a dependency.
function matches(value: unknown, schema: Record<string, any>): boolean {
  if (schema.$ref) return matches(value, (openapi.components.schemas as Record<string, any>)[schema.$ref.split('/').at(-1)]);
  if (value === null) return !!schema.nullable;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    if (schema.minProperties && Object.keys(object).length < schema.minProperties) return false;
    if (schema.required?.some((key: string) => !(key in object))) return false;
    return Object.entries(object).every(([key, item]) => schema.properties?.[key]
      ? matches(item, schema.properties[key]) : schema.additionalProperties !== false);
  }
  if (schema.type && typeof value !== schema.type) return false;
  if (schema.pattern && !new RegExp(schema.pattern).test(String(value))) return false;
  return true;
}
const profile = { uid: 'uid-1', email: 'ana@example.com', nombre: 'Ana', apellido: 'Pérez', username: 'Ana-User1', usernameKey: 'ana-user1', avatarUrl: null, profileStatus: 'complete', createdAt: '2026-11-09T00:00:00.000Z', updatedAt: '2026-11-09T00:00:00.000Z' };
describe('OpenAPI user contracts', () => {
  it.each([
    { uid: profile.uid, profileStatus: 'incomplete', profile: null },
    { uid: profile.uid, profileStatus: 'complete', profile },
  ])('represents complete and incomplete responses including null', (data) => {
    expect(matches({ success: true, data }, openapi.components.schemas.UserResponse)).toBe(true);
  });
  it('requires actual profile fields', () => {
    expect(matches({ success: true, data: { uid: profile.uid, profileStatus: 'complete', profile: { username: 'Ana-User1' } } }, openapi.components.schemas.UserResponse)).toBe(false);
  });
  it('uses a directly typed nullable object without allOf', () => {
    const schema = openapi.components.schemas.UserResponse.properties.data.properties.profile;
    expect(schema.type).toBe('object'); expect(schema.nullable).toBe(true); expect(schema).not.toHaveProperty('allOf');
  });
  it.each(['Ana-User1', '  Ana-User1  ', '\tAna-User1\n'])('allows normalized outer spaces in input schema: %j', (username) => {
    const input = { nombre: ' Ana ', apellido: ' Pérez ', username };
    expect(matches(input, openapi.components.schemas.UserInput)).toBe(true);
    expect(userBodySchema.parse(input).username).toBe('Ana-User1');
  });
  it('rejects internal username spaces in schema and implementation', () => {
    const input = { nombre: 'Ana', apellido: 'Pérez', username: 'Ana User1' };
    expect(matches(input, openapi.components.schemas.UserInput)).toBe(false);
    expect(userBodySchema.safeParse(input).success).toBe(false);
  });
  it('documents creation, recovery/idempotence, conflicts and errors', () => {
    const route = openapi.paths['/api/users/me'];
    expect(Object.keys(route.post.responses)).toEqual(expect.arrayContaining(['200', '201', '400', '401', '409', '500', '503']));
    expect(route.post.responses[409].description).toContain('PROFILE_INCONSISTENT');
    expect(route.get.responses[409].description).toContain('PROFILE_INCONSISTENT');
    expect(route.post.security).toEqual([{ bearerAuth: [] }]);
  });
  it('documents partial input without required fields and rejects empty/unknown payloads', () => {
    const schema = openapi.components.schemas.UserPatch;
    expect(matches({ nombre: ' Ana María ' }, schema)).toBe(true);
    expect(matches({ avatarUrl: null }, schema)).toBe(true);
    expect(matches({}, schema)).toBe(false);
    expect(matches({ uid: 'other' }, schema)).toBe(false);
    expect(schema).not.toHaveProperty('required');
    const patch = openapi.paths['/api/users/me'].patch;
    expect(patch.security).toEqual([{ bearerAuth: [] }]);
    expect(Object.keys(patch.responses)).toEqual(expect.arrayContaining(['200', '400', '401', '404', '409', '500', '503']));
    for (const example of Object.values(patch.requestBody.content['application/json'].examples)) {
      expect(matches(example.value, schema)).toBe(true);
    }
  });

});
