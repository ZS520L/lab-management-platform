const user = window.CURRENT_USER;
const isAdmin = user.role === 'admin';
const COLLAPSED_FOLDERS_KEY = 'lab:collapsedFolders';

function loadCollapsedFolderIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY) || '[]').map(Number));
  } catch (err) {
    return new Set();
  }
}

function saveCollapsedFolderIds() {
  localStorage.setItem(COLLAPSED_FOLDERS_KEY, JSON.stringify([...state.collapsedFolderIds]));
}

const state = {
  folders: [],
  folderMap: new Map(),
  collapsedFolderIds: loadCollapsedFolderIds(),
  currentFolder: null,
  currentNoteId: null,
  currentPreviewFile: null,
  socket: null,
  remoteUpdating: false,
  editTimer: null,
  unreadAnnouncements: [],
  announcementPopupIndex: 0,
  webNavCategories: [],
  uploadFiles: []
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function toast(message, type = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${type}`;
  el.hidden = false;
  clearTimeout(el.timer);
  el.timer = setTimeout(() => { el.hidden = true; }, 2600);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[ch]));
}

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: options.body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    ...options
  });
  const contentType = res.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    let message = typeof payload === 'object' ? payload.error : payload;
    if (typeof message === 'string' && /<\/?[a-z][\s\S]*>/i.test(message)) {
      message = `请求失败：${res.status} ${res.statusText || ''}`.trim();
    }
    throw new Error(message || '请求失败');
  }
  return payload;
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(idx === 0 ? 0 : 1)} ${units[idx]}`;
}

function formatDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

function statusBadge(status) {
  const map = { approved: '已发布', pending: '待审核', rejected: '已拒绝' };
  return `<span class="status ${status}">${map[status] || status}</span>`;
}

function userLabel(item) {
  const name = item.username || item.display_name || '-';
  const identity = item.identity || (item.role === 'admin' ? '管理员' : '学生');
  const grade = item.grade || '';
  return `${grade}${name}(${identity})`;
}

function flattenFolders(folders) {
  folders.forEach(folder => {
    state.folderMap.set(folder.id, folder);
    flattenFolders(folder.children || []);
  });
}

async function loadTree() {
  const data = await api('/api/tree');
  state.folders = data.folders;
  state.folderMap = new Map();
  flattenFolders(state.folders);
  $('#folder-tree').innerHTML = renderFolderNodes(state.folders);
  if (state.currentFolder && state.folderMap.has(state.currentFolder.id)) {
    state.currentFolder = state.folderMap.get(state.currentFolder.id);
    Array.prototype.forEach.call(document.querySelectorAll('.tree-node'), btn => btn.classList.toggle('selected', Number(btn.dataset.folderId) === state.currentFolder.id));
    $('#folder-title').textContent = state.currentFolder.name;
    $('#folder-subtitle').textContent = `已发布 ${state.currentFolder.approved_count || 0} 个文件${isAdmin ? `，待审核 ${state.currentFolder.pending_count || 0} 个` : ''}`;
    $('#upload-folder-id').value = state.currentFolder.id;
    $('#upload-folder-name').value = state.currentFolder.name;
  } else if (state.folders[0]) {
    selectFolder(state.folders[0]);
  } else {
    state.currentFolder = null;
  }
}

function renderFolderNodes(nodes) {
  if (!nodes.length) return '<div class="empty">暂无目录</div>';
  return `<ul>${nodes.map(node => {
    const hasChildren = Boolean(node.children && node.children.length);
    const collapsed = state.collapsedFolderIds.has(node.id);
    const countText = `${node.approved_count || 0}${isAdmin && node.pending_count ? `/${node.pending_count}` : ''}`;
    return `
      <li class="${collapsed ? 'collapsed' : ''}">
        <div class="tree-line">
          ${hasChildren
            ? `<button class="tree-toggle" data-toggle-folder="${node.id}" title="${collapsed ? '展开目录' : '折叠目录'}">${collapsed ? '▶' : '▼'}</button>`
            : '<span class="tree-toggle-spacer"></span>'}
          <button class="tree-node" data-folder-id="${node.id}">
            <span>📁 ${escapeHtml(node.name)}</span>
            <span class="count">${countText}</span>
          </button>
        </div>
        ${hasChildren ? `<div class="tree-children">${renderFolderNodes(node.children)}</div>` : ''}
      </li>`;
  }).join('')}</ul>`;
}

function renderFolderOptions(nodes = state.folders, selectedId = null, depth = 0) {
  return nodes.map(node => {
    const prefix = depth > 0 ? '　'.repeat(depth) + '└ ' : '';
    const selected = Number(selectedId) === node.id ? 'selected' : '';
    const current = `<option value="${node.id}" ${selected}>${prefix}${escapeHtml(node.name)}</option>`;
    return current + renderFolderOptions(node.children || [], selectedId, depth + 1);
  }).join('');
}

function toggleFolderCollapse(folderId) {
  const id = Number(folderId);
  if (state.collapsedFolderIds.has(id)) state.collapsedFolderIds.delete(id);
  else state.collapsedFolderIds.add(id);
  saveCollapsedFolderIds();
  $('#folder-tree').innerHTML = renderFolderNodes(state.folders);
  if (state.currentFolder) {
    Array.from(document.querySelectorAll('.tree-node')).forEach(btn => btn.classList.toggle('selected', Number(btn.dataset.folderId) === state.currentFolder.id));
  }
}

function selectFolder(folder) {
  state.currentFolder = folder;
  $$('.tree-node').forEach(btn => btn.classList.toggle('selected', Number(btn.dataset.folderId) === folder.id));
  $('#folder-title').textContent = folder.name;
  $('#folder-subtitle').textContent = `已发布 ${folder.approved_count || 0} 个文件${isAdmin ? `，待审核 ${folder.pending_count || 0} 个` : ''}`;
  $('#upload-folder-id').value = folder.id;
  $('#upload-folder-name').value = folder.name;
  loadFiles();
}

async function loadFiles() {
  if (!state.currentFolder) return;
  const params = new URLSearchParams();
  const sort = $('#file-sort')?.value || 'uploader';
  params.set('sort', sort);
  if (isAdmin && $('#show-pending') && $('#show-pending').checked) params.set('include_pending', '1');
  const data = await api(`/api/folders/${state.currentFolder.id}/files?${params.toString()}`);
  const list = $('#file-list');
  if (!data.files.length) {
    list.className = 'file-list empty';
    list.textContent = '暂无文件';
    $('#file-detail').className = 'empty';
    $('#file-detail').textContent = '点击文件查看详情和预览。';
    return;
  }
  list.className = 'file-list';
  let lastUploader = null;
  list.innerHTML = data.files.map(file => {
    const groupHeader = sort === 'uploader' && file.uploader_name !== lastUploader
      ? `<div class="file-group-head">上传人：${escapeHtml(file.uploader_name || '-')}</div>`
      : '';
    lastUploader = file.uploader_name;
    return `${groupHeader}
    <div class="file-row" data-file-id="${file.id}">
      <span class="file-icon">${fileIcon(file)}</span>
      <span class="file-main">
        <strong>${escapeHtml(file.original_name)}</strong>
        <small>${escapeHtml(file.uploader_name)} · ${formatDate(file.created_at)} · ${fileTypeLabel(file)} · ${formatSize(file.size_bytes)}</small>
      </span>
      ${statusBadge(file.status)}
      ${canDeleteFile(file) ? `<button type="button" class="small danger-light" data-delete-file="${file.id}" data-file-name="${escapeHtml(file.original_name)}">删除</button>` : ''}
    </div>`;
  }).join('');
}

function canDeleteFile(file) {
  return isAdmin || (Number(file.uploader_id) === Number(user.id) && ['pending', 'rejected'].includes(file.status));
}

function canRenameFile(file) {
  return isAdmin || (Number(file.uploader_id) === Number(user.id) && ['pending', 'rejected'].includes(file.status));
}

function fileTypeLabel(file) {
  const ext = (file.ext || '').replace(/^\./, '').toUpperCase();
  if (ext) return ext;
  return file.mime_type || '未知类型';
}

function fileIcon(file) {
  const ext = (file.ext || '').toLowerCase();
  if (ext === '.pdf') return '📕';
  if (['.md', '.markdown'].includes(ext)) return '📝';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return '🖼️';
  if (['.doc', '.docx'].includes(ext)) return '📄';
  if (['.ppt', '.pptx'].includes(ext)) return '📽️';
  if (['.xls', '.xlsx', '.csv'].includes(ext)) return '📊';
  return '📦';
}

function filePreviewHtml(file) {
  const ext = (file.ext || '').toLowerCase();
  if (ext === '.pdf') return `<iframe class="preview-frame" src="${file.preview_url}" title="PDF 预览"></iframe>`;
  if (['.doc', '.docx', '.ppt', '.pptx'].includes(ext)) {
    const tip = file.office_preview_ready
      ? ''
      : '<div class="office-preview-tip">正在后台准备 PDF 预览。转换完成后，其他用户会直接打开缓存，不需要再等待。</div>';
    return `
      <div class="office-preview-wrap">
        ${tip}
        <iframe class="preview-frame" src="/api/files/${file.id}/office-preview" title="Office 转 PDF 预览" onload="this.closest('.office-preview-wrap')?.querySelector('.office-preview-tip')?.remove()"></iframe>
      </div>
    `;
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) return `<img class="image-preview" src="${file.preview_url}" alt="${escapeHtml(file.original_name)}" />`;
  if (['.md', '.markdown'].includes(ext) && file.html_preview) return `<article class="markdown-preview">${file.html_preview}</article>`;
  if (ext === '.txt' && file.text_preview) return `<pre class="text-preview">${escapeHtml(file.text_preview)}</pre>`;
  return '<div class="empty">该类型暂不支持在线预览，请下载查看。</div>';
}

async function loadFileDetail(id) {
  const { file } = await api(`/api/files/${id}`);
  state.currentPreviewFile = file;
  const detail = $('#file-detail');
  const preview = filePreviewHtml(file);

  const audit = `
    <dl class="meta">
      <div><dt>目录</dt><dd>${escapeHtml(file.folder_name)}</dd></div>
      <div><dt>上传人</dt><dd>${escapeHtml(file.uploader_name)}</dd></div>
      <div><dt>上传时间</dt><dd>${formatDate(file.created_at)}</dd></div>
      <div><dt>大小</dt><dd>${formatSize(file.size_bytes)}</dd></div>
      <div><dt>类型</dt><dd>${escapeHtml(file.mime_type || file.ext || '未知')}</dd></div>
      <div><dt>状态</dt><dd>${statusBadge(file.status)}</dd></div>
      ${file.approved_by_name ? `<div><dt>审核人</dt><dd>${escapeHtml(file.approved_by_name)}</dd></div>` : ''}
      ${file.approved_at ? `<div><dt>审核时间</dt><dd>${formatDate(file.approved_at)}</dd></div>` : ''}
      ${file.reject_reason ? `<div><dt>拒绝原因</dt><dd>${escapeHtml(file.reject_reason)}</dd></div>` : ''}
    </dl>`;

  const adminReviewActions = isAdmin && file.status === 'pending'
    ? `<div class="actions"><button class="primary" data-approve="${file.id}">通过</button><button class="danger" data-reject="${file.id}">拒绝</button></div>`
    : '';
  const renameFileAction = canRenameFile(file)
    ? `<button type="button" data-rename-file="${file.id}" data-file-name="${escapeHtml(file.original_name)}">修改文件名</button>`
    : '';
  const adminFileActions = isAdmin
    ? `<button data-move-file="${file.id}" data-file-name="${escapeHtml(file.original_name)}" data-current-folder="${file.folder_id}">移动文件</button>`
    : '';
  const deleteFileAction = canDeleteFile(file)
    ? `<button type="button" class="danger-light" data-delete-file="${file.id}" data-file-name="${escapeHtml(file.original_name)}">删除记录</button>`
    : '';

  detail.className = '';
  detail.innerHTML = `
    <div class="file-detail-header">
      <h2>${escapeHtml(file.original_name)}</h2>
      <div class="actions"><a class="button" href="${file.download_url}">下载文件</a>${renameFileAction}${adminFileActions}${deleteFileAction}</div>
      ${adminReviewActions}
    </div>
    <details class="file-info-collapse">
      <summary>文件信息</summary>
      ${audit}
      ${file.description ? `<p class="description">${escapeHtml(file.description)}</p>` : ''}
    </details>
    <section class="preview-section">
      <div class="preview-section-head">
        <h3>在线预览</h3>
        <button type="button" class="small" data-open-preview="${file.id}">全屏预览</button>
      </div>
      ${preview}
    </section>
  `;
}

function setUploadFiles(files) {
  state.uploadFiles = Array.from(files || []).filter(file => file && file.name);
  const input = $('#upload-file-input');
  if (input && typeof DataTransfer !== 'undefined') {
    const transfer = new DataTransfer();
    state.uploadFiles.forEach(file => transfer.items.add(file));
    input.files = transfer.files;
  }
  renderUploadFileList();
}

function renderUploadFileList(message = '') {
  const list = $('#upload-file-list');
  if (!list) return;
  if (message) {
    list.className = 'upload-file-list upload-progress';
    list.textContent = message;
    return;
  }
  if (!state.uploadFiles.length) {
    list.className = 'upload-file-list muted';
    list.textContent = '尚未选择文件';
    return;
  }
  const totalSize = state.uploadFiles.reduce((sum, file) => sum + file.size, 0);
  list.className = 'upload-file-list';
  list.innerHTML = `
    <strong>已选择 ${state.uploadFiles.length} 个文件，共 ${formatSize(totalSize)}</strong>
    <ul>
      ${state.uploadFiles.map(file => `<li>${escapeHtml(file.name)} <span>${formatSize(file.size)}</span></li>`).join('')}
    </ul>
  `;
}

async function uploadCurrentFile(event) {
  event.preventDefault();
  if (!state.currentFolder) return toast('请先选择目录', 'error');
  const form = $('#upload-form');
  const files = state.uploadFiles.length ? state.uploadFiles : Array.from($('#upload-file-input')?.files || []);
  if (!files.length) return toast('请选择或拖拽至少 1 个文件', 'error');
  const description = safeTextForForm(form.elements.description?.value || '');
  const submit = form.querySelector('button[type="submit"]');
  submit.disabled = true;
  const failed = [];
  let success = 0;
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      renderUploadFileList(`正在上传 ${index + 1} / ${files.length}：${file.name}`);
      const formData = new FormData();
      formData.set('folder_id', String(state.currentFolder.id));
      formData.set('description', description);
      formData.append('file', file, file.name);
      try {
        await api('/api/upload', { method: 'POST', body: formData });
        success += 1;
      } catch (err) {
        failed.push(`${file.name}：${err.message}`);
      }
    }
  } finally {
    submit.disabled = false;
  }
  if (failed.length) {
    renderUploadFileList(`上传完成：成功 ${success} 个，失败 ${failed.length} 个`);
    toast(`成功 ${success} 个，失败 ${failed.length} 个`, 'error');
  } else {
    $('#upload-dialog').close();
    form.reset();
    setUploadFiles([]);
    toast(isAdmin ? `上传成功，已发布 ${success} 个文件` : `上传成功，${success} 个文件等待管理员审核`);
  }
  await loadTree();
  await loadFiles();
  if (isAdmin) await loadPendingFiles();
}

function safeTextForForm(value) {
  return String(value ?? '').trim();
}

async function createFolder(event) {
  event.preventDefault();
  if (!isAdmin) return;
  const form = $('#folder-form');
  const body = Object.fromEntries(new FormData(form).entries());
  if ($('#folder-root-check')?.checked) delete body.parent_id;
  if (!body.parent_id) delete body.parent_id;
  await api('/api/folders', { method: 'POST', body: JSON.stringify(body) });
  $('#folder-dialog').close();
  form.reset();
  toast('目录已创建');
  await loadTree();
}

async function renameCurrentFolder() {
  if (!isAdmin || !state.currentFolder) return toast('请先选择目录', 'error');
  const name = prompt('新的目录名称：', state.currentFolder.name);
  if (!name || name.trim() === state.currentFolder.name) return;
  await api(`/api/folders/${state.currentFolder.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
  toast('目录已重命名');
  await loadTree();
  $('#folder-title').textContent = name.trim();
}

async function deleteCurrentFolder() {
  if (!isAdmin || !state.currentFolder) return toast('请先选择目录', 'error');
  const ok = confirm(`确认删除目录“${state.currentFolder.name}”？\n\n只有空目录才能删除；有子目录或文件时需要先移动/清空。`);
  if (!ok) return;
  await api(`/api/folders/${state.currentFolder.id}`, { method: 'DELETE' });
  toast('目录已删除');
  state.currentFolder = null;
  await loadTree();
  await loadFiles();
}

async function moveCurrentFolder(direction) {
  if (!isAdmin || !state.currentFolder) return toast('请先选择目录', 'error');
  await api(`/api/folders/${state.currentFolder.id}/move`, { method: 'POST', body: JSON.stringify({ direction }) });
  toast(direction === 'up' ? '目录已上移' : '目录已下移');
  await loadTree();
}

function openMoveFileDialog(button) {
  if (!isAdmin) return;
  $('#move-file-id').value = button.dataset.moveFile;
  $('#move-file-name').value = button.dataset.fileName || '';
  $('#move-folder-select').innerHTML = renderFolderOptions(state.folders, button.dataset.currentFolder);
  $('#move-file-dialog').showModal();
}

async function moveFile(event) {
  event.preventDefault();
  const form = $('#move-file-form');
  const body = Object.fromEntries(new FormData(form).entries());
  await api(`/api/admin/files/${body.file_id}/move`, { method: 'PATCH', body: JSON.stringify({ folder_id: body.folder_id }) });
  $('#move-file-dialog').close();
  toast('文件已移动');
  $('#file-detail').className = 'empty';
  $('#file-detail').textContent = '点击文件查看详情和预览。';
  await Promise.all([loadTree(), loadFiles(), loadPendingFiles()]);
}

async function renameFile(id, currentName = '') {
  const name = prompt('新的文件名：', currentName || '');
  if (!name || name.trim() === currentName) return;
  const data = await api(`/api/files/${id}`, { method: 'PATCH', body: JSON.stringify({ original_name: name }) });
  toast('文件名已修改');
  await loadFiles();
  if (state.currentPreviewFile && state.currentPreviewFile.id === id) {
    state.currentPreviewFile = data.file;
    await loadFileDetail(id);
  }
}

async function deleteFile(id, name = '') {
  if (!confirm(`确定删除文件记录「${name || id}」吗？删除后文件和笔记都会移除。`)) return;
  await api(`/api/files/${id}`, { method: 'DELETE' });
  toast('文件记录已删除');
  if (state.currentPreviewFile && state.currentPreviewFile.id === id) state.currentPreviewFile = null;
  $('#file-detail').className = 'empty';
  $('#file-detail').textContent = '点击文件查看详情和预览。';
  await Promise.all([loadTree(), loadFiles(), loadPendingFiles()]);
}

async function openFullscreenPreview(fileId) {
  const file = state.currentPreviewFile && state.currentPreviewFile.id === fileId
    ? state.currentPreviewFile
    : (await api(`/api/files/${fileId}`)).file;
  state.currentPreviewFile = file;
  $('#preview-dialog-title').textContent = file.original_name;
  $('#preview-dialog-subtitle').textContent = `${file.folder_name || ''} · ${file.uploader_name || ''} · ${formatSize(file.size_bytes)}`;
  $('#preview-dialog-file').innerHTML = filePreviewHtml(file);
  $('#file-comment-content').value = '';
  $('#preview-dialog').showModal();
  await loadFileComments(file.id);
}

async function loadFileComments(fileId) {
  const data = await api(`/api/files/${fileId}/comments`);
  const list = $('#file-comments-list');
  if (!data.comments.length) {
    list.className = 'file-comments-list empty';
    list.textContent = '暂无文件笔记';
    return;
  }
  list.className = 'file-comments-list';
  list.innerHTML = data.comments.map(comment => {
    const canDelete = isAdmin || comment.user_id === user.id;
    return `
      <article class="file-comment">
        <div class="file-comment-head">
          <div>
            <strong>${escapeHtml(userLabel(comment))}</strong>
            <small>${formatDate(comment.created_at)}</small>
          </div>
          ${canDelete ? `<button type="button" class="small danger-light" data-delete-comment="${comment.id}">删除</button>` : ''}
        </div>
        <p>${escapeHtml(comment.content).replace(/\n/g, '<br>')}</p>
      </article>
    `;
  }).join('');
}

async function submitFileComment(event) {
  event.preventDefault();
  const file = state.currentPreviewFile;
  if (!file) return toast('请先打开文件预览', 'error');
  const textarea = $('#file-comment-content');
  const content = textarea.value.trim();
  if (!content) return toast('笔记内容不能为空', 'error');
  await api(`/api/files/${file.id}/comments`, { method: 'POST', body: JSON.stringify({ content }) });
  textarea.value = '';
  toast('笔记已保存');
  await loadFileComments(file.id);
}

async function deleteFileComment(commentId) {
  const file = state.currentPreviewFile;
  if (!file) return toast('请先打开文件预览', 'error');
  const ok = confirm('确认删除这条文件笔记？');
  if (!ok) return;
  await api(`/api/files/${file.id}/comments/${commentId}`, { method: 'DELETE' });
  toast('笔记已删除');
  await loadFileComments(file.id);
}

async function loadPendingFiles() {
  if (!isAdmin) return;
  const data = await api('/api/admin/pending');
  const list = $('#pending-list');
  const hasFiles = Boolean(data.files.length);
  $('#pending-select-all').checked = false;
  $('#pending-select-all').disabled = !hasFiles;
  $('#batch-approve-selected').disabled = true;
  $('#batch-approve-all').disabled = !hasFiles;
  if (!hasFiles) {
    list.className = 'file-list empty';
    list.textContent = '暂无待审核文件';
    return;
  }
  list.className = 'file-list';
  list.innerHTML = data.files.map(file => `
    <div class="file-row static pending-file-row">
      <label class="checkline pending-check"><input class="pending-file-check" type="checkbox" value="${file.id}" /></label>
      <span class="file-icon">${fileIcon(file)}</span>
      <span class="file-main">
        <strong>${escapeHtml(file.original_name)}</strong>
        <small>${escapeHtml(file.folder_name)} · ${escapeHtml(file.uploader_name)} · ${formatDate(file.created_at)}</small>
      </span>
      <span class="pending-row-actions">
        <button class="small primary" data-approve="${file.id}">通过</button>
        <button class="small danger" data-reject="${file.id}">拒绝</button>
      </span>
    </div>
  `).join('');
}

async function approveFile(id) {
  await api(`/api/admin/files/${id}/approve`, { method: 'POST', body: JSON.stringify({}) });
  toast('已通过审核');
  await Promise.all([loadTree(), loadFiles(), loadPendingFiles()]);
}

function selectedPendingFileIds() {
  return Array.from(document.querySelectorAll('.pending-file-check:checked')).map(input => input.value);
}

function updatePendingBatchState() {
  const checks = Array.from(document.querySelectorAll('.pending-file-check'));
  const selectedCount = checks.filter(input => input.checked).length;
  $('#batch-approve-selected').disabled = selectedCount === 0;
  $('#pending-select-all').checked = checks.length > 0 && selectedCount === checks.length;
  $('#pending-select-all').indeterminate = selectedCount > 0 && selectedCount < checks.length;
}

async function batchApproveFiles(ids = []) {
  const approvingAll = ids.length === 0;
  if (!confirm(approvingAll ? '确定通过全部待审核文件吗？' : `确定通过选中的 ${ids.length} 个文件吗？`)) return;
  const data = await api('/api/admin/files/batch-approve', { method: 'POST', body: JSON.stringify({ ids }) });
  toast(`已通过 ${data.count || 0} 个文件`);
  await Promise.all([loadTree(), loadFiles(), loadPendingFiles()]);
}

async function rejectFile(id) {
  const reason = prompt('请输入拒绝原因：') || '未填写原因';
  await api(`/api/admin/files/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
  toast('已拒绝该文件');
  await Promise.all([loadTree(), loadFiles(), loadPendingFiles()]);
}

async function loadAnnouncements() {
  const data = await api('/api/announcements');
  const list = $('#announcement-list');
  if (!data.announcements.length) {
    list.innerHTML = '<div class="card empty">暂无公告</div>';
    return;
  }
  list.innerHTML = data.announcements.map(item => `
    <article class="card announcement">
      <div class="card-head">
        <h3>${item.pinned ? '📌 ' : ''}${escapeHtml(item.title)}</h3>
        <div class="announcement-actions">
          <small>${escapeHtml(item.author_name)} · ${formatDate(item.created_at)}</small>
          ${isAdmin ? `<button type="button" class="small danger-light" data-delete-announcement="${item.id}" data-announcement-title="${escapeHtml(item.title)}">删除</button>` : ''}
        </div>
      </div>
      <p>${escapeHtml(item.content).replace(/\n/g, '<br>')}</p>
    </article>
  `).join('');
}

async function deleteAnnouncement(id, title = '') {
  if (!confirm(`确定删除公告「${title || id}」吗？删除后所有人的已读记录也会一起清除。`)) return;
  await api(`/api/announcements/${id}`, { method: 'DELETE' });
  state.unreadAnnouncements = state.unreadAnnouncements.filter(item => String(item.id) !== String(id));
  if (!state.unreadAnnouncements.length && $('#announcement-popup')?.open) $('#announcement-popup').close();
  toast('公告已删除');
  await loadAnnouncements();
}

function webNavStatusText(status) {
  return { approved: '已发布', pending: '待审核', rejected: '已拒绝' }[status] || status;
}

function updateWebNavCategoryOptions(categories) {
  state.webNavCategories = categories || [];
  const options = ['<option value="">未分类</option>'].concat(
    state.webNavCategories.map(item => `<option value="${item.id}">${escapeHtml(item.name)}</option>`)
  ).join('');
  $('#webnav-category-select').innerHTML = options;
}

function renderWebNavCategories(categories) {
  const list = $('#webnav-category-list');
  if (!list) return;
  if (!categories.length) {
    list.className = 'webnav-category-list empty';
    list.textContent = '暂无分类';
    return;
  }
  list.className = 'webnav-category-list';
  list.innerHTML = categories.map(item => `
    <form class="webnav-category-row" data-webnav-category-id="${item.id}">
      <input name="name" value="${escapeHtml(item.name)}" required maxlength="60" />
      <button class="small primary" type="submit">保存</button>
      <button class="small danger-light" type="button" data-delete-webnav-category="${item.id}" data-category-name="${escapeHtml(item.name)}">删除</button>
    </form>
  `).join('');
}

function renderWebNavList(categories, links) {
  const list = $('#webnav-list');
  const groups = new Map();
  categories.forEach(category => groups.set(String(category.id), { category, links: [] }));
  groups.set('uncategorized', { category: { id: '', name: '未分类' }, links: [] });
  links.forEach(link => {
    const key = link.category_id ? String(link.category_id) : 'uncategorized';
    if (!groups.has(key)) groups.set(key, { category: { id: link.category_id || '', name: link.category_name || '未分类' }, links: [] });
    groups.get(key).links.push(link);
  });
  const visibleGroups = Array.from(groups.values()).filter(group => group.links.length > 0);
  if (!visibleGroups.length) {
    list.className = 'webnav-list empty';
    list.textContent = '暂无网页导航';
    return;
  }
  list.className = 'webnav-list';
  list.innerHTML = visibleGroups.map(group => `
    <section class="webnav-category-block">
      <div class="webnav-category-head">
        <h3>${escapeHtml(group.category.name)}</h3>
        <span class="count">${group.links.length} 个链接</span>
      </div>
      <div class="webnav-links-grid">
        ${group.links.map(link => {
          const adminActions = isAdmin ? [
            link.status === 'pending' ? `<button class="small primary" type="button" data-approve-webnav="${link.id}">通过</button>` : '',
            link.status === 'pending' ? `<button class="small ghost" type="button" data-reject-webnav="${link.id}">拒绝</button>` : '',
            link.status === 'rejected' ? `<button class="small primary" type="button" data-approve-webnav="${link.id}">重新通过</button>` : '',
            `<button class="small danger-light" type="button" data-delete-webnav="${link.id}" data-webnav-title="${escapeHtml(link.title)}">删除</button>`
          ].filter(Boolean).join('') : '';
          return `
          <article class="webnav-link-card ${link.status !== 'approved' ? 'not-approved' : ''}">
            <div class="webnav-link-main">
              <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.title)}</a>
              <p>${escapeHtml(link.description || '暂无说明')}</p>
              <small>${escapeHtml(link.suggested_by_name || '-')} 推荐 · ${formatDate(link.created_at)}</small>
            </div>
            <div class="webnav-link-actions">
              <span class="status ${link.status}">${webNavStatusText(link.status)}</span>
              ${adminActions}
            </div>
          </article>
        `;
        }).join('')}
      </div>
    </section>
  `).join('');
}

async function loadWebNav() {
  const includePending = isAdmin && $('#webnav-show-pending')?.checked ? '?include_pending=1' : '';
  const data = await api(`/api/web-nav${includePending}`);
  const categories = data.categories || [];
  const links = data.links || [];
  updateWebNavCategoryOptions(categories);
  renderWebNavCategories(categories);
  renderWebNavList(categories, links);
}

async function createWebNavLink(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  await api('/api/web-nav/links', { method: 'POST', body: JSON.stringify(data) });
  form.reset();
  toast(isAdmin ? '网页导航已添加' : '推荐已提交，等待管理员审核');
  await loadWebNav();
}

async function createWebNavCategory(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  await api('/api/web-nav/categories', { method: 'POST', body: JSON.stringify(data) });
  form.reset();
  toast('分类已新增');
  await loadWebNav();
}

async function updateWebNavCategory(event) {
  event.preventDefault();
  const form = event.target.closest('.webnav-category-row');
  if (!form) return;
  const data = Object.fromEntries(new FormData(form).entries());
  await api(`/api/web-nav/categories/${form.dataset.webnavCategoryId}`, { method: 'PATCH', body: JSON.stringify(data) });
  toast('分类已更新');
  await loadWebNav();
}

async function deleteWebNavCategory(id, name = '') {
  if (!confirm(`确定删除分类「${name || id}」吗？分类下链接会移动到未分类。`)) return;
  await api(`/api/web-nav/categories/${id}`, { method: 'DELETE' });
  toast('分类已删除');
  await loadWebNav();
}

async function updateWebNavLinkStatus(id, status) {
  const body = { status };
  if (status === 'rejected') body.reject_reason = prompt('请输入拒绝原因：') || '未填写原因';
  await api(`/api/web-nav/links/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  toast(status === 'approved' ? '链接已通过' : '链接已拒绝');
  await loadWebNav();
}

async function deleteWebNavLink(id, title = '') {
  if (!confirm(`确定删除网页导航「${title || id}」吗？`)) return;
  await api(`/api/web-nav/links/${id}`, { method: 'DELETE' });
  toast('链接已删除');
  await loadWebNav();
}

async function loadUnreadAnnouncements() {
  const data = await api('/api/announcements/unread');
  state.unreadAnnouncements = data.announcements || [];
  state.announcementPopupIndex = 0;
  if (state.unreadAnnouncements.length) showAnnouncementPopup(0);
}

function showAnnouncementPopup(index = state.announcementPopupIndex) {
  const dialog = $('#announcement-popup');
  if (!dialog || !state.unreadAnnouncements.length) return;
  state.announcementPopupIndex = Math.max(0, Math.min(index, state.unreadAnnouncements.length - 1));
  const item = state.unreadAnnouncements[state.announcementPopupIndex];
  $('#announcement-popup-count').textContent = `新公告 ${state.announcementPopupIndex + 1} / ${state.unreadAnnouncements.length}`;
  $('#announcement-popup-title').textContent = `${item.pinned ? '📌 ' : ''}${item.title}`;
  $('#announcement-popup-meta').textContent = `${item.author_name || ''} · ${formatDate(item.created_at)}`;
  $('#announcement-popup-content').textContent = item.content || '';
  $('#announcement-popup-prev').disabled = state.announcementPopupIndex === 0;
  $('#announcement-popup-next').disabled = state.announcementPopupIndex >= state.unreadAnnouncements.length - 1;
  if (!dialog.open) dialog.showModal();
}

async function markCurrentAnnouncementRead() {
  const item = state.unreadAnnouncements[state.announcementPopupIndex];
  if (!item) return;
  await api(`/api/announcements/${item.id}/read`, { method: 'POST', body: JSON.stringify({}) });
  state.unreadAnnouncements.splice(state.announcementPopupIndex, 1);
  if (!state.unreadAnnouncements.length) {
    $('#announcement-popup').close();
    toast('公告已读');
    return;
  }
  if (state.announcementPopupIndex >= state.unreadAnnouncements.length) state.announcementPopupIndex = state.unreadAnnouncements.length - 1;
  showAnnouncementPopup(state.announcementPopupIndex);
}

async function markAllAnnouncementsRead() {
  if (!state.unreadAnnouncements.length) return;
  const ids = state.unreadAnnouncements.map(item => item.id);
  await api('/api/announcements/read-all', { method: 'POST', body: JSON.stringify({ ids }) });
  state.unreadAnnouncements = [];
  $('#announcement-popup').close();
  toast('所有新公告已读');
}

async function publishAnnouncement(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  data.pinned = Boolean(data.pinned);
  await api('/api/announcements', { method: 'POST', body: JSON.stringify(data) });
  form.reset();
  toast('公告已发布');
  await loadAnnouncements();
  await loadUnreadAnnouncements();
}

async function loadUsers() {
  if (!isAdmin) return;
  const data = await api('/api/admin/users');
  const list = $('#user-list');
  if (!data.users.length) {
    list.className = 'user-list empty';
    list.textContent = '暂无白名单用户';
    return;
  }
  list.className = 'user-list';
  list.innerHTML = data.users.map(item => `
    <form class="user-row user-edit-form" data-user-id="${item.id}">
      <input name="username" value="${escapeHtml(item.username)}" required minlength="2" maxlength="32" pattern="[\\u4e00-\\u9fffA-Za-z0-9_-]{2,32}" title="2-32 位中文、英文、数字、下划线或短横线" />
      <input name="grade" value="${escapeHtml(item.grade || '')}" placeholder="年级" pattern="\\d{2}级" title="例如 23级、24级，可留空" />
      <select name="identity">
        <option value="学生" ${item.identity === '学生' ? 'selected' : ''}>学生</option>
        <option value="老师" ${item.identity === '老师' ? 'selected' : ''}>老师</option>
        <option value="管理员" ${item.identity === '管理员' ? 'selected' : ''}>管理员</option>
      </select>
      <label class="checkline active-toggle"><input name="active" type="checkbox" ${item.active ? 'checked' : ''} /> 启用</label>
      <button class="small primary" type="submit">保存</button>
      <button class="small danger" type="button" data-delete-user="${item.id}" data-username="${escapeHtml(item.username)}" ${item.id === user.id ? 'disabled title="不能删除当前登录账号"' : ''}>删除</button>
    </form>
  `).join('');
}

async function createUser(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  await api('/api/admin/users', { method: 'POST', body: JSON.stringify(data) });
  form.reset();
  toast('已加入白名单');
  await loadUsers();
}

async function updateUser(event) {
  event.preventDefault();
  const form = event.target.closest('.user-edit-form');
  if (!form) return;
  const id = form.dataset.userId;
  const data = Object.fromEntries(new FormData(form).entries());
  data.active = Boolean(form.elements.active.checked);
  await api(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  toast('白名单用户已更新');
  await loadUsers();
}

async function deleteUser(id, username) {
  if (!confirm(`确定删除白名单用户「${username}」吗？删除后该用户不能再登录。`)) return;
  await api(`/api/admin/users/${id}`, { method: 'DELETE' });
  toast('白名单用户已删除');
  await loadUsers();
}

async function updateAccessKey(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form).entries());
  await api('/api/admin/access-key', { method: 'POST', body: JSON.stringify(data) });
  form.reset();
  toast('统一密码已更新');
}

function leaderboardMedal(index) {
  if (index === 0) return '🥇';
  if (index === 1) return '🥈';
  if (index === 2) return '🥉';
  return String(index + 1);
}

async function loadLeaderboard(range = 'week') {
  const data = await api(`/api/leaderboard?range=${encodeURIComponent(range)}`);
  Array.from(document.querySelectorAll('.leaderboard-range')).forEach(btn => btn.classList.toggle('active', btn.dataset.leaderboardRange === data.range));
  const list = $('#leaderboard-list');
  const summary = $('#leaderboard-summary');
  const leaderboard = data.leaderboard || [];
  const totalFiles = leaderboard.reduce((sum, item) => sum + Number(item.approved_count || 0), 0);
  const topUser = leaderboard[0] ? userLabel(leaderboard[0]) : '暂无';
  const summaryText = data.range === 'total'
    ? '统计全部已通过审核的上传文件'
    : `统计 ${formatDate(data.start_at)} 至今通过审核的上传文件`;
  summary.className = 'leaderboard-summary';
  summary.innerHTML = `
    <div class="leaderboard-summary-main">
      <strong>${escapeHtml(data.title)}</strong>
      <span>${escapeHtml(summaryText)}</span>
    </div>
    <div class="leaderboard-stats">
      <div><strong>${leaderboard.length}</strong><span>上榜成员</span></div>
      <div><strong>${totalFiles}</strong><span>通过文件</span></div>
      <div><strong>${escapeHtml(topUser)}</strong><span>当前第一</span></div>
    </div>
  `;

  if (!leaderboard.length) {
    list.className = 'leaderboard-list empty leaderboard-empty';
    list.innerHTML = '<strong>暂无贡献记录</strong><span>当前时间范围内还没有通过审核的上传文件。</span>';
    return;
  }

  const maxCount = Math.max(...leaderboard.map(item => Number(item.approved_count || 0)), 1);
  list.className = 'leaderboard-list';
  list.innerHTML = leaderboard.map((item, index) => {
    const count = Number(item.approved_count || 0);
    const percent = Math.max(8, Math.round((count / maxCount) * 100));
    return `
      <div class="leaderboard-row rank-${index + 1} ${index < 3 ? 'top-rank' : ''}">
        <div class="rank-medal">${leaderboardMedal(index)}</div>
        <div class="leaderboard-user">
          <strong>${escapeHtml(userLabel(item))}</strong>
          <small>最近通过：${formatDate(item.latest_approved_at)}</small>
          <div class="leaderboard-progress"><span style="width: ${percent}%"></span></div>
        </div>
        <div class="leaderboard-count"><strong>${count}</strong><span>个文件</span></div>
      </div>
    `;
  }).join('');
}

async function loadNotes() {
  const data = await api('/api/notes');
  const list = $('#note-list');
  if (!data.notes.length) {
    list.className = 'note-list empty';
    list.textContent = '暂无笔记';
    return;
  }
  list.className = 'note-list';
  list.innerHTML = data.notes.map(note => `
    <button class="note-row" data-note-id="${note.id}">
      <strong>${escapeHtml(note.title)}</strong>
      <small>${escapeHtml(note.folder_name || '未关联目录')} · ${escapeHtml(note.updater_name || note.creator_name)} · ${formatDate(note.updated_at)}</small>
    </button>
  `).join('');
}

async function createNote() {
  const title = prompt('笔记标题：') || '未命名笔记';
  const body = { title, folder_id: state.currentFolder ? state.currentFolder.id : null };
  const data = await api('/api/notes', { method: 'POST', body: JSON.stringify(body) });
  toast('笔记已创建');
  await loadNotes();
  await openNote(data.id);
}

async function openNote(id) {
  const data = await api(`/api/notes/${id}`);
  state.currentNoteId = id;
  $('#note-title').value = data.note.title;
  $('#note-content').value = data.note.content || '';
  $('#note-status').textContent = `创建人：${data.note.creator_name}；最后更新：${formatDate(data.note.updated_at)}`;
  $$('.note-row').forEach(row => row.classList.toggle('selected', row.dataset.noteId === id));
  if (!state.socket) initSocket();
  state.socket.emit('note:join', { id });
}

function initSocket() {
  state.socket = io();
  state.socket.on('note:remote-edit', payload => {
    if (payload.id !== state.currentNoteId) return;
    state.remoteUpdating = true;
    $('#note-content').value = payload.content;
    $('#note-status').textContent = `${payload.editor} 正在编辑...`;
    state.remoteUpdating = false;
  });
  state.socket.on('note:saved', payload => {
    if (payload.id !== state.currentNoteId) return;
    $('#note-status').textContent = `${payload.updated_by} 已保存：${formatDate(payload.updated_at)}`;
    loadNotes().catch(console.error);
  });
  state.socket.on('note:presence', payload => {
    $('#note-status').textContent = payload.message;
  });
}

async function saveNote() {
  if (!state.currentNoteId) return toast('请先选择笔记', 'error');
  const title = $('#note-title').value;
  const content = $('#note-content').value;
  await api(`/api/notes/${state.currentNoteId}`, { method: 'PUT', body: JSON.stringify({ title, content }) });
  if (state.socket) state.socket.emit('note:save', { id: state.currentNoteId, title, content });
  toast('笔记已保存');
  await loadNotes();
}

function bindEvents() {
  $('#folder-tree').addEventListener('click', event => {
    const toggle = event.target.closest('[data-toggle-folder]');
    if (toggle) {
      event.stopPropagation();
      toggleFolderCollapse(toggle.dataset.toggleFolder);
      return;
    }

    const btn = event.target.closest('[data-folder-id]');
    if (!btn) return;
    const folder = state.folderMap.get(Number(btn.dataset.folderId));
    if (folder) selectFolder(folder);
  });

  $('#file-list').addEventListener('click', event => {
    if (event.target.closest('[data-delete-file]')) return;
    const row = event.target.closest('[data-file-id]');
    if (row) loadFileDetail(row.dataset.fileId).catch(err => toast(err.message, 'error'));
  });

  document.addEventListener('click', event => {
    const approve = event.target.closest('[data-approve]');
    const reject = event.target.closest('[data-reject]');
    const move = event.target.closest('[data-move-file]');
    const renameFileBtn = event.target.closest('[data-rename-file]');
    const renameFolder = event.target.closest('#rename-folder-btn');
    const deleteFolder = event.target.closest('#delete-folder-btn');
    const moveFolderUp = event.target.closest('#move-folder-up-btn');
    const moveFolderDown = event.target.closest('#move-folder-down-btn');
    const deleteComment = event.target.closest('[data-delete-comment]');
    const openPreview = event.target.closest('[data-open-preview]');
    const deleteFileBtn = event.target.closest('[data-delete-file]');
    const deleteAnnouncementBtn = event.target.closest('[data-delete-announcement]');
    const approveWebNav = event.target.closest('[data-approve-webnav]');
    const rejectWebNav = event.target.closest('[data-reject-webnav]');
    const deleteWebNav = event.target.closest('[data-delete-webnav]');
    const deleteWebNavCategoryBtn = event.target.closest('[data-delete-webnav-category]');
    const deleteUserBtn = event.target.closest('[data-delete-user]');
    if (approve) approveFile(approve.dataset.approve).catch(err => toast(err.message, 'error'));
    if (reject) rejectFile(reject.dataset.reject).catch(err => toast(err.message, 'error'));
    if (move) openMoveFileDialog(move);
    if (renameFileBtn) renameFile(renameFileBtn.dataset.renameFile, renameFileBtn.dataset.fileName || '').catch(err => toast(err.message, 'error'));
    if (renameFolder) renameCurrentFolder().catch(err => toast(err.message, 'error'));
    if (deleteFolder) deleteCurrentFolder().catch(err => toast(err.message, 'error'));
    if (moveFolderUp) moveCurrentFolder('up').catch(err => toast(err.message, 'error'));
    if (moveFolderDown) moveCurrentFolder('down').catch(err => toast(err.message, 'error'));
    if (deleteComment) deleteFileComment(deleteComment.dataset.deleteComment).catch(err => toast(err.message, 'error'));
    if (openPreview) openFullscreenPreview(openPreview.dataset.openPreview).catch(err => toast(err.message, 'error'));
    if (deleteFileBtn) deleteFile(deleteFileBtn.dataset.deleteFile, deleteFileBtn.dataset.fileName || '').catch(err => toast(err.message, 'error'));
    if (deleteAnnouncementBtn) deleteAnnouncement(deleteAnnouncementBtn.dataset.deleteAnnouncement, deleteAnnouncementBtn.dataset.announcementTitle || '').catch(err => toast(err.message, 'error'));
    if (approveWebNav) updateWebNavLinkStatus(approveWebNav.dataset.approveWebnav, 'approved').catch(err => toast(err.message, 'error'));
    if (rejectWebNav) updateWebNavLinkStatus(rejectWebNav.dataset.rejectWebnav, 'rejected').catch(err => toast(err.message, 'error'));
    if (deleteWebNav) deleteWebNavLink(deleteWebNav.dataset.deleteWebnav, deleteWebNav.dataset.webnavTitle || '').catch(err => toast(err.message, 'error'));
    if (deleteWebNavCategoryBtn) deleteWebNavCategory(deleteWebNavCategoryBtn.dataset.deleteWebnavCategory, deleteWebNavCategoryBtn.dataset.categoryName || '').catch(err => toast(err.message, 'error'));
    if (deleteUserBtn) deleteUser(deleteUserBtn.dataset.deleteUser, deleteUserBtn.dataset.username || '').catch(err => toast(err.message, 'error'));
  });

  $$('.tabs button').forEach(btn => btn.addEventListener('click', () => {
    $$('.tabs button').forEach(item => item.classList.remove('active'));
    $$('.view').forEach(view => view.classList.remove('active'));
    btn.classList.add('active');
    const targetView = $(`#view-${btn.dataset.view}`);
    if (!targetView) return;
    targetView.classList.add('active');
    if (btn.dataset.view === 'webnav') loadWebNav().catch(err => toast(err.message, 'error'));
    if (btn.dataset.view === 'leaderboard') loadLeaderboard('week').catch(err => toast(err.message, 'error'));
    if (btn.dataset.view === 'announcements') loadAnnouncements().catch(err => toast(err.message, 'error'));
    if (btn.dataset.view === 'admin') Promise.all([loadPendingFiles(), loadUsers()]).catch(err => toast(err.message, 'error'));
  }));

  Array.from(document.querySelectorAll('.leaderboard-range')).forEach(btn => btn.addEventListener('click', () => {
    loadLeaderboard(btn.dataset.leaderboardRange || 'week').catch(err => toast(err.message, 'error'));
  }));

  $('#upload-open').addEventListener('click', () => {
    if (!state.currentFolder) return toast('请先选择目录', 'error');
    const form = $('#upload-form');
    form.reset();
    setUploadFiles([]);
    $('#upload-folder-id').value = state.currentFolder.id;
    $('#upload-folder-name').value = state.currentFolder.name;
    $('#upload-dialog').showModal();
  });
  $('#upload-form').addEventListener('submit', event => uploadCurrentFile(event).catch(err => toast(err.message, 'error')));
  $('#upload-file-input')?.addEventListener('change', event => setUploadFiles(event.currentTarget.files));
  const uploadDropzone = $('#upload-dropzone');
  if (uploadDropzone) {
    uploadDropzone.addEventListener('click', event => {
      if (event.target.id !== 'upload-file-input') $('#upload-file-input')?.click();
    });
    uploadDropzone.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        $('#upload-file-input')?.click();
      }
    });
    ['dragenter', 'dragover'].forEach(name => uploadDropzone.addEventListener(name, event => {
      event.preventDefault();
      uploadDropzone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(name => uploadDropzone.addEventListener(name, event => {
      event.preventDefault();
      uploadDropzone.classList.remove('dragover');
    }));
    uploadDropzone.addEventListener('drop', event => setUploadFiles(event.dataTransfer.files));
  }
  $('#file-sort')?.addEventListener('change', () => loadFiles().catch(err => toast(err.message, 'error')));
  $('#show-pending')?.addEventListener('change', () => loadFiles().catch(err => toast(err.message, 'error')));
  $('#pending-list')?.addEventListener('change', event => {
    if (event.target.closest('.pending-file-check')) updatePendingBatchState();
  });
  $('#pending-select-all')?.addEventListener('change', event => {
    Array.from(document.querySelectorAll('.pending-file-check')).forEach(input => { input.checked = event.currentTarget.checked; });
    updatePendingBatchState();
  });
  $('#batch-approve-selected')?.addEventListener('click', () => batchApproveFiles(selectedPendingFileIds()).catch(err => toast(err.message, 'error')));
  $('#batch-approve-all')?.addEventListener('click', () => batchApproveFiles([]).catch(err => toast(err.message, 'error')));

  $('#new-folder-btn')?.addEventListener('click', () => {
    $('#folder-root-check').checked = false;
    $('#folder-parent-id').value = state.currentFolder ? state.currentFolder.id : '';
    $('#folder-parent-name').value = state.currentFolder ? state.currentFolder.name : '根目录';
    $('#folder-dialog').showModal();
  });
  $('#folder-root-check')?.addEventListener('change', event => {
    if (event.currentTarget.checked) {
      $('#folder-parent-id').value = '';
      $('#folder-parent-name').value = '根目录';
      return;
    }
    $('#folder-parent-id').value = state.currentFolder ? state.currentFolder.id : '';
    $('#folder-parent-name').value = state.currentFolder ? state.currentFolder.name : '根目录';
  });
  $('#folder-form')?.addEventListener('submit', event => createFolder(event).catch(err => toast(err.message, 'error')));
  $('#move-file-form')?.addEventListener('submit', event => moveFile(event).catch(err => toast(err.message, 'error')));
  $('#file-comment-form')?.addEventListener('submit', event => submitFileComment(event).catch(err => toast(err.message, 'error')));
  $('#preview-dialog-close')?.addEventListener('click', () => $('#preview-dialog').close());

  document.querySelectorAll('[data-close-dialog]').forEach(btn => btn.addEventListener('click', () => btn.closest('dialog').close()));

  $('#webnav-link-form')?.addEventListener('submit', event => createWebNavLink(event).catch(err => toast(err.message, 'error')));
  $('#webnav-category-form')?.addEventListener('submit', event => createWebNavCategory(event).catch(err => toast(err.message, 'error')));
  $('#webnav-category-list')?.addEventListener('submit', event => updateWebNavCategory(event).catch(err => toast(err.message, 'error')));
  $('#webnav-show-pending')?.addEventListener('change', () => loadWebNav().catch(err => toast(err.message, 'error')));
  $('#announcement-form')?.addEventListener('submit', event => publishAnnouncement(event).catch(err => toast(err.message, 'error')));
  $('#announcement-popup-prev')?.addEventListener('click', () => showAnnouncementPopup(state.announcementPopupIndex - 1));
  $('#announcement-popup-next')?.addEventListener('click', () => showAnnouncementPopup(state.announcementPopupIndex + 1));
  $('#announcement-popup-read')?.addEventListener('click', () => markCurrentAnnouncementRead().catch(err => toast(err.message, 'error')));
  $('#announcement-popup-read-all')?.addEventListener('click', () => markAllAnnouncementsRead().catch(err => toast(err.message, 'error')));
  $('#announcement-popup-close')?.addEventListener('click', () => $('#announcement-popup').close());
  $('#user-form')?.addEventListener('submit', event => createUser(event).catch(err => toast(err.message, 'error')));
  $('#user-list')?.addEventListener('submit', event => updateUser(event).catch(err => toast(err.message, 'error')));
  $('#shared-password-form')?.addEventListener('submit', event => updateAccessKey(event).catch(err => toast(err.message, 'error')));

  $('#new-note-btn')?.addEventListener('click', () => createNote().catch(err => toast(err.message, 'error')));
  $('#note-list')?.addEventListener('click', event => {
    const row = event.target.closest('[data-note-id]');
    if (row) openNote(row.dataset.noteId).catch(err => toast(err.message, 'error'));
  });
  $('#save-note-btn')?.addEventListener('click', () => saveNote().catch(err => toast(err.message, 'error')));
  $('#note-content')?.addEventListener('input', () => {
    if (!state.socket || !state.currentNoteId || state.remoteUpdating) return;
    clearTimeout(state.editTimer);
    state.editTimer = setTimeout(() => {
      state.socket.emit('note:edit', { id: state.currentNoteId, content: $('#note-content').value });
    }, 250);
  });
}

async function boot() {
  if (!isAdmin) $$('.admin-only').forEach(el => el.remove());
  bindEvents();
  await loadTree();
  await loadAnnouncements();
  await loadUnreadAnnouncements();
}

boot().catch(err => toast(err.message, 'error'));
