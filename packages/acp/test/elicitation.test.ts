/** Form answers are checked against requestedSchema. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AcpClient, serveAgent, validateElicitation, type ElicitationResponse } from '@deft-subspace/acp';
import { byteLink } from './helpers.ts';

const form = {
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 2, maxLength: 10 },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0, maximum: 150 },
    color: { type: 'string', enum: ['red', 'blue'] },
    size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }, { const: 'l', title: 'Large' }] },
    tags: { type: 'array', items: { enum: ['a', 'b', 'c'] }, minItems: 1, maxItems: 2 },
    agree: { type: 'boolean' },
    when: { type: 'string', format: 'date' },
  },
  required: ['name', 'agree'],
};

test('validateElicitation accepts a fitting answer', () => {
  assert.deepEqual(
    validateElicitation(form, { name: 'Ada', email: 'ada@example.test', age: 36, color: 'red', size: 'l', tags: ['a', 'c'], agree: true, when: '2026-11-07' }),
    []
  );
  assert.deepEqual(validateElicitation(form, { name: 'Ada', agree: false }), [], 'optional fields may be left out');
});

test('validateElicitation names every problem', () => {
  assert.deepEqual(validateElicitation(form, { email: 'nope', age: 1.5, color: 'green', size: 'm', tags: ['a', 'b', 'z'], agree: 'yes', when: '7/11', extra: 1 }), [
    'name is required',
    'email must be a valid email',
    'age must be an integer',
    'color must be one of "red", "blue"',
    'size must be one of "s", "l"',
    'tags allows at most 2 choices',
    'tags: "z" is not one of the choices',
    'agree must be true or false',
    'when must be a valid date',
    'extra is not a field of this form',
  ]);
  assert.deepEqual(validateElicitation(form, { name: 'A', agree: true, age: 200 }), ['name must be at least 2 characters', 'age must be at most 150']);
  assert.deepEqual(validateElicitation(form, ['x']), ['the answer must be an object']);
});

test('validateElicitation: no schema, or keywords outside the subset, accept', () => {
  assert.deepEqual(validateElicitation(undefined, { anything: 1 }), []);
  assert.deepEqual(validateElicitation({ type: 'object', properties: { n: { type: 'string', pattern: '^x' } } }, { n: 'y' }), []);
});

for (const protocol of [1, 2] as const) {
  test(`v${protocol}: an accepted answer that does not fit the form reaches the agent as decline`, async () => {
    const answers: unknown[] = [];
    const link = byteLink();
    serveAgent(link.agent, {
      name: 'asker',
      protocols: [protocol],
      prompt: async (turn) => {
        for (const message of ['good', 'bad']) answers.push(await turn.elicit({ message, requestedSchema: form }));
        return 'end_turn';
      },
    });
    const client = await AcpClient.connect(link.client, {
      elicitation: (request): ElicitationResponse =>
        request.message === 'good' ? { action: 'accept', content: { name: 'Ada', agree: true } } : { action: 'accept', content: { name: 'Ada' } },
    });
    await (await client.newSession({ cwd: '/w' })).prompt('go').done;
    assert.deepEqual(answers, [{ action: 'accept', content: { name: 'Ada', agree: true } }, { action: 'decline' }]);
    await client.close();
  });
}

test('elicitationModes: only the listed modes are advertised; others are declined unasked', async () => {
  const link = byteLink();
  let seen: unknown;
  const asked: string[] = [];
  serveAgent(link.agent, {
    name: 'asker',
    protocols: [2],
    prompt: async (turn) => {
      seen = turn.clientSupports.elicitation;
      asked.push((await turn.elicit({ message: 'name?', requestedSchema: { type: 'object', properties: { n: { type: 'string' } } } })).action);
      return 'end_turn';
    },
  });
  const client = await AcpClient.connect(link.client, {
    elicitationModes: ['form'],
    elicitation: () => ({ action: 'accept', content: { n: 'x' } }),
  });
  await (await client.newSession({ cwd: '/w' })).prompt('go').done;
  assert.deepEqual(seen, { form: true, url: false });
  assert.deepEqual(asked, ['accept']);
  await client.close();
});
