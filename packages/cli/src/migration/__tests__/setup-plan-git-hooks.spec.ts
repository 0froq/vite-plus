import { spawnSync } from 'node:child_process';
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
const { installGitHooks, isViteHooksSetupComplete } = await import('../migrator.js');

const mockSelect = vi.mocked(prompts.select);
const mockConfirm = vi.mocked(prompts.confirm);
const mockInfo = vi.mocked(prompts.log.info);

const SKIP_MESSAGE = 'Git hooks already configured, skipping';

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
}

function writePackageJson(dir: string, pkg: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
}

function readPackageJson(dir: string): { scripts?: Record<string, string> } {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

/** Simulate what `vp config` leaves behind: dispatcher files and core.hooksPath. */
function installDispatcher(dir: string, hookNames: string[]) {
  const dispatcherDir = path.join(dir, '.vite-hooks', '_');
  fs.mkdirSync(dispatcherDir, { recursive: true });
  fs.writeFileSync(path.join(dispatcherDir, 'h'), '#!/usr/bin/env sh\n');
  for (const hookName of hookNames) {
    fs.writeFileSync(
      path.join(dispatcherDir, hookName),
      '#!/usr/bin/env sh\n. "$(dirname "$0")/h"',
    );
  }
  git(dir, 'config', 'core.hooksPath', '.vite-hooks/_');
}

function expectNoHooksPrompt() {
  expect(mockConfirm).not.toHaveBeenCalled();
  expect(mockSelect).not.toHaveBeenCalled();
}

describe('collectMigrationSetupPlan existing Vite+ hooks', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vp-test-setup-plan-hooks-'));
    writePackageJson(tmpDir, {});
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function writeProjectHooks() {
    fs.mkdirSync(path.join(tmpDir, '.vite-hooks'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.vite-hooks', 'commit-msg'), 'echo msg\n');
    fs.writeFileSync(path.join(tmpDir, '.vite-hooks', 'pre-commit'), 'npm test\n');
  }

  function setUpFullyConfiguredHooks() {
    git(tmpDir, 'init', '-q');
    writePackageJson(tmpDir, { scripts: { prepare: 'vp config' } });
    writeProjectHooks();
    installDispatcher(tmpDir, ['commit-msg', 'pre-commit']);
  }

  function collect(options: { interactive: boolean; hooks?: boolean }) {
    return collectMigrationSetupPlan(
      tmpDir,
      PackageManager.pnpm,
      { ...options, agent: false, editor: false },
      [],
      false,
    );
  }

  describe('fully configured hooks', () => {
    beforeEach(setUpFullyConfiguredHooks);

    it('is detected as complete', () => {
      expect(isViteHooksSetupComplete(tmpDir)).toBe(true);
    });

    it.each([true, false])(
      'skips the hooks step without prompting (interactive=%s)',
      async (interactive) => {
        const plan = await collect({ interactive });

        expect(plan.shouldSetupHooks).toBe(false);
        expectNoHooksPrompt();
        expect(mockInfo).toHaveBeenCalledWith(SKIP_MESSAGE);
      },
    );

    it('still honors --no-hooks', async () => {
      const plan = await collect({ interactive: true, hooks: false });

      expect(plan.shouldSetupHooks).toBe(false);
      expectNoHooksPrompt();
      expect(mockInfo).not.toHaveBeenCalledWith(SKIP_MESSAGE);
    });

    it('still runs setup when --hooks is passed', async () => {
      const plan = await collect({ interactive: true, hooks: true });

      expect(plan.shouldSetupHooks).toBe(true);
      expectNoHooksPrompt();
      expect(mockInfo).not.toHaveBeenCalledWith(SKIP_MESSAGE);
    });
  });

  describe('partially configured hooks', () => {
    it.each([
      [
        'no prepare script',
        () => {
          git(tmpDir, 'init', '-q');
          writeProjectHooks();
          installDispatcher(tmpDir, ['commit-msg', 'pre-commit']);
        },
      ],
      [
        'core.hooksPath unset',
        () => {
          git(tmpDir, 'init', '-q');
          writePackageJson(tmpDir, { scripts: { prepare: 'vp config' } });
          writeProjectHooks();
        },
      ],
      [
        'dispatcher missing',
        () => {
          setUpFullyConfiguredHooks();
          fs.rmSync(path.join(tmpDir, '.vite-hooks', '_'), { recursive: true });
        },
      ],
      [
        'dispatcher stub missing for a project hook',
        () => {
          setUpFullyConfiguredHooks();
          fs.rmSync(path.join(tmpDir, '.vite-hooks', '_', 'commit-msg'));
        },
      ],
      [
        'no git repository',
        () => {
          writePackageJson(tmpDir, { scripts: { prepare: 'vp config' } });
          writeProjectHooks();
        },
      ],
    ])('completes setup without prompting when %s', async (_case, setUp) => {
      setUp();
      expect(isViteHooksSetupComplete(tmpDir)).toBe(false);

      for (const interactive of [true, false]) {
        const plan = await collect({ interactive });
        expect(plan.shouldSetupHooks).toBe(true);
      }
      expectNoHooksPrompt();
      expect(mockInfo).not.toHaveBeenCalledWith(SKIP_MESSAGE);
    });

    it('does not treat hook files alone as fully configured', () => {
      writeProjectHooks();

      expect(isViteHooksSetupComplete(tmpDir)).toBe(false);
    });

    it('preserves existing hook files while completing setup', async () => {
      writeProjectHooks();

      const plan = await collect({ interactive: true });
      expect(plan.shouldSetupHooks).toBe(true);
      expect(installGitHooks(tmpDir, true)).toBe(true);

      expect(fs.readFileSync(path.join(tmpDir, '.vite-hooks', 'pre-commit'), 'utf8')).toBe(
        'npm test\n',
      );
      expect(fs.readFileSync(path.join(tmpDir, '.vite-hooks', 'commit-msg'), 'utf8')).toBe(
        'echo msg\n',
      );
      expect(readPackageJson(tmpDir).scripts?.prepare).toBe('vp config');
      expect(fs.existsSync(path.join(tmpDir, 'vite.config.ts'))).toBe(false);
    });

    it('still runs the existing preflight checks', async () => {
      git(tmpDir, 'init', '-q');
      writeProjectHooks();
      git(tmpDir, 'config', 'core.hooksPath', '.githooks');

      const plan = await collect({ interactive: true });

      expect(plan.shouldSetupHooks).toBe(false);
      expectNoHooksPrompt();
      expect(prompts.log.warn).toHaveBeenCalledWith(
        expect.stringContaining('core.hooksPath is already set to ".githooks"'),
      );
    });

    it.each([true, false])('respects --hooks=%s', async (hooks) => {
      writeProjectHooks();

      const plan = await collect({ interactive: true, hooks });

      expect(plan.shouldSetupHooks).toBe(hooks);
      expectNoHooksPrompt();
    });
  });

  describe('no existing hooks', () => {
    it('does not treat non-hook files in .vite-hooks/ as existing hooks', async () => {
      fs.mkdirSync(path.join(tmpDir, '.vite-hooks'));
      fs.writeFileSync(path.join(tmpDir, '.vite-hooks', 'README.md'), 'not a hook\n');
      mockConfirm.mockResolvedValueOnce(true);

      const plan = await collect({ interactive: true });

      expect(plan.shouldSetupHooks).toBe(true);
      expect(mockConfirm).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])('asks the original confirm prompt (answer=%s)', async (answer) => {
      mockConfirm.mockResolvedValueOnce(answer);

      const plan = await collect({ interactive: true });

      expect(plan.shouldSetupHooks).toBe(answer);
      expect(mockConfirm).toHaveBeenCalledTimes(1);
      expect(mockSelect).not.toHaveBeenCalled();
    });

    it('sets up hooks by default in non-interactive mode', async () => {
      const plan = await collect({ interactive: false });

      expect(plan.shouldSetupHooks).toBe(true);
      expectNoHooksPrompt();
    });

    it.each([true, false])('respects --hooks=%s without prompting', async (hooks) => {
      const plan = await collect({ interactive: true, hooks });

      expect(plan.shouldSetupHooks).toBe(hooks);
      expectNoHooksPrompt();
    });
  });
});
