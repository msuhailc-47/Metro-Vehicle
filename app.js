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

  async deleteVehicle(id) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('vehicles', 'readwrite');
      const store = tx.objectStore('vehicles');
      const request = store.delete(Number(id));
      request.onsuccess = () => {
        deleteVehicleFromCloud(id);
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
    await loadVehicles();
    setupEventListeners();
    setupNotifications();
    registerServiceWorker();
    initCompanySync();
  } catch (err) {
    console.error('App init failed:', err);
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
    navigator.serviceWorker.register('sw.js').catch(err => console.log('SW registration failed:', err));
  }
}

// Request Notification Permissions
function setupNotifications() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

// ==================== EXPIRY COMPUTATION ====================
function getDocStatus(dateStr) {
  if (!dateStr) return { status: 'none', label: '-', badgeClass: '' };
  
  const now = new Date();
  const target = new Date(dateStr);
  const diffTime = target - now;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (now >= target) {
    return { status: 'expired', label: `Expired (${Math.abs(diffDays)}d ago)`, badgeClass: 'expired' };
  } else if (diffDays <= 10) {
    return { status: 'expiring-critical', label: `Expires in ${diffDays}d`, badgeClass: 'expiring-critical' };
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
    let status = getOverallVehicleStatus(v);
    if (status === 'expired') expiredCount++;
    else if (status === 'expiring' || status === 'expiring-critical') expiringCount++;
    else validCount++;
  });

  document.getElementById('statTotal').innerText = total;
  document.getElementById('statExpired').innerText = expiredCount;
  document.getElementById('statExpiring').innerText = expiringCount;
  document.getElementById('statValid').innerText = validCount;
}

// ==================== RENDER VEHICLE CARDS ====================
function renderVehiclesList() {
  const container = document.getElementById('vehiclesGrid');
  const searchVal = document.getElementById('searchInput').value.trim().toLowerCase();

  const filtered = vehicles.filter(v => {
    // Filter by tab
    const overallStatus = getOverallVehicleStatus(v);
    if (activeFilter !== 'all' && overallStatus !== activeFilter) return false;

    // Filter by search
    if (searchVal) {
      const noMatch = v.vehicleNo.toLowerCase().includes(searchVal);
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
              <div class="v-number">${v.vehicleNo}</div>
            </div>
            ${overallBadge}
          </div>

          <div class="doc-status-grid">
    `;

    DOC_FIELDS.forEach(f => {
      const val = v[f.key];
      const st = f.isExpiry ? getDocStatus(val) : { status: 'none', label: '', badgeClass: '' };
      let dateDisplay = '-';
      if (val) {
        const d = new Date(val);
        dateDisplay = d.toLocaleDateString([], { month: 'short', day: 'numeric', year: '2-digit' });
      }

      html += `
        <div class="doc-chip">
          <span class="doc-label">${f.label}</span>
          <span class="doc-val">
            ${dateDisplay}
            ${(f.isExpiry && st.badgeClass) ? `<span class="status-badge ${st.badgeClass}" style="padding: 0.1rem 0.4rem; font-size: 0.65rem;">${st.status === 'expired' ? '🔴' : st.status === 'expiring-critical' ? '🟠' : st.status === 'expiring' ? '🟡' : '🟢'}</span>` : ''}
          </span>
        </div>
      `;
    });

    html += `
          </div>
          
          ${v.gps ? `<div style="font-size: 0.8rem; color: var(--text-muted); margin-bottom: 0.75rem;"><strong>GPS/Info:</strong> ${v.gps}</div>` : ''}
        </div>

        <div class="v-actions">
          <button onclick="openDocManagerModal(${v.id})" title="Manage Documents">
            📁 Docs (${attachedFilesCount})
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
  if (notifList.length > 0 && 'Notification' in window && Notification.permission === 'granted') {
    const expiredItems = notifList.filter(n => n.status === 'expired');
    if (expiredItems.length > 0) {
      new Notification('🚨 Vehicle Document Expired!', {
        body: expiredItems.map(i => i.message).slice(0, 3).join('\n'),
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="45" fill="%23ef4444"/></svg>'
      });
    }
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
  document.getElementById('exportDbBtn').addEventListener('click', exportDatabaseJson);
  document.getElementById('importDbBtn').addEventListener('click', () => {
    document.getElementById('importDbInput').click();
  });
  document.getElementById('importDbInput').addEventListener('change', importDatabaseJson);

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
function openVehicleModal(vehicleToEdit = null) {
  tempAttachedFiles = [];
  const form = document.getElementById('vehicleForm');
  form.reset();

  if (vehicleToEdit) {
    currentEditingVehicleId = vehicleToEdit.id;
    document.getElementById('vehicleModalTitle').innerText = 'Edit Vehicle Record';
    document.getElementById('vehicleNo').value = vehicleToEdit.vehicleNo;
    document.getElementById('regDate').value = vehicleToEdit.regDate || '';
    document.getElementById('fitnessUpto').value = vehicleToEdit.fitnessUpto || '';
    document.getElementById('insuranceUpto').value = vehicleToEdit.insuranceUpto || '';
    document.getElementById('taxUpto').value = vehicleToEdit.taxUpto || '';
    document.getElementById('permitUpto').value = vehicleToEdit.permitUpto || '';
    document.getElementById('nationalPermit').value = vehicleToEdit.nationalPermit || '';
    document.getElementById('pucc').value = vehicleToEdit.pucc || '';
    document.getElementById('gps').value = vehicleToEdit.gps || '';
    tempAttachedFiles = vehicleToEdit.files ? [...vehicleToEdit.files] : [];
  } else {
    currentEditingVehicleId = null;
    document.getElementById('vehicleModalTitle').innerText = 'Add Vehicle Record';
  }

  updateFormFileCountText();
  renderFormAttachedPreview();
  document.getElementById('vehicleModal').classList.add('active');
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

async function handleVehicleFormSubmit(e) {
  e.preventDefault();

  const vehicleNo = document.getElementById('vehicleNo').value.trim().toUpperCase();
  if (!vehicleNo) {
    alert('Please enter a vehicle number.');
    return;
  }

  const vehicleData = {
    vehicleNo,
    regDate: document.getElementById('regDate').value,
    fitnessUpto: document.getElementById('fitnessUpto').value,
    insuranceUpto: document.getElementById('insuranceUpto').value,
    taxUpto: document.getElementById('taxUpto').value,
    permitUpto: document.getElementById('permitUpto').value,
    nationalPermit: document.getElementById('nationalPermit').value,
    pucc: document.getElementById('pucc').value,
    gps: document.getElementById('gps').value.trim(),
    files: tempAttachedFiles
  };

  if (currentEditingVehicleId) {
    vehicleData.id = currentEditingVehicleId;
  }

  await db.saveVehicle(vehicleData);
  closeVehicleModal();
  await loadVehicles();
}

// File Input Handler (Multi-file Base64 conversion)
async function handleFileInputChange(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  if (tempAttachedFiles.length + files.length > 10) {
    alert(`You can attach up to 10 files. Currently have ${tempAttachedFiles.length}, trying to add ${files.length}.`);
    e.target.value = ''; // Reset so they can try again
    return;
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const base64 = await fileToBase64(file);
    tempAttachedFiles.push({
      id: 'f_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substr(2, 5),
      name: file.name,
      type: file.type,
      category: 'General',
      data: base64
    });
  }

  // CRITICAL: Reset input value so the same input can trigger 'change' again for subsequent uploads
  e.target.value = '';

  updateFormFileCountText();
  renderFormAttachedPreview();
}

function updateFormFileCountText() {
  const txt = document.getElementById('formFileCountText');
  if (tempAttachedFiles.length === 0) {
    txt.innerText = 'No files selected.';
  } else {
    txt.innerText = `${tempAttachedFiles.length} of 10 file(s) attached.`;
  }
}

// Render visual thumbnail preview grid with individual remove buttons
function renderFormAttachedPreview() {
  const container = document.getElementById('formAttachedPreview');
  if (!container) return;

  if (tempAttachedFiles.length === 0) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  tempAttachedFiles.forEach((f, idx) => {
    const isImage = (f.type && f.type.startsWith('image/')) || (f.data && f.data.startsWith('data:image/'));
    const thumbContent = isImage
      ? `<img src="${f.data}" style="width: 100%; height: 80px; object-fit: cover; border-radius: 6px;">`
      : `<div style="width: 100%; height: 80px; display: flex; align-items: center; justify-content: center; background: var(--bg-main); border-radius: 6px; font-size: 2rem;">📄</div>`;

    html += `
      <div style="position: relative; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: 8px; overflow: hidden; padding: 4px;">
        ${thumbContent}
        <div style="font-size: 0.7rem; padding: 2px 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-muted);">${f.name}</div>
        <button type="button" onclick="removeFormAttachedFile(${idx})" style="position: absolute; top: 4px; right: 4px; width: 34px; height: 34px; border-radius: 50%; background: #ef4444; color: #ffffff; border: 2px solid #ffffff; font-size: 1.1rem; font-weight: 800; cursor: pointer; display: flex; align-items: center; justify-content: center; line-height: 1; box-shadow: 0 2px 8px rgba(0,0,0,0.6); z-index: 20; touch-action: manipulation;" title="Remove this photo">✕</button>
      </div>
    `;
  });

  container.innerHTML = html;
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

function captureCameraSnapshot() {
  const video = document.getElementById('cameraVideo');
  const canvas = document.getElementById('cameraCanvas');
  const ctx = canvas.getContext('2d');

  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 480;

  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg', 0.85);

  const category = document.getElementById('cameraDocCategory').value || 'Captured';
  const fileName = `${category}_Scan_${Date.now()}.jpg`;

  tempAttachedFiles.push({
    id: 'f_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    name: fileName,
    type: 'image/jpeg',
    category: category,
    data: base64
  });

  updateFormFileCountText();
  renderFormAttachedPreview();
  closeCameraModal();
  alert(`📸 Snapshot added as ${fileName}`);
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
  loadVehicles(); // refresh UI
}

function renderDocList(vehicle) {
  const container = document.getElementById('docListContainer');
  if (!vehicle.files || vehicle.files.length === 0) {
    container.innerHTML = `<p style="color: var(--text-muted); text-align: center; padding: 1.5rem;">No documents attached yet.</p>`;
    return;
  }

  let html = '';
  vehicle.files.forEach((f, idx) => {
    const isImage = f.type.startsWith('image/') || f.data.startsWith('data:image/');
    const icon = isImage ? `<img src="${f.data}" class="doc-thumb">` : `<div class="doc-thumb">📄</div>`;

    html += `
      <div class="doc-item-row">
        ${icon}
        <div class="doc-details">
          <div class="doc-name">${f.name}</div>
          <div class="doc-meta">Category: <strong>${f.category || 'General'}</strong></div>
        </div>
        <div class="doc-item-actions">
          <button class="icon-btn" onclick="previewDocFile('${f.id}')" title="Preview">👁️</button>
          <button class="icon-btn" onclick="downloadSingleDoc('${f.id}')" title="Download">📥</button>
          <button class="icon-btn" onclick="shareDocFile('${f.id}')" title="Share (WhatsApp)">💬</button>
          <button class="icon-btn" onclick="renameDocCategory('${f.id}')" title="Rename Category">🏷️</button>
          <button class="icon-btn" onclick="deleteDocFile('${f.id}')" title="Delete">🗑️</button>
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
    const base64 = await fileToBase64(file);
    vehicle.files.push({
      id: 'f_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
      name: file.name,
      type: file.type,
      category: 'Uploaded',
      data: base64
    });
  }

  await db.saveVehicle(vehicle);
  input.value = '';
  renderDocList(vehicle);
}

async function handleExtraFileInputChange(e) {
  const files = e.target.files;
  if (!files || files.length === 0) return;

  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  if (!vehicle.files) vehicle.files = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const base64 = await fileToBase64(file);
    vehicle.files.push({
      id: 'f_' + Date.now() + '_' + i + '_' + Math.random().toString(36).substr(2, 5),
      name: file.name,
      type: file.type,
      category: 'Document',
      data: base64
    });
  }

  await db.saveVehicle(vehicle);
  e.target.value = '';
  renderDocList(vehicle);
}

async function deleteDocFile(fileId) {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  vehicle.files = vehicle.files.filter(f => f.id !== fileId);
  await db.saveVehicle(vehicle);
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
    renderDocList(vehicle);
  }
}

// Function to share document via WhatsApp / Web Share API
async function shareDocFile(fileId) {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  const fileObj = vehicle.files.find(f => f.id === fileId);
  if (!fileObj) return;

  const downloadFallback = () => {
    const a = document.createElement('a');
    a.href = fileObj.data;
    a.download = fileObj.name || `document_${fileId}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    alert("Since direct sharing is not supported on this network (needs HTTPS), the file has been downloaded. You can now share it from your gallery.");
  };

  if (!navigator.share) {
    downloadFallback();
    return;
  }

  try {
    // Convert base64 data to Blob/File object
    const res = await fetch(fileObj.data);
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
        text: `Vehicle Document: ${vehicle.vehicleNo} - ${fileObj.category || 'General'}`
      });
      alert("Your browser does not support attaching files directly. We shared the text, but the file will now be downloaded for you to share manually.");
      downloadFallback();
    }
  } catch (error) {
    console.error("Error sharing file:", error);
    if (error.name !== 'AbortError') {
      downloadFallback();
    }
  }
}



async function previewDocFile(fileId) {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  const fileObj = vehicle.files.find(f => f.id === fileId);
  if (!fileObj) return;

  const content = document.getElementById('lightboxContent');
  document.getElementById('lightboxTitle').innerText = fileObj.name;

  if (fileObj.type.startsWith('image/') || fileObj.data.startsWith('data:image/')) {
    content.innerHTML = `<img src="${fileObj.data}" style="max-width: 100%; max-height: 70vh; border-radius: 8px;">`;
  } else if (fileObj.type === 'application/pdf' || fileObj.data.startsWith('data:application/pdf')) {
    content.innerHTML = `<iframe src="${fileObj.data}" style="width: 100%; height: 70vh; border: none;"></iframe>`;
  } else {
    content.innerHTML = `<p style="color: #fff;">Preview not available for this file type. Click download instead.</p>`;
  }

  document.getElementById('lightboxModal').classList.add('active');
}

async function downloadSingleDoc(fileId) {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  const fileObj = vehicle.files.find(f => f.id === fileId);
  if (!fileObj) return;

  const a = document.createElement('a');
  a.href = fileObj.data;
  a.download = fileObj.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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

  vehicle.files.forEach(f => {
    // Extract base64 part
    const base64Data = f.data.split(',')[1];
    folder.file(f.name, base64Data, { base64: true });
  });

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
          alert('Database restored successfully!');
        }
      }
    } catch (err) {
      alert('Invalid backup JSON file.');
    }
  };
  reader.readAsText(file);
}

async function exportVehiclesCsv() {
  const allVehicles = await db.getAllVehicles();
  if (allVehicles.length === 0) {
    alert('No records to export.');
    return;
  }

  let csv = 'Vehicle No,Reg Date,Fitness Upto,Insurance Upto,Tax Upto,Permit Upto,National Permit,PUCC Upto,GPS Remarks,Documents Count\n';

  allVehicles.forEach(v => {
    csv += `"${v.vehicleNo}","${v.regDate || ''}","${v.fitnessUpto || ''}","${v.insuranceUpto || ''}","${v.taxUpto || ''}","${v.permitUpto || ''}","${v.nationalPermit || ''}","${v.pucc || ''}","${v.gps || ''}",${(v.files && v.files.length) || 0}\n`;
  });

  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `Vehicle_Expiry_Report_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
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

// PDF.js worker setup
if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
}

async function convertPdfToImages(pdfDataUri) {
  const base64Data = pdfDataUri.split(',')[1];
  const binaryString = window.atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const loadingTask = pdfjsLib.getDocument({ data: bytes });
  const pdf = await loadingTask.promise;
  const images = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    await page.render({ canvasContext: context, viewport: viewport }).promise;
    images.push(canvas.toDataURL('image/jpeg'));
  }
  return images;
}

// Image compression helper to speed up OCR
async function compressImageForOcr(base64Str, maxWidth = 1500) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
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
      
      resolve(canvas.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = reject;
    img.src = base64Str;
  });
}

// ==================== SMART OCR / AI SCANNER ====================
async function ocrScanAllDocs() {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle || !vehicle.files || vehicle.files.length === 0) {
    alert('No documents to scan. Please upload files first.');
    return;
  }

  const filesToScan = vehicle.files.filter(f =>
    (f.type && f.type.startsWith('image/')) || (f.data && f.data.startsWith('data:image/')) ||
    (f.type && f.type === 'application/pdf') || (f.data && f.data.startsWith('data:application/pdf'))
  );

  if (filesToScan.length === 0) {
    alert('No scannable files found. OCR works on photos/images and PDFs.');
    return;
  }

  // Show OCR modal
  document.getElementById('ocrModal').classList.add('active');
  document.getElementById('ocrResults').style.display = 'none';
  document.getElementById('ocrStatus').style.display = 'block';
  let allExtractedDates = [];
  const totalFiles = filesToScan.length;

  try {
    for (let i = 0; i < totalFiles; i++) {
      const file = filesToScan[i];
      const progress = Math.round(((i + 0.5) / totalFiles) * 100);
      document.getElementById('ocrProgressBar').style.width = progress + '%';

      let fileExtractedText = '';

      if (file.data.startsWith('data:application/pdf')) {
        const pdfImages = await convertPdfToImages(file.data);
        for (let p = 0; p < pdfImages.length; p++) {
          const result = await Tesseract.recognize(pdfImages[p], 'eng', {
            logger: m => {
              if (m.status === 'recognizing text') {
                const innerP = Math.round(((i + ((m.progress + p) / pdfImages.length)) / totalFiles) * 100);
                document.getElementById('ocrProgressBar').style.width = innerP + '%';
              }
            }
          });
          fileExtractedText += `\n${result.data.text}\n`;
        }
      } else if (file.data.startsWith('data:image/')) {
        // Compress image before OCR to speed up processing
        const compressedImage = await compressImageForOcr(file.data);
        const result = await Tesseract.recognize(compressedImage, 'eng', {
          logger: m => {
            if (m.status === 'recognizing text') {
              const p = Math.round(((i + m.progress) / totalFiles) * 100);
              document.getElementById('ocrProgressBar').style.width = p + '%';
            }
          }
        });
        fileExtractedText += `\n${result.data.text}\n`;
      }

      const fileDates = extractDatesFromText(fileExtractedText);
      const detectedType = detectDocumentTypeFromText(fileExtractedText);

      fileDates.forEach(d => {
        let displayName = file.name || `Document ${i+1}`;
        if (detectedType) {
          displayName = `${detectedType} (Auto-detected)`;
        } else if (file.category && file.category !== 'General') {
          displayName = `${file.category} (${displayName})`;
        }
        allExtractedDates.push({
          sourceName: displayName,
          ...d
        });
      });
    }

    document.getElementById('ocrProgressBar').style.width = '100%';

    showOcrResults(allExtractedDates, vehicle);
  } catch (error) {
    console.error('OCR Error:', error);
    document.getElementById('ocrStatus').innerHTML = `
      <p style="color: var(--danger); font-weight: 700;">❌ OCR Scanning Failed</p>
      <p style="font-size: 0.85rem; color: var(--text-muted); margin-top: 0.5rem;">Error: ${error.message}</p>
    `;
  }
}

function detectDocumentTypeFromText(text) {
  const t = text.toLowerCase();
  if (t.includes('certificate of registration') || (t.includes('owner name') && t.includes('chassis'))) return 'RC Book';
  if (t.includes('certificate of fitness') || t.includes('fitness certificate')) return 'Fitness Certificate';
  if (t.includes('insurance') || t.includes('policy schedule') || t.includes('certificate of insurance')) return 'Insurance Policy';
  if (t.includes('tax receipt') || t.includes('motor vehicle tax')) return 'Tax Receipt';
  if (t.includes('national permit') || t.includes('authorization') || t.includes('goods carriage permit')) return 'Permit';
  if (t.includes('pollution') || t.includes('emission') || t.includes('pucc')) return 'PUCC';
  return null;
}

function extractDatesFromText(text) {
  const dates = [];

  // Common Indian date formats: DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
  const dateRegex = /\b(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})\b/g;
  let match;
  while ((match = dateRegex.exec(text)) !== null) {
    const day = parseInt(match[1]);
    const month = parseInt(match[2]);
    const year = parseInt(match[3]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000 && year <= 2040) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00`;
      const dateLabel = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
      dates.push({ dateStr, dateLabel, raw: match[0] });
    }
  }

  // Text month formats: DD-MMM-YYYY or DD MMM YYYY (e.g. 14-Jan-2016)
  const monthNames = { 'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6, 'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12 };
  const textMonthRegex = /\b(\d{1,2})[\/\-\.\s]+([a-zA-Z]{3,9})[\/\-\.\s]+(\d{4})\b/g;
  while ((match = textMonthRegex.exec(text)) !== null) {
    const day = parseInt(match[1]);
    const monthStr = match[2].toLowerCase().substring(0, 3);
    const year = parseInt(match[3]);
    const month = monthNames[monthStr];
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000 && year <= 2040) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00`;
      const dateLabel = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
      if (!dates.find(d => d.dateStr === dateStr)) {
        dates.push({ dateStr, dateLabel, raw: match[0] });
      }
    }
  }

  // Also try YYYY-MM-DD format
  const isoRegex = /\b(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g;
  while ((match = isoRegex.exec(text)) !== null) {
    const year = parseInt(match[1]);
    const month = parseInt(match[2]);
    const day = parseInt(match[3]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && year >= 2000 && year <= 2040) {
      const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T00:00`;
      const dateLabel = `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
      if (!dates.find(d => d.dateStr === dateStr)) {
        dates.push({ dateStr, dateLabel, raw: match[0] });
      }
    }
  }

  return dates;
}

function showOcrResults(extractedDates, vehicle) {
  document.getElementById('ocrStatus').style.display = 'none';
  const resultsDiv = document.getElementById('ocrResults');
  resultsDiv.style.display = 'block';

  let html = '<h4 style="font-weight: 700; margin-bottom: 0.75rem;">✅ Scan Complete!</h4>';

  if (extractedDates.length > 0) {
    html += '<p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.75rem;">Dates found in documents. Select which field to auto-fill:</p>';

    extractedDates.forEach((d, idx) => {
      // Suggest the field based on the file name/category if possible
      let suggestedField = "";
      const sourceLower = d.sourceName.toLowerCase();
      if (sourceLower.includes("registration") || sourceLower.includes("rc")) suggestedField = "regDate";
      else if (sourceLower.includes("fitness")) suggestedField = "fitnessUpto";
      else if (sourceLower.includes("insurance") || sourceLower.includes("policy")) suggestedField = "insuranceUpto";
      else if (sourceLower.includes("tax")) suggestedField = "taxUpto";
      else if (sourceLower.includes("national permit") || sourceLower.includes("np")) suggestedField = "nationalPermit";
      else if (sourceLower.includes("permit")) suggestedField = "permitUpto";
      else if (sourceLower.includes("pucc") || sourceLower.includes("pollution") || sourceLower.includes("emission")) suggestedField = "pucc";

      html += `
        <div class="ocr-date-found" style="display: flex; justify-content: space-between; align-items: center; padding: 0.8rem; flex-wrap: wrap;">
          <div style="width: 100%; margin-bottom: 0.4rem; font-size: 0.75rem; color: var(--text-muted); font-weight: 600;">
            📄 Found in: ${d.sourceName}
          </div>
          <div class="ocr-value" style="margin:0;">📅 ${d.dateLabel}</div>
          <select class="ocr-field-select" data-date="${d.dateStr}" style="padding: 0.4rem; border-radius: var(--radius-sm); border: 1px solid var(--border-color); background: var(--bg-main); color: var(--text-main);">
            <option value="">-- Ignore --</option>
            <option value="regDate" ${suggestedField === 'regDate' ? 'selected' : ''}>Registration</option>
            <option value="fitnessUpto" ${suggestedField === 'fitnessUpto' ? 'selected' : ''}>Fitness</option>
            <option value="insuranceUpto" ${suggestedField === 'insuranceUpto' ? 'selected' : ''}>Insurance</option>
            <option value="taxUpto" ${suggestedField === 'taxUpto' ? 'selected' : ''}>Tax</option>
            <option value="permitUpto" ${suggestedField === 'permitUpto' ? 'selected' : ''}>Permit</option>
            <option value="nationalPermit" ${suggestedField === 'nationalPermit' ? 'selected' : ''}>National Permit</option>
            <option value="pucc" ${suggestedField === 'pucc' ? 'selected' : ''}>PUCC</option>
          </select>
        </div>
      `;
    });

    html += `
      <div style="margin-top: 1rem; text-align: center;">
        <button class="primary-btn" onclick="saveAllOcrDates()" style="width: 100%; padding: 0.75rem;">💾 Save All Selected Dates</button>
      </div>
    `;
  } else {
    html += '<p style="color: var(--warning); font-weight: 600;">⚠️ No dates found in the scanned documents.</p>';
    html += '<p style="font-size: 0.85rem; color: var(--text-muted);">Try uploading clearer images with visible dates.</p>';
  }

  resultsDiv.innerHTML = html;
}

async function saveAllOcrDates() {
  const vehicle = await db.getVehicle(currentDocManagerVehicleId);
  if (!vehicle) return;

  const selects = document.querySelectorAll('.ocr-field-select');
  let updated = false;

  selects.forEach(select => {
    const fieldKey = select.value;
    const dateStr = select.getAttribute('data-date');
    if (fieldKey) {
      vehicle[fieldKey] = dateStr;
      updated = true;
    }
  });

  if (updated) {
    await db.saveVehicle(vehicle);
    document.getElementById('ocrModal').classList.remove('active');
    closeDocManagerModal();
    await loadVehicles();
    alert('✅ All selected dates have been saved successfully!');
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
  document.getElementById('companyCodeInput').value = currentCompanyName;
  document.getElementById('syncKeyInput').value = currentSyncKey;

  const leaveBtn = document.getElementById('leaveCompanyBtn');
  const syncLocalBtn = document.getElementById('syncLocalBtn');
  const activeBadge = document.getElementById('activeSyncBadge');

  if (currentSyncKey) {
    leaveBtn.style.display = 'block';
    syncLocalBtn.style.display = 'block';
    activeBadge.style.display = 'block';
    document.getElementById('activeCompanyName').innerText = currentCompanyName || 'Company Workspace';
    document.getElementById('activeSyncKey').innerText = currentSyncKey;
  } else {
    leaveBtn.style.display = 'none';
    syncLocalBtn.style.display = 'none';
    activeBadge.style.display = 'none';
  }
  document.getElementById('companyModal').classList.add('active');
}

function closeCompanyModal() {
  document.getElementById('companyModal').classList.remove('active');
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
    const text = `🏢 Join our Company Vehicle Workspace in VehicleEx Pro!\n\nCompany: ${currentCompanyName || 'Company Workspace'}\nSync Key: ${currentSyncKey}\n\nOpen app & paste this key in Company Sync: https://msuhailc-47.github.io/Metro-Vehicle/`;
    const url = `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`;
    window.open(url, '_blank');
  }
}

function getLightVehicles(vehicles) {
  return vehicles.map(v => {
    const light = { ...v };
    if (light.files && Array.isArray(light.files)) {
      light.files = light.files.map(f => ({
        id: f.id,
        name: f.name,
        type: f.type,
        size: f.size,
        category: f.category
      }));
    }
    return light;
  });
}

function generateSyncKey(companyName) {
  const prefix = companyName.replace(/[^A-Za-z0-9]/g, '').substring(0, 6).toUpperCase() || 'FLEET';
  const randNum = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${randNum}`;
}

async function handleCompanyFormSubmit(e) {
  e.preventDefault();
  initFirebaseApp();
  const companyName = document.getElementById('companyCodeInput').value.trim();
  let syncKey = document.getElementById('syncKeyInput').value.trim().toUpperCase();

  if (!companyName) {
    alert('Please enter a Company Name / Fleet Title.');
    return;
  }

  try {
    if (syncKey) {
      // Connect to existing workspace
      const res = await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/workspaces/${syncKey}.json`);
      const data = await res.json();
      if (!data) {
        alert('⚠️ Workspace not found with this Sync Key. Please check the key or create a new workspace.');
        return;
      }
      currentSyncKey = syncKey;
      currentCompanyName = data.name || companyName;
    } else {
      // Create new workspace with clean friendly key
      currentSyncKey = generateSyncKey(companyName);
      currentCompanyName = companyName;
      
      const allLocalVehicles = await db.getAllVehicles();
      const lightVehicles = getLightVehicles(allLocalVehicles);
      
      const payload = {
        name: currentCompanyName,
        vehicles: lightVehicles,
        createdAt: new Date().toISOString()
      };

      await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/workspaces/${currentSyncKey}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    localStorage.setItem('vehicleex_company_name', currentCompanyName);
    localStorage.setItem('vehicleex_sync_key', currentSyncKey);

    updateCompanyHeaderBadge();
    listenToFirebaseWorkspace();
    openCompanyModal(); // Refresh modal to show prominent sync key & copy button

    // Copy to clipboard automatically on connection
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(currentSyncKey).catch(() => {});
    }

    alert(`🎉 Connected to Workspace: ${currentCompanyName}!\n\n🔑 Sync Key: ${currentSyncKey}\n(Key automatically copied to clipboard!)`);
  } catch (err) {
    console.error('Company Connection Error:', err);
    alert('⚠️ Connection Error: ' + err.message);
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
        if (val && Array.isArray(val.vehicles) && !isSyncingFromCloud) {
          isSyncingFromCloud = true;
          await db.clearAll();
          for (const cv of val.vehicles) {
            await db.saveVehicle(cv, true);
          }
          await loadVehicles();
          isSyncingFromCloud = false;
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
    if (val && Array.isArray(val.vehicles)) {
      isSyncingFromCloud = true;
      await db.clearAll();
      for (const cv of val.vehicles) {
        await db.saveVehicle(cv, true);
      }
      await loadVehicles();
      isSyncingFromCloud = false;
    }
  } catch (err) {
    console.warn('Sync Fetch Notice:', err.message);
    isSyncingFromCloud = false;
  }
}

async function pushCurrentVehiclesToCloud() {
  if (!currentSyncKey || isSyncingFromCloud) return;
  try {
    const allVehicles = await db.getAllVehicles();
    const lightVehicles = getLightVehicles(allVehicles);
    const payload = {
      name: currentCompanyName,
      vehicles: lightVehicles,
      updatedAt: new Date().toISOString()
    };

    if (firebaseDb) {
      await firebaseDb.ref('workspaces/' + currentSyncKey).set(payload);
    } else {
      await fetch(`https://vehicleex-85816-default-rtdb.asia-southeast1.firebasedatabase.app/workspaces/${currentSyncKey}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }
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
    localStorage.removeItem('vehicleex_company_name');
    localStorage.removeItem('vehicleex_sync_key');
    updateCompanyHeaderBadge();
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


