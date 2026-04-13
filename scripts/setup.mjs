#!/usr/bin/env node
/**
 * agent-middleware Setup Wizard
 *
 * Interactive first-run setup — modeled after OpenClaw / OpenHands CLI wizards.
 * Guides the user through: prerequisite checks, config, build, pm2 start,
 * optional auto-update and boot-time startup.
 *
 * Cross-platform: macOS / Linux / Windows / WSL.
 */
import {
  intro,
  outro,
  text,
  select,
  confirm,
  spinner,
  note,
  cancel,
  isCancel,
  log,
} from '@clack/prompts';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ─── Helpers ─────────────────────────────────────────────────────────────
const has = (cmd) => {
  try {
    execSync(process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const run = (cmd, opts = {}) => {
  return spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT, ...opts });
};

const quietRun = (cmd) => {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8' });
  } catch (err) {
    return null;
  }
};

const handleCancel = (value, msg = 'Setup cancelled') => {
  if (isCancel(value)) {
    cancel(msg);
    process.exit(0);
  }
  return value;
};

// ─── Main Flow ───────────────────────────────────────────────────────────
async function main() {
  console.clear();
  intro('🦾 agent-middleware setup wizard');

  // Step 1: Prerequisite checks
  const s1 = spinner();
  s1.start('Checking prerequisites');
  const prereqs = {
    node: has('node'),
    git: has('git'),
    pnpm: has('pnpm'),
    pm2: has('pm2'),
  };
  const nodeVer = prereqs.node ? (quietRun('node --version') || '').trim() : null;
  s1.stop('Prerequisites checked');

  const missing = [];
  if (!prereqs.node) missing.push('node');
  if (!prereqs.git) missing.push('git');
  if (!prereqs.pnpm) missing.push('pnpm (npm install -g pnpm)');
  if (missing.length > 0) {
    note(
      `Missing required tools:\n${missing.map((m) => `  - ${m}`).join('\n')}\n\nInstall them first, then re-run: pnpm run setup`,
      '❌ Prerequisites not met',
    );
    process.exit(1);
  }

  note(
    [
      `node:  ${nodeVer} ✓`,
      `git:   ✓`,
      `pnpm:  ✓`,
      `pm2:   ${prereqs.pm2 ? '✓' : '(will install)'}`,
    ].join('\n'),
    'System check',
  );

  // Step 2: Install pm2 if missing
  if (!prereqs.pm2) {
    const installPm2 = handleCancel(
      await confirm({
        message: 'pm2 not found — install globally now? (npm install -g pm2)',
        initialValue: true,
      }),
    );
    if (installPm2) {
      log.info('Installing pm2 globally…');
      const r = run('npm install -g pm2');
      if (r.status !== 0) {
        cancel('Failed to install pm2. Try running with sudo, or install manually: npm install -g pm2');
        process.exit(1);
      }
    } else {
      cancel('pm2 is required. Install manually and re-run: pnpm run setup');
      process.exit(1);
    }
  }

  // Step 3: Port
  const port = handleCancel(
    await text({
      message: 'HTTP port for middleware',
      placeholder: '3200',
      initialValue: process.env.PORT || '3200',
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Enter a valid port number (1-65535)';
      },
    }),
  );

  // Step 4: Brain model (planner)
  const brainModel = handleCancel(
    await select({
      message: 'Brain model (DAG planner for /accomplish endpoint)',
      initialValue: 'sonnet',
      options: [
        { value: 'sonnet', label: 'sonnet  (recommended — balanced planner)', hint: 'arxiv 2604.06296 §6.2' },
        { value: 'haiku', label: 'haiku   (cheaper, faster, less nuanced)' },
        { value: 'opus', label: 'opus    (NOT recommended — role2_never_called risk)', hint: 'too strong for planner' },
      ],
    }),
  );

  // Step 5: Critic model (recovery options)
  const criticModel = handleCancel(
    await select({
      message: 'Critic model (failure diagnosis + recovery options)',
      initialValue: 'haiku',
      options: [
        { value: 'haiku', label: 'haiku   (recommended — critic role)', hint: 'arxiv 2604.06296 Table 1' },
        { value: 'sonnet', label: 'sonnet  (more nuanced, costlier)' },
      ],
    }),
  );

  // Step 6: Auto-pull
  const autoPull = handleCancel(
    await confirm({
      message: 'Enable auto-update? (pm2-auto-pull: check git every 5 min, auto reload on new commits)',
      initialValue: true,
    }),
  );

  // Step 7: Boot-time autostart
  const bootStart = handleCancel(
    await confirm({
      message: 'Enable boot-time auto-start? (pm2 will start agent-middleware on every machine boot)',
      initialValue: true,
    }),
  );

  // Step 8: Summary + confirm
  note(
    [
      `Port:           ${port}`,
      `Brain model:    ${brainModel}`,
      `Critic model:   ${criticModel}`,
      `Auto-update:    ${autoPull ? 'yes (pm2-auto-pull, 5 min poll)' : 'no (manual pnpm deploy)'}`,
      `Boot-start:     ${bootStart ? 'yes' : 'no'}`,
      `Install path:   ${ROOT}`,
    ].join('\n'),
    'Review configuration',
  );

  const go = handleCancel(
    await confirm({ message: 'Proceed with installation?', initialValue: true }),
  );
  if (!go) {
    cancel('Setup cancelled — nothing was changed.');
    process.exit(0);
  }

  // Step 9: Write .env (merge with existing if present)
  const s2 = spinner();
  s2.start('Writing .env');
  const envPath = path.join(ROOT, '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
  const existingLines = existing.split(/\r?\n/).filter(Boolean);
  const updates = {
    PORT: port,
    MIDDLEWARE_BRAIN_MODEL: brainModel,
    MIDDLEWARE_CRITIC_MODEL: criticModel,
  };
  const kept = existingLines.filter((line) => {
    const k = line.split('=')[0].trim();
    return !(k in updates);
  });
  const merged = [
    '# agent-middleware configuration (generated by setup wizard)',
    '# Re-run `pnpm run setup` to reconfigure.',
    ...kept,
    ...Object.entries(updates).map(([k, v]) => `${k}=${v}`),
  ].join('\n') + '\n';
  fs.writeFileSync(envPath, merged, 'utf-8');
  s2.stop('.env written');

  // Step 10: Install deps + build
  const s3 = spinner();
  s3.start('Installing dependencies (pnpm install)');
  let r = run('pnpm install', { stdio: 'pipe' });
  if (r.status !== 0) {
    s3.stop('pnpm install failed');
    cancel('Dependency installation failed. Run manually: pnpm install');
    process.exit(1);
  }
  s3.stop('Dependencies installed');

  const s4 = spinner();
  s4.start('Building TypeScript → dist/');
  r = run('pnpm run build', { stdio: 'pipe' });
  if (r.status !== 0) {
    s4.stop('Build failed');
    cancel('Build failed. Run manually to inspect: pnpm run build');
    process.exit(1);
  }
  s4.stop('Build complete');

  // Step 11: Free port if something else is there
  const s5 = spinner();
  s5.start(`Checking port ${port}`);
  const portCheck = quietRun(
    process.platform === 'win32'
      ? `netstat -ano | findstr :${port}`
      : `lsof -iTCP:${port} -sTCP:LISTEN -t || true`,
  );
  if (portCheck && portCheck.trim()) {
    s5.stop(`Port ${port} is in use`);
    const pids = portCheck.trim().split(/\s+/).filter(Boolean);
    note(
      `PID(s) holding port ${port}:\n  ${pids.join('\n  ')}\n\nIf this is an old middleware process, it's safe to kill.`,
      '⚠ Port conflict',
    );
    const killOld = handleCancel(
      await confirm({ message: `Kill process(es) on port ${port}?`, initialValue: true }),
    );
    if (killOld) {
      for (const pid of pids) {
        run(process.platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill ${pid}`, { stdio: 'ignore' });
      }
      log.info(`Killed ${pids.length} process(es)`);
    } else {
      cancel('Port conflict not resolved. Free the port manually and re-run.');
      process.exit(1);
    }
  } else {
    s5.stop(`Port ${port} is free`);
  }

  // Step 12: Start with pm2
  const s6 = spinner();
  s6.start('Starting agent-middleware with pm2');
  // pm2 start idempotent — use startOrRestart
  r = run('pm2 startOrRestart ecosystem.config.cjs --update-env', { stdio: 'pipe' });
  if (r.status !== 0) {
    s6.stop('pm2 start failed');
    cancel('Failed to start with pm2. Check logs: pm2 logs agent-middleware');
    process.exit(1);
  }
  run('pm2 save', { stdio: 'ignore' });
  s6.stop('pm2 process running');

  // Step 13: Health check
  const s7 = spinner();
  s7.start(`Health check: http://localhost:${port}/health`);
  // Give middleware ~2s to bind port
  await new Promise((r) => setTimeout(r, 2000));
  const health = quietRun(`curl -sf --max-time 5 http://localhost:${port}/health`);
  if (health) {
    s7.stop('Health check passed ✓');
  } else {
    s7.stop('Health check did not respond yet');
    note(
      [
        'Middleware started but did not respond to /health within 5s.',
        '',
        'This can be normal on slow startup. Check:',
        `  pm2 logs agent-middleware --lines 30`,
        `  curl http://localhost:${port}/health`,
      ].join('\n'),
      '⚠ Health check timeout',
    );
  }

  // Step 14: Optional — auto-pull
  if (autoPull) {
    const s8 = spinner();
    s8.start('Installing pm2-auto-pull module');
    run('pm2 install pm2-auto-pull', { stdio: 'pipe' });
    s8.stop('pm2-auto-pull installed');
  }

  // Step 15: Optional — boot-time startup
  let bootInstructions = null;
  if (bootStart) {
    const s9 = spinner();
    s9.start('Configuring boot-time startup');
    // `pm2 startup` prints a platform-specific sudo command that the user
    // must run ONCE to register the init service. Capture and show it.
    const startupOut = quietRun('pm2 startup');
    s9.stop('Boot-startup command prepared');
    const match = startupOut ? startupOut.match(/sudo\s+env\s+.*pm2\s+startup\s+\S+/) : null;
    if (match) {
      bootInstructions = match[0];
    } else {
      bootInstructions = startupOut ? startupOut.trim().split('\n').pop() : null;
    }
  }

  // Final summary
  outro('✅ agent-middleware is live');

  const nextSteps = [
    `  pm2 status                      # check process state`,
    `  pm2 logs agent-middleware       # follow logs`,
    `  pm2 restart agent-middleware    # restart`,
    `  curl http://localhost:${port}/health`,
    `  curl -X POST http://localhost:${port}/accomplish \\`,
    `    -H 'Content-Type: application/json' \\`,
    `    -d '{"goal":"...","wait":true}'`,
  ];
  if (bootInstructions) {
    nextSteps.push('');
    nextSteps.push('  Boot-start requires one-time sudo command:');
    nextSteps.push(`    ${bootInstructions}`);
  }
  note(nextSteps.join('\n'), 'Next steps');
}

main().catch((err) => {
  cancel(`Setup failed: ${err?.message ?? err}`);
  process.exit(1);
});
