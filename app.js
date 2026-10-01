/**
 * Vehicle Expiry & Document Management System
 * Full Client-Side App Powered by IndexedDB, WebRTC Camera, JSZip, and Web Notifications.
 */

// ==================== INDEXEDDB ENGINE ====================
class VehicleDB {
  constructor() {
    this.dbName = 'VehicleExpiryDB';
    this.version = 1;
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('vehicles')) {
          const store = db.createObjectStore('vehicles', { keyPath: 'id', autoIncrement: true });
          store.createIndex('vehicleNo', 'vehicleNo', { unique: false });
        }
      };

      request.onsuccess = (event) => {
        this.db = event.target.result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        console.error('IndexedDB Error:', event.target.error);
        reject(event.target.error);
      };
    });
  }

  async getAllVehicles() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('vehicles', 'readonly');
      const store = tx.objectStore('vehicles');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async getVehicle(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('vehicles', 'readonly');
      const store = tx.objectStore('vehicles');
      const request = store.get(Number(id));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async saveVehicle(vehicle, skipCloudSync = false) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('vehicles', 'readwrite');
      const store = tx.objectStore('vehicles');
      let request;
      if (vehicle.id) {
        request = store.put(vehicle);
      } else {
        vehicle.createdAt = new Date().toISOString();
        request = store.add(vehicle);
      }
      request.onsuccess = (e) => {
        if (!vehicle.id) vehicle.id = e.target.result;
        if (!skipCloudSync) syncVehicleToCloud(vehicle);
        resolve(e.target.result);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteVehicle(id, skipCloudSync = false) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('vehicles', 'readwrite');
      const store = tx.objectStore('vehicles');
      const request = store.delete(Number(id));
      request.onsuccess = () => {
        if (!skipCloudSync && !isSyncingFromCloud) {
          deleteVehicleFromCloud(id);
        }
        resolve(true);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async clearAll() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('vehicles', 'readwrite');
      const store = tx.objectStore('vehicles');
      const request = store.clear();
      request.onsuccess = () => resolve(true);
      request.onerror = () => reject(request.error);
    });
  }
}

// Global Instances & App State
const db = new VehicleDB();
let vehicles = [];
let activeFilter = 'all';
let currentEditingVehicleId = null;
let currentDocManagerVehicleId = null;
let tempAttachedFiles = [];
let cameraStream = null;
let cameraFacingMode = 'environment';
let currentViewMode = localStorage.getItem('vehicleex_view_mode') || 'card';

// Cloudinary Media Configuration
const CLOUDINARY_CONFIG = {
  cloudName: 'pknpbpzr',
  uploadPreset: 'photos'
};

// Direct Cloudinary Upload function with instant pre-compression & timeout
async function uploadToCloudinary(fileOrBase64) {
  let payload = fileOrBase64;
  // If it's a raw File / Blob from camera or device (often 5MB-10MB), compress to ~90KB first!
  if (fileOrBase64 instanceof File || fileOrBase64 instanceof Blob) {
    try {
      payload = await fileToBase64(fileOrBase64);
    } catch (e) {
      console.warn('Compression notice, fallback to original:', e);
      payload = fileOrBase64;
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const formData = new FormData();
    formData.append('file', payload);
    formData.append('upload_preset', CLOUDINARY_CONFIG.uploadPreset);

    const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CONFIG.cloudName}/auto/upload`, {
      method: 'POST',
      body: formData,
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error?.message || 'Cloudinary upload failed');
    }

    const data = await res.json();
    return {
      url: data.secure_url,
      publicId: data.public_id,
      bytes: data.bytes
    };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Document Field Definitions
const DOC_FIELDS = [
  { key: 'regDate', label: 'Registration', isExpiry: false },
  { key: 'fitnessUpto', label: 'Fitness', isExpiry: true },
  { key: 'insuranceUpto', label: 'Insurance', isExpiry: true },
  { key: 'taxUpto', label: 'Tax', isExpiry: true },
  { key: 'permitUpto', label: 'Permit', isExpiry: true },
  { key: 'nationalPermit', label: 'National Permit', isExpiry: true },
  { key: 'pucc', label: 'PUCC', isExpiry: true }
];

// ==================== APP INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await db.init();
  } catch (dbErr) {
    console.error('IndexedDB init error:', dbErr);
  }

  registerServiceWorker();

  try {
    await loadVehicles();
  } catch (loadErr) {
    console.error('Load vehicles error:', loadErr);
  }

  try {
    setupEventListeners();
  } catch (elErr) {
    console.error('Event listeners setup error:', elErr);
  }

  try {
    setupNotifications();
  } catch (notifErr) {
    console.error('Notification setup error:', notifErr);
  }

  try {
    initCompanySync();
  } catch (syncErr) {
    console.error('Company sync init error:', syncErr);
  }
});

// Automatically re-sync and restore realtime stream when device regains network
window.addEventListener('online', () => {
  console.log('🌐 Network connection restored. Syncing with cloud...');
  if (currentSyncKey) {
    fetchLatestCloudVehicles();
    listenToFirebaseWorkspace();
  }
});

// Load Vehicles from IndexedDB
async function loadVehicles() {
  vehicles = await db.getAllVehicles();
  renderDashboardStats();
  renderVehiclesList();
  checkAndTriggerExpirations();
}

// Register Service Worker
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(err => console.log('SW registration notice:', err));
  }
}

// Request Notification Permissions Safely
function setupNotifications() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      const p = Notification.requestPermission();
      if (p && typeof p.then === 'function') {
        p.catch(() => {});
      }
    }
  } catch (e) {
    console.warn('Notification permission request notice:', e);
  }
}

// Cross-Platform Notification Helper (Works safely on Android Chrome and Desktop)
async function triggerSystemNotification(title, options) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    // 1. Android Chrome / PWA standard: use ServiceWorker registration
    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && typeof reg.showNotification === 'function') {
          await reg.showNotification(title, options);
          return;
        }
      } catch (swErr) {
        console.warn('SW notification fallback:', swErr);
      }
    }

    // 2. Desktop browser fallback where 'new Notification' is allowed
    try {
      new Notification(title, options);
    } catch (desktopErr) {
      console.warn('Desktop Notification constructor notice:', desktopErr);
    }
  } catch (err) {
    console.warn('Notification display suppressed safely:', err);
  }
}

// HTML Sanitization helper against XSS
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==================== EXPIRY COMPUTATION ====================
function getDocStatus(dateStr) {
  if (!dateStr) return { status: 'none', label: '-', badgeClass: '' };
  
  const now = new Date();
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(dateStr);
  if (isNaN(target.getTime())) return { status: 'none', label: '-', badgeClass: '' };

  const targetMidnight = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const diffDays = Math.ceil((targetMidnight - nowMidnight) / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    const daysAgo = Math.abs(diffDays);
    return { status: 'expired', label: `Expired ${daysAgo}d ago`, badgeClass: 'expired' };
  } else if (diffDays === 0) {
    return { status: 'expired', label: `Expired Today`, badgeClass: 'expired' };
  } else if (diffDays <= 10) {
    return { status: 'expiring-critical', label: diffDays === 1 ? 'Expires Tomorrow' : `Expires in ${diffDays}d`, badgeClass: 'expiring-critical' };
  } else if (diffDays <= 30) {
    return { status: 'expiring', label: `Expires in ${diffDays}d`, badgeClass: 'expiring' };
  } else {
    return { status: 'valid', label: `Valid`, badgeClass: 'valid' };
  }
}

function getOverallVehicleStatus(v) {
  let hasExpired = false;
  let hasExpiringCritical = false;
  let hasExpiring = false;

  DOC_FIELDS.forEach(f => {
    if (!f.isExpiry) return;
    const val = v[f.key];
    if (val) {
      const st = getDocStatus(val).status;
      if (st === 'expired') hasExpired = true;
      if (st === 'expiring-critical') hasExpiringCritical = true;
      if (st === 'expiring') hasExpiring = true;
    }
  });

  if (hasExpired) return 'expired';
  if (hasExpiringCritical) return 'expiring-critical';
  if (hasExpiring) return 'expiring';
  return 'valid';
}

// ==================== DASHBOARD METRICS ====================
function renderDashboardStats() {
  let total = vehicles.length;
  let expiredCount = 0;
  let expiringCount = 0;
  let validCount = 0;

  vehicles.forEach(v => {
    let hasExpired = false;
    let hasExpiring = false;

    DOC_FIELDS.forEach(f => {
      if (!f.isExpiry) return;
      const val = v[f.key];
      if (val) {
        const st = getDocStatus(val).status;
        if (st === 'expired') hasExpired = true;
        if (st === 'expiring' || st === 'expiring-critical') hasExpiring = true;
      }
    });

    if (hasExpired) expiredCount++;
    if (hasExpiring) expiringCount++;
    if (!hasExpired && !hasExpiring) validCount++;
  });

  const totalEl = document.getElementById('statTotal');
  const expEl = document.getElementById('statExpired');
  const soonEl = document.getElementById('statExpiring');
  const valEl = document.getElementById('statValid');

  if (totalEl) totalEl.innerText = total;
  if (expEl) expEl.innerText = expiredCount;
  if (soonEl) soonEl.innerText = expiringCount;
  if (valEl) valEl.innerText = validCount;
}

function setFilter(filterType) {
  activeFilter = filterType;
  document.querySelectorAll('.filter-pills .pill-btn').forEach(b => {
    if (b.getAttribute('data-filter') === filterType) {
      b.classList.add('active');
    } else {
      b.classList.remove('active');
    }
  });
  renderVehiclesList();
}

// ==================== RENDER VEHICLE CARDS & TABLE VIEW ====================
function toggleViewMode() {
  currentViewMode = currentViewMode === 'card' ? 'table' : 'card';
  localStorage.setItem('vehicleex_view_mode', currentViewMode);
  updateViewToggleButton();
  renderVehiclesList();
}

function updateViewToggleButton() {
  const btn = document.getElementById('viewToggleBtn');
  if (btn) {
    btn.innerHTML = currentViewMode === 'card' ? '📋 Table View' : '🔲 Card View';
    btn.title = currentViewMode === 'card' ? 'Switch to Table View' : 'Switch to Card View';
  }
}

function renderVehiclesList() {
  const container = document.getElementById('vehiclesGrid');
  const searchVal = document.getElementById('searchInput').value.trim().toLowerCase();
  updateViewToggleButton();

  const filtered = vehicles.filter(v => {
    // 1. Filter by tab
    if (activeFilter === 'expired') {
      let hasExpired = false;
      DOC_FIELDS.forEach(f => {
        if (!f.isExpiry) return;
        const val = v[f.key];
        if (val && getDocStatus(val).status === 'expired') hasExpired = true;
      });
      if (!hasExpired) return false;
    } else if (activeFilter === 'expiring') {
      let hasExpiring = false;
      DOC_FIELDS.forEach(f => {
        if (!f.isExpiry) return;
        const val = v[f.key];
        if (val) {
          const st = getDocStatus(val).status;
          if (st === 'expiring' || st === 'expiring-critical') hasExpiring = true;
        }
      });
      if (!hasExpiring) return false;
    } else if (activeFilter === 'valid') {
      const overallStatus = getOverallVehicleStatus(v);
      if (overallStatus !== 'valid') return false;
    }

    // 2. Filter by search
    if (searchVal) {
      const noMatch = (v.vehicleNo || '').toLowerCase().includes(searchVal);
      const gpsMatch = (v.gps || '').toLowerCase().includes(searchVal);
      return noMatch || gpsMatch;
    }

    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div style="grid-column: 1 / -1; text-align: center; padding: 3rem 1rem; color: var(--text-muted);">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom: 1rem;"><circle cx="12" cy="12" r="10"/><path d="M16 16s-1.5-2-4-2-4 2-4 2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
        <p style="font-size: 1.1rem; font-weight: 600;">No vehicle records found</p>
        <p style="font-size: 0.85rem; margin-top: 0.2rem;">Try adjusting search terms or add a new vehicle.</p>
      </div>
    `;
    return;
  }

  // If Table View is selected
  if (currentViewMode === 'table') {
    container.style.display = 'block';
    let tblHtml = `
      <div class="table-responsive-wrapper">
        <div class="table-scroll-hint">
          <span>👉 Swipe horizontally to view all documents & actions</span>
        </div>
        <table class="vehicles-data-table">
          <thead>
            <tr>
              <th class="sticky-col">Vehicle No</th>
              <th>Fitness</th>
              <th>Insurance</th>
              <th>Tax</th>
              <th>Permit</th>
              <th>PUCC</th>
              <th>Docs</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
    `;

    filtered.forEach(v => {
      const overallStatus = getOverallVehicleStatus(v);
      let overallBadge = '';
      if (overallStatus === 'expired') overallBadge = '<span class="status-badge expired">🔴 Expired</span>';
      else if (overallStatus === 'expiring-critical') overallBadge = '<span class="status-badge expiring-critical">🟠 Exp. 10d</span>';
      else if (overallStatus === 'expiring') overallBadge = '<span class="status-badge expiring">🟡 Expiring</span>';
      else overallBadge = '<span class="status-badge valid">🟢 Valid</span>';

      const attachedFilesCount = (v.files && v.files.length) || 0;

      function renderTableCell(key) {
        const val = v[key];
        if (!val) return '<span style="color: var(--text-muted);">-</span>';
        const st = getDocStatus(val);
        const d = new Date(val);
        const dStr = isNaN(d.getTime()) ? val : d.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
        let badge = '';
        if (st.status === 'expired') badge = '<span class="status-badge expired" style="padding:0.1rem 0.35rem; font-size:0.65rem;">🔴 Exp</span>';
        else if (st.status === 'expiring-critical') badge = '<span class="status-badge expiring-critical" style="padding:0.1rem 0.35rem; font-size:0.65rem;">🟠 10d</span>';
        else if (st.status === 'expiring') badge = '<span class="status-badge expiring" style="padding:0.1rem 0.35rem; font-size:0.65rem;">🟡 Soon</span>';
        else badge = '<span class="status-badge valid" style="padding:0.1rem 0.35rem; font-size:0.65rem;">🟢</span>';

        return `<div class="tbl-date-cell"><span class="tbl-date-val">${dStr}</span>${badge}</div>`;
      }

      tblHtml += `
        <tr>
          <td class="sticky-col">
            <div class="tbl-vnum">${escapeHtml(v.vehicleNo || 'Vehicle')}</div>
            <div style="margin-top: 4px;">${overallBadge}</div>
            ${v.gps ? `<small style="color: var(--text-muted); display: block; margin-top: 2px; font-size: 0.72rem;">${escapeHtml(v.gps)}</small>` : ''}
          </td>
          <td>${renderTableCell('fitnessUpto')}</td>
          <td>${renderTableCell('insuranceUpto')}</td>
          <td>${renderTableCell('taxUpto')}</td>
          <td>${renderTableCell('permitUpto')}</td>
          <td>${renderTableCell('pucc')}</td>
          <td>
            <button class="secondary-btn" onclick="openDocManagerModal(${v.id})" style="padding: 0.35rem 0.65rem; font-size: 0.8rem;">
              📁 ${attachedFilesCount}
            </button>
          </td>
          <td>
            <div class="tbl-actions">
              <button onclick="duplicateVehicle(${v.id})" title="Duplicate record to new vehicle">📑 Copy</button>
              <button onclick="editVehicle(${v.id})" title="Edit">✏️ Edit</button>
              <button class="btn-del" onclick="deleteVehicleRecord(${v.id})" title="Delete">🗑️</button>
            </div>
          </td>
        </tr>
      `;
    });

    tblHtml += `
          </tbody>
        </table>
      </div>
    `;
    container.innerHTML = tblHtml;
    return;
  }

  // Otherwise, render Card View (with prominent, large dates!)
  container.style.display = 'grid';
  let html = '';
  filtered.forEach(v => {
    const overallStatus = getOverallVehicleStatus(v);
    let overallBadge = '';
    if (overallStatus === 'expired') overallBadge = '<span class="status-badge expired">🔴 Expired</span>';
    else if (overallStatus === 'expiring-critical') overallBadge = '<span class="status-badge expiring-critical">🟠 Exp. 10d</span>';
    else if (overallStatus === 'expiring') overallBadge = '<span class="status-badge expiring">🟡 Expiring Soon</span>';
    else overallBadge = '<span class="status-badge valid">🟢 Valid</span>';

    const attachedFilesCount = (v.files && v.files.length) || 0;

    html += `
      <div class="vehicle-card">
        <div>
          <div class="v-header">
            <div>
              <div class="v-number">${escapeHtml(v.vehicleNo)}</div>
            </div>
            ${overallBadge}
          </div>

          <div class="doc-chips-grid">
      `;

    DOC_FIELDS.forEach(f => {
      const val = v[f.key];
      const st = f.isExpiry ? getDocStatus(val) : { status: 'none', label: '', badgeClass: '' };
      let dateDisplay = '-';
      if (val) {
        const d = new Date(val);
        dateDisplay = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
      }

      let chipClass = 'doc-chip';
      if (f.isExpiry && st.status === 'expired') chipClass += ' chip-expired';
      else if (f.isExpiry && st.status === 'expiring-critical') chipClass += ' chip-critical';
      else if (f.isExpiry && st.status === 'expiring') chipClass += ' chip-expiring';

      html += `
        <div class="${chipClass}">
          <span class="doc-label">${f.label}</span>
          <span class="doc-val">
            <span>${dateDisplay}</span>
            ${(f.isExpiry && st.badgeClass) ? `<span class="status-badge ${st.badgeClass}" style="padding: 0.15rem 0.5rem; font-size: 0.68rem;">${st.status === 'expired' ? '🔴 Expired' : st.status === 'expiring-critical' ? '🟠 10d' : st.status === 'expiring' ? '🟡 Soon' : '🟢 Valid'}</span>` : ''}
          </span>
        </div>
      `;
    });

    html += `
          </div>
          
          ${v.gps ? `<div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem;"><strong>GPS/Info:</strong> ${escapeHtml(v.gps)}</div>` : ''}
        </div>

        <div class="v-actions">
          <button onclick="openDocManagerModal(${v.id})" title="Manage Documents">
            📁 Docs (${attachedFilesCount})
          </button>
          <button onclick="duplicateVehicle(${v.id})" title="Duplicate record to new vehicle">
            📑 Copy
          </button>
          <button onclick="editVehicle(${v.id})" title="Edit Record">
            ✏️ Edit
          </button>
          <button class="btn-del" onclick="deleteVehicleRecord(${v.id})" title="Delete">
            🗑️
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// ==================== NOTIFICATIONS ENGINE ====================
function checkAndTriggerExpirations() {
  const notifList = [];
  const now = new Date();

  vehicles.forEach(v => {
    DOC_FIELDS.forEach(f => {
      if (!f.isExpiry) return;
      const val = v[f.key];
      if (val) {
        const target = new Date(val);
        const diffTime = target - now;
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        if (now >= target) {
          notifList.push({
            vehicleNo: v.vehicleNo,
            docLabel: f.label,
            status: 'expired',
            message: `${f.label} expired for vehicle ${v.vehicleNo}`,
            vehicleId: v.id
          });
        } else if (diffDays <= 10) {
          notifList.push({
            vehicleNo: v.vehicleNo,
            docLabel: f.label,
            status: 'expiring',
            message: `${f.label} expiring in ${diffDays} day(s) for ${v.vehicleNo}`,
            vehicleId: v.id
          });
        }
      }
    });
  });

  // Update notification badge
  const badgeEl = document.getElementById('notifBadge');
  if (notifList.length > 0) {
    badgeEl.innerText = notifList.length;
    badgeEl.style.display = 'flex';
  } else {
    badgeEl.style.display = 'none';
  }

  // Save active notifications to container
  window.activeNotifications = notifList;

  // Trigger system notification if newly expired
  try {
    if (notifList.length > 0 && 'Notification' in window && Notification.permission === 'granted') {
      const expiredItems = notifList.filter(n => n.status === 'expired');
      if (expiredItems.length > 0) {
        triggerSystemNotification('🚨 Vehicle Document Expired!', {
          body: expiredItems.map(i => i.message).slice(0, 3).join('\n'),
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="%23ef4444"/></svg>'
        });
      }
    }
  } catch (e) {
    console.warn('Notification trigger notice:', e);
  }
}

// ==================== EVENT LISTENERS & MODAL CONTROL ====================
function setupEventListeners() {
  // Theme Toggle
  document.getElementById('themeToggleBtn').addEventListener('click', () => {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    document.getElementById('themeIconSun').style.display = isDark ? 'inline' : 'none';
    document.getElementById('themeIconMoon').style.display = isDark ? 'none' : 'inline';
  });

  // Search input
  document.getElementById('searchInput').addEventListener('input', () => {
    renderVehiclesList();
  });

  // Filter Pills
  document.querySelectorAll('.filter-pills .pill-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.filter-pills .pill-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      activeFilter = e.target.getAttribute('data-filter');
      renderVehiclesList();
    });
  });

  // Open Add Vehicle Modal
  document.getElementById('openAddVehicleModalBtn').addEventListener('click', () => {
    openVehicleModal();
  });

  // Mobile bottom nav helper
  function bindMobileNav(elementId, handler) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      document.querySelectorAll('.mobile-nav .nav-item').forEach(item => item.classList.remove('active'));
      el.classList.add('active');
      handler();
    });
  }

  bindMobileNav('mobNavAdd', () => openVehicleModal());
  bindMobileNav('mobNavNotif', () => openNotifModal());
  bindMobileNav('mobNavHome', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  bindMobileNav('mobNavCalendar', () => openCalendarModal());

  // Close Modal Helper
  function bindCloseBtn(btnId, closeFn) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeFn();
    });
  }

  bindCloseBtn('closeVehicleModalBtn', closeVehicleModal);
  bindCloseBtn('cancelVehicleModalBtn', closeVehicleModal);
  bindCloseBtn('closeCameraModalBtn', closeCameraModal);
  bindCloseBtn('closeDocManagerBtn', closeDocManagerModal);
  bindCloseBtn('closeNotifModalBtn', closeNotifModal);
  bindCloseBtn('closeCalendarModalBtn', closeCalendarModal);
  bindCloseBtn('closeOcrModalBtn', () => { document.getElementById('ocrModal').classList.remove('active'); });
  bindCloseBtn('closeLightboxBtn', () => {
    document.getElementById('lightboxModal').classList.remove('active');
  });

  // Tap Backdrop (.modal-overlay) to close active modal
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.remove('active');
        if (overlay.id === 'cameraModal' && cameraStream) {
          cameraStream.getTracks().forEach(track => track.stop());
          cameraStream = null;
        }
      }
    });
  });

  // Vehicle Form Submit
  document.getElementById('vehicleForm').addEventListener('submit', handleVehicleFormSubmit);

  // File selection inputs - listen for changes
  document.getElementById('fileInput').addEventListener('change', handleFileInputChange);
  document.getElementById('nativeCameraInput').addEventListener('change', handleFileInputChange);

  // Document Manager Extra Uploads
  const extraFileEl = document.getElementById('extraFileInput');
  if (extraFileEl) extraFileEl.addEventListener('change', handleExtraFileInputChange);
  const extraCamEl = document.getElementById('extraCameraInput');
  if (extraCamEl) extraCamEl.addEventListener('change', handleExtraFileInputChange);

  // Camera Scanner Modal Triggers
  document.getElementById('openCameraScannerBtn').addEventListener('click', openCameraModal);
  document.getElementById('takeSnapshotBtn').addEventListener('click', captureCameraSnapshot);
  document.getElementById('switchCameraBtn').addEventListener('click', switchCameraFacing);

  // Document Manager Actions
  document.getElementById('downloadAllZipBtn').addEventListener('click', handleDownloadAllZip);
  document.getElementById('ocrScanAllBtn').addEventListener('click', ocrScanAllDocs);

  // Notification Bell
  document.getElementById('notifBellBtn').addEventListener('click', openNotifModal);

  // Export / Import Database JSON
  const exportDbBtn = document.getElementById('exportDbBtn');
  if (exportDbBtn) exportDbBtn.addEventListener('click', exportDatabaseJson);
  const importDbBtn = document.getElementById('importDbBtn');
  if (importDbBtn) {
    importDbBtn.addEventListener('click', () => {
      const input = document.getElementById('importDbInput');
      if (input) input.click();
    });
  }
  const importDbInput = document.getElementById('importDbInput');
  if (importDbInput) importDbInput.addEventListener('change', importDatabaseJson);

  // Export CSV
  document.getElementById('exportCsvBtn').addEventListener('click', exportVehiclesCsv);

  // Calendar Navigation
  document.getElementById('calPrevMonth').addEventListener('click', () => {
    calendarViewMonth--;
    if (calendarViewMonth < 0) { calendarViewMonth = 11; calendarViewYear--; }
    renderCalendar();
  });
  document.getElementById('calNextMonth').addEventListener('click', () => {
    calendarViewMonth++;
    if (calendarViewMonth > 11) { calendarViewMonth = 0; calendarViewYear++; }
    renderCalendar();
  });
}

// ==================== VEHICLE CRUD ACTIONS ====================

function toDateInputValue(val) {
  if (!val) return '';
  return String(val).trim().split('T')[0];
}

function formatExpiryDateWithDefaultTime(val) {
  if (!val) return '';
  const dateOnly = String(val).trim().split('T')[0];
  if (!dateOnly) return '';
  return `${dateOnly}T08:00`;
}

function setQuickDate(inputId, type) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const now = new Date();
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (type === 'today') {
    // today
  } else if (type === '+6m') {
    d.setMonth(d.getMonth() + 6);
  } else if (type === '+1y') {
    d.setFullYear(d.getFullYear() + 1);
  } else if (type === '+2y') {
    d.setFullYear(d.getFullYear() + 2);
  } else if (type === '+5y') {
    d.setFullYear(d.getFullYear() + 5);
  } else if (type === '+15y') {
    d.setFullYear(d.getFullYear() + 15);
  } else if (type === 'quarter') {
    const y = now.getFullYear();
    const m = now.getMonth();
    if (m < 2 || (m === 2 && now.getDate() < 31)) {
      d = new Date(y, 2, 31);
    } else if (m < 5 || (m === 5 && now.getDate() < 30)) {
      d = new Date(y, 5, 30);
    } else if (m < 8 || (m === 8 && now.getDate() < 30)) {
      d = new Date(y, 8, 30);
    } else if (m < 11 || (m === 11 && now.getDate() < 31)) {
      d = new Date(y, 11, 31);
    } else {
      d = new Date(y + 1, 2, 31);
    }
  }

  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  input.value = `${yyyy}-${mm}-${dd}`;

  input.classList.add('input-highlight-flash');
  setTimeout(() => input.classList.remove('input-highlight-flash'), 400);
}

function duplicateVehicle(id) {
  const v = vehicles.find(item => item.id === Number(id));
  if (!v) return;
  openVehicleModal({
    ...v,
    id: null,
    isClone: true,
    vehicleNo: ''
  });
}

function openVehicleModal(vehicleToEdit = null) {
  tempAttachedFiles = [];
  const form = document.getElementById('vehicleForm');
  form.reset();

  if (vehicleToEdit) {
    currentEditingVehicleId = vehicleToEdit.id;
    document.getElementById('vehicleModalTitle').innerText = vehicleToEdit.isClone ? 'Duplicate Record to New Vehicle' : 'Edit Vehicle Record';
    document.getElementById('vehicleNo').value = vehicleToEdit.vehicleNo || '';
    document.getElementById('regDate').value = toDateInputValue(vehicleToEdit.regDate);
    document.getElementById('fitnessUpto').value = toDateInputValue(vehicleToEdit.fitnessUpto);
    document.getElementById('insuranceUpto').value = toDateInputValue(vehicleToEdit.insuranceUpto);
    document.getElementById('taxUpto').value = toDateInputValue(vehicleToEdit.taxUpto);
    document.getElementById('permitUpto').value = toDateInputValue(vehicleToEdit.permitUpto);
    document.getElementById('nationalPermit').value = toDateInputValue(vehicleToEdit.nationalPermit);
    document.getElementById('pucc').value = toDateInputValue(vehicleToEdit.pucc);
    document.getElementById('gps').value = vehicleToEdit.gps || '';
    tempAttachedFiles = vehicleToEdit.files ? [...vehicleToEdit.files] : [];
  } else {
    currentEditingVehicleId = null;
    document.getElementById('vehicleModalTitle').innerText = 'Add Vehicle Record';
  }

  updateFormFileCountText();
  renderFormAttachedPreview();
  document.getElementById('vehicleModal').classList.add('active');
  setTimeout(() => document.getElementById('vehicleNo')?.focus(), 150);
}

function closeVehicleModal() {
  document.getElementById('vehicleModal').classList.remove('active');
}

async function editVehicle(idOrNo) {
  let v = null;
  if (idOrNo !== undefined && idOrNo !== null) {
    if (typeof idOrNo === 'number' || !isNaN(Number(idOrNo))) {
      v = await db.getVehicle(Number(idOrNo));
    }
    if (!v) {
      v = vehicles.find(item => String(item.id) === String(idOrNo) || item.vehicleNo === String(idOrNo));
    }
  }

  if (v) {
    openVehicleModal(v);
  } else {
    alert('Vehicle record not found.');
  }
}

async function deleteVehicleRecord(id) {
  const v = await db.getVehicle(id);
  if (v && confirm(`Are you sure you want to delete vehicle record ${v.vehicleNo}?`)) {
    await db.deleteVehicle(id);
    await loadVehicles();
  }
}

function collectVehicleFormData() {
  const vehicleNo = document.getElementById('vehicleNo').value.trim().toUpperCase();
  if (!vehicleNo) {
    alert('Please enter a vehicle number.');
    return null;
  }

  const vehicleData = {
    vehicleNo,
    regDate: document.getElementById('regDate').value,
    fitnessUpto: formatExpiryDateWithDefaultTime(document.getElementById('fitnessUpto').value),
    insuranceUpto: formatExpiryDateWithDefaultTime(document.getElementById('insuranceUpto').value),
    taxUpto: formatExpiryDateWithDefaultTime(document.getElementById('taxUpto').value),
    permitUpto: formatExpiryDateWithDefaultTime(document.getElementById('permitUpto').value),
    nationalPermit: formatExpiryDateWithDefaultTime(document.getElementById('nationalPermit').value),
    pucc: formatExpiryDateWithDefaultTime(document.getElementById('pucc').value),
    gps: document.getElementById('gps').value.trim(),
    files: tempAttachedFiles
  };

  if (currentEditingVehicleId) {
    vehicleData.id = currentEditingVehicleId;
  }
  return vehicleData;
}

async function handleVehicleFormSubmit(e) {
  if (e) e.preventDefault();
  const vehicleData = collectVehicleFormData();
  if (!vehicleData) return;

  await db.saveVehicle(vehicleData);
  await pushCurrentVehiclesToCloud();
  closeVehicleModal();
  await loadVehicles();
}

async function handleSaveAndAddNext() {
  const vehicleData = collectVehicleFormData();
  if (!vehicleData) return;

  await db.saveVehicle(vehicleData);
  await pushCurrentVehiclesToCloud();
  await loadVehicles();

  const savedNo = vehicleData.vehicleNo;
  document.getElementById('vehicleForm').reset();
  tempAttachedFiles = [];
  currentEditingVehicleId = null;
  updateFormFileCountText();
  renderFormAttachedPreview();

  const title = document.getElementById('vehicleModalTitle');
  if (title) {
    title.innerText = `✅ Saved ${savedNo}! Enter Next Vehicle:`;
    setTimeout(() => { if (title) title.innerText = 'Add Vehicle Record'; }, 3000);
  }

  const vInput = document.getElementById('vehicleNo');
  if (vInput) {
    vInput.focus();
    vInput.classList.add('input-highlight-flash');
    setTimeout(() => vInput.classList.remove('input-highlight-flash'), 500);
  }
}

// File Input Handler with Cloudinary Upload
async function handleFileInputChange(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  if (tempAttachedFiles.length + files.length > 10) {
    alert(`You can attach up to 10 files. Currently have ${tempAttachedFiles.length}, trying to add ${files.length}.`);
    e.target.value = ''; // Reset so they can try again
    return;
  }

  const countTxt = document.getElementById('formFileCountText');
  if (countTxt) {
    countTxt.innerHTML = '<span style="color: var(--primary); font-weight: 700;">☁️ Uploading photos to Cloudinary... please wait</span>';
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let fileUrl = '';
    try {
      const uploadRes = await uploadToCloudinary(file);
      fileUrl = uploadRes.url;
    } catch (err) {
      console.warn('Cloudinary upload fallback to base64:', err);
      fileUrl = await fileToBase64(file);
    }

    tempAttachedFiles.push({
      id: 'f_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substr(2, 5),
      name: file.name,
      type: file.type,
      category: 'General',
      url: fileUrl,
      data: fileUrl
    });
  }

  // CRITICAL: Reset input value so the same input can trigger 'change' again for subsequent uploads
  e.target.value = '';

  updateFormFileCountText();
  renderFormAttachedPreview();
}

function isPdfFile(fileObj, fileSrc) {
  if (!fileObj && !fileSrc) return false;
  const type = (fileObj && fileObj.type) || '';
  const name = (fileObj && fileObj.name) || '';
  const src = fileSrc || (fileObj && (fileObj.url || fileObj.data)) || '';

  if (type === 'application/pdf') return true;
  if (name.toLowerCase().endsWith('.pdf')) return true;
  if (typeof src === 'string') {
    const s = src.toLowerCase();
    if (s.startsWith('data:application/pdf')) return true;
    if (s.endsWith('.pdf') || s.includes('.pdf?') || s.includes('/pdf/')) return true;
  }
  return false;
}

function isImageFile(fileObj, fileSrc) {
  if (isPdfFile(fileObj, fileSrc)) return false;
  const type = (fileObj && fileObj.type) || '';
  const name = (fileObj && fileObj.name) || '';
  const src = fileSrc || (fileObj && (fileObj.url || fileObj.data)) || '';

  if (type.startsWith('image/')) return true;
  if (name.match(/\.(jpg|jpeg|png|webp|gif|bmp|svg|avif)$/i)) return true;
  if (typeof src === 'string') {
    const s = src.toLowerCase();
    if (s.startsWith('data:image/')) return true;
    if (s.match(/\.(jpg|jpeg|png|webp|gif|bmp|svg|avif)(\?|$)/i)) return true;
    if (s.includes('cloudinary.com') && !s.includes('.pdf')) return true;
  }
  return false;
}

function updateFormFileCountText() {
  const txt = document.getElementById('formFileCountText');
  const scanBtnRow = document.getElementById('formAiScanBtnRow');
  if (tempAttachedFiles.length === 0) {
    if (txt) txt.innerText = 'No files selected.';
    if (scanBtnRow) scanBtnRow.style.display = 'none';
  } else {
    if (txt) txt.innerText = `${tempAttachedFiles.length} of 10 file(s) attached.`;
    if (scanBtnRow) scanBtnRow.style.display = 'block';
  }
}

// Render visual thumbnail preview grid with individual remove buttons and click-to-view
function renderFormAttachedPreview() {
  const container = document.getElementById('formAttachedPreview');
  if (!container) return;

  if (tempAttachedFiles.length === 0) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  tempAttachedFiles.forEach((f, idx) => {
    const fileSrc = f.url || f.data;
    const isPdf = isPdfFile(f, fileSrc);
    const isImg = isImageFile(f, fileSrc);

    let thumbContent = '';
    if (isImg) {
      thumbContent = `<img src="${fileSrc}" style="width: 100%; height: 80px; object-fit: cover; border-radius: 6px;">`;
    } else if (isPdf) {
      thumbContent = `
        <div style="width: 100%; height: 80px; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(239, 68, 68, 0.1); border: 1px dashed rgba(239, 68, 68, 0.4); border-radius: 6px; color: #ef4444;">
          <span style="font-size: 1.8rem; line-height: 1;">📄</span>
          <span style="font-size: 0.65rem; font-weight: 800; margin-top: 3px; letter-spacing: 0.5px;">PDF DOC</span>
        </div>`;
    } else {
      thumbContent = `<div style="width: 100%; height: 80px; display: flex; align-items: center; justify-content: center; background: var(--bg-main); border-radius: 6px; font-size: 2rem;">📁</div>`;
    }

    html += `
      <div style="position: relative; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; padding: 4px;">
        <div onclick="previewFormAttachedFile(${idx})" style="cursor: pointer;" title="Click to view file">
          ${thumbContent}
        </div>
        <div style="font-size: 0.7rem; padding: 3px 4px 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted); cursor: pointer;" onclick="previewFormAttachedFile(${idx})" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
        <button type="button" onclick="removeFormAttachedFile(${idx})" style="position: absolute; top: 4px; right: 4px; width: 32px; height: 32px; border-radius: 50%; background: #ef4444; color: #ffffff; border: 2px solid #ffffff; font-size: 1.1rem; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; box-shadow: 0 2px 8px rgba(0,0,0,0.6); z-index: 20; touch-action: manipulation;" title="Remove this file">✕</button>
      </div>
    `;
  });

  container.innerHTML = html;
}

function previewFormAttachedFile(idx) {
  const f = tempAttachedFiles[idx];
  if (!f) return;
  const fileSrc = f.url || f.data;
  openLightboxWithFile(f.name, fileSrc, f.type);
}

// Remove a single file from the form's attached files list
function removeFormAttachedFile(idx) {
  tempAttachedFiles.splice(idx, 1);
  updateFormFileCountText();
  renderFormAttachedPreview();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    // If not an image (e.g. PDF), read standard base64
    if (!file.type || !file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result);
      reader.onerror = err => reject(err);
      return;
    }

    // For images, automatically compress to max 1200px and 72% JPEG quality
    // This reduces 10MB camera photos to ~80KB-120KB (98% reduction!) while keeping text crystal clear
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (e) => {
      const img = new Image();
      img.src = e.target.result;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const maxDim = 1200;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.72);
        resolve(compressedDataUrl);
      };
      img.onerror = () => resolve(e.target.result); // Fallback
    };
    reader.onerror = err => reject(err);
  });
}

// ==================== LIVE CAMERA SCANNER ====================
async function openCameraModal() {
  const modal = document.getElementById('cameraModal');
  modal.classList.add('active');
  await startCameraStream();
}

async function startCameraStream() {
  const video = document.getElementById('cameraVideo');
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
  }

  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacingMode, width: { ideal: 1280 }, height: { ideal: 960 } }
    });
    video.srcObject = cameraStream;
  } catch (err) {
    alert('Could not access camera. Please allow camera permissions or use file picker.');
    closeCameraModal();
  }
}

function closeCameraModal() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(track => track.stop());
    cameraStream = null;
  }
  document.getElementById('cameraModal').classList.remove('active');
}

function switchCameraFacing() {
  cameraFacingMode = cameraFacingMode === 'environment' ? 'user' : 'environment';
  startCameraStream();
}

async function captureCameraSnapshot() {
  const video = document.getElementById('cameraVideo');
  const canvas = document.getElementById('cameraCanvas');
  const ctx = canvas.getContext('2d');

  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg', 0.85);

  const category = document.getElementById('cameraDocCategory').value || 'Captured';
  const fileName = `${category}_Scan_${Date.now()}.jpg`;

  closeCameraModal();

  const countTxt = document.getElementById('formFileCountText');
  if (countTxt) {
    countTxt.innerHTML = '<span style="color: var(--primary); font-weight: 700;">☁️ Uploading snapshot to Cloudinary...</span>';
  }

  let fileUrl = '';
  try {
    const uploadRes = await uploadToCloudinary(base64);
    fileUrl = uploadRes.url;
  } catch (err) {
    console.warn('Snapshot Cloudinary fallback to base64:', err);
    fileUrl = base64;
  }

  tempAttachedFiles.push({
    id: 'f_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    name: fileName,
    type: 'image/jpeg',
    category: category,
    url: fileUrl,
    data: fileUrl
  });

  updateFormFileCountText();
  renderFormAttachedPreview();
}

// ==================== DOCUMENT MANAGER (ADD/REMOVE/UPDATE/RENAME/PREVIEW) ====================
async function openDocManagerModal(vehicleId) {
  currentDocManagerVehicleId = vehicleId;
  const vehicle = await db.getVehicle(vehicleId);
  if (!vehicle) return;

  document.getElementById('docManagerTitle').innerText = `Documents: ${vehicle.vehicleNo}`;
  renderDocList(vehicle);
  document.getElementById('docManagerModal').classList.add('active');
}

function closeDocManagerModal() {
  document.getElementById('docManagerModal').classList.remove('active');
  currentDocManagerVehicleId = null;
  loadVehicles(); // refresh UI
}

function renderDocList(vehicle) {
  const container = document.getElementById('docListContainer');
  if (!vehicle.files || vehicle.files.length === 0) {
    container.innerHTML = `<p style="color: var(--text-muted); text-align: center; padding: 2rem 1rem;">No documents attached yet. Use buttons below to add photos.</p>`;
    return;
  }

  let html = '';
  vehicle.files.forEach((f, idx) => {
    const fileSrc = f.url || f.data;
    const isPdf = isPdfFile(f, fileSrc);
    const isImg = isImageFile(f, fileSrc);

    let thumbHtml = '';
    if (isImg) {
      thumbHtml = `<img src="${fileSrc}" class="doc-thumb" alt="${escapeHtml(f.name)}">`;
    } else if (isPdf) {
      thumbHtml = `
        <div class="doc-thumb" style="display:flex; flex-direction:column; align-items:center; justify-content:center; background: rgba(239, 68, 68, 0.12); color: #ef4444;">
          <span style="font-size: 1.4rem; line-height: 1;">📄</span>
          <span style="font-size: 0.6rem; font-weight: 800; margin-top: 2px;">PDF</span>
        </div>`;
    } else {
      thumbHtml = `<div class="doc-thumb" style="display:flex;align-items:center;justify-content:center;font-size:1.4rem;">📁</div>`;
    }

    html += `
      <div class="doc-item-row">
        <div class="doc-item-top">
          <div class="doc-thumb-wrapper" onclick="previewDocFile('${f.id}')" title="Click to view">
            ${thumbHtml}
            <div class="doc-thumb-hover-overlay">🔍</div>
          </div>

          <div class="doc-details">
            <div class="doc-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
            <span class="doc-meta-badge" onclick="renameDocCategory('${f.id}')" title="Click to change category">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><circle cx="7" cy="7" r="1.5"/></svg>
              <span>${escapeHtml(f.category || 'Document')}</span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="opacity: 0.6;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
            </span>
          </div>
        </div>

        <div class="doc-item-actions">
          <button class="doc-action-btn btn-view" onclick="previewDocFile('${f.id}')" title="View Document">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>View</span>
          </button>
          <button class="doc-action-btn btn-share" onclick="shareDocFile('${f.id}')" title="Share via WhatsApp">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            <span>Share</span>
          </button>
          <button class="doc-action-btn btn-download" onclick="downloadSingleDoc('${f.id}')" title="Download Document">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          </button>
          <button class="doc-action-btn btn-delete" onclick="deleteDocFile('${f.id}')" title="Delete Document">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

async function handleUploadExtraDoc() {
  const input = document.getElementById('extraFileInput');
  if (!input.files || input.files.length === 0) {
    alert('Please select a file to upload.');
    return;
  }

  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  if (!vehicle.files) vehicle.files = [];

  for (let i = 0; i < input.files.length; i++) {
    const file = input.files[i];
    let fileUrl = '';
    try {
      const uploadRes = await uploadToCloudinary(file);
      fileUrl = uploadRes.url;
    } catch (err) {
      console.warn('Cloudinary upload fallback to base64:', err);
      fileUrl = await fileToBase64(file);
    }

    vehicle.files.push({
      id: 'f_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      name: file.name,
      type: file.type,
      category: 'Uploaded',
      url: fileUrl,
      data: fileUrl
    });
  }

  await db.saveVehicle(vehicle);
  await pushCurrentVehiclesToCloud();
  input.value = '';
  renderDocList(vehicle);
}

async function handleExtraFileInputChange(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  if (!vehicle.files) vehicle.files = [];

  const listContainer = document.getElementById('docListContainer');
  let noticeEl = document.getElementById('cloudUploadNotice');
  if (!noticeEl && listContainer) {
    listContainer.insertAdjacentHTML('afterbegin', '<div id="cloudUploadNotice" class="upload-progress-indicator">⚡ Compressing & uploading to Cloudinary...</div>');
    noticeEl = document.getElementById('cloudUploadNotice');
  }

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (noticeEl) {
        noticeEl.innerText = `⚡ Uploading photo ${i + 1} of ${files.length}...`;
      }
      let fileUrl = '';
      try {
        const uploadRes = await uploadToCloudinary(file);
        fileUrl = uploadRes.url;
      } catch (err) {
        console.warn('Cloudinary upload fallback to base64:', err);
        fileUrl = await fileToBase64(file);
      }

      vehicle.files.push({
        id: 'f_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substr(2, 5),
        name: file.name,
        type: file.type,
        category: 'Document',
        url: fileUrl,
        data: fileUrl
      });
    }

    await db.saveVehicle(vehicle);
    await pushCurrentVehiclesToCloud();
  } finally {
    const notice = document.getElementById('cloudUploadNotice');
    if (notice) notice.remove();
  }

  e.target.value = '';
  renderDocList(vehicle);
}

async function deleteDocFile(fileId) {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  if (!confirm('Are you sure you want to delete this document?')) return;

  vehicle.files = (vehicle.files || []).filter(f => f.id !== fileId);
  await db.saveVehicle(vehicle);
  await pushCurrentVehiclesToCloud();
  renderDocList(vehicle);
}

async function renameDocCategory(fileId) {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  const fileObj = vehicle.files.find(f => f.id === fileId);
  if (!fileObj) return;

  const newCat = prompt("Enter new document category (e.g., RC, Insurance, Photo):", fileObj.category || '');
  if (newCat && newCat.trim() !== '') {
    fileObj.category = newCat.trim();
    await db.saveVehicle(vehicle);
    await pushCurrentVehiclesToCloud();
    renderDocList(vehicle);
  }
}

// Function to share document via WhatsApp / Web Share API
async function shareDocFile(fileId) {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  const fileObj = vehicle.files.find(f => f.id === fileId);
  if (!fileObj) return;

  const fileSrc = fileObj.url || fileObj.data;

  const downloadFallback = () => {
    const a = document.createElement('a');
    a.href = fileSrc;
    a.download = fileObj.name || `document_${fileId}.jpg`;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    alert("Opening or downloading file so you can share it.");
  };

  if (!navigator.share) {
    downloadFallback();
    return;
  }

  try {
    const res = await fetch(fileSrc);
    const blob = await res.blob();
    const file = new File([blob], fileObj.name, { type: fileObj.type || 'image/jpeg' });

    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({
        files: [file],
        title: fileObj.name,
        text: `Vehicle Document: ${vehicle.vehicleNo} - ${fileObj.category || 'General'}`
      });
    } else if (navigator.share) {
      await navigator.share({
        title: fileObj.name,
        text: `Vehicle Document: ${vehicle.vehicleNo} - ${fileObj.category || 'General'}: ${fileSrc}`
      });
    } else {
      downloadFallback();
    }
  } catch (error) {
    console.error("Error sharing file:", error);
    if (error.name !== 'AbortError') {
      downloadFallback();
    }
  }
}

let currentLightboxFile = null;
let currentLightboxBlobUrl = null;

function closeLightboxModal() {
  const modal = document.getElementById('lightboxModal');
  if (modal) modal.classList.remove('active');
  const content = document.getElementById('lightboxContent');
  if (content) content.innerHTML = '';
  if (currentLightboxBlobUrl) {
    try { URL.revokeObjectURL(currentLightboxBlobUrl); } catch (e) {}
    currentLightboxBlobUrl = null;
  }
  currentLightboxFile = null;
}

function openLightboxWithFile(name, src, type) {
  currentLightboxFile = { name: name || 'Document', src, type };
  const titleEl = document.getElementById('lightboxTitle');
  if (titleEl) titleEl.innerText = name || 'Document Preview';

  const modal = document.getElementById('lightboxModal');
  const content = document.getElementById('lightboxContent');
  if (!modal || !content) return;

  const isPdf = isPdfFile({ name, type }, src);
  const isImg = isImageFile({ name, type }, src);

  if (isImg) {
    content.innerHTML = `
      <div style="display: flex; justify-content: center; align-items: center; width: 100%; padding: 0.5rem;">
        <img src="${src}" alt="${escapeHtml(name)}" style="max-width: 100%; max-height: 75vh; border-radius: 8px; object-fit: contain; box-shadow: 0 4px 20px rgba(0,0,0,0.6);">
      </div>
    `;
  } else if (isPdf) {
    renderPdfInLightbox(src, content);
  } else {
    const blobUrl = getPdfBlobUrl(src);
    content.innerHTML = `
      <div style="text-align: center; color: #fff; padding: 2.5rem 1rem;">
        <div style="font-size: 3rem; margin-bottom: 0.75rem;">📁</div>
        <p style="font-size: 1rem; font-weight: 600; margin-bottom: 1rem;">${escapeHtml(name)}</p>
        <div style="display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap;">
          <a href="${blobUrl}" target="_blank" class="primary-btn" style="color: #fff; text-decoration: none;">↗️ Open File</a>
          <button type="button" class="secondary-btn" onclick="downloadCurrentLightboxFile()" style="color: #fff; border-color: rgba(255,255,255,0.3);">📥 Download</button>
        </div>
      </div>
    `;
  }

  modal.classList.add('active');
}

async function renderPdfInLightbox(pdfSource, contentContainer) {
  contentContainer.innerHTML = `
    <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 3rem 1rem; color: #fff; width: 100%;">
      <div class="ocr-spinner" style="margin-bottom: 1rem;"></div>
      <p style="font-size: 1rem; font-weight: 700; margin: 0;">Rendering PDF Document...</p>
      <p style="font-size: 0.8rem; color: #94a3b8; margin-top: 0.4rem;">High clarity canvas viewer</p>
    </div>
  `;

  try {
    const pdf = await loadPdfDocument(pdfSource);
    const numPages = pdf.numPages;

    contentContainer.innerHTML = `
      <div id="pdfViewerScroll" style="width: 100%; max-height: 72vh; overflow-y: auto; overflow-x: auto; display: flex; flex-direction: column; align-items: center; gap: 1rem; padding: 0.5rem; -webkit-overflow-scrolling: touch;"></div>
    `;
    const scrollContainer = document.getElementById('pdfViewerScroll');

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const unscaledViewport = page.getViewport({ scale: 1.0 });

      // Calculate width to fit comfortably on screen (mobile or desktop)
      const containerWidth = Math.min(window.innerWidth - 48, 760);
      const scale = containerWidth / unscaledViewport.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const renderViewport = page.getViewport({ scale: scale * dpr });

      const pageCard = document.createElement('div');
      pageCard.style.cssText = 'position: relative; background: #ffffff; border-radius: 8px; box-shadow: 0 4px 20px rgba(0,0,0,0.6); overflow: hidden; display: flex; flex-direction: column; align-items: center; max-width: 100%;';

      const pageHeader = document.createElement('div');
      pageHeader.style.cssText = 'width: 100%; background: #1e293b; color: #cbd5e1; font-size: 0.75rem; font-weight: 700; padding: 6px 12px; display: flex; justify-content: space-between; align-items: center; box-sizing: border-box;';
      pageHeader.innerHTML = `<span>Page ${pageNum} of ${numPages}</span><span style="font-size: 0.7rem; color: #64748b;">${Math.round(unscaledViewport.width)} × ${Math.round(unscaledViewport.height)}</span>`;

      const canvas = document.createElement('canvas');
      canvas.width = renderViewport.width;
      canvas.height = renderViewport.height;
      canvas.style.width = `${Math.round(renderViewport.width / dpr)}px`;
      canvas.style.maxWidth = '100%';
      canvas.style.height = 'auto';
      canvas.style.display = 'block';

      const ctx = canvas.getContext('2d');
      pageCard.appendChild(pageHeader);
      pageCard.appendChild(canvas);
      scrollContainer.appendChild(pageCard);

      await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
    }
  } catch (err) {
    console.error('PDF Render Error:', err);
    const blobUrl = getPdfBlobUrl(pdfSource);
    contentContainer.innerHTML = `
      <div style="text-align: center; color: #fff; padding: 2.5rem 1rem; max-width: 480px;">
        <div style="font-size: 3rem; margin-bottom: 0.75rem;">📄</div>
        <h4 style="font-size: 1.1rem; margin-bottom: 0.5rem; color: #fff;">PDF Document</h4>
        <p style="font-size: 0.85rem; color: #94a3b8; margin-bottom: 1.5rem;">
          Tap below to open this PDF full-screen in your phone or browser's PDF viewer.
        </p>
        <div style="display: flex; gap: 0.75rem; justify-content: center; flex-wrap: wrap;">
          <a href="${blobUrl}" target="_blank" class="primary-btn" style="color: #fff; text-decoration: none; padding: 0.65rem 1.25rem; font-weight: 700; display: inline-flex; align-items: center; gap: 0.4rem;">
            ↗️ Open Full PDF
          </a>
          <button type="button" class="secondary-btn" onclick="downloadCurrentLightboxFile()" style="color: #fff; border-color: rgba(255,255,255,0.3); background: rgba(255,255,255,0.1); padding: 0.65rem 1.25rem; font-weight: 700;">
            📥 Download
          </button>
        </div>
      </div>
    `;
  }
}

function openCurrentLightboxInNewTab() {
  if (!currentLightboxFile || !currentLightboxFile.src) return;
  const isPdf = isPdfFile(currentLightboxFile, currentLightboxFile.src);
  if (isPdf) {
    const blobUrl = getPdfBlobUrl(currentLightboxFile.src);
    window.open(blobUrl, '_blank');
  } else {
    window.open(currentLightboxFile.src, '_blank');
  }
}

function downloadCurrentLightboxFile() {
  if (!currentLightboxFile || !currentLightboxFile.src) return;
  const a = document.createElement('a');
  const isPdf = isPdfFile(currentLightboxFile, currentLightboxFile.src);
  const targetUrl = isPdf ? getPdfBlobUrl(currentLightboxFile.src) : currentLightboxFile.src;
  a.href = targetUrl;
  a.download = currentLightboxFile.name || 'document';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 500);
}

async function previewDocFile(fileId) {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  const fileObj = vehicle.files.find(f => f.id === fileId);
  if (!fileObj) return;

  const fileSrc = fileObj.url || fileObj.data;
  openLightboxWithFile(fileObj.name, fileSrc, fileObj.type);
}

async function downloadSingleDoc(fileId) {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  const fileObj = vehicle.files.find(f => f.id === fileId);
  if (!fileObj) return;

  const fileSrc = fileObj.url || fileObj.data;
  const a = document.createElement('a');
  const isPdf = isPdfFile(fileObj, fileSrc);
  const targetUrl = isPdf ? getPdfBlobUrl(fileSrc) : fileSrc;
  a.href = targetUrl;
  a.download = fileObj.name || 'document';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => document.body.removeChild(a), 500);
}

// Bulk ZIP Download using JSZip
async function handleDownloadAllZip() {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle || !vehicle.files || vehicle.files.length === 0) {
    alert('No documents to download.');
    return;
  }

  if (typeof JSZip === 'undefined') {
    alert('JSZip library is loading. Please try again in a moment.');
    return;
  }

  const zip = new JSZip();
  const folder = zip.folder(`${vehicle.vehicleNo}_Documents`);

  for (let i = 0; i < vehicle.files.length; i++) {
    const f = vehicle.files[i];
    const fileSrc = f.url || f.data;
    if (!fileSrc) continue;

    try {
      if (fileSrc.startsWith('http')) {
        const res = await fetch(fileSrc);
        const blob = await res.blob();
        folder.file(f.name || `doc_${i+1}.jpg`, blob);
      } else if (fileSrc.includes(',')) {
        const base64Data = fileSrc.split(',')[1];
        folder.file(f.name || `doc_${i+1}.jpg`, base64Data, { base64: true });
      }
    } catch (e) {
      console.warn('Zip file add notice:', e);
    }
  }

  const content = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(content);
  a.download = `${vehicle.vehicleNo}_All_Documents.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ==================== NOTIFICATION MODAL ====================
function openNotifModal() {
  const container = document.getElementById('notifListContainer');
  const items = window.activeNotifications || [];

  if (items.length === 0) {
    container.innerHTML = `<p style="text-align: center; padding: 2rem; color: var(--text-muted);">🎉 All document expirations are up to date!</p>`;
  } else {
    let html = '';
    items.forEach(n => {
      html += `
        <div style="background: var(--bg-main); border: 1px solid var(--border-color); border-radius: 8px; padding: 0.75rem 1rem; display: flex; align-items: center; justify-content: space-between;">
          <div>
            <div style="font-weight: 700; font-size: 0.95rem;">${n.vehicleNo}</div>
            <div style="font-size: 0.85rem; color: ${n.status === 'expired' ? 'var(--danger)' : 'var(--warning)'}; font-weight: 600;">
              ${n.message}
            </div>
          </div>
          <button class="secondary-btn" onclick="editVehicleFromNotif('${n.vehicleId}')">Edit & Renew</button>
        </div>
      `;
    });
    container.innerHTML = html;
  }

  document.getElementById('notifModal').classList.add('active');
}

function closeNotifModal() {
  document.getElementById('notifModal').classList.remove('active');
}

async function editVehicleFromNotif(idOrNo) {
  closeNotifModal();
  setTimeout(async () => {
    await editVehicle(idOrNo);
  }, 100);
}

// ==================== EXPORT & IMPORT ====================
async function exportDatabaseJson() {
  const allVehicles = await db.getAllVehicles();
  const jsonStr = JSON.stringify(allVehicles, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `VehicleExpiry_Backup_${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function importDatabaseJson(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (event) => {
    try {
      const importedData = JSON.parse(event.target.result);
      if (Array.isArray(importedData)) {
        if (confirm(`Import ${importedData.length} vehicle records into database?`)) {
          for (const item of importedData) {
            delete item.id; // allow autoIncrement
            await db.saveVehicle(item);
          }
          await loadVehicles();
          if (currentSyncKey) {
            await pushCurrentVehiclesToCloud();
          }
          alert('Database restored successfully!');
        }
      }
    } catch (err) {
      alert('Invalid backup JSON file.');
    }
  };
  reader.readAsText(file);
}

// ==================== EXCEL (.XLSX) EXPORT ENGINE ====================
async function exportVehiclesExcel() {
  let allVehicles = (vehicles && vehicles.length > 0) ? vehicles : await db.getAllVehicles();
  if (!allVehicles || allVehicles.length === 0) {
    alert('No vehicle records to export.');
    return;
  }

  function formatExcelDate(dateStr) {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      const day = String(d.getDate()).padStart(2, '0');
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const year = d.getFullYear();
      let hours = d.getHours();
      const minutes = String(d.getMinutes()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12 || 12;
      return `${day}/${month}/${year} ${hours}:${minutes} ${ampm}`;
    } catch (e) {
      return dateStr;
    }
  }

  // Build rows array with structured headers
  const rows = allVehicles.map(v => {
    const overallStatus = getOverallVehicleStatus(v);
    let statusLabel = 'Valid';
    if (overallStatus === 'expired') statusLabel = 'Expired';
    else if (overallStatus === 'expiring-critical') statusLabel = 'Expires in <= 10 Days';
    else if (overallStatus === 'expiring') statusLabel = 'Expiring Soon';

    return {
      'Vehicle Number': v.vehicleNo || '',
      'Status': statusLabel,
      'Registration Date': v.regDate || '-',
      'Fitness Upto': formatExcelDate(v.fitnessUpto),
      'Insurance Upto': formatExcelDate(v.insuranceUpto),
      'Tax Upto': formatExcelDate(v.taxUpto),
      'Permit Upto': formatExcelDate(v.permitUpto),
      'National Permit Upto': formatExcelDate(v.nationalPermit),
      'PUCC Upto': formatExcelDate(v.pucc),
      'GPS / Remarks': v.gps || '-',
      'Attached Docs Count': (v.files && v.files.length) || 0
    };
  });

  // If XLSX library is loaded, export true Microsoft Excel .xlsx
  if (typeof XLSX !== 'undefined') {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.json_to_sheet(rows);

    // Auto-fit column widths
    ws['!cols'] = [
      { wch: 16 }, // Vehicle Number
      { wch: 22 }, // Status
      { wch: 18 }, // Registration Date
      { wch: 22 }, // Fitness Upto
      { wch: 22 }, // Insurance Upto
      { wch: 22 }, // Tax Upto
      { wch: 22 }, // Permit Upto
      { wch: 22 }, // National Permit Upto
      { wch: 22 }, // PUCC Upto
      { wch: 25 }, // GPS / Remarks
      { wch: 18 }  // Attached Docs Count
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Vehicles Report');
    const todayStr = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `Vehicle_Expiry_Report_${todayStr}.xlsx`);
    return;
  }

  // Fallback to CSV if library is not yet loaded
  exportVehiclesCsv();
}

async function exportVehiclesCsv() {
  let allVehicles = (vehicles && vehicles.length > 0) ? vehicles : await db.getAllVehicles();
  if (!allVehicles || allVehicles.length === 0) {
    alert('No vehicle records to export.');
    return;
  }

  // Prepend UTF-8 BOM so Excel opens cleanly on Windows, Android & iOS
  let csv = '\uFEFFVehicle No,Reg Date,Fitness Upto,Insurance Upto,Tax Upto,Permit Upto,National Permit,PUCC Upto,GPS Remarks,Documents Count\n';

  allVehicles.forEach(v => {
    csv += `"${v.vehicleNo || ''}","${v.regDate || ''}","${v.fitnessUpto || ''}","${v.insuranceUpto || ''}","${v.taxUpto || ''}","${v.permitUpto || ''}","${v.nationalPermit || ''}","${v.pucc || ''}","${v.gps || ''}",${(v.files && v.files.length) || 0}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Vehicle_Expiry_Report_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ==================== EXCEL (.XLSX / .CSV) IMPORT ENGINE ====================
async function handleExcelImport(e) {
  const file = e.target.files?.[0];
  if (!file) return;

  if (typeof XLSX === 'undefined') {
    alert('Excel engine is still loading. Please try again in a few moments.');
    e.target.value = '';
    return;
  }

  try {
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: 'array', cellDates: true });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '' });

    if (!rows || rows.length === 0) {
      alert('No data rows found in the uploaded Excel file.');
      e.target.value = '';
      return;
    }

    function findVal(row, possibleNames) {
      const keys = Object.keys(row);
      for (const p of possibleNames) {
        const pClean = p.toLowerCase().replace(/[^a-z0-9]/g, '');
        for (const k of keys) {
          const kClean = k.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (kClean.includes(pClean)) {
            return row[k];
          }
        }
      }
      return '';
    }

    function parseExcelDate(val) {
      if (!val) return '';
      if (val instanceof Date) {
        if (isNaN(val.getTime())) return '';
        const y = val.getFullYear();
        const m = String(val.getMonth() + 1).padStart(2, '0');
        const d = String(val.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}T08:00`;
      }
      const str = String(val).trim();
      if (!str || str === '-') return '';

      const dateParts = str.split(' ')[0].split(/[-/]/);
      if (dateParts.length === 3) {
        if (dateParts[0].length === 4) {
          // YYYY-MM-DD
          return `${dateParts[0]}-${dateParts[1].padStart(2, '0')}-${dateParts[2].padStart(2, '0')}T08:00`;
        } else if (dateParts[2].length === 4) {
          // DD/MM/YYYY
          return `${dateParts[2]}-${dateParts[1].padStart(2, '0')}-${dateParts[0].padStart(2, '0')}T08:00`;
        }
      }

      const parsed = new Date(str);
      if (!isNaN(parsed.getTime())) {
        const y = parsed.getFullYear();
        const m = String(parsed.getMonth() + 1).padStart(2, '0');
        const d = String(parsed.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}T08:00`;
      }
      return '';
    }

    const importedVehicles = [];
    for (const r of rows) {
      const vNo = findVal(r, ['vehicleno', 'regno', 'vehicle number', 'registration', 'vno', 'vehicle']);
      if (!vNo) continue;

      const vehicleNo = String(vNo).trim().toUpperCase();
      const regDateRaw = findVal(r, ['regdate', 'registration date', 'reg date']);
      const fitnessRaw = findVal(r, ['fitness', 'fitnessexpiry', 'fitness upto']);
      const insuranceRaw = findVal(r, ['insurance', 'insuranceexpiry', 'insurance upto', 'ins upto']);
      const taxRaw = findVal(r, ['tax', 'taxexpiry', 'tax upto']);
      const permitRaw = findVal(r, ['permit', 'permitexpiry', 'permit upto']);
      const nationalPermitRaw = findVal(r, ['nationalpermit', 'national permit', 'np upto']);
      const puccRaw = findVal(r, ['pucc', 'puccexpiry', 'pucc upto', 'pollution']);
      const gpsRaw = findVal(r, ['gps', 'remarks', 'make', 'model', 'notes']);

      importedVehicles.push({
        vehicleNo,
        regDate: toDateInputValue(parseExcelDate(regDateRaw)),
        fitnessUpto: parseExcelDate(fitnessRaw),
        insuranceUpto: parseExcelDate(insuranceRaw),
        taxUpto: parseExcelDate(taxRaw),
        permitUpto: parseExcelDate(permitRaw),
        nationalPermit: parseExcelDate(nationalPermitRaw),
        pucc: parseExcelDate(puccRaw),
        gps: String(gpsRaw || '').trim(),
        files: []
      });
    }

    if (importedVehicles.length === 0) {
      alert('Could not find any vehicles with a valid vehicle number in this Excel file.\n\nPlease ensure your Excel column has a title like "Vehicle Number" or "Reg No".');
      e.target.value = '';
      return;
    }

    if (confirm(`Found ${importedVehicles.length} vehicles in Excel.\n\nImport them into your workspace now?`)) {
      for (const item of importedVehicles) {
        await db.saveVehicle(item);
      }
      await pushCurrentVehiclesToCloud();
      await loadVehicles();
      alert(`🎉 Successfully imported ${importedVehicles.length} vehicles from Excel!`);
    }
  } catch (err) {
    console.error('Excel Import Error:', err);
    alert('Error reading Excel file: ' + err.message);
  } finally {
    e.target.value = '';
  }
}

// ==================== CALENDAR VIEW ====================
let calendarViewMonth = new Date().getMonth();
let calendarViewYear = new Date().getFullYear();

function openCalendarModal() {
  calendarViewMonth = new Date().getMonth();
  calendarViewYear = new Date().getFullYear();
  renderCalendar();
  document.getElementById('calendarModal').classList.add('active');
}

function closeCalendarModal() {
  document.getElementById('calendarModal').classList.remove('active');
}

function renderCalendar() {
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('calMonthLabel').innerText = `${monthNames[calendarViewMonth]} ${calendarViewYear}`;

  const grid = document.getElementById('calendarGrid');
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html = dayNames.map(d => `<div class="cal-header-cell">${d}</div>`).join('');

  const firstDay = new Date(calendarViewYear, calendarViewMonth, 1).getDay();
  const daysInMonth = new Date(calendarViewYear, calendarViewMonth + 1, 0).getDate();
  const today = new Date();

  // Build expiry map for this month
  const expiryMap = {};
  vehicles.forEach(v => {
    DOC_FIELDS.forEach(f => {
      if (!f.isExpiry) return;
      const val = v[f.key];
      if (val) {
        const d = new Date(val);
        if (d.getMonth() === calendarViewMonth && d.getFullYear() === calendarViewYear) {
          const day = d.getDate();
          if (!expiryMap[day]) expiryMap[day] = [];
          expiryMap[day].push({
            vehicleNo: v.vehicleNo,
            vehicleId: v.id,
            docLabel: f.label,
            date: d,
            status: getDocStatus(val).status
          });
        }
      }
    });
  });

  // Empty cells before first day
  for (let i = 0; i < firstDay; i++) {
    html += '<div class="cal-day empty"></div>';
  }

  // Day cells
  for (let day = 1; day <= daysInMonth; day++) {
    const isToday = day === today.getDate() && calendarViewMonth === today.getMonth() && calendarViewYear === today.getFullYear();
    const events = expiryMap[day] || [];
    const hasExpired = events.some(e => e.status === 'expired');
    const hasExpiringCritical = events.some(e => e.status === 'expiring-critical');
    const hasExpiring = events.some(e => e.status === 'expiring');

    let classes = 'cal-day';
    if (isToday) classes += ' today';
    if (hasExpired) classes += ' has-expired';
    else if (hasExpiringCritical) classes += ' has-expiring-critical';
    else if (hasExpiring) classes += ' has-expiring';

    let dots = '';
    if (events.length > 0) {
      dots = '<div class="cal-dot-row">';
      events.slice(0, 4).forEach(e => {
        let dotClass = 'yellow';
        if (e.status === 'expired') dotClass = 'red';
        else if (e.status === 'expiring-critical') dotClass = 'orange';
        dots += `<span class="cal-dot ${dotClass}"></span>`;
      });
      dots += '</div>';
    }

    html += `<div class="${classes}" onclick="showCalDayDetails(${day})">${day}${dots}</div>`;
  }

  grid.innerHTML = html;
  document.getElementById('calDayDetails').innerHTML = '';
}

function showCalDayDetails(day) {
  const container = document.getElementById('calDayDetails');
  const events = [];

  vehicles.forEach(v => {
    DOC_FIELDS.forEach(f => {
      const val = v[f.key];
      if (val) {
        const d = new Date(val);
        if (d.getDate() === day && d.getMonth() === calendarViewMonth && d.getFullYear() === calendarViewYear) {
          events.push({
            vehicleNo: v.vehicleNo,
            vehicleId: v.id,
            docLabel: f.label,
            status: getDocStatus(val).status
          });
        }
      }
    });
  });

  if (events.length === 0) {
    container.innerHTML = `<p style="text-align: center; color: var(--text-muted); padding: 0.5rem;">No expiry events on this day.</p>`;
    return;
  }

  let html = `<h4 style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.5rem;">Expiries on Day ${day}:</h4>`;
  events.forEach(e => {
    let color = 'var(--success)';
    let statusLabel = 'Valid';
    if (e.status === 'expired') { color = 'var(--danger)'; statusLabel = '🔴 Expired'; }
    else if (e.status === 'expiring-critical') { color = 'var(--warning-dark)'; statusLabel = '🟠 Exp. in 10d'; }
    else if (e.status === 'expiring') { color = 'var(--warning)'; statusLabel = '🟡 Expiring Soon'; }

    html += `
      <div class="cal-detail-item">
        <div class="cal-vehicle">${e.vehicleNo}</div>
        <div class="cal-doc" style="color: ${color}; font-weight: 600;">${e.docLabel} - ${statusLabel}</div>
      </div>
    `;
  });
  container.innerHTML = html;
}

/// PDF.js Engine Configuration & Helpers
function initPdfjs() {
  const lib = typeof pdfjsLib !== 'undefined' ? pdfjsLib : ((typeof window !== 'undefined' && window.pdfjsLib) || (typeof window !== 'undefined' && window['pdfjs-dist/build/pdf']));
  if (lib) {
    if (!lib.GlobalWorkerOptions.workerSrc || lib.GlobalWorkerOptions.workerSrc.includes('cdnjs')) {
      lib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';
    }
    return lib;
  }
  return null;
}

// Convert base64 data to Uint8Array for binary-safe PDF parsing
function getPdfDataBytes(pdfSource) {
  if (typeof pdfSource === 'string' && (pdfSource.startsWith('data:') || pdfSource.includes(';base64,'))) {
    try {
      const commaIdx = pdfSource.indexOf(',');
      const base64Data = commaIdx !== -1 ? pdfSource.substring(commaIdx + 1) : pdfSource;
      const binaryString = window.atob(base64Data.trim());
      const len = binaryString.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes;
    } catch (e) {
      console.warn('Error decoding base64 PDF bytes:', e);
    }
  }
  return null;
}

// Create a Blob URL from PDF source (safe for opening in new tabs and downloading without data URL restrictions)
function getPdfBlobUrl(pdfSource) {
  if (typeof pdfSource === 'string' && (pdfSource.startsWith('data:') || pdfSource.includes(';base64,'))) {
    try {
      const bytes = getPdfDataBytes(pdfSource);
      if (bytes) {
        const blob = new Blob([bytes], { type: 'application/pdf' });
        return URL.createObjectURL(blob);
      }
    } catch (e) {
      console.warn('Failed to create PDF blob URL:', e);
    }
  }
  return pdfSource;
}

// Safely load a PDF document object using PDF.js
async function loadPdfDocument(pdfSource) {
  const lib = initPdfjs();
  if (!lib) {
    throw new Error('PDF.js library is loading. Please check internet connection.');
  }

  const bytes = getPdfDataBytes(pdfSource);
  if (bytes) {
    return await lib.getDocument({ data: bytes }).promise;
  }

  // If remote URL (e.g. Cloudinary)
  try {
    return await lib.getDocument(pdfSource).promise;
  } catch (err) {
    console.warn('Direct PDF URL load notice, trying arrayBuffer fetch:', err.message);
    const res = await fetch(pdfSource);
    const buf = await res.arrayBuffer();
    return await lib.getDocument({ data: new Uint8Array(buf) }).promise;
  }
}

// Image compression helper to speed up OCR and ensure clean canvas
async function compressImageForOcr(imageSrc, maxWidth = 1600) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        let width = img.width;
        let height = img.height;
        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch (e) {
        resolve(imageSrc);
      }
    };
    img.onerror = () => resolve(imageSrc);
    img.src = imageSrc;
  });
}

// Match Indian registration plates (e.g. KL-07-CD-1234, MH-12-AB-1234, DL-01-A-9999)
function detectVehicleNoFromText(text) {
  if (!text) return null;
  const regex = /\b([A-Z]{2}[-\s]?[0-9]{1,2}[-\s]?[A-Z]{1,3}[-\s]?[0-9]{4})\b/i;
  const match = regex.exec(text);
  if (match) {
    return match[1].toUpperCase().replace(/\s+/g, '-').replace(/--+/g, '-');
  }
  return null;
}

function detectDocumentTypeFromText(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes('certificate of registration') || (t.includes('owner name') && t.includes('chassis')) || t.includes('form 23') || t.includes('rc status')) return 'RC Book';
  if (t.includes('certificate of fitness') || t.includes('fitness certificate') || t.includes('form 38')) return 'Fitness Certificate';
  if (t.includes('insurance') || t.includes('policy schedule') || t.includes('certificate of insurance') || t.includes('motor vehicle insurance')) return 'Insurance Policy';
  if (t.includes('tax receipt') || t.includes('motor vehicle tax') || t.includes('mv tax') || t.includes('road tax')) return 'Tax Receipt';
  if (t.includes('national permit') || t.includes('goods carriage permit') || t.includes('all india tourist permit') || t.includes('form 48') || t.includes('permit certificate')) return 'Permit';
  if (t.includes('pollution') || t.includes('emission') || t.includes('pucc') || t.includes('puc certificate')) return 'PUCC';
  return null;
}

function extractDatesFromText(text, docType = '', fileName = '') {
  if (!text) return [];
  const dates = [];
  const addedSet = new Set();

  function addDate(day, month, year, raw, matchIndex) {
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      if (year >= 0 && year < 100) year += 2000;
      if (year >= 2000 && year <= 2045) {
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dateLabel = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
        if (!addedSet.has(dateStr)) {
          addedSet.add(dateStr);

          // Examine context (60 chars before and after) to guess the field
          const contextStart = Math.max(0, matchIndex - 60);
          const contextEnd = Math.min(text.length, matchIndex + 60);
          const contextSnippet = text.substring(contextStart, contextEnd);
          const suggestedField = guessFieldFromContext(contextSnippet, docType, fileName);

          dates.push({ dateStr, dateLabel, raw: raw.trim(), suggestedField });
        }
      }
    }
  }

  function guessFieldFromContext(snippet, dType, fName) {
    const s = (snippet || '').toLowerCase();
    if (s.includes('fitness') || s.includes('fc valid') || s.includes('fitness upto') || s.includes('fit upto') || s.includes('validity of fc')) return 'fitnessUpto';
    if (s.includes('insurance') || s.includes('policy period') || s.includes('insured upto') || s.includes('period of insurance') || s.includes('policy upto')) return 'insuranceUpto';
    if (s.includes('tax') || s.includes('mv tax') || s.includes('tax upto') || s.includes('tax paid upto') || s.includes('road tax')) return 'taxUpto';
    if (s.includes('national permit') || s.includes('np valid') || s.includes('auth valid') || s.includes('authorization upto')) return 'nationalPermit';
    if (s.includes('permit') || s.includes('carriage permit') || s.includes('permit upto') || s.includes('permit valid')) return 'permitUpto';
    if (s.includes('pucc') || s.includes('pollution') || s.includes('emission') || s.includes('puc upto') || s.includes('puc valid')) return 'pucc';
    if (s.includes('registration date') || s.includes('date of reg') || s.includes('regn date') || s.includes('reg. date')) return 'regDate';

    const fallback = `${dType || ''} ${fName || ''}`.toLowerCase();
    if (fallback.includes('fitness') || fallback.includes('fc')) return 'fitnessUpto';
    if (fallback.includes('insurance') || fallback.includes('policy')) return 'insuranceUpto';
    if (fallback.includes('tax')) return 'taxUpto';
    if (fallback.includes('national permit') || fallback.includes('np')) return 'nationalPermit';
    if (fallback.includes('permit')) return 'permitUpto';
    if (fallback.includes('pollution') || fallback.includes('pucc') || fallback.includes('emission')) return 'pucc';
    if (fallback.includes('rc') || fallback.includes('registration')) return 'regDate';
    return '';
  }

  const monthNames = { 
    'jan': 1, 'january': 1, 'feb': 2, 'february': 2, 'mar': 3, 'march': 3,
    'apr': 4, 'april': 4, 'may': 5, 'jun': 6, 'june': 6, 'jul': 7, 'july': 7,
    'aug': 8, 'august': 8, 'sep': 9, 'sept': 9, 'september': 9,
    'oct': 10, 'october': 10, 'nov': 11, 'november': 11, 'dec': 12, 'december': 12 
  };
  
  // Format 1: DD-MMM-YYYY or DD MMM YY (e.g. 14-Sep-2026, 14 Sep 26, 22/OCT/2025)
  const textMonthRegex1 = /\b(\d{1,2})[\/\-\.\s]+([a-zA-Z]{3,9})[\/\-\.\s]+(\d{2,4})\b/g;
  let match;
  while ((match = textMonthRegex1.exec(text)) !== null) {
    const day = parseInt(match[1]);
    const month = monthNames[match[2].toLowerCase().substring(0, 3)];
    const year = parseInt(match[3]);
    if (month) addDate(day, month, year, match[0], match.index);
  }

  // Format 1b: MMM DD, YYYY or MMM DD YYYY (e.g. Sep 14, 2026)
  const textMonthRegex2 = /\b([a-zA-Z]{3,9})[\s\.\-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s\.\-]+(\d{2,4})\b/g;
  while ((match = textMonthRegex2.exec(text)) !== null) {
    const month = monthNames[match[1].toLowerCase().substring(0, 3)];
    const day = parseInt(match[2]);
    const year = parseInt(match[3]);
    if (month) addDate(day, month, year, match[0], match.index);
  }

  // Format 2: Numeric DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY-MM-DD
  const numDateRegex = /\b(\d{1,4})[\/\-\.\\|\s]+(\d{1,2})[\/\-\.\\|\s]+(\d{2,4})\b/g;
  while ((match = numDateRegex.exec(text)) !== null) {
    let day = parseInt(match[1]);
    let month = parseInt(match[2]);
    let year = parseInt(match[3]);
    if (match[1].length === 4) {
      year = parseInt(match[1]);
      month = parseInt(match[2]);
      day = parseInt(match[3]);
    }
    addDate(day, month, year, match[0], match.index);
  }

  return dates;
}

// Scans a single file (PDF or Image) and returns extracted text, dates, document type, and vehicle number
async function scanSingleDocument(file, onProgress) {
  const fileSrc = file.url || file.data;
  if (!fileSrc) return { text: '', dates: [], docType: null, vehicleNo: null };

  const isPdf = isPdfFile(file, fileSrc);
  let extractedText = '';

  if (isPdf) {
    try {
      if (onProgress) onProgress(0.15, `Opening PDF (${file.name || 'Document'})...`);
      const pdf = await loadPdfDocument(fileSrc);
      const numPages = pdf.numPages;

      // Step 1: Fast direct digital text extraction (50ms)
      if (onProgress) onProgress(0.3, `Extracting digital text from ${numPages} page(s)...`);
      let digitalText = '';
      for (let p = 1; p <= numPages; p++) {
        const page = await pdf.getPage(p);
        const textContent = await page.getTextContent();
        const pageStr = textContent.items.map(item => item.str).join(' ');
        digitalText += `\n${pageStr}\n`;
      }

      if (digitalText.replace(/\s+/g, '').length >= 30) {
        console.log(`⚡ Instant Digital PDF text extracted from ${file.name} (${digitalText.length} chars)`);
        extractedText = digitalText;
      } else {
        // Step 2: Scanned image PDF fallback: Render pages to canvas and run Tesseract OCR
        console.log(`🖼️ Scanned image PDF detected for ${file.name}. Rendering pages for OCR...`);
        for (let p = 1; p <= numPages; p++) {
          if (onProgress) onProgress(0.3 + (p / numPages) * 0.65, `AI OCR reading page ${p} of ${numPages}...`);
          const page = await pdf.getPage(p);
          const viewport = page.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport }).promise;
          const pageImg = canvas.toDataURL('image/jpeg', 0.85);

          if (typeof Tesseract !== 'undefined') {
            const result = await Tesseract.recognize(pageImg, 'eng');
            extractedText += `\n${result.data.text}\n`;
          }
        }
      }
    } catch (pdfErr) {
      console.warn('PDF scan notice for', file.name, pdfErr);
    }
  } else {
    // Normal Image scanning (Camera photo, gallery image)
    if (typeof Tesseract === 'undefined') {
      throw new Error('AI OCR engine is loading. Please check internet connection.');
    }
    const compressed = await compressImageForOcr(fileSrc);
    const result = await Tesseract.recognize(compressed, 'eng', {
      logger: m => {
        if (m.status === 'recognizing text' && onProgress) {
          onProgress(0.2 + (m.progress * 0.75), `AI reading text: ${Math.round(m.progress * 100)}%`);
        }
      }
    });
    extractedText = result.data.text || '';
  }

  const docType = detectDocumentTypeFromText(extractedText);
  const dates = extractDatesFromText(extractedText, docType, file.name || '');
  const vehicleNo = detectVehicleNoFromText(extractedText);

  return { text: extractedText, dates, docType, vehicleNo };
}

// Global state for OCR workflow
let currentOcrScanMode = 'docManager'; // 'docManager' or 'form'
let currentOcrVehicle = null;
let currentDetectedVehicleNo = null;

async function runAiScanWorkflow(filesToScan, isFormMode = false, targetVehicle = null) {
  currentOcrScanMode = isFormMode ? 'form' : 'docManager';
  currentOcrVehicle = targetVehicle;
  currentDetectedVehicleNo = null;

  const validFiles = (filesToScan || []).filter(f => {
    const src = f.url || f.data || '';
    return isImageFile(f, src) || isPdfFile(f, src) || src.startsWith('http');
  });

  if (validFiles.length === 0) {
    alert('No scannable files found. AI scan supports photos and PDF documents.');
    return;
  }

  // Open OCR modal
  document.getElementById('ocrModal').classList.add('active');
  document.getElementById('ocrResults').style.display = 'none';
  document.getElementById('ocrStatus').style.display = 'block';

  const statusText = document.getElementById('ocrStatusText');
  const progressBar = document.getElementById('ocrProgressBar');
  if (statusText) statusText.innerText = 'Initializing AI Scanner...';
  if (progressBar) progressBar.style.width = '10%';

  let allExtractedDates = [];
  const totalFiles = validFiles.length;

  try {
    for (let i = 0; i < totalFiles; i++) {
      const file = validFiles[i];
      const startP = Math.round((i / totalFiles) * 100);
      if (progressBar) progressBar.style.width = `${Math.max(10, startP)}%`;
      if (statusText) statusText.innerText = `Scanning document ${i + 1} of ${totalFiles} (${file.name || 'File'})...`;

      const scanResult = await scanSingleDocument(file, (fraction, msg) => {
        const itemP = Math.round(((i + fraction) / totalFiles) * 100);
        if (progressBar) progressBar.style.width = `${itemP}%`;
        if (statusText && msg) statusText.innerText = `Doc ${i + 1}/${totalFiles}: ${msg}`;
      });

      if (!currentDetectedVehicleNo && scanResult.vehicleNo) {
        currentDetectedVehicleNo = scanResult.vehicleNo;
      }

      scanResult.dates.forEach(d => {
        let displayName = file.name || `Document ${i + 1}`;
        if (scanResult.docType) {
          displayName = `${scanResult.docType} (${displayName})`;
        } else if (file.category && file.category !== 'General') {
          displayName = `${file.category} (${displayName})`;
        }
        allExtractedDates.push({
          sourceName: displayName,
          ...d
        });
      });
    }

    if (progressBar) progressBar.style.width = '100%';
    showOcrResults(allExtractedDates, isFormMode, targetVehicle, currentDetectedVehicleNo);
  } catch (err) {
    console.error('AI Scan Error:', err);
    document.getElementById('ocrStatus').innerHTML = `
      <p style="color: var(--danger); font-weight: 700; font-size: 1rem;">❌ Scan Notice</p>
      <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.5rem;">${err.message}</p>
      <button class="secondary-btn" style="margin-top: 1rem;" onclick="document.getElementById('ocrModal').classList.remove('active')">Close</button>
    `;
  }
}

// AI Scan Trigger: Document Manager (existing vehicle)
async function ocrScanAllDocs() {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle || !vehicle.files || vehicle.files.length === 0) {
    alert('No documents to scan. Please upload photos or PDF files first.');
    return;
  }
  await runAiScanWorkflow(vehicle.files, false, vehicle);
}

// AI Scan Trigger: Vehicle Add/Edit Form (attached files before saving)
async function ocrScanFormAttachedFiles() {
  if (!tempAttachedFiles || tempAttachedFiles.length === 0) {
    alert('Please attach photos or PDF documents first.');
    return;
  }
  await runAiScanWorkflow(tempAttachedFiles, true, null);
}

function showOcrResults(extractedDates, isFormMode, vehicle, detectedVehicleNo) {
  document.getElementById('ocrStatus').style.display = 'none';
  const resultsDiv = document.getElementById('ocrResults');
  resultsDiv.style.display = 'block';

  let html = `
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.85rem;">
      <h4 style="font-weight: 800; font-size: 1.05rem; margin: 0; color: #fff;">✅ AI Scan Complete!</h4>
      <span style="font-size: 0.75rem; background: rgba(59, 130, 246, 0.15); color: var(--primary); padding: 2px 8px; border-radius: 12px; font-weight: 700;">${extractedDates.length} Date(s) Found</span>
    </div>
  `;

  if (detectedVehicleNo) {
    html += `
      <div style="background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.3); border-radius: 8px; padding: 0.65rem 0.85rem; margin-bottom: 0.85rem; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <span style="font-size: 0.72rem; color: var(--text-muted); display: block; font-weight: 600;">DETECTED REGISTRATION NO:</span>
          <span style="font-size: 1rem; font-weight: 800; color: var(--primary); letter-spacing: 0.5px;">${detectedVehicleNo}</span>
        </div>
        ${isFormMode ? `<label style="display: flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; font-weight: 600; cursor: pointer; color: #fff;"><input type="checkbox" id="ocrVehicleNoCheckbox" checked> Auto-fill No.</label>` : ''}
      </div>
    `;
  }

  if (extractedDates.length > 0) {
    html += `
      <p style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 0.75rem;">
        Review the detected dates below. The AI has pre-selected matching fields based on document text:
      </p>
      <div style="max-height: 52vh; overflow-y: auto; padding-right: 4px; display: flex; flex-direction: column; gap: 0.6rem;">
    `;

    extractedDates.forEach((d, idx) => {
      const suggested = d.suggestedField || '';
      html += `
        <div class="ocr-date-found" style="display: flex; flex-direction: column; gap: 0.4rem; padding: 0.65rem 0.8rem; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px;">
          <div style="font-size: 0.72rem; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(d.sourceName)}">
            📄 ${escapeHtml(d.sourceName)}
          </div>
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 0.5rem;">
            <div style="font-size: 0.95rem; font-weight: 800; color: var(--success); display: flex; align-items: center; gap: 0.35rem;">
              <span>📅</span> ${d.dateLabel}
            </div>
            <select class="ocr-field-select" data-date="${d.dateStr}" style="padding: 0.4rem 0.6rem; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-main); color: var(--text-main); font-size: 0.82rem; font-weight: 600; flex-shrink: 0; min-width: 140px;">
              <option value="">-- Ignore --</option>
              <option value="fitnessUpto" ${suggested === 'fitnessUpto' ? 'selected' : ''}>Fitness Upto</option>
              <option value="insuranceUpto" ${suggested === 'insuranceUpto' ? 'selected' : ''}>Insurance Upto</option>
              <option value="taxUpto" ${suggested === 'taxUpto' ? 'selected' : ''}>Tax Upto</option>
              <option value="permitUpto" ${suggested === 'permitUpto' ? 'selected' : ''}>Permit Upto</option>
              <option value="nationalPermit" ${suggested === 'nationalPermit' ? 'selected' : ''}>National Permit</option>
              <option value="pucc" ${suggested === 'pucc' ? 'selected' : ''}>PUCC Upto</option>
              <option value="regDate" ${suggested === 'regDate' ? 'selected' : ''}>Registration Date</option>
            </select>
          </div>
        </div>
      `;
    });

    html += `</div>`;

    if (isFormMode) {
      html += `
        <div style="margin-top: 1rem; display: flex; gap: 0.5rem;">
          <button type="button" class="secondary-btn" onclick="document.getElementById('ocrModal').classList.remove('active')" style="flex: 1; justify-content: center;">Cancel</button>
          <button type="button" class="primary-btn" onclick="applyOcrDatesToForm()" style="flex: 2; justify-content: center; font-weight: 800;">⚡ Apply to Vehicle Form</button>
        </div>
      `;
    } else {
      html += `
        <div style="margin-top: 1rem; display: flex; gap: 0.5rem;">
          <button type="button" class="secondary-btn" onclick="document.getElementById('ocrModal').classList.remove('active')" style="flex: 1; justify-content: center;">Cancel</button>
          <button type="button" class="primary-btn" onclick="saveAllOcrDates()" style="flex: 2; justify-content: center; font-weight: 800;">💾 Save Dates to Vehicle</button>
        </div>
      `;
    }
  } else {
    html += `
      <div style="text-align: center; padding: 1.5rem 0.5rem;">
        <p style="color: var(--warning); font-weight: 700; font-size: 1rem; margin-bottom: 0.35rem;">⚠️ No dates found</p>
        <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1.25rem;">
          Ensure the uploaded document contains clear text or valid date stamps (e.g. DD/MM/YYYY).
        </p>
        <button type="button" class="secondary-btn" onclick="document.getElementById('ocrModal').classList.remove('active')" style="margin: 0 auto;">Close</button>
      </div>
    `;
  }

  resultsDiv.innerHTML = html;
}

function applyOcrDatesToForm() {
  const selects = document.querySelectorAll('.ocr-field-select');
  let count = 0;

  selects.forEach(sel => {
    const fieldKey = sel.value;
    const dateStr = sel.getAttribute('data-date');
    if (fieldKey && dateStr) {
      const input = document.getElementById(fieldKey);
      if (input) {
        input.value = dateStr.split('T')[0];
        count++;
      }
    }
  });

  const vehCheckbox = document.getElementById('ocrVehicleNoCheckbox');
  if (vehCheckbox && vehCheckbox.checked && currentDetectedVehicleNo) {
    const vehInput = document.getElementById('vehicleNo');
    if (vehInput && (!vehInput.value || vehInput.value.trim() === '')) {
      vehInput.value = currentDetectedVehicleNo;
      count++;
    }
  }

  document.getElementById('ocrModal').classList.remove('active');
  if (count > 0) {
    alert(`✅ Successfully auto-filled ${count} field(s) into the form!`);
  } else {
    alert('No fields were selected to fill.');
  }
}

async function saveAllOcrDates() {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  const selects = document.querySelectorAll('.ocr-field-select');
  let updated = false;

  selects.forEach(select => {
    const fieldKey = select.value;
    const dateStr = select.getAttribute('data-date');
    if (fieldKey && dateStr) {
      vehicle[fieldKey] = formatExpiryDateWithDefaultTime(dateStr);
      updated = true;
    }
  });

  if (updated) {
    await db.saveVehicle(vehicle);
    await pushCurrentVehiclesToCloud();
    document.getElementById('ocrModal').classList.remove('active');
    closeDocManagerModal();
    await loadVehicles();
    alert('✅ All selected dates have been saved and synced to cloud!');
  } else {
    alert('⚠️ Please select at least one field to save.');
  }
}

// ==================== COMPANY CLOUD SYNC MODULE (FIREBASE REALTIME DB) ====================
const firebaseConfig = {
  apiKey: "AIzaSyDPQG7XrJiQlh5pJGVuEufI8ejiJ7oZqYw",
  authDomain: "vehicleex-85816.firebaseapp.com",
  databaseURL: "https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "vehicleex-85816",
  storageBucket: "vehicleex-85816.firebasestorage.app",
  messagingSenderId: "312893614750",
  appId: "1:312893614750:web:a80826ca6f741775dd698f",
  measurementId: "G-JFTKPXXF87"
};

let firebaseDb = null;
let firebaseListenerRef = null;
let currentCompanyName = localStorage.getItem('vehicleex_company_name') || '';
let currentSyncKey = localStorage.getItem('vehicleex_sync_key') || '';
let isSyncingFromCloud = false;

let currentAlertConfig = {
  enabled: false,
  phone: '',
  apiKey: '',
  noticeDays: 7,
  lastAlertDate: ''
};

let currentTelegramConfig = {
  enabled: false,
  botToken: '',
  chatId: '',
  noticeDays: 7,
  lastAlertDate: ''
};

function loadLocalAlertConfig() {
  if (!currentSyncKey) return;
  try {
    const savedWa = localStorage.getItem(`vehicleex_alert_config_${currentSyncKey}`);
    if (savedWa) {
      currentAlertConfig = { ...currentAlertConfig, ...JSON.parse(savedWa) };
    }
  } catch (e) {}

  try {
    const savedTg = localStorage.getItem(`vehicleex_tg_config_${currentSyncKey}`);
    if (savedTg) {
      currentTelegramConfig = { ...currentTelegramConfig, ...JSON.parse(savedTg) };
    }
  } catch (e) {}
}

function initFirebaseApp() {
  try {
    if (typeof firebase !== 'undefined' && !firebase.apps.length) {
      firebase.initializeApp(firebaseConfig);
    }
    if (typeof firebase !== 'undefined' && firebase.database) {
      firebaseDb = firebase.database();
    }
  } catch (e) {
    console.warn('Firebase init notice:', e.message);
  }
}

function initCompanySync() {
  initFirebaseApp();
  updateCompanyHeaderBadge();
  if (currentSyncKey) {
    loadLocalAlertConfig();
    listenToFirebaseWorkspace();
  }
}

function updateCompanyHeaderBadge() {
  const badgeText = document.getElementById('companyBadgeText');
  const loginBtn = document.getElementById('companyLoginBtn');
  if (currentSyncKey && currentCompanyName) {
    if (badgeText) badgeText.innerText = `🏢 ${currentCompanyName}`;
    if (loginBtn) {
      loginBtn.style.background = 'var(--primary)';
      loginBtn.style.color = '#fff';
      loginBtn.style.borderColor = 'var(--primary)';
    }
  } else {
    if (badgeText) badgeText.innerText = `🏢 Company Sync`;
    if (loginBtn) {
      loginBtn.style.background = 'var(--bg-card)';
      loginBtn.style.color = 'var(--text-main)';
      loginBtn.style.borderColor = 'var(--border-color)';
    }
  }
}

function openCompanyModal() {
  const activeView = document.getElementById('companyActiveView');
  const setupView = document.getElementById('companySetupView');
  const backBtn = document.getElementById('backToActiveWsBtn');

  if (currentSyncKey) {
    // Already connected to a company! Show Dashboard View
    if (activeView) activeView.style.display = 'block';
    if (setupView) setupView.style.display = 'none';
    if (backBtn) backBtn.style.display = 'none';

    const nameEl = document.getElementById('activeCompanyName');
    const keyEl = document.getElementById('activeSyncKey');
    const countEl = document.getElementById('activeWsVehicleCount');

    if (nameEl) nameEl.textContent = currentCompanyName || 'Company Workspace';
    if (keyEl) keyEl.textContent = currentSyncKey;
    if (countEl) countEl.textContent = Array.isArray(vehicles) ? vehicles.length : '0';

    loadLocalAlertConfig();
    renderWaAlertUI();
    renderTgAlertUI();

    // Refresh alert configs from cloud in background
    fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/workspaces/${currentSyncKey}.json`)
      .then(res => res.json())
      .then(wsData => {
        if (wsData && typeof wsData === 'object') {
          if (wsData.alertConfig) {
            currentAlertConfig = { ...currentAlertConfig, ...wsData.alertConfig };
            localStorage.setItem(`vehicleex_alert_config_${currentSyncKey}`, JSON.stringify(currentAlertConfig));
            renderWaAlertUI();
          }
          if (wsData.telegramConfig) {
            currentTelegramConfig = { ...currentTelegramConfig, ...wsData.telegramConfig };
            localStorage.setItem(`vehicleex_tg_config_${currentSyncKey}`, JSON.stringify(currentTelegramConfig));
            renderTgAlertUI();
          }
        }
      })
      .catch(() => {});
  } else {
    // Not connected: Show Create/Join tabs
    if (activeView) activeView.style.display = 'none';
    if (setupView) setupView.style.display = 'block';
    if (backBtn) backBtn.style.display = 'none';
    switchCompanyTab('create');
  }

  const modal = document.getElementById('companyModal');
  if (modal) modal.classList.add('active');
}

function showCompanySwitchView() {
  const activeView = document.getElementById('companyActiveView');
  const setupView = document.getElementById('companySetupView');
  const backBtn = document.getElementById('backToActiveWsBtn');

  if (activeView) activeView.style.display = 'none';
  if (setupView) setupView.style.display = 'block';
  if (backBtn) backBtn.style.display = currentSyncKey ? 'block' : 'none';
  switchCompanyTab('create');
}

function switchCompanyTab(tab) {
  const tabCreate = document.getElementById('tabCreateCompany');
  const tabJoin = document.getElementById('tabJoinCompany');
  const paneCreate = document.getElementById('companyCreateTabContent');
  const paneJoin = document.getElementById('companyJoinTabContent');

  if (tab === 'join') {
    if (tabCreate) tabCreate.classList.remove('active');
    if (tabJoin) tabJoin.classList.add('active');
    if (paneCreate) paneCreate.style.display = 'none';
    if (paneJoin) paneJoin.style.display = 'block';
  } else {
    if (tabCreate) tabCreate.classList.add('active');
    if (tabJoin) tabJoin.classList.remove('active');
    if (paneCreate) paneCreate.style.display = 'block';
    if (paneJoin) paneJoin.style.display = 'none';
  }
}

function closeCompanyModal() {
  const modal = document.getElementById('companyModal');
  if (modal) modal.classList.remove('active');
}

function copySyncKey(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  if (currentSyncKey) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(currentSyncKey).then(() => {
        alert(`📋 Sync Key Copied to Clipboard!\n\nKey: ${currentSyncKey}\n\nShare this key with staff to join ${currentCompanyName || 'Workspace'}.`);
      }).catch(() => {
        prompt('Copy your Workspace Sync Key:', currentSyncKey);
      });
    } else {
      prompt('Copy your Workspace Sync Key:', currentSyncKey);
    }
  }
}

function shareSyncKeyWhatsApp() {
  if (currentSyncKey) {
    const text = `🏢 Join our Company Vehicle Workspace in VehicleEx Pro!\n\nCompany: ${currentCompanyName || 'Company Workspace'}\nSync Key: ${currentSyncKey}\n\nOpen app & paste this key in Company Sync: https://metro-vehicle.web.app/`;
    const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  }
}

function sanitizeForCloud(data) {
  return JSON.parse(JSON.stringify(data, (key, value) => {
    return value === undefined ? null : value;
  }));
}

function getLightVehicles(vehicles) {
  if (!Array.isArray(vehicles)) return [];
  return vehicles.map(v => {
    const light = { ...v };
    light.vehicleNo = light.vehicleNo ? String(light.vehicleNo).trim().toUpperCase() : '';
    light.regDate = light.regDate || '';
    light.fitnessUpto = light.fitnessUpto || '';
    light.insuranceUpto = light.insuranceUpto || '';
    light.taxUpto = light.taxUpto || '';
    light.permitUpto = light.permitUpto || '';
    light.nationalPermit = light.nationalPermit || '';
    light.pucc = light.pucc || '';
    light.gps = light.gps || '';

    if (light.files && Array.isArray(light.files)) {
      light.files = light.files.map(f => {
        const cloudUrl = (f.url && f.url.startsWith('http')) ? f.url 
          : ((f.data && f.data.startsWith('http')) ? f.data : (f.url || f.data || ''));
        return {
          id: f.id || 'f_' + Date.now() + '_' + Math.random().toString(36).substr(2, 4),
          name: f.name || 'Document',
          type: f.type || 'image/jpeg',
          size: f.size || 0,
          category: f.category || 'Document',
          url: cloudUrl,
          data: cloudUrl
        };
      });
    } else {
      light.files = [];
    }
    return light;
  });
}

function generateSyncKey(companyName) {
  const prefix = companyName.replace(/[^A-Za-z0-9]/g, '').substring(0, 6).toUpperCase() || 'FLEET';
  const randNum = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${randNum}`;
}

async function handleCreateCompanySubmit(e) {
  e.preventDefault();
  const input = document.getElementById('createCompanyNameInput');
  const companyName = input ? input.value.trim() : '';

  if (!companyName) {
    alert('Please enter a Company or Fleet Name.');
    return;
  }

  initFirebaseApp();
  const syncKey = generateSyncKey(companyName);
  currentSyncKey = syncKey;
  currentCompanyName = companyName;

  try {
    const allLocalVehicles = await db.getAllVehicles();
    const lightVehicles = getLightVehicles(allLocalVehicles);

    const payload = sanitizeForCloud({
      name: currentCompanyName,
      vehicles: lightVehicles,
      createdAt: new Date().toISOString()
    });

    await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/workspaces/${currentSyncKey}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    localStorage.setItem('vehicleex_company_name', currentCompanyName);
    localStorage.setItem('vehicleex_sync_key', currentSyncKey);

    updateCompanyHeaderBadge();
    listenToFirebaseWorkspace();
    openCompanyModal();

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(currentSyncKey).catch(() => {});
    }

    alert(`🎉 Company Workspace Created!\n\n🏢 Company: ${currentCompanyName}\n🔑 Sync Key: ${currentSyncKey}\n\n(Sync Key copied to clipboard! Share this key with your staff.)`);
  } catch (err) {
    console.error('Create Company Error:', err);
    alert('⚠️ Error creating company workspace: ' + err.message);
  }
}

async function handleJoinCompanySubmit(e) {
  e.preventDefault();
  const keyInput = document.getElementById('joinSyncKeyInput');
  const nameInput = document.getElementById('joinCompanyNameInput');
  const syncKey = keyInput ? keyInput.value.trim().toUpperCase() : '';
  const optionalName = nameInput ? nameInput.value.trim() : '';

  if (!syncKey) {
    alert('Please enter a Workspace Sync Key.');
    return;
  }

  initFirebaseApp();

  try {
    const res = await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/workspaces/${syncKey}.json`);
    const data = await res.json();

    if (!data) {
      alert(`⚠️ Workspace with key "${syncKey}" not found.\n\nPlease check the Sync Key with your company admin.`);
      return;
    }

    currentSyncKey = syncKey;
    currentCompanyName = data.name || optionalName || syncKey;

    localStorage.setItem('vehicleex_company_name', currentCompanyName);
    localStorage.setItem('vehicleex_sync_key', currentSyncKey);

    updateCompanyHeaderBadge();

    if (Array.isArray(data.vehicles)) {
      isSyncingFromCloud = true;
      try {
        await db.clearAll();
        for (const cv of data.vehicles) {
          await db.saveVehicle(cv, true);
        }
        await loadVehicles();
      } finally {
        isSyncingFromCloud = false;
      }
    }

    listenToFirebaseWorkspace();
    openCompanyModal();

    alert(`✅ Connected to "${currentCompanyName}"!\n\n${data.vehicles ? data.vehicles.length : 0} vehicles synced from cloud.`);
  } catch (err) {
    console.error('Join Workspace Error:', err);
    alert('⚠️ Error joining workspace: ' + err.message);
  }
}

async function handleCompanyFormSubmit(e) {
  // Backwards compatibility alias
  return handleCreateCompanySubmit(e);
}

async function mergeCloudVehicles(cloudVehicles) {
  if (!Array.isArray(cloudVehicles)) return;
  isSyncingFromCloud = true;
  try {
    const localVehicles = await db.getAllVehicles();
    const localMap = new Map();
    localVehicles.forEach(v => {
      const key = v.vehicleNo ? v.vehicleNo.trim().toUpperCase() : String(v.id);
      localMap.set(key, v);
    });

    const cloudKeySet = new Set();

    for (const cv of cloudVehicles) {
      const key = cv.vehicleNo ? cv.vehicleNo.trim().toUpperCase() : String(cv.id);
      cloudKeySet.add(key);

      const existingLocal = localMap.get(key);
      if (existingLocal) {
        cv.id = existingLocal.id;
      } else {
        delete cv.id;
      }
      cv.files = Array.isArray(cv.files) ? cv.files : [];
      await db.saveVehicle(cv, true);
    }

    // Synchronize vehicle deletions: remove local vehicles that were deleted from cloud
    for (const [key, lv] of localMap.entries()) {
      if (!cloudKeySet.has(key)) {
        await db.deleteVehicle(lv.id, true);
      }
    }

    await loadVehicles();
    checkAndAutoSendDailyAlerts();

    // If Document Manager Modal is currently open for a vehicle, re-render its document list live!
    const docModal = document.getElementById('docManagerModal');
    if (docModal && docModal.classList.contains('active') && currentDocManagerVehicleId) {
      const activeDocVehicle = await db.getVehicle(currentDocManagerVehicleId);
      if (activeDocVehicle) {
        renderDocList(activeDocVehicle);
      } else {
        closeDocManagerModal();
      }
    }
  } catch (err) {
    console.error('Merge Cloud Vehicles Error:', err);
  } finally {
    isSyncingFromCloud = false;
  }
}

function listenToFirebaseWorkspace() {
  if (!currentSyncKey) return;
  initFirebaseApp();

  try {
    if (firebaseDb) {
      if (firebaseListenerRef) firebaseListenerRef.off();
      firebaseListenerRef = firebaseDb.ref('workspaces/' + currentSyncKey);
      firebaseListenerRef.on('value', async (snapshot) => {
        const val = snapshot.val();
        if (val && !isSyncingFromCloud) {
          if (val.alertConfig && typeof val.alertConfig === 'object') {
            currentAlertConfig = { ...currentAlertConfig, ...val.alertConfig };
            localStorage.setItem(`vehicleex_alert_config_${currentSyncKey}`, JSON.stringify(currentAlertConfig));
            renderWaAlertUI();
          }
          if (val.telegramConfig && typeof val.telegramConfig === 'object') {
            currentTelegramConfig = { ...currentTelegramConfig, ...val.telegramConfig };
            localStorage.setItem(`vehicleex_tg_config_${currentSyncKey}`, JSON.stringify(currentTelegramConfig));
            renderTgAlertUI();
          }
          const cloudList = Array.isArray(val.vehicles) ? val.vehicles : [];
          await mergeCloudVehicles(cloudList);
        }
      });
      return;
    }
  } catch (err) {
    console.warn('Realtime listener fallback to fetch:', err);
  }

  // REST fallback
  fetchLatestCloudVehicles();
}

async function fetchLatestCloudVehicles() {
  if (!currentSyncKey || isSyncingFromCloud) return;
  try {
    const res = await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/workspaces/${currentSyncKey}.json`);
    const val = await res.json();
    if (val && !isSyncingFromCloud) {
      if (val.alertConfig && typeof val.alertConfig === 'object') {
        currentAlertConfig = { ...currentAlertConfig, ...val.alertConfig };
        localStorage.setItem(`vehicleex_alert_config_${currentSyncKey}`, JSON.stringify(currentAlertConfig));
        renderWaAlertUI();
      }
      if (val.telegramConfig && typeof val.telegramConfig === 'object') {
        currentTelegramConfig = { ...currentTelegramConfig, ...val.telegramConfig };
        localStorage.setItem(`vehicleex_tg_config_${currentSyncKey}`, JSON.stringify(currentTelegramConfig));
        renderTgAlertUI();
      }
      const cloudList = Array.isArray(val.vehicles) ? val.vehicles : [];
      await mergeCloudVehicles(cloudList);
    }
  } catch (err) {
    console.warn('Sync Fetch Notice:', err.message);
  }
}

async function pushCurrentVehiclesToCloud() {
  if (!currentSyncKey) {
    return;
  }
  if (isSyncingFromCloud) {
    console.warn('☁️ Cloud push postponed: currently syncing latest cloud data.');
    return;
  }
  try {
    const allVehicles = await db.getAllVehicles();
    const lightVehicles = getLightVehicles(allVehicles);
    const payload = sanitizeForCloud({
      name: currentCompanyName || 'Company Workspace',
      vehicles: lightVehicles,
      alertConfig: currentAlertConfig || null,
      telegramConfig: currentTelegramConfig || null,
      updatedAt: new Date().toISOString()
    });

    // 1. Instant direct REST PUT - always reliable
    await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/workspaces/${currentSyncKey}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    // 2. Realtime DB SDK update
    if (firebaseDb) {
      try {
        await firebaseDb.ref('workspaces/' + currentSyncKey).set(payload);
      } catch (sdkErr) {
        console.warn('Firebase RTDB SDK sync notice:', sdkErr.message);
      }
    }
    console.log(`☁️ Cloud Workspace (${currentSyncKey}) updated with ${lightVehicles.length} vehicles.`);
  } catch (err) {
    console.error('Cloud Push Error:', err.message);
  }
}

async function manualSyncRefresh() {
  if (!currentSyncKey) {
    alert('Please connect to a Company Workspace first.');
    return;
  }
  await fetchLatestCloudVehicles();
  alert('🔄 Sync refreshed! Latest data loaded from cloud.');
}

async function syncLocalVehiclesToCompany() {
  if (!currentSyncKey) {
    alert('Please connect to a Company Workspace first.');
    return;
  }
  await pushCurrentVehiclesToCloud();
  alert(`✅ Local vehicles successfully pushed to Cloud Workspace (${currentCompanyName})!`);
}

function leaveCompanyWorkspace() {
  if (confirm('Disconnect from Company Workspace? You will return to standalone local storage mode.')) {
    if (firebaseListenerRef) firebaseListenerRef.off();
    currentCompanyName = '';
    currentSyncKey = '';
    currentAlertConfig = { enabled: false, phone: '', apiKey: '', noticeDays: 7, lastAlertDate: '' };
    currentTelegramConfig = { enabled: false, botToken: '', chatId: '', noticeDays: 7, lastAlertDate: '' };
    localStorage.removeItem('vehicleex_company_name');
    localStorage.removeItem('vehicleex_sync_key');
    updateCompanyHeaderBadge();
    renderWaAlertUI();
    renderTgAlertUI();
    closeCompanyModal();
    alert('Disconnected from Company Workspace.');
  }
}

async function syncVehicleToCloud(vehicle) {
  if (!currentSyncKey || isSyncingFromCloud) return;
  await pushCurrentVehiclesToCloud();
}

async function deleteVehicleFromCloud(id) {
  if (!currentSyncKey || isSyncingFromCloud) return;
  await pushCurrentVehiclesToCloud();
}

// ==================== WHATSAPP DAILY EXPIRED / EXPIRING ALERTS ====================

function renderWaAlertUI() {
  const toggle = document.getElementById('waAlertsToggle');
  const body = document.getElementById('waConfigBody');
  const phone = document.getElementById('waAlertPhone');
  const apiKey = document.getElementById('waAlertApiKey');
  const noticeDays = document.getElementById('waAlertNoticeDays');
  const statusMsg = document.getElementById('waStatusMsg');

  if (toggle) toggle.checked = !!currentAlertConfig.enabled;
  if (body) body.style.display = currentAlertConfig.enabled ? 'block' : 'none';
  if (phone) phone.value = currentAlertConfig.phone || '';
  if (apiKey) apiKey.value = currentAlertConfig.apiKey || '';
  if (noticeDays) noticeDays.value = currentAlertConfig.noticeDays || 7;
  if (statusMsg) {
    statusMsg.style.display = 'none';
    statusMsg.textContent = '';
  }
}

function toggleWaAlerts(checked) {
  const body = document.getElementById('waConfigBody');
  if (body) body.style.display = checked ? 'block' : 'none';
  currentAlertConfig.enabled = !!checked;
}

async function saveWaAlertSettings() {
  if (!currentSyncKey) {
    alert('Please connect to a Company Workspace first.');
    return;
  }
  const isEnabled = document.getElementById('waAlertsToggle')?.checked || false;
  const phoneInput = document.getElementById('waAlertPhone')?.value.trim() || '';
  const apiKeyInput = document.getElementById('waAlertApiKey')?.value.trim() || '';
  const noticeDays = parseInt(document.getElementById('waAlertNoticeDays')?.value) || 7;
  const statusMsg = document.getElementById('waStatusMsg');

  if (isEnabled) {
    if (!phoneInput) {
      alert('Please enter Manager\'s WhatsApp Phone Number (with Country Code).\nExample: +919876543210');
      return;
    }
    if (!apiKeyInput) {
      alert('Please enter your CallMeBot Free WhatsApp API Key.\n\nClick "1-Click Get Key" to receive it on WhatsApp in 30 seconds.');
      return;
    }
  }

  currentAlertConfig = {
    enabled: isEnabled,
    phone: phoneInput,
    apiKey: apiKeyInput,
    noticeDays: noticeDays,
    lastAlertDate: currentAlertConfig.lastAlertDate || ''
  };

  localStorage.setItem(`vehicleex_alert_config_${currentSyncKey}`, JSON.stringify(currentAlertConfig));

  if (statusMsg) {
    statusMsg.style.display = 'block';
    statusMsg.className = 'ws-wa-status-msg info';
    statusMsg.textContent = 'Saving settings to cloud...';
  }

  try {
    // 1. Save alertConfig inside workspace
    await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/workspaces/${currentSyncKey}/alertConfig.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentAlertConfig)
    });

    // 2. Register/unregister in alert_registry for daily cloud runner
    if (isEnabled) {
      await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/alert_registry/${currentSyncKey}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(true)
      });
    } else {
      await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/alert_registry/${currentSyncKey}.json`, {
        method: 'DELETE'
      });
    }

    if (statusMsg) {
      statusMsg.className = 'ws-wa-status-msg success';
      statusMsg.textContent = '✅ WhatsApp Alert settings saved successfully!';
      setTimeout(() => { if (statusMsg) statusMsg.style.display = 'none'; }, 4000);
    }
  } catch (err) {
    console.error('Error saving alert settings:', err);
    if (statusMsg) {
      statusMsg.className = 'ws-wa-status-msg error';
      statusMsg.textContent = '⚠️ Saved locally, cloud sync notice: ' + err.message;
    }
  }
}

async function sendCallMeBotMessage(phone, apiKey, text) {
  let cleanPhone = phone.replace(/[^0-9+]/g, '');
  if (cleanPhone.startsWith('+')) cleanPhone = cleanPhone.substring(1);
  const encodedText = encodeURIComponent(text);
  const url = `https://api.callmebot.com/whatsapp.php?phone=${cleanPhone}&text=${encodedText}&apikey=${apiKey}`;

  try {
    await fetch(url, { mode: 'no-cors' });
    return { success: true };
  } catch (err) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ success: true });
      img.onerror = () => resolve({ success: true });
      img.src = url;
      setTimeout(() => resolve({ success: true }), 3000);
    });
  }
}

async function sendTestWhatsAppAlert() {
  const phone = document.getElementById('waAlertPhone')?.value.trim();
  const apiKey = document.getElementById('waAlertApiKey')?.value.trim();
  const noticeDays = parseInt(document.getElementById('waAlertNoticeDays')?.value) || 7;
  const statusMsg = document.getElementById('waStatusMsg');

  if (!phone || !apiKey) {
    alert('Please enter both WhatsApp Phone Number and CallMeBot API Key to test.');
    return;
  }

  if (statusMsg) {
    statusMsg.style.display = 'block';
    statusMsg.className = 'ws-wa-status-msg info';
    statusMsg.textContent = '🚀 Sending test message to WhatsApp...';
  }

  const companyName = currentCompanyName || 'Fleet Workspace';
  const testMsg = `🔔 *Metro Vehicle App - Alert Test*\n\n` +
    `🏢 *Company:* ${companyName}\n` +
    `✅ *Status:* Connected Successfully!\n` +
    `⚙️ *Advance Notice:* ${noticeDays} days\n` +
    `📅 *Time:* ${new Date().toLocaleTimeString()}\n\n` +
    `You will receive daily automated vehicle expiry alerts on this WhatsApp number.\n\n` +
    `🌐 https://metro-vehicle.web.app`;

  try {
    await sendCallMeBotMessage(phone, apiKey, testMsg);
    if (statusMsg) {
      statusMsg.className = 'ws-wa-status-msg success';
      statusMsg.textContent = '✅ Test alert dispatched to WhatsApp! Please check your WhatsApp messages in a few seconds.';
    }
  } catch (err) {
    if (statusMsg) {
      statusMsg.className = 'ws-wa-status-msg error';
      statusMsg.textContent = '⚠️ Could not dispatch test alert: ' + err.message;
    }
  }
}

// ==================== ALERT CATEGORIZATION & FORMATTING HELPERS ====================

const ALERT_NUM_ICONS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

function getAlertNumIcon(idx) {
  return ALERT_NUM_ICONS[idx] || `${idx + 1}.`;
}

function categorizeVehicleAlerts(vehicleList, noticeDays = 7) {
  const expiredVehicles = [];
  const expiringVehicles = [];
  const now = new Date();
  const nowMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const vList = Array.isArray(vehicleList) ? vehicleList : [];

  vList.forEach(v => {
    const expiredDocs = [];
    const expiringDocs = [];

    DOC_FIELDS.forEach(f => {
      if (!f.isExpiry) return;
      const val = v[f.key];
      if (!val) return;

      const target = new Date(val);
      if (isNaN(target.getTime())) return;

      const targetMidnight = new Date(target.getFullYear(), target.getMonth(), target.getDate());
      const diffDays = Math.ceil((targetMidnight - nowMidnight) / (1000 * 60 * 60 * 24));
      const dateStr = target.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

      if (diffDays <= 0) {
        const daysAgo = Math.abs(diffDays);
        const statusText = daysAgo === 0 ? 'Expired Today' : `Expired ${daysAgo}d ago`;
        expiredDocs.push({
          key: f.key,
          label: f.label,
          diffDays,
          statusText,
          dateStr
        });
      } else if (diffDays <= noticeDays) {
        const statusText = diffDays === 1 ? 'Expires Tomorrow' : `Expires in ${diffDays}d`;
        expiringDocs.push({
          key: f.key,
          label: f.label,
          diffDays,
          statusText,
          dateStr
        });
      }
    });

    const regNo = v.vehicleNo || 'Unknown';
    const makeModel = [v.make, v.model].filter(Boolean).join(' ') || '';

    if (expiredDocs.length > 0) {
      expiredVehicles.push({
        regNo,
        makeModel,
        docs: expiredDocs
      });
    }

    if (expiringDocs.length > 0) {
      expiringVehicles.push({
        regNo,
        makeModel,
        docs: expiringDocs
      });
    }
  });

  return { expiredVehicles, expiringVehicles };
}

function buildWhatsAppAlertText(companyTitle, expiredVehicles, expiringVehicles, noticeDays) {
  const todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  let msg = `🚨 *VEHICLE EXPIRY ALERT* 🚨\n`;
  msg += `🏢 *Company:* ${companyTitle}\n`;
  msg += `📅 *Date:* ${todayStr}\n`;

  if (expiredVehicles.length > 0) {
    msg += `\n🔴 *EXPIRED DOCUMENTS (${expiredVehicles.length} Vehicles):*\n`;
    const slice = expiredVehicles.slice(0, 6);
    slice.forEach((item, idx) => {
      msg += `${getAlertNumIcon(idx)} *${item.regNo}*${item.makeModel ? ` (${item.makeModel})` : ''}\n`;
      item.docs.forEach(d => {
        msg += `   ❌ ${d.label}: *${d.statusText}* (${d.dateStr})\n`;
      });
      msg += `\n`;
    });
    if (expiredVehicles.length > 6) {
      msg += `   _...and ${expiredVehicles.length - 6} more expired vehicle(s)_\n\n`;
    }
  }

  if (expiringVehicles.length > 0) {
    msg += `🟡 *EXPIRING WITHIN ${noticeDays} DAYS (${expiringVehicles.length} Vehicles):*\n`;
    const slice = expiringVehicles.slice(0, 6);
    slice.forEach((item, idx) => {
      msg += `${getAlertNumIcon(idx)} *${item.regNo}*${item.makeModel ? ` (${item.makeModel})` : ''}\n`;
      item.docs.forEach(d => {
        msg += `   ⚠️ ${d.label}: *${d.statusText}* (${d.dateStr})\n`;
      });
      msg += `\n`;
    });
    if (expiringVehicles.length > 6) {
      msg += `   _...and ${expiringVehicles.length - 6} more expiring vehicle(s)_\n\n`;
    }
  }

  msg += `📱 _Please renew expired & upcoming documents on time._\n`;
  msg += `🌐 https://metro-vehicle.web.app`;
  return msg;
}

async function sendTodayExpiryAlertWhatsApp(isAutomated = false) {
  const phone = currentAlertConfig.phone || document.getElementById('waAlertPhone')?.value.trim();
  const apiKey = currentAlertConfig.apiKey || document.getElementById('waAlertApiKey')?.value.trim();
  const noticeDays = currentAlertConfig.noticeDays || parseInt(document.getElementById('waAlertNoticeDays')?.value) || 7;
  const statusMsg = document.getElementById('waStatusMsg');

  if (!phone || !apiKey) {
    if (!isAutomated) alert('Please configure and save your WhatsApp Phone Number and API Key first.');
    return;
  }

  const { expiredVehicles, expiringVehicles } = categorizeVehicleAlerts(vehicles, noticeDays);
  const totalAlertVehicles = expiredVehicles.length + expiringVehicles.length;

  if (totalAlertVehicles === 0) {
    if (!isAutomated) {
      if (statusMsg) {
        statusMsg.style.display = 'block';
        statusMsg.className = 'ws-wa-status-msg info';
        statusMsg.textContent = 'ℹ️ All vehicle documents are currently valid! No alerts to send today.';
      } else {
        alert('ℹ️ All vehicle documents are currently valid! No alerts to send today.');
      }
    }
    return;
  }

  if (statusMsg && !isAutomated) {
    statusMsg.style.display = 'block';
    statusMsg.className = 'ws-wa-status-msg info';
    statusMsg.textContent = `🚀 Preparing alert (${expiredVehicles.length} expired, ${expiringVehicles.length} expiring in ${noticeDays}d)...`;
  }

  const companyTitle = currentCompanyName || 'Fleet Workspace';
  const msg = buildWhatsAppAlertText(companyTitle, expiredVehicles, expiringVehicles, noticeDays);

  try {
    await sendCallMeBotMessage(phone, apiKey, msg);
    const todayIso = new Date().toISOString().split('T')[0];
    currentAlertConfig.lastAlertDate = todayIso;
    localStorage.setItem(`vehicleex_alert_config_${currentSyncKey}`, JSON.stringify(currentAlertConfig));

    if (statusMsg && !isAutomated) {
      statusMsg.className = 'ws-wa-status-msg success';
      statusMsg.textContent = `✅ Expiry alert (${expiredVehicles.length} expired, ${expiringVehicles.length} expiring) sent to WhatsApp!`;
    }
  } catch (err) {
    if (statusMsg && !isAutomated) {
      statusMsg.className = 'ws-wa-status-msg error';
      statusMsg.textContent = '⚠️ Error sending alert: ' + err.message;
    }
  }
}

// ==================== TELEGRAM DAILY EXPIRED / EXPIRING ALERTS ====================

function renderTgAlertUI() {
  const toggle = document.getElementById('tgAlertsToggle');
  const body = document.getElementById('tgConfigBody');
  const token = document.getElementById('tgBotToken');
  const chatId = document.getElementById('tgChatId');
  const noticeDays = document.getElementById('tgNoticeDays');
  const statusMsg = document.getElementById('tgStatusMsg');

  if (toggle) toggle.checked = !!currentTelegramConfig.enabled;
  if (body) body.style.display = currentTelegramConfig.enabled ? 'block' : 'none';
  if (token) token.value = currentTelegramConfig.botToken || '';
  if (chatId) chatId.value = currentTelegramConfig.chatId || '';
  if (noticeDays) noticeDays.value = currentTelegramConfig.noticeDays || 7;
  if (statusMsg) {
    statusMsg.style.display = 'none';
    statusMsg.textContent = '';
  }
}

function toggleTgAlerts(checked) {
  const body = document.getElementById('tgConfigBody');
  if (body) body.style.display = checked ? 'block' : 'none';
  currentTelegramConfig.enabled = !!checked;
}

async function autoDetectTelegramChatId() {
  const tokenInput = document.getElementById('tgBotToken');
  const botToken = tokenInput ? tokenInput.value.trim() : '';
  const statusMsg = document.getElementById('tgStatusMsg');

  if (!botToken) {
    alert('Please enter your Telegram Bot Token first.\n\nClick "1-Click @BotFather" to create a bot and get the HTTP API token.');
    return;
  }

  if (statusMsg) {
    statusMsg.style.display = 'block';
    statusMsg.className = 'ws-tg-status-msg info';
    statusMsg.textContent = '🔍 Connecting to Telegram to check for recent messages...';
  }

  try {
    // 1. Verify Bot Token
    const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
    const meData = await meRes.json();
    if (!meData.ok) {
      throw new Error('Invalid Bot Token! Please double-check the token from @BotFather.');
    }
    const botUser = meData.result.username;

    // 2. Fetch recent updates
    const updRes = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates`);
    const updData = await updRes.json();

    if (!updData.ok || !updData.result || updData.result.length === 0) {
      if (statusMsg) {
        statusMsg.className = 'ws-tg-status-msg error';
        statusMsg.innerHTML = `⚠️ No recent messages found!<br>1. Open your bot: <a href="https://t.me/${botUser}" target="_blank" style="color:#0088cc; font-weight:700;">@${botUser}</a> in Telegram.<br>2. Press <b>START</b> (or add it to your group and send a message).<br>3. Then click <b>'Auto-Detect'</b> again!`;
      }
      return;
    }

    // Get the most recent update
    const updates = updData.result;
    const lastUpdate = updates[updates.length - 1];
    const message = lastUpdate.message || lastUpdate.channel_post || lastUpdate.my_chat_member;

    if (!message || !message.chat) {
      throw new Error('Could not find chat information in recent messages.');
    }

    const chatId = message.chat.id;
    const chatTitle = message.chat.title || message.chat.first_name || 'Personal Chat';
    const isGroup = message.chat.type === 'group' || message.chat.type === 'supergroup';

    document.getElementById('tgChatId').value = chatId;
    currentTelegramConfig.chatId = String(chatId);

    if (statusMsg) {
      statusMsg.className = 'ws-tg-status-msg success';
      statusMsg.textContent = `✅ Successfully connected to ${isGroup ? 'Group' : 'User'}: "${chatTitle}" (Chat ID: ${chatId})! Click 'Save Settings' to save.`;
    }
  } catch (err) {
    if (statusMsg) {
      statusMsg.className = 'ws-tg-status-msg error';
      statusMsg.textContent = '⚠️ ' + err.message;
    }
  }
}

async function saveTgAlertSettings() {
  if (!currentSyncKey) {
    alert('Please connect to a Company Workspace first.');
    return;
  }
  const isEnabled = document.getElementById('tgAlertsToggle')?.checked || false;
  const tokenInput = document.getElementById('tgBotToken')?.value.trim() || '';
  const chatIdInput = document.getElementById('tgChatId')?.value.trim() || '';
  const noticeDays = parseInt(document.getElementById('tgNoticeDays')?.value) || 7;
  const statusMsg = document.getElementById('tgStatusMsg');

  if (isEnabled) {
    if (!tokenInput) {
      alert('Please enter your Telegram Bot Token.\n\nClick "1-Click @BotFather" to create a bot in Telegram.');
      return;
    }
    if (!chatIdInput) {
      alert('Please enter or Auto-Detect your Telegram Chat ID.\n\nTap START in your bot and click "Auto-Detect".');
      return;
    }
  }

  currentTelegramConfig = {
    enabled: isEnabled,
    botToken: tokenInput,
    chatId: chatIdInput,
    noticeDays: noticeDays,
    lastAlertDate: currentTelegramConfig.lastAlertDate || ''
  };

  localStorage.setItem(`vehicleex_tg_config_${currentSyncKey}`, JSON.stringify(currentTelegramConfig));

  if (statusMsg) {
    statusMsg.style.display = 'block';
    statusMsg.className = 'ws-tg-status-msg info';
    statusMsg.textContent = 'Saving settings to cloud...';
  }

  try {
    // 1. Save telegramConfig in workspace
    await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/workspaces/${currentSyncKey}/telegramConfig.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentTelegramConfig)
    });

    // 2. Register/unregister in alert_registry for daily cloud runner
    if (isEnabled || currentAlertConfig.enabled) {
      await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/alert_registry/${currentSyncKey}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(true)
      });
    } else {
      await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/alert_registry/${currentSyncKey}.json`, {
        method: 'DELETE'
      });
    }

    if (statusMsg) {
      statusMsg.className = 'ws-tg-status-msg success';
      statusMsg.textContent = '✅ Telegram Alert settings saved successfully!';
      setTimeout(() => { if (statusMsg) statusMsg.style.display = 'none'; }, 4000);
    }
  } catch (err) {
    console.error('Error saving Telegram alert settings:', err);
    if (statusMsg) {
      statusMsg.className = 'ws-tg-status-msg error';
      statusMsg.textContent = '⚠️ Saved locally, cloud sync notice: ' + err.message;
    }
  }
}

async function sendTestTelegramAlert() {
  const botToken = document.getElementById('tgBotToken')?.value.trim();
  const chatId = document.getElementById('tgChatId')?.value.trim();
  const noticeDays = parseInt(document.getElementById('tgNoticeDays')?.value) || 7;
  const statusMsg = document.getElementById('tgStatusMsg');

  if (!botToken || !chatId) {
    alert('Please enter both Bot Token and Chat ID to test.');
    return;
  }

  if (statusMsg) {
    statusMsg.style.display = 'block';
    statusMsg.className = 'ws-tg-status-msg info';
    statusMsg.textContent = '🚀 Sending test message to Telegram...';
  }

  const companyName = currentCompanyName || 'Fleet Workspace';
  const testMsg = `🔔 <b>Metro Vehicle App - Telegram Alert Test</b>\n\n` +
    `🏢 <b>Company:</b> ${escapeHtml(companyName)}\n` +
    `✅ <b>Status:</b> Connected Successfully!\n` +
    `⚙️ <b>Advance Notice:</b> ${noticeDays} days\n` +
    `📅 <b>Time:</b> ${new Date().toLocaleTimeString()}\n\n` +
    `Daily automated vehicle expiry alerts will be delivered here.\n\n` +
    `🌐 <a href="https://metro-vehicle.web.app">Open App</a>`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: testMsg,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.description || 'Failed to send message');
    }

    if (statusMsg) {
      statusMsg.className = 'ws-tg-status-msg success';
      statusMsg.textContent = '✅ Test alert delivered to Telegram! Check your Telegram messages.';
    }
  } catch (err) {
    if (statusMsg) {
      statusMsg.className = 'ws-tg-status-msg error';
      statusMsg.textContent = '⚠️ Could not dispatch test alert: ' + err.message;
    }
  }
}

function buildTelegramAlertHtml(companyTitle, expiredVehicles, expiringVehicles, noticeDays) {
  const todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  let msg = `🚨 <b>VEHICLE EXPIRY ALERT</b> 🚨\n`;
  msg += `🏢 <b>Company:</b> ${escapeHtml(companyTitle)}\n`;
  msg += `📅 <b>Date:</b> ${todayStr}\n`;

  if (expiredVehicles.length > 0) {
    msg += `\n🔴 <b>EXPIRED DOCUMENTS (${expiredVehicles.length} Vehicles):</b>\n`;
    const slice = expiredVehicles.slice(0, 10);
    slice.forEach((item, idx) => {
      msg += `${getAlertNumIcon(idx)} <b>${escapeHtml(item.regNo)}</b>${item.makeModel ? ` (${escapeHtml(item.makeModel)})` : ''}\n`;
      item.docs.forEach(d => {
        msg += `   ❌ ${escapeHtml(d.label)}: <b>${escapeHtml(d.statusText)}</b> (${escapeHtml(d.dateStr)})\n`;
      });
      msg += `\n`;
    });
    if (expiredVehicles.length > 10) {
      msg += `   <i>...and ${expiredVehicles.length - 10} more expired vehicle(s)</i>\n\n`;
    }
  }

  if (expiringVehicles.length > 0) {
    msg += `🟡 <b>EXPIRING WITHIN ${noticeDays} DAYS (${expiringVehicles.length} Vehicles):</b>\n`;
    const slice = expiringVehicles.slice(0, 10);
    slice.forEach((item, idx) => {
      msg += `${getAlertNumIcon(idx)} <b>${escapeHtml(item.regNo)}</b>${item.makeModel ? ` (${escapeHtml(item.makeModel)})` : ''}\n`;
      item.docs.forEach(d => {
        msg += `   ⚠️ ${escapeHtml(d.label)}: <b>${escapeHtml(d.statusText)}</b> (${escapeHtml(d.dateStr)})\n`;
      });
      msg += `\n`;
    });
    if (expiringVehicles.length > 10) {
      msg += `   <i>...and ${expiringVehicles.length - 10} more expiring vehicle(s)</i>\n\n`;
    }
  }

  msg += `📱 <i>Please renew expired & upcoming documents on time.</i>\n`;
  msg += `🌐 <a href="https://metro-vehicle.web.app">Open Metro Vehicle App</a>`;
  return msg;
}

async function sendTodayExpiryAlertTelegram(isAutomated = false) {
  const botToken = currentTelegramConfig.botToken || document.getElementById('tgBotToken')?.value.trim();
  const chatId = currentTelegramConfig.chatId || document.getElementById('tgChatId')?.value.trim();
  const noticeDays = currentTelegramConfig.noticeDays || parseInt(document.getElementById('tgNoticeDays')?.value) || 7;
  const statusMsg = document.getElementById('tgStatusMsg');

  if (!botToken || !chatId) {
    if (!isAutomated) alert('Please configure and save your Telegram Bot Token and Chat ID first.');
    return;
  }

  const { expiredVehicles, expiringVehicles } = categorizeVehicleAlerts(vehicles, noticeDays);
  const totalAlertVehicles = expiredVehicles.length + expiringVehicles.length;

  if (totalAlertVehicles === 0) {
    if (!isAutomated) {
      if (statusMsg) {
        statusMsg.style.display = 'block';
        statusMsg.className = 'ws-tg-status-msg info';
        statusMsg.textContent = 'ℹ️ All vehicle documents are currently valid! No alerts to send today.';
      } else {
        alert('ℹ️ All vehicle documents are currently valid! No alerts to send today.');
      }
    }
    return;
  }

  if (statusMsg && !isAutomated) {
    statusMsg.style.display = 'block';
    statusMsg.className = 'ws-tg-status-msg info';
    statusMsg.textContent = `🚀 Preparing alert (${expiredVehicles.length} expired, ${expiringVehicles.length} expiring in ${noticeDays}d)...`;
  }

  const companyTitle = currentCompanyName || 'Fleet Workspace';
  const msg = buildTelegramAlertHtml(companyTitle, expiredVehicles, expiringVehicles, noticeDays);

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const data = await res.json();
    if (!data.ok) {
      throw new Error(data.description || 'Failed to send message');
    }

    const todayIST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    currentTelegramConfig.lastAlertDate = todayIST;
    localStorage.setItem(`vehicleex_tg_config_${currentSyncKey}`, JSON.stringify(currentTelegramConfig));

    // Sync to Firebase RTDB so all devices and GitHub runner skip duplicate alerts
    if (currentSyncKey) {
      fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/workspaces/${currentSyncKey}/telegramConfig/lastAlertDate.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(todayIST)
      }).catch(() => {});
    }

    if (statusMsg && !isAutomated) {
      statusMsg.className = 'ws-tg-status-msg success';
      statusMsg.textContent = `✅ Expiry alert (${expiredVehicles.length} expired, ${expiringVehicles.length} expiring) delivered to Telegram!`;
    }
  } catch (err) {
    if (statusMsg && !isAutomated) {
      statusMsg.className = 'ws-tg-status-msg error';
      statusMsg.textContent = '⚠️ Error sending alert: ' + err.message;
    }
  }
}

let isCheckingDailyAlerts = false;
async function checkAndAutoSendDailyAlerts() {
  if (isCheckingDailyAlerts || !currentSyncKey) return;
  isCheckingDailyAlerts = true;
  try {
    const todayIST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
    const nowHourIST = parseInt(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }).format(new Date()), 10);

    // Auto-alert check: Trigger if 6:00 AM IST or later and alert not yet sent today
    if (nowHourIST >= 6) {
      if (currentTelegramConfig && currentTelegramConfig.enabled && currentTelegramConfig.botToken && currentTelegramConfig.chatId) {
        if (currentTelegramConfig.lastAlertDate !== todayIST) {
          console.log('⏰ Auto-triggering daily Telegram alert from in-app supervisor...');
          await sendTodayExpiryAlertTelegram(true);
        }
      }
    }
  } catch (err) {
    console.warn('Auto alert check notice:', err);
  } finally {
    isCheckingDailyAlerts = false;
  }
}




