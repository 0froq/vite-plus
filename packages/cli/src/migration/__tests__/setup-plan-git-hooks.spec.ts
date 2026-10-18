import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import * as prompts from '@voidzero-dev/vite-plus-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PackageManager } from '../../types/index.js';

vi.mock('@voidzero-dev/vite-plus-prompts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@voidzero-dev/vite-plus-prompts')>();
  return {
    ...mod,
    select: vi.fn(),
    confirm: vi.fn(),
    log: { ...mod.log, info: vi.fn(), warn: vi.fn() },
  };
});

const { collectMigrationSetupPlan } = await import('../setup-plan.js');

const mockSelect = vi.mocked(prompts.select);
const mockConfirm = vi.mocked(prompts.confirm);

describe('collectMigrationSetupPlan existing Vite+ hooks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-test-setup-plan-hooks-'));
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    fs.mkdirSync(path.join(tmpDir, '.vite-hooks'));
    fs.writeFileSync(path.join(tmpDir, '.vite-hooks', 'commit-msg'), 'echo msg\n');
    fs.writeFileSync(path.join(tmpDir, '.vite-hooks', 'pre-commit'), 'vp staged\n');
    fs.writeFileSync(path.join(tmpDir, '.vite-hooks', 'README.md'), 'not a hook\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function collect(options: { interactive: boolean; hooks?: boolean }) {
    return collectMigrationSetupPlan(
      tmpDir,
      PackageManager.pnpm,
      { ...options, agent: false, editor: false },
      [],
      false,
    );
  }

  it('lists detected hooks and keeps them by default', async () => {
    mockSelect.mockResolvedValueOnce('keep');

    const plan = await collect({ interactive: true });

    expect(plan.shouldSetupHooks).toBe(true);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockSelect).toHaveBeenCalledTimes(1);
    const [selectOptions] = mockSelect.mock.calls[0];
    expect(selectOptions.message).toBe(
      'Git hooks already configured in .vite-hooks/ (pre-commit, commit-msg)',
    );
    expect(selectOptions.initialValue).toBe('keep');
    expect(selectOptions.options.map((option) => option.value)).toEqual(['keep', 'skip']);
  });

  it('skips git hooks setup when Skip is selected', async () => {
    mockSelect.mockResolvedValueOnce('skip');

    const plan = await collect({ interactive: true });

    expect(plan.shouldSetupHooks).toBe(false);
  });

  it('keeps existing hooks without prompting in non-interactive mode', async () => {
    const plan = await collect({ interactive: false });

    expect(plan.shouldSetupHooks).toBe(true);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it.each([true, false])('bypasses the prompt when --hooks=%s is passed', async (hooks) => {
    const plan = await collect({ interactive: true, hooks });

    expect(plan.shouldSetupHooks).toBe(hooks);
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockConfirm).not.toHaveBeenCalled();
  });
});
