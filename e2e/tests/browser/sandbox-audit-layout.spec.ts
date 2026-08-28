import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const styles = readFileSync(resolve('sandbox/src/web/assets/app.css'), 'utf8');
const markup = readFileSync(resolve('sandbox/src/web/assets/index.html'), 'utf8');
const script = readFileSync(resolve('sandbox/src/web/assets/app.js'), 'utf8');

function embeddedAuditPage() {
  return markup
    .replace('<link rel="stylesheet" href="/app.css" />', `<style>${styles}</style>`)
    .replace('<script src="/app.js" defer></script>', '');
}

test('audit event rows fill the table and align with every header column', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.setContent(`
    <style>${styles}</style>
    <div class="content" style="width: 1200px; height: 400px">
      <section class="panel active">
        <div class="table-head">
          <span>Event</span><span data-column="details">Details</span><span data-column="time">Time</span>
        </div>
        <div class="event-list">
          <button class="event-row" type="button">
            <span class="event-main"><span class="badge file">File</span><span>fixture.txt</span></span>
            <span class="event-detail">read · PID 42</span>
            <span class="event-time">18:00:26</span>
          </button>
        </div>
      </section>
    </div>
  `);

  const geometry = await page.evaluate(() => {
    const rect = (selector: string) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
      return element.getBoundingClientRect();
    };
    return {
      header: rect('.table-head').toJSON(),
      row: rect('.event-row').toJSON(),
      headerDetails: rect('[data-column="details"]').toJSON(),
      rowDetails: rect('.event-detail').toJSON(),
      headerTime: rect('[data-column="time"]').toJSON(),
      rowTime: rect('.event-time').toJSON(),
    };
  });

  expect(geometry.row.width).toBeCloseTo(geometry.header.width, 0);
  expect(geometry.rowDetails.x).toBeCloseTo(geometry.headerDetails.x, 0);
  expect(geometry.rowTime.x).toBeCloseTo(geometry.headerTime.x, 0);
});

test('audit side panels resize from their borders while the center fills the remainder', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.setContent(embeddedAuditPage());
  await page.addScriptTag({ content: script });

  const sidebar = page.locator('.sidebar');
  const main = page.locator('.main');
  const inspector = page.locator('.inspector');
  const leftHandle = page.locator('[data-resizer="sidebar"]');
  const rightHandle = page.locator('[data-resizer="inspector"]');

  await expect(leftHandle).toBeVisible();
  await expect(rightHandle).toBeVisible();
  await expect(leftHandle).toHaveCSS('cursor', 'col-resize');
  await expect(rightHandle).toHaveCSS('cursor', 'col-resize');

  const sidebarBefore = await sidebar.boundingBox();
  const mainBefore = await main.boundingBox();
  const inspectorBefore = await inspector.boundingBox();
  const leftHandleBox = await leftHandle.boundingBox();
  const rightHandleBox = await rightHandle.boundingBox();
  if (!sidebarBefore || !mainBefore || !inspectorBefore || !leftHandleBox || !rightHandleBox) {
    throw new Error('Expected all audit panels and resize handles to have layout boxes.');
  }

  await page.mouse.move(leftHandleBox.x + leftHandleBox.width / 2, leftHandleBox.y + 120);
  await page.mouse.down();
  await page.mouse.move(leftHandleBox.x + leftHandleBox.width / 2 + 80, leftHandleBox.y + 120);
  await page.mouse.up();

  const sidebarAfter = await sidebar.boundingBox();
  const mainAfterLeft = await main.boundingBox();
  expect(sidebarAfter?.width).toBeCloseTo(sidebarBefore.width + 80, 0);
  expect(mainAfterLeft?.width).toBeCloseTo(mainBefore.width - 80, 0);

  const movedRightHandle = await rightHandle.boundingBox();
  if (!movedRightHandle) throw new Error('Expected the right resize handle to remain visible.');
  await page.mouse.move(movedRightHandle.x + movedRightHandle.width / 2, movedRightHandle.y + 120);
  await page.mouse.down();
  await page.mouse.move(
    movedRightHandle.x + movedRightHandle.width / 2 - 60,
    movedRightHandle.y + 120,
  );
  await page.mouse.up();

  const inspectorAfter = await inspector.boundingBox();
  const mainAfterRight = await main.boundingBox();
  expect(inspectorAfter?.width).toBeCloseTo(inspectorBefore.width + 60, 0);
  expect(mainAfterRight?.width).toBeCloseTo(mainBefore.width - 140, 0);

  const movedLeftHandle = await leftHandle.boundingBox();
  if (!movedLeftHandle) throw new Error('Expected the left resize handle to remain visible.');
  await page.mouse.move(movedLeftHandle.x + movedLeftHandle.width / 2, movedLeftHandle.y + 120);
  await page.mouse.down();
  await page.mouse.move(
    movedLeftHandle.x + movedLeftHandle.width / 2 - 120,
    movedLeftHandle.y + 120,
  );
  await page.mouse.up();

  const latestRightHandle = await rightHandle.boundingBox();
  if (!latestRightHandle) throw new Error('Expected the right resize handle to remain visible.');
  await page.mouse.move(
    latestRightHandle.x + latestRightHandle.width / 2,
    latestRightHandle.y + 120,
  );
  await page.mouse.down();
  await page.mouse.move(
    latestRightHandle.x + latestRightHandle.width / 2 + 100,
    latestRightHandle.y + 120,
  );
  await page.mouse.up();

  const sidebarAfterShrink = await sidebar.boundingBox();
  const inspectorAfterShrink = await inspector.boundingBox();
  const mainAfterShrink = await main.boundingBox();
  expect(sidebarAfterShrink?.width).toBeCloseTo(sidebarBefore.width - 40, 0);
  expect(inspectorAfterShrink?.width).toBeCloseTo(inspectorBefore.width - 40, 0);
  expect(mainAfterShrink?.width).toBeCloseTo(mainBefore.width + 80, 0);
});
