// Overwatch Admin Dashboard

let authToken = localStorage.getItem('overwatch_admin_token') || '';
let currentUser = JSON.parse(localStorage.getItem('overwatch_admin_user') || 'null');
let googleClientId = '';
let projectConfig = null;
let envVarsLoaded = false;

// Toast Notifications
const toastIcons = {
  success: '&#10003;',
  error: '&#10007;',
  warning: '&#9888;',
  info: '&#8505;',
};

function showToast(message, type = 'info', duration = 4000) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${toastIcons[type]}</span>
    <span class="toast-body">${escapeHtml(message)}</span>
    <button class="toast-close" onclick="this.parentElement.remove()">&times;</button>
  `;
  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      toast.classList.add('removing');
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }
}

// Double-click protection
const _activeActions = new Set();

function guardAction(key, fn) {
  if (_activeActions.has(key)) return;
  _activeActions.add(key);
  return Promise.resolve(fn()).finally(() => _activeActions.delete(key));
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));

  document.getElementById(`tab-${tabName}`).classList.remove('hidden');
  document.querySelector(`.tab-btn[data-tab="${tabName}"]`).classList.add('active');

  if (tabName === 'environment' && !envVarsLoaded) {
    envVarsLoaded = true;
    loadEnvVars();
  }
}

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

// Searchable Select Component
class SearchableSelect {
  constructor(container, options = []) {
    this.container = container;
    this.options = options;
    this.selectedValue = container.dataset.value || '';
    this.isOpen = false;
    this.highlightedIndex = -1;
    this.filteredOptions = [...options];
    this.render();
    this.attachEvents();
  }

  render() {
    const selectedLabel = this.selectedValue || 'Select...';
    this.container.innerHTML = `
      <div class="searchable-select">
        <input type="text" class="searchable-select-input" value="${selectedLabel}" readonly>
        <span class="searchable-select-arrow">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 4.5L6 7.5L9 4.5"/>
          </svg>
        </span>
        <div class="searchable-select-dropdown">
          <div class="searchable-select-search">
            <input type="text" placeholder="Search..." class="searchable-search-input">
          </div>
          <div class="searchable-select-options"></div>
        </div>
      </div>
    `;

    this.selectEl = this.container.querySelector('.searchable-select');
    this.inputEl = this.container.querySelector('.searchable-select-input');
    this.dropdownEl = this.container.querySelector('.searchable-select-dropdown');
    this.searchInputEl = this.container.querySelector('.searchable-search-input');
    this.optionsEl = this.container.querySelector('.searchable-select-options');

    this.renderOptions();
  }

  renderOptions() {
    const searchQuery = this.searchInputEl ? this.searchInputEl.value.trim() : '';
    let html = '';

    if (this.filteredOptions.length > 0) {
      html = this.filteredOptions.map((option, index) => {
        const isSelected = option === this.selectedValue;
        const isHighlighted = index === this.highlightedIndex;
        return `<div class="searchable-select-option${isSelected ? ' selected' : ''}${isHighlighted ? ' highlighted' : ''}" data-value="${option}" data-index="${index}">${option}</div>`;
      }).join('');
    }

    // Show custom tag option when search text doesn't exactly match any option
    if (searchQuery && !this.options.includes(searchQuery)) {
      const customIndex = this.filteredOptions.length;
      const isHighlighted = customIndex === this.highlightedIndex;
      html += `<div class="searchable-select-option custom-tag${isHighlighted ? ' highlighted' : ''}" data-value="${searchQuery}" data-index="${customIndex}">Use "${searchQuery}"</div>`;
    }

    if (!html) {
      html = '<div class="searchable-select-empty">Type a custom tag or search</div>';
    }

    this.optionsEl.innerHTML = html;
  }

  attachEvents() {
    // Toggle dropdown on input click
    this.inputEl.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    // Search input
    this.searchInputEl.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      this.filteredOptions = this.options.filter(opt => opt.toLowerCase().includes(query));
      this.highlightedIndex = this.filteredOptions.length > 0 ? 0 : -1;
      // If no exact match and there's a custom option, highlight it
      if (e.target.value.trim() && !this.options.includes(e.target.value.trim()) && this.highlightedIndex === -1) {
        this.highlightedIndex = 0;
      }
      this.renderOptions();
    });

    // Prevent dropdown close when clicking search
    this.searchInputEl.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Option click
    this.optionsEl.addEventListener('click', (e) => {
      const option = e.target.closest('.searchable-select-option');
      if (option) {
        this.selectOption(option.dataset.value);
      }
    });

    // Keyboard navigation
    this.searchInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this.highlightedIndex = Math.min(this.highlightedIndex + 1, this.filteredOptions.length - 1);
        this.renderOptions();
        this.scrollToHighlighted();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this.highlightedIndex = Math.max(this.highlightedIndex - 1, 0);
        this.renderOptions();
        this.scrollToHighlighted();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.highlightedIndex >= 0 && this.highlightedIndex < this.filteredOptions.length) {
          this.selectOption(this.filteredOptions[this.highlightedIndex]);
        } else {
          // Accept custom input
          const customValue = this.searchInputEl.value.trim();
          if (customValue) {
            this.selectOption(customValue);
          }
        }
      } else if (e.key === 'Escape') {
        this.close();
      }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!this.container.contains(e.target)) {
        this.close();
      }
    });
  }

  scrollToHighlighted() {
    const highlighted = this.optionsEl.querySelector('.highlighted');
    if (highlighted) {
      highlighted.scrollIntoView({ block: 'nearest' });
    }
  }

  selectOption(value) {
    this.selectedValue = value;
    this.container.dataset.value = value;
    this.inputEl.value = value;
    this.close();
  }

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    this.isOpen = true;
    this.selectEl.classList.add('open');
    this.searchInputEl.value = '';
    this.filteredOptions = [...this.options];
    this.highlightedIndex = this.options.indexOf(this.selectedValue);
    if (this.highlightedIndex === -1 && this.options.length > 0) {
      this.highlightedIndex = 0;
    }
    this.renderOptions();
    setTimeout(() => this.searchInputEl.focus(), 10);
    this.scrollToHighlighted();
  }

  close() {
    this.isOpen = false;
    this.selectEl.classList.remove('open');
  }

  getValue() {
    return this.selectedValue;
  }

  setValue(value) {
    this.selectedValue = value;
    this.container.dataset.value = value;
    if (this.inputEl) {
      this.inputEl.value = value;
    }
  }

  setOptions(options) {
    this.options = options;
    this.filteredOptions = [...options];
    if (this.options.length > 0 && !this.options.includes(this.selectedValue)) {
      this.selectedValue = this.options[0];
      this.container.dataset.value = this.selectedValue;
    }
    this.renderOptions();
    if (this.inputEl) {
      this.inputEl.value = this.selectedValue;
    }
  }
}

// Store searchable select instances
const searchableSelects = {};

function initSearchableSelect(containerId, selectedValue = 'latest') {
  const container = document.getElementById(containerId);
  if (!container) return null;

  const options = cachedTags || ['latest'];
  if (searchableSelects[containerId]) {
    searchableSelects[containerId].setOptions(options);
    searchableSelects[containerId].setValue(selectedValue);
    return searchableSelects[containerId];
  }

  container.dataset.value = selectedValue;
  const select = new SearchableSelect(container, options);
  select.setValue(selectedValue);
  searchableSelects[containerId] = select;
  return select;
}

function populateTagSelect(selectId, selectedValue = 'latest') {
  // Map old selectId to new container IDs
  const containerMap = {
    'tenant-tag': 'tenant-tag-container',
    'update-tag': 'update-tag-container',
    'new-tenant-tag': 'new-tenant-tag-container'
  };

  const containerId = containerMap[selectId] || selectId;
  initSearchableSelect(containerId, selectedValue);
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
async function loadDashboard(silent = false) {
  const refreshEl = document.getElementById('refresh-indicator');
  if (silent && refreshEl) refreshEl.classList.remove('hidden');

  try {
    const [health, tenants, , buildHealth] = await Promise.all([
      api('/status/health'),
      api('/tenants'),
      loadImageTags(),
      fetch('/health').then(r => r.json()).catch(() => ({})),
    ]);

    cachedTenants = tenants;

    document.getElementById('health-status').textContent =
      health.database === 'connected' ? 'Healthy' : 'Unhealthy';
    document.getElementById('health-status').className =
      `status-badge ${health.database === 'connected' ? 'healthy' : 'unhealthy'}`;

    // Display build info
    const buildInfoEl = document.getElementById('build-info');
    if (buildInfoEl && buildHealth.buildTime && buildHealth.buildTime !== 'dev') {
      const shortCommit = buildHealth.buildCommit && buildHealth.buildCommit !== 'dev'
        ? buildHealth.buildCommit.substring(0, 7)
        : '';
      const buildDate = new Date(buildHealth.buildTime).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      buildInfoEl.textContent = shortCommit ? `Build: ${buildDate} (${shortCommit})` : `Build: ${buildDate}`;
    } else if (buildInfoEl) {
      buildInfoEl.textContent = 'Build: dev';
    }

    document.getElementById('db-status').textContent = health.database;

    const containerEl = document.getElementById('container-count');
    containerEl.textContent = `${health.runningContainers}/${health.containers}`;
    containerEl.className = 'value has-tooltip';
    containerEl.setAttribute('data-tooltip', formatContainerTooltip(health.containerDetails));

    document.getElementById('tenant-count').textContent = tenants.length;

    renderTenants(tenants);
  } catch (error) {
    console.error('Failed to load dashboard:', error);
  } finally {
    if (refreshEl) refreshEl.classList.add('hidden');
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
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>',
  env: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v1m0 16v1m-8-9H3m18 0h-1m-2.636-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707"></path><circle cx="12" cy="12" r="4"></circle></svg>',
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
        <button class="btn btn-secondary btn-sm btn-icon has-tooltip" onclick="showTenantEnvVarsModal('${tenant.tenantId}')" data-tooltip="Env Vars">${icons.env}</button>
        <button class="btn btn-secondary btn-sm btn-icon has-tooltip" onclick="showUpdateModal('${tenant.tenantId}', '${tenant.version}')" data-tooltip="Update">${icons.update}</button>
        <button class="btn btn-secondary btn-sm btn-icon has-tooltip" onclick="showLogs('${tenant.tenantId}')" data-tooltip="Logs">${icons.logs}</button>
        <button class="btn btn-danger btn-sm btn-icon has-tooltip" onclick="showDeleteModal('${tenant.tenantId}')" data-tooltip="Delete">${icons.trash}</button>
      </div>
    </div>
  `}).join('');
}

// Tenant Actions
async function startTenant(tenantId, btn) {
  guardAction(`start-${tenantId}`, async () => {
    setButtonLoading(btn, true, 'Starting...');
    try {
      await api(`/tenants/${tenantId}/start`, { method: 'POST' });
      showToast(`Tenant ${tenantId} started`, 'success');
      loadDashboard();
    } catch (error) {
      setButtonLoading(btn, false, 'Start');
      showToast(`Failed to start ${tenantId}: ${error.message}`, 'error');
    }
  });
}

async function stopTenant(tenantId, btn) {
  guardAction(`stop-${tenantId}`, async () => {
    setButtonLoading(btn, true, 'Stopping...');
    try {
      await api(`/tenants/${tenantId}/stop`, { method: 'POST' });
      showToast(`Tenant ${tenantId} stopped`, 'success');
      loadDashboard();
    } catch (error) {
      setButtonLoading(btn, false, 'Stop');
      showToast(`Failed to stop ${tenantId}: ${error.message}`, 'error');
    }
  });
}

async function restartTenant(tenantId, btn) {
  guardAction(`restart-${tenantId}`, async () => {
    setButtonLoading(btn, true, 'Restarting...');
    try {
      await api(`/tenants/${tenantId}/restart`, { method: 'POST' });
      showToast(`Tenant ${tenantId} restarted`, 'success');
      loadDashboard();
    } catch (error) {
      setButtonLoading(btn, false, 'Restart');
      showToast(`Failed to restart ${tenantId}: ${error.message}`, 'error');
    }
  });
}

async function accessTenant(tenantId, btn) {
  guardAction(`access-${tenantId}`, async () => {
    setButtonLoading(btn, true, 'Loading...');
    try {
      const result = await api(`/tenants/${tenantId}/access-token`, { method: 'POST' });
      setButtonLoading(btn, false, 'Access');
      window.open(result.accessUrl, '_blank');
    } catch (error) {
      setButtonLoading(btn, false, 'Access');
      showToast(`Failed to access ${tenantId}: ${error.message}`, 'error');
    }
  });
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
    showToast(`Tenant ${tenantId} deleted`, 'success');
    loadDashboard();
  } catch (error) {
    setButtonLoading(btn, false, 'Delete');
    showToast(`Failed to delete tenant: ${error.message}`, 'error');
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
            <span class="admin-email">${escapeHtml(admin.email)}</span>
            <span class="admin-meta">Added ${formatDate(admin.addedAt)} by ${escapeHtml(admin.addedBy)}</span>
          </div>
          <button class="btn btn-danger btn-xs" onclick="confirmDeleteAdmin('${escapeAttr(admin.email)}')">Remove</button>
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
    showToast(`Admin ${email} added`, 'success');
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
    showToast(`Admin ${email} removed`, 'success');
    loadAdminUsers();
  } catch (error) {
    setButtonLoading(btn, false, 'Remove');
    showToast(`Failed to remove admin: ${error.message}`, 'error');
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
    showToast('Backup repository initialized', 'success');
  } catch (error) {
    statusEl.textContent = 'Error';
    showToast(`Failed to initialize: ${error.message}`, 'error');
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
      document.getElementById('tenant-backups-list').innerHTML = `<p class="error">Failed to check backup status: ${escapeHtml(error.message)}</p>`;
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
      document.getElementById('tenant-backups-list').innerHTML = `<p class="error">Failed to initialize: ${escapeHtml(error.message)}</p>`;
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
      listEl.innerHTML = `<p class="error">Error: ${escapeHtml(error.message)}</p>`;
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
    container.innerHTML = `<p class="empty">No backups for ${escapeHtml(tenantId)}. Create your first backup!</p>`;
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
    showToast('Backup created', 'success');
    await loadTenantBackups(currentBackupTenantId);
  } catch (error) {
    if (error.isLocked) {
      showLockedError('tenant-backups-list', error.lockInfo);
    } else {
      showToast(`Backup failed: ${error.message}`, 'error');
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
    listEl.innerHTML = `<p class="error">Failed to unlock: ${escapeHtml(error.message)}</p>`;
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
    showToast('Backup restored successfully', 'success');
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
  const imageTag = document.getElementById('new-tenant-tag-container').dataset.value || 'latest';

  setButtonLoading(btn, true, 'Creating...');

  try {
    await api(`/backups/${snapshotId}/create-tenant`, {
      method: 'POST',
      body: JSON.stringify({ tenantId, domain, imageTag }),
    });
    hideAllModals();
    showToast(`Tenant ${tenantId} created from backup`, 'success');
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
    showToast('Backup deleted', 'success');
    if (currentBackupTenantId) {
      await loadTenantBackups(currentBackupTenantId);
    }
  } catch (error) {
    setButtonLoading(btn, false, 'Delete');
    if (error.isLocked) {
      hideModal('delete-backup-modal');
      showLockedError('tenant-backups-list', error.lockInfo);
    } else {
      showToast(`Failed to delete backup: ${error.message}`, 'error');
    }
  }
}

// Environment Variables Management
let currentEnvVarTenantId = null;

async function loadEnvVars() {
  try {
    const vars = await api('/env-vars');
    renderEnvVars(vars);
  } catch (error) {
    document.getElementById('env-vars-list').innerHTML =
      `<p class="error">Error: ${error.message}</p>`;
  }
}

function renderEnvVars(vars) {
  const container = document.getElementById('env-vars-list');

  if (vars.length === 0) {
    container.innerHTML = '<p class="env-vars-empty">No environment variables defined. Add variables to share configuration across all tenants.</p>';
    return;
  }

  container.innerHTML = vars.map(v => `
    <div class="env-var-card">
      <div class="env-var-info">
        <span class="env-var-key">${v.key}</span>
        <span class="env-var-value">${v.value}</span>
        ${v.description ? `<span class="env-var-description">${v.description}</span>` : ''}
      </div>
      <div class="env-var-actions">
        <button class="btn btn-secondary btn-xs" onclick="showEditEnvVarModal('${v.key}', '${escapeAttr(v.value)}', ${v.sensitive}, '${escapeAttr(v.description || '')}')">Edit</button>
        <button class="btn btn-danger btn-xs" onclick="showDeleteEnvVarModal('${v.key}')">Delete</button>
      </div>
    </div>
  `).join('');
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(str) {
  return escapeHtml(str);
}

function showAddEnvVarModal() {
  document.getElementById('env-var-modal-title').textContent = 'Add Environment Variable';
  document.getElementById('env-var-key').value = '';
  document.getElementById('env-var-key').disabled = false;
  document.getElementById('env-var-value').value = '';
  document.getElementById('env-var-value').required = true;
  document.getElementById('env-var-value').placeholder = 'Variable value';
  document.getElementById('env-var-sensitive').checked = false;
  document.getElementById('env-var-description').value = '';
  document.getElementById('env-var-error').textContent = '';
  resetModalButtons('env-var-modal');
  showModal('env-var-modal');
}

function showEditEnvVarModal(key, value, sensitive, description) {
  document.getElementById('env-var-modal-title').textContent = 'Edit Environment Variable';
  document.getElementById('env-var-key').value = key;
  document.getElementById('env-var-key').disabled = true;
  document.getElementById('env-var-value').value = sensitive ? '' : value;
  document.getElementById('env-var-value').placeholder = sensitive ? 'Enter new value (leave blank to keep current)' : 'Variable value';
  document.getElementById('env-var-value').required = !sensitive;
  document.getElementById('env-var-sensitive').checked = sensitive;
  document.getElementById('env-var-description').value = description;
  document.getElementById('env-var-error').textContent = '';
  resetModalButtons('env-var-modal');
  showModal('env-var-modal');
}

async function saveEnvVar(e) {
  e.preventDefault();

  const btn = e.target.querySelector('button[type="submit"]');
  const key = document.getElementById('env-var-key').value.trim();
  const value = document.getElementById('env-var-value').value;
  const sensitive = document.getElementById('env-var-sensitive').checked;
  const description = document.getElementById('env-var-description').value.trim();
  const isEdit = document.getElementById('env-var-key').disabled;


  setButtonLoading(btn, true, 'Saving...');

  try {
    const result = await api('/env-vars', {
      method: 'POST',
      body: JSON.stringify({ key, value, sensitive, description: description || undefined }),
    });
    hideModal('env-var-modal');
    showToast(`Variable ${key} saved`, 'success');
    loadEnvVars();

    if (result.tenantsAffected > 0) {
      document.getElementById('restart-tenants-count').textContent = result.tenantsAffected;
      showModal('restart-tenants-modal');
    }
  } catch (error) {
    setButtonLoading(btn, false, 'Save');
    document.getElementById('env-var-error').textContent = error.message;
  }
}

function showDeleteEnvVarModal(key) {
  document.getElementById('delete-env-var-key').textContent = key;
  document.getElementById('confirm-delete-env-var-btn').onclick = () => deleteEnvVar(key);
  resetModalButtons('delete-env-var-modal');
  showModal('delete-env-var-modal');
}

async function deleteEnvVar(key) {
  const btn = document.getElementById('confirm-delete-env-var-btn');
  setButtonLoading(btn, true, 'Deleting...');

  try {
    const result = await api(`/env-vars/${encodeURIComponent(key)}`, { method: 'DELETE' });
    hideModal('delete-env-var-modal');
    showToast(`Variable ${key} deleted`, 'success');
    loadEnvVars();

    if (result.tenantsAffected > 0) {
      document.getElementById('restart-tenants-count').textContent = result.tenantsAffected;
      showModal('restart-tenants-modal');
    }
  } catch (error) {
    setButtonLoading(btn, false, 'Delete');
    showToast(`Failed to delete: ${error.message}`, 'error');
  }
}

async function restartAllTenants() {
  const btn = document.getElementById('confirm-restart-tenants-btn');
  setButtonLoading(btn, true, 'Restarting...');

  const failed = [];
  for (const tenant of cachedTenants) {
    try {
      await api(`/tenants/${tenant.tenantId}/restart`, { method: 'POST' });
    } catch (err) {
      failed.push(tenant.tenantId);
      console.error(`Failed to restart ${tenant.tenantId}:`, err);
    }
  }
  hideModal('restart-tenants-modal');
  loadDashboard();

  if (failed.length > 0) {
    showToast(`Failed to restart: ${failed.join(', ')}`, 'error', 6000);
  } else {
    showToast('All tenants restarted', 'success');
  }
}

// Tenant Environment Variables

async function showTenantEnvVarsModal(tenantId) {
  currentEnvVarTenantId = tenantId;
  document.getElementById('tenant-env-vars-name').textContent = tenantId;
  document.getElementById('tenant-env-vars-list').innerHTML = '<p class="loading">Loading...</p>';
  showModal('tenant-env-vars-modal');

  try {
    const vars = await api(`/env-vars/tenants/${tenantId}`);
    renderTenantEnvVars(vars, tenantId);
  } catch (error) {
    document.getElementById('tenant-env-vars-list').innerHTML =
      `<p class="error">Error: ${error.message}</p>`;
  }
}

function renderTenantEnvVars(vars, tenantId) {
  const container = document.getElementById('tenant-env-vars-list');

  if (vars.length === 0) {
    container.innerHTML = '<p class="env-vars-empty">No environment variables configured. Add global variables first.</p>';
    return;
  }

  container.innerHTML = vars.map(v => `
    <div class="env-var-card">
      <div class="env-var-info">
        <span class="env-var-key">${v.key} <span class="source-badge ${v.source}">${v.source}</span></span>
        <span class="env-var-value">${v.value}</span>
        ${v.description ? `<span class="env-var-description">${v.description}</span>` : ''}
      </div>
      <div class="env-var-actions">
        <button class="btn btn-secondary btn-xs" onclick="showOverrideEnvVarModal('${tenantId}', '${v.key}', '${escapeAttr(v.value)}', ${v.sensitive})">Override</button>
        ${v.source === 'override' ? `<button class="btn btn-danger btn-xs" onclick="resetTenantOverride('${tenantId}', '${v.key}')">Reset</button>` : ''}
      </div>
    </div>
  `).join('');
}

function showOverrideEnvVarModal(tenantId, key, value, sensitive) {
  document.getElementById('override-tenant-id').value = tenantId;
  document.getElementById('override-env-var-key').textContent = key;
  document.getElementById('override-env-var-value').value = sensitive ? '' : value;
  document.getElementById('override-env-var-value').placeholder = sensitive ? 'Enter override value' : 'Override value';
  document.getElementById('override-env-var-sensitive').checked = sensitive;
  document.getElementById('override-env-var-error').textContent = '';
  resetModalButtons('override-env-var-modal');
  showModal('override-env-var-modal');
}

async function saveOverrideEnvVar(e) {
  e.preventDefault();

  const btn = e.target.querySelector('button[type="submit"]');
  const tenantId = document.getElementById('override-tenant-id').value;
  const key = document.getElementById('override-env-var-key').textContent;
  const value = document.getElementById('override-env-var-value').value;
  const sensitive = document.getElementById('override-env-var-sensitive').checked;

  if (!value) {
    document.getElementById('override-env-var-error').textContent = 'Value is required';
    return;
  }

  setButtonLoading(btn, true, 'Saving...');

  try {
    await api(`/env-vars/tenants/${tenantId}/overrides`, {
      method: 'POST',
      body: JSON.stringify({ key, value, sensitive }),
    });
    hideModal('override-env-var-modal');
    showToast(`Override for ${key} saved`, 'success');
    showTenantEnvVarsModal(tenantId);
  } catch (error) {
    setButtonLoading(btn, false, 'Save Override');
    document.getElementById('override-env-var-error').textContent = error.message;
  }
}

async function resetTenantOverride(tenantId, key) {
  try {
    await api(`/env-vars/tenants/${tenantId}/overrides/${encodeURIComponent(key)}`, { method: 'DELETE' });
    showToast(`Override for ${key} reset`, 'success');
    showTenantEnvVarsModal(tenantId);
  } catch (error) {
    showToast(`Failed to reset override: ${error.message}`, 'error');
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

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Manage admins modal
  document.getElementById('manage-admins-btn').addEventListener('click', () => {
    showModal('manage-admins-modal');
    loadAdminUsers();
  });

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
      imageTag: document.getElementById('tenant-tag-container').dataset.value || 'latest',
    };

    setButtonLoading(btn, true, 'Creating...');

    try {
      await api('/tenants', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      hideAllModals();
      showToast(`Tenant ${data.tenantId} created`, 'success');
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
    const imageTag = document.getElementById('update-tag-container').dataset.value;
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
      showToast(`Tenant ${tenantId} updated`, 'success');
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

  // Env var management
  document.getElementById('add-env-var-btn').addEventListener('click', showAddEnvVarModal);
  document.getElementById('env-var-form').addEventListener('submit', saveEnvVar);
  document.getElementById('override-env-var-form').addEventListener('submit', saveOverrideEnvVar);
  document.getElementById('confirm-restart-tenants-btn').addEventListener('click', restartAllTenants);

  document.getElementById('add-admin-btn').addEventListener('click', showAddAdminModal);
  document.getElementById('add-admin-form').addEventListener('submit', addAdmin);
  document.getElementById('tenant-create-backup-btn').addEventListener('click', (e) => {
    createTenantBackup(e.target);
  });
  document.getElementById('restore-backup-form').addEventListener('submit', restoreBackup);
  document.getElementById('create-from-backup-form').addEventListener('submit', createTenantFromBackup);

  setInterval(() => {
    if (authToken && !document.querySelector('.modal:not(.hidden)')) {
      loadDashboard(true);
    }
  }, 30000);
});
