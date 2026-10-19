// Diff 弹窗移动端/响应式适配的浏览器结构回归。
// 使用项目生产构建产物中的真实 CSS，在 Chromium 中注入与组件同结构的 DOM，
// 校验断点、安全区、dvh、内部滚动边界与触控尺寸。
const fs = require('fs');
const path = require('path');
const { chromium } = require('/home/burger/.npm/_npx/361ceb562f3b3235/node_modules/playwright-core');

const cssDir = path.resolve(__dirname, '../../.next/static/css');
const cssFile = fs.readdirSync(cssDir).find((name) => name.endsWith('.css') && fs.readFileSync(path.join(cssDir, name), 'utf8').includes('notus-diff-dialog'));
if (!cssFile) throw new Error('未找到包含 notus-diff-dialog 的构建 CSS，请先执行 npm run build:web');
const css = fs.readFileSync(path.join(cssDir, cssFile), 'utf8');

const HARNESS = `
<style>${css}</style>
<div class="notus-diff-dialog__backdrop">
  <div class="notus-diff-dialog" role="dialog" aria-modal="true" aria-label="修改详情">
    <div class="notus-diff-dialog__header">
      <div><div>修改详情</div></div>
      <div class="notus-diff-dialog__header-actions">
        <button type="button" class="notus-diff-dialog__file-toggle"><span>文件</span></button>
        <button type="button" aria-label="关闭">x</button>
      </div>
    </div>
    <div class="notus-diff-dialog__body">
      <button type="button" class="notus-diff-dialog__file-backdrop"></button>
      <nav class="notus-diff-dialog__sidebar is-mobile-open"><button type="button">修改文件</button></nav>
      <div class="notus-diff-dialog__content">
        <div class="notus-diff-dialog__content-header"><span>a/very/long/path/that/is/long.md</span></div>
        <div class="notus-diff-dialog__scroll">
          <div class="notus-diff-dialog__lines">
            <div style="padding:0 14px"><span>1</span><span>+</span><span>${'x'.repeat(600)}</span></div>
          </div>
        </div>
        <div class="notus-diff-dialog__footer">
          <div>
            <button type="button">废弃预览</button>
            <button type="button">回滚修改</button>
            <button type="button">应用修改</button>
            <button type="button">全部应用</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>`;

(async () => {
  const browser = await chromium.launch();
  const failures = [];
  const check = (ok, label, extra = '') => {
    console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ' :: ' + extra : ''}`);
    if (!ok) failures.push(label);
  };

  const page = await browser.newPage();
  await page.setContent(HARNESS, { waitUntil: 'load' });

  for (const [width, height] of [[1280, 900], [1024, 768], [961, 800], [960, 800], [768, 900], [421, 800], [420, 844], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(80);
    const m = await page.evaluate(() => {
      const q = (s) => document.querySelector(s);
      const backdrop = q('.notus-diff-dialog__backdrop');
      const dialog = q('.notus-diff-dialog');
      const sidebar = q('.notus-diff-dialog__sidebar');
      const toggle = q('.notus-diff-dialog__file-toggle');
      const closeBtn = q('.notus-diff-dialog__header-actions button[aria-label="关闭"]');
      const footerBtn = q('.notus-diff-dialog__footer button');
      const scroll = q('.notus-diff-dialog__scroll');
      const lines = q('.notus-diff-dialog__lines');
      return {
        docScrollW: document.documentElement.scrollWidth,
        docClientW: document.documentElement.clientWidth,
        bodyScrollW: document.body.scrollWidth,
        backdropPadding: getComputedStyle(backdrop).padding,
        dialogW: dialog.getBoundingClientRect().width,
        dialogH: dialog.getBoundingClientRect().height,
        dialogLeft: dialog.getBoundingClientRect().left,
        dialogRight: dialog.getBoundingClientRect().right,
        sidebarPos: getComputedStyle(sidebar).position,
        sidebarVisible: getComputedStyle(sidebar).visibility,
        toggleDisplay: getComputedStyle(toggle).display,
        closeH: closeBtn.getBoundingClientRect().height,
        closeW: closeBtn.getBoundingClientRect().width,
        footerBtnH: footerBtn.getBoundingClientRect().height,
        scrollScrollW: scroll.scrollWidth,
        scrollClientW: scroll.clientWidth,
        linesMinWidth: getComputedStyle(lines).minWidth,
        bodyDisplay: getComputedStyle(q('.notus-diff-dialog__body')).display,
      };
    });
    console.log(`\n--- viewport ${width}x${height} ---`);
    check(m.docScrollW <= m.docClientW, `[${width}] 页面无横向溢出`, `scrollW=${m.docScrollW} clientW=${m.docClientW}`);
    check(m.dialogLeft >= -0.5 && m.dialogRight <= width + 0.5, `[${width}] 弹窗完全位于视口内`, `left=${m.dialogLeft} right=${m.dialogRight}`);
    if (width > 960) {
      check(m.bodyDisplay === 'grid', `[${width}] 宽屏双栏布局`);
      check(m.toggleDisplay === 'none', `[${width}] 宽屏隐藏文件入口`);
      check(m.sidebarPos === 'static' || m.sidebarPos === 'relative', `[${width}] 宽屏侧栏为固定列`, m.sidebarPos);
    } else {
      check(m.bodyDisplay === 'block', `[${width}] 窄屏单栏布局`);
      check(m.toggleDisplay !== 'none', `[${width}] 窄屏显示文件入口`);
      check(m.sidebarPos === 'absolute', `[${width}] 窄屏侧栏为悬浮抽屉`, m.sidebarPos);
      check(m.sidebarVisible === 'visible', `[${width}] is-mobile-open 抽屉可见`, m.sidebarVisible);
      check(m.closeH >= 36 && m.closeW >= 36, `[${width}] 关闭入口触控尺寸`, `${m.closeW}x${m.closeH}`);
      check(m.footerBtnH >= 40, `[${width}] 底部按钮触控高度`, String(m.footerBtnH));
    }
    check(m.linesMinWidth === 'max-content', `[${width}] diff 行按内容宽度`);
    check(m.scrollScrollW > m.scrollClientW, `[${width}] 长行只在内容区横向滚动`, `${m.scrollScrollW}>${m.scrollClientW}`);
    check(m.docScrollW <= m.docClientW, `[${width}] 长行不撑开页面`);
    const linePadLeft = await page.evaluate(() => getComputedStyle(document.querySelector('.notus-diff-dialog__lines > div')).paddingLeft);
    if (width <= 420) check(linePadLeft === '8px', `[${width}] 小屏压缩 diff 行留白`, linePadLeft);
    else check(linePadLeft === '14px', `[${width}] 常规 diff 行留白`, linePadLeft);
  }

  // 安全区与 dvh：验证计算样式中确实声明了 env()/dvh 相关规则（结构断言补充）。
  const cssHasSafeArea = /env\(safe-area-inset-top\)/.test(css);
  const cssHasDvh = /100dvh/.test(css);
  check(cssHasSafeArea, 'CSS 含安全区 env()');
  check(cssHasDvh, 'CSS 含 100dvh');

  // 390 宽下外壳高度应跟随视口（dvh）。
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(60);
  const small = await page.evaluate(() => {
    const d = document.querySelector('.notus-diff-dialog');
    return { h: d.getBoundingClientRect().height, vh: window.innerHeight };
  });
  check(small.h >= small.vh - 2, '[390] 弹窗高度铺满视口高度', `${small.h}/${small.vh}`);

  await browser.close();
  console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES: ' + failures.length}`);
  if (failures.length) { console.log(failures.join('\n')); process.exit(1); }
})();
