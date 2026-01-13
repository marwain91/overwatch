// Overwatch Admin Dashboard

let authToken = localStorage.getItem('overwatch_admin_token') || '';
let currentUser = JSON.parse(localStorage.getItem('overwatch_admin_user') || 'null');
let googleClientId = '';
let projectConfig = null;

// API Helper
async function api(endpoint, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const response = await fetch(`/api${endpoint}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    logout();
    throw new Error('Unauthorized');
  }

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(data.error || 'Request failed');
    error.isLocked = data.isLocked;
    error.lockInfo = data.lockInfo;
    throw error;
  }

  return data;
}

// Load project configuration and update UI
async function loadProjectConfig() {
  try {
    projectConfig = await api('/status/config');
    updateBranding();
    return projectConfig;
  } catch (error) {
    console.error('Failed to load project config:', error);
    return null;
  }
}

function updateBranding() {
  if (!projectConfig) return;

  const projectName = projectConfig.project.name;
  const titleText = `Overwatch - ${projectName}`;

  // Update page title
  document.title = titleText;

  // Update login title
  const loginTitle = document.getElementById('login-title');
  if (loginTitle) {
    loginTitle.textContent = 'Overwatch';
  }

  // Update login subtitle
  const loginSubtitle = document.getElementById('login-subtitle');
  if (loginSubtitle) {
    loginSubtitle.textContent = `Managing: ${projectName}`;
  }

  // Update dashboard title
  const dashboardTitle = document.getElementById('dashboard-title');
  if (dashboardTitle) {
    dashboardTitle.textContent = titleText;
  }
}

// Image Tags
let cachedTags = null;

async function loadImageTags() {
  if (cachedTags) return cachedTags;

  try {
    const { tags } = await api('/status/tags');
    cachedTags = tags;
    return tags;
  } catch (error) {
    console.error('Failed to load image tags:', error);
    return ['latest'];
  }
}

function populateTagSelect(selectId, selectedValue = 'latest') {
  const select = document.getElementById(selectId);
  if (!select || !cachedTags) return;

  select.innerHTML = cachedTags.map(tag =>
    `<option value="${tag}" ${tag === selectedValue ? 'selected' : ''}>${tag}</option>`
  ).join('');
}

// Auth
function login(token, user = null) {
  authToken = token;
  currentUser = user;
  localStorage.setItem('overwatch_admin_token', token);
  if (user) {
    localStorage.setItem('overwatch_admin_user', JSON.stringify(user));
    updateUserInfo(user);
  }
}

function logout() {
  authToken = '';
  currentUser = null;
  localStorage.removeItem('overwatch_admin_token');
  localStorage.removeItem('overwatch_admin_user');
  showScreen('login');
}

function updateUserInfo(user) {
  const userInfo = document.getElementById('user-info');
  const avatar = document.getElementById('user-avatar');
  const name = document.getElementById('user-name');

  if (user && user.picture) {
    avatar.src = user.picture;
    avatar.alt = user.name || user.email;
    name.textContent = user.name || user.email;
    userInfo.style.display = 'flex';
  } else {
    userInfo.style.display = 'none';
  }
}

// Google Sign-In callback
async function handleGoogleSignIn(response) {
  try {
    document.getElementById('login-error').textContent = '';

    const result = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: response.credential }),
    });

    const data = await result.json();

    if (!result.ok) {
      throw new Error(data.error || 'Login failed');
    }

    login(data.token, data.user);
    showScreen('dashboard');
    await loadProjectConfig();
    loadDashboard();
    loadBackupStatus();
  } catch (error) {
    document.getElementById('login-error').textContent = error.message;
  }
}

// Initialize Google Sign-In
async function initGoogleSignIn() {
  try {
    const config = await fetch('/api/auth/config').then(r => r.json());

    if (config.configured && config.googleClientId) {
      googleClientId = config.googleClientId;
      document.getElementById('g_id_onload').setAttribute('data-client_id', googleClientId);
      document.getElementById('google-signin-container').style.display = 'block';

      if (window.google && window.google.accounts) {
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: handleGoogleSignIn,
        });
        window.google.accounts.id.renderButton(
          document.querySelector('.g_id_signin'),
          { theme: 'outline', size: 'large', width: 300 }
        );
      }
    } else {
      document.getElementById('login-error').textContent = 'Google Sign-In not configured. Please set GOOGLE_CLIENT_ID.';
    }
  } catch (error) {
    console.error('Failed to load auth config:', error);
    document.getElementById('login-error').textContent = 'Failed to load authentication configuration.';
  }
}

window.handleGoogleSignIn = handleGoogleSignIn;

function showScreen(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  document.getElementById(`${screen}-screen`).classList.remove('hidden');
}

// UI Updates
async function loadDashboard() {
  try {
    const [health, tenants] = await Promise.all([
      api('/status/health'),
      api('/tenants'),
      loadImageTags(),
    ]);

    cachedTenants = tenants;

    document.getElementById('health-status').textContent =
      health.database === 'connected' ? 'Healthy' : 'Unhealthy';
    document.getElementById('health-status').className =
      `status-badge ${health.database === 'connected' ? 'healthy' : 'unhealthy'}`;

    document.getElementById('db-status').textContent = health.database;

    const containerEl = document.getElementById('container-count');
    containerEl.textContent = `${health.runningContainers}/${health.containers}`;
    containerEl.className = 'value has-tooltip';
    containerEl.setAttribute('data-tooltip', formatContainerTooltip(health.containerDetails));

    document.getElementById('tenant-count').textContent = tenants.length;

    renderTenants(tenants);
    loadAdminUsers();
  } catch (error) {
    console.error('Failed to load dashboard:', error);
  }
}

function formatContainerTooltip(containers) {
  if (!containers || containers.length === 0) return 'No containers';
  return containers
    .map(c => `${c.state === 'running' ? '●' : '○'} ${c.name}`)
    .join('\n');
}

function formatTenantContainerTooltip(containers) {
  if (!containers || containers.length === 0) return 'No containers';
  return containers
    .map(c => `${c.state === 'running' ? '●' : '○'} ${c.name.split('-').pop()}`)
    .join('\n');
}

// SVG Icons
const icons = {
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12"></rect></svg>',
  restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>',
  external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>',
  backup: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path><polyline points="17 21 17 13 7 13 7 21"></polyline><polyline points="7 3 7 8 15 8"></polyline></svg>',
  update: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>',
  logs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>',
};

function renderTenants(tenants) {
  const container = document.getElementById('tenants-list');

  if (tenants.length === 0) {
    container.innerHTML = '<p class="loading">No tenants yet. Create your first tenant!</p>';
    return;
  }

  container.innerHTML = tenants.map(tenant => {
    const containerTooltip = formatTenantContainerTooltip(tenant.containers);
    return `
    <div class="tenant-card" data-tenant-id="${tenant.tenantId}">
      <div class="tenant-info">
        <h3>${tenant.tenantId}</h3>
        <p class="domain">${tenant.domain}</p>
        <p>Version: ${tenant.version} | Containers: <span class="has-tooltip" data-tooltip="${containerTooltip}">${tenant.runningContainers}/${tenant.totalContainers}</span></p>
      </div>
      <div class="tenant-meta">
        <span class="status-badge ${tenant.healthy ? 'healthy' : 'unhealthy'}">
          ${tenant.healthy ? 'Running' : 'Stopped'}
        </span>
      </div>
      <div class="tenant-actions">
        ${tenant.healthy ? `
          <button class="btn btn-primary btn-sm btn-icon has-tooltip" onclick="accessTenant('${tenant.tenantId}', this)" data-tooltip="Access">${icons.external}</button>
          <button class="btn btn-secondary btn-sm btn-icon has-tooltip" onclick="restartTenant('${tenant.tenantId}', this)" data-tooltip="Restart">${icons.restart}</button>
          <button class="btn btn-secondary btn-sm btn-icon has-tooltip" onclick="stopTenant('${tenant.tenantId}', this)" data-tooltip="Stop">${icons.stop}</button>
        ` : `
          <button class="btn btn-primary btn-sm btn-icon has-tooltip" onclick="startTenant('${tenant.tenantId}', this)" data-tooltip="Start">${icons.play}</button>
        `}
        <button class="btn btn-secondary btn-sm btn-icon has-tooltip" onclick="showTenantBackupsModal('${tenant.tenantId}')" data-tooltip="Backups">${icons.backup}</button>
        <button class="btn btn-secondary btn-sm btn-icon has-tooltip" onclick="showUpdateModal('${tenant.tenantId}', '${tenant.version}')" data-tooltip="Update">${icons.update}</button>
        <button class="btn btn-secondary btn-sm btn-icon has-tooltip" onclick="showLogs('${tenant.tenantId}')" data-tooltip="Logs">${icons.logs}</button>
        <button class="btn btn-danger btn-sm btn-icon has-tooltip" onclick="showDeleteModal('${tenant.tenantId}')" data-tooltip="Delete">${icons.trash}</button>
      </div>
    </div>
  `}).join('');
}

// Tenant Actions
async function startTenant(tenantId, btn) {
  setButtonLoading(btn, true, 'Starting...');
  try {
    await api(`/tenants/${tenantId}/start`, { method: 'POST' });
    loadDashboard();
  } catch (error) {
    setButtonLoading(btn, false, 'Start');
    alert(`Failed to start tenant: ${error.message}`);
  }
}

async function stopTenant(tenantId, btn) {
  setButtonLoading(btn, true, 'Stopping...');
  try {
    await api(`/tenants/${tenantId}/stop`, { method: 'POST' });
    loadDashboard();
  } catch (error) {
    setButtonLoading(btn, false, 'Stop');
    alert(`Failed to stop tenant: ${error.message}`);
  }
}

async function restartTenant(tenantId, btn) {
  setButtonLoading(btn, true, 'Restarting...');
  try {
    await api(`/tenants/${tenantId}/restart`, { method: 'POST' });
    loadDashboard();
  } catch (error) {
    setButtonLoading(btn, false, 'Restart');
    alert(`Failed to restart tenant: ${error.message}`);
  }
}

async function accessTenant(tenantId, btn) {
  setButtonLoading(btn, true, 'Loading...');
  try {
    const result = await api(`/tenants/${tenantId}/access-token`, { method: 'POST' });
    setButtonLoading(btn, false, 'Access');
    window.open(result.accessUrl, '_blank');
  } catch (error) {
    setButtonLoading(btn, false, 'Access');
    alert(`Failed to access tenant: ${error.message}`);
  }
}

// Modals
function showModal(modalId) {
  document.getElementById(modalId).classList.remove('hidden');
}

function hideModal(modalId) {
  document.getElementById(modalId).classList.add('hidden');
}

function hideAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
}

function showUpdateModal(tenantId, currentVersion) {
  document.getElementById('update-tenant-id').value = tenantId;
  document.getElementById('update-tenant-name').textContent = tenantId;
  populateTagSelect('update-tag', currentVersion);
  document.getElementById('update-error').textContent = '';
  resetModalButtons('update-modal');
  showModal('update-modal');
}

function showDeleteModal(tenantId) {
  document.getElementById('delete-tenant-name').textContent = tenantId;
  document.getElementById('keep-data-checkbox').checked = false;
  document.getElementById('confirm-delete-btn').onclick = () => deleteTenant(tenantId);
  resetModalButtons('delete-modal');
  showModal('delete-modal');
}

function resetModalButtons(modalId) {
  const modal = document.getElementById(modalId);
  modal.querySelectorAll('button[type="submit"], button.btn-primary, button.btn-danger').forEach(btn => {
    btn.disabled = false;
    if (btn.dataset.originalHtml) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    }
  });
}

async function showLogs(tenantId) {
  showModal('logs-modal');
  document.getElementById('logs-content').textContent = 'Loading logs...';

  try {
    const tenants = await api('/tenants');
    const tenant = tenants.find(t => t.tenantId === tenantId);

    if (!tenant || tenant.containers.length === 0) {
      document.getElementById('logs-content').textContent = 'No containers found';
      return;
    }

    const backendContainer = tenant.containers.find(c => c.name.includes('backend'));
    if (backendContainer) {
      const { logs } = await api(`/status/containers/${backendContainer.id}/logs?tail=200`);
      document.getElementById('logs-content').textContent = logs || 'No logs available';
    }
  } catch (error) {
    document.getElementById('logs-content').textContent = `Error: ${error.message}`;
  }
}

async function deleteTenant(tenantId) {
  const keepData = document.getElementById('keep-data-checkbox').checked;
  const btn = document.getElementById('confirm-delete-btn');

  setButtonLoading(btn, true, 'Deleting...');

  try {
    await api(`/tenants/${tenantId}?keepData=${keepData}`, { method: 'DELETE' });
    hideAllModals();
    loadDashboard();
  } catch (error) {
    setButtonLoading(btn, false, 'Delete');
    alert(`Failed to delete tenant: ${error.message}`);
  }
}

function setButtonLoading(btn, loading, text) {
  if (loading) {
    btn.disabled = true;
    if (!btn.dataset.originalHtml) {
      btn.dataset.originalHtml = btn.innerHTML;
    }
    if (btn.classList.contains('btn-icon')) {
      btn.innerHTML = '<span class="spinner"></span>';
    } else {
      btn.innerHTML = `<span class="spinner"></span> ${text}`;
    }
  } else {
    btn.disabled = false;
    if (btn.dataset.originalHtml) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    } else {
      btn.textContent = text;
    }
  }
}

// Admin User Management
async function loadAdminUsers() {
  try {
    const admins = await api('/admin-users');
    renderAdminUsers(admins);
  } catch (error) {
    document.getElementById('admin-users-list').innerHTML =
      `<p class="error">Error: ${error.message}</p>`;
  }
}

function renderAdminUsers(admins) {
  const container = document.getElementById('admin-users-list');

  if (admins.length === 0) {
    container.innerHTML = '<p class="empty">No admin users configured.</p>';
    return;
  }

  container.innerHTML = `
    <div class="admin-users-grid">
      ${admins.map(admin => `
        <div class="admin-user-card">
          <div class="admin-user-info">
            <span class="admin-email">${admin.email}</span>
            <span class="admin-meta">Added ${formatDate(admin.addedAt)} by ${admin.addedBy}</span>
          </div>
          <button class="btn btn-danger btn-xs" onclick="confirmDeleteAdmin('${admin.email}')">Remove</button>
        </div>
      `).join('')}
    </div>
  `;
}

function formatDate(dateString) {
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function showAddAdminModal() {
  document.getElementById('admin-email').value = '';
  document.getElementById('add-admin-error').textContent = '';
  resetModalButtons('add-admin-modal');
  showModal('add-admin-modal');
}

async function addAdmin(e) {
  e.preventDefault();

  const btn = e.target.querySelector('button[type="submit"]');
  const email = document.getElementById('admin-email').value;

  setButtonLoading(btn, true, 'Adding...');

  try {
    await api('/admin-users', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    hideModal('add-admin-modal');
    loadAdminUsers();
  } catch (error) {
    setButtonLoading(btn, false, 'Add Admin');
    document.getElementById('add-admin-error').textContent = error.message;
  }
}

function confirmDeleteAdmin(email) {
  document.getElementById('delete-admin-email').textContent = email;
  document.getElementById('confirm-delete-admin-btn').onclick = () => deleteAdmin(email);
  resetModalButtons('delete-admin-modal');
  showModal('delete-admin-modal');
}

async function deleteAdmin(email) {
  const btn = document.getElementById('confirm-delete-admin-btn');
  setButtonLoading(btn, true, 'Removing...');

  try {
    await api(`/admin-users/${encodeURIComponent(email)}`, { method: 'DELETE' });
    hideModal('delete-admin-modal');
    loadAdminUsers();
  } catch (error) {
    setButtonLoading(btn, false, 'Remove');
    alert(`Failed to remove admin: ${error.message}`);
  }
}

// Backup Management
let cachedTenants = [];
let currentBackupTenantId = null;
let backupStatus = { configured: false, initialized: false };

async function loadBackupStatus() {
  const statusEl = document.getElementById('backup-status-indicator');

  try {
    backupStatus = await api('/backups/status');

    if (!backupStatus.configured) {
      statusEl.textContent = 'Not configured';
      statusEl.className = 'value';
      return;
    }

    if (!backupStatus.initialized) {
      statusEl.innerHTML = '<a href="#" onclick="initBackupRepo(); return false;">Initialize</a>';
      statusEl.className = 'value';
      return;
    }

    statusEl.textContent = 'Connected';
    statusEl.className = 'value';
  } catch (error) {
    statusEl.textContent = 'Error';
    statusEl.className = 'value';
  }
}

async function initBackupRepo() {
  const statusEl = document.getElementById('backup-status-indicator');
  statusEl.innerHTML = '<span class="spinner"></span>';

  try {
    await api('/backups/init', { method: 'POST' });
    await loadBackupStatus();
    alert('Backup repository initialized successfully!');
  } catch (error) {
    statusEl.textContent = 'Error';
    alert(`Failed to initialize: ${error.message}`);
  }
}

async function showTenantBackupsModal(tenantId) {
  currentBackupTenantId = tenantId;
  document.getElementById('tenant-backups-name').textContent = tenantId;
  document.getElementById('tenant-backups-list').innerHTML = '<p class="loading">Loading backups...</p>';
  document.getElementById('tenant-create-backup-btn').disabled = true;
  showModal('tenant-backups-modal');

  try {
    backupStatus = await api('/backups/status');
  } catch (error) {
    if (error.isLocked) {
      showLockedError('tenant-backups-list', error.lockInfo);
    } else {
      document.getElementById('tenant-backups-list').innerHTML = `<p class="error">Failed to check backup status: ${error.message}</p>`;
    }
    return;
  }

  if (!backupStatus.configured) {
    document.getElementById('tenant-backups-list').innerHTML = '<p class="empty">Backups not configured. Set backup environment variables.</p>';
    return;
  }

  if (!backupStatus.initialized) {
    document.getElementById('tenant-backups-list').innerHTML = '<p class="empty">Backup repository not initialized. <a href="#" onclick="initBackupRepoFromModal(); return false;">Initialize now</a></p>';
    return;
  }

  if (backupStatus.isLocked) {
    showLockedError('tenant-backups-list', backupStatus.lockInfo);
    return;
  }

  document.getElementById('tenant-create-backup-btn').disabled = false;
  await loadTenantBackups(tenantId);
}

async function initBackupRepoFromModal() {
  document.getElementById('tenant-backups-list').innerHTML = '<p class="loading">Initializing repository...</p>';

  try {
    await api('/backups/init', { method: 'POST' });
    backupStatus.initialized = true;
    await loadBackupStatus();
    document.getElementById('tenant-create-backup-btn').disabled = false;
    await loadTenantBackups(currentBackupTenantId);
  } catch (error) {
    if (error.isLocked) {
      showLockedError('tenant-backups-list', error.lockInfo);
    } else {
      document.getElementById('tenant-backups-list').innerHTML = `<p class="error">Failed to initialize: ${error.message}</p>`;
    }
  }
}

async function loadTenantBackups(tenantId) {
  const listEl = document.getElementById('tenant-backups-list');

  try {
    const backups = await api(`/backups?tenantId=${tenantId}`);
    renderTenantBackups(backups, tenantId);
  } catch (error) {
    if (error.isLocked) {
      showLockedError('tenant-backups-list', error.lockInfo);
    } else {
      listEl.innerHTML = `<p class="error">Error: ${error.message}</p>`;
    }
  }
}

function formatBackupTime(backup) {
  const date = new Date(backup.time);
  return date.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function renderTenantBackups(backups, tenantId) {
  const container = document.getElementById('tenant-backups-list');

  if (backups.length === 0) {
    container.innerHTML = `<p class="empty">No backups for ${tenantId}. Create your first backup!</p>`;
    return;
  }

  container.innerHTML = backups.map(backup => {
    const formattedDate = formatBackupTime(backup);
    const escapedDate = formattedDate.replace(/'/g, "\\'");

    return `
      <div class="backup-card" data-snapshot-id="${backup.id}">
        <div class="backup-info">
          <span class="backup-name">${formattedDate}</span>
          <span class="backup-meta">ID: ${backup.shortId}</span>
        </div>
        <div class="backup-actions">
          <button class="btn btn-secondary btn-sm" onclick="showRestoreModal('${backup.id}', '${escapedDate}', '${tenantId}')">Restore</button>
          <button class="btn btn-primary btn-sm" onclick="showCreateFromBackupModal('${backup.id}', '${escapedDate}', '${tenantId}')">Clone</button>
          <button class="btn btn-danger btn-sm" onclick="showDeleteBackupModal('${backup.id}', '${escapedDate}')">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

async function createTenantBackup(btn) {
  if (!currentBackupTenantId) return;

  setButtonLoading(btn, true, 'Backing up...');

  try {
    await api('/backups', {
      method: 'POST',
      body: JSON.stringify({ tenantId: currentBackupTenantId }),
    });
    await loadTenantBackups(currentBackupTenantId);
  } catch (error) {
    if (error.isLocked) {
      showLockedError('tenant-backups-list', error.lockInfo);
    } else {
      alert(`Backup failed: ${error.message}`);
    }
  } finally {
    setButtonLoading(btn, false, '+ Create Backup');
  }
}

function showLockedError(containerId, lockInfo) {
  const container = document.getElementById(containerId);
  let details = '';
  if (lockInfo) {
    const parts = [];
    if (lockInfo.pid) parts.push(`PID: ${lockInfo.pid}`);
    if (lockInfo.host) parts.push(`Host: ${lockInfo.host}`);
    if (lockInfo.user) parts.push(`User: ${lockInfo.user}`);
    if (lockInfo.createdAt) parts.push(`Created: ${lockInfo.createdAt}`);
    if (lockInfo.age) parts.push(`Age: ${lockInfo.age}`);
    if (parts.length > 0) {
      details = `<div class="lock-details"><strong>Lock details:</strong><br>${parts.join('<br>')}</div>`;
    }
  }
  container.innerHTML = `
    <div class="locked-error">
      <p class="error">Repository is locked by another operation.</p>
      ${details}
      <p>This can happen if a previous operation timed out or crashed.</p>
      <button class="btn btn-danger btn-sm" onclick="unlockRepository()">Force Unlock</button>
    </div>
  `;
}

async function unlockRepository() {
  const listEl = document.getElementById('tenant-backups-list');
  listEl.innerHTML = '<p class="loading">Unlocking repository...</p>';

  try {
    await api('/backups/unlock', { method: 'POST' });
    if (currentBackupTenantId) {
      backupStatus = await api('/backups/status');
      if (backupStatus.isLocked) {
        showLockedError('tenant-backups-list', backupStatus.lockInfo);
      } else {
        document.getElementById('tenant-create-backup-btn').disabled = false;
        await loadTenantBackups(currentBackupTenantId);
      }
    }
  } catch (error) {
    listEl.innerHTML = `<p class="error">Failed to unlock: ${error.message}</p>`;
  }
}

async function createBackupSilent(tenantId) {
  const result = await api('/backups', {
    method: 'POST',
    body: JSON.stringify({ tenantId }),
  });
  return result;
}

function showRestoreModal(snapshotId, backupName, sourceTenantId) {
  document.getElementById('restore-snapshot-id').value = snapshotId;
  document.getElementById('restore-backup-info').textContent = backupName;
  document.getElementById('restore-error').textContent = '';

  const select = document.getElementById('restore-tenant-select');
  select.innerHTML = '<option value="">Select a tenant...</option>' +
    cachedTenants.map(t => `<option value="${t.tenantId}" ${t.tenantId === sourceTenantId ? 'selected' : ''}>${t.tenantId} (${t.domain})</option>`).join('');

  resetModalButtons('restore-backup-modal');
  showModal('restore-backup-modal');
}

async function restoreBackup(e) {
  e.preventDefault();

  const btn = e.target.querySelector('button[type="submit"]');
  const snapshotId = document.getElementById('restore-snapshot-id').value;
  const tenantId = document.getElementById('restore-tenant-select').value;

  if (!tenantId) {
    document.getElementById('restore-error').textContent = 'Please select a tenant';
    return;
  }

  setButtonLoading(btn, true, 'Restoring...');

  try {
    await api(`/backups/${snapshotId}/restore`, {
      method: 'POST',
      body: JSON.stringify({ tenantId }),
    });
    hideModal('restore-backup-modal');
    alert('Backup restored successfully!');
  } catch (error) {
    setButtonLoading(btn, false, 'Restore');
    if (error.isLocked) {
      hideModal('restore-backup-modal');
      showLockedError('tenant-backups-list', error.lockInfo);
    } else {
      document.getElementById('restore-error').textContent = error.message;
    }
  }
}

function showCreateFromBackupModal(snapshotId, backupName, sourceTenantId) {
  document.getElementById('create-from-backup-snapshot-id').value = snapshotId;
  document.getElementById('create-from-backup-info').textContent = backupName;
  document.getElementById('new-tenant-id').value = sourceTenantId ? `${sourceTenantId}-copy` : '';
  document.getElementById('new-tenant-domain').value = '';
  document.getElementById('create-from-backup-error').textContent = '';
  populateTagSelect('new-tenant-tag', 'latest');
  resetModalButtons('create-from-backup-modal');
  showModal('create-from-backup-modal');
}

async function createTenantFromBackup(e) {
  e.preventDefault();

  const btn = e.target.querySelector('button[type="submit"]');
  const snapshotId = document.getElementById('create-from-backup-snapshot-id').value;
  const tenantId = document.getElementById('new-tenant-id').value;
  const domain = document.getElementById('new-tenant-domain').value;
  const imageTag = document.getElementById('new-tenant-tag').value || 'latest';

  setButtonLoading(btn, true, 'Creating...');

  try {
    await api(`/backups/${snapshotId}/create-tenant`, {
      method: 'POST',
      body: JSON.stringify({ tenantId, domain, imageTag }),
    });
    hideAllModals();
    alert(`Tenant ${tenantId} created from backup!`);
    currentBackupTenantId = null;
    loadDashboard();
  } catch (error) {
    setButtonLoading(btn, false, 'Create Tenant');
    if (error.isLocked) {
      hideModal('create-from-backup-modal');
      showLockedError('tenant-backups-list', error.lockInfo);
    } else {
      document.getElementById('create-from-backup-error').textContent = error.message;
    }
  }
}

function showDeleteBackupModal(snapshotId, backupName) {
  document.getElementById('delete-backup-info').textContent = backupName;
  document.getElementById('confirm-delete-backup-btn').onclick = () => deleteBackup(snapshotId);
  resetModalButtons('delete-backup-modal');
  showModal('delete-backup-modal');
}

async function deleteBackup(snapshotId) {
  const btn = document.getElementById('confirm-delete-backup-btn');
  setButtonLoading(btn, true, 'Deleting...');

  try {
    await api(`/backups/${snapshotId}`, { method: 'DELETE' });
    hideModal('delete-backup-modal');
    if (currentBackupTenantId) {
      await loadTenantBackups(currentBackupTenantId);
    }
  } catch (error) {
    setButtonLoading(btn, false, 'Delete');
    if (error.isLocked) {
      hideModal('delete-backup-modal');
      showLockedError('tenant-backups-list', error.lockInfo);
    } else {
      alert(`Failed to delete backup: ${error.message}`);
    }
  }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', async () => {
  await initGoogleSignIn();

  if (authToken) {
    try {
      await api('/status/health');
      if (currentUser) {
        updateUserInfo(currentUser);
      }
      showScreen('dashboard');
      await loadProjectConfig();
      loadDashboard();
      loadBackupStatus();
    } catch (error) {
      logout();
    }
  } else {
    showScreen('login');
  }

  document.getElementById('logout-btn').addEventListener('click', logout);

  document.getElementById('create-tenant-btn').addEventListener('click', () => {
    document.getElementById('create-tenant-form').reset();
    document.getElementById('create-error').textContent = '';
    populateTagSelect('tenant-tag', 'latest');
    resetModalButtons('create-modal');
    showModal('create-modal');
  });

  document.getElementById('create-tenant-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const btn = e.target.querySelector('button[type="submit"]');
    const data = {
      tenantId: document.getElementById('tenant-id').value,
      domain: document.getElementById('tenant-domain').value,
      imageTag: document.getElementById('tenant-tag').value || 'latest',
    };

    setButtonLoading(btn, true, 'Creating...');

    try {
      await api('/tenants', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      hideAllModals();
      loadDashboard();
    } catch (error) {
      setButtonLoading(btn, false, 'Create Tenant');
      document.getElementById('create-error').textContent = error.message;
    }
  });

  document.getElementById('update-tenant-form').addEventListener('submit', async (e) => {
    e.preventDefault();

    const btn = e.target.querySelector('button[type="submit"]');
    const tenantId = document.getElementById('update-tenant-id').value;
    const imageTag = document.getElementById('update-tag').value;
    const errorEl = document.getElementById('update-error');

    let backupsConfigured = false;
    try {
      const status = await api('/backups/status');
      backupsConfigured = status.configured && status.initialized;
    } catch {
    }

    if (backupsConfigured) {
      setButtonLoading(btn, true, 'Backing up...');
      errorEl.textContent = '';

      try {
        await createBackupSilent(tenantId);
      } catch (error) {
        setButtonLoading(btn, false, 'Update');
        errorEl.textContent = `Backup failed: ${error.message}. Update cancelled.`;
        return;
      }
    }

    setButtonLoading(btn, true, 'Updating...');

    try {
      await api(`/tenants/${tenantId}`, {
        method: 'PATCH',
        body: JSON.stringify({ imageTag }),
      });
      hideAllModals();
      loadDashboard();
    } catch (error) {
      setButtonLoading(btn, false, 'Update');
      errorEl.textContent = error.message;
    }
  });

  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal');
      if (modal) {
        hideModal(modal.id);
      }
    });
  });

  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        hideModal(modal.id);
      }
    });
  });

  document.getElementById('add-admin-btn').addEventListener('click', showAddAdminModal);
  document.getElementById('add-admin-form').addEventListener('submit', addAdmin);
  document.getElementById('tenant-create-backup-btn').addEventListener('click', (e) => {
    createTenantBackup(e.target);
  });
  document.getElementById('restore-backup-form').addEventListener('submit', restoreBackup);
  document.getElementById('create-from-backup-form').addEventListener('submit', createTenantFromBackup);

  setInterval(() => {
    if (authToken && !document.querySelector('.modal:not(.hidden)')) {
      loadDashboard();
    }
  }, 30000);
});
