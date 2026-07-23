// ==UserScript==
// @name         BOSS Zhipin Apply Helper
// @namespace    https://codex.local/
// @version      0.1.2
// @description  Semi-automatic, rate-limited job apply/contact helper for BOSS Zhipin.
// @author       Codex
// @match        https://www.zhipin.com/*
// @match        https://*.zhipin.com/*
// @match        https://*.bosszhipin.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'bossApplyHelper.settings.v1';
  const SEEN_KEY = 'bossApplyHelper.seenJobs.v1';

  const DEFAULTS = {
    includeKeywords: '前端,JavaScript,React,Vue',
    excludeKeywords: '外包,驻场,销售,实习,培训',
    maxPerRun: 10,
    intervalSeconds: 18,
    dryRun: true,
    autoConfirmDialogs: false,
    panelPosition: null,
    message:
      '您好，我对这个岗位很感兴趣，经验与岗位方向比较匹配，方便的话想进一步沟通一下，谢谢。'
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
  const now = () => new Date().toLocaleTimeString();

  const state = {
    running: false,
    stopped: false,
    count: 0,
    logs: [],
    seen: loadSeen(),
    settings: loadSettings()
  };

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...(GM_getValue(STORAGE_KEY) || {}) };
    } catch (error) {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
    }
  }

  function saveSettings(settings) {
    state.settings = { ...settings };
    try {
      GM_setValue(STORAGE_KEY, state.settings);
    } catch (error) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
    }
  }

  function loadSeen() {
    try {
      return new Set(GM_getValue(SEEN_KEY) || []);
    } catch (error) {
      const raw = localStorage.getItem(SEEN_KEY);
      return new Set(raw ? JSON.parse(raw) : []);
    }
  }

  function saveSeen() {
    const list = Array.from(state.seen).slice(-1000);
    try {
      GM_setValue(SEEN_KEY, list);
    } catch (error) {
      localStorage.setItem(SEEN_KEY, JSON.stringify(list));
    }
  }

  function terms(value) {
    return String(value || '')
      .split(/[,，\s\n]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function visible(element) {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function textOf(element) {
    return (element && element.innerText ? element.innerText : '').replace(/\s+/g, ' ').trim();
  }

  function compact(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function getScrollTop(target) {
    return target === window ? window.scrollY : target.scrollTop;
  }

  function setScrollTop(target, value) {
    if (target === window) {
      window.scrollTo({ top: value, behavior: 'auto' });
    } else {
      target.scrollTop = value;
    }
  }

  function getMaxScrollTop(target) {
    if (target === window) {
      const scrolling = document.scrollingElement || document.documentElement;
      return Math.max(0, scrolling.scrollHeight - window.innerHeight);
    }
    return Math.max(0, target.scrollHeight - target.clientHeight);
  }

  function getScrollViewportHeight(target) {
    return target === window ? window.innerHeight : target.clientHeight;
  }

  function getScrollableParent(element) {
    let current = element ? element.parentElement : null;
    while (current && current !== document.body && current !== document.documentElement) {
      const style = window.getComputedStyle(current);
      const canScroll = /(auto|scroll|overlay)/.test(style.overflowY);
      if (canScroll && current.scrollHeight > current.clientHeight + 20) return current;
      current = current.parentElement;
    }
    return window;
  }

  function getJobScrollTarget() {
    const firstCard = document.querySelector(
      '.job-card-wrapper,.job-card-body,.job-card-box,.job-list-box li,li[class*="job-card"],div[class*="job-card"]'
    );
    return getScrollableParent(firstCard);
  }

  async function smoothScrollBy(target, distance, duration = 720) {
    const start = getScrollTop(target);
    const max = getMaxScrollTop(target);
    const end = clamp(start + distance, 0, max);
    const delta = end - start;

    if (Math.abs(delta) < 4) return false;

    const startTime = performance.now();
    const easeOutCubic = (value) => 1 - Math.pow(1 - value, 3);

    while (performance.now() - startTime < duration && !state.stopped) {
      const progress = clamp((performance.now() - startTime) / duration, 0, 1);
      setScrollTop(target, start + delta * easeOutCubic(progress));
      await sleep(16);
    }

    setScrollTop(target, end);
    return true;
  }

  function clickLikeHuman(element) {
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const inViewport =
      rect.top >= 72 &&
      rect.bottom <= window.innerHeight - 24 &&
      rect.left >= 0 &&
      rect.right <= window.innerWidth;
    if (!inViewport) {
      element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
    ['mouseover', 'mousedown', 'mouseup', 'click'].forEach((type) => {
      element.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
    });
    if (typeof element.click === 'function') element.click();
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements)).filter(visible);
  }

  function queryVisible(selector, root = document) {
    return uniqueElements(Array.from(root.querySelectorAll(selector)));
  }

  function findClickableByText(texts, root = document) {
    const candidates = queryVisible(
      'button,a,[role="button"],.btn,[class*="btn"],[class*="button"],span',
      root
    );

    return candidates.find((element) => {
      const label = textOf(element);
      if (!label) return false;
      const disabled =
        element.disabled ||
        element.getAttribute('aria-disabled') === 'true' ||
        /disabled|forbid|expire/i.test(element.className || '');
      return !disabled && texts.some((item) => label.includes(item));
    });
  }

  function findJobCards() {
    const selectors = [
      '.job-card-wrapper',
      '.job-card-body',
      '.job-card-box',
      '.job-list-box li',
      'li[class*="job-card"]',
      'div[class*="job-card"]'
    ];

    const cards = uniqueElements(selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))));
    return cards.filter((card) => {
      const text = textOf(card);
      const rect = card.getBoundingClientRect();
      const nearCurrentViewport = rect.bottom >= 72 && rect.top <= window.innerHeight + 240;
      return nearCurrentViewport && /薪|K|k|经验|学历|公司|岗位|职位/.test(text) && text.length > 20;
    }).sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
  }

  function getFirstText(root, selectors) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const value = compact(textOf(element));
      if (value) return value;
    }
    return '';
  }

  function extractJob(card) {
    const title = getFirstText(card, [
      '.job-name',
      '.job-title',
      '[class*="job-name"]',
      '[class*="job-title"]',
      'a'
    ]);
    const company = getFirstText(card, [
      '.company-name',
      '[class*="company-name"]',
      '[class*="company"]'
    ]);
    const salary = getFirstText(card, ['.salary', '[class*="salary"]']);
    const link = card.querySelector('a[href*="/job_detail/"],a[href*="/gongsi/job/"],a[href]');
    const href = link ? new URL(link.getAttribute('href'), location.href).href : '';
    const raw = compact(textOf(card));
    const key = href || compact(`${title}|${company}|${salary}|${raw.slice(0, 80)}`);

    return { title, company, salary, href, raw, key };
  }

  function jobMatches(job) {
    const include = terms(state.settings.includeKeywords);
    const exclude = terms(state.settings.excludeKeywords);
    const haystack = `${job.title} ${job.company} ${job.salary} ${job.raw}`.toLowerCase();
    const included = include.length === 0 || include.some((term) => haystack.includes(term.toLowerCase()));
    const excluded = exclude.some((term) => haystack.includes(term.toLowerCase()));
    return included && !excluded;
  }

  function getActiveDetailText() {
    const detail = document.querySelector('.job-detail, .job-sec, .job-detail-box, [class*="job-detail"]');
    return detail ? textOf(detail) : textOf(document.body);
  }

  function hasAlreadyContacted() {
    const detailText = getActiveDetailText();
    return /已沟通|继续沟通|已投递|已申请/.test(detailText);
  }

  async function applyCurrentDetail(job) {
    await sleep(randomBetween(900, 1500));

    if (hasAlreadyContacted()) {
      log(`跳过已沟通/已投递：${job.title || job.key}`);
      return false;
    }

    const button = findClickableByText([
      '立即沟通',
      '投递简历',
      '申请职位',
      '感兴趣',
      '聊一聊',
      '继续聊'
    ]);

    if (!button) {
      log(`未找到投递按钮：${job.title || job.key}`);
      return false;
    }

    if (state.settings.dryRun) {
      log(`试运行命中：${job.title || '未知岗位'} ${job.salary || ''} ${job.company || ''}`);
      return true;
    }

    clickLikeHuman(button);
    log(`已点击：${textOf(button)} -> ${job.title || '未知岗位'}`);
    await sleep(randomBetween(1600, 2600));
    await handleStayOnPagePrompt();
    await handleOptionalDialog();
    await handleStayOnPagePrompt();
    return true;
  }

  async function handleStayOnPagePrompt() {
    const stayButton = findClickableByText([
      '留在此页继续沟通',
      '留在此页',
      '继续留在此页',
      '继续查看职位'
    ]);

    if (!stayButton) return false;

    clickLikeHuman(stayButton);
    log(`已处理沟通完成提示：${textOf(stayButton)}`);
    await sleep(randomBetween(900, 1500));
    return true;
  }

  async function handleOptionalDialog() {
    const message = compact(state.settings.message);
    const editable = queryVisible('textarea,input[type="text"],[contenteditable="true"]')
      .reverse()
      .find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top > 0 && rect.bottom < window.innerHeight + 250;
      });

    if (editable && message) {
      editable.focus();
      if (editable.isContentEditable) {
        editable.innerText = message;
        editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
      } else if (!editable.value) {
        editable.value = message;
        editable.dispatchEvent(new Event('input', { bubbles: true }));
        editable.dispatchEvent(new Event('change', { bubbles: true }));
      }
      log('已填入招呼语，是否发送取决于页面按钮和你的确认设置。');
    }

    if (!state.settings.autoConfirmDialogs) return;

    const confirm = findClickableByText([
      '确认',
      '确定',
      '发送',
      '发送简历',
      '同意并继续',
      '继续沟通',
      '立即发送'
    ]);

    if (confirm) {
      clickLikeHuman(confirm);
      log(`已自动确认弹窗：${textOf(confirm)}`);
      await sleep(randomBetween(1000, 1800));
    }
  }

  async function processCard(card) {
    const job = extractJob(card);
    if (!job.key || state.seen.has(job.key)) return false;

    state.seen.add(job.key);
    saveSeen();

    if (!jobMatches(job)) {
      log(`筛选跳过：${job.title || job.raw.slice(0, 24)}`);
      return false;
    }

    clickLikeHuman(card.querySelector('a[href], .job-name, .job-title') || card);
    log(`打开岗位：${job.title || job.raw.slice(0, 24)}`);

    const applied = await applyCurrentDetail(job);
    if (applied) {
      state.count += 1;
      updatePanel();
      await sleep(Number(state.settings.intervalSeconds) * 1000 + randomBetween(800, 2600));
    }
    return applied;
  }

  async function goNextOrScroll() {
    const target = getJobScrollTarget();
    const oldMaxScrollTop = getMaxScrollTop(target);
    const moved = await smoothScrollBy(target, Math.floor(getScrollViewportHeight(target) * 0.68));
    await sleep(360);
    if (moved || getMaxScrollTop(target) > oldMaxScrollTop) return true;

    const next = findClickableByText(['下一页', '下页']);
    if (next && !/disabled|forbid/i.test(next.className || '')) {
      clickLikeHuman(next);
      log('进入下一页');
      await sleep(randomBetween(2200, 3600));
      return true;
    }
    return false;
  }

  async function run() {
    if (state.running) return;
    collectSettingsFromPanel();
    state.running = true;
    state.stopped = false;
    state.count = 0;
    updatePanel();
    log(state.settings.dryRun ? '开始试运行，不会真实点击投递按钮。' : '开始执行，请保持当前标签页打开。');

    try {
      let idleRounds = 0;
      while (!state.stopped && state.count < Number(state.settings.maxPerRun)) {
        const cards = findJobCards();
        let touched = false;

        for (const card of cards) {
          if (state.stopped || state.count >= Number(state.settings.maxPerRun)) break;
          const applied = await processCard(card);
          touched = touched || applied;
        }

        if (state.stopped || state.count >= Number(state.settings.maxPerRun)) break;
        const moved = await goNextOrScroll();
        idleRounds = touched || moved ? 0 : idleRounds + 1;
        if (idleRounds >= 2) break;
      }
    } catch (error) {
      log(`执行出错：${error.message || error}`);
    } finally {
      state.running = false;
      state.stopped = true;
      updatePanel();
      log(`结束，本轮命中 ${state.count} 个岗位。`);
    }
  }

  function stop() {
    state.stopped = true;
    state.running = false;
    log('已停止。');
    updatePanel();
  }

  function resetSeen() {
    state.seen = new Set();
    saveSeen();
    log('已清空本地已处理记录。');
    updatePanel();
  }

  function collectSettingsFromPanel() {
    const panel = document.querySelector('#boss-apply-helper');
    if (!panel) return;

    const nextSettings = { ...state.settings };
    panel.querySelectorAll('[data-setting]').forEach((input) => {
      const key = input.dataset.setting;
      if (input.type === 'checkbox') {
        nextSettings[key] = input.checked;
      } else if (input.type === 'number') {
        nextSettings[key] = Number(input.value);
      } else {
        nextSettings[key] = input.value;
      }
    });
    saveSettings(nextSettings);
  }

  function log(message) {
    state.logs.unshift(`[${now()}] ${message}`);
    state.logs = state.logs.slice(0, 80);
    updatePanel();
  }

  function makeInput(label, key, type = 'text') {
    const wrap = document.createElement('label');
    wrap.className = 'bah-field';
    wrap.innerHTML = `<span>${label}</span>`;
    const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    if (type !== 'textarea') input.type = type;
    input.dataset.setting = key;
    input.value = state.settings[key];
    input.addEventListener('change', () => {
      const value = type === 'number' ? Number(input.value) : input.value;
      saveSettings({ ...state.settings, [key]: value });
    });
    wrap.appendChild(input);
    return wrap;
  }

  function makeCheckbox(label, key) {
    const wrap = document.createElement('label');
    wrap.className = 'bah-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.setting = key;
    input.checked = Boolean(state.settings[key]);
    input.addEventListener('change', () => saveSettings({ ...state.settings, [key]: input.checked }));
    wrap.append(input, document.createTextNode(label));
    return wrap;
  }

  function restorePanelPosition(panel) {
    const position = state.settings.panelPosition;
    if (!position || typeof position.left !== 'number' || typeof position.top !== 'number') return;

    const rect = panel.getBoundingClientRect();
    const left = clamp(position.left, 8, Math.max(8, window.innerWidth - rect.width - 8));
    const top = clamp(position.top, 8, window.innerHeight - Math.min(rect.height, window.innerHeight - 16) - 8);

    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
    panel.style.right = 'auto';
  }

  function savePanelPosition(panel) {
    const rect = panel.getBoundingClientRect();
    saveSettings({
      ...state.settings,
      panelPosition: {
        left: Math.round(rect.left),
        top: Math.round(rect.top)
      }
    });
  }

  function makePanelDraggable(panel, handle) {
    if (!panel || !handle) return;

    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('button')) return;

      const rect = panel.getBoundingClientRect();
      dragging = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.right = 'auto';
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });

    handle.addEventListener('pointermove', (event) => {
      if (!dragging) return;

      const rect = panel.getBoundingClientRect();
      const nextLeft = clamp(startLeft + event.clientX - startX, 8, Math.max(8, window.innerWidth - rect.width - 8));
      const nextTop = clamp(startTop + event.clientY - startY, 8, Math.max(8, window.innerHeight - 48));
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
    });

    const finishDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      savePanelPosition(panel);
    };

    handle.addEventListener('pointerup', finishDrag);
    handle.addEventListener('pointercancel', finishDrag);
  }

  function createPanel() {
    const style = document.createElement('style');
    style.textContent = `
      #boss-apply-helper {
        position: fixed;
        right: 16px;
        top: 92px;
        z-index: 2147483647;
        width: 320px;
        max-height: calc(100vh - 120px);
        overflow: auto;
        color: #18212f;
        background: #ffffff;
        border: 1px solid #d8dee8;
        box-shadow: 0 12px 36px rgba(15, 23, 42, .18);
        border-radius: 8px;
        font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #boss-apply-helper * { box-sizing: border-box; }
      .bah-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #eef1f5;
        font-weight: 700;
        cursor: move;
        user-select: none;
        touch-action: none;
      }
      .bah-head button { cursor: pointer; }
      .bah-body { display: grid; gap: 9px; padding: 12px; }
      .bah-field { display: grid; gap: 4px; color: #526173; }
      .bah-field input,
      .bah-field textarea {
        width: 100%;
        border: 1px solid #cfd7e3;
        border-radius: 6px;
        padding: 7px 8px;
        font: inherit;
        color: #152033;
        background: #fff;
      }
      .bah-field textarea { min-height: 64px; resize: vertical; }
      .bah-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .bah-check { display: flex; align-items: center; gap: 7px; color: #314157; }
      .bah-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .bah-actions button,
      .bah-small {
        border: 1px solid #b9c6d8;
        border-radius: 6px;
        padding: 7px 8px;
        cursor: pointer;
        background: #f7f9fc;
        color: #172033;
        font: inherit;
      }
      .bah-actions button:first-child {
        border-color: #00a389;
        background: #00b899;
        color: #fff;
        font-weight: 700;
      }
      .bah-actions button:disabled { cursor: not-allowed; opacity: .55; }
      .bah-status {
        padding: 8px;
        border-radius: 6px;
        background: #f3f6fa;
        color: #334155;
      }
      .bah-log {
        height: 150px;
        overflow: auto;
        padding: 8px;
        border: 1px solid #edf0f5;
        border-radius: 6px;
        background: #fbfcfe;
        color: #475569;
        white-space: pre-wrap;
      }
    `;
    document.documentElement.appendChild(style);

    const panel = document.createElement('section');
    panel.id = 'boss-apply-helper';
    panel.innerHTML = `
      <div class="bah-head">
        <span>BOSS 投递助手</span>
        <button class="bah-small" data-action="collapse">收起</button>
      </div>
      <div class="bah-body"></div>
    `;
    document.body.appendChild(panel);
    restorePanelPosition(panel);
    makePanelDraggable(panel, panel.querySelector('.bah-head'));

    const body = panel.querySelector('.bah-body');
    body.appendChild(makeInput('包含关键词（逗号/空格分隔）', 'includeKeywords', 'textarea'));
    body.appendChild(makeInput('排除关键词（逗号/空格分隔）', 'excludeKeywords', 'textarea'));

    const row = document.createElement('div');
    row.className = 'bah-row';
    row.appendChild(makeInput('本轮上限', 'maxPerRun', 'number'));
    row.appendChild(makeInput('间隔秒数', 'intervalSeconds', 'number'));
    body.appendChild(row);

    body.appendChild(makeInput('招呼语', 'message', 'textarea'));
    body.appendChild(makeCheckbox('试运行：只记录命中，不真实点击', 'dryRun'));
    body.appendChild(makeCheckbox('自动确认发送/弹窗按钮', 'autoConfirmDialogs'));

    const actions = document.createElement('div');
    actions.className = 'bah-actions';
    actions.innerHTML = `
      <button data-action="start">开始</button>
      <button data-action="stop">停止</button>
      <button data-action="reset">清空记录</button>
      <button data-action="save">保存设置</button>
    `;
    body.appendChild(actions);

    const status = document.createElement('div');
    status.className = 'bah-status';
    status.dataset.role = 'status';
    body.appendChild(status);

    const logBox = document.createElement('div');
    logBox.className = 'bah-log';
    logBox.dataset.role = 'log';
    body.appendChild(logBox);

    panel.addEventListener('click', (event) => {
      const action = event.target && event.target.dataset ? event.target.dataset.action : '';
      if (!action) return;
      if (action === 'start') run();
      if (action === 'stop') stop();
      if (action === 'reset') resetSeen();
      if (action === 'save') {
        collectSettingsFromPanel();
        log('设置已保存。');
      }
      if (action === 'collapse') {
        body.style.display = body.style.display === 'none' ? 'grid' : 'none';
        event.target.textContent = body.style.display === 'none' ? '展开' : '收起';
      }
    });

    updatePanel();
  }

  function updatePanel() {
    const panel = document.querySelector('#boss-apply-helper');
    if (!panel) return;

    const status = panel.querySelector('[data-role="status"]');
    const logBox = panel.querySelector('[data-role="log"]');
    const start = panel.querySelector('[data-action="start"]');
    const stopButton = panel.querySelector('[data-action="stop"]');

    if (status) {
      status.textContent = `状态：${state.running ? '运行中' : '已停止'} | 本轮：${state.count}/${state.settings.maxPerRun} | 已记录：${state.seen.size}`;
    }
    if (logBox) {
      logBox.textContent = state.logs.join('\n') || '等待开始...';
    }
    if (start) start.disabled = state.running;
    if (stopButton) stopButton.disabled = !state.running;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel);
  } else {
    createPanel();
  }
})();
