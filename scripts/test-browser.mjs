import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as createPortReservation } from 'node:net';
import * as playwright from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import reviewRecoveryScenarios from '../tests/reviewRecovery.browser.js';
import reviewSessionInsightsScenarios from '../tests/reviewSessionInsights.browser.js';
import requestReviewScenarios from '../tests/requestReview.browser.js';

const filename = fileURLToPath(import.meta.url);
const root = dirname(dirname(filename));
const output = join(root, 'node_modules/.cache/review-ui');

if (process.argv[2] === '--serve') {
  Object.assign(process.env, {
    VITE_GH_CLIENT_ID: '', VITE_OAUTH_PROXY: '', VITE_GRAPH_TRANSPORT: 'off',
    VITE_ADO_TRANSPORT: process.argv[3], VITE_AZURE_CLIENT_ID: '', VITE_AZURE_TENANT_ID: '',
    VITE_SUMMARIZE_ENDPOINT: '', VITE_READINESS_ENDPOINT: '', VITE_REVIEW_ENDPOINT: process.argv[5] === 'insights' ? '/api/test-review' : '',
    VITE_SUGGEST_ENDPOINT: '', VITE_TEAMS_NOTIFY: 'off', VITE_SKILL_PATHS: '',
    NOTIFY_WEBHOOK_URL: '', TEAMS_WEBHOOK_URL: '',
  });
  const { createServer } = await import('vite');
  const server = await createServer({
    root,
    cacheDir: join(root, 'node_modules/.cache/review-ui-vite', process.argv[3]),
    server: { host: '127.0.0.1', port: Number(process.argv[4]), strictPort: true },
  });
  await server.listen();
  process.send({ url: `http://127.0.0.1:${server.httpServer.address().port}` });
  process.on('message', async message => {
    if (message === 'close') { await server.close(); process.disconnect(); }
  });
} else {
  await main();
}

async function startPreview(transport, mode = '') {
  const port = await new Promise((resolve, reject) => {
    const reservation = createPortReservation();
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', () => {
      const available = reservation.address().port;
      reservation.close(error => error ? reject(error) : resolve(available));
    });
  });
  const child = spawn(process.execPath, [filename, '--serve', transport, String(port), mode], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  child.stdout.on('data', data => { logs += data.toString(); });
  child.stderr.on('data', data => { logs += data.toString(); });
  const ready = new Promise((resolve, reject) => {
    const limit = setTimeout(() => reject(new Error(`Preview startup timed out: ${logs}`)), 30000);
    child.once('error', error => { clearTimeout(limit); reject(error); });
    child.once('exit', code => { clearTimeout(limit); reject(new Error(`Preview exited (${code}): ${logs}`)); });
    child.once('message', message => { clearTimeout(limit); resolve(message.url); });
  });
  const close = async () => {
    if (child.exitCode !== null) return;
    const stopped = new Promise(resolve => child.once('exit', resolve));
    if (child.connected) child.send('close');
    else child.kill();
    await stopped;
  };
  try {
    return { url: await ready, close };
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function main() {
  const requested = process.argv.find(argument => argument.startsWith('--browser='))?.slice('--browser='.length)
    || process.env.DOCTHREAD_TEST_BROWSERS || 'chromium,firefox,webkit';
  const engines = requested.split(',');
  if (engines.some(engine => !['chromium', 'firefox', 'webkit'].includes(engine))) throw new Error('Unknown browser engine.');
  await mkdir(output, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), platform: process.platform, engines: [] };
  let app;
  let ado;
  let insights;
  try {
    app = await startPreview('off');
    ado = await startPreview('dev-cli');
    insights = await startPreview('off', 'insights');
    const allowedOrigins = new Set([app.url, ado.url, insights.url]);
    for (const engine of engines) {
      const result = { engine, passed: false, scenarios: [], accessibility: [], blockedRequests: [], error: null };
      report.engines.push(result);
      let browser;
      let host;
      const prepareContext = async context => {
        await context.route('**/*', route => {
          const request = route.request();
          const url = new URL(request.url());
          const protectedPath = /^\/(?:gh-api|ado-api|api|auth|ado-auth)(?:\/|$)/.test(url.pathname);
          if (!allowedOrigins.has(url.origin) || protectedPath || !['GET', 'HEAD'].includes(request.method())) {
            result.blockedRequests.push({ method: request.method(), path: url.pathname, origin: url.origin });
            return route.abort('blockedbyclient');
          }
          return route.continue();
        });
      };
      try {
        browser = await playwright[engine].launch();
        host = await browser.newContext();
        await prepareContext(host);
        const page = await host.newPage();
        const checks = {
          prepareContext,
          checkPage: async (check, name) => {
            const scan = await new AxeBuilder({ page: check }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
            const violations = scan.violations.map(violation => ({
              id: violation.id, impact: violation.impact, help: violation.help,
              nodes: violation.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })),
            }));
            result.accessibility.push({ scenario: name, violations });
            const basename = `${engine}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 100)}`;
            await check.screenshot({ path: join(output, `${basename}.png`), fullPage: !name.startsWith('insights'), scale: 'css' });
            console.log(`${engine}: ${name}: ${violations.length ? `FAIL (${violations.length} accessibility rules)` : 'PASS'}`);
          },
        };
        if (!process.argv.includes('--insights-only') && !process.argv.includes('--request-review-only')) {
          result.scenarios = await reviewRecoveryScenarios(page, { ...checks, app: app.url, ado: ado.url });
        }
        if (!process.argv.includes('--request-review-only')) {
          result.scenarios.push(...await reviewSessionInsightsScenarios(page, { ...checks, app: insights.url }));
        }
        result.scenarios.push(...await requestReviewScenarios(page, { ...checks, app: insights.url }));
        result.passed = result.blockedRequests.length === 0 && result.accessibility.every(scan => scan.violations.length === 0);
      } catch (error) {
        result.error = String(error?.stack || error);
        console.error(`${engine}: FAIL: ${error.message}`);
      } finally {
        await host?.close();
        await browser?.close();
      }
    }
  } finally {
    await insights?.close();
    await ado?.close();
    await app?.close();
    await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2) + '\n');
  }
  const passed = report.engines.length === engines.length && report.engines.every(result => result.passed);
  console.log(`Browser gate: ${passed ? 'PASS' : 'FAIL'}. Results: ${join(output, 'results.json')}`);
  process.exitCode = passed ? 0 : 1;
}