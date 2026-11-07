/**
 * A stdio agent (official SDK, v1) for start(): needs a login before
 * session/new, offers modes "auto" and "ask", asks permission, then replies.
 */
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

let loggedIn = false;
const modes = new Map<string, string>();
acp
  .agent({ name: 'login-agent' })
  .onRequest('initialize', () => ({
    protocolVersion: 1,
    agentCapabilities: {},
    agentInfo: { name: 'login-agent', version: '1.0.0' },
    authMethods: [{ id: 'browser', name: 'Log in with a browser' }],
  }))
  .onRequest('authenticate', () => {
    loggedIn = true;
    return {};
  })
  .onRequest('session/new', () => {
    if (!loggedIn) throw acp.RequestError.authRequired();
    const sessionId = `s${modes.size + 1}`;
    modes.set(sessionId, 'auto');
    return { sessionId, modes: { currentModeId: 'auto', availableModes: [{ id: 'auto', name: 'Auto' }, { id: 'ask', name: 'Ask first' }] } };
  })
  .onRequest('session/set_mode', ({ params }) => {
    modes.set(params.sessionId, params.modeId);
    return {};
  })
  .onRequest('session/prompt', async ({ params, client }) => {
    const say = (text: string) =>
      client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
    const answer = await client.request('session/request_permission', {
      sessionId: params.sessionId,
      toolCall: { toolCallId: 't1', title: 'Write notes.md', kind: 'edit' },
      options: [
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    });
    const allowed = answer.outcome.outcome === 'selected' && answer.outcome.optionId === 'yes';
    await say(`mode=${modes.get(params.sessionId)} allowed=${allowed}`);
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
