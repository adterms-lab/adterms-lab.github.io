import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const base = (process.env.SITE_BASE || 'https://adterms-lab.github.io').replace(/\/$/, '');
const hash = b => createHash('sha256').update(b).digest('hex');
const pages = [
  { path: 'index.html', expected: hash(await readFile('index.html')) },
  { path: 'business.html', expected: hash(await readFile('business.html')) },
];
const version = 'v26.10.19.6';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForLiveRelease() {
  for (let attempt = 1; attempt <= 20; attempt++) {
    let matches = 0;
    for (const page of pages) {
      const url = base + '/' + page.path + '?release-check=' + encodeURIComponent(process.env.GITHUB_SHA || 'manual') + '-' + attempt + '-' + Date.now();
      try {
        const r = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
        if (!r.ok) throw Error('HTTP ' + r.status);
        const live = hash(Buffer.from(await r.arrayBuffer()));
        if (live === page.expected) {
          console.log('PASS: ' + page.path + ' matches current repository SHA-256 ' + live);
          matches++;
        } else {
          console.log('Live ' + page.path + ' not yet current (attempt ' + attempt + '/20): ' + live + ' vs ' + page.expected);
        }
      } catch (e) {
        console.log('Live site ' + page.path + ' fetch attempt ' + attempt + '/20: ' + String(e));
      }
    }
    if (matches === pages.length) return;
    if (attempt < 20) await pause(15000);
  }
  throw Error('Public GitHub Pages file never matched the committed HTML; website deployment or caching is not verified.');
}

await waitForLiveRelease();
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  async function newPage(viewport) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const r = await page.goto(base + '/business.html?e2e=' + Date.now(), { waitUntil: 'load', timeout: 45000 });
    assert.equal(r?.status(), 200, 'The browser must load the public page');
    await page.locator('[data-tab="quiz"]').click();
    await page.locator('#quizDirection').waitFor();
    assert.equal(await page.locator('#brandHome .app-build').textContent(), version, 'Business 100 version badge');
    assert.deepEqual(await page.locator('#quizDirection option').allTextContents(), [
      '説明から用語を選ぶ',
      '用語から説明を選ぶ',
      '両方を混ぜる',
    ]);
    return { context, page, errors };
  }

  async function start(page, direction) {
    await page.locator('#quizDirection').selectOption(direction);
    await page.locator('[data-do="quizStart"]').click();
    await page.locator('.quiz-play .question h2').waitFor();
    const state = await page.evaluate(() => {
      const card = words.find(x => x.id === quiz.ids[quiz.index]);
      return { id: card.id, term: card.term, definition: card.definition, direction: quiz.currentDirection };
    });
    assert.equal(state.direction, direction === 'mixed' ? state.direction : direction);
    assert.equal((await page.locator('.quiz-play .options .option').count()), 4);
    return state;
  }

  // Description -> term (original behavior)
  {
    const { page, context, errors } = await newPage({ width: 1280, height: 800 });
    const q = await start(page, 'definition');
    assert.equal(await page.locator('.question .clue').textContent(), 'この説明に当てはまる用語は？');
    assert.equal(await page.locator('.question h2').textContent(), q.definition);
    assert.equal(await page.locator('.options .option[data-id="' + q.id + '"] .option-text').textContent(), q.term);
    await page.locator('.options .option[data-id="' + q.id + '"]').click();
    assert.equal(await page.locator('.options .option.right').count(), 1);
    await page.locator('[data-do="quizFinish"]').click();
    assert.match(await page.locator('.quiz-scores .score.good').textContent(), /1/);
    await page.screenshot({ path: 'test-results/quiz-definition-desktop.png' });
    assert.deepEqual(errors, [], 'No browser JavaScript errors in definition mode');
    await context.close();
    console.log('PASS: desktop explanation -> term, correct answer and result');
  }

  // Term -> description; long option texts must remain inside mobile viewport.
  {
    const { page, context, errors } = await newPage({ width: 390, height: 844 });
    const q = await start(page, 'term');
    assert.equal(await page.locator('.question .clue').textContent(), 'この用語に当てはまる説明は？');
    assert.equal(await page.locator('.question h2').textContent(), q.term);
    assert.equal(await page.locator('.options .option[data-id="' + q.id + '"] .option-text').textContent(), q.definition);
    const geometry = await page.evaluate(() => ({
      pageScroll: document.documentElement.scrollHeight,
      viewport: window.innerHeight,
      overflow: getComputedStyle(document.body).overflow
    }));
    assert.equal(geometry.overflow, 'hidden', 'Mobile quiz screen locks page scrolling');
    assert.ok(geometry.pageScroll <= geometry.viewport + 4, 'Mobile quiz screen fits viewport: ' + JSON.stringify(geometry));
    await page.locator('.options .option[data-id="' + q.id + '"]').click();
    assert.equal(await page.locator('.options .option.right').count(), 1);
    await page.locator('[data-do="quizFinish"]').click();
    await page.screenshot({ path: 'test-results/quiz-term-mobile.png' });
    await page.locator('[data-do="quizReset"]').click();
    assert.equal(await page.locator('#quizDirection').inputValue(), 'term', 'Keep selected format on retry');
    assert.deepEqual(errors, [], 'No browser JavaScript errors in term mode');
    await context.close();
    console.log('PASS: mobile term -> explanation, result, retry format and viewport');
  }

  // Mixed: 10 prompts alternate directions in random order, with 5 of each.
  {
    const { page, context, errors } = await newPage({ width: 390, height: 844 });
    await start(page, 'mixed');
    const directions = await page.evaluate(() => [...quiz.directions]);
    assert.equal(directions.length, 10);
    assert.equal(directions.filter(x => x === 'term').length, 5);
    assert.equal(directions.filter(x => x === 'definition').length, 5);
    for (let i = 0; i < 10; i++) {
      assert.equal(await page.locator('.question .clue').textContent(),
        directions[i] === 'term' ? 'この用語に当てはまる説明は？' : 'この説明に当てはまる用語は？');
      await page.locator('[data-do="skip"]').click();
    }
    assert.equal(await page.locator('.review-row').count(), 10);
    assert.match(await page.locator('.quiz-scores .score.skip').textContent(), /10/);
    await page.screenshot({ path: 'test-results/quiz-mixed-mobile.png' });
    assert.deepEqual(errors, [], 'No browser JavaScript errors in mixed mode');
    await page.locator('#brandHome').click();
    await page.waitForURL(/\/index\.html/);
    assert.ok((await page.title()).includes('AdTerms Lab'), 'Brand navigates to app home');
    assert.equal(await page.locator('#brandHome .app-build').textContent(), version, 'Main app has same version badge');
    await context.close();
    console.log('PASS: mixed mode balances both directions, finishes all 10, returns home');
  }
  console.log('ALL LIVE WEB BROWSER TESTS PASSED');
} finally {
  await browser.close();
}
