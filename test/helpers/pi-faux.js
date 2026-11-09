// A pi extension for test/pi-host.test.js only: registers pi's built-in faux provider (provider `faux`, model `faux-1`,
// no API key, no network) with scripted answers, and records each model call to $FAUX_LOG as one JSON line. A user
// message containing CALLSTATUS makes the model call mcp__fai_browser__fai_browser_status once; anything else gets a
// short text answer. Loaded by pi with `-e`; `@earendil-works/pi-ai` resolves to pi's own copy.
import { appendFileSync } from 'node:fs';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';

const textOf = message => {
  const content = message?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map(part => part?.text ?? '').join('') : '';
};

export default function piFaux(pi) {
  const log = entry => {
    if (process.env.FAUX_LOG) appendFileSync(process.env.FAUX_LOG, `${JSON.stringify(entry)}\n`);
  };
  const faux = fauxProvider({ provider: 'faux', models: [{ id: 'faux-1' }] });
  faux.setResponses(Array.from({ length: 50 }, () => context => {
    const last = context.messages.at(-1);
    const lastUser = [...context.messages].reverse().find(message => message.role === 'user');
    // pi 1.5 carries the system prompt, its sections and the tool declarations in system messages.
    const system = JSON.stringify(context.messages.filter(message => message.role === 'system'));
    log({ event: 'model_call', lastRole: last?.role, lastUser: textOf(lastUser).slice(0, 2000),
      faiSection: system.includes('<fai-browser>') && system.includes('mcp__fai_browser__fai_browser_open'),
      tools: [...new Set(system.match(/mcp__fai_browser__[a-z_]+/g) ?? [])] });
    if (last?.role === 'user' && textOf(last).includes('CALLSTATUS')) {
      return fauxAssistantMessage(fauxToolCall('mcp__fai_browser__fai_browser_status', {}), { stopReason: 'toolUse' });
    }
    return fauxAssistantMessage('ok');
  }));
  pi.registerProvider(faux.provider);
}
