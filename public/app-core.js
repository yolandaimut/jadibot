// --- skrip global terpadu xu core untuk dashboard.html dan chat.html ---
const EXCLUSIVE_ADMIN_EMAIL = 'suryadev2105@gmail.com';
const EXCLUSIVE_ADMIN_GOOGLE_ID = '113793372874509761088';
const READ_ANNOUNCEMENTS_STORAGE_KEY = 'xu_core_read_announcements';
const ONBOARDING_DISMISSED_STORAGE_KEY = 'xu_core_onboarding_dismissed';
const STICKER_CACHE_PREFIX = 'xu_core_stickers_v1_';
const QUICK_REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const MAX_CPU_POINTS = 25;

// --- state global identitas akun, koneksi, dan dashboard ---
let isAppCoreInitialized = false;
let activePageName = 'dashboard';
let botStartTimeMs = Date.now();
let loadedPluginsCache = [];
let featureCatalogCache = [];
let currentDisabledCategories = [];
let currentGroupConfigsMap = {};
let isCurrentUserAdmin = false;
let currentGoogleUserId = '';
let currentUserEmail = '';
let currentUserFullName = 'User';
let currentUserAvatarUrl = '';
let currentUserHandle = '';
let currentUserProfileData = null;
let adminWhatsAppNumber = '6285700408187';
let currentConnectionStatus = 'DISCONNECTED';
let lastKnownDatabaseSnapshot = null;

// --- state pengumuman, terminal cli, entitas terkelola, dan penjadwal ---
let announcementsCache = [];
let terminalLogsBuffer = [];
let activeLogFilter = 'all';
let isTerminalAutoScrollEnabled = true;

let managedUsersCache = [];
let managedGroupsCache = [];
let managedUserFilter = 'all';
const selectedManagedUserJids = new Set();

let scheduledMessagesCache = [];
let directTargetMode = 'group';
let scheduleTargetMode = 'group';

// --- state api gateway, auto-reply builder, media upload, dan overlay live chat ---
let currentGatewayApiKey = '';
let isGatewayKeyVisible = false;
let gatewayLocalFilePayload = null;
let gwCopyIconResetTimer = null;
let gwCopySnippetResetTimer = null;
let pairingCopyResetTimer = null;

let visualAutoReplyRules = [];
let isAutoReplyRawMode = false;
let brandingAvatarBase64Payload = '';
let pendingProfileAvatarBase64 = '';
let webhookDeliveryLogsCache = [];
let publicChatMessagesCache = [];
let waLiveInboxCache = [];
let activeWaInboxJid = '';
let activeWorkspaceTab = 'dashboard';
let isCommandPaletteOpen = false;
let cmdPaletteSelectedIndex = 0;
let cmdPaletteFilteredActions = [];
let isLiveChatFullscreenOpen = false;
let activeLiveChatMode = 'inbox';
let isMobileInboxConversationOpen = false;

let pendingDeleteUserJid = null;
let latestTrafficSeries = null;
let lastSubscriptionMeta = null;
let refreshStartedAt = 0;
let refreshFallbackTimer = null;
let uptimeTickInterval = null;

// --- state khusus modul xu core community (chat.html) & stiker hibrida ---
let communityMessagesCache = [];
let communityPinnedCache = [];
let communityMembersCache = [];
let communityStickersCache = [];
let activePinnedCarouselIndex = 0;
let activeCommunityReplyTarget = null;
let activeFloatingMessageId = '';
let activeDetailReactionMessageId = '';
let activeDetailReactionFilter = 'all';
let isChatAttachMenuOpen = false;
let isStickerSheetOpen = false;
let isMembersDrawerOpen = false;
let isStickerSyncRunning = false;
let messageLongPressTimer = null;
// --- state & controller simpan atau hapus stiker favorit ala whatsapp ---
let activeInspectStickerUrl = '';

// --- instance grafik dashboard ---
let cpuChartInstance = null;
let trafficChartInstance = null;
let trafficVelocityChartInstance = null;

// --- koneksi socket.io global ---
const socketClient = io({
  withCredentials: true,
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionAttempts: Infinity
});

// --- helper reusable dom, modal, clipboard, waktu wib, dan eksekusi aman ---
function getEl(elementId) {
  if (!elementId) return null;
  return document.getElementById(elementId);
}

function toggleModalVisibility(modalId, isVisible) {
  const modal = getEl(modalId);
  if (!modal) return;
  modal.classList.toggle('hidden', !isVisible);
  modal.classList.toggle('flex', isVisible);
}

function safeExecute(actionFn, contextLabel = 'UI') {
  try {
    return actionFn();
  } catch (err) {
    console.error(`[${contextLabel}]`, err);
    return null;
  }
}

function escapeHtmlString(rawString) {
  return String(rawString ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function checkExclusiveAdminUser(userObj) {
  if (!userObj) return false;
  const email = String(userObj.email || '').trim().toLowerCase();
  const googleId = String(userObj.googleId || userObj.userId || '').trim();
  return email === EXCLUSIVE_ADMIN_EMAIL || googleId === EXCLUSIVE_ADMIN_GOOGLE_ID;
}

async function copyTextToClipboard(textValue, successTitle = 'Disalin', emptyMessage = 'Tidak ada teks untuk disalin.') {
  const cleanText = String(textValue || '').trim();
  if (!cleanText) {
    showCyberToast('Kosong', emptyMessage, 'danger');
    return false;
  }
  try {
    await navigator.clipboard.writeText(cleanText);
    showCyberToast(successTitle, 'Teks berhasil disalin ke clipboard.', 'info');
    return true;
  } catch {
    showCyberToast('Gagal Menyalin', 'Izin clipboard ditolak browser.', 'danger');
    return false;
  }
}

function formatWibDateTime(timestampMs) {
  const parsedMs = Number(timestampMs || 0);
  if (!parsedMs) return '-';
  const datePart = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(new Date(parsedMs));
  const timePart = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(parsedMs)).replace('.', ':');
  return `${datePart}, ${timePart} WIB`;
}

function formatWibTimeOnly(timestampMs) {
  const parsedMs = Number(timestampMs || 0);
  if (!parsedMs) return '--:--';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date(parsedMs)).replace('.', ':');
}

function updateButtonGroupState(selector, dataAttr, activeValue, activeClass, inactiveClass) {
  document.querySelectorAll(selector).forEach((buttonEl) => {
    const isMatched = buttonEl.getAttribute(dataAttr) === activeValue;
    buttonEl.className = isMatched ? activeClass : inactiveClass;
  });
}

// --- notifikasi cyber glass toast seragam untuk dashboard dan chat ---
function showCyberToast(title, message, variant = 'success') {
  const container = getEl('cyberToastContainer');
  if (!container) return;

  const styles = {
    success: {
      border: 'border-emerald-500/35',
      glow: 'shadow-[0_8px_28px_rgba(16,185,129,0.18)]',
      badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
      bar: 'bg-emerald-400',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M5 13l4 4L19 7"/>'
    },
    danger: {
      border: 'border-rose-500/35',
      glow: 'shadow-[0_8px_28px_rgba(244,63,94,0.2)]',
      badge: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
      bar: 'bg-rose-500',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4c-.77-1.33-2.69-1.33-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z"/>'
    },
    info: {
      border: 'border-sky-500/35',
      glow: 'shadow-[0_8px_28px_rgba(14,165,233,0.18)]',
      badge: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
      bar: 'bg-sky-400',
      icon: '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>'
    }
  };

  const theme = styles[variant] || styles.info;
  const toastCard = document.createElement('div');
  toastCard.className = `pointer-events-auto relative overflow-hidden rounded-xl bg-slate-950/95 backdrop-blur-xl border ${theme.border} ${theme.glow} p-3 transition-all duration-300 -translate-y-3 opacity-0`;

  toastCard.innerHTML = `
    <div class="flex items-start gap-2.5">
      <div class="w-7 h-7 rounded-lg border ${theme.badge} flex items-center justify-center shrink-0">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">${theme.icon}</svg>
      </div>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-bold text-white truncate">${escapeHtmlString(title)}</p>
        <p class="text-[11px] text-slate-400 mt-0.5 leading-snug break-words">${escapeHtmlString(message)}</p>
      </div>
      <button type="button" onclick="this.closest('.pointer-events-auto').remove()" class="text-slate-500 hover:text-slate-200 transition-colors">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-slate-800/80">
      <div class="h-full ${theme.bar} cyber-toast-progress"></div>
    </div>
  `;

  container.appendChild(toastCard);
  requestAnimationFrame(() => {
    toastCard.classList.remove('-translate-y-3', 'opacity-0');
    toastCard.classList.add('translate-y-0', 'opacity-100');
  });

  setTimeout(() => {
    toastCard.classList.remove('translate-y-0', 'opacity-100');
    toastCard.classList.add('-translate-y-2', 'opacity-0');
    setTimeout(() => toastCard.remove(), 300);
  }, 3600);
}

function showTopToast(messageText, isError = false) {
  showCyberToast(isError ? 'Peringatan' : 'Sistem', messageText, isError ? 'danger' : 'success');
}

// --- modul settings profile, avatar maks 5mb, dan hapus akun konfirmasi dinamis ---
function getExpectedDeleteAccountPhrase() {
  const resolvedName = String(currentUserFullName || 'User').trim() || 'User';
  return `confirm ${resolvedName}`;
}

function applyProfileIdentityToHeader(profileObj) {
  if (!profileObj) return;
  const resolvedName = String(profileObj.displayName || profileObj.fullName || profileObj.givenName || 'User').trim();
  const resolvedAvatar =
    profileObj.avatarUrl ||
    profileObj.pictureUrl ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(resolvedName)}&background=10b981&color=fff`;

  currentUserFullName = resolvedName;
  currentUserAvatarUrl = resolvedAvatar;
  if (typeof profileObj.handle === 'string') currentUserHandle = profileObj.handle;
  if (typeof profileObj.email === 'string' && profileObj.email) currentUserEmail = profileObj.email;

  if (getEl('navGoogleAvatar')) getEl('navGoogleAvatar').src = resolvedAvatar;
  if (getEl('communityNavAvatar')) getEl('communityNavAvatar').src = resolvedAvatar;
  if (getEl('navGoogleGivenName')) getEl('navGoogleGivenName').textContent = resolvedName;
  if (getEl('profileAvatarPreviewImg') && !pendingProfileAvatarBase64) {
    getEl('profileAvatarPreviewImg').src = resolvedAvatar;
  }
  if (getEl('deleteAccountExpectedPhrase')) {
    getEl('deleteAccountExpectedPhrase').textContent = getExpectedDeleteAccountPhrase();
  }
}

function populateProfileSettingsModalFields(profileData) {
  const safeProfile = profileData || {};
  const displayName = String(safeProfile.displayName || currentUserFullName || 'User').slice(0, 20);
  const avatarUrl =
    safeProfile.avatarUrl ||
    currentUserAvatarUrl ||
    getEl('navGoogleAvatar')?.src ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=10b981&color=fff`;
  const isDeveloperRole = isCurrentUserAdmin || String(safeProfile.role || '').toUpperCase() === 'DEVELOPER';

  if (getEl('profileAvatarPreviewImg') && !pendingProfileAvatarBase64) {
    getEl('profileAvatarPreviewImg').src = avatarUrl;
  }
  if (getEl('profileDisplayNameInput')) {
    getEl('profileDisplayNameInput').value = displayName;
  }
  if (getEl('profileHandleInput')) {
    getEl('profileHandleInput').value = String(safeProfile.handle ?? currentUserHandle ?? '');
  }
  if (getEl('profileEmailReadonly')) {
    getEl('profileEmailReadonly').value = String(safeProfile.email || currentUserEmail || '-');
  }

  const roleBadgeEl = getEl('profileRoleHexBadge');
  if (roleBadgeEl) {
    roleBadgeEl.textContent = isDeveloperRole ? 'DEVELOPER' : 'MEMBER';
    roleBadgeEl.className = isDeveloperRole
      ? 'role-hex-badge role-hex-developer'
      : 'role-hex-badge role-hex-member';
  }

  if (getEl('deleteAccountExpectedPhrase')) {
    getEl('deleteAccountExpectedPhrase').textContent = getExpectedDeleteAccountPhrase();
  }

  updateProfileNameCounter();
  validateDeleteAccountConfirmation();
}

async function fetchCurrentProfileSettings() {
  try {
    const response = await fetch('/api/profile/me', {
      method: 'GET',
      credentials: 'same-origin'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.isSuccess) return null;

    currentUserProfileData = payload.profile || null;
    if (typeof payload.isAdmin === 'boolean') {
      isCurrentUserAdmin = payload.isAdmin;
    }

    if (currentUserProfileData) {
      applyProfileIdentityToHeader(currentUserProfileData);
      populateProfileSettingsModalFields(currentUserProfileData);
    }

    if (Array.isArray(payload.stickers)) {
      communityStickersCache = payload.stickers;
    }

    return payload;
  } catch (profileErr) {
    console.error('[PROFILE FETCH]', profileErr);
    return null;
  }
}

async function openProfileSettingsModal() {
  pendingProfileAvatarBase64 = '';
  if (getEl('profileAvatarFileInput')) getEl('profileAvatarFileInput').value = '';
  if (getEl('profileAvatarFileInfo')) getEl('profileAvatarFileInfo').textContent = 'JPG / PNG / WebP maksimal 5 MB';
  getEl('profileClearAvatarBtn')?.classList.add('hidden');
  if (getEl('deleteAccountConfirmInput')) getEl('deleteAccountConfirmInput').value = '';

  populateProfileSettingsModalFields(currentUserProfileData);
  toggleModalVisibility('profileSettingsModal', true);
  await fetchCurrentProfileSettings();
}

function closeProfileSettingsModal() {
  clearProfileAvatarSelection();
  toggleModalVisibility('profileSettingsModal', false);
}

function updateProfileNameCounter() {
  const inputEl = getEl('profileDisplayNameInput');
  const counterEl = getEl('profileDisplayNameCounter');
  if (!inputEl || !counterEl) return;

  const currentLength = String(inputEl.value || '').length;
  counterEl.textContent = `${currentLength}/20`;
  counterEl.className = currentLength >= 20
    ? 'text-[10px] font-mono-code text-amber-300 font-bold'
    : 'text-[10px] font-mono-code text-slate-400';
}

function handleProfileAvatarSelect(event) {
  const selectedFile = event?.target?.files?.[0];
  const infoEl = getEl('profileAvatarFileInfo');
  const previewEl = getEl('profileAvatarPreviewImg');
  const clearBtn = getEl('profileClearAvatarBtn');

  if (!selectedFile) {
    clearProfileAvatarSelection();
    return;
  }

  if (!/^image\/(jpeg|jpg|png|webp)$/i.test(selectedFile.type || '')) {
    showCyberToast('Format Tidak Didukung', 'Gunakan gambar berformat JPG, PNG, atau WebP.', 'danger');
    clearProfileAvatarSelection();
    return;
  }

  if (selectedFile.size > 5 * 1024 * 1024) {
    showCyberToast('File Terlalu Besar', 'Maksimal ukuran foto profil adalah 5 MB.', 'danger');
    clearProfileAvatarSelection();
    return;
  }

  const fileReader = new FileReader();
  fileReader.onload = () => {
    pendingProfileAvatarBase64 = String(fileReader.result || '');
    if (previewEl && pendingProfileAvatarBase64) {
      previewEl.src = pendingProfileAvatarBase64;
    }
    if (infoEl) {
      infoEl.textContent = `${selectedFile.name} (${(selectedFile.size / 1024).toFixed(1)} KB)`;
    }
    clearBtn?.classList.remove('hidden');
  };
  fileReader.readAsDataURL(selectedFile);
}

function clearProfileAvatarSelection() {
  pendingProfileAvatarBase64 = '';
  if (getEl('profileAvatarFileInput')) getEl('profileAvatarFileInput').value = '';
  if (getEl('profileAvatarFileInfo')) getEl('profileAvatarFileInfo').textContent = 'JPG / PNG / WebP maksimal 5 MB';
  getEl('profileClearAvatarBtn')?.classList.add('hidden');

  const fallbackAvatar =
    currentUserProfileData?.avatarUrl ||
    currentUserAvatarUrl ||
    getEl('navGoogleAvatar')?.src ||
    `https://ui-avatars.com/api/?name=${encodeURIComponent(currentUserFullName)}&background=10b981&color=fff`;
  if (getEl('profileAvatarPreviewImg')) {
    getEl('profileAvatarPreviewImg').src = fallbackAvatar;
  }
}

async function submitProfileSettingsUpdate() {
  const displayName = String(getEl('profileDisplayNameInput')?.value || '').trim();
  const handle = String(getEl('profileHandleInput')?.value || '').trim();
  const saveBtn = getEl('profileSaveSubmitBtn');

  if (!displayName) {
    showCyberToast('Nama Kosong', 'Nama akun tidak boleh kosong.', 'danger');
    return;
  }
  if (displayName.length > 20) {
    showCyberToast('Nama Terlalu Panjang', 'Nama akun maksimal terdiri dari 20 karakter.', 'danger');
    return;
  }

  if (saveBtn) saveBtn.disabled = true;
  try {
    const response = await fetch('/api/profile/update', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName,
        handle,
        avatarBase64: pendingProfileAvatarBase64 || ''
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.isSuccess) {
      throw new Error(result.errorMessage || 'Gagal memperbarui profil akun.');
    }

    currentUserProfileData = result.profile || currentUserProfileData;
    pendingProfileAvatarBase64 = '';
    getEl('profileClearAvatarBtn')?.classList.add('hidden');
    if (getEl('profileAvatarFileInput')) getEl('profileAvatarFileInput').value = '';
    if (getEl('profileAvatarFileInfo')) getEl('profileAvatarFileInfo').textContent = 'Profil tersinkronisasi.';

    applyProfileIdentityToHeader(currentUserProfileData);
    populateProfileSettingsModalFields(currentUserProfileData);
    showCyberToast('Profil Diperbarui', 'Nama dan foto profil Anda telah disimpan.', 'success');
  } catch (updateErr) {
    showCyberToast('Gagal Menyimpan Profil', updateErr.message, 'danger');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function validateDeleteAccountConfirmation() {
  const inputEl = getEl('deleteAccountConfirmInput');
  const submitBtn = getEl('deleteAccountSubmitBtn');
  if (!inputEl || !submitBtn) return false;

  const expectedPhrase = getExpectedDeleteAccountPhrase();
  if (getEl('deleteAccountExpectedPhrase')) {
    getEl('deleteAccountExpectedPhrase').textContent = expectedPhrase;
  }

  const isExactMatch = Boolean(currentUserFullName) && String(inputEl.value || '') === expectedPhrase;
  submitBtn.disabled = !isExactMatch;
  return isExactMatch;
}

async function submitPermanentAccountDeletion() {
  const expectedPhrase = getExpectedDeleteAccountPhrase();
  if (!validateDeleteAccountConfirmation()) {
    showCyberToast('Konfirmasi Belum Sesuai', `Ketik persis: ${expectedPhrase}`, 'danger');
    return;
  }

  const submitBtn = getEl('deleteAccountSubmitBtn');
  if (submitBtn) submitBtn.disabled = true;

  try {
    const response = await fetch('/api/account/delete', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirmationText: expectedPhrase,
        verifiedDynamicPhrase: expectedPhrase
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.isSuccess) {
      throw new Error(result.errorMessage || 'Gagal menghapus akun.');
    }

    try {
      localStorage.removeItem(`${STICKER_CACHE_PREFIX}${currentGoogleUserId}`);
    } catch {}

    if (socketClient.connected) socketClient.disconnect();
    window.location.replace('/login');
  } catch (deleteErr) {
    showCyberToast('Penghapusan Gagal', deleteErr.message, 'danger');
    validateDeleteAccountConfirmation();
  }
}

// --- pratinjau langsung variabel template broadcast zona wib ---
function formatBroadcastTemplatePreview(rawText) {
  const nowJakarta = new Date();
  const dateLabel = new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    dateStyle: 'full'
  }).format(nowJakarta);
  const timeLabel = `${new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(nowJakarta).replace('.', ':')} WIB`;
  const activeBotName = (getEl('cfgBotNameInput')?.value || '').trim() || 'Xu Core';

  return String(rawText || '')
    .replaceAll('{botName}', activeBotName)
    .replaceAll('{date}', dateLabel)
    .replaceAll('{time}', timeLabel);
}

function updateBroadcastLivePreview() {
  const inputEl = getEl('broadcastGroupMessageInput');
  const previewEl = getEl('broadcastLivePreviewText');
  if (!inputEl || !previewEl) return;

  const rawValue = inputEl.value;
  if (!rawValue.trim()) {
    previewEl.textContent = 'Pratinjau hasil pesan akan tampil di sini secara otomatis saat Anda mengetik...';
    previewEl.classList.add('text-slate-500');
    previewEl.classList.remove('text-slate-200');
    return;
  }

  previewEl.textContent = formatBroadcastTemplatePreview(rawValue);
  previewEl.classList.remove('text-slate-500');
  previewEl.classList.add('text-slate-200');
}

function setupBroadcastTemplatePreviewListener() {
  const broadcastInput = getEl('broadcastGroupMessageInput');
  const botNameInput = getEl('cfgBotNameInput');
  if (broadcastInput) broadcastInput.addEventListener('input', updateBroadcastLivePreview);
  if (botNameInput) botNameInput.addEventListener('input', updateBroadcastLivePreview);
  updateBroadcastLivePreview();
}

// --- animasi teks brand xu core pada canvas sinkron dengan login.html ---
function initHeaderBrandTextCanvas(canvasEl, options) {
  if (!canvasEl || !canvasEl.getContext) return;

  const ctx = canvasEl.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const scaleFactor = options.scale || 1;
  const canvasWidth = options.width;
  const canvasHeight = options.height;
  const centerY = options.centerY != null ? options.centerY : canvasHeight / 2;

  canvasEl.width = Math.round(canvasWidth * scaleFactor * dpr);
  canvasEl.height = Math.round(canvasHeight * scaleFactor * dpr);
  canvasEl.style.width = `${Math.round(canvasWidth * scaleFactor)}px`;
  canvasEl.style.height = `${Math.round(canvasHeight * scaleFactor)}px`;
  ctx.scale(dpr * scaleFactor, dpr * scaleFactor);

  let brandInkColor = '#f8fafc';
  let lastStyleCheckMs = -1e9;

  const letterSpacing = 3;
  const brandText = 'XU CORE';
  const fontSize = options.fontSize || 27;
  const fontSpec = `700 ${fontSize}px Outfit, "Segoe UI", system-ui, sans-serif`;

  const timing = {
    textStart: 220,
    textStagger: 55,
    textDuration: 680,
    animEnd: 1400
  };

  const clampUnit = (val) => (val < 0 ? 0 : val > 1 ? 1 : val);
  const easeOutQuart = (progress) => 1 - Math.pow(1 - progress, 4);

  function measureBrandTextWidth(textValue) {
    let totalWidth = 0;
    for (let idx = 0; idx < textValue.length; idx += 1) {
      totalWidth += ctx.measureText(textValue[idx]).width + letterSpacing;
    }
    return totalWidth - letterSpacing;
  }

  function renderFrame(elapsedMs) {
    ctx.clearRect(0, 0, canvasWidth, canvasHeight);

    const nowMs = performance.now();
    if (nowMs - lastStyleCheckMs > 300) {
      lastStyleCheckMs = nowMs;
      const computedStyles = getComputedStyle(document.documentElement);
      brandInkColor = (computedStyles.getPropertyValue('--brand-ink') || '').trim() || '#f8fafc';
      if (document.fonts && document.fonts.check && !document.fonts.check(fontSpec) && document.fonts.load) {
        document.fonts.load(fontSpec);
      }
    }

    ctx.font = fontSpec;
    const textWidth = measureBrandTextWidth(brandText);
    const textStartX = 2;
    const textBaselineY = centerY + fontSize * 0.35;

    ctx.save();
    ctx.beginPath();
    ctx.rect(textStartX - 4, textBaselineY - fontSize * 0.98, textWidth + 12, fontSize * 1.4);
    ctx.clip();

    ctx.fillStyle = brandInkColor;
    ctx.textBaseline = 'alphabetic';

    let cursorX = textStartX;
    for (let charIdx = 0; charIdx < brandText.length; charIdx += 1) {
      const charProgress = easeOutQuart(clampUnit((elapsedMs - timing.textStart - charIdx * timing.textStagger) / timing.textDuration));
      const charAdvance = ctx.measureText(brandText[charIdx]).width + letterSpacing;
      if (charProgress > 0) {
        ctx.globalAlpha = Math.min(1, charProgress * 1.6);
        ctx.fillText(brandText[charIdx], cursorX, textBaselineY + (1 - charProgress) * fontSize * 0.75);
      }
      cursorX += charAdvance;
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  const startTimeMs = performance.now();
  const holdDurationMs = 2800;
  const fadeDurationMs = 450;
  const totalCycleMs = timing.animEnd + holdDurationMs + fadeDurationMs;

  function animateLoop() {
    const cycleElapsed = (performance.now() - startTimeMs) % totalCycleMs;
    const fadeElapsed = cycleElapsed - (timing.animEnd + holdDurationMs);
    renderFrame(Math.min(cycleElapsed, timing.animEnd));
    canvasEl.style.opacity = fadeElapsed > 0 ? String(Math.max(0, 1 - fadeElapsed / fadeDurationMs)) : '1';
    requestAnimationFrame(animateLoop);
  }

  animateLoop();
}
// --- kompatibilitas sinkronisasi elemen profil lintas halaman ---
function syncProfileElementsAcrossPages() {
  applyProfileIdentityToHeader({
    displayName: currentUserFullName,
    avatarUrl: currentUserAvatarUrl,
    handle: currentUserHandle,
    email: currentUserEmail
  });
}

// --- format pemisah hari zona asia/jakarta ---
function formatWibDayDivider(timestampMs) {
  const parsedMs = Number(timestampMs || Date.now());
  const dateFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const targetKey = dateFormatter.format(new Date(parsedMs));
  const todayKey = dateFormatter.format(new Date());
  const yesterdayKey = dateFormatter.format(new Date(Date.now() - 86400000));
  if (targetKey === todayKey) return 'Hari ini';
  if (targetKey === yesterdayKey) return 'Kemarin';
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  }).format(new Date(parsedMs));
}

// --- kartu panduan onboarding 3 langkah khusus user baru ---
function isOnboardingDismissed() {
  try {
    return localStorage.getItem(ONBOARDING_DISMISSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function dismissOnboardingCard() {
  try {
    localStorage.setItem(ONBOARDING_DISMISSED_STORAGE_KEY, '1');
  } catch {}
  getEl('onboardingProgressCard')?.classList.add('hidden');
  showCyberToast('Panduan Ditutup', 'Anda bisa mengakses semua fitur lewat menu atau Ctrl+K.', 'info');
}

function updateOnboardingStepBadge(elementId, stepNumber, isCompleted) {
  const stepEl = getEl(elementId);
  if (!stepEl) return;
  if (isCompleted) {
    stepEl.innerHTML = '<svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"/></svg>';
    stepEl.className = 'w-5 h-5 rounded-full accent-bg text-slate-950 flex items-center justify-center shrink-0 mt-0.5';
  } else {
    stepEl.textContent = String(stepNumber);
    stepEl.className = 'w-5 h-5 rounded-full bg-slate-900 border border-slate-700 text-[10px] font-mono-code font-bold text-slate-300 flex items-center justify-center shrink-0 mt-0.5';
  }
}

function evaluateOnboardingProgress(databaseObj = lastKnownDatabaseSnapshot) {
  const card = getEl('onboardingProgressCard');
  if (!card) return;
  if (isOnboardingDismissed()) {
    card.classList.add('hidden');
    return;
  }

  const db = databaseObj || {};
  const settings = db.settings || {};
  const msgIn = Number(db.totalMessagesReceived || 0);
  const msgOut = Number(db.totalMessagesSent || 0);
  const apiCalls = Number(db.apiKeyStats?.totalCalls || 0);

  const normalizedBotName = String(settings.botName || '').trim().toLowerCase();
  const isCustomBotName = Boolean(normalizedBotName) && !['xu core', 'surya core'].includes(normalizedBotName);

  const step1Done = currentConnectionStatus === 'CONNECTED' || currentConnectionStatus === 'ONLINE' || msgIn > 0 || msgOut > 0;
  const step2Done = Boolean(settings.isAiEnabled) || (Array.isArray(settings.autoReplies) && settings.autoReplies.length > 0) || isCustomBotName;
  const step3Done = msgOut > 0 || apiCalls > 0;

  const completedCount = [step1Done, step2Done, step3Done].filter(Boolean).length;
  if (completedCount >= 3) {
    card.classList.add('hidden');
    return;
  }

  card.classList.remove('hidden');
  const percent = Math.round((completedCount / 3) * 100);
  if (getEl('onboardingProgressCountLabel')) {
    getEl('onboardingProgressCountLabel').textContent = `${completedCount}/3 selesai`;
  }
  if (getEl('onboardingProgressBarFill')) {
    getEl('onboardingProgressBarFill').style.width = `${percent}%`;
  }

  updateOnboardingStepBadge('onboardStep1Icon', 1, step1Done);
  updateOnboardingStepBadge('onboardStep2Icon', 2, step2Done);
  updateOnboardingStepBadge('onboardStep3Icon', 3, step3Done);
}

// --- overlay live chat layar penuh pada dashboard (wa inbox & public chat ringkas) ---
function renderPublicChatMessages() {
  const container = getEl('publicChatMessagesList');
  const badge = getEl('publicChatCountBadge');
  if (badge) badge.textContent = String(publicChatMessagesCache.length);
  if (!container) return;

  if (publicChatMessagesCache.length === 0) {
    container.innerHTML = '<p class="text-xs font-mono-code text-slate-500 text-center py-8">Belum ada pesan di ruang obrolan publik. Mulai sapa pengguna lain!</p>';
    return;
  }

  container.innerHTML = publicChatMessagesCache.map((msg) => {
    const isMine = msg.userId === currentGoogleUserId;
    const avatar = msg.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(msg.name || 'U')}&background=0f172a&color=10b981`;
    const adminBadge = msg.isAdmin
      ? '<span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/35 text-amber-300 font-mono-code text-[8px] font-bold">ADMIN</span>'
      : '';
    const deleteBtn = isCurrentUserAdmin
      ? `<button type="button" data-id="${escapeHtmlString(msg.id)}" onclick="deletePublicChatMessageAdmin(this.dataset.id)" title="Hapus Pesan" class="text-[9px] text-rose-400 hover:text-rose-300 ml-1">✕</button>`
      : '';

    return `
      <div class="flex items-start gap-2 ${isMine ? 'flex-row-reverse' : ''}">
        <img src="${escapeHtmlString(avatar)}" alt="U" class="w-7 h-7 rounded-full object-cover border border-slate-700 shrink-0 mt-0.5" />
        <div class="max-w-[82%] rounded-xl px-3 py-2 text-xs ${isMine ? 'bg-emerald-500/15 border border-emerald-500/30 text-slate-100' : 'bg-slate-950/90 border border-slate-800 text-slate-200'}">
          <div class="flex items-center justify-between gap-2 mb-0.5">
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="font-bold text-[11px] ${isMine ? 'text-emerald-300' : 'text-white'} truncate">${escapeHtmlString(msg.name || 'User')}</span>
              ${adminBadge}
            </div>
            <div class="flex items-center gap-1 shrink-0">
              <span class="text-[9px] font-mono-code text-slate-500">${escapeHtmlString(formatWibTimeOnly(msg.timestamp))}</span>
              ${deleteBtn}
            </div>
          </div>
          <p class="text-[11px] leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">${escapeHtmlString(msg.text || (msg.type === 'sticker' ? '[Stiker]' : '[Media]'))}</p>
        </div>
      </div>
    `;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function submitPublicChatMessage(event) {
  if (event) event.preventDefault();
  const input = getEl('publicChatInput');
  const text = String(input?.value || '').trim();
  if (!text) return;
  socketClient.emit('public:chat:send', { text });
  if (input) input.value = '';
}

function deletePublicChatMessageAdmin(messageId) {
  if (!isCurrentUserAdmin || !messageId) return;
  socketClient.emit('public:chat:delete', { id: messageId });
}

function clearPublicChatAdmin() {
  if (!isCurrentUserAdmin) return;
  socketClient.emit('public:chat:clear');
  showCyberToast('Public Chat', 'Seluruh pesan ruang obrolan publik dibersihkan.', 'info');
}

// --- arahkan pembukaan live chat langsung menuju /chat sesuai tab ---
function openLiveChatFullscreen(defaultMode = 'community') {
  window.location.href = defaultMode === 'inbox' ? '/chat?tab=inbox' : '/chat';
}

function closeLiveChatFullscreen() {
  const overlay = getEl('liveChatFullscreenOverlay');
  if (!overlay) return;
  isLiveChatFullscreenOpen = false;
  isMobileInboxConversationOpen = false;
  overlay.classList.add('hidden');
  overlay.classList.remove('flex');
  document.body.classList.remove('overflow-hidden');
  getEl('floatingChatFabBtn')?.classList.remove('hidden');
  syncChatUnreadIndicator();
}

function switchLiveChatMode(mode) {
  activeLiveChatMode = mode === 'public' ? 'public' : 'inbox';
  const isPublic = activeLiveChatMode === 'public';

  const inboxPanel = getEl('fsWaInboxPanel');
  const publicPanel = getEl('fsPublicChatPanel');
  const inboxBtn = getEl('fsChatTabInboxBtn');
  const publicBtn = getEl('fsChatTabPublicBtn');
  const clearAdminBtn = getEl('publicChatClearAdminBtn');

  if (inboxPanel) {
    inboxPanel.classList.toggle('hidden', isPublic);
    inboxPanel.classList.toggle('grid', !isPublic);
  }
  if (publicPanel) {
    publicPanel.classList.toggle('hidden', !isPublic);
    publicPanel.classList.toggle('flex', isPublic);
  }

  const activeBtnCls = 'px-3 py-1.5 rounded-lg font-bold accent-bg text-slate-950 transition-all flex items-center gap-1.5';
  const inactiveBtnCls = 'px-3 py-1.5 rounded-lg font-semibold text-slate-400 hover:text-white transition-all flex items-center gap-1.5';

  if (inboxBtn) inboxBtn.className = isPublic ? inactiveBtnCls : activeBtnCls;
  if (publicBtn) publicBtn.className = isPublic ? activeBtnCls : inactiveBtnCls;
  if (clearAdminBtn && isCurrentUserAdmin) {
    clearAdminBtn.classList.toggle('hidden', !isPublic);
  }

  if (isPublic) renderPublicChatMessages();
  else renderWaLiveInboxUI();
}

// --- perbarui lencana jumlah pesan whatsapp belum dibaca ---
function syncChatUnreadIndicator() {
  const totalUnread = waLiveInboxCache.reduce((sum, chat) => sum + Number(chat.unreadCount || 0), 0);
  const unreadLabel = totalUnread > 99 ? '99+' : String(totalUnread);

  const fabBadge = getEl('floatingChatUnreadBadge');
  if (fabBadge) {
    if (totalUnread > 0 && !isLiveChatFullscreenOpen) {
      fabBadge.textContent = unreadLabel;
      fabBadge.classList.remove('hidden');
    } else {
      fabBadge.classList.add('hidden');
    }
  }

  const chatTabUnreadBadge = getEl('chatPageInboxUnreadBadge');
  if (chatTabUnreadBadge) {
    if (totalUnread > 0 && activeChatPageSection !== 'inbox') {
      chatTabUnreadBadge.textContent = unreadLabel;
      chatTabUnreadBadge.classList.remove('hidden');
    } else {
      chatTabUnreadBadge.classList.add('hidden');
    }
  }
}

function formatCleanWhatsappSubtitle(jid) {
  const raw = String(jid || '').trim();
  if (!raw) return '-';
  if (raw.endsWith('@g.us')) return `Grup • ${raw.split('@')[0]}`;
  if (raw.endsWith('@s.whatsapp.net')) return `+${raw.split('@')[0]}`;
  return raw;
}

// --- state & pengalih section community / wa bot inbox di halaman chat.html ---
let activeChatPageSection = 'community';

function switchChatPageSection(targetSection) {
  activeChatPageSection = targetSection === 'inbox' ? 'inbox' : 'community';
  const isInbox = activeChatPageSection === 'inbox';

  const communityTabBtn = getEl('chatPageTabCommunityBtn');
  const inboxTabBtn = getEl('chatPageTabInboxBtn');
  const communityMessagesEl = getEl('communityMessagesContainer');
  const communityStatusWrap = getEl('communityStatusBarsWrap');
  const communityFooterEl = getEl('communityInputFooter');
  const inboxPanelEl = getEl('chatPageWaInboxPanel');

  const headerTitleEl = getEl('chatRoomHeaderTitle');
  const headerBadgeEl = getEl('chatRoomHeaderBadge');
  const communityMetaEl = getEl('communityHeaderMeta');
  const inboxMetaEl = getEl('waInboxHeaderMeta');
  const membersBtnEl = getEl('communityMembersDrawerBtn');
  const pinnedBtnEl = getEl('communityPinnedHeaderBtn');
  const refreshInboxBtnEl = getEl('waInboxRefreshHeaderBtn');

  const activeTabCls = 'py-1.5 px-3 rounded-lg font-bold accent-bg text-slate-950 transition-all flex items-center justify-center gap-1.5 shadow-sm';
  const inactiveTabCls = 'py-1.5 px-3 rounded-lg font-semibold text-slate-400 hover:text-white transition-all flex items-center justify-center gap-1.5';

  if (communityTabBtn) communityTabBtn.className = isInbox ? inactiveTabCls : activeTabCls;
  if (inboxTabBtn) inboxTabBtn.className = isInbox ? activeTabCls : inactiveTabCls;

  communityMessagesEl?.classList.toggle('hidden', isInbox);
  communityStatusWrap?.classList.toggle('hidden', isInbox);
  communityFooterEl?.classList.toggle('hidden', isInbox);

  if (inboxPanelEl) {
    inboxPanelEl.classList.toggle('hidden', !isInbox);
    inboxPanelEl.classList.toggle('grid', isInbox);
  }

  if (headerTitleEl) headerTitleEl.textContent = isInbox ? 'WA Bot Inbox' : 'Xu Core Community';
  if (headerBadgeEl) headerBadgeEl.textContent = isInbox ? 'LIVE BOT' : 'Official';

  if (communityMetaEl) {
    communityMetaEl.classList.toggle('hidden', isInbox);
    communityMetaEl.classList.toggle('flex', !isInbox);
  }
  if (inboxMetaEl) {
    inboxMetaEl.classList.toggle('hidden', !isInbox);
    inboxMetaEl.classList.toggle('flex', isInbox);
  }

  membersBtnEl?.classList.toggle('hidden', isInbox);
  pinnedBtnEl?.classList.toggle('hidden', isInbox);
  if (refreshInboxBtnEl) {
    refreshInboxBtnEl.classList.toggle('hidden', !isInbox);
    refreshInboxBtnEl.classList.toggle('flex', isInbox);
  }

  renderCommunityPinnedBar();

  if (isInbox) {
    closeChatAttachMenu();
    closeMessageActionPopup();
    socketClient.emit('inbox:list');
    renderWaLiveInboxUI();
  } else {
    renderCommunityMessagesTimeline(false);
  }

  syncChatUnreadIndicator();
}

function refreshWaLiveInbox() {
  socketClient.emit('inbox:list');
  showCyberToast('WA Bot Inbox', 'Menyegarkan daftar percakapan WhatsApp...', 'info');
}

function renderWaLiveInboxUI() {
  const listEl = getEl('waInboxChatList');
  const countBadge = getEl('waInboxChatCountBadge');
  const listPane = getEl('waInboxListPane');
  const convPane = getEl('waInboxConversationPane');

  if (countBadge) countBadge.textContent = String(waLiveInboxCache.length);
  syncChatUnreadIndicator();

  if (listPane && convPane) {
    if (isMobileInboxConversationOpen && activeWaInboxJid) {
      listPane.classList.add('hidden', 'md:flex');
      convPane.classList.remove('hidden');
      convPane.classList.add('flex');
    } else {
      listPane.classList.remove('hidden');
      listPane.classList.add('flex');
      convPane.classList.add('hidden', 'md:flex');
      convPane.classList.remove('flex');
    }
  }

  if (!listEl) return;
  if (waLiveInboxCache.length === 0) {
    listEl.innerHTML = '<p class="text-xs font-mono-code text-slate-500 text-center py-10">Menunggu pesan WhatsApp masuk...</p>';
    return;
  }

  if (!activeWaInboxJid || !waLiveInboxCache.some((chat) => chat.jid === activeWaInboxJid)) {
    activeWaInboxJid = waLiveInboxCache[0].jid;
  }

  listEl.innerHTML = waLiveInboxCache.map((chat) => {
    const isSelected = chat.jid === activeWaInboxJid;
    const unreadBadge = chat.unreadCount > 0
      ? `<span class="px-1.5 py-0.5 rounded-full bg-emerald-500 text-slate-950 font-mono-code text-[9px] font-bold shrink-0">${chat.unreadCount}</span>`
      : '';
    return `
      <button type="button" data-jid="${escapeHtmlString(chat.jid)}" onclick="selectWaInboxChat(this.dataset.jid)" class="w-full text-left rounded-xl px-3 py-2.5 border transition-all ${isSelected ? 'bg-slate-800/90 accent-border' : 'bg-slate-900/60 border-slate-800/80 hover:bg-slate-900'}">
        <div class="flex items-center justify-between gap-2">
          <p class="text-xs font-bold text-white truncate">${escapeHtmlString(chat.name || chat.jid.split('@')[0])}</p>
          <span class="text-[9px] font-mono-code text-slate-500 shrink-0">${escapeHtmlString(formatWibTimeOnly(chat.lastTimestamp))}</span>
        </div>
        <p class="text-[10px] font-mono-code text-emerald-400/80 truncate mt-0.5">${escapeHtmlString(formatCleanWhatsappSubtitle(chat.jid))}</p>
        <div class="flex items-center justify-between gap-2 mt-1">
          <p class="text-[11px] text-slate-400 truncate">${escapeHtmlString(chat.lastMessage || '-')}</p>
          ${unreadBadge}
        </div>
      </button>
    `;
  }).join('');

  renderActiveWaInboxMessages();
}

function selectWaInboxChat(chatJid) {
  activeWaInboxJid = chatJid;
  isMobileInboxConversationOpen = true;
  socketClient.emit('inbox:read', { chatJid });
  renderWaLiveInboxUI();
}

function backToWaInboxListMobile() {
  isMobileInboxConversationOpen = false;
  renderWaLiveInboxUI();
}

function renderActiveWaInboxMessages() {
  const titleEl = getEl('waInboxActiveTitle');
  const jidEl = getEl('waInboxActiveJid');
  const viewport = getEl('waInboxMessagesViewport');
  if (!viewport) return;

  const activeChat = waLiveInboxCache.find((chat) => chat.jid === activeWaInboxJid);
  if (!activeChat) {
    if (titleEl) titleEl.textContent = 'Pilih percakapan';
    if (jidEl) jidEl.textContent = '-';
    viewport.innerHTML = '<p class="text-xs font-mono-code text-slate-500 text-center py-12">Pilih percakapan untuk mulai membaca dan membalas pesan WhatsApp.</p>';
    return;
  }

  if (titleEl) titleEl.textContent = activeChat.name || activeChat.jid.split('@')[0];
  if (jidEl) jidEl.textContent = formatCleanWhatsappSubtitle(activeChat.jid);

  const msgs = Array.isArray(activeChat.messages) ? activeChat.messages : [];
  if (msgs.length === 0) {
    viewport.innerHTML = '<p class="text-xs font-mono-code text-slate-500 text-center py-12">Belum ada pesan di percakapan ini.</p>';
    return;
  }

  viewport.innerHTML = msgs.map((msg) => `
    <div class="flex ${msg.fromMe ? 'justify-end' : 'justify-start'}">
      <div class="max-w-[85%] sm:max-w-[72%] rounded-2xl px-3.5 py-2.5 text-xs ${msg.fromMe ? 'bg-sky-500/20 border border-sky-500/35 text-slate-100' : 'bg-slate-900/95 border border-slate-800 text-slate-200'}">
        <div class="flex items-center justify-between gap-3 mb-1">
          <span class="text-[10px] font-bold ${msg.fromMe ? 'text-sky-300' : 'text-emerald-300'}">${escapeHtmlString(msg.senderName || (msg.fromMe ? 'Bot' : 'User'))}</span>
          <span class="text-[9px] font-mono-code text-slate-500">${escapeHtmlString(formatWibTimeOnly(msg.timestamp))}</span>
        </div>
        <p class="text-xs leading-relaxed whitespace-pre-wrap break-words [overflow-wrap:anywhere]">${escapeHtmlString(msg.text)}</p>
      </div>
    </div>
  `).join('');

  viewport.scrollTop = viewport.scrollHeight;
}

function submitWaInboxReply(event) {
  if (event) event.preventDefault();
  if (!activeWaInboxJid) {
    showCyberToast('Pilih Chat', 'Pilih salah satu percakapan di daftar kiri terlebih dahulu.', 'danger');
    return;
  }
  const input = getEl('waInboxReplyInput');
  const btn = getEl('waInboxReplyBtn');
  const message = String(input?.value || '').trim();
  if (!message) return;

  if (btn) btn.disabled = true;
  socketClient.emit('inbox:reply', { chatJid: activeWaInboxJid, message });
  if (input) input.value = '';
}

// --- backup & restore konfigurasi bot (.json), config lanjutan & reset limit ---
function exportBotConfigJson() {
  socketClient.emit('config:export');
}

function handleImportBotConfigFile(event) {
  const file = event?.target?.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || '{}'));
      socketClient.emit('config:import', { config: parsed });
    } catch {
      showCyberToast('File Tidak Valid', 'Pastikan file yang dipilih berformat JSON yang benar.', 'danger');
    }
    if (event.target) event.target.value = '';
  };
  reader.readAsText(file);
}

function triggerResetAllUsersLimitNow() {
  const defaultLimit = parseInt(getEl('cfgDefaultLimitInput')?.value || '25', 10) || 25;
  socketClient.emit('manage:users:resetLimit', { defaultLimit });
}

function saveAdvancedBotSettings() {
  socketClient.emit('settings:update', {
    customMessages: {
      wait: String(getEl('cfgMsgWaitInput')?.value || '').trim(),
      limit: String(getEl('cfgMsgLimitInput')?.value || '').trim(),
      premium: String(getEl('cfgMsgPremiumInput')?.value || '').trim(),
      owner: String(getEl('cfgMsgOwnerInput')?.value || '').trim(),
      group: String(getEl('cfgMsgGroupInput')?.value || '').trim(),
      private: String(getEl('cfgMsgPrivateInput')?.value || '').trim()
    },
    prefixConfig: {
      prefixes: String(getEl('cfgPrefixesInput')?.value || '.!/#').trim(),
      cooldownSeconds: Number(getEl('cfgCooldownSecInput')?.value || 3),
      spamLimit: Number(getEl('cfgSpamLimitInput')?.value || 5),
      spamCooldownSeconds: Number(getEl('cfgSpamCooldownInput')?.value || 15)
    },
    menuConfig: {
      header: String(getEl('cfgMenuHeaderInput')?.value || '').trim(),
      footer: String(getEl('cfgMenuFooterInput')?.value || '').trim(),
      thumbnailUrl: String(getEl('cfgMenuThumbInput')?.value || '').trim()
    },
    limitConfig: {
      defaultLimit: parseInt(getEl('cfgDefaultLimitInput')?.value || '25', 10) || 25,
      resetHourWib: parseInt(getEl('cfgResetHourInput')?.value || '0', 10) || 0,
      autoResetEnabled: Boolean(getEl('cfgAutoResetLimitCheck')?.checked)
    }
  });
}

// --- visual auto-reply builder (sinkron dua arah dengan textarea) ---
function parseAutoReplyLinesToArray(rawText) {
  return String(rawText || '')
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('=');
      if (idx === -1) return null;
      const leftPart = line.slice(0, idx).trim();
      const rightPart = line.slice(idx + 1).trim();

      let matchType = 'exact';
      let trigger = leftPart;
      const pipeIdx = leftPart.indexOf('|');
      if (pipeIdx !== -1) {
        const modeCandidate = leftPart.slice(0, pipeIdx).trim().toLowerCase();
        trigger = leftPart.slice(pipeIdx + 1).trim();
        matchType = ['exact', 'contains', 'starts'].includes(modeCandidate) ? modeCandidate : 'exact';
      }

      let response = rightPart;
      let mediaType = 'text';
      let mediaUrl = '';
      const mediaParts = rightPart.split('|');
      if (mediaParts.length >= 3) {
        const possibleType = mediaParts[mediaParts.length - 2].trim().toLowerCase();
        const possibleUrl = mediaParts[mediaParts.length - 1].trim();
        if (['image', 'sticker', 'document'].includes(possibleType) && /^https?:\/\//i.test(possibleUrl)) {
          mediaType = possibleType;
          mediaUrl = possibleUrl;
          response = mediaParts.slice(0, -2).join('|').trim();
        }
      }

      return { matchType, trigger, response, mediaType, mediaUrl };
    })
    .filter((item) => item && item.trigger && (item.response || item.mediaUrl));
}

function serializeAutoReplyArrayToLines(rulesArray) {
  if (!Array.isArray(rulesArray)) return '';
  return rulesArray
    .map((rule) => {
      const base = `${rule.matchType || 'exact'}|${rule.trigger}=${rule.response || ''}`;
      if (rule.mediaType && rule.mediaType !== 'text' && rule.mediaUrl) {
        return `${base}|${rule.mediaType}|${rule.mediaUrl}`;
      }
      return base;
    })
    .join('\n');
}

function toggleAutoReplyEditorMode() {
  isAutoReplyRawMode = !isAutoReplyRawMode;
  const visualPanel = getEl('arVisualBuilderPanel');
  const rawPanel = getEl('arRawTextareaPanel');
  const toggleBtn = getEl('arModeToggleBtn');

  if (isAutoReplyRawMode) syncRawTextareaFromVisualRules();
  else syncVisualRulesFromRawTextarea();

  visualPanel?.classList.toggle('hidden', isAutoReplyRawMode);
  rawPanel?.classList.toggle('hidden', !isAutoReplyRawMode);
  if (toggleBtn) toggleBtn.textContent = isAutoReplyRawMode ? 'Mode Visual' : 'Mode Teks';
}

function toggleAutoReplyMediaField() {
  const mediaType = getEl('arMediaTypeSelect')?.value || 'text';
  getEl('arMediaUrlWrap')?.classList.toggle('hidden', mediaType === 'text');
}

function syncRawTextareaFromVisualRules() {
  const rawInput = getEl('cfgAutoReplyInput');
  if (rawInput) rawInput.value = serializeAutoReplyArrayToLines(visualAutoReplyRules);
}

function syncVisualRulesFromRawTextarea() {
  const rawInput = getEl('cfgAutoReplyInput');
  if (!rawInput) return;
  visualAutoReplyRules = parseAutoReplyLinesToArray(rawInput.value);
  renderVisualAutoReplyRules();
}

function resetAutoReplyBuilderForm() {
  if (getEl('arEditIndexInput')) getEl('arEditIndexInput').value = '-1';
  if (getEl('arTriggerInput')) getEl('arTriggerInput').value = '';
  if (getEl('arMatchTypeSelect')) getEl('arMatchTypeSelect').value = 'exact';
  if (getEl('arMediaTypeSelect')) getEl('arMediaTypeSelect').value = 'text';
  if (getEl('arMediaUrlInput')) getEl('arMediaUrlInput').value = '';
  if (getEl('arResponseInput')) getEl('arResponseInput').value = '';
  getEl('arCancelEditBtn')?.classList.add('hidden');
  if (getEl('arSubmitRuleBtn')) getEl('arSubmitRuleBtn').textContent = '+ Tambah Rule';
  toggleAutoReplyMediaField();
}

function renderVisualAutoReplyRules() {
  const listEl = getEl('arVisualRulesList');
  const countBadge = getEl('arRulesCountBadge');
  if (countBadge) countBadge.textContent = `${visualAutoReplyRules.length} rule`;
  if (!listEl) return;

  if (visualAutoReplyRules.length === 0) {
    listEl.innerHTML = '<p class="text-[11px] font-mono-code text-slate-500 text-center py-2">Belum ada aturan Auto-Reply.</p>';
    return;
  }

  listEl.innerHTML = visualAutoReplyRules.map((rule, idx) => {
    const matchLabelMap = { exact: 'EXACT', contains: 'CONTAINS', starts: 'STARTS' };
    const mediaBadge = rule.mediaType && rule.mediaType !== 'text'
      ? `<span class="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/30 text-sky-300 font-mono-code text-[9px] uppercase">${escapeHtmlString(rule.mediaType)}</span>`
      : '';

    return `
      <div class="rounded-lg bg-slate-900/90 border border-slate-800 px-3 py-2 flex items-start justify-between gap-2 text-xs">
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="px-1.5 py-0.5 rounded bg-slate-950 border border-slate-700 font-mono-code text-[9px] accent-text font-bold">${matchLabelMap[rule.matchType] || 'EXACT'}</span>
            <span class="font-mono-code font-bold text-white truncate">${escapeHtmlString(rule.trigger)}</span>
            ${mediaBadge}
          </div>
          <p class="text-[11px] text-slate-400 truncate">${escapeHtmlString(rule.response || rule.mediaUrl || '-')}</p>
        </div>
        <div class="flex items-center gap-1 shrink-0">
          <button type="button" onclick="editVisualAutoReplyRule(${idx})" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-[10px] font-semibold text-slate-200 transition-colors">Edit</button>
          <button type="button" onclick="deleteVisualAutoReplyRule(${idx})" class="px-2 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 text-[10px] font-semibold text-rose-300 transition-colors">Hapus</button>
        </div>
      </div>
    `;
  }).join('');
}

function upsertVisualAutoReplyRule() {
  const trigger = String(getEl('arTriggerInput')?.value || '').trim();
  const matchType = String(getEl('arMatchTypeSelect')?.value || 'exact').trim().toLowerCase();
  const mediaType = String(getEl('arMediaTypeSelect')?.value || 'text').trim().toLowerCase();
  const mediaUrl = String(getEl('arMediaUrlInput')?.value || '').trim();
  const response = String(getEl('arResponseInput')?.value || '').trim();
  const editIndex = parseInt(getEl('arEditIndexInput')?.value || '-1', 10);

  if (!trigger) {
    showCyberToast('Trigger Kosong', 'Isi kata pemicu (trigger) terlebih dahulu.', 'danger');
    return;
  }
  if (mediaType === 'text' && !response) {
    showCyberToast('Balasan Kosong', 'Isi teks balasan terlebih dahulu.', 'danger');
    return;
  }
  if (mediaType !== 'text' && !/^https?:\/\//i.test(mediaUrl)) {
    showCyberToast('URL Media Invalid', 'Masukkan URL media valid (http:// atau https://).', 'danger');
    return;
  }

  const nextRule = {
    trigger: trigger.slice(0, 80),
    matchType: ['exact', 'contains', 'starts'].includes(matchType) ? matchType : 'exact',
    mediaType: ['text', 'image', 'sticker', 'document'].includes(mediaType) ? mediaType : 'text',
    mediaUrl: mediaType !== 'text' ? mediaUrl.slice(0, 400) : '',
    response: response.slice(0, 500)
  };

  if (editIndex >= 0 && editIndex < visualAutoReplyRules.length) {
    visualAutoReplyRules[editIndex] = nextRule;
    showCyberToast('Rule Diperbarui', `Aturan "${nextRule.trigger}" diperbarui. Klik Simpan Pengaturan untuk menerapkan.`, 'info');
  } else {
    if (visualAutoReplyRules.length >= 30) {
      showCyberToast('Batas Tercapai', 'Maksimal 30 aturan Auto-Reply per bot.', 'danger');
      return;
    }
    visualAutoReplyRules.push(nextRule);
    showCyberToast('Rule Ditambahkan', `Aturan "${nextRule.trigger}" ditambahkan. Klik Simpan Pengaturan untuk menerapkan.`, 'success');
  }

  syncRawTextareaFromVisualRules();
  renderVisualAutoReplyRules();
  resetAutoReplyBuilderForm();
}

function editVisualAutoReplyRule(index) {
  const rule = visualAutoReplyRules[index];
  if (!rule) return;

  if (getEl('arEditIndexInput')) getEl('arEditIndexInput').value = String(index);
  if (getEl('arTriggerInput')) getEl('arTriggerInput').value = rule.trigger || '';
  if (getEl('arMatchTypeSelect')) getEl('arMatchTypeSelect').value = rule.matchType || 'exact';
  if (getEl('arMediaTypeSelect')) getEl('arMediaTypeSelect').value = rule.mediaType || 'text';
  if (getEl('arMediaUrlInput')) getEl('arMediaUrlInput').value = rule.mediaUrl || '';
  if (getEl('arResponseInput')) getEl('arResponseInput').value = rule.response || '';

  toggleAutoReplyMediaField();
  getEl('arCancelEditBtn')?.classList.remove('hidden');
  if (getEl('arSubmitRuleBtn')) getEl('arSubmitRuleBtn').textContent = 'Simpan Perubahan Rule';
  getEl('arTriggerInput')?.focus();
}

function deleteVisualAutoReplyRule(index) {
  if (index < 0 || index >= visualAutoReplyRules.length) return;
  const removed = visualAutoReplyRules.splice(index, 1)[0];
  syncRawTextareaFromVisualRules();
  renderVisualAutoReplyRules();
  resetAutoReplyBuilderForm();
  showCyberToast('Rule Dihapus', `Aturan "${removed?.trigger || '-'}" dihapus dari daftar.`, 'info');
}

// --- preset template 1-klik untuk ai persona & welcome grup ---
function applyAiPersonaPreset(presetKey) {
  const presets = {
    cs: 'Kamu adalah Customer Service ramah dari toko kami. Jawab pertanyaan pelanggan dengan singkat, sopan, informatif, dan selalu akhiri dengan menawarkan bantuan terkait produk, harga, atau cara pemesanan. Jam operasional: 08:00 - 22:00 WIB.',
    community: 'Kamu adalah asisten admin komunitas yang santai, suportif, dan ramah. Bantu anggota menjawab pertanyaan umum seputar aturan grup, jadwal kegiatan, serta ingatkan anggota agar tetap menjaga etika diskusi.',
    assistant: 'Kamu adalah asisten pribadi cerdas yang ringkas dan profesional. Bantu menjawab pertanyaan, merangkum informasi, dan memberikan saran praktis dalam bahasa Indonesia yang natural.'
  };
  const chosenPrompt = presets[presetKey];
  if (!chosenPrompt) return;

  if (getEl('cfgAiSystemPromptInput')) getEl('cfgAiSystemPromptInput').value = chosenPrompt;
  if (getEl('cfgAiEnabledCheck')) getEl('cfgAiEnabledCheck').checked = true;
  showCyberToast('Preset AI Diterapkan', 'Template System Prompt siap disimpan. Sesuaikan nama toko jika perlu.', 'info');
}

function applyGroupWelcomePreset(presetKey) {
  const presets = {
    community: 'Halo @user! Selamat datang di grup @group. Silakan perkenalkan diri dan patuhi aturan grup ya!',
    store: 'Selamat datang @user di @group! Ketik .menu atau .pricelist untuk melihat daftar layanan & promo terbaru kami.',
    formal: 'Selamat datang @user di grup resmi @group. Mohon membaca deskripsi grup dan menjaga etika berkomunikasi.'
  };
  const chosenText = presets[presetKey];
  if (!chosenText) return;

  if (getEl('groupCfgWelcomeText')) getEl('groupCfgWelcomeText').value = chosenText;
  if (getEl('groupCfgWelcomeCheck')) getEl('groupCfgWelcomeCheck').checked = true;
  showCyberToast('Preset Welcome', 'Template pesan selamat datang diterapkan.', 'info');
}

// --- command palette (ctrl + k) dan hotkeys global ---
function getCommandPaletteActions() {
  const actions = [
    { id: 'tab-dash', group: 'Navigasi', title: 'Buka Tab Dashboard', desc: 'Lihat metrik, koneksi WA, grafik & terminal CLI', run: () => switchWorkspaceTab('dashboard') },
    { id: 'tab-manage', group: 'Navigasi', title: 'Buka Tab Kelola Bot & Config', desc: 'Auto-Reply, Pesan Sistem, Prefix, Menu, Limit & User', run: () => switchWorkspaceTab('manage') },
    { id: 'go-community', group: 'Komunitas', title: 'Buka Xu Core Community (/chat)', desc: 'Ruang live chat komunitas, stiker Supabase & reaksi emoji', run: () => { window.location.href = '/chat'; } },
    { id: 'open-profile', group: 'Akun', title: 'Buka Settings Profile', desc: 'Ubah nama akun, foto profil, atau tutup akun', run: () => openProfileSettingsModal() },
    { id: 'open-wa-inbox', group: 'Live Chat', title: 'Buka WA Live Chat Inbox (Layar Penuh)', desc: 'Pantau dan balas pesan WhatsApp langsung dari browser', run: () => openLiveChatFullscreen('community') },
    { id: 'tab-api', group: 'Navigasi', title: 'Buka Tab API Gateway & Webhook', desc: 'Kelola API Key, Webhook Forwarder & Delivery Logs', run: () => switchWorkspaceTab('gateway') }
  ];

  if (isCurrentUserAdmin) {
    actions.push(
      { id: 'tab-ide', group: 'Admin', title: 'Buka Plugin IDE', desc: 'Edit, validasi, dan hot-reload plugin JavaScript', run: () => switchWorkspaceTab('developer') },
      { id: 'open-admin', group: 'Admin', title: 'Buka Panel Admin Eksklusif', desc: 'Monitor sesi global, pengumuman, voucher & perpanjangan', run: () => { window.location.href = '/admin'; } },
      { id: 'backup-zip', group: 'Admin', title: 'Unduh Backup ZIP Platform', desc: 'Ekspor arsip database.json & folder plugins', run: () => downloadPlatformBackupZip() }
    );
  }

  actions.push(
    { id: 'export-cfg', group: 'Aksi Cepat', title: 'Export Konfigurasi Bot (.json)', desc: 'Unduh backup seluruh pengaturan bot Anda', run: () => exportBotConfigJson() },
    { id: 'copy-uid', group: 'Aksi Cepat', title: 'Salin User ID Akun', desc: 'Salin ID akun Xu Core ke clipboard', run: () => copyCurrentGoogleId() },
    { id: 'sync-session', group: 'Aksi Cepat', title: 'Sinkronisasi Sesi & Statistik', desc: 'Muat ulang data real-time dari server', run: () => triggerManualSessionSync() },
    { id: 'redeem-voucher', group: 'Aksi Cepat', title: 'Redeem Kode Voucher', desc: 'Klaim kode trial atau bonus masa aktif', run: () => openVoucherRedeemModal() },
    { id: 'renew-plan', group: 'Aksi Cepat', title: 'Perpanjang Masa Aktif Paket', desc: 'Buka opsi perpanjangan langganan', run: () => openRenewModal() },
    { id: 'export-csv', group: 'Aksi Cepat', title: 'Export Daftar User ke CSV', desc: 'Unduh data nomor, limit & status premium (.csv)', run: () => exportManagedUsersToCsv() },
    { id: 'open-notif', group: 'Aksi Cepat', title: 'Buka Pusat Pemberitahuan', desc: 'Lihat pengumuman & pengaturan notifikasi Chrome', run: () => openAnnouncementCenterModal() },
    { id: 'open-security', group: 'Aksi Cepat', title: 'Keamanan & Ganti Kata Sandi', desc: 'Ubah sandi lokal atau reset via OTP WhatsApp', run: () => openAccountSecurityModal() },
    { id: 'restart-bot', group: 'Sesi WA', title: 'Soft Restart Koneksi Bot', desc: 'Hubungkan ulang sesi WhatsApp tanpa logout', run: () => triggerSoftRestartSession() },
    { id: 'clear-prekeys', group: 'Sesi WA', title: 'Bersihkan Cache Sesi (Clear Pre-Keys)', desc: 'Ringankan sesi tanpa menghapus creds.json', run: () => triggerClearPreKeys() },
    { id: 'theme-emerald', group: 'Tema', title: 'Tema: Emerald Green', desc: 'Ganti aksen dashboard ke Emerald', run: () => applyAccentTheme('emerald') },
    { id: 'theme-cyan', group: 'Tema', title: 'Tema: Cyber Cyan', desc: 'Ganti aksen dashboard ke Cyan', run: () => applyAccentTheme('cyan') },
    { id: 'theme-violet', group: 'Tema', title: 'Tema: Electric Violet', desc: 'Ganti aksen dashboard ke Violet', run: () => applyAccentTheme('violet') },
    { id: 'theme-mono', group: 'Tema', title: 'Tema: Minimalist Monochrome', desc: 'Ganti aksen dashboard ke Putih Monokrom', run: () => applyAccentTheme('mono') },
    { id: 'go-pricing', group: 'Halaman', title: 'Halaman Sewa / Beli Paket (QRIS)', desc: 'Buka katalog paket & riwayat transaksi QRIS', run: () => { window.location.href = '/sewa-beli-paket'; } },
    { id: 'go-docs', group: 'Halaman', title: 'Buka Dokumentasi Xu Core', desc: 'Panduan lengkap API & fitur', run: () => { window.location.href = '/dokumentasi'; } }
  );

  return actions;
}

function openCommandPalette() {
  if (!getEl('commandPaletteModal')) return;
  isCommandPaletteOpen = true;
  cmdPaletteSelectedIndex = 0;
  const input = getEl('cmdPaletteInput');
  if (input) input.value = '';
  toggleModalVisibility('commandPaletteModal', true);
  renderCommandPaletteResults();
  setTimeout(() => input?.focus(), 20);
}

function closeCommandPalette() {
  isCommandPaletteOpen = false;
  toggleModalVisibility('commandPaletteModal', false);
}

function renderCommandPaletteResults() {
  const container = getEl('cmdPaletteResultsList');
  if (!container) return;

  const query = String(getEl('cmdPaletteInput')?.value || '').trim().toLowerCase();
  const allActions = getCommandPaletteActions();

  cmdPaletteFilteredActions = allActions.filter((item) => {
    if (!query) return true;
    return (
      item.title.toLowerCase().includes(query) ||
      item.desc.toLowerCase().includes(query) ||
      item.group.toLowerCase().includes(query)
    );
  });

  if (cmdPaletteSelectedIndex >= cmdPaletteFilteredActions.length) {
    cmdPaletteSelectedIndex = Math.max(0, cmdPaletteFilteredActions.length - 1);
  }

  if (cmdPaletteFilteredActions.length === 0) {
    container.innerHTML = '<div class="py-6 text-center text-xs font-mono-code text-slate-500">Tidak ada aksi yang cocok.</div>';
    return;
  }

  container.innerHTML = cmdPaletteFilteredActions.map((item, idx) => {
    const isActive = idx === cmdPaletteSelectedIndex;
    return `
      <button type="button" onclick="executeCommandPaletteAction(${idx})" onmouseenter="cmdPaletteSelectedIndex = ${idx}; updateCommandPaletteHighlight();" data-cmd-idx="${idx}" class="cmd-palette-item w-full text-left px-3 py-2.5 rounded-xl flex items-center justify-between gap-3 transition-colors ${isActive ? 'bg-slate-800/90 border accent-border' : 'border border-transparent hover:bg-slate-900'}">
        <div class="min-w-0">
          <p class="text-xs font-bold text-white truncate">${escapeHtmlString(item.title)}</p>
          <p class="text-[10px] text-slate-400 truncate mt-0.5">${escapeHtmlString(item.desc)}</p>
        </div>
        <span class="px-2 py-0.5 rounded bg-slate-950 border border-slate-800 font-mono-code text-[9px] text-slate-400 shrink-0">${escapeHtmlString(item.group)}</span>
      </button>
    `;
  }).join('');
}

function updateCommandPaletteHighlight() {
  document.querySelectorAll('.cmd-palette-item').forEach((el) => {
    const idx = Number(el.getAttribute('data-cmd-idx'));
    const isActive = idx === cmdPaletteSelectedIndex;
    el.className = `cmd-palette-item w-full text-left px-3 py-2.5 rounded-xl flex items-center justify-between gap-3 transition-colors ${isActive ? 'bg-slate-800/90 border accent-border' : 'border border-transparent hover:bg-slate-900'}`;
  });
}

function executeCommandPaletteAction(index) {
  const action = cmdPaletteFilteredActions[index];
  closeCommandPalette();
  if (action && typeof action.run === 'function') action.run();
}

function setupGlobalHotkeys() {
  document.addEventListener('keydown', (event) => {
    const key = String(event.key || '').toLowerCase();
    if ((event.ctrlKey || event.metaKey) && key === 'k' && getEl('commandPaletteModal')) {
      event.preventDefault();
      if (isCommandPaletteOpen) closeCommandPalette();
      else openCommandPalette();
      return;
    }

    if (key === 'escape') {
      if (isCommandPaletteOpen) {
        event.preventDefault();
        closeCommandPalette();
        return;
      }
      if (isLiveChatFullscreenOpen) {
        event.preventDefault();
        closeLiveChatFullscreen();
        return;
      }
      if (activeFloatingMessageId) closeMessageActionPopup();
      if (activeDetailReactionMessageId) closeReactionDetailSheet();
      if (isStickerSheetOpen) closeStickerBottomSheet();
      if (activeInspectStickerUrl) closeStickerFavoriteSheet();
      if (isChatAttachMenuOpen) closeChatAttachMenu();
      if (isMembersDrawerOpen) toggleMembersDrawer(false);
      closePinnedMessagesModal();
      closeChatMediaLightbox();
      closeProfileSettingsModal();
      return;
    }

    if (!isCommandPaletteOpen) return;

    if (key === 'arrowdown') {
      event.preventDefault();
      if (cmdPaletteFilteredActions.length > 0) {
        cmdPaletteSelectedIndex = (cmdPaletteSelectedIndex + 1) % cmdPaletteFilteredActions.length;
        updateCommandPaletteHighlight();
      }
    } else if (key === 'arrowup') {
      event.preventDefault();
      if (cmdPaletteFilteredActions.length > 0) {
        cmdPaletteSelectedIndex = (cmdPaletteSelectedIndex - 1 + cmdPaletteFilteredActions.length) % cmdPaletteFilteredActions.length;
        updateCommandPaletteHighlight();
      }
    } else if (key === 'enter') {
      event.preventDefault();
      executeCommandPaletteAction(cmdPaletteSelectedIndex);
    }
  });
}

// --- alias kompatibilitas untuk setupCommandPaletteHotkeys ---
function setupCommandPaletteHotkeys() {
  setupGlobalHotkeys();
}

// --- webhook delivery logs real-time ---
function renderWebhookDeliveryLogs(logsInput) {
  if (Array.isArray(logsInput)) webhookDeliveryLogsCache = logsInput;

  const listEl = getEl('webhookDeliveryLogsList');
  const countBadge = getEl('webhookLogsCountBadge');
  if (countBadge) countBadge.textContent = `${webhookDeliveryLogsCache.length} log`;
  if (!listEl) return;

  if (webhookDeliveryLogsCache.length === 0) {
    listEl.innerHTML = '<div class="rounded-xl bg-slate-950/60 border border-dashed border-slate-800 p-4 text-center text-[11px] font-mono-code text-slate-500">Belum ada riwayat pengiriman webhook.</div>';
    return;
  }

  listEl.innerHTML = webhookDeliveryLogsCache.map((entry) => {
    const isOk = Boolean(entry.isSuccess);
    const statusLabel = entry.statusCode ? `${entry.statusCode} ${isOk ? 'OK' : 'ERR'}` : 'FAIL';
    const statusCls = isOk
      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35'
      : 'bg-rose-500/15 text-rose-300 border-rose-500/35';

    return `
      <div class="rounded-xl bg-slate-950/85 border border-slate-800/90 px-3 py-2.5 space-y-1 text-[11px] font-mono-code">
        <div class="flex items-center justify-between gap-2">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="px-1.5 py-0.5 rounded border text-[9px] font-bold shrink-0 ${statusCls}">${escapeHtmlString(statusLabel)}</span>
            <span class="text-slate-200 font-semibold truncate">${escapeHtmlString(entry.event || 'message.received')}</span>
          </div>
          <span class="text-[10px] text-slate-400 shrink-0">${Number(entry.durationMs || 0)}ms</span>
        </div>
        <div class="flex items-center justify-between gap-2 text-[10px] text-slate-500">
          <span class="truncate">${escapeHtmlString(entry.url || '-')}</span>
          <span class="shrink-0">${escapeHtmlString(formatWibDateTime(entry.timestamp))}</span>
        </div>
        ${entry.errorMessage ? `<p class="text-[10px] text-rose-400 truncate">${escapeHtmlString(entry.errorMessage)}</p>` : ''}
      </div>
    `;
  }).join('');
}

function clearWebhookDeliveryLogsUI() {
  if (webhookDeliveryLogsCache.length === 0) {
    showCyberToast('Log Kosong', 'Tidak ada riwayat webhook yang perlu dibersihkan.', 'info');
    return;
  }
  socketClient.emit('webhook:logs:clear');
}

// --- export daftar user & statistik ke csv ---
function escapeCsvCell(rawValue) {
  const str = String(rawValue ?? '');
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

function exportManagedUsersToCsv() {
  const rowsSource = getFilteredManagedUsers();
  const targetList = rowsSource.length > 0 ? rowsSource : managedUsersCache;

  if (!Array.isArray(targetList) || targetList.length === 0) {
    showCyberToast('Data Kosong', 'Belum ada data user untuk diekspor ke CSV.', 'danger');
    return;
  }

  const header = ['JID', 'Nomor', 'Nama', 'Limit', 'Premium_Reseller', 'Status_Banned', 'Tipe_ID'];
  const csvLines = [header.join(',')];

  for (const user of targetList) {
    const isLid = String(user.jid || '').endsWith('@lid');
    csvLines.push([
      escapeCsvCell(user.jid || ''),
      escapeCsvCell(user.number || ''),
      escapeCsvCell(user.name || ''),
      escapeCsvCell(Number(user.limit || 0)),
      escapeCsvCell(user.premium ? 'Premium' : 'Reguler'),
      escapeCsvCell(user.banned ? 'Banned' : 'Aktif'),
      escapeCsvCell(isLid ? 'LID' : 'JID')
    ].join(','));
  }

  const csvContent = `\uFEFF${csvLines.join('\n')}`;
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `xu-core-users-${stamp}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  showCyberToast('Export CSV Berhasil', `${targetList.length} data user berhasil diunduh.`, 'success');
}

// --- foto profil whatsapp bot dari web ---
function handleBrandingAvatarSelect(event) {
  const file = event?.target?.files?.[0];
  const infoEl = getEl('brandingAvatarFileInfo');
  const previewImg = getEl('brandingAvatarPreviewImg');
  const clearBtn = getEl('brandingClearAvatarBtn');

  if (!file) {
    clearBrandingAvatarFile();
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    showCyberToast('Gambar Terlalu Besar', 'Maksimal ukuran foto profil WhatsApp adalah 5 MB.', 'danger');
    clearBrandingAvatarFile();
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    brandingAvatarBase64Payload = String(reader.result || '');
    if (previewImg && brandingAvatarBase64Payload) previewImg.src = brandingAvatarBase64Payload;
    if (infoEl) infoEl.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
    clearBtn?.classList.remove('hidden');
  };
  reader.readAsDataURL(file);
}

function clearBrandingAvatarFile() {
  brandingAvatarBase64Payload = '';
  const fileInput = getEl('brandingAvatarFileInput');
  const infoEl = getEl('brandingAvatarFileInfo');
  const clearBtn = getEl('brandingClearAvatarBtn');
  const botAvatar = getEl('botProfileAvatar');
  const previewImg = getEl('brandingAvatarPreviewImg');

  if (fileInput) fileInput.value = '';
  if (infoEl) infoEl.textContent = 'JPG/PNG/WebP maks 5 MB';
  clearBtn?.classList.add('hidden');
  if (previewImg && botAvatar?.src) previewImg.src = botAvatar.src;
}

function submitBotWhatsappBranding() {
  if (!brandingAvatarBase64Payload) {
    showCyberToast('Foto Belum Dipilih', 'Pilih gambar foto profil terlebih dahulu.', 'danger');
    return;
  }

  const btn = getEl('brandingSubmitBtn');
  if (btn) btn.disabled = true;
  socketClient.emit('bot:branding:update', { avatarBase64: brandingAvatarBase64Payload });
  showCyberToast('Memperbarui Foto', 'Mengirim foto profil baru ke akun WhatsApp bot...', 'info');
}

// --- manajemen pengumuman & pusat notifikasi ---
function getReadAnnouncementIdsSet() {
  try {
    const raw = JSON.parse(localStorage.getItem(READ_ANNOUNCEMENTS_STORAGE_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

function saveReadAnnouncementIdsSet(idSet) {
  try {
    localStorage.setItem(READ_ANNOUNCEMENTS_STORAGE_KEY, JSON.stringify(Array.from(idSet).slice(-100)));
  } catch {}
}

function getCategoryBadgeStyle(category) {
  const normalized = String(category || 'INFO').toUpperCase();
  const map = {
    INFO: 'bg-sky-500/15 text-sky-300 border border-sky-500/30',
    SUCCESS: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
    WARN: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
    DANGER: 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
  };
  return { label: map[normalized] ? normalized : 'INFO', cls: map[normalized] || map.INFO };
}

function renderAnnouncementsCenterUI(listInput) {
  if (Array.isArray(listInput)) announcementsCache = listInput;

  const readSet = getReadAnnouncementIdsSet();
  const unreadCount = announcementsCache.filter((item) => !readSet.has(item.id)).length;
  const badgeEl = getEl('announcementUnreadBadge');

  if (badgeEl) {
    if (unreadCount > 0) {
      badgeEl.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
      badgeEl.classList.remove('hidden');
    } else {
      badgeEl.classList.add('hidden');
    }
  }

  const modalListEl = getEl('announcementModalList');
  if (modalListEl) {
    if (announcementsCache.length === 0) {
      modalListEl.innerHTML = '<div class="rounded-xl bg-[#111726] border border-dashed border-slate-800 p-4 text-center text-[11px] text-slate-500 font-mono-code">Belum ada pemberitahuan resmi saat ini.</div>';
    } else {
      modalListEl.innerHTML = announcementsCache.map((item) => {
        const badge = getCategoryBadgeStyle(item.category);
        const isUnread = !readSet.has(item.id);
        return `
          <article class="rounded-xl bg-[#111726] border ${isUnread ? 'border-sky-500/35' : 'border-slate-800/90 opacity-85'} p-3 space-y-1.5 transition-all">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1.5">
                <span class="px-2 py-0.5 rounded font-mono-code text-[9px] font-bold uppercase tracking-wider ${badge.cls}">${badge.label}</span>
                ${isUnread ? '<span class="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse"></span>' : ''}
              </div>
            </div>
            <p class="text-[10px] font-mono-code text-slate-400 leading-none pt-0.5">${escapeHtmlString(formatWibDateTime(item.createdAt))}</p>
            <h4 class="text-xs font-bold text-white leading-snug">${escapeHtmlString(item.title || 'Pengumuman / Update Panel')}</h4>
            <div class="text-[11px] text-slate-300 leading-snug whitespace-pre-wrap break-words [overflow-wrap:anywhere]">${escapeHtmlString(item.text)}</div>
          </article>
        `;
      }).join('');
    }
  }
}

function renderGlobalAnnouncementBanner(announcementPayload) {
  if (Array.isArray(announcementPayload)) {
    renderAnnouncementsCenterUI(announcementPayload);
    return;
  }
  if (announcementPayload && typeof announcementPayload === 'object') {
    const cleanText = String(announcementPayload.text || '').trim();
    if (!cleanText) {
      renderAnnouncementsCenterUI([]);
      return;
    }
    const updatedAt = Number(announcementPayload.updatedAt || Date.now());
    const legacyItem = {
      id: `ann_legacy_${updatedAt}`,
      title: String(announcementPayload.title || 'Pengumuman / Update Panel'),
      category: String(announcementPayload.level || announcementPayload.category || 'INFO').toUpperCase(),
      text: cleanText,
      createdAt: updatedAt
    };
    const existingWithoutLegacy = announcementsCache.filter((item) => !String(item.id || '').startsWith('ann_legacy_'));
    const existsSameText = existingWithoutLegacy.some((item) => item.text === legacyItem.text);
    renderAnnouncementsCenterUI(existsSameText ? existingWithoutLegacy : [legacyItem, ...existingWithoutLegacy]);
    return;
  }
  renderAnnouncementsCenterUI(announcementsCache);
}

function openAnnouncementCenterModal() {
  syncBrowserNotifLabel();
  renderAnnouncementsCenterUI(announcementsCache);
  toggleModalVisibility('announcementCenterModal', true);
}

function closeAnnouncementCenterModal() {
  toggleModalVisibility('announcementCenterModal', false);
}

function markAllAnnouncementsAsRead() {
  const readSet = getReadAnnouncementIdsSet();
  announcementsCache.forEach((item) => readSet.add(item.id));
  saveReadAnnouncementIdsSet(readSet);
  renderAnnouncementsCenterUI(announcementsCache);
  showCyberToast('Notifikasi', 'Semua pemberitahuan ditandai sudah dibaca.', 'info');
}
// --- grafik high-amplitude: traffic velocity, cpu heartbeat, dan 7-day traffic ---
function hexToRgba(hexColor, alpha) {
  const cleanHex = hexColor.replace('#', '').trim();
  const fullHex = cleanHex.length === 3 ? cleanHex.split('').map((char) => char + char).join('') : cleanHex;
  const num = parseInt(fullHex, 16);
  if (Number.isNaN(num)) return `rgba(16, 185, 129, ${alpha})`;
  return `rgba(${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}, ${alpha})`;
}

function getActiveAccentColor() {
  return getComputedStyle(document.documentElement).getPropertyValue('--accent-main').trim() || '#10b981';
}

function buildCpuGradient(ctx, accentHex) {
  const gradient = ctx.createLinearGradient(0, 0, 0, 176);
  gradient.addColorStop(0, hexToRgba(accentHex, 0.38));
  gradient.addColorStop(0.65, hexToRgba(accentHex, 0.1));
  gradient.addColorStop(1, hexToRgba(accentHex, 0.0));
  return gradient;
}

function initTrafficVelocityChart() {
  const canvas = getEl('trafficVelocityChart');
  if (!canvas || typeof Chart === 'undefined' || trafficVelocityChartInstance) return;

  const ctx = canvas.getContext('2d');
  const areaGradient = ctx.createLinearGradient(0, 0, 0, 288);
  areaGradient.addColorStop(0, 'rgba(255, 255, 255, 0.24)');
  areaGradient.addColorStop(0.65, 'rgba(255, 255, 255, 0.06)');
  areaGradient.addColorStop(1, 'rgba(255, 255, 255, 0.0)');

  trafficVelocityChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: ['-18s', '-15s', '-12s', '-9s', '-6s', '-3s', 'Now'],
      datasets: [{
        label: 'Throughput',
        data: [0, 0, 0, 0, 0, 0, 0],
        borderColor: '#ffffff',
        borderWidth: 2.6,
        backgroundColor: areaGradient,
        fill: true,
        tension: 0.28,
        pointRadius: 4.5,
        pointHoverRadius: 7,
        pointBackgroundColor: '#ffffff',
        pointBorderColor: '#050810',
        pointBorderWidth: 1.5
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 220 },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(9, 13, 22, 0.95)',
          titleColor: '#94a3b8',
          bodyColor: '#ffffff',
          borderColor: 'rgba(148, 163, 184, 0.25)',
          borderWidth: 1,
          displayColors: false,
          callbacks: { label: (ctxItem) => `${ctxItem.parsed.y} req / 3s` }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(148, 163, 184, 0.08)' },
          border: { display: false },
          ticks: { color: 'rgba(148, 163, 184, 0.75)', font: { family: 'JetBrains Mono', size: 10 } }
        },
        y: {
          min: 0,
          max: 3,
          border: { display: false },
          grid: { color: 'rgba(148, 163, 184, 0.09)', drawTicks: false },
          ticks: {
            precision: 0,
            maxTicksLimit: 5,
            color: 'rgba(148, 163, 184, 0.7)',
            font: { family: 'JetBrains Mono', size: 10 }
          }
        }
      }
    }
  });
}

function updateLiveTrafficVelocityUI(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return;
  if (!getEl('trafficVelocityChart')) return;
  if (!trafficVelocityChartInstance) initTrafficVelocityChart();

  const reqPerSecEl = getEl('liveReqPerSecValue');
  if (reqPerSecEl && snapshot.reqPerSec !== undefined) {
    reqPerSecEl.textContent = Number(snapshot.reqPerSec || 0).toFixed(1);
  }

  if (trafficVelocityChartInstance && Array.isArray(snapshot.series)) {
    const numericSeries = snapshot.series.map((val) => Math.max(0, Number(val || 0)));
    const minVal = Math.min(...numericSeries);
    const maxVal = Math.max(...numericSeries);
    const spread = maxVal - minVal;

    const dynamicMin = minVal > 1 && spread > 0 ? Math.max(0, Math.floor(minVal - Math.max(1, spread * 0.15))) : 0;
    const dynamicMax = maxVal === 0 ? 2 : Math.max(dynamicMin + 2, Math.ceil(maxVal + Math.max(1, spread * 0.12)));

    trafficVelocityChartInstance.data.labels = Array.isArray(snapshot.labels)
      ? snapshot.labels
      : ['-18s', '-15s', '-12s', '-9s', '-6s', '-3s', 'Now'];
    trafficVelocityChartInstance.data.datasets[0].data = numericSeries;
    trafficVelocityChartInstance.options.scales.y.min = dynamicMin;
    trafficVelocityChartInstance.options.scales.y.max = dynamicMax;
    trafficVelocityChartInstance.update('active');
  }

  if (!isCurrentUserAdmin) return;
  const endpointsContainer = getEl('topActiveEndpointsList');
  if (endpointsContainer && Array.isArray(snapshot.topEndpoints)) {
    if (snapshot.topEndpoints.length === 0) {
      endpointsContainer.innerHTML = '<p class="text-[11px] font-mono-code text-slate-500">Menunggu aktivitas endpoint &amp; pesan masuk...</p>';
      return;
    }

    const hitValues = snapshot.topEndpoints.map((ep) => Math.max(0, Number(ep.hits || 0)));
    const maxHits = Math.max(...hitValues, 1);
    const minHits = Math.min(...hitValues);
    const hitRange = maxHits - minHits;

    endpointsContainer.innerHTML = snapshot.topEndpoints.map((ep, idx) => {
      const currentHits = Math.max(0, Number(ep.hits || 0));
      const normalizedRatio = hitRange > 0 ? (currentHits - minHits) / hitRange : currentHits / maxHits;
      const pct = hitRange > 0
        ? Math.round(18 + Math.pow(normalizedRatio, 0.85) * 82)
        : Math.max(12, Math.min(100, Math.round((currentHits / maxHits) * 100)));

      return `
        <div class="rounded-xl bg-slate-950/85 border border-slate-800/90 px-3 py-2.5 space-y-2">
          <div class="flex items-center justify-between gap-2 font-mono-code text-[11px]">
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-slate-500 font-bold">#${idx + 1}</span>
              <span class="px-1.5 py-0.5 rounded bg-slate-800 text-slate-200 text-[9px] font-bold uppercase shrink-0">${escapeHtmlString(ep.method || 'GET')}</span>
              <span class="text-slate-200 truncate">${escapeHtmlString(ep.path || '/')}</span>
            </div>
            <span class="text-slate-300 font-semibold shrink-0">${currentHits} reqs</span>
          </div>
          <div class="h-1 w-full rounded-full bg-slate-900 overflow-hidden">
            <div class="h-full bg-white rounded-full transition-all duration-300" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    }).join('');
  }
}

function initCpuHeartbeatChart() {
  const canvas = getEl('cpuHeartbeatChart');
  if (!canvas || typeof Chart === 'undefined' || cpuChartInstance) return;

  const ctx = canvas.getContext('2d');
  const accentColor = getActiveAccentColor();

  cpuChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array(MAX_CPU_POINTS).fill(''),
      datasets: [{
        label: 'CPU %',
        data: Array(MAX_CPU_POINTS).fill(0),
        borderColor: accentColor,
        borderWidth: 2.4,
        backgroundColor: buildCpuGradient(ctx, accentColor),
        fill: true,
        tension: 0.22,
        pointRadius: 0,
        pointHoverRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 200 },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: {
          min: 0,
          max: 15,
          border: { display: false },
          grid: { color: 'rgba(148, 163, 184, 0.08)', drawTicks: false },
          ticks: {
            maxTicksLimit: 4,
            color: 'rgba(148, 163, 184, 0.6)',
            font: { family: 'JetBrains Mono', size: 9 },
            callback: (val) => `${Math.round(val)}%`
          }
        }
      }
    }
  });
}

function pushSystemMetricsPoint(payload) {
  if (!getEl('cpuHeartbeatChart')) return;
  const cpuPercentage = typeof payload === 'number' ? payload : (payload?.usage ?? 0);
  if (cpuChartInstance) {
    const clampedValue = Math.max(0, Math.min(100, Number(cpuPercentage) || 0));
    const dataset = cpuChartInstance.data.datasets[0];
    cpuChartInstance.data.labels.shift();
    cpuChartInstance.data.labels.push('');
    dataset.data.shift();
    dataset.data.push(clampedValue);

    const peakCpu = Math.max(...dataset.data, 1);
    const floorCpu = Math.min(...dataset.data);
    const cpuSpread = peakCpu - floorCpu;
    const nextMin = floorCpu > 4 && cpuSpread > 0 ? Math.max(0, Math.floor(floorCpu - Math.max(1.5, cpuSpread * 0.2))) : 0;
    const nextMax = Math.min(100, Math.max(nextMin + 4, Math.ceil(peakCpu * 1.18)));

    cpuChartInstance.options.scales.y.min = nextMin;
    cpuChartInstance.options.scales.y.max = nextMax;
    cpuChartInstance.update('none');

    const valueEl = getEl('cpuUsageValue');
    const sourceEl = getEl('cpuSourceBadge');
    if (valueEl) valueEl.textContent = `${clampedValue.toFixed(1)}%`;
    if (sourceEl) {
      sourceEl.textContent = 'LIVE';
      sourceEl.className = 'px-1.5 py-0.5 rounded accent-soft-bg accent-text border accent-border';
    }
  }

  if (payload && typeof payload === 'object') {
    const ramEl = getEl('ramUsageValue');
    const diskEl = getEl('volumeDiskValue');
    if (ramEl && payload.ramRssMb !== undefined) {
      ramEl.textContent = `${payload.ramRssMb} MB`;
      ramEl.title = `Heap: ${payload.ramHeapMb} MB / Total OS: ${payload.ramTotalMb} MB`;
    }
    if (diskEl && payload.volumeSizeLabel) diskEl.textContent = payload.volumeSizeLabel;
  }
}

function initTrafficHistoryChart() {
  const canvas = getEl('trafficHistoryChart');
  if (!canvas || typeof Chart === 'undefined' || trafficChartInstance) return;

  trafficChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: [],
      datasets: [
        { label: 'Masuk', data: [], backgroundColor: 'rgba(16, 185, 129, 0.78)', borderRadius: 5 },
        { label: 'Keluar', data: [], backgroundColor: 'rgba(56, 189, 248, 0.78)', borderRadius: 5 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          labels: { color: '#94a3b8', boxWidth: 10, font: { family: 'JetBrains Mono', size: 9 } }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: 'rgba(148, 163, 184, 0.65)', font: { family: 'JetBrains Mono', size: 9 } } },
        y: { beginAtZero: true, border: { display: false }, grid: { color: 'rgba(148, 163, 184, 0.07)' }, ticks: { precision: 0, color: 'rgba(148, 163, 184, 0.55)', font: { family: 'JetBrains Mono', size: 9 } } }
      }
    }
  });
}

function updateTrafficHistoryChart(trafficInput) {
  if (!getEl('trafficHistoryChart')) return;
  if (!trafficChartInstance) initTrafficHistoryChart();
  if (!trafficChartInstance || !trafficInput) return;

  if (Array.isArray(trafficInput)) {
    latestTrafficSeries = trafficInput;
    trafficChartInstance.data.labels = trafficInput.map((item) => item.label || String(item.date || '').slice(5));
    trafficChartInstance.data.datasets[0].data = trafficInput.map((item) => Number(item.in || 0));
    trafficChartInstance.data.datasets[1].data = trafficInput.map((item) => Number(item.out || 0));
    trafficChartInstance.update('none');
    return;
  }

  if (typeof trafficInput === 'object') {
    const keys = Object.keys(trafficInput).sort();
    trafficChartInstance.data.labels = keys.map((dateKey) => dateKey.slice(5));
    trafficChartInstance.data.datasets[0].data = keys.map((dateKey) => Number(trafficInput[dateKey]?.in || 0));
    trafficChartInstance.data.datasets[1].data = keys.map((dateKey) => Number(trafficInput[dateKey]?.out || 0));
    trafficChartInstance.update('none');
  }
}

// --- ganti tema aksen dengan transisi melingkar view transition ---
function applyAccentTheme(themeName, notify = true) {
  const executeApply = () => {
    document.documentElement.setAttribute('data-theme', themeName);
    try { localStorage.setItem('jadibot_theme_pref', themeName); } catch {}
    if (cpuChartInstance) {
      const accentColor = getActiveAccentColor();
      cpuChartInstance.data.datasets[0].borderColor = accentColor;
      cpuChartInstance.data.datasets[0].backgroundColor = buildCpuGradient(cpuChartInstance.ctx, accentColor);
      cpuChartInstance.update('none');
    }
  };

  if (document.startViewTransition) {
    const centerX = window.innerWidth / 2;
    const centerY = window.innerHeight / 2;
    const endRadius = Math.hypot(centerX, centerY);
    const transition = document.startViewTransition(executeApply);
    transition.ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${centerX}px ${centerY}px)`, `circle(${endRadius}px at ${centerX}px ${centerY}px)`] },
        { duration: 500, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', pseudoElement: '::view-transition-new(root)' }
      );
    });
  } else {
    executeApply();
  }

  if (notify) showCyberToast('Tema Diubah', `Tema aksen aktif: ${themeName.toUpperCase()}`, 'info');
}

// --- notifikasi browser & dropdown menu akun ---
function syncBrowserNotifLabel() {
  const statusEl = getEl('browserNotifStatusLabel');
  const modalBtn = getEl('modalEnableNotifBtn');
  const isGranted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  if (statusEl) statusEl.textContent = isGranted ? 'On' : 'Off';
  if (modalBtn) {
    modalBtn.textContent = isGranted ? 'Aktif' : 'Aktifkan';
    modalBtn.className = isGranted
      ? 'px-3 py-1 rounded-lg bg-emerald-500/20 border border-emerald-500/35 text-emerald-300 font-bold text-[11px] shrink-0'
      : 'px-2.5 py-1 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 font-bold text-[11px] shrink-0 transition-all active:scale-95';
  }
}

async function requestBrowserNotificationPermission() {
  if (typeof Notification === 'undefined') {
    showCyberToast('Tidak Didukung', 'Browser Anda tidak mendukung notifikasi desktop.', 'danger');
    return;
  }
  const permission = await Notification.requestPermission();
  syncBrowserNotifLabel();
  showCyberToast('Notifikasi Browser', permission === 'granted' ? 'Alert putus koneksi diaktifkan.' : 'Izin notifikasi ditolak.', permission === 'granted' ? 'success' : 'danger');
}

function notifyBotDisconnectIfAllowed(reasonText) {
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    new Notification('Xu Core — Koneksi Terputus', {
      body: reasonText || 'Sesi WhatsApp Anda terputus. Buka dashboard untuk memeriksa.'
    });
  }
}

function toggleUserDropdownMenu(event) {
  if (event) event.stopPropagation();
  const popupMenu = getEl('userDropdownMenuPopup');
  if (popupMenu) popupMenu.classList.toggle('hidden');
}

function copyCurrentGoogleId() {
  copyTextToClipboard(currentGoogleUserId, 'User ID Disalin', 'User ID belum tersedia.');
}

function triggerManualSessionSync() {
  socketClient.emit('session:sync');
  if (isCurrentUserAdmin) socketClient.emit('admin:sessions:list');
  showCyberToast('Sinkronisasi', 'Memuat ulang status sesi dan statistik...', 'info');
}

async function logoutGoogleAccount() {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {}
  if (socketClient.connected) socketClient.disconnect();
  window.location.replace('/login');
}

// --- navigasi workspace dashboard & pengalih mode autentikasi wa ---
function switchWorkspaceTab(targetTab) {
  if (targetTab === 'developer' && !isCurrentUserAdmin) {
    showTopToast('Tab IDE khusus admin platform', true);
    return;
  }

  activeWorkspaceTab = targetTab;

  const views = {
    dashboard: getEl('workspaceDashboardView'),
    manage: getEl('workspaceManageView'),
    gateway: getEl('workspaceGatewayView'),
    developer: getEl('workspaceDeveloperView')
  };

  const buttons = {
    dashboard: getEl('navTabDashboard'),
    manage: getEl('navTabManage'),
    gateway: getEl('navTabGateway'),
    developer: getEl('navTabDeveloper')
  };

  const activeTabClasses = 'header-nav-btn gap-1.5 text-[11px] font-semibold accent-bg text-slate-950 whitespace-nowrap shadow-sm';
  const inactiveTabClasses = 'header-nav-btn gap-1.5 text-[11px] font-semibold text-slate-400 hover:text-slate-100 whitespace-nowrap';

  for (const [key, sectionEl] of Object.entries(views)) {
    if (!sectionEl) continue;
    sectionEl.classList.toggle('hidden', key !== targetTab);
    sectionEl.classList.toggle('grid', key === targetTab);
  }

  for (const [key, btnEl] of Object.entries(buttons)) {
    if (!btnEl) continue;
    if (key === 'developer' && !isCurrentUserAdmin) continue;
    btnEl.className = key === targetTab ? activeTabClasses : inactiveTabClasses;
  }

  if (targetTab === 'dashboard') {
    if (trafficVelocityChartInstance) trafficVelocityChartInstance.resize();
    if (cpuChartInstance) cpuChartInstance.resize();
    if (trafficChartInstance) trafficChartInstance.resize();
  }
  if (targetTab === 'manage') {
    requestManagedEntities('all');
    socketClient.emit('schedule:list');
    renderFeatureCatalogUI();
    renderVisualAutoReplyRules();
  }
  if (targetTab === 'gateway') {
    updateGatewayPayloadPreview();
    renderWebhookDeliveryLogs(webhookDeliveryLogsCache);
  }
}

function switchAuthMode(mode) {
  const isPairing = mode === 'pairing';
  getEl('qrCodeAuthPanel')?.classList.toggle('hidden', isPairing);
  getEl('pairingCodeAuthPanel')?.classList.toggle('hidden', !isPairing);
  const activeCls = 'py-2 rounded-lg text-xs font-semibold transition-all accent-bg text-slate-950';
  const inactiveCls = 'py-2 rounded-lg text-xs font-semibold transition-all text-slate-400 hover:text-white';
  if (getEl('authTabQrBtn')) getEl('authTabQrBtn').className = isPairing ? inactiveCls : activeCls;
  if (getEl('authTabPairingBtn')) getEl('authTabPairingBtn').className = isPairing ? activeCls : inactiveCls;
}

// --- sinkronisasi monitor global & ai persona badges ---
function syncFromGlobalMonitorSnapshot(monitorSnapshot) {
  if (!monitorSnapshot || typeof monitorSnapshot !== 'object') return;

  const summary = monitorSnapshot.summary;
  if (summary) {
    if (getEl('globalActiveBotsCount')) getEl('globalActiveBotsCount').textContent = Number(summary.onlineCount || 0);
    const connWrap = getEl('globalMonitorConnectingWrap');
    const connEl = getEl('globalConnectingBotsCount');
    if (connWrap && connEl) {
      const connectingVal = Number(summary.connectingCount || 0);
      connEl.textContent = connectingVal;
      connWrap.classList.toggle('hidden', connectingVal <= 0);
    }
  }

  if (!Array.isArray(monitorSnapshot.sessions) || !currentGoogleUserId) return;
  const mySessionRow = monitorSnapshot.sessions.find((row) => row.googleUserId === currentGoogleUserId);
  if (!mySessionRow) return;

  animateMetricCounter('statMessagesReceived', mySessionRow.totalMessagesReceived || 0);
  animateMetricCounter('statMessagesSent', mySessionRow.totalMessagesSent || 0);
  animateMetricCounter('statUniqueUsers', mySessionRow.uniqueUsersCount || 0);
  updateAiPersonaBadgesUI(Boolean(mySessionRow.isAiEnabled));

  if (mySessionRow.sessionSizeLabel) {
    if (getEl('statSessionSizeSub')) getEl('statSessionSizeSub').textContent = `sesi: ${mySessionRow.sessionSizeLabel}`;
    const pill = getEl('botProfileSessionSizePill');
    if (pill) {
      pill.textContent = mySessionRow.sessionSizeLabel;
      pill.classList.remove('hidden');
    }
  }

  if (mySessionRow.subscription) renderSubscriptionCountdown(mySessionRow.subscription);

  if (['ONLINE', 'CONNECTING', 'OFFLINE'].includes(mySessionRow.status)) {
    const mappedStatus = mySessionRow.status === 'ONLINE' ? 'CONNECTED' : (mySessionRow.status === 'CONNECTING' ? 'CONNECTING' : 'DISCONNECTED');
    const badgeText = getEl('connectionStatusText');
    if (badgeText && badgeText.textContent !== mySessionRow.status) {
      updateConnectionUIState(mappedStatus, null, mySessionRow.status === 'CONNECTING');
    }
  }
}

function updateAiPersonaBadgesUI(isEnabled) {
  const stripBadge = getEl('aiStatusStripBadge');
  const quickBtn = getEl('toggleAiPersonaBtn');
  const cfgBadge = getEl('cfgAiStateBadge');

  if (stripBadge) {
    stripBadge.textContent = isEnabled ? 'AI: ON' : 'AI: OFF';
    stripBadge.className = isEnabled
      ? 'hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-500/15 border border-violet-500/35 text-[10px] text-violet-300 font-bold shrink-0'
      : 'hidden sm:inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-950 border border-slate-800 text-[10px] text-slate-400 shrink-0';
  }
  if (quickBtn) {
    quickBtn.textContent = isEnabled ? 'Aktif' : 'Nonaktif';
    quickBtn.className = isEnabled
      ? 'px-3 py-1 rounded-lg font-semibold accent-bg text-slate-950 transition-all shrink-0'
      : 'px-3 py-1 rounded-lg font-semibold bg-slate-800 text-slate-400 transition-all shrink-0';
  }
  if (cfgBadge) {
    cfgBadge.textContent = isEnabled ? 'ON' : 'OFF';
    cfgBadge.className = isEnabled
      ? 'px-2 py-0.5 rounded-full bg-violet-500/15 border border-violet-500/35 font-mono-code text-[10px] text-violet-300 font-bold'
      : 'px-2 py-0.5 rounded-full bg-slate-900 border border-slate-700 font-mono-code text-[10px] text-slate-400';
  }
}

// --- modal perpanjang, voucher, keamanan sandi/otp, dan pengaturan grup ---
function openRenewModal() { toggleModalVisibility('renewSubscriptionModal', true); }
function closeRenewModal() { toggleModalVisibility('renewSubscriptionModal', false); }

function orderPackageViaWhatsApp(durationLabel, priceLabel) {
  const text = `Halo Admin, saya ingin perpanjang paket Xu Core (${durationLabel} - ${priceLabel}).\nUser ID: ${currentGoogleUserId}`;
  window.open(`https://wa.me/${adminWhatsAppNumber}?text=${encodeURIComponent(text)}`, '_blank');
  closeRenewModal();
}

function contactOwnerViaWhatsApp() {
  const text = `Halo Owner Xu Core, saya butuh bantuan terkait panel.\nUser ID: ${currentGoogleUserId}`;
  window.open(`https://wa.me/${adminWhatsAppNumber}?text=${encodeURIComponent(text)}`, '_blank');
}

function openVoucherRedeemModal() {
  if (getEl('voucherCodeInput')) getEl('voucherCodeInput').value = '';
  toggleModalVisibility('voucherRedeemModal', true);
}

function closeVoucherRedeemModal() { toggleModalVisibility('voucherRedeemModal', false); }

function submitRedeemVoucher() {
  const code = String(getEl('voucherCodeInput')?.value || '').trim().toUpperCase();
  if (!code) {
    showCyberToast('Kode Kosong', 'Masukkan kode voucher terlebih dahulu.', 'danger');
    return;
  }
  const btn = getEl('voucherRedeemSubmitBtn');
  if (btn) btn.disabled = true;
  socketClient.emit('voucher:redeem', { code });
}

function openAccountSecurityModal() {
  if (getEl('secOtpEmailInput') && currentUserEmail) getEl('secOtpEmailInput').value = currentUserEmail;
  switchSecurityModalTab('change');
  toggleModalVisibility('accountSecurityModal', true);
}

function closeAccountSecurityModal() { toggleModalVisibility('accountSecurityModal', false); }

function switchSecurityModalTab(tab) {
  const isOtp = tab === 'otp';
  getEl('secChangePasswordPanel')?.classList.toggle('hidden', isOtp);
  getEl('secOtpResetPanel')?.classList.toggle('hidden', !isOtp);
  const activeCls = 'py-1.5 rounded-lg font-bold accent-bg text-slate-950 transition-all';
  const inactiveCls = 'py-1.5 rounded-lg font-semibold text-slate-400 hover:text-white transition-all';
  if (getEl('secTabChangeBtn')) getEl('secTabChangeBtn').className = isOtp ? inactiveCls : activeCls;
  if (getEl('secTabOtpBtn')) getEl('secTabOtpBtn').className = isOtp ? activeCls : inactiveCls;
}

async function submitChangeAccountPassword() {
  const currentPassword = String(getEl('secCurrentPasswordInput')?.value || '');
  const newPassword = String(getEl('secNewPasswordInput')?.value || '');
  const btn = getEl('secChangeSubmitBtn');

  if (!currentPassword || newPassword.length < 6) {
    showCyberToast('Validasi Gagal', 'Isi kata sandi lama dan sandi baru minimal 6 karakter.', 'danger');
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/auth/password/change', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.isSuccess) throw new Error(data.errorMessage || 'Gagal mengubah kata sandi.');

    if (getEl('secCurrentPasswordInput')) getEl('secCurrentPasswordInput').value = '';
    if (getEl('secNewPasswordInput')) getEl('secNewPasswordInput').value = '';
    closeAccountSecurityModal();
    showCyberToast('Sandi Diperbarui', data.message || 'Kata sandi akun berhasil diubah.', 'success');
  } catch (err) {
    showCyberToast('Gagal Mengubah Sandi', err.message, 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function requestPasswordResetOtp() {
  const email = String(getEl('secOtpEmailInput')?.value || '').trim();
  const btn = getEl('secRequestOtpBtn');
  if (!email) {
    showCyberToast('Email Kosong', 'Masukkan alamat email akun lokal Anda.', 'danger');
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/auth/password/request-otp', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.isSuccess) throw new Error(data.errorMessage || 'Gagal mengirim OTP WhatsApp.');
    showCyberToast('OTP Terkirim', data.message || 'Kode OTP 6 digit telah dikirim ke WhatsApp owner.', 'success');
  } catch (err) {
    showCyberToast('Gagal Kirim OTP', err.message, 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function submitVerifyPasswordOtp() {
  const email = String(getEl('secOtpEmailInput')?.value || '').trim();
  const otpCode = String(getEl('secOtpCodeInput')?.value || '').trim();
  const newPassword = String(getEl('secOtpNewPasswordInput')?.value || '');
  const btn = getEl('secVerifyOtpBtn');

  if (!email || !/^\d{6}$/.test(otpCode) || newPassword.length < 6) {
    showCyberToast('Input Tidak Valid', 'Isi email, kode OTP 6 digit, dan kata sandi baru (min. 6 karakter).', 'danger');
    return;
  }

  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/auth/password/verify-otp', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otpCode, newPassword })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.isSuccess) throw new Error(data.errorMessage || 'Verifikasi OTP gagal.');

    if (getEl('secOtpCodeInput')) getEl('secOtpCodeInput').value = '';
    if (getEl('secOtpNewPasswordInput')) getEl('secOtpNewPasswordInput').value = '';
    closeAccountSecurityModal();
    showCyberToast('Reset Berhasil', data.message || 'Kata sandi akun berhasil direset.', 'success');
  } catch (err) {
    showCyberToast('Reset Gagal', err.message, 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openGroupVisualConfigModal(jid, subject) {
  const cfg = currentGroupConfigsMap[jid] || {};
  if (getEl('groupCfgTargetJid')) getEl('groupCfgTargetJid').value = jid;
  if (getEl('groupCfgModalSubtitle')) getEl('groupCfgModalSubtitle').textContent = `${subject} (${jid})`;
  if (getEl('groupCfgAntiLinkCheck')) getEl('groupCfgAntiLinkCheck').checked = Boolean(cfg.antiLink);
  if (getEl('groupCfgAntiToxicCheck')) getEl('groupCfgAntiToxicCheck').checked = Boolean(cfg.antiToxic);
  if (getEl('groupCfgWelcomeCheck')) getEl('groupCfgWelcomeCheck').checked = Boolean(cfg.welcomeEnabled);
  if (getEl('groupCfgWelcomeText')) getEl('groupCfgWelcomeText').value = cfg.welcomeMessage || 'Selamat datang @user di grup @group!';
  if (getEl('groupCfgGoodbyeCheck')) getEl('groupCfgGoodbyeCheck').checked = Boolean(cfg.goodbyeEnabled);
  if (getEl('groupCfgGoodbyeText')) getEl('groupCfgGoodbyeText').value = cfg.goodbyeMessage || 'Sampai jumpa @user dari @group.';
  toggleModalVisibility('groupVisualConfigModal', true);
}

function saveGroupVisualConfig() {
  const jid = String(getEl('groupCfgTargetJid')?.value || '').trim();
  if (!jid) return;
  socketClient.emit('manage:group:config', {
    jid,
    antiLink: Boolean(getEl('groupCfgAntiLinkCheck')?.checked),
    antiToxic: Boolean(getEl('groupCfgAntiToxicCheck')?.checked),
    welcomeEnabled: Boolean(getEl('groupCfgWelcomeCheck')?.checked),
    welcomeMessage: String(getEl('groupCfgWelcomeText')?.value || '').trim(),
    goodbyeEnabled: Boolean(getEl('groupCfgGoodbyeCheck')?.checked),
    goodbyeMessage: String(getEl('groupCfgGoodbyeText')?.value || '').trim()
  });
}

// --- whatsapp api gateway multi-media & webhook ---
function renderGatewayKeyUI(apiKey, apiKeyStats) {
  currentGatewayApiKey = String(apiKey || '');
  const inputEl = getEl('gwApiKeyInput');
  const badgeEl = getEl('gwApiKeyStatusBadge');
  const callsEl = getEl('gwApiKeyCallsCount');
  const lastUsedEl = getEl('gwApiKeyLastUsedLabel');

  if (inputEl) {
    inputEl.value = currentGatewayApiKey;
    inputEl.type = isGatewayKeyVisible ? 'text' : 'password';
  }
  if (badgeEl) {
    badgeEl.textContent = currentGatewayApiKey ? 'AKTIF' : 'BELUM ADA';
    badgeEl.className = currentGatewayApiKey
      ? 'px-2 py-0.5 rounded-full bg-emerald-500/15 border border-emerald-500/35 font-mono-code text-[10px] text-emerald-300 font-bold shrink-0'
      : 'px-2 py-0.5 rounded-full bg-slate-950 border border-slate-800 font-mono-code text-[10px] text-slate-400 shrink-0';
  }
  if (callsEl) callsEl.textContent = Number(apiKeyStats?.totalCalls || 0).toLocaleString('id-ID');
  if (lastUsedEl) lastUsedEl.textContent = apiKeyStats?.lastUsedAt ? formatWibDateTime(apiKeyStats.lastUsedAt) : '-';
  updateGatewayPayloadPreview();
}

function toggleGatewayKeyVisibility() {
  isGatewayKeyVisible = !isGatewayKeyVisible;
  const inputEl = getEl('gwApiKeyInput');
  const btn = getEl('gwToggleKeyVisibilityBtn');
  const iconEl = getEl('gwToggleKeyIcon');

  if (inputEl) inputEl.type = isGatewayKeyVisible ? 'text' : 'password';
  if (btn) {
    const label = isGatewayKeyVisible ? 'Sembunyikan API Key' : 'Tampilkan API Key';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  }
  if (iconEl) {
    iconEl.innerHTML = isGatewayKeyVisible
      ? '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />'
      : '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />';
  }
}

function flashCopyButtonCheckmark(btnId, iconId, defaultTitle, timerSetter, existingTimer) {
  const btn = getEl(btnId);
  const icon = getEl(iconId);
  if (!icon) return;

  icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.4" d="M5 13l4 4L19 7" />';
  if (btn) {
    btn.classList.remove('text-slate-400');
    btn.classList.add('text-emerald-400');
    btn.title = 'Copied!';
  }

  if (existingTimer) clearTimeout(existingTimer);
  timerSetter(setTimeout(() => {
    icon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />';
    if (btn) {
      btn.classList.remove('text-emerald-400');
      btn.classList.add('text-slate-400');
      btn.title = defaultTitle;
    }
    timerSetter(null);
  }, 2000));
}

async function copyGatewayApiKey() {
  const isCopied = await copyTextToClipboard(
    currentGatewayApiKey,
    'API Key Disalin',
    'Belum ada API Key aktif. Klik Generate Key terlebih dahulu.'
  );
  if (isCopied) {
    flashCopyButtonCheckmark('gwCopyKeyBtn', 'gwCopyKeyIcon', 'Salin API Key', (timer) => { gwCopyIconResetTimer = timer; }, gwCopyIconResetTimer);
  }
}

function generateGatewayApiKey() { socketClient.emit('gateway:key:generate'); }
function revokeGatewayApiKey() { socketClient.emit('gateway:key:revoke'); }

function saveGatewayWebhookSettings() {
  const webhookUrl = String(getEl('gwWebhookUrlInput')?.value || '').trim();
  const webhookSecret = String(getEl('gwWebhookSecretInput')?.value || '').trim();
  socketClient.emit('settings:update', { webhookUrl, webhookSecret });
}

function testGatewayWebhookUrl() {
  const webhookUrl = String(getEl('gwWebhookUrlInput')?.value || '').trim();
  const webhookSecret = String(getEl('gwWebhookSecretInput')?.value || '').trim();
  if (!webhookUrl) {
    showCyberToast('URL Kosong', 'Masukkan URL Webhook terlebih dahulu.', 'danger');
    return;
  }
  socketClient.emit('gateway:webhook:test', { webhookUrl, webhookSecret });
  showCyberToast('Menguji Webhook', 'Mengirim payload uji ke server tujuan...', 'info');
}

function switchGatewayMediaFields() {
  if (!getEl('gwMediaTypeSelect')) return;
  const type = getEl('gwMediaTypeSelect').value || 'text';
  const isMedia = ['image', 'video', 'audio', 'sticker', 'document'].includes(type);
  const isLoc = type === 'location';
  const isContact = type === 'contact';
  const showTextGroup = ['text', 'image', 'video', 'document'].includes(type);

  getEl('gwTextGroup')?.classList.toggle('hidden', !showTextGroup);
  getEl('gwMediaSourceGroup')?.classList.toggle('hidden', !isMedia);
  getEl('gwLocationGroup')?.classList.toggle('hidden', !isLoc);

  const contactWrap = getEl('gwContactGroup');
  if (contactWrap) {
    contactWrap.classList.toggle('hidden', !isContact);
    contactWrap.classList.toggle('grid', isContact);
  }

  const pttWrap = getEl('gwAudioPttWrap');
  if (pttWrap) {
    pttWrap.classList.toggle('hidden', type !== 'audio');
    pttWrap.classList.toggle('flex', type === 'audio');
  }

  const docWrap = getEl('gwDocumentMetaWrap');
  if (docWrap) {
    docWrap.classList.toggle('hidden', type !== 'document');
    docWrap.classList.toggle('grid', type === 'document');
  }

  if (getEl('gwMessageLabel')) {
    getEl('gwMessageLabel').textContent = type === 'text' ? 'Isi Pesan Teks' : 'Caption Media (Opsional)';
  }

  const urlInput = getEl('gwMediaUrlInput');
  if (urlInput) {
    const placeholderMap = {
      image: 'https://domain.com/foto.jpg',
      video: 'https://domain.com/video.mp4',
      audio: 'https://domain.com/audio.mp3',
      sticker: 'https://domain.com/stiker.webp',
      document: 'https://domain.com/dokumen.pdf'
    };
    urlInput.placeholder = placeholderMap[type] || 'https://domain.com/file';
  }

  const fileInput = getEl('gwMediaFileInput');
  if (fileInput) {
    const acceptMap = {
      image: 'image/*',
      video: 'video/*',
      audio: 'audio/*',
      sticker: 'image/webp,image/png,image/jpeg',
      document: '*/*'
    };
    fileInput.accept = acceptMap[type] || '*/*';
  }

  updateGatewayPayloadPreview();
}

function clearGatewayLocalFile() {
  gatewayLocalFilePayload = null;
  if (getEl('gwMediaFileInput')) getEl('gwMediaFileInput').value = '';
  if (getEl('gwMediaFileInfo')) {
    getEl('gwMediaFileInfo').textContent = 'belum ada file';
    getEl('gwMediaFileInfo').className = 'flex-1 min-w-0 text-[11px] font-mono-code text-slate-400 truncate px-1';
  }
  getEl('gwClearMediaFileBtn')?.classList.add('hidden');
  updateGatewayPayloadPreview();
}

function handleGatewayLocalFileSelect(event) {
  const file = event?.target?.files?.[0];
  if (!file) {
    clearGatewayLocalFile();
    return;
  }
  if (file.size > 12 * 1024 * 1024) {
    showCyberToast('File Terlalu Besar', 'Maksimal ukuran unggah lokal 12 MB. Gunakan URL untuk file besar.', 'danger');
    clearGatewayLocalFile();
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    gatewayLocalFilePayload = {
      fileName: file.name,
      mimetype: file.type || 'application/octet-stream',
      size: file.size,
      base64: String(reader.result || '')
    };
    if (getEl('gwMediaFileInfo')) {
      getEl('gwMediaFileInfo').textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
      getEl('gwMediaFileInfo').className = 'flex-1 min-w-0 text-[11px] font-mono-code text-slate-200 truncate px-1';
    }
    getEl('gwClearMediaFileBtn')?.classList.remove('hidden');
    if (getEl('gwDocFileNameInput') && !getEl('gwDocFileNameInput').value) getEl('gwDocFileNameInput').value = file.name;
    if (getEl('gwDocMimeInput') && !getEl('gwDocMimeInput').value) getEl('gwDocMimeInput').value = file.type || 'application/octet-stream';
    updateGatewayPayloadPreview();
  };
  reader.readAsDataURL(file);
}

function buildGatewayPayloadObject(forPreview = false) {
  const targetJid = String(getEl('gwTargetJidInput')?.value || '').trim();
  const mediaType = String(getEl('gwMediaTypeSelect')?.value || 'text').trim().toLowerCase();
  const rawMessage = String(getEl('gwMessageTextarea')?.value || '').trim();
  const mentionAll = Boolean(getEl('gwMentionAllCheck')?.checked);

  const payload = { targetJid: targetJid || '6281234567890', mediaType, mentionAll };

  if (mediaType === 'text') {
    payload.message = rawMessage || 'Halo dari Xu Core API Gateway';
  } else if (['image', 'video', 'audio', 'sticker', 'document'].includes(mediaType)) {
    const mediaUrl = String(getEl('gwMediaUrlInput')?.value || '').trim();
    if (mediaUrl) payload.mediaUrl = mediaUrl;
    if (gatewayLocalFilePayload?.base64) {
      payload.mediaBase64 = forPreview
        ? `[BASE64:${gatewayLocalFilePayload.fileName} (${(gatewayLocalFilePayload.size / 1024).toFixed(1)} KB)]`
        : gatewayLocalFilePayload.base64;
    }
    if (['image', 'video', 'document'].includes(mediaType) && rawMessage) payload.caption = rawMessage;
    if (mediaType === 'audio') payload.ptt = Boolean(getEl('gwAudioPttCheck')?.checked);
    if (mediaType === 'document') {
      payload.fileName = String(getEl('gwDocFileNameInput')?.value || gatewayLocalFilePayload?.fileName || 'document.pdf').trim();
      payload.mimetype = String(getEl('gwDocMimeInput')?.value || gatewayLocalFilePayload?.mimetype || 'application/pdf').trim();
    }
  } else if (mediaType === 'location') {
    payload.location = {
      degreesLatitude: Number(getEl('gwLocLatInput')?.value || -6.9932),
      degreesLongitude: Number(getEl('gwLocLngInput')?.value || 110.4203),
      name: String(getEl('gwLocNameInput')?.value || '').trim(),
      address: String(getEl('gwLocAddressInput')?.value || '').trim()
    };
  } else if (mediaType === 'contact') {
    payload.contact = {
      fullName: String(getEl('gwContactNameInput')?.value || 'Admin Xu Core').trim(),
      phoneNumber: String(getEl('gwContactPhoneInput')?.value || '').replace(/\D/g, '')
    };
  }

  return payload;
}

function getSanitizedGatewaySnippetPayload() {
  const rawPayload = buildGatewayPayloadObject(true);
  const cleanPayload = {};
  for (const [key, value] of Object.entries(rawPayload)) {
    if (value === undefined) continue;
    cleanPayload[key] = key === 'mediaBase64' ? 'data:application/octet-stream;base64,ISI_BASE64_FILE_ANDA' : value;
  }
  return cleanPayload;
}

function buildGatewayFormattedSnippet(formatType = 'json') {
  const endpointUrl = `${window.location.origin}/api/v1/gateway/send`;
  const apiKeyValue = currentGatewayApiKey || 'YOUR_API_KEY';
  const cleanPayload = getSanitizedGatewaySnippetPayload();

  if (formatType === 'javascript') {
    const indentedPayload = JSON.stringify(cleanPayload, null, 2)
      .split('\n')
      .map((line, idx) => (idx === 0 ? line : `  ${line}`))
      .join('\n');

    return [
      `const response = await fetch('${endpointUrl}', {`,
      "  method: 'POST',",
      '  headers: {',
      "    'Content-Type': 'application/json',",
      `    'x-api-key': '${apiKeyValue}'`,
      '  },',
      `  body: JSON.stringify(${indentedPayload})`,
      '});',
      '',
      'const result = await response.json();',
      'console.log(result);'
    ].join('\n');
  }

  if (formatType === 'curl') {
    return [
      `curl -X POST "${endpointUrl}" \\`,
      '  -H "Content-Type: application/json" \\',
      `  -H "x-api-key: ${apiKeyValue}" \\`,
      `  -d '${JSON.stringify(cleanPayload)}'`
    ].join('\n');
  }

  return JSON.stringify(cleanPayload, null, 2);
}

function updateGatewayPayloadPreview() {
  const previewEl = getEl('gwPayloadPreviewCode');
  if (!previewEl) return;
  safeExecute(() => {
    const selectedFormat = getEl('gwSnippetFormatSelect')?.value || 'json';
    previewEl.textContent = buildGatewayFormattedSnippet(selectedFormat);
  }, 'updateGatewayPayloadPreview');
}

function handleGatewayFormatChange() { updateGatewayPayloadPreview(); }

async function copyGatewayPreviewSnippet() {
  const selectedFormat = getEl('gwSnippetFormatSelect')?.value || 'json';
  const snippetText = buildGatewayFormattedSnippet(selectedFormat);
  const labelMap = { json: 'Payload JSON Disalin', javascript: 'Kode JavaScript Disalin', curl: 'Perintah cURL Disalin' };
  const isCopied = await copyTextToClipboard(snippetText, labelMap[selectedFormat] || 'Kode Disalin', 'Tidak ada konten untuk disalin.');
  if (isCopied) {
    flashCopyButtonCheckmark('gwCopySnippetBtn', 'gwCopySnippetIcon', 'Salin Kode', (timer) => { gwCopySnippetResetTimer = timer; }, gwCopySnippetResetTimer);
  }
}

async function submitGatewayTestMessage() {
  if (!currentGatewayApiKey) {
    showCyberToast('API Key Belum Ada', 'Klik "Generate Key" terlebih dahulu.', 'danger');
    return;
  }
  const rawTarget = String(getEl('gwTargetJidInput')?.value || '').trim();
  if (!rawTarget) {
    showCyberToast('Tujuan Kosong', 'Masukkan nomor WhatsApp atau ID Grup tujuan.', 'danger');
    return;
  }

  const payload = buildGatewayPayloadObject(false);
  const btn = getEl('gwSendSubmitBtn');
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/v1/gateway/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': currentGatewayApiKey },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.isSuccess) throw new Error(data.errorMessage || `Gateway menolak permintaan (HTTP ${res.status}).`);
    if (data.apiKeyStats) renderGatewayKeyUI(currentGatewayApiKey, data.apiKeyStats);
    showCyberToast('Gateway Terkirim', `Pesan (${payload.mediaType}) terkirim ke ${String(data.targetJid || rawTarget).split('@')[0]}.`, 'success');
  } catch (err) {
    showCyberToast('Gateway Gagal', err.message, 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}
// --- statistik langganan, leaderboard perintah, dan form pengaturan bot ---
function renderSubscriptionCountdown(subscriptionOrExpiresAt) {
  const pill = getEl('subscriptionCountdownPill');
  if (!pill) return;

  const isObj = subscriptionOrExpiresAt && typeof subscriptionOrExpiresAt === 'object';
  const expiresAtMs = isObj ? Number(subscriptionOrExpiresAt.expiresAt || 0) : Number(subscriptionOrExpiresAt || 0);
  const planName = isObj && subscriptionOrExpiresAt.plan ? String(subscriptionOrExpiresAt.plan) : 'Starter';
  const isReseller = Boolean(isObj && subscriptionOrExpiresAt.isReseller);
  const maxSlots = isObj && subscriptionOrExpiresAt.maxSlots ? Number(subscriptionOrExpiresAt.maxSlots) : 1;

  if (isObj) lastSubscriptionMeta = subscriptionOrExpiresAt;

  const remainingDays = isObj && subscriptionOrExpiresAt.remainingDays !== undefined
    ? Number(subscriptionOrExpiresAt.remainingDays)
    : Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 86400000));
  const isExpired = isObj && subscriptionOrExpiresAt.isExpired !== undefined
    ? Boolean(subscriptionOrExpiresAt.isExpired)
    : (expiresAtMs > 0 && remainingDays <= 0);
  const resellerTag = isReseller ? ` • Reseller (${maxSlots} Slot)` : ` • ${maxSlots} Slot`;

  if (isExpired) {
    pill.textContent = `${planName}${resellerTag} • Habis`;
    pill.className = 'px-2.5 py-0.5 rounded-full bg-rose-500/15 border border-rose-500/30 text-rose-300 font-semibold';
  } else if (expiresAtMs > 0) {
    pill.textContent = `${planName}${resellerTag} • Sisa ${remainingDays} Hari`;
    pill.className = remainingDays <= 3
      ? 'px-2.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 font-semibold'
      : (isReseller
        ? 'px-2.5 py-0.5 rounded-full bg-sky-500/15 border border-sky-500/30 text-sky-300 font-semibold'
        : 'px-2.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 font-semibold');
  } else {
    pill.textContent = `${planName}${resellerTag} • Aktif`;
    pill.className = 'px-2.5 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-300 font-semibold';
  }

  const metaInfo = getEl('renewCurrentPlanMeta');
  if (metaInfo) {
    metaInfo.innerHTML = `<span>Paket: <strong class="text-white">${escapeHtmlString(planName)}</strong></span><span>Slot: <strong class="accent-text">${maxSlots}</strong></span>`;
  }
}

function renderTopCommandsLeaderboard(list) {
  const container = getEl('topCommandsLeaderboardList');
  if (!container) return;
  if (!Array.isArray(list) || list.length === 0) {
    container.innerHTML = '<p class="text-slate-500">Belum ada statistik perintah.</p>';
    return;
  }
  const maxHit = Math.max(1, Number(list[0].hit || 1));
  container.innerHTML = list.map((item, idx) => {
    const pct = Math.min(100, Math.round((item.hit / maxHit) * 100));
    return `
      <div class="space-y-1">
        <div class="flex items-center justify-between font-mono-code">
          <span class="text-slate-200">#${idx + 1} .${escapeHtmlString(item.name)}</span>
          <span class="accent-text font-bold">${item.hit}x</span>
        </div>
        <div class="h-1.5 w-full rounded-full bg-slate-950 overflow-hidden">
          <div class="h-full accent-bg rounded-full" style="width: ${pct}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function animateMetricCounter(elementId, newValue) {
  const targetElement = getEl(elementId);
  if (!targetElement) return;
  targetElement.textContent = (parseInt(newValue, 10) || 0).toLocaleString('id-ID');
}

function populateSettingsForm(settingsObj) {
  if (!settingsObj) return;
  currentDisabledCategories = Array.isArray(settingsObj.disabledCategories) ? settingsObj.disabledCategories : [];
  currentGroupConfigsMap = settingsObj.groupConfigs && typeof settingsObj.groupConfigs === 'object' ? settingsObj.groupConfigs : {};

  const serializedAutoReplies = serializeAutoReplyArrayToLines(settingsObj.autoReplies || []);
  const customMsgs = settingsObj.customMessages || {};
  const prefixCfg = settingsObj.prefixConfig || {};
  const menuCfg = settingsObj.menuConfig || {};
  const limitCfg = settingsObj.limitConfig || {};

  const fieldPairs = [
    ['cfgBotNameInput', settingsObj.botName || ''],
    ['cfgPacknameInput', settingsObj.packname || ''],
    ['cfgAuthorInput', settingsObj.author || ''],
    ['cfgOwnersInput', Array.isArray(settingsObj.owners) ? settingsObj.owners.join(', ') : ''],
    ['cfgToxicInput', Array.isArray(settingsObj.toxic) ? settingsObj.toxic.join(', ') : ''],
    ['cfgAiSystemPromptInput', settingsObj.aiSystemPrompt || ''],
    ['gwWebhookUrlInput', settingsObj.webhookUrl || ''],
    ['gwWebhookSecretInput', settingsObj.webhookSecret || ''],
    ['cfgAutoReplyInput', serializedAutoReplies],
    ['cfgMsgWaitInput', customMsgs.wait || ''],
    ['cfgMsgLimitInput', customMsgs.limit || ''],
    ['cfgMsgPremiumInput', customMsgs.premium || ''],
    ['cfgMsgOwnerInput', customMsgs.owner || ''],
    ['cfgMsgGroupInput', customMsgs.group || ''],
    ['cfgMsgPrivateInput', customMsgs.private || ''],
    ['cfgPrefixesInput', prefixCfg.prefixes || '.!/#'],
    ['cfgCooldownSecInput', String(prefixCfg.cooldownSeconds ?? 3)],
    ['cfgSpamLimitInput', String(prefixCfg.spamLimit ?? 5)],
    ['cfgSpamCooldownInput', String(prefixCfg.spamCooldownSeconds ?? 15)],
    ['cfgMenuHeaderInput', menuCfg.header || ''],
    ['cfgMenuFooterInput', menuCfg.footer || ''],
    ['cfgMenuThumbInput', menuCfg.thumbnailUrl || ''],
    ['cfgDefaultLimitInput', String(limitCfg.defaultLimit ?? 25)],
    ['cfgResetHourInput', String(limitCfg.resetHourWib ?? 0)]
  ];

  fieldPairs.forEach(([id, val]) => {
    const fieldEl = getEl(id);
    if (fieldEl && document.activeElement !== fieldEl) fieldEl.value = val;
  });

  const isEditingBuilder = ['arTriggerInput', 'arResponseInput', 'arMediaUrlInput', 'cfgAutoReplyInput'].includes(document.activeElement?.id);
  if (!isEditingBuilder) {
    visualAutoReplyRules = Array.isArray(settingsObj.autoReplies)
      ? settingsObj.autoReplies.map((rule) => ({
          trigger: String(rule.trigger || ''),
          matchType: String(rule.matchType || 'exact'),
          response: String(rule.response || ''),
          mediaType: String(rule.mediaType || 'text'),
          mediaUrl: String(rule.mediaUrl || '')
        }))
      : [];
    renderVisualAutoReplyRules();
  }

  if (getEl('cfgNoPrefixCheck')) getEl('cfgNoPrefixCheck').checked = settingsObj.isNoPrefix ?? true;
  if (getEl('cfgAllowedPcCheck')) getEl('cfgAllowedPcCheck').checked = settingsObj.allowedPc ?? true;
  if (getEl('cfgAiEnabledCheck')) getEl('cfgAiEnabledCheck').checked = Boolean(settingsObj.isAiEnabled);
  if (getEl('cfgAiGroupReplyCheck')) getEl('cfgAiGroupReplyCheck').checked = Boolean(settingsObj.aiGroupAutoReply);
  if (getEl('cfgAutoResetLimitCheck')) getEl('cfgAutoResetLimitCheck').checked = limitCfg.autoResetEnabled ?? true;

  updateAiPersonaBadgesUI(Boolean(settingsObj.isAiEnabled));
  renderFeatureCatalogUI();
}

function saveBotConfigurationForm() {
  const rawToxic = getEl('cfgToxicInput')?.value || '';
  const rawOwners = getEl('cfgOwnersInput')?.value || '';
  const autoReplies = isAutoReplyRawMode
    ? parseAutoReplyLinesToArray(getEl('cfgAutoReplyInput')?.value || '')
    : [...visualAutoReplyRules];

  if (isAutoReplyRawMode) {
    visualAutoReplyRules = autoReplies;
    renderVisualAutoReplyRules();
  } else {
    syncRawTextareaFromVisualRules();
  }

  socketClient.emit('settings:update', {
    botName: getEl('cfgBotNameInput')?.value.trim() || '',
    packname: getEl('cfgPacknameInput')?.value.trim() || '',
    author: getEl('cfgAuthorInput')?.value.trim() || '',
    owners: rawOwners.split(',').map((item) => item.trim()).filter(Boolean),
    toxic: rawToxic.split(',').map((word) => word.trim()).filter(Boolean),
    autoReplies,
    disabledCategories: currentDisabledCategories,
    isNoPrefix: Boolean(getEl('cfgNoPrefixCheck')?.checked),
    allowedPc: Boolean(getEl('cfgAllowedPcCheck')?.checked),
    isAiEnabled: Boolean(getEl('cfgAiEnabledCheck')?.checked),
    aiGroupAutoReply: Boolean(getEl('cfgAiGroupReplyCheck')?.checked),
    aiSystemPrompt: String(getEl('cfgAiSystemPromptInput')?.value || '').trim()
  });
}

function renderDatabaseStatistics(databaseObject, globalStatsObject, trafficSeriesArg) {
  if (databaseObject) {
    lastKnownDatabaseSnapshot = databaseObject;
    animateMetricCounter('statMessagesReceived', databaseObject.totalMessagesReceived || 0);
    animateMetricCounter('statMessagesSent', databaseObject.totalMessagesSent || 0);
    animateMetricCounter('statUniqueUsers', Array.isArray(databaseObject.uniqueUsers) ? databaseObject.uniqueUsers.length : 0);

    if (databaseObject.startTime) botStartTimeMs = databaseObject.startTime;

    const resolvedSub = databaseObject.subscription
      ? { ...databaseObject.subscription }
      : (databaseObject.expiresAt ? { expiresAt: databaseObject.expiresAt } : lastSubscriptionMeta);
    if (resolvedSub) renderSubscriptionCountdown(resolvedSub);

    if (Array.isArray(trafficSeriesArg)) updateTrafficHistoryChart(trafficSeriesArg);
    else if (Array.isArray(latestTrafficSeries)) updateTrafficHistoryChart(latestTrafficSeries);
    else if (databaseObject.trafficHistory) updateTrafficHistoryChart(databaseObject.trafficHistory);

    const isAutoRead = databaseObject.settings?.autoRead ?? true;
    const isPublicMode = databaseObject.settings?.publicMode ?? true;
    const activeToggleCls = 'px-3 py-1 rounded-lg font-semibold accent-bg text-slate-950 transition-all';
    const inactiveToggleCls = 'px-3 py-1 rounded-lg font-semibold bg-slate-800 text-slate-400 transition-all';

    if (getEl('toggleAutoReadBtn')) {
      getEl('toggleAutoReadBtn').textContent = isAutoRead ? 'Aktif' : 'Nonaktif';
      getEl('toggleAutoReadBtn').className = isAutoRead ? activeToggleCls : inactiveToggleCls;
    }
    if (getEl('togglePublicModeBtn')) {
      getEl('togglePublicModeBtn').textContent = isPublicMode ? 'Aktif' : 'Nonaktif';
      getEl('togglePublicModeBtn').className = isPublicMode ? activeToggleCls : inactiveToggleCls;
    }

    if (databaseObject.apiKey !== undefined || databaseObject.apiKeyStats) {
      renderGatewayKeyUI(databaseObject.apiKey, databaseObject.apiKeyStats);
    }
    if (Array.isArray(databaseObject.webhookLogs)) renderWebhookDeliveryLogs(databaseObject.webhookLogs);

    populateSettingsForm(databaseObject.settings);
    evaluateOnboardingProgress(databaseObject);
  }

  if (globalStatsObject) {
    if (getEl('globalActiveBotsCount')) getEl('globalActiveBotsCount').textContent = globalStatsObject.totalActiveBots || 0;
    if (getEl('globalTotalTrafficCount')) {
      const combinedTraffic = (globalStatsObject.globalMessagesReceived || 0) + (globalStatsObject.globalMessagesSent || 0);
      getEl('globalTotalTrafficCount').textContent = combinedTraffic.toLocaleString('id-ID');
    }
  }
}

// --- status koneksi whatsapp & aksi pemeliharaan sesi ---
function resetAuthenticationPanelsUI() {
  const qrImg = getEl('qrCodeImageElement');
  if (qrImg) {
    qrImg.src = '';
    qrImg.classList.add('hidden');
  }
  if (getEl('qrCodeStatusText')) {
    getEl('qrCodeStatusText').textContent = 'Klik tombol di bawah untuk menginisialisasi sesi dan menampilkan QR Code terbaru.';
  }
  getEl('pairingCodeDisplayWrapper')?.classList.add('hidden');
  getEl('copyPairingCodeBtn')?.classList.add('hidden');
  if (getEl('pairingCodeValue')) getEl('pairingCodeValue').textContent = '----';
}

function updateConnectionUIState(statusState, profileObject, isAutoReconnect = false) {
  const badge = getEl('connectionStatusBadge');
  if (!badge) return;

  const normalizedStatus = String(statusState || 'disconnected').toLowerCase();
  currentConnectionStatus = normalizedStatus === 'connected' || normalizedStatus === 'online'
    ? 'CONNECTED'
    : (normalizedStatus === 'connecting' ? 'CONNECTING' : 'DISCONNECTED');

  const icon = getEl('connectionStatusIcon');
  const text = getEl('connectionStatusText');
  const profileCard = getEl('connectedProfileCard');
  const autoReconnectNotice = getEl('autoReconnectNotice');
  const authBox = getEl('authenticationBox');

  if (normalizedStatus === 'connected' || normalizedStatus === 'online') {
    badge.className = 'flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] font-semibold font-mono-code shrink-0 shadow-[0_0_12px_rgba(16,185,129,0.2)]';
    if (icon) icon.className = 'w-2 h-2 rounded-full bg-emerald-500';
    if (text) text.textContent = 'ONLINE';
    profileCard?.classList.remove('hidden');
    autoReconnectNotice?.classList.add('hidden');
    authBox?.classList.add('hidden');
    resetAuthenticationPanelsUI();

    if (profileObject) {
      const resolvedAvatar =
        profileObject.avatarUrl ||
        `https://ui-avatars.com/api/?name=${encodeURIComponent(profileObject.name || 'Bot')}&background=10b981&color=fff`;
      if (getEl('botProfileName')) getEl('botProfileName').textContent = profileObject.name || 'WhatsApp Bot';
      if (getEl('botProfileNumber')) getEl('botProfileNumber').textContent = `+${profileObject.number || '-'}`;
      if (getEl('botProfileAvatar')) getEl('botProfileAvatar').src = resolvedAvatar;
      if (!brandingAvatarBase64Payload && getEl('brandingAvatarPreviewImg')) {
        getEl('brandingAvatarPreviewImg').src = resolvedAvatar;
      }
    }
  } else if (normalizedStatus === 'connecting') {
    badge.className = 'flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[11px] font-semibold font-mono-code shrink-0';
    if (icon) icon.className = 'w-2 h-2 rounded-full bg-amber-400 animate-ping';
    if (text) text.textContent = 'CONNECTING';
    profileCard?.classList.add('hidden');
    autoReconnectNotice?.classList.toggle('hidden', !isAutoReconnect);
    authBox?.classList.toggle('hidden', isAutoReconnect);
  } else {
    badge.className = 'flex items-center gap-2 px-3 py-1 rounded-full bg-rose-500/10 border border-rose-500/30 text-rose-400 text-[11px] font-semibold font-mono-code shrink-0';
    if (icon) icon.className = 'w-2 h-2 rounded-full bg-rose-500 animate-pulse';
    if (text) text.textContent = 'OFFLINE';
    profileCard?.classList.add('hidden');
    autoReconnectNotice?.classList.add('hidden');
    authBox?.classList.remove('hidden');
  }

  evaluateOnboardingProgress();
}

function initiateConnection(method) {
  if (method === 'pairing') {
    const phoneInput = getEl('pairingPhoneInput')?.value.trim() || '';
    if (!phoneInput) return showTopToast('Masukkan nomor WhatsApp terlebih dahulu', true);
    socketClient.emit('session:connect', { method: 'pairing', phoneNumber: phoneInput });
    showTopToast('Meminta 8-digit pairing code...');
  } else {
    socketClient.emit('session:connect', { method: 'qr' });
    if (getEl('qrCodeStatusText')) {
      getEl('qrCodeStatusText').textContent = 'Menghubungkan ke server WhatsApp, mohon tunggu QR Code...';
    }
    showTopToast('Menginisialisasi sesi QR Code...');
  }
}

async function copyPairingCodeValue() {
  const codeText = String(getEl('pairingCodeValue')?.textContent || '').trim();
  if (!codeText || codeText === '----') {
    showCyberToast('Belum Ada Kode', 'Request 8-Digit Pairing Code terlebih dahulu.', 'danger');
    return;
  }
  const isCopied = await copyTextToClipboard(codeText, 'Pairing Code Disalin', 'Kode pairing belum tersedia.');
  if (isCopied) {
    flashCopyButtonCheckmark('copyPairingCodeBtn', 'copyPairingCodeIcon', 'Copy Pairing Code', (timer) => { pairingCopyResetTimer = timer; }, pairingCopyResetTimer);
  }
}

function triggerSoftRestartSession() {
  socketClient.emit('session:restart');
  showTopToast('Memulai soft restart koneksi bot...');
}

function triggerClearPreKeys() {
  const btn = getEl('clearPreKeysBtn');
  if (btn) btn.disabled = true;
  socketClient.emit('session:clear-prekeys');
  showCyberToast('Pemeliharaan Sesi', 'Membersihkan pre-key/sender-key tanpa menghapus creds.json...', 'info');
}

function toggleBotSetting(settingKey) { socketClient.emit('settings:toggle', { key: settingKey }); }
function openLogoutConfirmationModal() { toggleModalVisibility('logoutConfirmModal', true); }
function closeLogoutConfirmationModal() { toggleModalVisibility('logoutConfirmModal', false); }

function confirmSessionLogout() {
  closeLogoutConfirmationModal();
  socketClient.emit('session:logout');
  resetAuthenticationPanelsUI();
  showTopToast('Menghapus sesi bot Anda...');
}

// --- terminal cli real-time ---
function setupTerminalScrollWatcher() {
  const terminalBox = getEl('terminalLogOutput');
  const resumeBtn = getEl('resumeAutoScrollBtn');
  if (!terminalBox || !resumeBtn) return;

  terminalBox.addEventListener('scroll', () => {
    const distanceFromBottom = terminalBox.scrollHeight - terminalBox.scrollTop - terminalBox.clientHeight;
    isTerminalAutoScrollEnabled = distanceFromBottom <= 24;
    resumeBtn.classList.toggle('hidden', isTerminalAutoScrollEnabled);
  });
}

function resumeTerminalAutoScroll() {
  const terminalBox = getEl('terminalLogOutput');
  isTerminalAutoScrollEnabled = true;
  getEl('resumeAutoScrollBtn')?.classList.add('hidden');
  if (terminalBox) terminalBox.scrollTop = terminalBox.scrollHeight;
}

function setTerminalFilter(levelFilter) {
  activeLogFilter = levelFilter;
  updateButtonGroupState(
    '.log-filter-btn',
    'data-log-filter',
    levelFilter,
    'log-filter-btn px-2.5 py-0.5 rounded-md accent-bg text-slate-950 font-bold',
    'log-filter-btn px-2.5 py-0.5 rounded-md bg-slate-950 border border-slate-800 text-slate-400 hover:text-white'
  );
  renderFilteredTerminalLogs();
}

function buildTerminalLineElement(logEntry) {
  const cleanMessage = String(logEntry?.message ?? '').trim();
  if (!cleanMessage) return null;

  const lineElement = document.createElement('div');
  const normalizedLevel = String(logEntry?.level || 'info').toLowerCase();
  const colorMap = { success: 'text-emerald-400', warn: 'text-amber-300', error: 'text-rose-400', msg: 'text-cyan-400' };
  const levelColorClass = colorMap[normalizedLevel] || 'text-slate-300';

  lineElement.className = `block m-0 p-0 whitespace-pre-wrap break-all ${levelColorClass}`;
  lineElement.innerHTML = `<span class="text-slate-500 select-none">[${escapeHtmlString(logEntry?.timestamp || '--:--:--')}]</span> ${escapeHtmlString(cleanMessage)}`;
  return lineElement;
}

function renderFilteredTerminalLogs() {
  const terminalBox = getEl('terminalLogOutput');
  if (!terminalBox) return;
  terminalBox.innerHTML = '';

  for (const entry of terminalLogsBuffer) {
    const entryLevel = String(entry?.level || 'info').toLowerCase();
    if (activeLogFilter !== 'all' && entryLevel !== activeLogFilter) continue;
    const lineEl = buildTerminalLineElement(entry);
    if (lineEl) terminalBox.appendChild(lineEl);
  }
  if (isTerminalAutoScrollEnabled) terminalBox.scrollTop = terminalBox.scrollHeight;
}

function appendTerminalLine(logEntry) {
  if (!logEntry?.message) return;
  terminalLogsBuffer.push(logEntry);
  if (terminalLogsBuffer.length > 200) terminalLogsBuffer.shift();

  const entryLevel = String(logEntry?.level || 'info').toLowerCase();
  if (activeLogFilter !== 'all' && entryLevel !== activeLogFilter) return;

  const terminalBox = getEl('terminalLogOutput');
  const lineElement = buildTerminalLineElement(logEntry);
  if (!terminalBox || !lineElement) return;

  terminalBox.appendChild(lineElement);
  if (isTerminalAutoScrollEnabled) terminalBox.scrollTop = terminalBox.scrollHeight;
}

function copyTerminalLogs() { copyTextToClipboard(getEl('terminalLogOutput')?.innerText, 'Log Disalin', 'Terminal masih kosong.'); }

function clearTerminalLogs() {
  terminalLogsBuffer = [];
  if (getEl('terminalLogOutput')) getEl('terminalLogOutput').innerHTML = '';
  showTopToast('Tampilan terminal dibersihkan');
}

// --- broadcast anti-ban, direct message, scheduler, katalog, user & grup ---
function setBroadcastSpeedPreset(delaySec) {
  if (getEl('broadcastDelayInput')) getEl('broadcastDelayInput').value = String(delaySec);
  showCyberToast('Preset Broadcast', `Jeda pengiriman diatur ke ${delaySec} detik/grup.`, 'info');
}

function sendGroupBroadcast() {
  const message = getEl('broadcastGroupMessageInput')?.value.trim() || '';
  const delaySeconds = Number(getEl('broadcastDelayInput')?.value || 6);
  if (!message) {
    showCyberToast('Pesan Kosong', 'Isi pesan broadcast terlebih dahulu.', 'danger');
    return;
  }

  getEl('broadcastProgressWrapper')?.classList.remove('hidden');
  if (getEl('broadcastProgressLabel')) getEl('broadcastProgressLabel').textContent = 'Mengambil daftar grup aktif...';
  if (getEl('broadcastProgressStats')) getEl('broadcastProgressStats').textContent = '0/0';
  if (getEl('broadcastProgressBarFill')) getEl('broadcastProgressBarFill').style.width = '0%';
  if (getEl('broadcastSendSubmitBtn')) getEl('broadcastSendSubmitBtn').disabled = true;

  socketClient.emit('broadcast:groups', { message, delaySeconds });
  showCyberToast('Broadcast Dimulai', `Mengirim ke semua grup aktif (jeda ${delaySeconds} detik)...`, 'info');
}

function switchDirectTargetMode(mode) {
  directTargetMode = mode === 'custom' ? 'custom' : 'group';
  getEl('directGroupSelectWrap')?.classList.toggle('hidden', directTargetMode !== 'group');
  getEl('directCustomInputWrap')?.classList.toggle('hidden', directTargetMode !== 'custom');

  const activeCls = 'px-2 py-1 rounded-md accent-bg text-slate-950 transition-all';
  const inactiveCls = 'px-2 py-1 rounded-md text-slate-400 hover:text-white transition-all';
  if (getEl('directModeGroupBtn')) getEl('directModeGroupBtn').className = directTargetMode === 'group' ? activeCls : inactiveCls;
  if (getEl('directModeCustomBtn')) getEl('directModeCustomBtn').className = directTargetMode === 'custom' ? activeCls : inactiveCls;
}

function submitDirectMessage() {
  const targetJid = directTargetMode === 'group'
    ? (getEl('directGroupSelect')?.value || '').trim()
    : (getEl('directCustomTargetInput')?.value || '').trim();
  const message = (getEl('directMessageTextarea')?.value || '').trim();
  const mentionAll = Boolean(getEl('directMentionAllCheck')?.checked);

  if (!targetJid) return showCyberToast('Tujuan Kosong', 'Pilih grup atau masukkan nomor/ID tujuan.', 'danger');
  if (!message) return showCyberToast('Pesan Kosong', 'Tulis pesan yang ingin dikirim.', 'danger');

  if (getEl('directSendSubmitBtn')) getEl('directSendSubmitBtn').disabled = true;
  socketClient.emit('direct:send', { targetJid, message, mentionAll });
}

function populateGroupSelectorOptions() {
  const selectors = [getEl('directGroupSelect'), getEl('schedGroupSelect')];
  const optionsHtml = managedGroupsCache.length > 0
    ? '<option value="">-- Pilih Grup Aktif --</option>' +
      managedGroupsCache.map((groupItem) => `<option value="${escapeHtmlString(groupItem.jid)}">${escapeHtmlString(groupItem.subject || groupItem.jid)} (${Number(groupItem.participantsCount || 0)} anggota)</option>`).join('')
    : '<option value="">-- Belum ada grup aktif --</option>';

  selectors.forEach((selectEl) => {
    if (!selectEl) return;
    const prevVal = selectEl.value;
    selectEl.innerHTML = optionsHtml;
    if (prevVal && managedGroupsCache.some((groupItem) => groupItem.jid === prevVal)) selectEl.value = prevVal;
  });
}

function toggleScheduleTargetMode() {
  scheduleTargetMode = scheduleTargetMode === 'group' ? 'custom' : 'group';
  getEl('schedGroupSelect')?.classList.toggle('hidden', scheduleTargetMode !== 'group');
  getEl('schedCustomTargetInput')?.classList.toggle('hidden', scheduleTargetMode !== 'custom');
  if (getEl('schedTargetModeBtn')) {
    getEl('schedTargetModeBtn').textContent = scheduleTargetMode === 'group' ? 'Ganti ke Input ID' : 'Ganti ke Pilih Grup';
  }
}

function updateScheduleTimeFieldsUI() {
  const mode = getEl('schedRepeatTypeSelect')?.value || 'once';
  getEl('schedOnceTimeWrap')?.classList.toggle('hidden', mode !== 'once');
  getEl('schedDailyTimeWrap')?.classList.toggle('hidden', mode !== 'daily');
  getEl('schedIntervalWrap')?.classList.toggle('hidden', mode !== 'interval');
}

function createScheduledMessage() {
  const title = (getEl('schedTitleInput')?.value || '').trim();
  const groupSelect = getEl('schedGroupSelect');
  const targetJid = scheduleTargetMode === 'group'
    ? (groupSelect?.value || '').trim()
    : (getEl('schedCustomTargetInput')?.value || '').trim();
  const targetLabel = scheduleTargetMode === 'group'
    ? (groupSelect?.options[groupSelect.selectedIndex]?.text || targetJid)
    : targetJid;
  const repeatType = getEl('schedRepeatTypeSelect')?.value || 'once';
  const message = (getEl('schedMessageTextarea')?.value || '').trim();
  const mentionAll = Boolean(getEl('schedMentionAllCheck')?.checked);

  if (!targetJid) return showCyberToast('Tujuan Kosong', 'Pilih grup atau isi nomor/ID tujuan jadwal.', 'danger');
  if (!message) return showCyberToast('Pesan Kosong', 'Isi pesan pengingat tidak boleh kosong.', 'danger');

  const payload = { title, targetJid, targetLabel, repeatType, message, mentionAll };
  if (repeatType === 'once') {
    const rawDateTime = getEl('schedOnceDatetimeInput')?.value || '';
    const parsedMs = rawDateTime ? new Date(rawDateTime).getTime() : 0;
    if (!parsedMs || Number.isNaN(parsedMs)) {
      return showCyberToast('Waktu Tidak Valid', 'Pilih tanggal dan jam pengiriman terlebih dahulu.', 'danger');
    }
    payload.runAtMs = parsedMs;
  } else if (repeatType === 'daily') {
    payload.dailyTime = getEl('schedDailyTimeInput')?.value || '08:00';
  } else {
    payload.intervalMinutes = Number(getEl('schedIntervalMinutesInput')?.value || 60);
  }

  socketClient.emit('schedule:create', payload);
}

function renderScheduledMessagesGrid() {
  const gridEl = getEl('scheduledMessagesCardGrid');
  const countBadge = getEl('scheduledCountBadge');
  if (countBadge) countBadge.textContent = `${scheduledMessagesCache.length} Jadwal`;
  if (!gridEl) return;

  if (scheduledMessagesCache.length === 0) {
    gridEl.innerHTML = '<div class="col-span-full py-5 text-center text-xs text-slate-500 rounded-xl bg-slate-950/50 border border-dashed border-slate-800">Belum ada pesan terjadwal atau reminder aktif.</div>';
    return;
  }

  gridEl.innerHTML = scheduledMessagesCache.map((item) => {
    const nextDateText = item.nextRunAt ? formatWibDateTime(item.nextRunAt) : '-';
    const modeLabel = item.repeatType === 'daily'
      ? `Harian ${escapeHtmlString(item.dailyTime)}`
      : (item.repeatType === 'interval' ? `Tiap ${Number(item.intervalMinutes || 60)}m` : 'Sekali');

    return `
      <div class="bg-slate-900/45 backdrop-blur-md border ${item.isActive ? 'border-slate-800' : 'border-slate-800/50 opacity-60'} rounded-xl p-3 flex flex-col justify-between gap-2">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-xs font-bold text-white truncate">${escapeHtmlString(item.title || item.targetLabel)}</p>
            <p class="text-[10px] font-mono-code text-slate-400 truncate mt-0.5">${escapeHtmlString(item.targetLabel)}</p>
          </div>
          <span class="px-2 py-0.5 rounded-full bg-slate-950 border border-slate-800 font-mono-code text-[9px] accent-text shrink-0">${modeLabel}</span>
        </div>
        <p class="text-[11px] text-slate-300 line-clamp-2 break-words">${escapeHtmlString(item.message)}</p>
        <div class="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/70">
          <span class="text-[10px] font-mono-code text-slate-400 truncate">${item.isActive ? `Next: ${nextDateText}` : escapeHtmlString(item.lastStatus || 'PAUSED')}</span>
          <div class="flex items-center gap-1.5 shrink-0">
            <button type="button" data-id="${escapeHtmlString(item.id)}" onclick="socketClient.emit('schedule:toggle', { id: this.dataset.id })" class="px-2 py-0.5 rounded-md text-[10px] font-semibold ${item.isActive ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'bg-slate-800 text-slate-400'}">
              ${item.isActive ? 'Aktif' : 'Pause'}
            </button>
            <button type="button" data-id="${escapeHtmlString(item.id)}" onclick="socketClient.emit('schedule:delete', { id: this.dataset.id })" title="Hapus Jadwal" class="w-6 h-6 rounded-full flex items-center justify-center bg-slate-950 hover:bg-rose-500/20 border border-slate-800 text-slate-400 hover:text-rose-400 transition-colors">
              <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function toggleBotFeatureCategory(categoryName) {
  const normalized = String(categoryName || '').trim().toLowerCase();
  if (!normalized) return;

  if (currentDisabledCategories.includes(normalized)) {
    currentDisabledCategories = currentDisabledCategories.filter((cat) => cat !== normalized);
  } else {
    currentDisabledCategories = [...currentDisabledCategories, normalized];
  }

  socketClient.emit('catalog:toggleCategory', { category: normalized });
  renderFeatureCatalogUI();
}

function renderFeatureCatalogUI() {
  const container = getEl('featureCatalogContainer');
  const query = String(getEl('catalogSearchInput')?.value || '').trim().toLowerCase();
  if (!container) return;

  const grouped = {};
  for (const item of featureCatalogCache) {
    const categoryKey = String(item.category || 'general').toLowerCase();
    const commands = Array.isArray(item.commands) ? item.commands : [];
    const aliases = Array.isArray(item.aliases) ? item.aliases : [];
    const usageText = String(item.usage || '').trim();

    const matchedCmds = commands.filter((cmd) => {
      if (!query) return true;
      const cmdLower = String(cmd).toLowerCase();
      const aliasMatch = aliases.some((aliasItem) => String(aliasItem).toLowerCase().includes(query));
      return cmdLower.includes(query) || categoryKey.includes(query) || usageText.toLowerCase().includes(query) || aliasMatch;
    });

    if (matchedCmds.length === 0) continue;
    if (!grouped[categoryKey]) grouped[categoryKey] = [];
    grouped[categoryKey].push({
      commands: matchedCmds,
      aliases,
      usage: usageText,
      limit: Number(item.limit || 0),
      premiumOnly: Boolean(item.premiumOnly),
      ownerOnly: Boolean(item.ownerOnly)
    });
  }

  const categories = Object.keys(grouped).sort();
  if (categories.length === 0) {
    container.innerHTML = '<div class="col-span-full py-6 text-center text-xs text-slate-500 rounded-xl bg-slate-950/50 border border-dashed border-slate-800">Belum ada fitur yang cocok.</div>';
    return;
  }

  container.innerHTML = categories.map((cat) => {
    const isOff = currentDisabledCategories.includes(cat);
    const chipsHtml = grouped[cat].flatMap((entry) => {
      const aliasHint = entry.aliases.length > 0 ? `Alias: ${entry.aliases.map((aliasItem) => `.${aliasItem}`).join(', ')}` : '';
      const limitBadge = entry.limit > 0 ? `<span class="text-[9px] text-slate-400">L:${entry.limit}</span>` : '';
      const premBadge = entry.premiumOnly ? '<span class="px-1 rounded bg-sky-500/20 text-sky-300 text-[9px] font-bold">PRO</span>' : '';
      const ownerBadge = entry.ownerOnly ? '<span class="px-1 rounded bg-amber-500/20 text-amber-300 text-[9px] font-bold">OWN</span>' : '';

      return entry.commands.map((cmd) => {
        const cmdUsage = entry.usage ? ` ${entry.usage}` : '';
        return `<span title="${escapeHtmlString(aliasHint)}" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-900/90 border border-slate-800 text-[10px] font-mono-code text-slate-200"><span>.${escapeHtmlString(cmd)}${escapeHtmlString(cmdUsage)}</span>${limitBadge}${premBadge}${ownerBadge}</span>`;
      });
    }).join('');

    return `
      <div class="p-3.5 rounded-xl bg-slate-900/40 backdrop-blur-md border ${isOff ? 'border-slate-800/50 opacity-60' : 'border-slate-800 hover:border-slate-700'} flex flex-col justify-between gap-2.5 transition-all">
        <div class="flex items-center justify-between gap-2 pb-2 border-b border-slate-800/70">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-1.5 h-1.5 rounded-full ${isOff ? 'bg-slate-600' : 'accent-bg shadow-[0_0_8px_var(--accent-main)]'} shrink-0"></span>
            <span class="text-xs font-bold uppercase tracking-wider text-slate-100 font-mono-code truncate">${escapeHtmlString(cat)}</span>
          </div>
          <button type="button" data-category="${escapeHtmlString(cat)}" onclick="toggleBotFeatureCategory(this.dataset.category)" class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-all ${isOff ? 'bg-slate-900 border-slate-700' : 'accent-soft-bg accent-border'}" title="${isOff ? 'Aktifkan Kategori' : 'Nonaktifkan Kategori'}">
            <span class="inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${isOff ? 'translate-x-0.5 bg-slate-500' : 'translate-x-4 accent-bg shadow-[0_0_8px_var(--accent-main)]'}"></span>
          </button>
        </div>
        <div class="flex flex-wrap gap-1.5">${chipsHtml}</div>
      </div>
    `;
  }).join('');
}

function setRefreshSpinState(isSpinning, targetScope = 'all') {
  const pairs = [
    { key: 'users', btn: getEl('refreshUsersBtn'), icon: getEl('refreshUsersIcon') },
    { key: 'groups', btn: getEl('refreshGroupsBtn'), icon: getEl('refreshGroupsIcon') }
  ];
  pairs.forEach(({ key, btn, icon }) => {
    if (isSpinning && targetScope !== 'all' && targetScope !== key) return;
    if (btn) btn.disabled = isSpinning;
    if (icon) icon.classList.toggle('animate-spin', isSpinning);
  });
}

function stopRefreshSpinSmoothly() {
  if (refreshFallbackTimer) {
    clearTimeout(refreshFallbackTimer);
    refreshFallbackTimer = null;
  }
  const remainingDelay = Math.max(0, 350 - (Date.now() - refreshStartedAt));
  setTimeout(() => setRefreshSpinState(false, 'all'), remainingDelay);
}

function requestManagedEntities(targetScope = 'all') {
  refreshStartedAt = Date.now();
  setRefreshSpinState(true, targetScope);
  if (refreshFallbackTimer) clearTimeout(refreshFallbackTimer);
  refreshFallbackTimer = setTimeout(() => {
    setRefreshSpinState(false, 'all');
    refreshFallbackTimer = null;
  }, 8000);
  socketClient.emit('manage:list');
}

function setManagedUserFilter(filterKey) {
  managedUserFilter = filterKey;
  updateButtonGroupState(
    '.user-filter-pill',
    'data-user-filter',
    filterKey,
    'user-filter-pill px-2.5 py-1 rounded-full accent-bg text-slate-950 font-bold',
    'user-filter-pill px-2.5 py-1 rounded-full bg-slate-950 border border-slate-800 text-slate-400 hover:text-white'
  );
  renderManagedUsersTable();
}

// --- deteksi konsisten entri lid dari flag backend, akhiran @lid, maupun panjang digit lid ---
function isManagedUserLid(userObj) {
  if (!userObj) return false;
  if (userObj.isLid === true) return true;
  if (String(userObj.jid || '').endsWith('@lid')) return true;
  const digits = String(userObj.number || '').replace(/\D/g, '');
  return digits.length >= 14 && !digits.startsWith('62');
}

function getFilteredManagedUsers() {
  const query = String(getEl('manageUserSearchInput')?.value || '').toLowerCase();
  return managedUsersCache.filter((user) => {
    const matchQuery =
      String(user.number || '').toLowerCase().includes(query) ||
      String(user.name || '').toLowerCase().includes(query) ||
      String(user.jid || '').toLowerCase().includes(query);
    if (!matchQuery) return false;
    if (managedUserFilter === 'premium') return Boolean(user.premium);
    if (managedUserFilter === 'banned') return Boolean(user.banned);
    if (managedUserFilter === 'lid') return isManagedUserLid(user);
    return true;
  });
}

function syncBulkUserActionBar() {
  const bar = getEl('bulkUserActionBar');
  const count = selectedManagedUserJids.size;
  if (getEl('selectedUsersCountLabel')) getEl('selectedUsersCountLabel').textContent = count;
  if (bar) {
    bar.classList.toggle('hidden', count === 0);
    bar.classList.toggle('flex', count > 0);
  }
}

function toggleSingleManagedUserSelection(jid, isChecked) {
  if (isChecked) selectedManagedUserJids.add(jid);
  else selectedManagedUserJids.delete(jid);
  syncBulkUserActionBar();
}

function toggleSelectAllVisibleUsers() {
  const visibleUsers = getFilteredManagedUsers();
  if (visibleUsers.length === 0) return;
  const allSelected = visibleUsers.every((user) => selectedManagedUserJids.has(user.jid));
  visibleUsers.forEach((user) => (allSelected ? selectedManagedUserJids.delete(user.jid) : selectedManagedUserJids.add(user.jid)));
  renderManagedUsersTable();
}

function executeBulkUserAction(changes) {
  const jids = Array.from(selectedManagedUserJids);
  if (jids.length === 0) return;
  socketClient.emit('manage:users:bulkUpdate', { jids, ...changes });
  selectedManagedUserJids.clear();
  syncBulkUserActionBar();
}

function renderManagedUsersTable() {
  const cardGrid = getEl('managedUsersCardGrid');
  if (!cardGrid) return;

  const validSet = new Set(managedUsersCache.map((user) => user.jid));
  for (const jid of Array.from(selectedManagedUserJids)) {
    if (!validSet.has(jid)) selectedManagedUserJids.delete(jid);
  }
  syncBulkUserActionBar();

  const filtered = getFilteredManagedUsers();
  if (filtered.length === 0) {
    cardGrid.innerHTML = '<div class="col-span-full py-8 text-center text-xs text-slate-500 rounded-xl bg-slate-950/50 border border-dashed border-slate-800">Belum ada user terdata.</div>';
    return;
  }

  cardGrid.innerHTML = filtered.map((user) => {
    const isLid = isManagedUserLid(user);
    const isSelected = selectedManagedUserJids.has(user.jid);
    const lidBadge = isLid ? '<span class="px-1.5 py-0.5 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 font-mono-code text-[9px] font-bold">LID</span>' : '';
    const premiumBadgeClass = user.premium
      ? 'bg-sky-500/15 border-sky-400/40 text-sky-300 shadow-[0_0_12px_rgba(56,189,248,0.28)]'
      : 'bg-slate-950/80 border-slate-800 text-slate-400';
    const statusBadgeClass = user.banned
      ? 'bg-rose-500/15 border-rose-500/40 text-rose-300 shadow-[0_0_12px_rgba(244,63,94,0.28)]'
      : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.26)]';

    return `
      <div class="bg-slate-900/40 backdrop-blur-md border ${isSelected ? 'accent-border' : 'border-slate-800 hover:border-slate-700'} rounded-xl p-3 flex flex-col justify-between gap-2.5 transition-all">
        <div class="flex items-start justify-between gap-2">
          <div class="flex items-start gap-2 min-w-0">
            <input type="checkbox" ${isSelected ? 'checked' : ''} data-jid="${escapeHtmlString(user.jid)}" onchange="toggleSingleManagedUserSelection(this.dataset.jid, this.checked)" class="mt-0.5 w-3.5 h-3.5 accent-emerald-500 rounded cursor-pointer shrink-0" />
            <div class="min-w-0">
              <p class="text-xs font-bold text-white truncate">${escapeHtmlString(user.name)}</p>
              <div class="flex items-center gap-1.5 mt-0.5">
                <p class="text-[10px] font-mono-code text-slate-400 truncate">+${escapeHtmlString(user.number)}</p>
                ${lidBadge}
              </div>
            </div>
          </div>
          <label class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-950/90 border border-slate-800 focus-within:border-[var(--accent-main)] shrink-0" title="Ubah Limit User">
            <span class="text-[9px] uppercase font-mono-code text-slate-500">LIM</span>
            <input type="number" min="0" value="${Number(user.limit || 0)}" data-jid="${escapeHtmlString(user.jid)}" onchange="updateManagedUser(this.dataset.jid, { limit: Number(this.value) })" class="w-10 bg-transparent text-[11px] font-mono-code font-bold accent-text text-right focus:outline-none" />
          </label>
        </div>
        <div class="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/70">
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${premiumBadgeClass}">
              <span class="w-1.5 h-1.5 rounded-full ${user.premium ? 'bg-sky-400' : 'bg-slate-500'}"></span>
              ${user.premium ? 'Premium' : 'Reguler'}
            </span>
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold ${statusBadgeClass}">
              <span class="w-1.5 h-1.5 rounded-full ${user.banned ? 'bg-rose-400' : 'bg-emerald-400'}"></span>
              ${user.banned ? 'Banned' : 'Aktif'}
            </span>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            <button type="button" data-jid="${escapeHtmlString(user.jid)}" onclick="updateManagedUser(this.dataset.jid, { premium: ${!user.premium} })" title="${user.premium ? 'Cabut Premium Reseller' : 'Aktifkan Premium Reseller'}" class="w-7 h-7 rounded-full flex items-center justify-center border transition-all active:scale-90 ${user.premium ? 'bg-sky-500/20 border-sky-400/40 text-sky-300 hover:bg-sky-500/30' : 'bg-slate-950/90 border-slate-800 text-slate-400 hover:text-sky-300 hover:border-sky-500/40'}">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/></svg>
            </button>
            <button type="button" data-jid="${escapeHtmlString(user.jid)}" onclick="updateManagedUser(this.dataset.jid, { banned: ${!user.banned} })" title="${user.banned ? 'Buka Banned User' : 'Ban User'}" class="w-7 h-7 rounded-full flex items-center justify-center border transition-all active:scale-90 ${user.banned ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/25' : 'bg-slate-950/90 border-slate-800 text-slate-400 hover:text-amber-300 hover:border-amber-500/40'}">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg>
            </button>
            <button type="button" data-jid="${escapeHtmlString(user.jid)}" data-name="${escapeHtmlString(user.name)}" data-number="${escapeHtmlString(user.number)}" onclick="openDeleteUserModal(this.dataset.jid, this.dataset.name, this.dataset.number)" title="Hapus User Permanen" class="w-7 h-7 rounded-full flex items-center justify-center bg-slate-950/90 hover:bg-rose-500/20 border border-slate-800 hover:border-rose-500/40 text-slate-400 hover:text-rose-400 transition-all active:scale-90">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function openDeleteUserModal(jid, name, number) {
  pendingDeleteUserJid = jid;
  if (getEl('deleteUserTargetLabel')) getEl('deleteUserTargetLabel').textContent = `${name} (+${number})`;
  toggleModalVisibility('deleteUserConfirmModal', true);
}

function closeDeleteUserModal() {
  pendingDeleteUserJid = null;
  toggleModalVisibility('deleteUserConfirmModal', false);
}

function confirmDeleteManagedUser() {
  if (!pendingDeleteUserJid) return;
  socketClient.emit('manage:user:delete', { jid: pendingDeleteUserJid });
  closeDeleteUserModal();
}

function renderManagedGroupsTable() {
  const cardGrid = getEl('managedGroupsCardGrid');
  const query = String(getEl('manageGroupSearchInput')?.value || '').trim().toLowerCase();
  if (!cardGrid) return;

  const filtered = managedGroupsCache.filter(
    (groupItem) => String(groupItem.subject || '').toLowerCase().includes(query) || String(groupItem.jid || '').toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    cardGrid.innerHTML = '<div class="col-span-full py-8 text-center text-xs text-slate-500 rounded-xl bg-slate-950/50 border border-dashed border-slate-800">Belum ada grup aktif terdata.</div>';
    return;
  }

  cardGrid.innerHTML = filtered.map((groupItem) => {
    const isActive = !groupItem.banned;
    return `
      <div class="bg-slate-900/40 backdrop-blur-md border border-slate-800 hover:border-slate-700 rounded-xl p-3 flex flex-col justify-between gap-2.5 transition-all">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-xs font-bold text-white truncate">${escapeHtmlString(groupItem.subject || groupItem.jid)}</p>
            <p class="text-[10px] font-mono-code text-slate-500 truncate mt-0.5">${escapeHtmlString(groupItem.jid)}</p>
          </div>
          <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-950/90 border border-slate-800 text-[10px] font-mono-code text-slate-300 shrink-0">
            <svg class="w-3 h-3 accent-text" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
            <strong>${Number(groupItem.participantsCount || 0)}</strong>
          </span>
        </div>
        <div class="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/70">
          <span class="inline-flex items-center gap-1.5 text-[10px] font-semibold ${isActive ? 'text-emerald-300' : 'text-rose-300'}">
            <span class="w-1.5 h-1.5 rounded-full ${isActive ? 'bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.8)]' : 'bg-rose-400 shadow-[0_0_8px_rgba(244,63,94,0.8)]'}"></span>
            ${isActive ? 'Akses Bot Aktif' : 'Grup Dibanned'}
          </span>
          <div class="flex items-center gap-2 shrink-0">
            <button type="button" data-jid="${escapeHtmlString(groupItem.jid)}" data-subject="${escapeHtmlString(groupItem.subject || groupItem.jid)}" onclick="openGroupVisualConfigModal(this.dataset.jid, this.dataset.subject)" class="px-2 py-0.5 rounded-lg bg-slate-950 hover:bg-slate-800 border border-slate-800 text-[10px] font-semibold text-slate-200 transition-colors">
              Atur
            </button>
            <button type="button" data-jid="${escapeHtmlString(groupItem.jid)}" onclick="updateManagedGroup(this.dataset.jid, { banned: ${!groupItem.banned} })" title="${isActive ? 'Matikan Akses Grup (Ban)' : 'Aktifkan Kembali Akses Grup'}" class="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-all active:scale-95 ${isActive ? 'bg-emerald-500/20 border-emerald-500/40' : 'bg-rose-500/15 border-rose-500/40'}">
              <span class="inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${isActive ? 'translate-x-4 bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.75)]' : 'translate-x-0.5 bg-rose-400'}"></span>
            </button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function updateManagedUser(jid, changes) { socketClient.emit('manage:user:update', { jid, ...changes }); }
function updateManagedGroup(jid, changes) { socketClient.emit('manage:group:update', { jid, ...changes }); }

// --- manajemen plugin ide khusus admin & backup zip ---
function syncCategoryFilterOptions(pluginsArray) {
  const selectEl = getEl('pluginCategoryFilter');
  if (!selectEl) return;
  const currentVal = selectEl.value || 'all';
  const categories = Array.from(new Set(pluginsArray.map((pluginItem) => pluginItem.category || 'root'))).sort();
  selectEl.innerHTML = '<option value="all">Semua</option>' +
    categories.map((cat) => `<option value="${escapeHtmlString(cat)}">${escapeHtmlString(cat)}</option>`).join('');
  if (categories.includes(currentVal)) selectEl.value = currentVal;
}

function renderPluginsList(pluginsArray) {
  loadedPluginsCache = pluginsArray || [];
  syncCategoryFilterOptions(loadedPluginsCache);

  const container = getEl('pluginsFileListContainer');
  if (!container) return;
  container.innerHTML = '';

  const searchQuery = String(getEl('pluginSearchInput')?.value || '').toLowerCase();
  const selectedCategory = getEl('pluginCategoryFilter')?.value || 'all';
  const filteredPlugins = loadedPluginsCache.filter((item) => {
    const matchSearch = item.fileName.toLowerCase().includes(searchQuery);
    const matchCategory = selectedCategory === 'all' || (item.category || 'root') === selectedCategory;
    return matchSearch && matchCategory;
  });

  if (filteredPlugins.length === 0) {
    container.innerHTML = '<p class="text-xs text-slate-500">Tidak ada plugin yang cocok.</p>';
    return;
  }

  filteredPlugins.forEach((pluginItem) => {
    const isEnabled = pluginItem.isEnabled !== false;
    const card = document.createElement('div');
    card.className = `flex items-center justify-between gap-2 p-2.5 rounded-xl bg-slate-950/80 border ${isEnabled ? 'border-slate-800 hover:border-slate-700' : 'border-slate-800/50 opacity-60'} transition-all`;
    card.innerHTML = `
      <button type="button" data-file="${escapeHtmlString(pluginItem.fileName)}" onclick="selectPluginForEditing(this.dataset.file)" class="text-left flex-1 min-w-0">
        <p class="text-xs font-bold text-slate-200 font-mono-code truncate">${escapeHtmlString(pluginItem.fileName)}</p>
        <p class="text-[10px] text-slate-500 mt-0.5">${escapeHtmlString(pluginItem.category || 'root')} • ${isEnabled ? 'Aktif' : 'Nonaktif'}</p>
      </button>
      <div class="flex items-center gap-1 shrink-0">
        <button type="button" data-file="${escapeHtmlString(pluginItem.fileName)}" onclick="togglePluginActiveState(this.dataset.file)" class="px-2 py-1 rounded-lg text-[10px] font-semibold ${isEnabled ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25' : 'bg-slate-800 text-slate-400'}">
          ${isEnabled ? 'ON' : 'OFF'}
        </button>
        <button type="button" data-file="${escapeHtmlString(pluginItem.fileName)}" onclick="deletePluginFile(this.dataset.file)" class="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-all">
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
        </button>
      </div>
    `;
    container.appendChild(card);
  });
}

function togglePluginActiveState(fileName) { socketClient.emit('plugin:toggle', { fileName }); }

async function downloadPlatformBackupZip() {
  const isVerifiedAdminId = String(currentGoogleUserId || '').trim() === EXCLUSIVE_ADMIN_GOOGLE_ID;
  if (!isCurrentUserAdmin || !isVerifiedAdminId) {
    showCyberToast('Access denied', 'The ZIP backup feature is only available to platform developers.', 'danger');
    return;
  }

  showCyberToast('Backup ZIP', 'Memverifikasi akses & menyiapkan arsip backup...', 'info');
  try {
    const response = await fetch('/api/backup/download', { method: 'GET', credentials: 'same-origin' });
    if (!response.ok) {
      const errorPayload = await response.json().catch(() => ({}));
      showCyberToast('Access denied', errorPayload.errorMessage || 'Akses ditolak.', 'danger');
      return;
    }
    const dispositionHeader = response.headers.get('Content-Disposition') || '';
    const fileNameMatch = dispositionHeader.match(/filename="([^"]+)"/i);
    const downloadFileName = fileNameMatch ? fileNameMatch[1] : `xu-core-backup-${Date.now()}.zip`;
    const zipBlob = await response.blob();
    const objectUrl = URL.createObjectURL(zipBlob);
    const downloadAnchor = document.createElement('a');
    downloadAnchor.href = objectUrl;
    downloadAnchor.download = downloadFileName;
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    URL.revokeObjectURL(objectUrl);
    showCyberToast('Backup Berhasil', `Arsip ${downloadFileName} berhasil diunduh.`, 'success');
  } catch {
    showCyberToast('Gagal Mengunduh', 'Terjadi gangguan jaringan saat mengambil arsip Backup ZIP.', 'danger');
  }
}

function updateEditorLineNumbers() {
  const textarea = getEl('pluginCodeEditorTextarea');
  const gutter = getEl('editorLineNumbersGutter');
  if (!textarea || !gutter) return;
  const lineCount = (textarea.value || '').split('\n').length;
  gutter.textContent = Array.from({ length: lineCount }, (_, idx) => idx + 1).join('\n');
}

function setupCodeEditorEnhancements() {
  const textarea = getEl('pluginCodeEditorTextarea');
  const gutter = getEl('editorLineNumbersGutter');
  if (!textarea || !gutter) return;

  textarea.addEventListener('input', updateEditorLineNumbers);
  textarea.addEventListener('scroll', () => { gutter.scrollTop = textarea.scrollTop; });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value = `${textarea.value.substring(0, start)}  ${textarea.value.substring(end)}`;
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      updateEditorLineNumbers();
    }
  });
  updateEditorLineNumbers();
}

function selectPluginForEditing(fileName, showToast = true) {
  const found = loadedPluginsCache.find((item) => item.fileName === fileName);
  if (!found) return;
  if (getEl('pluginFileNameInput')) getEl('pluginFileNameInput').value = found.fileName;
  if (getEl('pluginCodeEditorTextarea')) getEl('pluginCodeEditorTextarea').value = found.codeContent ?? '';
  updateEditorLineNumbers();
  if (showToast) showTopToast(`Membuka ${found.fileName}`);
}

function prepareNewPluginTemplate() {
  if (getEl('pluginFileNameInput')) getEl('pluginFileNameInput').value = 'info/custom-command.js';
  if (getEl('pluginCodeEditorTextarea')) {
    getEl('pluginCodeEditorTextarea').value =
`const run = async (m, client, { cfg }) => {
  await m.reply(\`Halo dari \${cfg.botName}! Perintah: \${m.cmd}\`);
};

export default {
  run,
  cmd: ['halo'],
  use: '',
  type: 'info',
  limit: 1,
  restrict: false
};`;
  }
  updateEditorLineNumbers();
  showTopToast('Template plugin baru siap disunting');
}

function saveAndApplyPlugin() {
  const fileName = getEl('pluginFileNameInput')?.value.trim() || '';
  const codeContent = getEl('pluginCodeEditorTextarea')?.value || '';
  if (!fileName) return showTopToast('Nama file plugin wajib diisi', true);
  socketClient.emit('plugin:save', { fileName, codeContent });
}

function deletePluginFile(fileName) { socketClient.emit('plugin:delete', { fileName }); }
function copyEditorCode() { copyTextToClipboard(getEl('pluginCodeEditorTextarea')?.value, 'Kode Disalin', 'Editor masih kosong.'); }

async function pasteEditorCode() {
  const textarea = getEl('pluginCodeEditorTextarea');
  if (!textarea) return;
  try {
    textarea.value = await navigator.clipboard.readText();
    updateEditorLineNumbers();
    showTopToast('Kode ditempel dari clipboard');
  } catch {
    showTopToast('Izin clipboard ditolak browser', true);
  }
}

function clearEditorCode() {
  const textarea = getEl('pluginCodeEditorTextarea');
  if (textarea) {
    textarea.value = '';
    updateEditorLineNumbers();
    showTopToast('Editor dibersihkan');
  }
}

function updateCodeInspectorReport(errorMessageText, hasError) {
  const box = getEl('developerErrorReportBox');
  const dot = getEl('inspectorIndicatorDot');
  const badge = getEl('inspectorStatusBadge');
  const viewport = getEl('inspectorTerminalViewport');
  const output = getEl('inspectorErrorDetailOutput');
  if (!box || !output) return;

  if (hasError) {
    box.className = 'rounded-xl bg-rose-950/20 border border-rose-500/40 p-3.5 sm:p-4 transition-all duration-200 space-y-2.5';
    dot.className = 'w-2 h-2 rounded-full bg-rose-500 animate-ping shrink-0';
    badge.className = 'inline-flex items-center px-2.5 py-0.5 rounded-md bg-rose-500/15 text-rose-300 border border-rose-500/30 text-[11px] font-semibold font-mono-code shrink-0';
    badge.textContent = 'Status: Error Terdeteksi';
    viewport.className = 'rounded-lg bg-black/80 border border-rose-500/30 p-3 overflow-x-auto';
    output.className = 'text-[11px] sm:text-xs font-mono-code text-rose-300 leading-relaxed whitespace-pre-wrap break-words';
    output.textContent = errorMessageText;
  } else {
    box.className = 'rounded-xl bg-emerald-950/15 border border-emerald-500/30 p-3.5 sm:p-4 transition-all duration-200 space-y-2.5';
    dot.className = 'w-2 h-2 rounded-full bg-emerald-400 shrink-0';
    badge.className = 'inline-flex items-center px-2.5 py-0.5 rounded-md bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[11px] font-semibold font-mono-code shrink-0';
    badge.textContent = 'Status: Aman / Ready';
    viewport.className = 'rounded-lg bg-black/80 border border-emerald-500/20 p-3 overflow-x-auto';
    output.className = 'text-[11px] sm:text-xs font-mono-code text-emerald-300/90 leading-relaxed whitespace-pre-wrap break-words';
    output.textContent = errorMessageText || 'Belum ada error sintaks maupun runtime yang terdeteksi.';
  }
}
// --- modul stiker hibrida via supabase storage & sinkronisasi localStorage ---
function getUserStickerStorageKey(userId) {
  return `${STICKER_CACHE_PREFIX}${String(userId || currentGoogleUserId || 'guest')}`;
}

function readLocalCachedStickers(userId) {
  try {
    const rawJson = localStorage.getItem(getUserStickerStorageKey(userId));
    if (!rawJson) return null;
    const parsed = JSON.parse(rawJson);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveLocalCachedStickers(userId, stickersArray) {
  try {
    localStorage.setItem(getUserStickerStorageKey(userId), JSON.stringify(stickersArray || []));
  } catch {
    // --- abaikan jika kuota localStorage penuh ---
  }
}

function prefetchImageUrlSafe(imageUrl, timeoutMs = 4500) {
  return new Promise((resolve) => {
    if (!imageUrl) {
      resolve(false);
      return;
    }
    let isSettled = false;
    const timer = setTimeout(() => {
      if (!isSettled) {
        isSettled = true;
        resolve(false);
      }
    }, timeoutMs);

    const imgObj = new Image();
    imgObj.onload = () => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve(true);
      }
    };
    imgObj.onerror = () => {
      if (!isSettled) {
        isSettled = true;
        clearTimeout(timer);
        resolve(false);
      }
    };
    imgObj.src = imageUrl;
  });
}

// --- tarik dan cache url stiker supabase ke localStorage dengan progress bar pada perangkat baru ---
async function syncStickersFromSupabaseToLocal(userId, serverStickersInput) {
  if (isStickerSyncRunning) return;

  const normalizedServerList = Array.isArray(serverStickersInput)
    ? serverStickersInput.filter((entry) => entry && entry.url)
    : [];
  const cachedList = readLocalCachedStickers(userId);

  const isAlreadySynced =
    Array.isArray(cachedList) &&
    cachedList.length === normalizedServerList.length &&
    cachedList.every((cachedItem, idx) => cachedItem?.url === normalizedServerList[idx]?.url);

  if (isAlreadySynced) {
    communityStickersCache = cachedList;
    renderCommunityStickerGrid();
    return;
  }

  if (normalizedServerList.length === 0) {
    communityStickersCache = [];
    saveLocalCachedStickers(userId, []);
    renderCommunityStickerGrid();
    return;
  }

  isStickerSyncRunning = true;
  const progressWrap = getEl('stickerSyncProgressWrap');
  const progressBar = getEl('stickerSyncProgressBar');
  const percentLabel = getEl('stickerSyncPercentLabel');
  const statusText = getEl('stickerSyncStatusText');

  if (progressWrap) progressWrap.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '5%';
  if (percentLabel) percentLabel.textContent = '5%';
  if (statusText) {
    statusText.textContent = `Menyinkronkan 0/${normalizedServerList.length} stiker dari Supabase...`;
  }

  const totalCount = normalizedServerList.length;
  for (let index = 0; index < totalCount; index += 1) {
    const stickerEntry = normalizedServerList[index];
    await prefetchImageUrlSafe(stickerEntry.url);

    const completed = index + 1;
    const progressPercent = Math.round((completed / totalCount) * 100);
    if (progressBar) progressBar.style.width = `${progressPercent}%`;
    if (percentLabel) percentLabel.textContent = `${progressPercent}%`;
    if (statusText) {
      statusText.textContent = `Menarik stiker Supabase (${completed}/${totalCount}) ke perangkat ini...`;
    }
  }

  communityStickersCache = normalizedServerList;
  saveLocalCachedStickers(userId, normalizedServerList);
  renderCommunityStickerGrid();

  if (statusText) statusText.textContent = 'Sinkronisasi stiker selesai. Pemuatan berikutnya instan.';
  setTimeout(() => {
    progressWrap?.classList.add('hidden');
    isStickerSyncRunning = false;
  }, 650);
}

// --- konversi file gambar ke data url base64 untuk unggahan stiker & media chat ---
function readFileAsDataUrlPromise(fileObj) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Gagal membaca file dari perangkat.'));
    reader.readAsDataURL(fileObj);
  });
}

// --- multi-select gambar dari galeri untuk diunggah sebagai stiker ke supabase storage ---
async function handleStickerMultiFileSelect(event) {
  const filesList = Array.from(event?.target?.files || []);
  if (filesList.length === 0) return;

  const limitedFiles = filesList.slice(0, 12);
  const progressWrap = getEl('stickerSyncProgressWrap');
  const progressBar = getEl('stickerSyncProgressBar');
  const percentLabel = getEl('stickerSyncPercentLabel');
  const statusText = getEl('stickerSyncStatusText');

  if (progressWrap) progressWrap.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '15%';
  if (percentLabel) percentLabel.textContent = '15%';
  if (statusText) statusText.textContent = `Menyiapkan ${limitedFiles.length} gambar stiker...`;

  try {
    const base64Items = [];
    for (let fileIdx = 0; fileIdx < limitedFiles.length; fileIdx += 1) {
      const currentFile = limitedFiles[fileIdx];
      if (currentFile.size > 4 * 1024 * 1024) {
        showCyberToast('File Dilewati', `${currentFile.name} melebihi batas 4 MB.`, 'danger');
        continue;
      }
      const dataUrl = await readFileAsDataUrlPromise(currentFile);
      if (dataUrl) base64Items.push(dataUrl);
    }

    if (base64Items.length === 0) {
      progressWrap?.classList.add('hidden');
      if (event.target) event.target.value = '';
      return;
    }

    if (progressBar) progressBar.style.width = '55%';
    if (percentLabel) percentLabel.textContent = '55%';
    if (statusText) statusText.textContent = `Mengunggah ${base64Items.length} stiker ke Supabase Storage...`;

    const response = await fetch('/api/stickers/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stickers: base64Items })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.isSuccess) {
      throw new Error(result.errorMessage || 'Gagal mengunggah stiker ke Supabase.');
    }

    if (progressBar) progressBar.style.width = '100%';
    if (percentLabel) percentLabel.textContent = '100%';
    if (statusText) statusText.textContent = `${result.addedCount || base64Items.length} stiker berhasil disimpan.`;

    communityStickersCache = Array.isArray(result.stickers) ? result.stickers : communityStickersCache;
    saveLocalCachedStickers(currentGoogleUserId, communityStickersCache);
    renderCommunityStickerGrid();
    showCyberToast('Stiker Ditambahkan', `${result.addedCount || base64Items.length} stiker siap digunakan.`, 'success');
  } catch (uploadErr) {
    showCyberToast('Upload Stiker Gagal', uploadErr.message, 'danger');
  } finally {
    if (event.target) event.target.value = '';
    setTimeout(() => progressWrap?.classList.add('hidden'), 700);
  }
}

// --- hapus stiker tertentu dari koleksi user ---
async function deleteCommunityStickerItem(stickerId, event) {
  if (event) event.stopPropagation();
  if (!stickerId) return;

  try {
    const response = await fetch(`/api/stickers/${encodeURIComponent(stickerId)}`, {
      method: 'DELETE',
      credentials: 'same-origin'
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.isSuccess) {
      throw new Error(result.errorMessage || 'Gagal menghapus stiker.');
    }

    communityStickersCache = Array.isArray(result.stickers) ? result.stickers : [];
    saveLocalCachedStickers(currentGoogleUserId, communityStickersCache);
    renderCommunityStickerGrid();
    showCyberToast('Stiker Dihapus', 'Stiker dihapus dari koleksi Anda.', 'info');
  } catch (deleteErr) {
    showCyberToast('Gagal Hapus Stiker', deleteErr.message, 'danger');
  }
}

// --- render grid stiker pada bottom sheet chat.html dengan dimensi persegi terkunci ---
function renderCommunityStickerGrid() {
  const gridEl = getEl('stickerGridContainer');
  const countEl = getEl('stickerCountBadge');
  if (countEl) countEl.textContent = String(communityStickersCache.length);
  if (!gridEl) return;

  const createTileHtml = `
    <button type="button" onclick="getEl('stickerMultiFileInput')?.click()" class="w-full aspect-square min-w-0 rounded-2xl bg-slate-900/90 hover:bg-slate-800 border-2 border-dashed border-slate-700 hover:border-[var(--accent-main)] flex flex-col items-center justify-center gap-1.5 text-slate-300 hover:text-white transition-all active:scale-95">
      <svg class="w-6 h-6 accent-text" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M12 4v16m8-8H4"/></svg>
      <span class="text-[11px] font-bold">Buat</span>
    </button>
  `;

  const stickerTilesHtml = communityStickersCache.map((stickerItem) => `
    <div onclick="sendCommunityStickerMessage('${escapeHtmlString(stickerItem.url)}')" role="button" tabindex="0" class="group relative w-full aspect-square min-w-0 rounded-2xl bg-slate-900/75 hover:bg-slate-800/90 border border-slate-800 hover:border-[var(--accent-border)] p-1.5 flex items-center justify-center cursor-pointer transition-all active:scale-95 overflow-hidden">
      <img src="${escapeHtmlString(stickerItem.url)}" alt="Stiker" loading="lazy" class="w-full h-full max-w-full max-h-full object-contain rounded-xl select-none pointer-events-none" />
      <button type="button" data-sticker-id="${escapeHtmlString(stickerItem.id || '')}" onclick="deleteCommunityStickerItem(this.dataset.stickerId, event)" title="Hapus Stiker" aria-label="Hapus Stiker" class="absolute top-1.5 right-1.5 z-10 w-5 h-5 rounded-full bg-slate-950/90 hover:bg-rose-500 border border-slate-700 text-slate-300 hover:text-white flex items-center justify-center text-[10px] opacity-90 sm:opacity-0 sm:group-hover:opacity-100 transition-all">
        ✕
      </button>
    </div>
  `).join('');

  gridEl.innerHTML = `${createTileHtml}${stickerTilesHtml}`;
}

// --- kirim stiker ke ruang aktif (community atau dm xu core) ---
function sendCommunityStickerMessage(stickerUrl) {
  if (!stickerUrl) return;
  if (activeChatRoomType === 'dm' && activeChatRoomTargetId) {
    socketClient.emit('dm:send', {
      peerUserId: activeChatRoomTargetId,
      type: 'sticker',
      mediaUrl: stickerUrl,
      text: '',
      replyTo: activeCommunityReplyTarget
    });
  } else {
    socketClient.emit('community:message:send', {
      type: 'sticker',
      mediaUrl: stickerUrl,
      text: '',
      replyTo: activeCommunityReplyTarget
    });
  }
  clearCommunityReplyTarget();
  closeStickerBottomSheet();
}

function isStickerUrlFavorited(stickerUrl) {
  if (!stickerUrl) return false;
  return communityStickersCache.some((item) => item?.url === stickerUrl);
}

function renderStickerFavoriteSheetState() {
  const toggleBtn = getEl('stickerFavoriteToggleBtn');
  const toggleIcon = getEl('stickerFavoriteToggleIcon');
  const toggleLabel = getEl('stickerFavoriteToggleLabel');
  if (!toggleBtn || !toggleLabel) return;

  const isSaved = isStickerUrlFavorited(activeInspectStickerUrl);
  if (isSaved) {
    toggleBtn.className = 'w-full py-3 px-4 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/35 text-rose-300 font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-60';
    toggleLabel.textContent = 'Hapus dari Favorit';
    if (toggleIcon) {
      toggleIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>';
    }
  } else {
    toggleBtn.className = 'w-full py-3 px-4 rounded-xl accent-bg text-slate-950 font-extrabold text-xs sm:text-sm flex items-center justify-center gap-2 transition-all active:scale-95 accent-shadow disabled:opacity-60';
    toggleLabel.textContent = 'Tambahkan ke Favorit';
    if (toggleIcon) {
      toggleIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"/>';
    }
  }
}

function openStickerFavoriteSheet(stickerUrl, senderName = 'Member', event) {
  if (event) event.stopPropagation();
  if (!stickerUrl) return;

  activeInspectStickerUrl = stickerUrl;
  if (getEl('stickerFavoritePreviewImg')) getEl('stickerFavoritePreviewImg').src = stickerUrl;
  if (getEl('stickerFavoriteSenderLabel')) {
    getEl('stickerFavoriteSenderLabel').textContent = `Dikirim oleh ${senderName || 'Member'}`;
  }

  renderStickerFavoriteSheetState();
  toggleModalVisibility('stickerFavoriteSheetOverlay', true);
}

function closeStickerFavoriteSheet() {
  activeInspectStickerUrl = '';
  toggleModalVisibility('stickerFavoriteSheetOverlay', false);
}

async function toggleStickerFavoriteStatus() {
  if (!activeInspectStickerUrl) return;

  const toggleBtn = getEl('stickerFavoriteToggleBtn');
  const isCurrentlySaved = isStickerUrlFavorited(activeInspectStickerUrl);
  const actionType = isCurrentlySaved ? 'remove' : 'add';

  if (toggleBtn) toggleBtn.disabled = true;
  try {
    const response = await fetch('/api/stickers/favorite', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: activeInspectStickerUrl,
        action: actionType
      })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.isSuccess) {
      throw new Error(result.errorMessage || 'Gagal memperbarui stiker favorit.');
    }

    communityStickersCache = Array.isArray(result.stickers) ? result.stickers : [];
    saveLocalCachedStickers(currentGoogleUserId, communityStickersCache);
    renderCommunityStickerGrid();
    renderStickerFavoriteSheetState();

    showCyberToast(
      actionType === 'add' ? 'Disimpan ke Favorit' : 'Dihapus dari Favorit',
      actionType === 'add'
        ? 'Stiker kini tersedia di koleksi Stiker Anda.'
        : 'Stiker telah dihapus dari koleksi favorit Anda.',
      actionType === 'add' ? 'success' : 'info'
    );
    closeStickerFavoriteSheet();
  } catch (favoriteErr) {
    showCyberToast('Gagal Memproses', favoriteErr.message, 'danger');
  } finally {
    if (toggleBtn) toggleBtn.disabled = false;
  }
}

// --- buka/tutup menu lampiran (foto, video, stiker) & sheet stiker ---
function toggleChatAttachMenu(event) {
  if (event) event.stopPropagation();
  isChatAttachMenuOpen = !isChatAttachMenuOpen;
  const popup = getEl('chatAttachMenuPopup');
  if (popup) popup.classList.toggle('hidden', !isChatAttachMenuOpen);
}

function closeChatAttachMenu() {
  isChatAttachMenuOpen = false;
  getEl('chatAttachMenuPopup')?.classList.add('hidden');
}

function openStickerBottomSheet() {
  closeChatAttachMenu();
  isStickerSheetOpen = true;
  toggleModalVisibility('stickerBottomSheet', true);
  renderCommunityStickerGrid();

  if (!readLocalCachedStickers(currentGoogleUserId) && communityStickersCache.length > 0) {
    syncStickersFromSupabaseToLocal(currentGoogleUserId, communityStickersCache);
  }
}

function closeStickerBottomSheet() {
  isStickerSheetOpen = false;
  toggleModalVisibility('stickerBottomSheet', false);
}

function triggerChatMediaUpload(mediaType) {
  closeChatAttachMenu();
  if (mediaType === 'video') {
    getEl('chatVideoFileInput')?.click();
  } else {
    getEl('chatPhotoFileInput')?.click();
  }
}

// --- unggah lampiran foto atau video room chat ke supabase storage ---
async function handleChatMediaFileSelected(event, mediaType) {
  const fileObj = event?.target?.files?.[0];
  if (!fileObj) return;

  const maxLimitBytes = mediaType === 'video' ? 14 * 1024 * 1024 : 6 * 1024 * 1024;
  if (fileObj.size > maxLimitBytes) {
    const maxMbLabel = Math.round(maxLimitBytes / (1024 * 1024));
    showCyberToast('File Terlalu Besar', `Maksimal ukuran ${mediaType === 'video' ? 'video' : 'foto'} adalah ${maxMbLabel} MB.`, 'danger');
    if (event.target) event.target.value = '';
    return;
  }

  const uploadBar = getEl('chatMediaUploadStatusBar');
  const uploadText = getEl('chatMediaUploadStatusText');
  if (uploadBar) uploadBar.classList.remove('hidden');
  if (uploadText) uploadText.textContent = `Mengunggah ${mediaType === 'video' ? 'video' : 'foto'} (${fileObj.name})...`;

  try {
    const dataUrl = await readFileAsDataUrlPromise(fileObj);
    const response = await fetch('/api/chat/media/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mediaType, dataUrl })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.isSuccess || !result.url) {
      throw new Error(result.errorMessage || 'Gagal mengunggah media.');
    }

    const optionalCaption = String(getEl('communityMessageInput')?.value || '').trim();
    if (activeChatRoomType === 'dm' && activeChatRoomTargetId) {
      socketClient.emit('dm:send', {
        peerUserId: activeChatRoomTargetId,
        type: mediaType === 'video' ? 'video' : 'image',
        mediaUrl: result.url,
        text: optionalCaption,
        replyTo: activeCommunityReplyTarget
      });
    } else {
      socketClient.emit('community:message:send', {
        type: mediaType === 'video' ? 'video' : 'image',
        mediaUrl: result.url,
        text: optionalCaption,
        replyTo: activeCommunityReplyTarget
      });
    }

    if (getEl('communityMessageInput')) getEl('communityMessageInput').value = '';
    clearCommunityReplyTarget();
  } catch (mediaErr) {
    showCyberToast('Upload Media Gagal', mediaErr.message, 'danger');
  } finally {
    if (event.target) event.target.value = '';
    uploadBar?.classList.add('hidden');
  }
}

// --- laci sidebar daftar anggota komunitas dengan badge segi-enam bersinar ---
function toggleMembersDrawer(forceOpen) {
  isMembersDrawerOpen = typeof forceOpen === 'boolean' ? forceOpen : !isMembersDrawerOpen;
  const backdrop = getEl('membersDrawerBackdrop');
  const panel = getEl('membersDrawerPanel');

  if (backdrop) backdrop.classList.toggle('hidden', !isMembersDrawerOpen);
  if (panel) {
    panel.classList.toggle('-translate-x-full', !isMembersDrawerOpen);
    panel.classList.toggle('translate-x-0', isMembersDrawerOpen);
  }
}

function renderCommunityMembersDrawer() {
  const listEl = getEl('membersDrawerListContainer');
  const totalBadge = getEl('membersDrawerTotalLabel');
  const headerMembersEl = getEl('communityMembersCountLabel');
  const headerOnlineEl = getEl('communityOnlineCountLabel');

  const totalCount = communityMembersCache.length;
  const onlineCount = communityMembersCache.filter((member) => member.isOnline).length;

  if (totalBadge) totalBadge.textContent = `${totalCount} anggota • ${onlineCount} online`;
  if (headerMembersEl) headerMembersEl.textContent = `${totalCount} anggota`;
  if (headerOnlineEl) headerOnlineEl.textContent = `${onlineCount} online`;
  if (!listEl) return;

  const searchQuery = String(getEl('membersDrawerSearchInput')?.value || '').trim().toLowerCase();
  const filteredMembers = communityMembersCache.filter((member) => {
    if (!searchQuery) return true;
    const memberName = String(member.displayName || '').toLowerCase();
    const memberHandle = String(member.handle || '').toLowerCase();
    const memberRole = String(member.role || '').toLowerCase();
    return memberName.includes(searchQuery) || memberHandle.includes(searchQuery) || memberRole.includes(searchQuery);
  });

  if (filteredMembers.length === 0) {
    listEl.innerHTML = '<p class="text-xs font-mono-code text-slate-500 text-center py-8">Tidak ada anggota yang cocok.</p>';
    return;
  }

  listEl.innerHTML = filteredMembers.map((member) => {
    const displayName = member.displayName || 'Member';
    const isDev = String(member.role || '').toUpperCase() === 'DEVELOPER' || Boolean(member.isAdmin);
    const avatarUrl =
      member.avatarUrl ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=0f172a&color=10b981`;
    const handleText = member.handle
      ? `<p class="text-[11px] font-mono-code text-slate-400 truncate">${escapeHtmlString(member.handle.startsWith('@') ? member.handle : `@${member.handle}`)}</p>`
      : '';
    const roleBadgeHtml = isDev
      ? '<span class="role-hex-badge role-hex-developer mt-1"><span class="w-1.5 h-1.5 rounded-full bg-white"></span>DEVELOPER</span>'
      : '<span class="role-hex-badge role-hex-member mt-1">MEMBER</span>';

    return `
      <div class="flex items-center gap-3 p-2.5 rounded-xl bg-slate-900/60 hover:bg-slate-900 border border-slate-800/80 transition-colors">
        <div class="relative shrink-0">
          <img src="${escapeHtmlString(avatarUrl)}" alt="${escapeHtmlString(displayName)}" class="w-11 h-11 rounded-full object-cover border ${isDev ? 'border-rose-500/60' : 'border-emerald-500/45'}" />
          <span class="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-[#080d18] ${member.isOnline ? 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]' : 'bg-slate-600'}"></span>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-xs font-bold text-white truncate">${escapeHtmlString(displayName)}</p>
          ${handleText}
          <div>${roleBadgeHtml}</div>
        </div>
      </div>
    `;
  }).join('');
}

// --- periksa apakah objek pesan boleh disematkan (pengumuman admin atau media lampiran) ---
function isMessageEligibleForPin(messageItem) {
  if (!messageItem) return false;
  const pinnableTypes = ['image', 'video', 'sticker', 'audio', 'document', 'announcement', 'welcome'];
  const normalizedType = String(messageItem.type || '').trim().toLowerCase();
  return (
    pinnableTypes.includes(normalizedType) ||
    Boolean(messageItem.mediaUrl) ||
    Boolean(messageItem.isAnnouncement) ||
    Boolean(messageItem.isWelcome)
  );
}

// --- cari data pin aktif berdasarkan id pesan asli ---
function findPinnedEntryByMessageId(messageId) {
  if (!messageId) return null;
  return communityPinnedCache.find((pinItem) => pinItem?.messageId === messageId) || null;
}

// --- lompat secara instan ke posisi pesan asli di linimasa dan tampilkan efek highlight ---
function jumpToChatMessageInstant(targetMessageId) {
  if (!targetMessageId) return false;
  const targetRow = document.querySelector(`[data-community-msg-id="${CSS.escape(targetMessageId)}"]`);
  if (!targetRow) return false;

  targetRow.scrollIntoView({ behavior: 'instant', block: 'center' });
  const bubbleTarget = targetRow.querySelector('[data-bubble-msg-id]') || targetRow;

  bubbleTarget.classList.remove('message-jump-highlight');
  void bubbleTarget.offsetWidth;
  bubbleTarget.classList.add('message-jump-highlight');

  setTimeout(() => {
    bubbleTarget.classList.remove('message-jump-highlight');
  }, 1800);

  handleChatScrollVisibility();
  return true;
}

// --- navigasi instan ke pesan asli saat bar pesan disematkan diklik ---
function navigateToActivePinnedMessage(clickEvent) {
  if (clickEvent) clickEvent.stopPropagation();
  if (communityPinnedCache.length === 0) return;

  const activePin = communityPinnedCache[activePinnedCarouselIndex] || communityPinnedCache[0];
  if (activePin?.messageId) {
    const isFoundInTimeline = jumpToChatMessageInstant(activePin.messageId);
    if (isFoundInTimeline) return;
  }

  openPinnedMessagesModal();
}

// --- navigasi instan ke pesan asli dari daftar di dalam modal pesan disematkan ---
function jumpToPinnedItemFromModal(messageId) {
  if (!messageId) return;
  closePinnedMessagesModal();
  requestAnimationFrame(() => {
    const isJumped = jumpToChatMessageInstant(messageId);
    if (!isJumped) {
      showCyberToast('Pesan Tidak Ditemukan', 'Pesan asli sudah berada di luar riwayat linimasa terbaru.', 'info');
    }
  });
}

// --- bar pesan disematkan di bawah header (dikunci ketat khusus admin) ---
function renderCommunityPinnedBar() {
  const barEl = getEl('communityPinnedBar');
  const counterEl = getEl('communityPinnedCounter');
  const previewEl = getEl('communityPinnedPreviewText');
  const nextBtnEl = getEl('communityPinnedNextBtn');
  const modalListEl = getEl('communityPinnedModalList');
  const adminFormEl = getEl('communityPinnedAdminForm');

  if (adminFormEl) {
    adminFormEl.classList.toggle('hidden', !isCurrentUserAdmin);
  }

  if (barEl) {
    if (communityPinnedCache.length === 0 || activeChatRoomType !== 'community') {
      barEl.classList.add('hidden');
    } else {
      barEl.classList.remove('hidden');
      if (activePinnedCarouselIndex >= communityPinnedCache.length) {
        activePinnedCarouselIndex = 0;
      }
      const activePin = communityPinnedCache[activePinnedCarouselIndex];
      if (counterEl) {
        counterEl.textContent = `Pesan disematkan (${activePinnedCarouselIndex + 1}/${communityPinnedCache.length})`;
      }
      if (previewEl) {
        previewEl.textContent = activePin?.text || '-';
      }
      if (nextBtnEl) {
        const hasMultiplePins = communityPinnedCache.length > 1;
        nextBtnEl.classList.toggle('hidden', !hasMultiplePins);
        nextBtnEl.classList.toggle('flex', hasMultiplePins);
      }
    }
  }

  if (modalListEl) {
    if (communityPinnedCache.length === 0) {
      modalListEl.innerHTML = '<p class="text-xs font-mono-code text-slate-500 text-center py-6">Belum ada pesan yang disematkan.</p>';
    } else {
      modalListEl.innerHTML = communityPinnedCache.map((pinItem, pinIndex) => {
        const hasTargetMsg = Boolean(pinItem.messageId);
        const jumpAttr = hasTargetMsg
          ? `onclick="jumpToPinnedItemFromModal('${escapeHtmlString(pinItem.messageId)}')"`
          : '';
        const unpinBtnHtml = isCurrentUserAdmin
          ? `<button type="button" data-pin-id="${escapeHtmlString(pinItem.id)}" onclick="event.stopPropagation(); unpinCommunityMessageAdmin(this.dataset.pinId)" class="px-2 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-rose-300 text-[10px] font-bold shrink-0 transition-colors">Lepas</button>`
          : '';
        return `
          <div ${jumpAttr} class="rounded-xl bg-slate-950/90 border border-slate-800 ${hasTargetMsg ? 'hover:border-amber-500/40 cursor-pointer' : ''} p-3 space-y-1.5 transition-colors">
            <div class="flex items-center justify-between gap-2">
              <span class="text-[10px] font-mono-code accent-text font-bold">#${pinIndex + 1} • Disematkan oleh ${escapeHtmlString(pinItem.pinnedBy || 'Admin')}</span>
              ${unpinBtnHtml}
            </div>
            <p class="text-xs text-slate-200 leading-relaxed whitespace-pre-wrap break-words">${escapeHtmlString(pinItem.text || '')}</p>
            <div class="flex items-center justify-between text-[9px] font-mono-code text-slate-500">
              <span>${escapeHtmlString(formatWibDateTime(pinItem.pinnedAt))}</span>
              ${hasTargetMsg ? '<span class="text-amber-300/90">Ketuk untuk lompat ke pesan</span>' : ''}
            </div>
          </div>
        `;
      }).join('');
    }
  }
}

function cyclePinnedMessageBanner(clickEvent) {
  if (clickEvent) clickEvent.stopPropagation();
  if (communityPinnedCache.length <= 1) {
    navigateToActivePinnedMessage(clickEvent);
    return;
  }
  activePinnedCarouselIndex = (activePinnedCarouselIndex + 1) % communityPinnedCache.length;
  renderCommunityPinnedBar();
}

function openPinnedMessagesModal() {
  renderCommunityPinnedBar();
  toggleModalVisibility('communityPinnedModal', true);
}

function closePinnedMessagesModal() {
  toggleModalVisibility('communityPinnedModal', false);
}

function submitNewPinnedMessageAdmin() {
  if (!isCurrentUserAdmin) {
    showCyberToast('Akses Ditolak', 'Hanya Admin yang dapat menyematkan pesan.', 'danger');
    return;
  }
  const inputEl = getEl('communityPinnedNewInput');
  const pinText = String(inputEl?.value || '').trim();
  if (!pinText) return;
  socketClient.emit('community:pin:add', { text: pinText });
  if (inputEl) inputEl.value = '';
}

function pinCommunityMessageAdmin(messageId) {
  closeMessageActionPopup();
  if (!isCurrentUserAdmin) {
    showCyberToast('Akses Ditolak', 'Hanya Admin yang dapat menyematkan pesan.', 'danger');
    return;
  }
  const targetMsg = communityMessagesCache.find((messageItem) => messageItem.id === messageId);
  if (!targetMsg) return;
  if (!isMessageEligibleForPin(targetMsg)) {
    showCyberToast('Tidak Dapat Disematkan', 'Hanya pesan pengumuman admin atau media (foto, video, stiker) yang dapat disematkan.', 'info');
    return;
  }
  const mediaLabelMap = {
    video: '[Video]',
    image: '[Foto]',
    sticker: '[Stiker]',
    welcome: `Welcome ${targetMsg.welcomeTargetName || 'Member'}`
  };
  const fallbackLabel = mediaLabelMap[targetMsg.type] || '[Media]';
  const summaryText = targetMsg.text ? `${fallbackLabel} ${targetMsg.text}` : fallbackLabel;

  socketClient.emit('community:pin:add', {
    messageId: targetMsg.id,
    text: `${targetMsg.name || 'Member'}: ${summaryText}`
  });
}

function unpinCommunityMessageAdmin(pinId) {
  if (!isCurrentUserAdmin || !pinId) return;
  socketClient.emit('community:pin:remove', { pinId });
}

// --- gambar kanvas kartu auto-welcome modern dengan gradasi menyala & glowing avatar border ---
function drawRoundedRectPath(ctx, posX, posY, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(posX + radius, posY);
  ctx.arcTo(posX + width, posY, posX + width, posY + height, radius);
  ctx.arcTo(posX + width, posY + height, posX, posY + height, radius);
  ctx.arcTo(posX, posY + height, posX, posY, radius);
  ctx.arcTo(posX, posY, posX + width, posY, radius);
  ctx.closePath();
}

function renderSingleWelcomeCanvas(canvasEl) {
  if (!canvasEl || !canvasEl.getContext) return;
  const displayName = canvasEl.getAttribute('data-welcome-name') || 'Member Baru';
  const avatarUrl = canvasEl.getAttribute('data-welcome-avatar') || '';

  const width = 640;
  const height = 310;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvasEl.width = width * dpr;
  canvasEl.height = height * dpr;

  const ctx = canvasEl.getContext('2d');
  ctx.scale(dpr, dpr);

  const paintScene = (loadedAvatarImg) => {
    ctx.clearRect(0, 0, width, height);

    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#070b18');
    bgGrad.addColorStop(0.5, '#0f172a');
    bgGrad.addColorStop(1, '#091926');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    const orbLeft = ctx.createRadialGradient(90, 60, 10, 90, 60, 260);
    orbLeft.addColorStop(0, 'rgba(139, 92, 246, 0.55)');
    orbLeft.addColorStop(0.55, 'rgba(139, 92, 246, 0.14)');
    orbLeft.addColorStop(1, 'rgba(139, 92, 246, 0)');
    ctx.fillStyle = orbLeft;
    ctx.fillRect(0, 0, width, height);

    const orbRight = ctx.createRadialGradient(width - 90, height - 40, 10, width - 90, height - 40, 280);
    orbRight.addColorStop(0, 'rgba(16, 185, 129, 0.52)');
    orbRight.addColorStop(0.55, 'rgba(6, 182, 212, 0.18)');
    orbRight.addColorStop(1, 'rgba(6, 182, 212, 0)');
    ctx.fillStyle = orbRight;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
    ctx.lineWidth = 1;
    for (let gridX = 0; gridX <= width; gridX += 32) {
      ctx.beginPath();
      ctx.moveTo(gridX, 0);
      ctx.lineTo(gridX, height);
      ctx.stroke();
    }
    for (let gridY = 0; gridY <= height; gridY += 32) {
      ctx.beginPath();
      ctx.moveTo(0, gridY);
      ctx.lineTo(width, gridY);
      ctx.stroke();
    }

    ctx.save();
    drawRoundedRectPath(ctx, width / 2 - 96, 18, 192, 24, 12);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(52, 211, 153, 0.45)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.font = '700 10px "JetBrains Mono", monospace';
    ctx.fillStyle = '#6ee7b7';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('XU CORE COMMUNITY', width / 2, 30);
    ctx.restore();

    const centerX = width / 2;
    const centerY = 122;
    const avatarRadius = 52;

    ctx.save();
    ctx.shadowColor = 'rgba(16, 185, 129, 0.85)';
    ctx.shadowBlur = 28;
    const ringGrad = ctx.createLinearGradient(
      centerX - avatarRadius,
      centerY - avatarRadius,
      centerX + avatarRadius,
      centerY + avatarRadius
    );
    ringGrad.addColorStop(0, '#34d399');
    ringGrad.addColorStop(0.5, '#38bdf8');
    ringGrad.addColorStop(1, '#a78bfa');
    ctx.beginPath();
    ctx.arc(centerX, centerY, avatarRadius + 5, 0, Math.PI * 2);
    ctx.fillStyle = ringGrad;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    ctx.arc(centerX, centerY, avatarRadius, 0, Math.PI * 2);
    ctx.closePath();
    ctx.clip();

    if (loadedAvatarImg) {
      ctx.drawImage(
        loadedAvatarImg,
        centerX - avatarRadius,
        centerY - avatarRadius,
        avatarRadius * 2,
        avatarRadius * 2
      );
    } else {
      const innerGrad = ctx.createLinearGradient(centerX - avatarRadius, centerY - avatarRadius, centerX + avatarRadius, centerY + avatarRadius);
      innerGrad.addColorStop(0, '#1e293b');
      innerGrad.addColorStop(1, '#0f172a');
      ctx.fillStyle = innerGrad;
      ctx.fillRect(centerX - avatarRadius, centerY - avatarRadius, avatarRadius * 2, avatarRadius * 2);

      ctx.font = '800 42px Outfit, sans-serif';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(displayName.charAt(0).toUpperCase() || 'X', centerX, centerY + 2);
    }
    ctx.restore();

    ctx.save();
    ctx.shadowColor = 'rgba(56, 189, 248, 0.55)';
    ctx.shadowBlur = 16;
    const titleGrad = ctx.createLinearGradient(centerX - 130, 0, centerX + 130, 0);
    titleGrad.addColorStop(0, '#ffffff');
    titleGrad.addColorStop(0.5, '#a7f3d0');
    titleGrad.addColorStop(1, '#bae6fd');
    ctx.font = '900 34px Outfit, sans-serif';
    ctx.fillStyle = titleGrad;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('WELCOME', centerX, 218);
    ctx.restore();

    ctx.save();
    ctx.font = '700 18px "Plus Jakarta Sans", sans-serif';
    ctx.fillStyle = '#e2e8f0';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const truncatedName = displayName.length > 26 ? `${displayName.slice(0, 25)}…` : displayName;
    ctx.fillText(truncatedName, centerX, 254);

    const barGrad = ctx.createLinearGradient(centerX - 60, 0, centerX + 60, 0);
    barGrad.addColorStop(0, 'rgba(16, 185, 129, 0)');
    barGrad.addColorStop(0.5, '#34d399');
    barGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');
    ctx.fillStyle = barGrad;
    ctx.fillRect(centerX - 65, 276, 130, 3);
    ctx.restore();
  };

  paintScene(null);

  if (avatarUrl) {
    const avatarImage = new Image();
    avatarImage.crossOrigin = 'anonymous';
    avatarImage.referrerPolicy = 'no-referrer';
    avatarImage.onload = () => paintScene(avatarImage);
    avatarImage.src = avatarUrl;
  }
}

function hydrateAllWelcomeCanvases() {
  document.querySelectorAll('canvas[data-welcome-canvas="1"]').forEach((canvasEl) => {
    if (canvasEl.getAttribute('data-rendered') === '1') return;
    canvasEl.setAttribute('data-rendered', '1');
    safeExecute(() => renderSingleWelcomeCanvas(canvasEl), 'renderSingleWelcomeCanvas');
  });
}

function getCommunityDayDividerLabel(timestampMs) {
  return formatWibDayDivider(timestampMs);
}

// --- badge mini reaksi yang melekat di sudut bawah gelembung pesan ---
function buildMessageReactionBadgesHtml(msg) {
  const reactionsList = Array.isArray(msg.reactions) ? msg.reactions : [];
  if (reactionsList.length === 0) return '';

  const groupedCounts = new Map();
  let userReactedAny = false;

  for (const reactionItem of reactionsList) {
    const emojiChar = String(reactionItem.emoji || '');
    if (!emojiChar) continue;
    groupedCounts.set(emojiChar, (groupedCounts.get(emojiChar) || 0) + 1);
    if (reactionItem.userId === currentGoogleUserId) {
      userReactedAny = true;
    }
  }

  const pillsHtml = Array.from(groupedCounts.entries())
    .map(([emojiChar, count]) => `<span>${escapeHtmlString(emojiChar)}${count > 1 ? `<span class="text-[10px] font-mono-code font-bold ml-0.5 text-slate-200">${count}</span>` : ''}</span>`)
    .join('');

  return `
    <button type="button" data-msg-id="${escapeHtmlString(msg.id)}" onclick="openReactionDetailSheet(this.dataset.msgId, 'all', event)" class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-slate-900/95 hover:bg-slate-800 border ${userReactedAny ? 'accent-border' : 'border-slate-700/90'} shadow-lg text-xs transition-transform active:scale-95">
      ${pillsHtml}
    </button>
  `;
}

// --- state beranda chat ala whatsapp, dm xu core, dan ruang aktif ---
let activeChatRoomType = 'home';
let activeChatRoomTargetId = '';
let activeChatHomeFilter = 'all';
let dmRoomsListCache = [];
let activeDmMessagesCache = [];
let activeLightboxMediaMeta = { type: 'image', url: '', senderName: 'Member' };

// --- ubah filter pill di beranda chat ---
function setChatHomeFilter(filterKey) {
  activeChatHomeFilter = filterKey || 'all';
  updateButtonGroupState(
    '.chat-home-filter-btn',
    'data-home-filter',
    activeChatHomeFilter,
    'chat-home-filter-btn px-3.5 py-1.5 rounded-full accent-bg text-slate-950 font-bold whitespace-nowrap transition-all',
    'chat-home-filter-btn px-3.5 py-1.5 rounded-full bg-slate-900 border border-slate-800 text-slate-300 hover:text-white font-semibold whitespace-nowrap transition-all'
  );
  renderChatHomeView();
}

// --- segarkan seluruh data beranda chat (komunitas, dm xu core, dan bot wa) ---
function refreshAllChatHomeData() {
  socketClient.emit('community:init');
  socketClient.emit('dm:list');
  socketClient.emit('inbox:list');
  showCyberToast('Disegarkan', 'Daftar percakapan diperbarui.', 'info');
}

// --- state & helper loader ruang chat serta pengunci scroll instan paling bawah ---
let chatRoomLoaderHideTimer = null;
let chatRoomLoaderFallbackTimer = null;
let chatRoomRevealSequenceId = 0;

function forceScrollChatToBottomInstant() {
  const viewport = getEl('communityMessagesContainer');
  if (!viewport) return;
  viewport.scrollTop = viewport.scrollHeight + 9999;
  handleChatScrollVisibility();
}

function showChatRoomLoader(labelText = 'Memuat chat...') {
  const overlay = getEl('chatRoomLoadingOverlay');
  const labelEl = getEl('chatRoomLoadingLabel');
  if (chatRoomLoaderHideTimer) {
    clearTimeout(chatRoomLoaderHideTimer);
    chatRoomLoaderHideTimer = null;
  }
  if (chatRoomLoaderFallbackTimer) {
    clearTimeout(chatRoomLoaderFallbackTimer);
    chatRoomLoaderFallbackTimer = null;
  }
  if (labelEl) labelEl.textContent = labelText;
  if (!overlay) return;
  overlay.classList.remove('hidden', 'opacity-0', 'pointer-events-none');
  overlay.classList.add('flex', 'opacity-100');
}

function hideChatRoomLoaderNow() {
  const overlay = getEl('chatRoomLoadingOverlay');
  if (!overlay) return;
  overlay.classList.remove('opacity-100');
  overlay.classList.add('opacity-0', 'pointer-events-none');
  if (chatRoomLoaderHideTimer) clearTimeout(chatRoomLoaderHideTimer);
  chatRoomLoaderHideTimer = setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.classList.remove('flex');
    chatRoomLoaderHideTimer = null;
  }, 180);
}

function attachRoomMediaScrollSettlers(viewport, shouldLockToBottom = true) {
  if (!viewport || !shouldLockToBottom) return;
  const mediaElements = viewport.querySelectorAll('img, video');
  mediaElements.forEach((mediaEl) => {
    const isVideo = mediaEl.tagName === 'VIDEO';
    const isAlreadyReady = isVideo ? mediaEl.readyState >= 1 : mediaEl.complete;
    if (isAlreadyReady) return;
    const onMediaReady = () => {
      const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      if (distanceFromBottom < 420) {
        forceScrollChatToBottomInstant();
      }
    };
    mediaEl.addEventListener(isVideo ? 'loadedmetadata' : 'load', onMediaReady, { once: true });
  });
}

function settleInitialRoomScrollAndReveal() {
  const viewport = getEl('communityMessagesContainer');
  const currentSequence = ++chatRoomRevealSequenceId;
  const startTimeMs = Date.now();
  const minLoaderDisplayMs = 420;
  const maxMediaWaitMs = 580;

  if (!viewport) {
    hideChatRoomLoaderNow();
    return;
  }

  const pendingPromises = [];
  viewport.querySelectorAll('img, video').forEach((mediaEl) => {
    const isVideo = mediaEl.tagName === 'VIDEO';
    const isAlreadyReady = isVideo ? mediaEl.readyState >= 1 : mediaEl.complete;
    if (isAlreadyReady) return;
    pendingPromises.push(
      new Promise((resolve) => {
        const done = () => resolve();
        mediaEl.addEventListener(isVideo ? 'loadedmetadata' : 'load', done, { once: true });
        mediaEl.addEventListener('error', done, { once: true });
      })
    );
  });

  const mediaWaitRace = pendingPromises.length > 0
    ? Promise.race([
        Promise.all(pendingPromises),
        new Promise((resolve) => setTimeout(resolve, maxMediaWaitMs))
      ])
    : Promise.resolve();

  mediaWaitRace.then(() => {
    if (currentSequence !== chatRoomRevealSequenceId) return;
    const elapsedMs = Date.now() - startTimeMs;
    const remainingDelayMs = Math.max(0, minLoaderDisplayMs - elapsedMs);

    setTimeout(() => {
      if (currentSequence !== chatRoomRevealSequenceId) return;
      requestAnimationFrame(() => {
        forceScrollChatToBottomInstant();
        requestAnimationFrame(() => {
          forceScrollChatToBottomInstant();
          hideChatRoomLoaderNow();
          setTimeout(() => {
            if (currentSequence === chatRoomRevealSequenceId) {
              forceScrollChatToBottomInstant();
            }
          }, 90);
        });
      });
    }, remainingDelayMs);
  });
}

// --- kembali dari ruang chat ke beranda chat ---
function backToChatHomeView() {
  chatRoomRevealSequenceId += 1;
  if (chatRoomLoaderHideTimer) {
    clearTimeout(chatRoomLoaderHideTimer);
    chatRoomLoaderHideTimer = null;
  }
  if (chatRoomLoaderFallbackTimer) {
    clearTimeout(chatRoomLoaderFallbackTimer);
    chatRoomLoaderFallbackTimer = null;
  }
  getEl('chatRoomLoadingOverlay')?.classList.add('hidden');
  getEl('chatRoomLoadingOverlay')?.classList.remove('flex');

  activeChatRoomType = 'home';
  activeChatRoomTargetId = '';
  clearCommunityReplyTarget();
  closeChatAttachMenu();
  closeMessageActionPopup();

  getEl('chatRoomView')?.classList.add('hidden');
  getEl('chatRoomView')?.classList.remove('flex');
  getEl('chatHomeView')?.classList.remove('hidden');
  getEl('chatHomeView')?.classList.add('flex');
  renderChatHomeView();
}

// --- buka ruang chat aktif: community, dm akun xu core, atau bot/grup wa ---
function openUnifiedChatRoom(roomType, targetId = '') {
  activeChatRoomType = roomType;
  activeChatRoomTargetId = targetId;
  clearCommunityReplyTarget();
  closeChatAttachMenu();

  getEl('chatHomeView')?.classList.add('hidden');
  getEl('chatHomeView')?.classList.remove('flex');
  getEl('chatRoomView')?.classList.remove('hidden');
  getEl('chatRoomView')?.classList.add('flex');

  showChatRoomLoader('Memuat chat...');

  const isCommunity = roomType === 'community';
  const isDm = roomType === 'dm';
  const isWa = roomType === 'wa';

  const titleEl = getEl('roomHeaderTitle');
  const badgeEl = getEl('roomSourceBadge');
  const subEl = getEl('roomHeaderSubtitle');
  const avatarEl = getEl('roomHeaderAvatarImg');
  const inputEl = getEl('communityMessageInput');

  getEl('roomMembersDrawerBtn')?.classList.toggle('hidden', !isCommunity);
  getEl('roomPinnedHeaderBtn')?.classList.toggle('hidden', !isCommunity);
  getEl('roomAttachBtn')?.classList.toggle('hidden', isWa);
  getEl('roomStickerShortcutBtn')?.classList.toggle('hidden', isWa);

  if (isCommunity) {
    avatarEl?.classList.add('hidden');
    if (titleEl) titleEl.textContent = 'Xu Core Community';
    if (badgeEl) {
      badgeEl.textContent = 'Official';
      badgeEl.className = 'inline-flex items-center px-1.5 py-0.5 rounded-full accent-soft-bg border accent-border accent-text font-mono-code text-[9px] font-bold uppercase shrink-0';
    }
    const onlineCount = communityMembersCache.filter((member) => member.isOnline).length;
    if (subEl) subEl.innerHTML = `<span id="communityMembersCountLabel">${communityMembersCache.length} anggota</span> • <span id="communityOnlineCountLabel" class="text-emerald-400">${onlineCount} online</span>`;
    if (inputEl) inputEl.placeholder = 'Ketik pesan ke Xu Core Community...';
    renderCommunityPinnedBar();
    renderCommunityMessagesTimeline(true);
    settleInitialRoomScrollAndReveal();
    return;
  }

  getEl('communityPinnedBar')?.classList.add('hidden');

  if (isDm) {
    const peerMember =
      communityMembersCache.find((member) => member.userId === targetId) ||
      dmRoomsListCache.find((room) => room.peerUserId === targetId) ||
      {};
    const peerName = peerMember.displayName || peerMember.name || 'Member';
    const peerAvatar = peerMember.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(peerName)}&background=0f172a&color=38bdf8`;

    if (avatarEl) {
      avatarEl.src = peerAvatar;
      avatarEl.classList.remove('hidden');
    }
    if (titleEl) titleEl.textContent = peerName;
    if (badgeEl) {
      badgeEl.textContent = 'AKUN XU CORE';
      badgeEl.className = 'inline-flex items-center px-1.5 py-0.5 rounded-full bg-violet-500/20 border border-violet-500/40 text-violet-300 font-mono-code text-[9px] font-bold uppercase shrink-0';
    }
    if (subEl) subEl.textContent = peerMember.isOnline ? 'Online • Chat Pribadi Xu Core' : 'Offline • Chat Pribadi Xu Core';
    if (inputEl) inputEl.placeholder = `Kirim pesan ke ${peerName}...`;

    activeDmMessagesCache = [];
    if (getEl('communityMessagesContainer')) {
      getEl('communityMessagesContainer').innerHTML = '';
    }
    socketClient.emit('dm:open', { peerUserId: targetId });
    chatRoomLoaderFallbackTimer = setTimeout(() => {
      if (activeChatRoomType === 'dm' && activeChatRoomTargetId === targetId) {
        settleInitialRoomScrollAndReveal();
      }
    }, 3500);
    return;
  }

  if (isWa) {
    activeWaInboxJid = targetId;
    const waChat = waLiveInboxCache.find((chat) => chat.jid === targetId);
    const isGroupWa = Boolean(waChat?.isGroup || String(targetId).endsWith('@g.us'));
    const chatTitle = waChat?.name || String(targetId).split('@')[0];

    if (avatarEl) {
      avatarEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(chatTitle)}&background=064e3b&color=6ee7b7`;
      avatarEl.classList.remove('hidden');
    }
    if (titleEl) titleEl.textContent = chatTitle;
    if (badgeEl) {
      badgeEl.textContent = isGroupWa ? 'GRUP BOT WA' : 'USER BOT WA';
      badgeEl.className = isGroupWa
        ? 'inline-flex items-center px-1.5 py-0.5 rounded-full bg-amber-500/20 border border-amber-500/40 text-amber-300 font-mono-code text-[9px] font-bold uppercase shrink-0'
        : 'inline-flex items-center px-1.5 py-0.5 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono-code text-[9px] font-bold uppercase shrink-0';
    }
    if (subEl) subEl.textContent = formatCleanWhatsappSubtitle(targetId);
    if (inputEl) inputEl.placeholder = isGroupWa ? 'Kirim pesan ke grup WhatsApp via Bot...' : 'Balas pesan WhatsApp via Bot...';

    socketClient.emit('inbox:read', { chatJid: targetId });
    renderActiveWaRoomTimeline(true);
    settleInitialRoomScrollAndReveal();
  }
}

// --- render daftar percakapan beranda chat ala whatsapp dengan pembeda visual jelas ---
function renderChatHomeView() {
  const listEl = getEl('chatHomeActiveList');
  const membersListEl = getEl('chatHomeMembersList');
  if (!listEl) return;

  const query = String(getEl('chatHomeSearchInput')?.value || '').trim().toLowerCase();
  const rows = [];

  // --- 1. kartu utama xu core community ---
  const lastCommunityMsg = communityMessagesCache.length > 0
    ? communityMessagesCache[communityMessagesCache.length - 1]
    : null;
  const communityPreview = lastCommunityMsg
    ? `${lastCommunityMsg.name || 'Bot'}: ${lastCommunityMsg.text || (lastCommunityMsg.type === 'sticker' ? '[Stiker]' : '[Media]')}`
    : 'Ruang obrolan resmi seluruh pengguna Xu Core';

  rows.push({
    roomType: 'community',
    targetId: 'community',
    title: 'Xu Core Community',
    subtitle: communityPreview,
    timestamp: Number(lastCommunityMsg?.timestamp || Date.now()),
    unreadCount: 0,
    isGroup: true,
    sourceKind: 'community',
    avatarHtml: '<div class="w-12 h-12 rounded-full bg-gradient-to-br from-emerald-400 via-cyan-500 to-violet-500 flex items-center justify-center font-heading-modern font-extrabold text-sm text-slate-950 shrink-0 shadow-lg">XC</div>',
    sourceBadgeHtml: '<span class="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 font-mono-code text-[9px] font-bold">OFFICIAL</span>'
  });

  // --- 2. kartu percakapan dm sesama akun xu core ---
  for (const dmRoom of dmRoomsListCache) {
    const avatarUrl = dmRoom.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(dmRoom.name || 'M')}&background=1e1b4b&color=c4b5fd`;
    rows.push({
      roomType: 'dm',
      targetId: dmRoom.peerUserId,
      title: dmRoom.name || 'Member',
      subtitle: dmRoom.lastMessage || 'Mulai percakapan pribadi',
      timestamp: Number(dmRoom.lastTimestamp || 0),
      unreadCount: Number(dmRoom.unreadCount || 0),
      isGroup: false,
      sourceKind: 'xucore',
      avatarHtml: `
        <div class="relative shrink-0">
          <img src="${escapeHtmlString(avatarUrl)}" alt="${escapeHtmlString(dmRoom.name)}" class="w-12 h-12 rounded-full object-cover border border-violet-500/45" />
          <span class="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-[#050810] ${dmRoom.isOnline ? 'bg-emerald-400' : 'bg-slate-600'}"></span>
        </div>`,
      sourceBadgeHtml: '<span class="px-1.5 py-0.5 rounded bg-violet-500/15 border border-violet-500/35 text-violet-300 font-mono-code text-[9px] font-bold">XU CORE</span>'
    });
  }

  // --- 3. kartu percakapan masuk dari bot whatsapp (user pribadi & grup wa) ---
  for (const waChat of waLiveInboxCache) {
    const isGroupWa = Boolean(waChat.isGroup || String(waChat.jid || '').endsWith('@g.us'));
    const displayTitle = waChat.name || String(waChat.jid || '').split('@')[0];
    const cleanNumberSub = formatCleanWhatsappSubtitle(waChat.jid);
    const waIconBg = isGroupWa
      ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
      : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300';

    rows.push({
      roomType: 'wa',
      targetId: waChat.jid,
      title: displayTitle,
      subtitle: `${cleanNumberSub} • ${waChat.lastMessage || '-'}`,
      timestamp: Number(waChat.lastTimestamp || 0),
      unreadCount: Number(waChat.unreadCount || 0),
      isGroup: isGroupWa,
      sourceKind: 'bot',
      avatarHtml: `
        <div class="w-12 h-12 rounded-full border ${waIconBg} flex items-center justify-center font-heading-modern font-extrabold text-sm shrink-0">
          ${escapeHtmlString(displayTitle.charAt(0).toUpperCase() || 'W')}
        </div>`,
      sourceBadgeHtml: isGroupWa
        ? '<span class="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/35 text-amber-300 font-mono-code text-[9px] font-bold">GRUP WA</span>'
        : '<span class="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 font-mono-code text-[9px] font-bold">BOT WA</span>'
    });
  }

  const filteredRows = rows.filter((row) => {
    if (query) {
      const hay = `${row.title} ${row.subtitle} ${row.targetId}`.toLowerCase();
      if (!hay.includes(query)) return false;
    }
    if (activeChatHomeFilter === 'unread') return row.unreadCount > 0;
    if (activeChatHomeFilter === 'group') return row.isGroup;
    if (activeChatHomeFilter === 'bot') return row.sourceKind === 'bot';
    if (activeChatHomeFilter === 'xucore') return row.sourceKind === 'xucore' || row.sourceKind === 'community';
    return true;
  });

  if (filteredRows.length === 0) {
    listEl.innerHTML = '<div class="rounded-3xl bg-slate-900/50 border border-dashed border-slate-800 py-8 text-center text-xs font-mono-code text-slate-500">Tidak ada percakapan pada filter ini.</div>';
  } else {
    listEl.innerHTML = filteredRows.map((row) => {
      const unreadPill = row.unreadCount > 0
        ? `<span class="min-w-[20px] h-5 px-1.5 rounded-full accent-bg text-slate-950 font-mono-code text-[10px] font-extrabold flex items-center justify-center shrink-0">${row.unreadCount > 99 ? '99+' : row.unreadCount}</span>`
        : '';
      return `
        <button type="button" onclick="openUnifiedChatRoom('${escapeHtmlString(row.roomType)}', '${escapeHtmlString(row.targetId)}')" class="w-full text-left rounded-3xl bg-slate-900/70 hover:bg-slate-900 border border-slate-800/85 hover:border-slate-700 px-3.5 py-3 flex items-center gap-3 transition-all active:scale-[0.99]">
          ${row.avatarHtml}
          <div class="min-w-0 flex-1 space-y-0.5">
            <div class="flex items-center justify-between gap-2">
              <div class="flex items-center gap-1.5 min-w-0">
                <p class="text-sm font-bold text-white truncate">${escapeHtmlString(row.title)}</p>
                ${row.sourceBadgeHtml}
              </div>
              <span class="text-[10px] font-mono-code text-slate-500 shrink-0">${row.timestamp ? escapeHtmlString(formatWibTimeOnly(row.timestamp)) : ''}</span>
            </div>
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs text-slate-400 truncate">${escapeHtmlString(row.subtitle)}</p>
              ${unreadPill}
            </div>
          </div>
        </button>
      `;
    }).join('');
  }

  // --- render bagian mulai percakapan (daftar akun xu core lain) ---
  if (membersListEl) {
    const otherMembers = communityMembersCache.filter((member) => {
      if (!member.userId || member.userId === currentGoogleUserId) return false;
      if (!query) return true;
      return `${member.displayName || ''} ${member.handle || ''}`.toLowerCase().includes(query);
    });

    if (otherMembers.length === 0) {
      membersListEl.innerHTML = '<div class="rounded-3xl bg-slate-900/40 border border-dashed border-slate-800 py-5 text-center text-xs font-mono-code text-slate-500">Belum ada anggota lain yang tersedia.</div>';
    } else {
      membersListEl.innerHTML = otherMembers.map((member) => {
        const displayName = member.displayName || 'Member';
        const isDev = String(member.role || '').toUpperCase() === 'DEVELOPER' || Boolean(member.isAdmin);
        const avatarUrl = member.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=0f172a&color=10b981`;
        const roleHex = isDev
          ? '<span class="role-hex-badge role-hex-developer"><span class="w-1.5 h-1.5 rounded-full bg-white"></span>DEVELOPER</span>'
          : '<span class="role-hex-badge role-hex-member">MEMBER</span>';

        return `
          <button type="button" onclick="openUnifiedChatRoom('dm', '${escapeHtmlString(member.userId)}')" class="w-full text-left rounded-3xl bg-slate-900/60 hover:bg-slate-900 border border-slate-800/80 px-3.5 py-2.5 flex items-center justify-between gap-3 transition-all active:scale-[0.99]">
            <div class="flex items-center gap-3 min-w-0">
              <div class="relative shrink-0">
                <img src="${escapeHtmlString(avatarUrl)}" alt="${escapeHtmlString(displayName)}" class="w-11 h-11 rounded-full object-cover border border-slate-700" />
                <span class="absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-[#050810] ${member.isOnline ? 'bg-emerald-400' : 'bg-slate-600'}"></span>
              </div>
              <div class="min-w-0 space-y-1">
                <div class="flex items-center gap-1.5">
                  <p class="text-xs sm:text-sm font-bold text-white truncate">${escapeHtmlString(displayName)}</p>
                  <span class="px-1.5 py-0.5 rounded bg-violet-500/15 border border-violet-500/30 text-violet-300 font-mono-code text-[8px] font-bold shrink-0">XU CORE</span>
                </div>
                <div class="flex items-center gap-1.5">${roleHex}</div>
              </div>
            </div>
            <svg class="w-4 h-4 text-slate-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
          </button>
        `;
      }).join('');
    }
  }
}

// --- render ruang chat whatsapp bot (pribadi & grup wa) dengan bubble kompak grouped ---
function renderActiveWaRoomTimeline(shouldScrollBottom = true) {
  const viewport = getEl('communityMessagesContainer');
  if (!viewport || activeChatRoomType !== 'wa') return;

  const activeChat = waLiveInboxCache.find((chat) => chat.jid === activeChatRoomTargetId);
  const msgs = Array.isArray(activeChat?.messages) ? activeChat.messages : [];

  if (msgs.length === 0) {
    viewport.innerHTML = '<div class="py-12 text-center text-xs font-mono-code text-slate-500">Belum ada pesan di percakapan WhatsApp ini.</div>';
    return;
  }

  let prevSenderKey = '';
  viewport.innerHTML = msgs.map((msg) => {
    const isMine = Boolean(msg.fromMe);
    const senderName = msg.senderName || (isMine ? 'Bot WA' : 'User WA');
    const currentSenderKey = `${isMine ? 'me' : 'other'}:${senderName}`;
    const isGrouped = currentSenderKey === prevSenderKey;
    prevSenderKey = currentSenderKey;

    return `
      <div class="flex ${isMine ? 'justify-end' : 'justify-start'} ${isGrouped ? 'mt-0.5' : 'mt-2.5'}">
        <div class="max-w-[78%] sm:max-w-[65%] w-fit rounded-2xl px-3 py-1.5 text-xs ${isMine ? 'bg-emerald-500/20 border border-emerald-500/35 text-slate-100 rounded-tr-sm' : 'bg-slate-900/95 border border-slate-800 text-slate-200 rounded-tl-sm'}">
          ${!isGrouped ? `<p class="text-[10px] font-bold mb-0.5 ${isMine ? 'text-emerald-300' : 'text-sky-300'}">${escapeHtmlString(senderName)}</p>` : ''}
          <p class="text-[13px] leading-snug whitespace-pre-wrap break-words [overflow-wrap:anywhere]">${escapeHtmlString(msg.text || '')}</p>
          <p class="text-[9px] font-mono-code text-slate-400 text-right mt-0.5">${escapeHtmlString(formatWibTimeOnly(msg.timestamp))}</p>
        </div>
      </div>
    `;
  }).join('');

  if (shouldScrollBottom) {
    requestAnimationFrame(() => forceScrollChatToBottomInstant());
  }
}

// --- pengirim pesan terpadu sesuai ruang aktif (community, dm xu core, atau wa bot) ---
function submitActiveRoomMessageForm(event) {
  if (event) event.preventDefault();
  const inputEl = getEl('communityMessageInput');
  const messageText = String(inputEl?.value || '').trim();
  if (!messageText) return;

  if (activeChatRoomType === 'wa') {
    if (!activeChatRoomTargetId) return;
    const sendBtn = getEl('roomSendSubmitBtn');
    if (sendBtn) sendBtn.disabled = true;
    socketClient.emit('inbox:reply', { chatJid: activeChatRoomTargetId, message: messageText });
    if (inputEl) inputEl.value = '';
    return;
  }

  if (activeChatRoomType === 'dm') {
    if (!activeChatRoomTargetId) return;
    socketClient.emit('dm:send', {
      peerUserId: activeChatRoomTargetId,
      type: 'text',
      text: messageText,
      replyTo: activeCommunityReplyTarget
    });
    if (inputEl) inputEl.value = '';
    clearCommunityReplyTarget();
    return;
  }

  socketClient.emit('community:message:send', {
    type: 'text',
    text: messageText,
    replyTo: activeCommunityReplyTarget
  });
  if (inputEl) inputEl.value = '';
  clearCommunityReplyTarget();
}

// --- render linimasa pesan kompak dengan thumbnail media pada kutipan balasan & scroll akurat ---
function renderCommunityMessagesTimeline(shouldScrollBottom = true) {
  const viewport = getEl('communityMessagesContainer');
  if (!viewport) return;
  if (activeChatRoomType === 'wa') {
    renderActiveWaRoomTimeline(shouldScrollBottom);
    return;
  }

  const sourceList = activeChatRoomType === 'dm' ? activeDmMessagesCache : communityMessagesCache;
  if (sourceList.length === 0) {
    viewport.innerHTML = '<div class="py-12 text-center text-xs font-mono-code text-slate-500">Belum ada percakapan. Mulai kirim pesan sekarang!</div>';
    return;
  }

  let lastDayLabel = '';
  let previousNormalMsg = null;
  const blocks = [];

  for (const msg of sourceList) {
    const dayLabel = getCommunityDayDividerLabel(msg.timestamp);
    if (dayLabel !== lastDayLabel) {
      lastDayLabel = dayLabel;
      previousNormalMsg = null;
      blocks.push(`
        <div class="flex justify-center my-2.5">
          <span class="px-3 py-1 rounded-full bg-slate-900/90 border border-slate-800 text-[10px] font-mono-code font-semibold text-slate-400 shadow-sm">${escapeHtmlString(dayLabel)}</span>
        </div>
      `);
    }

    if (msg.type === 'welcome' || msg.isWelcome) {
      previousNormalMsg = null;
      const targetName = msg.welcomeTargetName || msg.name || 'Anggota Baru';
      const targetAvatar = msg.welcomeTargetAvatar || msg.avatarUrl || '';
      const reactionHtml = buildMessageReactionBadgesHtml(msg);

      blocks.push(`
        <div data-community-msg-id="${escapeHtmlString(msg.id)}" class="max-w-md mx-auto my-3 select-none">
          <div data-bubble-msg-id="${escapeHtmlString(msg.id)}" class="rounded-2xl overflow-hidden bg-slate-900/80 backdrop-blur-xl border border-slate-800/90 shadow-[0_14px_38px_rgba(0,0,0,0.55)]">
            <canvas data-welcome-canvas="1" data-welcome-name="${escapeHtmlString(targetName)}" data-welcome-avatar="${escapeHtmlString(targetAvatar)}" class="w-full h-auto block aspect-[640/310]"></canvas>
            <div class="p-3 space-y-1.5 bg-slate-950/75 border-t border-slate-800/80">
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-2 min-w-0">
                  <span class="w-6 h-6 rounded-full accent-soft-bg border accent-border flex items-center justify-center text-[10px] font-extrabold accent-text shrink-0">XC</span>
                  <span class="text-xs font-bold text-white truncate">Xu Core Bot</span>
                  <span class="px-1.5 py-0.5 rounded bg-violet-500/20 border border-violet-500/35 text-violet-300 font-mono-code text-[9px] font-bold">BOT</span>
                </div>
                <span class="text-[10px] font-mono-code text-slate-500 shrink-0">${escapeHtmlString(formatWibTimeOnly(msg.timestamp))}</span>
              </div>
              <p class="text-xs text-slate-300 leading-relaxed">${escapeHtmlString(msg.text || `${targetName} baru saja mendarat di Xu Core Community! Yuk sapa dia.`)}</p>
              <div class="flex items-center justify-between pt-0.5">
                <div>${reactionHtml}</div>
                <button type="button" data-msg-id="${escapeHtmlString(msg.id)}" onclick="openMessageActionPopup(this.dataset.msgId, this, event)" title="Reaksi & Opsi" class="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800/80 transition-colors">
                  <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      `);
      continue;
    }

    const isConsecutiveSameUser = Boolean(previousNormalMsg && previousNormalMsg.userId === msg.userId);
    previousNormalMsg = msg;

    const isMine = msg.userId === currentGoogleUserId;
    const isDev = Boolean(msg.isAdmin) || String(msg.role || '').toUpperCase() === 'DEVELOPER';
    const senderName = msg.name || 'Member';
    const senderAvatar =
      msg.avatarUrl ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(senderName)}&background=0f172a&color=10b981`;
    const timeLabel = formatWibTimeOnly(msg.timestamp);
    const handleHtml = msg.handle
      ? `<span class="text-[10px] font-mono-code text-slate-400 truncate">${escapeHtmlString(msg.handle.startsWith('@') ? msg.handle : `@${msg.handle}`)}</span>`
      : '';
    const roleBadgeHtml = isDev
      ? '<span class="role-hex-badge role-hex-developer"><span class="w-1.5 h-1.5 rounded-full bg-white"></span>DEVELOPER</span>'
      : '<span class="role-hex-badge role-hex-member">MEMBER</span>';

    const hasValidReply = Boolean(msg.replyTo && (msg.replyTo.id || msg.replyTo.text));
    const replyAuthorLabel = msg.replyTo?.userId === currentGoogleUserId ? 'Kamu' : (msg.replyTo?.name || 'Member');
    const resolvedReplyOrigin = hasValidReply && !msg.replyTo?.mediaUrl && msg.replyTo?.id
      ? sourceList.find((candidateItem) => candidateItem.id === msg.replyTo.id)
      : null;
    const replyMediaType = msg.replyTo?.type || resolvedReplyOrigin?.type || 'text';
    const replyMediaUrl = msg.replyTo?.mediaUrl || resolvedReplyOrigin?.mediaUrl || '';
    const replyThumbHtml = hasValidReply ? buildQuotedReplyThumbHtml(replyMediaType, replyMediaUrl) : '';

    const replyQuoteHtml = hasValidReply
      ? `
        <div onclick="scrollToRepliedCommunityMessage('${escapeHtmlString(msg.replyTo.id || '')}')" class="mb-1.5 pl-2 py-1.5 pr-2.5 rounded-xl bg-black/35 hover:bg-black/50 border-l-2 border-[var(--accent-main)] flex items-center gap-2 text-[10px] cursor-pointer transition-colors">
          ${replyThumbHtml}
          <div class="min-w-0 flex-1">
            <p class="font-bold accent-text truncate">${escapeHtmlString(replyAuthorLabel)}</p>
            <p class="text-slate-300 truncate mt-0.5">${escapeHtmlString(msg.replyTo.text || '[Pesan]')}</p>
          </div>
        </div>
      `
      : '';

    let bodyContentHtml = '';
    const isMediaOnlyCard = (msg.type === 'video' || msg.type === 'image') && Boolean(msg.mediaUrl);

    if (msg.type === 'sticker' && msg.mediaUrl) {
      bodyContentHtml = `
        <div class="py-0.5">
          <img src="${escapeHtmlString(msg.mediaUrl)}" alt="Stiker" loading="lazy" onclick="openStickerFavoriteSheet('${escapeHtmlString(msg.mediaUrl)}', '${escapeHtmlString(senderName)}', event)" class="w-28 h-28 sm:w-32 sm:h-32 object-contain rounded-xl select-none cursor-pointer hover:scale-105 active:scale-95 transition-transform drop-shadow-[0_6px_14px_rgba(0,0,0,0.45)]" />
        </div>
      `;
    } else if (msg.type === 'image' && msg.mediaUrl) {
      bodyContentHtml = `
        <div class="space-y-1">
          <div onclick="openChatMediaLightbox('image', '${escapeHtmlString(msg.mediaUrl)}', '${escapeHtmlString(senderName)}', '${escapeHtmlString(senderAvatar)}', '${escapeHtmlString(timeLabel)}')" class="relative max-w-[230px] sm:max-w-[260px] rounded-2xl overflow-hidden border border-slate-800/90 cursor-zoom-in shadow-lg">
            <img src="${escapeHtmlString(msg.mediaUrl)}" alt="Foto" loading="lazy" class="w-full max-h-72 object-cover block" />
          </div>
          ${msg.text ? `<p class="text-[13px] text-slate-100 leading-snug whitespace-pre-wrap break-words [overflow-wrap:anywhere] px-1 pt-0.5">${escapeHtmlString(msg.text)}</p>` : ''}
        </div>
      `;
    } else if (msg.type === 'video' && msg.mediaUrl) {
      bodyContentHtml = `
        <div class="space-y-1">
          <div onclick="openChatMediaLightbox('video', '${escapeHtmlString(msg.mediaUrl)}', '${escapeHtmlString(senderName)}', '${escapeHtmlString(senderAvatar)}', '${escapeHtmlString(timeLabel)}')" class="relative max-w-[230px] sm:max-w-[260px] rounded-2xl overflow-hidden bg-black border border-slate-800/90 cursor-pointer group/vid shadow-lg">
            <video src="${escapeHtmlString(msg.mediaUrl)}" muted playsinline preload="metadata" class="w-full max-h-72 object-cover block pointer-events-none"></video>
            <div class="absolute inset-0 bg-black/25 group-hover/vid:bg-black/35 flex items-center justify-center transition-colors">
              <span class="w-12 h-12 rounded-full bg-black/65 backdrop-blur-md border border-white/25 text-white flex items-center justify-center shadow-xl group-hover/vid:scale-110 transition-transform">
                <svg class="w-5 h-5 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
              </span>
            </div>
          </div>
          ${msg.text ? `<p class="text-[13px] text-slate-100 leading-snug whitespace-pre-wrap break-words [overflow-wrap:anywhere] px-1 pt-0.5">${escapeHtmlString(msg.text)}</p>` : ''}
        </div>
      `;
    } else {
      bodyContentHtml = `<p class="text-[13px] leading-snug whitespace-pre-wrap break-words [overflow-wrap:anywhere]">${escapeHtmlString(msg.text || '')}</p>`;
    }

    const reactionBadgeHtml = activeChatRoomType === 'community' ? buildMessageReactionBadgesHtml(msg) : '';
    const bubbleClass = msg.type === 'sticker' || isMediaOnlyCard
      ? 'bg-transparent p-0'
      : (isMine
        ? `w-fit bg-emerald-500/18 border border-emerald-500/30 text-slate-100 rounded-2xl ${isConsecutiveSameUser ? 'rounded-tr-md' : 'rounded-tr-sm'} px-3 py-1.5 shadow-sm`
        : `w-fit bg-slate-900/90 border border-slate-800/95 text-slate-100 rounded-2xl ${isConsecutiveSameUser ? 'rounded-tl-md' : 'rounded-tl-sm'} px-3 py-1.5 shadow-sm`);

    const avatarSlotHtml = isConsecutiveSameUser
      ? '<div class="w-8 shrink-0"></div>'
      : `<img src="${escapeHtmlString(senderAvatar)}" alt="${escapeHtmlString(senderName)}" class="w-8 h-8 rounded-full object-cover border ${isDev ? 'border-rose-500/60' : 'border-slate-700'} shrink-0 mt-0.5 shadow-sm" />`;

    const senderHeaderHtml = isConsecutiveSameUser
      ? ''
      : `
        <div class="flex flex-wrap items-center gap-1.5 mb-1 ${isMine ? 'justify-end' : 'justify-start'}">
          <span class="text-[11px] font-bold ${isMine ? 'text-emerald-300' : 'text-white'}">${escapeHtmlString(senderName)}</span>
          ${handleHtml}
          ${roleBadgeHtml}
        </div>
      `;

    const reactBtnHtml = activeChatRoomType === 'community'
      ? `<button type="button" data-msg-id="${escapeHtmlString(msg.id)}" onclick="openMessageActionPopup(this.dataset.msgId, this, event)" title="Reaksi / Opsi" class="p-0.5 rounded hover:bg-slate-800/80 text-slate-400 hover:text-white transition-colors"><svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.828 14.828a4 4 0 01-5.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg></button>`
      : '';

    blocks.push(`
      <div data-community-msg-id="${escapeHtmlString(msg.id)}" class="flex items-start gap-2 ${isMine ? 'flex-row-reverse' : ''} ${isConsecutiveSameUser ? 'mt-0.5' : 'mt-2.5'} group/msg">
        ${avatarSlotHtml}
        <div class="max-w-[78%] sm:max-w-[66%] flex flex-col ${isMine ? 'items-end' : 'items-start'}">
          ${senderHeaderHtml}

          <div
            data-bubble-msg-id="${escapeHtmlString(msg.id)}"
            oncontextmenu="openMessageActionPopup('${escapeHtmlString(msg.id)}', this, event); return false;"
            ontouchstart="startMessageLongPress('${escapeHtmlString(msg.id)}', this, event)"
            ontouchend="cancelMessageLongPress()"
            ontouchmove="cancelMessageLongPress()"
            class="relative transition-transform ${bubbleClass}">
            ${replyQuoteHtml}
            ${bodyContentHtml}

            <div class="flex items-center justify-end gap-1.5 mt-1 text-[10px] font-mono-code text-slate-400 ${isMediaOnlyCard ? 'px-1' : ''}">
              <span>${escapeHtmlString(timeLabel)}</span>
              ${reactBtnHtml}
              <button type="button" data-msg-id="${escapeHtmlString(msg.id)}" onclick="setCommunityReplyTarget(this.dataset.msgId)" title="Balas Pesan" class="p-0.5 rounded hover:bg-slate-800/80 text-slate-400 hover:text-white transition-colors">
                <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"/></svg>
              </button>
            </div>
          </div>

          ${reactionBadgeHtml ? `<div class="-mt-2 relative z-10 px-1">${reactionBadgeHtml}</div>` : ''}
        </div>
      </div>
    `);
  }

  viewport.innerHTML = blocks.join('');
  hydrateAllWelcomeCanvases();
  attachRoomMediaScrollSettlers(viewport, shouldScrollBottom);

  if (shouldScrollBottom) {
    requestAnimationFrame(() => forceScrollChatToBottomInstant());
  }
}

// --- long-press mobile, popup floating emoji reaction, pin admin, dan hapus pesan ---
function startMessageLongPress(messageId, anchorEl, touchEvent) {
  cancelMessageLongPress();
  messageLongPressTimer = setTimeout(() => {
    openMessageActionPopup(messageId, anchorEl, touchEvent);
  }, 430);
}

function cancelMessageLongPress() {
  if (messageLongPressTimer) {
    clearTimeout(messageLongPressTimer);
    messageLongPressTimer = null;
  }
}

// --- ambil daftar pesan sesuai ruang yang sedang dibuka (dm atau community) ---
function getActiveRoomMessagesList() {
  return activeChatRoomType === 'dm' ? activeDmMessagesCache : communityMessagesCache;
}

// --- konfigurasi cdn resmi emoji-datasource-apple untuk daftar & gambar emoji iphone ---
const APPLE_EMOJI_CDN_BASE = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@latest';
const APPLE_EMOJI_JSON_URL = `${APPLE_EMOJI_CDN_BASE}/emoji.json`;
const APPLE_EMOJI_IMG_BASE = `${APPLE_EMOJI_CDN_BASE}/img/apple/64`;

const APPLE_CATEGORY_LABELS_ID = {
  'Smileys & Emotion': 'Wajah & Emosi',
  'People & Body': 'Tangan & Orang',
  'Symbols': 'Hati & Simbol',
  'Animals & Nature': 'Hewan & Alam',
  'Food & Drink': 'Makanan & Minuman',
  'Activities': 'Aktivitas',
  'Travel & Places': 'Perjalanan & Tempat',
  'Objects': 'Objek',
  'Flags': 'Bendera'
};

const APPLE_CATEGORY_ORDER = [
  'Smileys & Emotion',
  'People & Body',
  'Symbols',
  'Animals & Nature',
  'Food & Drink',
  'Activities',
  'Travel & Places',
  'Objects',
  'Flags'
];

let appleEmojiCatalogCache = null;
let isFetchingAppleEmojiCatalog = false;

// --- konversi kode hex unified menjadi karakter unicode emoji ---
function unifiedHexToEmojiChar(unifiedHex) {
  try {
    const codePoints = String(unifiedHex || '')
      .split('-')
      .filter(Boolean)
      .map((hexPart) => parseInt(hexPart, 16));
    return String.fromCodePoint(...codePoints);
  } catch {
    return '';
  }
}

// --- konversi karakter unicode emoji menjadi nama file hex cdn apple ---
function buildAppleEmojiHexVariants(emojiChar) {
  const rawPoints = Array.from(String(emojiChar || ''))
    .map((ch) => ch.codePointAt(0))
    .filter((cp) => typeof cp === 'number');

  const withFe0f = rawPoints.map((cp) => cp.toString(16).toLowerCase()).join('-');
  const withoutFe0f = rawPoints
    .filter((cp) => cp !== 0xfe0f)
    .map((cp) => cp.toString(16).toLowerCase())
    .join('-');

  return { withFe0f, withoutFe0f };
}

// --- render gambar emoji gaya apple/iphone dengan fallback otomatis ---
function renderAppleStyleEmojiHtml(emojiChar, sizeClass = 'w-7 h-7', textSizeClass = 'text-2xl', exactImageFile = '') {
  const cleanEmoji = String(emojiChar || '').trim();
  if (!cleanEmoji) return '';

  const { withFe0f, withoutFe0f } = buildAppleEmojiHexVariants(cleanEmoji);
  const primaryFile = exactImageFile || `${withFe0f}.png`;
  const altFile = withoutFe0f && `${withoutFe0f}.png` !== primaryFile ? `${withoutFe0f}.png` : '';
  const primaryUrl = `${APPLE_EMOJI_IMG_BASE}/${primaryFile}`;
  const fallbackUrl = altFile ? `${APPLE_EMOJI_IMG_BASE}/${altFile}` : '';

  return `
    <span class="inline-flex items-center justify-center ${sizeClass} shrink-0 pointer-events-none select-none">
      <img
        src="${escapeHtmlString(primaryUrl)}"
        data-alt-src="${escapeHtmlString(fallbackUrl)}"
        alt="${escapeHtmlString(cleanEmoji)}"
        loading="lazy"
        decoding="async"
        onerror="if (this.dataset.altSrc && this.src !== this.dataset.altSrc) { this.src = this.dataset.altSrc; this.dataset.altSrc = ''; } else { this.style.display='none'; this.nextElementSibling.classList.remove('hidden'); }"
        class="w-full h-full object-contain"
      />
      <span class="hidden ${textSizeClass} leading-none">${escapeHtmlString(cleanEmoji)}</span>
    </span>
  `;
}

// --- tarik daftar lengkap emoji apple terbaru dari cdn lalu kelompokkan per kategori ---
async function loadAppleEmojiCatalogFromCdn() {
  if (Array.isArray(appleEmojiCatalogCache) && appleEmojiCatalogCache.length > 0) {
    return appleEmojiCatalogCache;
  }

  const response = await fetch(APPLE_EMOJI_JSON_URL);
  if (!response.ok) {
    throw new Error(`Gagal memuat katalog emoji CDN (HTTP ${response.status}).`);
  }

  const rawList = await response.json();
  const groupedMap = new Map();

  for (const item of rawList) {
    if (!item || !item.has_img_apple || !item.unified || !item.image) continue;
    if (item.category === 'Component') continue;

    const emojiChar = unifiedHexToEmojiChar(item.unified);
    if (!emojiChar) continue;

    const catKey = APPLE_CATEGORY_LABELS_ID[item.category] ? item.category : 'Objects';
    if (!groupedMap.has(catKey)) groupedMap.set(catKey, []);

    groupedMap.get(catKey).push({
      char: emojiChar,
      image: item.image,
      name: String(item.short_name || item.name || '').toLowerCase(),
      order: Number(item.sort_order || 99999)
    });
  }

  const structuredGroups = [];
  for (const catKey of APPLE_CATEGORY_ORDER) {
    const items = groupedMap.get(catKey);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => a.order - b.order);
    structuredGroups.push({
      category: APPLE_CATEGORY_LABELS_ID[catKey] || catKey,
      items
    });
  }

  appleEmojiCatalogCache = structuredGroups;
  return structuredGroups;
}

// --- render daftar kategori emoji apple lengkap di dalam bottom sheet pilih reaksi ---
async function renderExtendedEmojiCategoriesGrid() {
  const gridEl = getEl('extendedEmojiGridContainer');
  if (!gridEl) return;

  if (!appleEmojiCatalogCache) {
    if (isFetchingAppleEmojiCatalog) return;
    isFetchingAppleEmojiCatalog = true;
    gridEl.innerHTML = '<div class="py-12 text-center text-xs font-mono-code text-slate-400 animate-pulse">Memuat katalog emoji Apple terbaru dari CDN...</div>';

    try {
      await loadAppleEmojiCatalogFromCdn();
    } catch (cdnErr) {
      gridEl.innerHTML = `<div class="py-10 text-center text-xs font-mono-code text-rose-400">${escapeHtmlString(cdnErr.message || 'Gagal memuat emoji CDN.')}</div>`;
      isFetchingAppleEmojiCatalog = false;
      return;
    }
    isFetchingAppleEmojiCatalog = false;
  }

  gridEl.innerHTML = appleEmojiCatalogCache.map((group) => {
    const tilesHtml = group.items.map((entry) => `
      <button
        type="button"
        title="${escapeHtmlString(entry.name)}"
        onclick="triggerFloatingEmojiReaction('${escapeHtmlString(entry.char)}')"
        class="aspect-square rounded-xl hover:bg-slate-800/90 flex items-center justify-center transition-transform hover:scale-115 active:scale-90"
      >
        ${renderAppleStyleEmojiHtml(entry.char, 'w-7 h-7', 'text-2xl', entry.image)}
      </button>
    `).join('');

    return `
      <section class="space-y-1.5">
        <h4 class="text-xs font-bold text-slate-300 px-1 sticky top-0 py-1 bg-[#0b101d]/95 backdrop-blur-sm z-10">${escapeHtmlString(group.category)}</h4>
        <div class="grid grid-cols-7 sm:grid-cols-8 gap-1">
          ${tilesHtml}
        </div>
      </section>
    `;
  }).join('');
}

// --- tangani input emoji langsung dari keyboard bawaan hp ---
function handleCustomKeyboardEmojiInput(inputEl) {
  if (!inputEl || !activeFloatingMessageId) return;
  const rawVal = String(inputEl.value || '').trim();
  if (!rawVal) return;

  const firstSegment = typeof Intl !== 'undefined' && Intl.Segmenter
    ? Array.from(new Intl.Segmenter('id', { granularity: 'grapheme' }).segment(rawVal))[0]?.segment
    : Array.from(rawVal)[0];

  inputEl.value = '';
  if (firstSegment) {
    triggerFloatingEmojiReaction(firstSegment);
  }
}

// --- buka bottom sheet pilih reaksi lengkap ala apple & fokuskan input keyboard hp ---
function openExtendedEmojiPicker(clickEvent) {
  if (clickEvent) clickEvent.stopPropagation();
  const customInput = getEl('customKeyboardEmojiInput');
  if (customInput) customInput.value = '';
  toggleModalVisibility('extendedEmojiPickerSheet', true);
  renderExtendedEmojiCategoriesGrid();
  setTimeout(() => customInput?.focus(), 60);
}

function closeExtendedEmojiPicker() {
  const customInput = getEl('customKeyboardEmojiInput');
  if (customInput) customInput.value = '';
  toggleModalVisibility('extendedEmojiPickerSheet', false);
}

// --- buka top action bar dinamis dengan ikon pin/unpin & pill emoji cepat ala whatsapp ---
function openMessageActionPopup(messageId, anchorEl, triggerEvent) {
  if (triggerEvent) {
    if (typeof triggerEvent.preventDefault === 'function') triggerEvent.preventDefault();
    if (typeof triggerEvent.stopPropagation === 'function') triggerEvent.stopPropagation();
  }

  const activeList = getActiveRoomMessagesList();
  const targetMsg = activeList.find((messageItem) => messageItem.id === messageId);
  if (!targetMsg) return;

  activeFloatingMessageId = messageId;
  const overlay = getEl('floatingMessageActionOverlay');
  const reactionBar = getEl('floatingReactionBar');
  const pinBtn = getEl('floatingPinActionBtn');
  const pinIcon = getEl('floatingPinActionIcon');
  const pinLabel = getEl('floatingPinActionLabel');
  const deleteBtn = getEl('floatingDeleteActionBtn');

  if (!overlay || !reactionBar) return;

  const isCommunityRoom = activeChatRoomType === 'community';
  const canDeleteMessage = isCurrentUserAdmin || targetMsg.userId === currentGoogleUserId;
  const existingPinEntry = isCommunityRoom ? findPinnedEntryByMessageId(targetMsg.id) : null;
  const canShowPinButton = isCommunityRoom && isCurrentUserAdmin && (Boolean(existingPinEntry) || isMessageEligibleForPin(targetMsg));

  if (pinBtn) {
    pinBtn.classList.toggle('hidden', !canShowPinButton);
    pinBtn.classList.toggle('inline-flex', canShowPinButton);

    if (existingPinEntry) {
      pinBtn.title = 'Lepas Sematan';
      pinBtn.setAttribute('aria-label', 'Lepas Sematan');
      pinBtn.className = 'h-8 px-2.5 rounded-full bg-amber-500/25 hover:bg-amber-500/35 border border-amber-400/50 text-amber-200 inline-flex items-center gap-1.5 text-xs font-semibold transition-all active:scale-90';
      if (pinLabel) pinLabel.textContent = 'Lepas Sematan';
      if (pinIcon) {
        pinIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 17v5"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m2 2 20 20"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"/>';
      }
    } else {
      pinBtn.title = 'Sematkan Pesan';
      pinBtn.setAttribute('aria-label', 'Sematkan Pesan');
      pinBtn.className = 'h-8 px-2.5 rounded-full bg-amber-500/15 hover:bg-amber-500/25 border border-amber-500/35 text-amber-300 inline-flex items-center gap-1.5 text-xs font-semibold transition-all active:scale-90';
      if (pinLabel) pinLabel.textContent = 'Sematkan';
      if (pinIcon) {
        pinIcon.innerHTML = '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 17v5"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>';
      }
    }
  }

  if (deleteBtn) {
    deleteBtn.classList.toggle('hidden', !canDeleteMessage);
    deleteBtn.classList.toggle('inline-flex', canDeleteMessage);
  }

  reactionBar.classList.toggle('hidden', !isCommunityRoom);
  overlay.classList.remove('hidden');

  if (isCommunityRoom) {
    const anchorRect = anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect() : null;
    const pillWidth = Math.min(282, window.innerWidth - 20);
    reactionBar.style.width = `${Math.round(pillWidth)}px`;

    if (anchorRect) {
      const idealLeft = Math.max(10, Math.min(window.innerWidth - pillWidth - 10, anchorRect.left + anchorRect.width / 2 - pillWidth / 2));
      const idealTop = anchorRect.top > 136 ? anchorRect.top - 58 : Math.min(window.innerHeight - 96, Math.max(76, anchorRect.bottom + 8));
      reactionBar.style.left = `${Math.round(idealLeft)}px`;
      reactionBar.style.top = `${Math.round(idealTop)}px`;
    } else {
      reactionBar.style.left = `${Math.round((window.innerWidth - pillWidth) / 2)}px`;
      reactionBar.style.top = '88px';
    }
  }
}

function closeMessageActionPopup() {
  activeFloatingMessageId = '';
  closeExtendedEmojiPicker();
  getEl('floatingMessageActionOverlay')?.classList.add('hidden');
}

function triggerFloatingEmojiReaction(emojiChar) {
  if (!activeFloatingMessageId || !emojiChar) return;
  sendCommunityReaction(activeFloatingMessageId, emojiChar);
  closeMessageActionPopup();
}

function triggerFloatingReplyAction() {
  if (!activeFloatingMessageId) return;
  const targetId = activeFloatingMessageId;
  closeMessageActionPopup();
  setCommunityReplyTarget(targetId);
}

function triggerFloatingPinToggleAction() {
  if (!activeFloatingMessageId) return;
  const targetId = activeFloatingMessageId;
  const existingPin = findPinnedEntryByMessageId(targetId);
  if (existingPin) {
    closeMessageActionPopup();
    unpinCommunityMessageAdmin(existingPin.id);
    showCyberToast('Sematan Dilepas', 'Pesan dilepas dari daftar Pesan Disematkan.', 'info');
    return;
  }
  pinCommunityMessageAdmin(targetId);
}

function triggerFloatingDeleteAction() {
  if (!activeFloatingMessageId) return;
  const targetId = activeFloatingMessageId;
  closeMessageActionPopup();
  deleteCommunityMessage(targetId);
}

function sendCommunityReaction(messageId, emojiChar) {
  if (!messageId || !emojiChar) return;
  socketClient.emit('community:message:react', {
    messageId,
    emoji: emojiChar
  });
}

// --- hapus pesan sesuai ruang aktif (dm atau community) ---
function deleteCommunityMessage(messageId) {
  const activeList = getActiveRoomMessagesList();
  const targetMsg = activeList.find((msg) => msg.id === messageId);
  if (!targetMsg) return;

  const isAuthorized = isCurrentUserAdmin || targetMsg.userId === currentGoogleUserId;
  if (!isAuthorized) {
    showCyberToast('Akses Ditolak', 'Anda hanya dapat menghapus pesan milik Anda sendiri.', 'danger');
    return;
  }

  if (activeChatRoomType === 'dm' && activeChatRoomTargetId) {
    socketClient.emit('dm:delete', {
      peerUserId: activeChatRoomTargetId,
      messageId
    });
  } else {
    socketClient.emit('community:message:delete', { messageId });
  }
  closeReactionDetailSheet();
}

// --- bottom sheet modal detail reaksi ---
function openReactionDetailSheet(messageId, filterEmoji = 'all', event) {
  if (event) event.stopPropagation();
  activeDetailReactionMessageId = messageId;
  activeDetailReactionFilter = filterEmoji || 'all';
  renderReactionDetailSheetContent();
  toggleModalVisibility('reactionDetailSheetOverlay', true);
}

function closeReactionDetailSheet() {
  activeDetailReactionMessageId = '';
  toggleModalVisibility('reactionDetailSheetOverlay', false);
}

// --- tangani klik pill emoji di samping tombol semua (ikut react jika belum, filter jika sudah) ---
function handleReactionDetailEmojiClick(messageId, emojiChar) {
  if (!messageId || !emojiChar) return;
  const targetMsg = communityMessagesCache.find((msg) => msg.id === messageId);
  if (!targetMsg) return;

  const reactions = Array.isArray(targetMsg.reactions) ? targetMsg.reactions : [];
  const hasUserReactedThis = reactions.some(
    (entry) => entry.userId === currentGoogleUserId && entry.emoji === emojiChar
  );

  if (!hasUserReactedThis) {
    sendCommunityReaction(messageId, emojiChar);
    return;
  }

  activeDetailReactionFilter = activeDetailReactionFilter === emojiChar ? 'all' : emojiChar;
  renderReactionDetailSheetContent();
}

function setReactionDetailFilter(emojiFilter) {
  activeDetailReactionFilter = emojiFilter || 'all';
  renderReactionDetailSheetContent();
}

// --- render isi bottom sheet detail reaksi dengan tombol ikut react ala whatsapp ---
function renderReactionDetailSheetContent() {
  const titleEl = getEl('reactionDetailTitle');
  const tabsEl = getEl('reactionDetailTabs');
  const listEl = getEl('reactionDetailList');
  const deleteMsgBtn = getEl('reactionDetailDeleteMsgBtn');
  if (!listEl) return;

  const targetMsg = communityMessagesCache.find((msg) => msg.id === activeDetailReactionMessageId);
  if (!targetMsg) {
    closeReactionDetailSheet();
    return;
  }

  const reactions = Array.isArray(targetMsg.reactions) ? targetMsg.reactions : [];
  if (reactions.length === 0) {
    closeReactionDetailSheet();
    return;
  }

  const canDeleteMessage = isCurrentUserAdmin || targetMsg.userId === currentGoogleUserId;
  if (deleteMsgBtn) {
    deleteMsgBtn.classList.toggle('hidden', !canDeleteMessage);
    deleteMsgBtn.onclick = () => deleteCommunityMessage(targetMsg.id);
  }

  if (titleEl) {
    titleEl.textContent = `${reactions.length} reaksi`;
  }

  const countsMap = new Map();
  const ownEmojisSet = new Set();
  for (const entry of reactions) {
    countsMap.set(entry.emoji, (countsMap.get(entry.emoji) || 0) + 1);
    if (entry.userId === currentGoogleUserId) {
      ownEmojisSet.add(entry.emoji);
    }
  }

  if (activeDetailReactionFilter !== 'all' && !countsMap.has(activeDetailReactionFilter)) {
    activeDetailReactionFilter = 'all';
  }

  if (tabsEl) {
    const allPillCls = activeDetailReactionFilter === 'all'
      ? 'px-3 py-1.5 rounded-full accent-soft-bg border accent-border accent-text text-xs font-bold transition-all active:scale-95'
      : 'px-3 py-1.5 rounded-full bg-slate-900 border border-slate-800 text-slate-400 hover:text-white text-xs font-semibold transition-all active:scale-95';

    const emojiTabsHtml = Array.from(countsMap.entries()).map(([emojiChar, count]) => {
      const isSelected = activeDetailReactionFilter === emojiChar;
      const isUserReacted = ownEmojisSet.has(emojiChar);
      const pillCls = isSelected || isUserReacted
        ? 'px-3 py-1.5 rounded-full accent-soft-bg border accent-border text-white text-xs font-bold inline-flex items-center gap-1 transition-all active:scale-95'
        : 'px-3 py-1.5 rounded-full bg-slate-900 hover:bg-slate-800 border border-slate-700/90 text-slate-200 text-xs font-semibold inline-flex items-center gap-1 transition-all active:scale-95';
      const joinHintHtml = !isUserReacted
        ? '<span class="text-[10px] accent-text font-bold">+</span>'
        : '';

      return `<button type="button" title="${isUserReacted ? 'Filter reaksi ini' : 'Ketuk untuk ikut reaksi ini'}" onclick="handleReactionDetailEmojiClick('${escapeHtmlString(targetMsg.id)}', '${escapeHtmlString(emojiChar)}')" class="${pillCls}">${escapeHtmlString(emojiChar)} <span class="font-mono-code">${count}</span>${joinHintHtml}</button>`;
    }).join('');

    tabsEl.innerHTML = `<button type="button" onclick="setReactionDetailFilter('all')" class="${allPillCls}">Semua <span class="font-mono-code ml-0.5">${reactions.length}</span></button>${emojiTabsHtml}`;
  }

  const visibleReactions = activeDetailReactionFilter === 'all'
    ? reactions
    : reactions.filter((entry) => entry.emoji === activeDetailReactionFilter);

  listEl.innerHTML = visibleReactions.map((entry) => {
    const isOwnReaction = entry.userId === currentGoogleUserId;
    const displayName = isOwnReaction ? 'Kamu' : (entry.name || 'Member');
    const avatarUrl =
      entry.avatarUrl ||
      `https://ui-avatars.com/api/?name=${encodeURIComponent(entry.name || 'U')}&background=0f172a&color=10b981`;
    const tapActionAttr = isOwnReaction
      ? `onclick="sendCommunityReaction('${escapeHtmlString(targetMsg.id)}', '${escapeHtmlString(entry.emoji)}')"`
      : '';

    return `
      <div ${tapActionAttr} class="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-slate-900/75 border border-slate-800/90 ${isOwnReaction ? 'cursor-pointer hover:bg-slate-800/90 active:scale-[0.99]' : ''} transition-all">
        <div class="flex items-center gap-3 min-w-0">
          <img src="${escapeHtmlString(avatarUrl)}" alt="${escapeHtmlString(displayName)}" class="w-10 h-10 rounded-full object-cover border border-slate-700 shrink-0" />
          <div class="min-w-0">
            <p class="text-xs font-bold text-white truncate">${escapeHtmlString(displayName)}</p>
            <p class="text-[11px] ${isOwnReaction ? 'accent-text' : 'text-slate-500'} truncate">${isOwnReaction ? 'Ketuk untuk menghapus' : 'Anggota komunitas'}</p>
          </div>
        </div>
        <span class="text-xl shrink-0">${escapeHtmlString(entry.emoji)}</span>
      </div>
    `;
  }).join('');
}

// --- bangun html thumbnail persegi mini untuk kutipan balasan video, foto, atau stiker ---
function buildQuotedReplyThumbHtml(replyType, replyMediaUrl) {
  const cleanUrl = String(replyMediaUrl || '').trim();
  const normalizedType = String(replyType || 'text').trim().toLowerCase();
  if (!cleanUrl) return '';

  if (normalizedType === 'video') {
    return `
      <div class="w-10 h-10 rounded-lg overflow-hidden bg-black border border-slate-700/80 shrink-0 relative">
        <video src="${escapeHtmlString(cleanUrl)}" muted playsinline preload="metadata" class="w-full h-full object-cover pointer-events-none"></video>
        <span class="absolute inset-0 bg-black/30 flex items-center justify-center">
          <svg class="w-3.5 h-3.5 text-white drop-shadow" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </span>
      </div>
    `;
  }

  if (normalizedType === 'sticker') {
    return `
      <div class="w-10 h-10 rounded-lg overflow-hidden bg-slate-900/90 border border-slate-700/70 p-0.5 shrink-0 flex items-center justify-center">
        <img src="${escapeHtmlString(cleanUrl)}" alt="Stiker" loading="lazy" class="w-full h-full object-contain" />
      </div>
    `;
  }

  if (normalizedType === 'image') {
    return `
      <div class="w-10 h-10 rounded-lg overflow-hidden bg-slate-950 border border-slate-700/80 shrink-0">
        <img src="${escapeHtmlString(cleanUrl)}" alt="Foto" loading="lazy" class="w-full h-full object-cover" />
      </div>
    `;
  }

  return '';
}

// --- siapkan kutipan balasan pesan lengkap dengan thumbnail media untuk community atau dm ---
function setCommunityReplyTarget(messageId) {
  const activeList = getActiveRoomMessagesList();
  const foundMsg = activeList.find((messageItem) => messageItem.id === messageId);
  if (!foundMsg) return;

  const normalizedType = String(foundMsg.type || 'text').trim().toLowerCase();
  const mediaLabelMap = {
    video: 'Video',
    image: 'Foto',
    sticker: 'Stiker',
    welcome: `Welcome ${foundMsg.welcomeTargetName || 'Member'}`
  };
  const cleanText = String(foundMsg.text || '').trim();
  const summaryText = cleanText
    ? (['video', 'image'].includes(normalizedType) ? `${mediaLabelMap[normalizedType]} • ${cleanText}` : cleanText)
    : (mediaLabelMap[normalizedType] || `[${normalizedType || 'Media'}]`);

  activeCommunityReplyTarget = {
    id: foundMsg.id,
    userId: foundMsg.userId || '',
    name: foundMsg.name || 'Member',
    type: normalizedType,
    mediaUrl: String(foundMsg.mediaUrl || '').trim(),
    text: summaryText
  };

  const barEl = getEl('communityReplyPreviewBar');
  const thumbWrapEl = getEl('communityReplyPreviewThumbWrap');
  if (barEl) barEl.classList.remove('hidden');
  if (getEl('communityReplyPreviewAuthor')) {
    getEl('communityReplyPreviewAuthor').textContent = activeCommunityReplyTarget.name;
  }
  if (getEl('communityReplyPreviewText')) {
    getEl('communityReplyPreviewText').textContent = activeCommunityReplyTarget.text;
  }

  if (thumbWrapEl) {
    const thumbHtml = buildQuotedReplyThumbHtml(activeCommunityReplyTarget.type, activeCommunityReplyTarget.mediaUrl);
    if (thumbHtml) {
      thumbWrapEl.innerHTML = thumbHtml.replace('w-10 h-10 rounded-lg overflow-hidden', 'w-full h-full');
      thumbWrapEl.classList.remove('hidden');
    } else {
      thumbWrapEl.innerHTML = '';
      thumbWrapEl.classList.add('hidden');
    }
  }

  getEl('communityMessageInput')?.focus();
}

function clearCommunityReplyTarget() {
  activeCommunityReplyTarget = null;
  getEl('communityReplyPreviewBar')?.classList.add('hidden');
  const thumbWrapEl = getEl('communityReplyPreviewThumbWrap');
  if (thumbWrapEl) {
    thumbWrapEl.innerHTML = '';
    thumbWrapEl.classList.add('hidden');
  }
}

// --- lompat instan ke pesan asli saat kutipan balasan diklik ---
function scrollToRepliedCommunityMessage(targetMsgId) {
  if (!targetMsgId) return;
  jumpToChatMessageInstant(targetMsgId);
}

// --- tampilkan tombol scroll ke bawah saat user menggulir riwayat chat ke atas ---
function handleChatScrollVisibility() {
  const viewport = getEl('communityMessagesContainer');
  const scrollBtn = getEl('chatScrollBottomBtn');
  if (!viewport || !scrollBtn) return;

  const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
  scrollBtn.classList.toggle('hidden', distanceFromBottom < 140);
  scrollBtn.classList.toggle('flex', distanceFromBottom >= 140);
}

function scrollActiveChatToBottom() {
  const viewport = getEl('communityMessagesContainer');
  if (!viewport) return;
  viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
}

function submitCommunityChatForm(event) {
  if (event) event.preventDefault();
  const inputEl = getEl('communityMessageInput');
  const messageText = String(inputEl?.value || '').trim();
  if (!messageText) return;

  socketClient.emit('community:message:send', {
    type: 'text',
    text: messageText,
    replyTo: activeCommunityReplyTarget
  });

  if (inputEl) inputEl.value = '';
  clearCommunityReplyTarget();
}

// --- buka pratinjau video/foto layar penuh lengkap dengan profil, nama, waktu & tombol simpan ---
function openChatMediaLightbox(mediaType, mediaUrl, senderName = 'Member', senderAvatar = '', timeLabel = '') {
  const modal = getEl('chatMediaLightboxModal');
  const content = getEl('chatMediaLightboxContent');
  if (!modal || !content || !mediaUrl) return;

  activeLightboxMediaMeta = { type: mediaType, url: mediaUrl, senderName: senderName || 'Member' };

  const fallbackAvatar = `https://ui-avatars.com/api/?name=${encodeURIComponent(senderName || 'M')}&background=0f172a&color=10b981`;
  if (getEl('mediaLightboxAvatar')) getEl('mediaLightboxAvatar').src = senderAvatar || fallbackAvatar;
  if (getEl('mediaLightboxSenderName')) getEl('mediaLightboxSenderName').textContent = senderName || 'Member';
  if (getEl('mediaLightboxTime')) getEl('mediaLightboxTime').textContent = timeLabel || '';

  content.innerHTML = mediaType === 'video'
    ? `<video src="${escapeHtmlString(mediaUrl)}" controls autoplay playsinline class="max-h-[82vh] max-w-[96vw] rounded-2xl shadow-2xl bg-black"></video>`
    : `<img src="${escapeHtmlString(mediaUrl)}" alt="Media" class="max-h-[82vh] max-w-[96vw] rounded-2xl object-contain shadow-2xl" />`;
  toggleModalVisibility('chatMediaLightboxModal', true);
}

function closeChatMediaLightbox() {
  toggleModalVisibility('chatMediaLightboxModal', false);
  if (getEl('chatMediaLightboxContent')) getEl('chatMediaLightboxContent').innerHTML = '';
}

// --- unduh video atau foto dari lightbox ke perangkat user ---
async function downloadActiveLightboxMedia() {
  const { type, url, senderName } = activeLightboxMediaMeta || {};
  if (!url) return;

  const btn = getEl('mediaLightboxDownloadBtn');
  if (btn) btn.disabled = true;

  const safePrefix = String(senderName || 'xucore').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'xucore';
  const ext = type === 'video' ? 'mp4' : 'jpg';
  const fileName = `${safePrefix}-${Date.now()}.${ext}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Direct download fallback');
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(blobUrl);
    showCyberToast('Tersimpan', `${type === 'video' ? 'Video' : 'Foto'} berhasil diunduh.`, 'success');
  } catch {
    const fallbackLink = document.createElement('a');
    fallbackLink.href = url;
    fallbackLink.download = fileName;
    fallbackLink.target = '_blank';
    document.body.appendChild(fallbackLink);
    fallbackLink.click();
    fallbackLink.remove();
  } finally {
    if (btn) btn.disabled = false;
  }
}

// --- seluruh listener event socket.io untuk dashboard.html dan chat.html ---
socketClient.on('cpu-update', (payload) => {
  if (getEl('cpuHeartbeatChart')) pushSystemMetricsPoint(payload);
});

socketClient.on('traffic:velocity', (snapshot) => {
  if (getEl('trafficVelocityChart')) {
    safeExecute(() => updateLiveTrafficVelocityUI(snapshot), 'traffic:velocity');
  }
});

socketClient.on('admin:sessions:data', (snapshot) => {
  safeExecute(() => syncFromGlobalMonitorSnapshot(snapshot), 'admin:sessions:data');
});

socketClient.on('webhook:logs:update', (logs) => {
  if (getEl('webhookDeliveryLogsList')) {
    safeExecute(() => renderWebhookDeliveryLogs(logs), 'webhook:logs:update');
  }
});

socketClient.on('public:chat:history', (list) => {
  publicChatMessagesCache = Array.isArray(list) ? list : [];
  if (getEl('publicChatMessagesList')) renderPublicChatMessages();
});

socketClient.on('public:chat:message', (msg) => {
  if (!msg?.id) return;
  publicChatMessagesCache = [...publicChatMessagesCache, msg].slice(-80);
  if (getEl('publicChatMessagesList')) renderPublicChatMessages();
});

// --- sinkronkan wa bot inbox di beranda chat maupun saat ruang wa terbuka ---
socketClient.on('inbox:update', (list) => {
  waLiveInboxCache = Array.isArray(list) ? list : [];
  if (getEl('chatHomeActiveList')) renderChatHomeView();
  if (activeChatRoomType === 'wa') renderActiveWaRoomTimeline(true);
});

socketClient.on('inbox:reply:result', (res) => {
  const sendBtn = getEl('roomSendSubmitBtn') || getEl('waInboxReplyBtn');
  if (sendBtn) sendBtn.disabled = false;
  if (!res?.isSuccess) {
    showCyberToast('Balasan Gagal', res?.errorMessage || 'Pastikan bot sedang ONLINE.', 'danger');
  }
});

// --- sinkronkan ulang komunitas dan wa inbox setiap kali socket tersambung ---
socketClient.on('connect', () => {
  if (activePageName === 'chat' || getEl('communityMessagesContainer')) {
    socketClient.emit('community:init');
    socketClient.emit('inbox:list');
  }
});

// --- listener inisialisasi beranda chat & komunitas ---
socketClient.on('community:ready', (payload) => {
  if (!payload) return;

  isCurrentUserAdmin = Boolean(payload.isAdmin);
  if (payload.profile) {
    currentGoogleUserId = payload.profile.userId || currentGoogleUserId;
    currentUserEmail = payload.profile.email || currentUserEmail;
    currentUserProfileData = payload.profile;
    applyProfileIdentityToHeader(payload.profile);
    populateProfileSettingsModalFields(payload.profile);
  }

  communityMessagesCache = Array.isArray(payload.messages) ? payload.messages : [];
  communityPinnedCache = Array.isArray(payload.pinnedMessages) ? payload.pinnedMessages : [];
  communityMembersCache = Array.isArray(payload.members) ? payload.members : [];
  if (Array.isArray(payload.dmRooms)) dmRoomsListCache = payload.dmRooms;
  if (Array.isArray(payload.waInbox)) waLiveInboxCache = payload.waInbox;

  renderCommunityMembersDrawer();
  renderChatHomeView();

  if (activeChatRoomType === 'community') {
    renderCommunityPinnedBar();
    renderCommunityMessagesTimeline(true);
  } else if (activeChatRoomType === 'wa') {
    renderActiveWaRoomTimeline(true);
  }

  const serverStickers = Array.isArray(payload.stickers) ? payload.stickers : [];
  syncStickersFromSupabaseToLocal(currentGoogleUserId, serverStickers);
});

// --- listener dm sesama akun xu core ---
socketClient.on('dm:list:data', (roomsList) => {
  dmRoomsListCache = Array.isArray(roomsList) ? roomsList : [];
  if (getEl('chatHomeActiveList')) renderChatHomeView();
});

// --- terima riwayat pesan dm, render, dan selesaikan loader di posisi paling bawah ---
socketClient.on('dm:messages', (payload) => {
  if (!payload || payload.peerUserId !== activeChatRoomTargetId) return;
  if (chatRoomLoaderFallbackTimer) {
    clearTimeout(chatRoomLoaderFallbackTimer);
    chatRoomLoaderFallbackTimer = null;
  }
  activeDmMessagesCache = Array.isArray(payload.messages) ? payload.messages : [];
  if (activeChatRoomType === 'dm') {
    renderCommunityMessagesTimeline(true);
    settleInitialRoomScrollAndReveal();
  }
});

socketClient.on('dm:message:new', (newMsg) => {
  if (!newMsg?.id) return;
  const isCurrentDmPeer =
    activeChatRoomType === 'dm' &&
    (newMsg.userId === activeChatRoomTargetId || newMsg.toUserId === activeChatRoomTargetId);

  if (isCurrentDmPeer && !activeDmMessagesCache.some((m) => m.id === newMsg.id)) {
    activeDmMessagesCache = [...activeDmMessagesCache, newMsg].slice(-80);
    renderCommunityMessagesTimeline(true);
    if (newMsg.userId === activeChatRoomTargetId) {
      socketClient.emit('dm:open', { peerUserId: activeChatRoomTargetId });
    }
  }
});

socketClient.on('dm:message:deleted', (payload) => {
  if (!payload?.messageId) return;
  if (activeChatRoomType === 'dm' && payload.peerUserId === activeChatRoomTargetId) {
    activeDmMessagesCache = activeDmMessagesCache.filter((m) => m.id !== payload.messageId);
    renderCommunityMessagesTimeline(false);
  }
});

// --- terima pesan komunitas baru dan perbarui beranda maupun ruang komunitas ---
socketClient.on('community:message:new', (newMessage) => {
  if (!newMessage?.id) return;
  if (communityMessagesCache.some((existing) => existing.id === newMessage.id)) return;
  communityMessagesCache = [...communityMessagesCache, newMessage].slice(-120);

  if (getEl('chatHomeActiveList')) renderChatHomeView();
  if (activeChatRoomType === 'community' && getEl('communityMessagesContainer')) {
    renderCommunityMessagesTimeline(true);
  }
});

socketClient.on('community:message:reacted', (payload) => {
  if (!payload?.messageId) return;
  communityMessagesCache = communityMessagesCache.map((msg) =>
    msg.id === payload.messageId
      ? { ...msg, reactions: Array.isArray(payload.reactions) ? payload.reactions : [] }
      : msg
  );

  if (getEl('communityMessagesContainer')) {
    renderCommunityMessagesTimeline(false);
  }
  if (activeDetailReactionMessageId === payload.messageId) {
    renderReactionDetailSheetContent();
  }
});

socketClient.on('community:message:deleted', (payload) => {
  if (!payload?.messageId) return;
  communityMessagesCache = communityMessagesCache.filter((msg) => msg.id !== payload.messageId);

  if (Array.isArray(payload.pinnedMessages)) {
    communityPinnedCache = payload.pinnedMessages;
    renderCommunityPinnedBar();
  }

  if (getEl('communityMessagesContainer')) {
    renderCommunityMessagesTimeline(false);
  }
  if (activeDetailReactionMessageId === payload.messageId) {
    closeReactionDetailSheet();
  }
});

socketClient.on('community:pins:update', (pinnedList) => {
  communityPinnedCache = Array.isArray(pinnedList) ? pinnedList : [];
  renderCommunityPinnedBar();
});

// --- terima pembaruan daftar anggota online/offline lalu render drawer & beranda ---
socketClient.on('community:members:update', (membersList) => {
  communityMembersCache = Array.isArray(membersList) ? membersList : [];
  renderCommunityMembersDrawer();
  if (getEl('chatHomeActiveList')) renderChatHomeView();
});

socketClient.on('community:error', (payload) => {
  if (payload?.errorMessage) {
    showCyberToast('Komunitas', payload.errorMessage, 'danger');
  }
});

// --- listener fitur manajemen dashboard & sesi baileys ---
socketClient.on('config:export:result', (res) => {
  if (!res?.isSuccess || !res.data) {
    showCyberToast('Export Gagal', 'Gagal mengekspor konfigurasi bot.', 'danger');
    return;
  }
  const blob = new Blob([JSON.stringify(res.data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `xu-core-config-${stamp}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showCyberToast('Export Berhasil', 'File konfigurasi JSON berhasil diunduh.', 'success');
});

socketClient.on('config:import:result', (res) => {
  if (res?.isSuccess) {
    if (res.settings) populateSettingsForm(res.settings);
    showCyberToast('Import Berhasil', 'Seluruh konfigurasi bot berhasil dipulihkan dari JSON.', 'success');
  } else {
    showCyberToast('Import Gagal', res?.errorMessage || 'File JSON tidak valid.', 'danger');
  }
});

socketClient.on('manage:users:resetLimit:result', (res) => {
  if (res?.isSuccess) {
    showCyberToast('Limit Direset', `Limit ${res.affectedCount} user berhasil direset ke ${res.defaultLimit}.`, 'success');
  }
});

socketClient.on('bot:branding:result', (res) => {
  const btn = getEl('brandingSubmitBtn');
  if (btn) btn.disabled = false;
  if (res?.isSuccess) {
    if (res.avatarUrl && getEl('brandingAvatarPreviewImg')) {
      getEl('brandingAvatarPreviewImg').src = res.avatarUrl;
    }
    clearBrandingAvatarFile();
    showCyberToast('Foto Profil Diperbarui', 'Foto profil WhatsApp bot berhasil diperbarui.', 'success');
  } else {
    showCyberToast('Gagal Update Foto', res?.errorMessage || 'Pastikan bot dalam status ONLINE.', 'danger');
  }
});

socketClient.on('disconnect', () => {
  setRefreshSpinState(false, 'all');
  const sourceEl = getEl('cpuSourceBadge');
  if (sourceEl) {
    sourceEl.textContent = 'OFFLINE';
    sourceEl.className = 'px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-400';
  }
});

socketClient.on('auth:expired', () => {
  window.location.replace('/login');
});

socketClient.on('session:ready', (payload) => {
  isCurrentUserAdmin = Boolean(payload.isAdmin) && checkExclusiveAdminUser(payload.user);
  if (payload.adminWaNumber) adminWhatsAppNumber = payload.adminWaNumber;

  if (payload.user) {
    currentGoogleUserId = payload.user.googleId || '';
    currentUserEmail = payload.user.email || '';
    currentUserFullName = payload.user.fullName || payload.user.givenName || 'User';

    applyProfileIdentityToHeader({
      displayName: payload.user.givenName || payload.user.fullName || 'User',
      avatarUrl: payload.user.pictureUrl || ''
    });

    if (getEl('sessionIdentifierDisplay')) {
      getEl('sessionIdentifierDisplay').textContent = `User ID: ${currentGoogleUserId}`;
    }
  }

  if (!getEl('liveApplicationContainer')) return;

  const ideBtn = getEl('navTabDeveloper');
  const roleBadge = getEl('navRoleBadge');
  const backupMenuBtn = getEl('navBackupZipMenuBtn');
  const topEndpointsSection = getEl('topActiveEndpointsSection');
  const publicChatClearBtn = getEl('publicChatClearAdminBtn');
  const devView = getEl('workspaceDeveloperView');
  const adminPanelLink = getEl('navAdminPanelLink');

  if (isCurrentUserAdmin) {
    if (ideBtn) { ideBtn.classList.remove('hidden'); ideBtn.classList.add('flex'); }
    if (backupMenuBtn) { backupMenuBtn.classList.remove('hidden'); backupMenuBtn.classList.add('flex'); }
    if (topEndpointsSection) topEndpointsSection.classList.remove('hidden');
    if (publicChatClearBtn) publicChatClearBtn.classList.remove('hidden');
  } else {
    if (ideBtn) ideBtn.remove();
    if (backupMenuBtn) backupMenuBtn.remove();
    if (topEndpointsSection) topEndpointsSection.remove();
    if (publicChatClearBtn) publicChatClearBtn.remove();
    if (devView) devView.remove();
    if (adminPanelLink) adminPanelLink.remove();
  }

  if (roleBadge) {
    roleBadge.textContent = isCurrentUserAdmin ? 'Admin' : 'User';
    roleBadge.className = isCurrentUserAdmin
      ? 'text-[9px] px-1.5 py-0.5 rounded bg-sky-500/20 text-sky-300 border border-sky-500/30 font-mono-code font-bold uppercase'
      : 'text-[9px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono-code font-bold uppercase';
  }

  getEl('skeletonLoaderSection')?.classList.add('hidden');
  getEl('liveApplicationContainer')?.classList.remove('hidden');

  if (!trafficVelocityChartInstance) initTrafficVelocityChart(); else trafficVelocityChartInstance.resize();
  if (!cpuChartInstance) initCpuHeartbeatChart(); else cpuChartInstance.resize();
  if (!trafficChartInstance) initTrafficHistoryChart(); else trafficChartInstance.resize();

  if (payload.volumePath && getEl('volumeStoragePathText')) {
    getEl('volumeStoragePathText').textContent = `session: ${payload.volumePath.replace('/app/sessions', '')}`;
  }

  featureCatalogCache = payload.catalog || [];
  scheduledMessagesCache = Array.isArray(payload.schedules) ? payload.schedules : [];
  publicChatMessagesCache = Array.isArray(payload.publicChatMessages) ? payload.publicChatMessages : [];
  waLiveInboxCache = Array.isArray(payload.liveInbox) ? payload.liveInbox : [];

  renderScheduledMessagesGrid();
  renderPublicChatMessages();
  renderWaLiveInboxUI();
  renderDatabaseStatistics(payload.database, payload.globalStats, payload.trafficSeries);
  renderGatewayKeyUI(payload.apiKey ?? payload.database?.apiKey, payload.apiKeyStats ?? payload.database?.apiKeyStats);
  renderTopCommandsLeaderboard(payload.topCommands || []);

  if (Array.isArray(payload.database?.webhookLogs)) {
    renderWebhookDeliveryLogs(payload.database.webhookLogs);
  }
  if (payload.trafficVelocity) updateLiveTrafficVelocityUI(payload.trafficVelocity);
  if (payload.adminGlobalMonitor) syncFromGlobalMonitorSnapshot(payload.adminGlobalMonitor);

  if (Array.isArray(payload.announcements)) renderAnnouncementsCenterUI(payload.announcements);
  else renderGlobalAnnouncementBanner(payload.announcement);

  updateConnectionUIState(payload.status, payload.profile, Boolean(payload.isAutoReconnect));

  if (isCurrentUserAdmin) {
    renderPluginsList(payload.plugins || []);
    if (payload.plugins && payload.plugins.length > 0 && getEl('pluginFileNameInput') && !getEl('pluginFileNameInput').value) {
      selectPluginForEditing(payload.plugins[0].fileName, false);
    }
  }

  if (Array.isArray(payload.logs)) {
    terminalLogsBuffer = [...payload.logs];
    renderFilteredTerminalLogs();
  }
});

socketClient.on('session:reset', (payload) => {
  if (!getEl('connectionStatusBadge')) return;
  updateConnectionUIState('DISCONNECTED', null);
  renderDatabaseStatistics(payload.database, payload.globalStats);
  resetAuthenticationPanelsUI();
});

socketClient.on('connection:status', (payload) => {
  if (!getEl('connectionStatusBadge')) return;
  updateConnectionUIState(payload.status, payload.profile, Boolean(payload.isAutoReconnect));
  if (String(payload?.status).toUpperCase() !== 'DISCONNECTED' || !payload?.reason) return;

  const reason = String(payload.reason);
  notifyBotDisconnectIfAllowed(reason);

  if (reason === 'SUBSCRIPTION_EXPIRED') {
    showCyberToast('Masa Aktif Habis', 'Langganan bot Anda telah berakhir. Silakan perpanjang paket.', 'danger');
    openRenewModal();
  } else if (reason === 'RELINK_REQUIRED') {
    showCyberToast('Tautan Ulang Diperlukan', 'Sesi WhatsApp kadaluarsa, silakan scan QR atau Pairing ulang.', 'danger');
  } else if (reason === 'LOGGED_OUT') {
    showCyberToast('Sesi Terputus', 'Sesi bot telah logout atau dihapus dari perangkat.', 'danger');
  }
});

socketClient.on('session:clear-prekeys:result', (res) => {
  const btn = getEl('clearPreKeysBtn');
  if (btn) btn.disabled = false;
  if (res?.isSuccess) {
    showCyberToast('Cache Sesi Dibersihkan', `${res.deletedCount} file (${res.freedLabel}) dihapus. creds.json aman.`, 'success');
  } else {
    showCyberToast('Gagal Clear Cache', res?.errorMessage || 'Folder sesi tidak ditemukan.', 'danger');
  }
});

socketClient.on('ai:updated', (res) => {
  if (res?.isSuccess) {
    updateAiPersonaBadgesUI(Boolean(res.isAiEnabled));
    showCyberToast('AI Persona', `AI Persona ${res.isAiEnabled ? 'diaktifkan' : 'dinonaktifkan'}.`, 'success');
  }
});

socketClient.on('gateway:key:updated', (res) => {
  if (res?.isSuccess) {
    renderGatewayKeyUI(res.apiKey, res.apiKeyStats);
    showCyberToast('API Gateway', res.apiKey ? 'API Key baru siap digunakan.' : 'API Key telah dicabut.', res.apiKey ? 'success' : 'info');
  }
});

socketClient.on('gateway:webhook:test:result', (res) => {
  if (res?.isSuccess) {
    showCyberToast('Webhook Aktif', `Server tujuan merespons HTTP ${res.statusCode || 200}.`, 'success');
  } else {
    showCyberToast('Webhook Gagal', res?.errorMessage || 'Tidak dapat menghubungi URL Webhook.', 'danger');
  }
});

socketClient.on('manage:group:config:saved', (res) => {
  if (res?.isSuccess) {
    toggleModalVisibility('groupVisualConfigModal', false);
    showCyberToast('Grup Diperbarui', 'Pengaturan Welcome, Goodbye, dan moderasi grup disimpan.', 'success');
  }
});

socketClient.on('voucher:redeem:result', (res) => {
  const btn = getEl('voucherRedeemSubmitBtn');
  if (btn) btn.disabled = false;
  if (res?.isSuccess) {
    closeVoucherRedeemModal();
    if (res.subscription) renderSubscriptionCountdown(res.subscription);
    showCyberToast('Voucher Berhasil', `Masa aktif bertambah +${res.addedDays} hari.`, 'success');
  } else {
    showCyberToast('Klaim Gagal', res?.errorMessage || 'Kode voucher tidak valid.', 'danger');
  }
});

socketClient.on('qr:update', (payload) => {
  const qrImg = getEl('qrCodeImageElement');
  const qrText = getEl('qrCodeStatusText');
  if (!qrImg || !qrText) return;
  const qrDataUrl = typeof payload === 'string' ? payload : payload?.qrDataUrl;
  if (qrDataUrl) {
    qrImg.src = qrDataUrl;
    qrImg.classList.remove('hidden');
    qrText.textContent = 'Scan QR Code ini menggunakan aplikasi WhatsApp Anda (Perangkat Tertaut).';
  }
});

socketClient.on('pairing:code', (payload) => {
  const pairingCode = typeof payload === 'string' ? payload : payload?.pairingCode;
  if (pairingCode && getEl('pairingCodeValue')) {
    getEl('pairingCodeDisplayWrapper')?.classList.remove('hidden');
    getEl('copyPairingCodeBtn')?.classList.remove('hidden');
    getEl('pairingCodeValue').textContent = pairingCode;
    showCyberToast('Pairing Code', `Kode pairing diterima: ${pairingCode}`, 'success');
  }
});

socketClient.on('pairing:error', (errorMessage) => {
  showTopToast(errorMessage || 'Gagal menerbitkan kode pairing', true);
});

socketClient.on('stats:update', (payload) => {
  if (!getEl('liveApplicationContainer')) return;
  renderDatabaseStatistics(payload.userStats || payload.database, payload.globalStats, payload.trafficSeries);
  if (payload.topCommands) renderTopCommandsLeaderboard(payload.topCommands);
});

socketClient.on('announcements:update', (list) => {
  if (getEl('announcementModalList') || getEl('announcementUnreadBadge')) {
    safeExecute(() => renderAnnouncementsCenterUI(Array.isArray(list) ? list : []), 'announcements:update');
  }
});

socketClient.on('announcement:update', (payload) => {
  if (getEl('announcementModalList') || getEl('announcementUnreadBadge')) {
    safeExecute(() => renderGlobalAnnouncementBanner(payload), 'announcement:update');
  }
});

socketClient.on('direct:result', (res) => {
  const btn = getEl('directSendSubmitBtn');
  if (btn) btn.disabled = false;
  if (res?.isSuccess) {
    if (getEl('directMessageTextarea')) getEl('directMessageTextarea').value = '';
    if (getEl('directCharCountLabel')) getEl('directCharCountLabel').textContent = '0 karakter';
    showCyberToast('Pesan Terkirim', `Pesan berhasil dikirim ke ${String(res.targetJid || '').split('@')[0]}.`, 'success');
  } else {
    showCyberToast('Gagal Mengirim', res?.errorMessage || 'Gagal mengirim pesan langsung.', 'danger');
  }
});

socketClient.on('schedule:list', (list) => {
  scheduledMessagesCache = Array.isArray(list) ? list : [];
  if (getEl('scheduledMessagesCardGrid')) renderScheduledMessagesGrid();
});

socketClient.on('schedule:result', (res) => {
  if (res?.isSuccess) {
    if (getEl('schedTitleInput')) getEl('schedTitleInput').value = '';
    if (getEl('schedMessageTextarea')) getEl('schedMessageTextarea').value = '';
    showCyberToast('Jadwal Disimpan', 'Pesan terjadwal aktif dan siap dijalankan otomatis.', 'success');
  } else {
    showCyberToast('Jadwal Gagal', res?.errorMessage || 'Gagal menambahkan jadwal pesan.', 'danger');
  }
});

const handleCatalogRefresh = (catalogList) => {
  featureCatalogCache = Array.isArray(catalogList) ? catalogList : [];
  if (getEl('featureCatalogContainer')) renderFeatureCatalogUI();
};
socketClient.on('catalog:update', handleCatalogRefresh);
socketClient.on('catalog:data', handleCatalogRefresh);

socketClient.on('broadcast:progress', (prog) => {
  const current = Number(prog?.current || 0);
  const total = Math.max(1, Number(prog?.total || 1));
  const successCount = Number(prog?.successCount || 0);
  const failedCount = Number(prog?.failedCount || 0);
  const percent = Math.min(100, Math.round((current / total) * 100));

  getEl('broadcastProgressWrapper')?.classList.remove('hidden');
  if (getEl('broadcastProgressLabel')) getEl('broadcastProgressLabel').textContent = `Mengirim ${current}/${total} grup (${percent}%)`;
  if (getEl('broadcastProgressStats')) getEl('broadcastProgressStats').textContent = `✓ ${successCount} | ✗ ${failedCount}`;
  if (getEl('broadcastProgressBarFill')) getEl('broadcastProgressBarFill').style.width = `${percent}%`;
});

socketClient.on('broadcast:result', (res) => {
  if (getEl('broadcastSendSubmitBtn')) getEl('broadcastSendSubmitBtn').disabled = false;
  if (res?.isSuccess) {
    const sent = Number(res.sentCount ?? res.successCount ?? 0);
    const total = Number(res.totalGroups ?? res.total ?? 0);
    const failed = Number(res.failedCount ?? 0);
    if (getEl('broadcastProgressLabel')) getEl('broadcastProgressLabel').textContent = `Selesai: ${sent}/${total} grup`;
    if (getEl('broadcastProgressBarFill')) getEl('broadcastProgressBarFill').style.width = '100%';
    showCyberToast('Broadcast Selesai', `Terkirim ke ${sent}/${total} grup${failed > 0 ? ` (${failed} gagal)` : ''}.`, 'success');
  } else {
    if (getEl('broadcastProgressLabel')) getEl('broadcastProgressLabel').textContent = 'Broadcast dihentikan.';
    showCyberToast('Broadcast Gagal', res?.errorMessage || 'Gagal mengirim broadcast.', 'danger');
  }
});

socketClient.on('settings:saved', () => {
  showCyberToast('Pengaturan Disimpan', 'Konfigurasi bot berhasil diperbarui.', 'success');
});

socketClient.on('manage:data', (payload) => {
  managedUsersCache = Array.isArray(payload?.users) ? payload.users : [];
  managedGroupsCache = Array.isArray(payload?.groups) ? payload.groups : [];
  populateGroupSelectorOptions();
  renderManagedUsersTable();
  renderManagedGroupsTable();
  stopRefreshSpinSmoothly();
});

socketClient.on('manage:users:bulkResult', (res) => {
  if (res?.isSuccess) showCyberToast('Aksi Massal Selesai', `${res.count} user berhasil diperbarui sekaligus.`, 'success');
});

socketClient.on('manage:user:deleted', (payload) => {
  showCyberToast('User Dihapus', `Nomor +${payload?.number || '-'} berhasil dihapus permanen dari database.`, 'danger');
});

socketClient.on('terminal:log', (entry) => {
  if (getEl('terminalLogOutput')) appendTerminalLine(entry);
});

socketClient.on('plugin:list', (pluginsArray) => {
  if (isCurrentUserAdmin && getEl('pluginsFileListContainer')) renderPluginsList(pluginsArray);
});

socketClient.on('plugin:save:result', (result) => {
  if (result.isSuccess) {
    updateCodeInspectorReport(`Plugin "${result.fileName}" berhasil disimpan & dimuat ulang tanpa error.`, false);
    showCyberToast('Plugin Diterapkan', `File ${result.fileName} aktif (Hot-Reload).`, 'success');
  } else {
    updateCodeInspectorReport(result.errorMessage || 'Terjadi kesalahan sintaks pada plugin.', true);
    showCyberToast('Validasi Gagal', 'Cek detail error pada inspector.', 'danger');
  }
});

socketClient.on('plugin:error', (payload) => {
  updateCodeInspectorReport(`[Runtime Error - ${payload.fileName || 'Plugin'}]\n${payload.errorMessage || ''}`, true);
});

// --- inisialisasi terpadu kondisional untuk dashboard.html dan chat.html ---
function initXuCoreUnifiedPage(requestedPage) {
  if (isAppCoreInitialized) return;
  isAppCoreInitialized = true;
  activePageName = requestedPage || window.XU_CORE_PAGE_CONTEXT?.page || (getEl('communityMessagesContainer') ? 'chat' : 'dashboard');

  safeExecute(() => {
    window.addEventListener('click', () => {
      const popupMenu = getEl('userDropdownMenuPopup');
      if (popupMenu && !popupMenu.classList.contains('hidden')) popupMenu.classList.add('hidden');
      if (isChatAttachMenuOpen) closeChatAttachMenu();
    });

    setupGlobalHotkeys();

    if (!uptimeTickInterval) {
      uptimeTickInterval = setInterval(() => {
        const uptimeEl = getEl('statBotUptime');
        if (!uptimeEl) return;
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - botStartTimeMs) / 1000));
        const hours = String(Math.floor(elapsedSeconds / 3600)).padStart(2, '0');
        const minutes = String(Math.floor((elapsedSeconds % 3600) / 60)).padStart(2, '0');
        const seconds = String(elapsedSeconds % 60).padStart(2, '0');
        uptimeEl.textContent = `${hours}:${minutes}:${seconds}`;
      }, 1000);
    }

    if (activePageName === 'dashboard') {
      const brandCanvas = getEl('headerBrandTextCanvas');
      if (brandCanvas) {
        const responsiveScale = window.innerWidth < 440 ? 0.62 : 0.7;
        initHeaderBrandTextCanvas(brandCanvas, {
          width: 146,
          height: 44,
          centerY: 22,
          fontSize: 27,
          scale: responsiveScale
        });
      }

      if (getEl('trafficVelocityChart')) initTrafficVelocityChart();
      if (getEl('cpuHeartbeatChart')) initCpuHeartbeatChart();
      if (getEl('trafficHistoryChart')) initTrafficHistoryChart();
      if (getEl('terminalLogOutput')) setupTerminalScrollWatcher();
      if (getEl('pluginCodeEditorTextarea')) setupCodeEditorEnhancements();
      if (getEl('broadcastGroupMessageInput')) setupBroadcastTemplatePreviewListener();
      syncBrowserNotifLabel();
      if (getEl('gwMediaTypeSelect')) switchGatewayMediaFields();
      if (getEl('arVisualRulesList')) renderVisualAutoReplyRules();
      fetchCurrentProfileSettings();
    }

    if (activePageName === 'chat') {
      fetchCurrentProfileSettings();
      socketClient.emit('community:init');
      socketClient.emit('inbox:list');

      const urlParams = new URLSearchParams(window.location.search);
      if (urlParams.get('tab') === 'inbox') {
        switchChatPageSection('inbox');
      }
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        if (!socketClient.connected) {
          socketClient.connect();
        } else if (activePageName === 'chat') {
          socketClient.emit('community:init');
        } else {
          socketClient.emit('session:sync');
        }
      }
    });
  }, 'initXuCoreUnifiedPage');
}

window.XuCoreApp = {
  initPage: initXuCoreUnifiedPage
};