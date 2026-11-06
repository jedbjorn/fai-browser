import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measure, SMALL_PAGES } from '../bench/tokens/measure.mjs';
import { createTokenizers } from '../bench/tokens/tokenizers.mjs';

test('offline tokenizers return sane counts on a fixed string', async () => {
  const tokenizers = await createTokenizers({ includeKimi: false });
  const text = 'The quick brown fox jumps over the lazy dog.';
  const byId = Object.fromEntries(tokenizers.map(tokenizer => [tokenizer.id, tokenizer]));
  assert.equal(byId.chars4.count(text), 11);
  assert.equal(byId.openaiO200k.count(text), 10);
  assert.equal(byId.openaiO200k.encoding, 'o200k_base');
  assert.equal(byId.claudeSonnet55.status, 'not measured in this run');
  assert.equal(byId.claudeOpus55.count, null);
});

test('token benchmark measures two real pages and writes complete sane artifacts', { timeout: 120_000 }, async t => {
  const out = await mkdtemp(join(tmpdir(), 'fai-tokens-test-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const data = await measure({ pageIds: SMALL_PAGES, outDir: out, quiet: true, includeKimi: false });
  assert.equal(data.pages.length, 2);
  assert.deepEqual(data.pages.map(page => page.id), SMALL_PAGES);
  assert.ok(data.versions.playwrightCore);
  assert.ok(data.versions.chromium);
  assert.ok(data.versions.mcpSdk);

  for (const page of data.pages) {
    for (const [name, measured] of Object.entries(page.samples)) {
      if (name.endsWith('Structured')) {
        assert.equal(measured.text, '');
        assert.equal(measured.chars, 0);
        assert.equal(measured.tokens.openaiO200k, 0);
      } else {
        assert.ok(measured.text.length > 0, `${page.id} ${name} has text`);
        assert.ok(measured.chars > 0, `${page.id} ${name} has characters`);
        assert.ok(measured.tokens.openaiO200k > 0, `${page.id} ${name} has tokens`);
      }
      assert.equal(measured.chars, measured.text.length);
      assert.equal(measured.tokens.claudeSonnet55, null);
    }
    assert.match(page.samples.playwrightOpen.text, /\[ref=e\d+\]/);
    assert.match(page.samples.playwrightAct.text, /\[ref=e\d+\]/);
    assert.match(page.samples.playwrightMcpOpen.text, /### Snapshot/);
    assert.equal(page.payloads.open.structuredContent, undefined);
    assert.equal(page.payloads.act.structuredContent, undefined);
    assert.equal(page.payloads.open.structuredJson, '');
    assert.equal(page.payloads.act.structuredJson, '');
    assert.equal(page.payloads.open.mcpText, page.samples.faiOpenText.text);
    assert.equal(page.payloads.open.hosts.codex, page.samples.faiOpenCodex.text);
    assert.equal(page.payloads.open.hosts.claude, page.samples.faiOpenClaude.text);
    assert.equal(page.payloads.open.hosts.openCode, page.samples.faiOpenOpenCode.text);
    assert.equal(page.action, 'scroll down');
  }
  for (const [id, comparison] of Object.entries(data.summary)) {
    const counts = comparison.tokenizers.openaiO200k;
    if (id.endsWith('Structured')) {
      assert.equal(counts.faiTokens, 0);
      assert.equal(counts.tokenRatio, null);
      assert.equal(comparison.charRatio, null);
    } else {
      assert.ok(counts.faiTokens > 0, id);
      assert.ok(counts.tokenRatio > 0, id);
      assert.ok(comparison.charRatio > 0, id);
    }
    assert.ok(counts.pwTokens > 0);
    assert.equal(comparison.tokenizers.claudeSonnet55.faiTokens, null);
  }

  const saved = JSON.parse(await readFile(join(out, 'results.json'), 'utf8'));
  assert.equal(saved.pages.length, 2);
  assert.equal(saved.baseline.open.structured, 674);
  const markdown = await readFile(join(out, 'results.md'), 'utf8');
  assert.match(markdown, /## Before \/ after: open result medians/);
  assert.match(markdown, /## Medians and ratios/);
  assert.match(markdown, /## Per page/);
  assert.match(markdown, /contact-form/);
  assert.match(markdown, /docs-cli/);
  assert.match(markdown, /## Caveats/);
});
