/**
 * #2200-class — the remaining same-class by-slug read ops honor the federated
 * source grant.
 *
 * v0.42.46.0 (#2200) routed get_page tags + get_tags/get_links/get_backlinks/
 * get_timeline through the federated source scope. The adversarial review
 * flagged siblings in the SAME class that still used scalar-only
 * `ctx.sourceId ? {sourceId} : {}` and never threaded ctx.auth.allowedSources:
 *   - get_chunks   (scalar-only → 'default' fallback, wrong source for a
 *                   federated client; unscoped default bleed)
 *   - get_raw_data (scalar-only → unscoped cross-source read with no scope)
 *   - get_versions (scalar-only → unscoped cross-source read with no scope)
 *   - code_def / code_refs (brain-wide raw SQL over content_chunks, no grant;
 *                   remote callers now scope to the grant and FAIL CLOSED
 *                   with no source in scope)
 *
 * (resolve_slugs was already closed by #3242; takes_list/search/scorecard/
 * calibration already routed through sourceScopeOpts.)
 *
 * Coverage mirrors get-page-federated-scope.test.ts:
 *   - federated grant [alpha,beta] reads the beta slug's data, never the
 *     'default' decoy's (same-slug cross-source bleed guard)
 *   - grant [alpha] only → empty, never the beta/default data (isolation)
 *   - sourceIds[] precedence over scalar sourceId
 *   - code_def/code_refs: remote grant scopes results; remote with NO grant
 *     fails closed (permission_denied); trusted local stays brain-wide.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations, OperationError, type OperationContext } from '../src/core/operations.ts';
import { importCodeFile } from '../src/core/import-file.ts';

let engine: PGLiteEngine;
const get_chunks = operations.find(o => o.name === 'get_chunks')!;
const get_raw_data = operations.find(o => o.name === 'get_raw_data')!;
const get_versions = operations.find(o => o.name === 'get_versions')!;
const code_def = operations.find(o => o.name === 'code_def')!;
const code_refs = operations.find(o => o.name === 'code_refs')!;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

function remoteCtx(allowedSources: string[]): OperationContext {
  // Federated remote client: no scalar ctx.sourceId, grant via allowedSources.
  return ctxOf({ remote: true, sourceId: undefined, auth: { token: 't', clientId: 'c', scopes: [], allowedSources } as any });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('alpha', 'alpha', '/tmp/alpha') ON CONFLICT (id) DO NOTHING`);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('beta', 'beta', '/tmp/beta') ON CONFLICT (id) DO NOTHING`);

  // Beta page with chunks + raw data + version history.
  await engine.putPage('secret/beta-doc', {
    type: 'note', title: 'Beta secret', compiled_truth: 'beta-only content', frontmatter: {},
  }, { sourceId: 'beta' });
  await engine.upsertChunks('secret/beta-doc', [{
    chunk_index: 0,
    chunk_text: 'beta-only chunk text',
    chunk_source: 'compiled_truth',
  }], { sourceId: 'beta' });
  await engine.putRawData('secret/beta-doc', 'crustdata', { beta_field: 'beta-value' }, { sourceId: 'beta' });
  await engine.createVersion('secret/beta-doc', { sourceId: 'beta' });

  // Same-slug page in 'default' with DIFFERENT data — the cross-source bleed
  // guard. A federated read scoped to [alpha,beta] must NEVER surface these.
  await engine.putPage('secret/beta-doc', {
    type: 'note', title: 'Default decoy', compiled_truth: 'default content', frontmatter: {},
  }, { sourceId: 'default' });
  await engine.upsertChunks('secret/beta-doc', [{
    chunk_index: 0,
    chunk_text: 'default decoy chunk text',
    chunk_source: 'compiled_truth',
  }], { sourceId: 'default' });
  await engine.putRawData('secret/beta-doc', 'crustdata', { default_field: 'default-value' }, { sourceId: 'default' });
  await engine.createVersion('secret/beta-doc', { sourceId: 'default' });

  // Alpha page (in-grant sanity check for [alpha]).
  await engine.putPage('shared/alpha-doc', {
    type: 'note', title: 'Alpha doc', compiled_truth: 'alpha content', frontmatter: {},
  }, { sourceId: 'alpha' });
  await engine.upsertChunks('shared/alpha-doc', [{
    chunk_index: 0,
    chunk_text: 'alpha chunk text',
    chunk_source: 'compiled_truth',
  }], { sourceId: 'alpha' });

  // Code pages for code_def/code_refs: same file basename in two sources.
  // importCodeFile slugs from the relative path, so give each source a
  // distinct path but the same symbol name.
  await importCodeFile(engine, 'src/leak-fixture.ts', `export function leakySymbol(): number {
  return 42;
}
`, { noEmbed: true, sourceId: 'beta' });
  await importCodeFile(engine, 'src/leak-fixture.ts', `export function leakySymbol(): number {
  return 1;
}
`, { noEmbed: true, sourceId: 'default' });
});

describe('#2200-class get_chunks honors the federated grant', () => {
  test('[alpha,beta] returns the beta page chunks, not the default decoy', async () => {
    const chunks = await get_chunks.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' }) as any[];
    expect(chunks.length).toBe(1);
    expect(chunks[0].chunk_text).toBe('beta-only chunk text');
  });

  test('[alpha] only → empty, never the default decoy chunks (isolation)', async () => {
    const chunks = await get_chunks.handler(remoteCtx(['alpha']), { slug: 'secret/beta-doc' }) as any[];
    expect(chunks).toEqual([]);
  });

  test('scalar ctx.sourceId still scopes (v0.31.8 D20 preserved)', async () => {
    const chunks = await get_chunks.handler(ctxOf({ remote: false, sourceId: 'alpha' }), { slug: 'secret/beta-doc' }) as any[];
    expect(chunks).toEqual([]);
    const beta = await get_chunks.handler(ctxOf({ remote: false, sourceId: 'beta' }), { slug: 'secret/beta-doc' }) as any[];
    expect(beta[0].chunk_text).toBe('beta-only chunk text');
  });
});

describe('#2200-class get_raw_data honors the federated grant', () => {
  test('[alpha,beta] returns the beta page raw data, not the default decoy', async () => {
    const rows = await get_raw_data.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' }) as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].data.beta_field).toBe('beta-value');
  });

  test('[alpha] only → empty, never the default decoy rows (isolation)', async () => {
    const rows = await get_raw_data.handler(remoteCtx(['alpha']), { slug: 'secret/beta-doc' }) as any[];
    expect(rows).toEqual([]);
  });

  test('per-data-source filter still applies within the grant', async () => {
    const rows = await get_raw_data.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc', source: 'nonexistent' }) as any[];
    expect(rows).toEqual([]);
  });
});

describe('#2200-class get_versions honors the federated grant', () => {
  test('[alpha,beta] returns the beta page versions, not the default decoy', async () => {
    const versions = await get_versions.handler(remoteCtx(['alpha', 'beta']), { slug: 'secret/beta-doc' }) as any[];
    expect(versions.length).toBe(1);
    expect(versions[0].compiled_truth).toBe('beta-only content');
  });

  test('[alpha] only → empty, never the default decoy versions (isolation)', async () => {
    const versions = await get_versions.handler(remoteCtx(['alpha']), { slug: 'secret/beta-doc' }) as any[];
    expect(versions).toEqual([]);
  });
});

describe('#2200-class code_def / code_refs scope remote callers to their grant', () => {
  test('remote grant [beta] finds the beta definition only', async () => {
    const res: any = await code_def.handler(remoteCtx(['beta']), { symbol: 'leakySymbol' });
    expect(res.count).toBe(1);
    expect(res.defs[0].snippet).toContain('return 42');
  });

  test('remote grant [default] finds the default definition only', async () => {
    const res: any = await code_def.handler(remoteCtx(['default']), { symbol: 'leakySymbol' });
    expect(res.count).toBe(1);
    expect(res.defs[0].snippet).toContain('return 1');
  });

  test('remote grant [alpha] → zero results, never another source\'s code (isolation)', async () => {
    const res: any = await code_def.handler(remoteCtx(['alpha']), { symbol: 'leakySymbol' });
    expect(res.count).toBe(0);
    expect(res.defs).toEqual([]);
  });

  test('remote caller with NO grant and NO scalar scope fails closed', async () => {
    const ctx = ctxOf({ remote: true, sourceId: undefined, auth: undefined });
    await expect(code_def.handler(ctx, { symbol: 'leakySymbol' })).rejects.toBeInstanceOf(OperationError);
    await expect(code_refs.handler(ctx, { symbol: 'leakySymbol' })).rejects.toBeInstanceOf(OperationError);
  });

  test('code_refs: remote grant [beta] finds only the beta usage site', async () => {
    const res: any = await code_refs.handler(remoteCtx(['beta']), { symbol: 'leakySymbol' });
    expect(res.count).toBe(1);
    expect(res.refs[0].snippet).toContain('return 42');
  });

  test('code_refs: remote grant [alpha] → zero results (isolation)', async () => {
    const res: any = await code_refs.handler(remoteCtx(['alpha']), { symbol: 'leakySymbol' });
    expect(res.count).toBe(0);
  });

  test('trusted local caller stays brain-wide (finds BOTH same-slug definitions)', async () => {
    const res: any = await code_def.handler(ctxOf({ remote: false, sourceId: undefined }), { symbol: 'leakySymbol' });
    expect(res.count).toBe(2);
    const snippets = res.defs.map((d: any) => d.snippet).sort();
    expect(snippets[0]).toContain('return 1');
    expect(snippets[1]).toContain('return 42');
  });
});
