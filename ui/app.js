import { getInboxCounts, matchesInboxFilter } from './inbox.mjs';
import { runButtonAction } from './feedback.mjs';
import { getUsageCounts, matchesUsageView, sortSkillsForUsageView } from './usage.mjs';

const byId = (id) => document.getElementById(id);

const state = {
  catalog: { skills: [] },
  categories: [],
  usage: { schema_version: 1, favorites: [], recent: [] },
  selectedId: null,
  categoryFilter: '',
  categoryDialogMode: 'add',
  categoryDialogTarget: null,
  categoriesOpen: false,
  inboxFilter: '',
  usageView: 'available',
};

let sessionPromise;
async function api(url, options = {}) {
  if (options.method === 'POST') {
    sessionPromise ??= fetch('/api/session').then((response) => {
      if (!response.ok) throw new Error('无法获取本地会话');
      return response.json();
    });
    const session = await sessionPromise;
    options = { ...options, headers: { ...options.headers, 'x-skill-manager-token': session.token } };
  }
  const response = await fetch(url, options);
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) throw new Error(payload.error || '请求失败');
  return payload;
}

function setStatus(message) {
  byId('status').textContent = message;
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  byId('toastRegion').append(toast);
  window.setTimeout(() => toast.remove(), 3200);
}

function currentSkill() {
  return state.catalog.skills.find((skill) => skill.id === state.selectedId) ?? null;
}

function renderCategories() {
  const container = byId('categories');
  container.replaceChildren();
  for (const category of state.categories) {
    const row = document.createElement('div');
    row.className = 'cat';
    if (category.id === state.categoryFilter) row.classList.add('active');

    const filter = document.createElement('button');
    filter.type = 'button';
    filter.textContent = `${category.name} (${state.catalog.skills.filter((skill) => skill.category === category.id).length})`;
    filter.onclick = () => {
      state.categoryFilter = state.categoryFilter === category.id ? '' : category.id;
      render();
    };

    const rename = document.createElement('button');
    rename.type = 'button';
    rename.textContent = '重命名';
    rename.title = `重命名分类：${category.name}`;
    rename.onclick = () => openCategoryDialog('rename', category);

    row.append(filter, rename);
    container.append(row);
  }
}

function toggleCategories() {
  state.categoriesOpen = !state.categoriesOpen;
  const panel = byId('categoryPanel');
  const toggle = byId('categoryToggle');
  panel.hidden = !state.categoriesOpen;
  toggle.setAttribute('aria-expanded', String(state.categoriesOpen));
  toggle.textContent = state.categoriesOpen ? '收起分类' : '分类';
}

function openCategoryDialog(mode, category = null) {
  state.categoryDialogMode = mode;
  state.categoryDialogTarget = category;
  byId('categoryDialogTitle').textContent = mode === 'rename' ? '重命名分类' : '新增分类';
  byId('categoryId').value = category?.id ?? '';
  byId('categoryId').readOnly = mode === 'rename';
  byId('categoryName').value = category?.name ?? '';
  byId('categoryDialog').hidden = false;
  (mode === 'rename' ? byId('categoryName') : byId('categoryId')).focus();
}

function closeCategoryDialog() {
  byId('categoryDialog').hidden = true;
  state.categoryDialogTarget = null;
}

async function saveCategory(event) {
  event.preventDefault();
  const id = byId('categoryId').value.trim();
  const name = byId('categoryName').value.trim();
  if (!id || !name) return;
  try {
    const isRename = state.categoryDialogMode === 'rename';
    const target = state.categoryDialogTarget;
    const result = isRename
      ? await api(`/api/categories/${encodeURIComponent(target.id)}/rename`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
      : await api('/api/categories', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, name }) });
    state.categories = result.categories ?? state.categories;
    if (isRename) state.catalog = await api('/api/catalog');
    closeCategoryDialog();
    render();
    setStatus(isRename ? '分类已更新' : '分类已新增');
  } catch (error) {
    setStatus(error.message);
  }
}

function renderSkills() {
  const query = byId('search').value.trim().toLowerCase();
  const source = byId('source').value;
  const status = byId('statusFilter').value;
  const list = byId('list');
  list.replaceChildren();

  const filtered = state.catalog.skills.filter((skill) => {
    const haystack = `${skill.display_name ?? ''} ${skill.original_name ?? ''} ${skill.short_description ?? ''} ${skill.original_description ?? ''}`.toLowerCase();
    return (!query || haystack.includes(query))
      && (!source || skill.source === source)
      && (!status || skill.localization_status === status)
      && matchesInboxFilter(skill, state.inboxFilter)
      && matchesUsageView(skill, state.usageView, state.usage)
      && (!state.categoryFilter || skill.category === state.categoryFilter);
  });
  const skills = sortSkillsForUsageView(filtered, state.usageView, state.usage);
  byId('listCount').textContent = `${skills.length} 个结果`;
  if (state.selectedId && !skills.some((skill) => skill.id === state.selectedId)) {
    state.selectedId = null;
    fillEditor();
  }

  if (skills.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = state.usageView === 'favorites' ? '暂无收藏' : state.usageView === 'recent' ? '暂无最近引用' : state.usageView === 'available' ? '暂无可用的 Skill' : '没有匹配的 Skill';
    list.append(empty);
    return;
  }

  for (const skill of skills) {
    const row = document.createElement('div');
    row.className = 'skill-row';
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'item';
    if (skill.id === state.selectedId) item.classList.add('active');
    const title = document.createElement('span');
    title.className = 'skill-title';
    title.textContent = skill.display_name || skill.original_name;
    const invocation = document.createElement('span');
    invocation.className = 'skill-invocation';
    invocation.textContent = `$${skill.original_name}`;
    const summary = document.createElement('span');
    summary.className = 'skill-summary';
    summary.textContent = skill.short_description || skill.original_description || '';
    const badge = document.createElement('span');
    badge.className = `skill-badge ${skill.available === false ? 'is-unavailable' : 'is-available'}`;
    badge.textContent = skill.available === false ? '已失效' : '可用';
    item.append(title, invocation, summary, badge);
    item.onclick = () => {
      state.selectedId = skill.id;
      renderSkills();
      fillEditor();
    };
    const favorite = document.createElement('button');
    const isFavorite = state.usage.favorites.includes(skill.id);
    favorite.type = 'button';
    favorite.className = 'favorite-button action-button';
    favorite.classList.toggle('is-favorite', isFavorite);
    favorite.textContent = isFavorite ? '★' : '☆';
    favorite.title = isFavorite ? `取消收藏：${skill.display_name || skill.original_name}` : `收藏：${skill.display_name || skill.original_name}`;
    favorite.setAttribute('aria-label', favorite.title);
    favorite.setAttribute('aria-pressed', String(isFavorite));
    favorite.onclick = (event) => toggleFavorite(event, skill, !isFavorite);
    row.append(item, favorite);
    list.append(row);
  }
}

function renderUsageViews() {
  const counts = getUsageCounts(state.catalog.skills, state.usage);
  byId('allCount').textContent = state.catalog.skills.length;
  byId('availableCount').textContent = state.catalog.skills.filter((skill) => skill.available !== false).length;
  byId('favoriteCount').textContent = counts.favorites;
  byId('recentCount').textContent = counts.recent;
  for (const button of document.querySelectorAll('[data-usage-view]')) {
    button.classList.toggle('active', button.dataset.usageView === state.usageView && !state.inboxFilter);
    button.setAttribute('aria-pressed', String(button.classList.contains('active')));
  }
}

function renderInbox() {
  const counts = getInboxCounts(state.catalog.skills);
  byId('pendingCount').textContent = counts.pending;
  byId('repairCount').textContent = counts.repair;
  byId('unavailableCount').textContent = counts.unavailable;
  for (const button of document.querySelectorAll('[data-inbox]')) {
    button.classList.toggle('active', Boolean(button.dataset.inbox) && button.dataset.inbox === state.inboxFilter);
    button.setAttribute('aria-pressed', String(button.classList.contains('active')));
  }
}

function fillEditor() {
  const skill = currentSkill();
  const form = byId('edit');
  form.hidden = !skill;
  byId('workspace').classList.toggle('has-selection', Boolean(skill));
  if (!skill) return;
  byId('detailTitle').textContent = skill.display_name || skill.original_name;
  byId('detailStatus').textContent = skill.available === false ? '已失效' : '可用';
  byId('detailStatus').className = `skill-badge ${skill.available === false ? 'is-unavailable' : 'is-available'}`;
  for (const id of ['name', 'summary', 'category', 'confirmed', 'restore', 'useSkill']) byId(id).disabled = skill.available === false;
  form.querySelector('button[type="submit"]').disabled = skill.available === false;
  byId('name').value = skill.display_name || '';
  byId('summary').value = skill.short_description || '';
  const category = byId('category');
  category.replaceChildren();
  for (const option of state.categories) {
    const item = document.createElement('option');
    item.value = option.id;
    item.textContent = option.name;
    item.selected = option.id === skill.category;
    category.append(item);
  }
  const original = byId('original');
  original.replaceChildren();
  const invocation = document.createElement('div');
  invocation.textContent = `英文调用名：$${skill.original_name}`;
  const description = document.createElement('div');
  description.textContent = `英文说明：${skill.original_description || ''}`;
  original.append(invocation, description);
  const source = document.createElement('div');
  source.textContent = `来源：${skill.source} · ${skill.path}`;
  original.append(source);
}

function render() {
  renderUsageViews();
  renderInbox();
  renderCategories();
  renderSkills();
  fillEditor();
}

async function saveSkill(event) {
  event.preventDefault();
  const button = event.submitter;
  const skill = currentSkill();
  if (!skill) return;
  const outcome = await runButtonAction(button, () => api(`/api/skills/${encodeURIComponent(skill.id)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        displayName: byId('name').value,
        shortDescription: byId('summary').value,
        category: byId('category').value,
        confirmed: byId('confirmed')?.checked === true,
      }),
    }), {
      busyText: '保存中', successText: '已保存', errorText: '保存失败',
      successMessage: 'Skill 已保存', notify: showToast,
    });
  if (outcome.ok) {
    const result = outcome.value;
    const index = state.catalog.skills.findIndex((item) => item.id === skill.id);
    if (index >= 0 && result.skill) state.catalog.skills[index] = result.skill;
    render();
    setStatus('Skill 已保存');
  } else {
    setStatus(outcome.error.message);
  }
}

async function restoreSkill(event) {
  const button = event?.currentTarget;
  const skill = currentSkill();
  if (!skill) return;
  const outcome = await runButtonAction(button, () => api(`/api/skills/${encodeURIComponent(skill.id)}/restore`, { method: 'POST' }), {
    busyText: '恢复中', successText: '已恢复', errorText: '恢复失败',
    successMessage: '已恢复原始元数据', notify: showToast,
  });
  if (outcome.ok) {
    const result = outcome.value;
    if (result.catalog) state.catalog = result.catalog;
    else if (result.skill) {
      const index = state.catalog.skills.findIndex((item) => item.id === skill.id);
      if (index >= 0) state.catalog.skills[index] = result.skill;
    }
    render();
    setStatus('已恢复原始元数据');
  } else {
    setStatus(outcome.error.message);
  }
}

async function useSkill(event) {
  const button = event?.currentTarget;
  const skill = currentSkill();
  if (!skill?.original_name) return;
  const invocation = `$${skill.original_name}`;
  const outcome = await runButtonAction(button, async () => {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(invocation);
    } else {
      const fallback = document.createElement('textarea');
      fallback.value = invocation;
      fallback.setAttribute('readonly', '');
      fallback.style.position = 'fixed';
      fallback.style.opacity = '0';
      document.body.append(fallback);
      fallback.select();
      if (!document.execCommand('copy')) throw new Error('浏览器不支持复制');
      fallback.remove();
    }
    try {
      return await api(`/api/skills/${encodeURIComponent(skill.id)}/use`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
    } catch (error) {
      throw new Error(`已复制 ${invocation}，但记录最近引用失败：${error.message}`);
    }
  }, {
    busyText: '复制中', successText: '已复制', errorText: '复制失败',
    successMessage: `已复制 ${invocation}，请粘贴到聊天框`,
    errorMessage: (error) => error.message.includes('已复制') ? error.message : `复制失败，请手动输入 ${invocation}`,
    notify: showToast,
  });
  if (outcome.ok) {
    state.usage = outcome.value;
    render();
    setStatus(`已复制 ${invocation}，请粘贴到聊天框`);
  } else {
    setStatus(outcome.error.message.includes('已复制') ? outcome.error.message : `复制失败，请手动输入 ${invocation}`);
  }
}

async function toggleFavorite(event, skill, favorite) {
  const button = event.currentTarget;
  const outcome = await runButtonAction(button, () => api(`/api/skills/${encodeURIComponent(skill.id)}/favorite`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ favorite }),
  }), {
    successMessage: favorite ? '已加入我的收藏' : '已取消收藏',
    errorMessage: (error) => `收藏操作失败：${error.message}`,
    notify: showToast,
  });
  if (outcome.ok) {
    state.usage = outcome.value;
    render();
    setStatus(favorite ? '已加入我的收藏' : '已取消收藏');
  } else {
    setStatus(`收藏操作失败：${outcome.error.message}`);
  }
}

async function scan(event) {
  const button = event?.currentTarget;
  const outcome = await runButtonAction(button, () => api('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), {
    busyText: '扫描中', successText: '扫描完成', errorText: '扫描失败',
    successMessage: '扫描完成', notify: showToast,
  });
  if (outcome.ok) {
    state.catalog = outcome.value;
    render();
    setStatus('扫描完成');
  } else {
    setStatus(outcome.error.message);
  }
}

async function load() {
  try {
    const [catalog, categoryData, usage] = await Promise.all([api('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), api('/api/categories'), api('/api/usage')]);
    state.catalog = catalog;
    state.categories = categoryData.categories ?? [];
    state.usage = usage;
    render();
  } catch (error) {
    setStatus(error.message);
  }
}

byId('scan').onclick = scan;
byId('categoryToggle').onclick = toggleCategories;
byId('addCategory').onclick = () => openCategoryDialog('add');
byId('categoryForm').onsubmit = saveCategory;
byId('categoryCancel').onclick = closeCategoryDialog;
byId('edit').onsubmit = saveSkill;
byId('restore').onclick = restoreSkill;
byId('useSkill').onclick = useSkill;
byId('search').oninput = render;
byId('source').onchange = render;
byId('statusFilter').onchange = render;
for (const button of document.querySelectorAll('[data-inbox]')) {
  button.onclick = () => {
    state.usageView = 'all';
    state.inboxFilter = button.dataset.inbox;
    byId('statusFilter').value = '';
    render();
  };
}
for (const button of document.querySelectorAll('[data-usage-view]')) {
  button.onclick = () => {
    state.usageView = button.dataset.usageView;
    state.inboxFilter = '';
    render();
  };
}
load();
