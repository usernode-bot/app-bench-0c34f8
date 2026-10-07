// Tier List client. Renders the shared tier board (My tiers / Crowd),
// drag-to-rank through the platform's native UI kit, the per-thing panel
// (your tier + how everyone voted), Add and Report.
//
// Every class name below is a whole literal: the Tailwind compiler scans
// this file as text and cannot see a class assembled from fragments.
(() => {
  'use strict';

  const TIERS = ['S', 'A', 'B', 'C', 'D', 'F'];
  // Board rows top to bottom; the unranked tray is the last drop target.
  const ROWS = TIERS.concat('none');
  const ROW_INDEX = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5, none: 6 };
  const TIER_RANK = { S: 0, A: 1, B: 2, C: 3, D: 4, F: 5 };
  // Whole literals, never "bg-tier-" + tier.toLowerCase().
  const TIER_BG = {
    S: 'bg-tier-s',
    A: 'bg-tier-a',
    B: 'bg-tier-b',
    C: 'bg-tier-c',
    D: 'bg-tier-d',
    F: 'bg-tier-f',
  };

  // The iframe loads the app with ?token=…; the server expects it back on
  // every fetch as x-usernode-token.
  const token = new URLSearchParams(location.search).get('token');
  const native = window.unNative || null;

  const state = { status: 'loading', tab: 'mine', board: null };

  const boardRoot = document.querySelector('[data-board]');
  const tabButtons = Array.from(document.querySelectorAll('[role="tab"]'));
  const addButton = document.getElementById('add-button');

  let dragHandle = null;
  let deferUntilSettle = false; // hold re-renders while a drag is live
  let pendingRender = false;
  let clickSuppressedUntil = 0; // a click right after a drag is not a tap
  let panel = null; // { item, content, sheet? , dialog? }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function api(path, options = {}) {
    const headers = Object.assign({}, options.headers);
    if (token) headers['x-usernode-token'] = token;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(path, Object.assign({}, options, { headers }));
    let data = null;
    if (res.status !== 204) {
      try { data = await res.json(); } catch (_) { data = null; }
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'request_failed');
      err.code = data ? data.error : undefined;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(message) {
    if (native && typeof native.toast === 'function') native.toast(message);
    else console.warn('[toast] ' + message);
  }

  // ── Local state updates ──────────────────────────────────────────────

  // The tier most people picked; a tie goes to the higher tier.
  function crowdTierOf(votes) {
    const counts = new Map();
    for (const v of votes) counts.set(v.tier, (counts.get(v.tier) || 0) + 1);
    let best = null;
    for (const t of TIERS) {
      if (counts.has(t) && (best === null || counts.get(t) > counts.get(best))) best = t;
    }
    return best;
  }

  function voteSort(a, b) {
    return (TIER_RANK[a.tier] - TIER_RANK[b.tier]) || a.username.localeCompare(b.username);
  }

  // Apply my vote (or its removal) to local state: no refetch — the board
  // only refetches after Add and after a successful Retry.
  function applyLocalVote(item, tier) {
    const me = state.board ? state.board.me : null;
    item.votes = (item.votes || []).filter(v => !v.isMe);
    if (tier && me) item.votes.push({ username: me.username, tier, isMe: true });
    item.votes.sort(voteSort);
    item.voteCount = item.votes.length;
    item.myTier = tier || null;
    item.crowdTier = crowdTierOf(item.votes);
  }

  function findItem(id) {
    return state.board ? state.board.items.find(i => i.id === Number(id)) : undefined;
  }

  // ── Rendering ────────────────────────────────────────────────────────

  function render() {
    if (deferUntilSettle) { pendingRender = true; return; }
    if (dragHandle) { dragHandle.detach(); dragHandle = null; }
    boardRoot.replaceChildren(...buildBoard());
    if (state.status === 'ready' && state.tab === 'mine') attachDrag();
  }

  function letterTile(tier) {
    return el('div',
      'flex h-14 w-14 flex-none items-center justify-center font-display text-title font-extrabold text-on-tier '
        + TIER_BG[tier], tier);
  }

  function chipEl(item, showVotes) {
    const chip = el('button', 'chip', item.name);
    chip.type = 'button';
    chip.dataset.itemChip = '';
    chip.dataset.itemId = String(item.id);
    if (showVotes && item.voteCount > 0) {
      chip.appendChild(el('em', undefined,
        item.voteCount === 1 ? '1 vote' : item.voteCount + ' votes'));
    }
    return chip;
  }

  function buildBoard() {
    if (state.status === 'loading') return buildLoading();
    if (state.status === 'error') return buildError();

    const items = state.board ? state.board.items : [];
    const mine = state.tab === 'mine';
    const showVotes = !mine;
    const inTier = item => (mine ? item.myTier : item.crowdTier);

    const board = el('div', 'overflow-hidden rounded-xl border border-line bg-surface');
    for (const tier of TIERS) {
      const row = el('div', 'tier-row');
      row.dataset.tierRow = tier;
      row.appendChild(letterTile(tier));
      const chips = el('div',
        'flex min-h-14 flex-1 flex-wrap content-center items-center gap-1.5 p-2');
      chips.dataset.chips = '';
      for (const item of items) {
        if (inTier(item) === tier) chips.appendChild(chipEl(item, showVotes));
      }
      row.appendChild(chips);
      board.appendChild(row);
    }

    const trayBlock = el('div');
    trayBlock.appendChild(el('p', 'section-label',
      mine ? 'Not ranked yet' : 'Nobody has ranked yet'));
    const tray = el('div',
      'flex min-h-14 flex-wrap content-start items-start gap-1.5 rounded-xl border border-dashed border-line p-2');
    tray.dataset.tierRow = 'none';
    if (items.length === 0 && mine) {
      const empty = el('div', 'state-empty w-full');
      empty.appendChild(el('p', 'text-body font-medium', 'Nothing to rank yet'));
      empty.appendChild(el('p', 'text-small text-muted',
        'Add the first thing, like a favourite taco spot.'));
      const add = el('button', 'btn-secondary', 'Add');
      add.type = 'button';
      add.addEventListener('click', addFlow);
      empty.appendChild(add);
      tray.appendChild(empty);
    } else {
      for (const item of items) {
        if (!inTier(item)) tray.appendChild(chipEl(item, showVotes));
      }
    }
    trayBlock.appendChild(tray);
    if (mine && items.length > 0) {
      trayBlock.appendChild(el('p', 'px-1 pt-2 text-small text-muted',
        'Drag a thing into a tier, or tap it to pick one.'));
    }
    return [board, trayBlock];
  }

  function buildLoading() {
    const board = el('div', 'overflow-hidden rounded-xl border border-line bg-surface');
    for (const tier of TIERS) {
      const row = el('div', 'tier-row');
      row.dataset.tierRow = tier;
      row.appendChild(letterTile(tier));
      const chips = el('div', 'flex min-h-14 flex-1 items-center p-2');
      chips.appendChild(el('span', 'skeleton h-11 w-40'));
      row.appendChild(chips);
      board.appendChild(row);
    }
    // The tray is part of the settled layout, so it gets a placeholder too
    // — otherwise the board jumps into place when loading finishes.
    const trayBlock = el('div');
    trayBlock.appendChild(el('p', 'section-label',
      state.tab === 'mine' ? 'Not ranked yet' : 'Nobody has ranked yet'));
    const tray = el('div',
      'flex min-h-14 flex-wrap content-start items-start gap-1.5 rounded-xl border border-dashed border-line p-2');
    tray.dataset.tierRow = 'none';
    tray.appendChild(el('span', 'skeleton h-11 w-40'));
    tray.appendChild(el('span', 'skeleton h-11 w-32'));
    trayBlock.appendChild(tray);
    return [board, trayBlock];
  }

  function buildError() {
    const box = el('div', 'state-error w-full rounded-xl border border-line bg-surface');
    box.appendChild(el('p', 'text-heading', "Couldn't load the board"));
    box.appendChild(el('p', 'text-small text-muted', 'Nothing you ranked is lost.'));
    const retry = el('button', 'btn-secondary', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', loadBoard);
    box.appendChild(retry);
    return [box];
  }

  // ── Data ─────────────────────────────────────────────────────────────

  async function loadBoard() {
    state.status = 'loading';
    render();
    try {
      state.board = await api('/api/board');
      state.status = 'ready';
    } catch (_) {
      state.status = 'error';
    }
    render();
  }

  // Quiet refetch: keeps the screen as it is unless the board changed.
  async function refreshBoard() {
    try {
      state.board = await api('/api/board');
      state.status = 'ready';
      render();
    } catch (_) { /* keep what is on screen */ }
  }

  // ── Saving a tier (drag, panel buttons and Unrank all land here) ─────

  async function saveTier(item, tier) {
    const prev = item.myTier || null;
    if (!state.board || !state.board.me) {
      toast('Make an account to rank things');
      return;
    }
    if (prev === tier) return;
    applyLocalVote(item, tier);
    render();
    refreshOpenPanel(item);
    try {
      if (tier === null) {
        await api('/api/items/' + item.id + '/vote', { method: 'DELETE' });
      } else {
        await api('/api/items/' + item.id + '/vote',
          { method: 'PUT', body: JSON.stringify({ tier }) });
      }
    } catch (err) {
      applyLocalVote(item, prev);
      render();
      refreshOpenPanel(item);
      if (err.code === 'account_required') toast('Make an account to rank things');
      else if (err.status === 404) {
        toast('That thing is no longer on the board');
        closePanel();
        loadBoard();
      } else toast("Couldn't save your tier. Try again.");
    }
  }

  // ── Drag to rank (My tiers, native kit only) ─────────────────────────

  function clearTargets() {
    boardRoot.querySelectorAll('[data-tier-row]').forEach(row => row.classList.remove('is-target'));
  }

  function attachDrag() {
    if (!native || typeof native.attachGridPlacement !== 'function' || dragHandle) return;
    dragHandle = native.attachGridPlacement(boardRoot, {
      itemSelector: '[data-item-chip]',
      // Resolve the target from the dragged chip's centre, not the finger.
      cellFromPoint(_x, _y, info) {
        for (const node of document.elementsFromPoint(info.centerX, info.centerY)) {
          const row = node.closest && node.closest('[data-tier-row]');
          if (row) return { col: 0, row: ROW_INDEX[row.dataset.tierRow] };
        }
        return null;
      },
      canPlace() { return true; },
      onHover(_item, cell) {
        clearTargets();
        if (!cell) return;
        const row = boardRoot.querySelector('[data-tier-row="' + ROWS[cell.row] + '"]');
        if (row) row.classList.add('is-target');
      },
      rectForCell(_item, cell) {
        const row = boardRoot.querySelector('[data-tier-row="' + ROWS[cell.row] + '"]');
        const chips = row && row.querySelector('[data-chips]');
        return chips ? chips.getBoundingClientRect() : null;
      },
      onLift() {
        deferUntilSettle = true;
        clickSuppressedUntil = Date.now() + 1000;
      },
      onPlace(item, cell) {
        const id = item && item.dataset ? Number(item.dataset.itemId) : NaN;
        const found = findItem(id);
        if (!found) return;
        const tier = ROWS[cell.row];
        saveTier(found, tier === 'none' ? null : tier);
      },
      onSettle() {
        deferUntilSettle = false;
        clearTargets();
        clickSuppressedUntil = Date.now() + 400;
        if (pendingRender) { pendingRender = false; render(); }
      },
    });
  }

  // ── The per-thing panel ──────────────────────────────────────────────

  function fillPanel(container, item) {
    container.replaceChildren();

    const head = el('div', 'flex flex-col gap-1');
    head.appendChild(el('h2', 'text-heading', item.name));
    head.appendChild(el('p', 'text-small text-muted', 'Added by ' + item.createdBy));
    container.appendChild(head);

    const tierBlock = el('div');
    tierBlock.appendChild(el('p', 'section-label', 'Your tier'));
    const tierRow = el('div', 'flex gap-1.5');
    for (const tier of TIERS) {
      const button = el('button',
        'flex h-11 flex-1 items-center justify-center rounded-lg font-display text-body font-extrabold text-on-tier '
          + TIER_BG[tier], tier);
      button.type = 'button';
      button.setAttribute('aria-label', 'Tier ' + tier);
      if ((item.myTier || null) === tier) {
        button.setAttribute('aria-pressed', 'true');
        button.classList.add('ring-2', 'ring-fg', 'ring-offset-2', 'ring-offset-surface');
      }
      button.addEventListener('click', () => saveTier(item, tier));
      tierRow.appendChild(button);
    }
    tierBlock.appendChild(tierRow);
    const unrank = el('button', 'btn-secondary mt-1.5 w-full', 'Unrank');
    unrank.type = 'button';
    unrank.disabled = !item.myTier;
    unrank.addEventListener('click', () => saveTier(item, null));
    tierBlock.appendChild(unrank);
    container.appendChild(tierBlock);

    const votesBlock = el('div');
    votesBlock.appendChild(el('p', 'section-label', 'How everyone voted'));
    if (item.votes.length === 0) {
      votesBlock.appendChild(el('p', 'px-1 text-small text-muted', 'No votes yet'));
    } else {
      const list = el('ul', 'list');
      for (const vote of item.votes) {
        const row = el('li', 'list-row');
        row.appendChild(el('span',
          'flex h-7 w-7 flex-none items-center justify-center rounded-md font-display text-body font-extrabold text-on-tier '
            + TIER_BG[vote.tier], vote.tier));
        row.appendChild(el('span', 'text-body', vote.isMe ? 'you' : vote.username));
        list.appendChild(row);
      }
      votesBlock.appendChild(list);
    }
    container.appendChild(votesBlock);

    const report = el('button', 'min-h-11 self-start text-small font-medium text-danger', 'Report');
    report.type = 'button';
    report.addEventListener('click', () => reportFlow(item));
    container.appendChild(report);
  }

  function refreshOpenPanel(item) {
    if (panel && panel.item === item) fillPanel(panel.content, item);
  }

  function closePanel() {
    if (!panel) return;
    if (panel.sheet && panel.sheet.dismiss) panel.sheet.dismiss();
    else if (panel.dialog) panel.dialog.close();
    panel = null;
  }

  function openPanel(item) {
    closePanel();
    const content = el('div', 'flex flex-col gap-4');
    fillPanel(content, item);
    if (native && typeof native.presentSheet === 'function') {
      const sheet = native.presentSheet({
        contentEl: content,
        onDismiss() { if (panel && panel.content === content) panel = null; },
      });
      panel = { item, content, sheet };
    } else {
      // Plain local run without the hosted kit: a plain <dialog> instead.
      console.warn('unNative not loaded: the item panel falls back to a <dialog>');
      const dialog = document.createElement('dialog');
      dialog.className =
        'm-auto w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-4 text-fg backdrop:bg-ground/80';
      dialog.appendChild(content);
      dialog.addEventListener('close', () => { if (panel && panel.content === content) panel = null; });
      document.body.appendChild(dialog);
      dialog.showModal();
      panel = { item, content, dialog };
    }
  }

  // ── Report ───────────────────────────────────────────────────────────

  const REPORT_MESSAGE = 'It disappears for you now, and for everyone once 3 people report it.';

  async function reportFlow(item) {
    if (!state.board || !state.board.me) {
      toast('Make an account to report things');
      return;
    }
    let confirmed = false;
    if (native && typeof native.alert === 'function') {
      const result = await native.alert({
        title: 'Report this thing?',
        message: REPORT_MESSAGE,
        buttons: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Report', style: 'destructive' },
        ],
      });
      const label = result && result.button
        ? (typeof result.button === 'string' ? result.button : result.button.label)
        : null;
      confirmed = label === 'Report';
    } else {
      confirmed = await fallbackConfirm('Report this thing?', REPORT_MESSAGE, 'Report');
    }
    if (!confirmed) return;
    try {
      await api('/api/items/' + item.id + '/report', { method: 'POST' });
      closePanel();
      state.board.items = state.board.items.filter(i => i.id !== item.id);
      render();
      toast('Reported');
    } catch (err) {
      if (err.status === 404) {
        toast('That thing is no longer on the board');
        closePanel();
        loadBoard();
      } else if (err.code === 'account_required') toast('Make an account to report things');
      else toast("Couldn't report it. Try again.");
    }
  }

  // ── Add ──────────────────────────────────────────────────────────────

  async function addFlow() {
    if (!state.board || !state.board.me) {
      toast('Make an account to add things');
      return;
    }
    let name = '';
    if (native && typeof native.alert === 'function') {
      const result = await native.alert({
        title: 'Add a thing',
        field: { placeholder: 'e.g. Tartine Bakery' },
        buttons: [
          { label: 'Cancel', style: 'cancel' },
          { label: 'Add', style: 'default' },
        ],
      });
      const label = result && result.button
        ? (typeof result.button === 'string' ? result.button : result.button.label)
        : null;
      name = label === 'Add' && result.value ? result.value.trim() : '';
    } else {
      name = (await fallbackPrompt('Add a thing', 'e.g. Tartine Bakery')).trim();
    }
    if (!name) return;
    try {
      await api('/api/items', { method: 'POST', body: JSON.stringify({ name }) });
      await refreshBoard();
      toast('Added');
    } catch (err) {
      if (err.code === 'duplicate') toast("That's already on the board");
      else if (err.code === 'name_required' || err.code === 'name_too_long') {
        toast('Names are 1 to 60 characters');
      } else if (err.code === 'account_required') toast('Make an account to add things');
      else toast("Couldn't add it. Try again.");
    }
  }

  // ── Fallbacks for a plain local run without the hosted kit ───────────

  function fallbackPrompt(title, placeholder) {
    const body = el('form', 'flex flex-col gap-3');
    body.appendChild(el('h2', 'text-heading', title));
    const field = el('input', 'field');
    field.placeholder = placeholder;
    body.appendChild(field);
    const buttons = el('div', 'flex justify-end gap-2');
    const cancel = el('button', 'btn-secondary', 'Cancel');
    cancel.type = 'button';
    const add = el('button', 'btn-primary', 'Add');
    add.type = 'submit';
    buttons.appendChild(cancel);
    buttons.appendChild(add);
    body.appendChild(buttons);
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className =
        'm-auto w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-4 text-fg backdrop:bg-ground/80';
      dialog.appendChild(body);
      document.body.appendChild(dialog);
      const done = (value) => { dialog.close(); resolve(value); };
      cancel.addEventListener('click', () => done(null));
      body.addEventListener('submit', (e) => { e.preventDefault(); done(field.value); });
      dialog.addEventListener('close', () => { dialog.remove(); resolve(null); });
      dialog.showModal();
      field.focus();
    });
  }

  function fallbackConfirm(title, message, confirmLabel) {
    const body = el('div', 'flex flex-col gap-3');
    body.appendChild(el('h2', 'text-heading', title));
    body.appendChild(el('p', 'text-small text-muted', message));
    const buttons = el('div', 'flex justify-end gap-2');
    const cancel = el('button', 'btn-secondary', 'Cancel');
    cancel.type = 'button';
    const confirm = el('button', 'btn-primary', confirmLabel);
    confirm.type = 'button';
    buttons.appendChild(cancel);
    buttons.appendChild(confirm);
    body.appendChild(buttons);
    return new Promise((resolve) => {
      const dialog = document.createElement('dialog');
      dialog.className =
        'm-auto w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-4 text-fg backdrop:bg-ground/80';
      dialog.appendChild(body);
      document.body.appendChild(dialog);
      const done = (value) => { dialog.close(); resolve(value); };
      cancel.addEventListener('click', () => done(false));
      confirm.addEventListener('click', () => done(true));
      dialog.addEventListener('close', () => { dialog.remove(); resolve(false); });
      dialog.showModal();
    });
  }

  // ── Wiring ───────────────────────────────────────────────────────────

  function setTab(tab) {
    state.tab = tab;
    for (const button of tabButtons) {
      const active = button.dataset.tab === tab;
      button.setAttribute('aria-selected', active ? 'true' : 'false');
      button.classList.toggle('bg-fg', active);
      button.classList.toggle('text-ground', active);
      button.classList.toggle('text-muted', !active);
    }
    render();
  }

  for (const button of tabButtons) {
    button.addEventListener('click', () => setTab(button.dataset.tab));
  }
  tablistKeys();

  function tablistKeys() {
    // Left/right moves between the two tabs, as a tablist should.
    document.querySelector('[role="tablist"]').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = state.tab === 'mine' ? 'crowd' : 'mine';
      setTab(next);
      const target = tabButtons.find(b => b.dataset.tab === next);
      if (target) target.focus();
      e.preventDefault();
    });
  }

  addButton.addEventListener('click', addFlow);

  // Tap a chip to open its panel — unless the click follows a drag.
  boardRoot.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-item-chip]');
    if (!chip) return;
    if (Date.now() < clickSuppressedUntil) return;
    const item = findItem(chip.dataset.itemId);
    if (item) openPanel(item);
  });

  loadBoard();
})();
