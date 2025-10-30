"use strict";

const state = {
  connected: false,
  serverUrl: "http://localhost:8087",
  defaultLibraryPath: "",
  defaultLibraryName: "",
  selectedLibraryPath: "",
  selectedLibraryName: "",
  overwriteFootprints: false,
  overwriteModels: false,
  debugLogs: false,
  jobs: [],
  jobHistory: [],
  jobsLoading: false,
  historyLoading: false,
  historyFilter: "all",
  historySearchTerm: "",
  historyVisibleCount: 10,
  historyPageSize: 10,
};

const elements = {};

let pathRoots = [];
let currentDirectory = null;
let currentEntries = [];
let selectedEntryIndex = -1;
let historySearchTimeout = null;
let settingsSaveTimeout = null;
let settingsFeedbackTimeout = null;
const pathHistory = [];
let lastTrackedHistorySearch = "";
let lastPathInfoChecked = null;

const SETTINGS_SAVE_DEBOUNCE_MS = 400;
const SETTINGS_FEEDBACK_CLEAR_MS = 1500;

function $(selector) {
  return document.querySelector(selector);
}

function logDebug(message, ...args) {
  if (!state.debugLogs) {
    return;
  }
  console.debug(`[popup] ${message}`, ...args);
}

function trackEvent(name, detail = {}) {
  const payload = {
    event: name,
    detail,
    timestamp: new Date().toISOString(),
  };
  console.info("[ui-event]", payload);
}

function resetCollection(container, selector) {
  if (!container) {
    return;
  }
  container.querySelectorAll(selector).forEach((node) => node.remove());
}

async function sendMessage(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    throw new Error(response?.error || "Unbekannter Fehler");
  }
  return response.data;
}

function initElements() {
  elements.status = $("#connection-status");
  elements.statusLabel = elements.status?.querySelector(".status-label");
  elements.tabs = document.querySelectorAll(".tab-button");
  elements.tabContents = document.querySelectorAll(".tab-content");
  elements.lcscId = $("#lcsc-id");
  elements.libraryName = $("#library-name");
  elements.selectedPath = $("#selected-path");
  elements.openPathBrowser = $("#open-path-browser");
  elements.pathBrowser = $("#path-browser");
  elements.pathEntries = $("#path-entries");
  elements.pathBreadcrumb = $("#path-breadcrumb");
  elements.pathManual = $("#path-manual");
  elements.pathGo = $("#path-go");
  elements.pathApply = $("#path-apply");
  elements.pathBack = $("#path-back");
  elements.pathInfo = $("#path-info");
  elements.pathError = $("#path-error");
  elements.generateSymbol = $("#generate-symbol");
  elements.generateFootprint = $("#generate-footprint");
  elements.generateModel = $("#generate-model");
  elements.overwriteExisting = $("#overwrite-existing");
  elements.jobError = $("#job-error");
  elements.jobSuccess = $("#job-success");
  elements.jobForm = $("#job-form");
  elements.historyList = $("#history-list");
  elements.clearHistory = $("#clear-history");
  elements.historySearch = $("#history-search");
  elements.historyClearSearch = $("#history-clear-search");
  elements.historyFilter = $("#history-filter");
  elements.historyLoadMore = $("#history-load-more");
  elements.settingServerUrl = $("#setting-server-url");
  elements.settingDefaultPath = $("#setting-default-path");
  elements.settingDefaultName = $("#setting-default-name");
  elements.settingOverwriteFootprints = $("#setting-overwrite-footprints");
  elements.settingOverwriteModels = $("#setting-overwrite-models");
  elements.settingDebugLogs = $("#setting-debug-logs");
  elements.settingUseSelected = $("#setting-use-selected");
  elements.settingsFeedback = $("#settings-feedback");
  elements.jobSkip = $("#job-skip");
  elements.jobReset = $("#job-reset");
}

function bindEvents() {
  elements.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      switchTab(tab.dataset.tab);
      trackEvent("tab_changed", { tab: tab.dataset.tab });
    });
  });

  elements.openPathBrowser?.addEventListener("click", () => {
    trackEvent("cta_clicked", { id: "open_path_browser" });
    togglePathBrowser(true);
  });
  elements.pathBack?.addEventListener("click", () => {
    togglePathBrowser(false);
    trackEvent("cta_clicked", { id: "path_back_close" });
  });
  elements.pathApply?.addEventListener("click", () => {
    applyCurrentPath();
    trackEvent("cta_clicked", { id: "path_apply" });
  });
  elements.pathGo?.addEventListener("click", () => {
    handleManualPath();
    trackEvent("cta_clicked", { id: "path_go" });
  });
  elements.pathManual?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleManualPath();
      trackEvent("search_submitted", { scope: "path_browser", input: elements.pathManual.value.trim() });
    }
  });

  elements.pathEntries?.addEventListener("keydown", handlePathListKeydown);
  elements.pathEntries?.addEventListener(
    "focus",
    () => {
      if (!currentEntries.length) {
        return;
      }
      if (selectedEntryIndex < 0) {
        setSelectedEntry(0, true);
      } else {
        setSelectedEntry(selectedEntryIndex, true);
      }
    },
    true,
  );

  elements.jobSkip?.addEventListener("click", () => {
    applyDefaultPath();
    trackEvent("cta_clicked", { id: "job_skip_to_defaults" });
  });
  elements.jobReset?.addEventListener("click", () => {
    resetJobForm();
    trackEvent("cta_clicked", { id: "job_reset" });
  });
  elements.submitJob = $("#submit-job");
  elements.submitJob?.addEventListener("click", (event) => {
    event.preventDefault();
    handleJobSubmit(event);
  });

  elements.historySearch?.addEventListener("input", handleHistorySearchInput);
  elements.historySearch?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      state.historyVisibleCount = state.historyPageSize;
      finalizeHistorySearch(true);
    }
  });
  elements.historyClearSearch?.addEventListener("click", () => {
    elements.historySearch.value = "";
    state.historySearchTerm = "";
    state.historyVisibleCount = state.historyPageSize;
    finalizeHistorySearch(true);
    trackEvent("cta_clicked", { id: "history_search_clear" });
  });
  elements.historyFilter?.addEventListener("change", (event) => {
    state.historyFilter = event.target.value || "all";
    state.historyVisibleCount = state.historyPageSize;
    trackEvent("filter_applied", { scope: "history", filter: state.historyFilter });
    renderHistory();
  });
  elements.historyLoadMore?.addEventListener("click", () => {
    state.historyVisibleCount += state.historyPageSize;
    trackEvent("cta_clicked", {
      id: "history_load_more",
      visibleCount: state.historyVisibleCount,
    });
    renderHistory();
  });

  elements.clearHistory?.addEventListener("click", handleClearHistory);

  elements.settingUseSelected?.addEventListener("click", () => {
    if (state.selectedLibraryPath) {
      elements.settingDefaultPath.value = state.selectedLibraryPath;
      trackEvent("cta_clicked", { id: "settings_use_selected_path" });
      scheduleSettingsUpdate();
    }
  });
  elements.settingServerUrl?.addEventListener("input", handleSettingsFieldChange);
  elements.settingDefaultPath?.addEventListener("input", handleSettingsFieldChange);
  elements.settingDefaultName?.addEventListener("input", handleSettingsFieldChange);
  elements.settingOverwriteFootprints?.addEventListener("change", handleSettingsFieldChange);
  elements.settingOverwriteModels?.addEventListener("change", handleSettingsFieldChange);
  elements.settingDebugLogs?.addEventListener("change", handleSettingsFieldChange);
}

function resetJobForm() {
  if (!elements.jobForm) {
    return;
  }
  elements.lcscId.value = "";
  elements.jobError.textContent = "";
  elements.jobSuccess.textContent = "";
  elements.generateSymbol.checked = true;
  elements.generateFootprint.checked = false;
  elements.generateModel.checked = false;
  elements.overwriteExisting.checked = false;
  if (!state.selectedLibraryName && elements.libraryName) {
    elements.libraryName.value = state.defaultLibraryName || "";
  }
}

function applyDefaultPath() {
  const basePath = state.selectedLibraryPath || state.defaultLibraryPath || "";
  if (!basePath) {
    elements.jobError.textContent = "Bitte Standardpfad in den Einstellungen hinterlegen.";
    return;
  }
  state.selectedLibraryPath = basePath;
  if (elements.selectedPath) {
    elements.selectedPath.value = basePath;
  }
  elements.jobError.textContent = "";
  elements.jobSuccess.textContent = "Standardpfad übernommen.";
  lastPathInfoChecked = null;
  updatePathInfo(basePath);
}

function handleHistorySearchInput(event) {
  state.historySearchTerm = event.target.value || "";
  state.historyVisibleCount = state.historyPageSize;
  if (historySearchTimeout) {
    clearTimeout(historySearchTimeout);
  }
  historySearchTimeout = setTimeout(() => finalizeHistorySearch(false), 300);
  renderHistory();
}

function finalizeHistorySearch(forceTrack) {
  if (historySearchTimeout) {
    clearTimeout(historySearchTimeout);
    historySearchTimeout = null;
  }
  const term = state.historySearchTerm.trim();
  if (forceTrack || term !== lastTrackedHistorySearch) {
    trackEvent("search_submitted", {
      scope: "history",
      query: term,
    });
    lastTrackedHistorySearch = term;
  }
  renderHistory();
}

function handleSettingsFieldChange() {
  scheduleSettingsUpdate();
}

function scheduleSettingsUpdate() {
  if (!elements.settingsFeedback) {
    return;
  }
  if (settingsSaveTimeout) {
    clearTimeout(settingsSaveTimeout);
  }
  if (settingsFeedbackTimeout) {
    clearTimeout(settingsFeedbackTimeout);
    settingsFeedbackTimeout = null;
  }
  setSettingsFeedback("Speichern …", "success");
  settingsSaveTimeout = setTimeout(applySettingsUpdate, SETTINGS_SAVE_DEBOUNCE_MS);
}

function setSettingsFeedback(message, type = "success") {
  if (!elements.settingsFeedback) {
    return;
  }
  const el = elements.settingsFeedback;
  el.textContent = message || "";
  el.classList.remove("feedback-error", "feedback-success");
  if (!message) {
    return;
  }
  if (type === "error") {
    el.classList.add("feedback-error");
  } else {
    el.classList.add("feedback-success");
  }
}

function collectSettingsPayload() {
  const serverUrlInput = elements.settingServerUrl?.value ?? "";
  const defaultPathInput = elements.settingDefaultPath?.value ?? "";
  const defaultNameInput = elements.settingDefaultName?.value ?? "";

  return {
    serverUrl: serverUrlInput.trim(),
    defaultLibraryPath: defaultPathInput.trim(),
    defaultLibraryName: defaultNameInput.trim(),
    overwriteFootprints: Boolean(elements.settingOverwriteFootprints?.checked),
    overwriteModels: Boolean(elements.settingOverwriteModels?.checked),
    debugLogs: Boolean(elements.settingDebugLogs?.checked),
  };
}

async function applySettingsUpdate() {
  settingsSaveTimeout = null;
  try {
    const payload = collectSettingsPayload();
    const snapshot = await sendMessage("updateSettings", payload);
    applyState(snapshot);
    setSettingsFeedback("Gespeichert.", "success");
    settingsFeedbackTimeout = setTimeout(() => {
      setSettingsFeedback("");
      settingsFeedbackTimeout = null;
    }, SETTINGS_FEEDBACK_CLEAR_MS);
  } catch (error) {
    const message = error?.message || "Speichern fehlgeschlagen.";
    setSettingsFeedback(message, "error");
    if (settingsFeedbackTimeout) {
      clearTimeout(settingsFeedbackTimeout);
      settingsFeedbackTimeout = null;
    }
  }
}

function updatePathNavState() {
  if (elements.pathBack) {
    elements.pathBack.disabled = false;
  }
}

function switchTab(tabId) {
  elements.tabs.forEach((tab) => {
    const isActive = tab.dataset.tab === tabId;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-pressed", String(isActive));
  });
  elements.tabContents.forEach((content) => {
    const isActive = content.id === `tab-${tabId}`;
    content.classList.toggle("active", isActive);
    content.setAttribute("aria-hidden", String(!isActive));
  });
}

function togglePathBrowser(show) {
  if (show) {
    elements.pathBrowser.classList.remove("hidden");
    elements.pathBrowser.setAttribute("aria-hidden", "false");
    elements.jobForm?.classList.add("collapsed");
    elements.pathManual.value = state.selectedLibraryPath || state.defaultLibraryPath || "";
    pathHistory.length = 0;
    if (elements.pathEntries) {
      elements.pathEntries.dataset.currentPath = "";
      elements.pathEntries.scrollTop = 0;
    }
    updatePathNavState();
    loadRoots();
  } else {
    elements.pathBrowser.classList.add("hidden");
    elements.pathBrowser.setAttribute("aria-hidden", "true");
    elements.jobForm?.classList.remove("collapsed");
    pathHistory.length = 0;
    if (elements.pathEntries) {
      elements.pathEntries.dataset.currentPath = "";
      elements.pathEntries.scrollTop = 0;
    }
    updatePathNavState();
  }
}

async function loadRoots() {
  try {
    const data = await sendMessage("fs:listRoots");
    pathRoots = data || [];
    updatePathNavState();

    const manualPath = elements.pathManual.value.trim();
    if (manualPath) {
      loadDirectory(manualPath, { pushHistory: false });
    } else if (pathRoots.length > 0) {
      loadDirectory(pathRoots[0].path, { pushHistory: false });
    }
  } catch (error) {
    elements.pathError.textContent = error.message;
    updatePathNavState();
  }
}

async function handleManualPath() {
  const manualPath = elements.pathManual.value.trim();
  if (!manualPath) {
    elements.pathError.textContent = "Pfad eingeben.";
    return;
  }
  elements.pathError.textContent = "";
  await loadDirectory(manualPath);
}

function createBreadcrumbSegments(path) {
  if (!path) {
    return [];
  }

  const segments = [];
  const windowsDrive = path.match(/^[A-Za-z]:/);

  if (windowsDrive) {
    const drive = `${windowsDrive[0].toUpperCase()}:`;
    let current = `${windowsDrive[0]}\\`;
    segments.push({ label: drive, path: current });
    const remainder = path.slice(current.length).replace(/^[\\/]+/, "");
    if (!remainder) {
      return segments;
    }
    remainder.split(/[\\/]+/).filter(Boolean).forEach((part) => {
      current = current.endsWith("\\") ? `${current}${part}` : `${current}\\${part}`;
      segments.push({ label: part, path: current });
    });
    return segments;
  }

  if (path.startsWith("/")) {
    let current = "/";
    segments.push({ label: "/", path: current });
    const parts = path.split("/").filter(Boolean);
    parts.forEach((part) => {
      current = current === "/" ? `/${part}` : `${current}/${part}`;
      segments.push({ label: part, path: current });
    });
    return segments;
  }

  let current = "";
  path.split(/[\\/]+/)
    .filter(Boolean)
    .forEach((part, index) => {
      current = index === 0 ? part : `${current}/${part}`;
      segments.push({ label: part, path: current });
    });
  return segments;
}

function renderBreadcrumb(path) {
  if (!elements.pathBreadcrumb) {
    return;
  }
  const container = elements.pathBreadcrumb;
  container.innerHTML = "";
  const segments = createBreadcrumbSegments(path);
  if (!segments.length) {
    container.textContent = path || "";
    return;
  }
  segments.forEach((segment, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "breadcrumb-item";
    button.textContent = segment.label;
    button.dataset.path = segment.path;
    const isCurrent = index === segments.length - 1;

    const navigateToSegment = () => {
      if (isCurrent) {
        return;
      }
      loadDirectory(segment.path, { pushHistory: true });
      trackEvent("cta_clicked", { id: "path_breadcrumb", target: segment.path });
    };
    button.addEventListener("click", navigateToSegment);
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        navigateToSegment();
      }
    });
    button.disabled = isCurrent;
    if (isCurrent) {
      button.classList.add("active");
    }
    container.appendChild(button);
    if (index < segments.length - 1) {
      const separator = document.createElement("span");
      separator.className = "breadcrumb-separator";
      separator.textContent = "›";
      container.appendChild(separator);
    }
  });
}

function setSelectedEntry(index, focus = false) {
  const items = elements.pathEntries.querySelectorAll("li");
  if (index < 0 || index >= items.length) {
    selectedEntryIndex = -1;
    items.forEach((item) => item.setAttribute("aria-selected", "false"));
    return;
  }
  selectedEntryIndex = index;
  items.forEach((item, itemIndex) => {
    const isSelected = itemIndex === index;
    item.setAttribute("aria-selected", isSelected ? "true" : "false");
    if (isSelected && focus) {
      if (typeof item.focus === "function") {
        try {
          item.focus({ preventScroll: true });
        } catch (error) {
          item.focus();
        }
      }
    }
  });
}

function renderDirectoryEntries(entries, preserveScroll = false) {
  const list = Array.isArray(entries) ? entries : [];
  currentEntries = list.filter((entry) => entry.is_dir);
  const previousScrollTop = preserveScroll ? elements.pathEntries.scrollTop : 0;
  elements.pathEntries.innerHTML = "";

  if (!currentEntries.length) {
    const empty = document.createElement("li");
    empty.textContent = "Keine Unterordner";
    empty.className = "path-empty";
    empty.setAttribute("aria-disabled", "true");
    empty.tabIndex = -1;
    elements.pathEntries.appendChild(empty);
    selectedEntryIndex = -1;
    return;
  }

  currentEntries.forEach((entry, index) => {
    const li = document.createElement("li");
    li.dataset.index = String(index);
    li.dataset.path = entry.path;
    li.tabIndex = 0;

    const icon = document.createElement("span");
    icon.className = "entry-icon";
    icon.textContent = "📁";

    const label = document.createElement("span");
    label.textContent = entry.name;

    li.appendChild(icon);
    li.appendChild(label);

    li.addEventListener("click", () => {
      setSelectedEntry(index, true);
    });

    li.addEventListener("dblclick", () => {
      loadDirectory(entry.path);
    });

    li.addEventListener("focus", () => {
      if (selectedEntryIndex !== index) {
        setSelectedEntry(index);
      }
    });

    elements.pathEntries.appendChild(li);
  });

  if (selectedEntryIndex < 0) {
    selectedEntryIndex = 0;
  }
  selectedEntryIndex = Math.min(selectedEntryIndex, currentEntries.length - 1);
  if (preserveScroll) {
    elements.pathEntries.scrollTop = previousScrollTop;
  } else {
    elements.pathEntries.scrollTop = 0;
  }
  setSelectedEntry(selectedEntryIndex, true);
}

function openSelectedEntry() {
  if (selectedEntryIndex < 0 || !currentEntries[selectedEntryIndex]) {
    return;
  }
  loadDirectory(currentEntries[selectedEntryIndex].path);
}

function handlePathListKeydown(event) {
  if (!currentEntries.length) {
    if (event.key === "Backspace") {
      event.preventDefault();
      if (currentDirectory?.parent) {
        loadDirectory(currentDirectory.parent);
      }
    }
    return;
  }

  switch (event.key) {
    case "ArrowDown":
      event.preventDefault();
      if (selectedEntryIndex < currentEntries.length - 1) {
        setSelectedEntry(selectedEntryIndex + 1, true);
      }
      break;
    case "ArrowUp":
      event.preventDefault();
      if (selectedEntryIndex > 0) {
        setSelectedEntry(selectedEntryIndex - 1, true);
      }
      break;
    case "Home":
      event.preventDefault();
      setSelectedEntry(0, true);
      break;
    case "End":
      event.preventDefault();
      setSelectedEntry(currentEntries.length - 1, true);
      break;
    case "Enter":
    case "ArrowRight":
      event.preventDefault();
      openSelectedEntry();
      break;
    case "Backspace":
    case "ArrowLeft":
      event.preventDefault();
      if (currentDirectory?.parent) {
        loadDirectory(currentDirectory.parent);
      }
      break;
    default:
      break;
  }
}

async function updatePathInfo(path) {
  if (!elements.pathInfo) {
    return;
  }
  if (!path) {
    elements.pathInfo.textContent = "";
    elements.pathInfo.classList.remove("invalid");
    lastPathInfoChecked = null;
    return;
  }
  if (path === lastPathInfoChecked) {
    return;
  }
  try {
    const info = await sendMessage("fs:check", { path });
    let message = "";
    if (info.exists) {
      message = info.is_dir ? "Ordner vorhanden" : "Pfad existiert";
    } else {
      message = "Ordner wird neu erstellt";
    }
    if (info.writable) {
      message += " – beschreibbar";
      elements.pathInfo.classList.remove("invalid");
    } else {
      message += " – keine Schreibrechte";
      elements.pathInfo.classList.add("invalid");
    }
    elements.pathInfo.textContent = message;
    lastPathInfoChecked = path;
  } catch (error) {
    elements.pathInfo.textContent = error.message;
    elements.pathInfo.classList.add("invalid");
    lastPathInfoChecked = null;
  }
}

async function loadDirectory(path, options = {}) {
  const { pushHistory = true } = options;
  try {
    const targetPath = String(path);
    if (pushHistory && currentDirectory?.path && currentDirectory.path !== targetPath) {
      pathHistory.push(currentDirectory.path);
      if (pathHistory.length > 50) {
        pathHistory.shift();
      }
    }
    const data = await sendMessage("fs:listDirectory", { path: targetPath });
    currentDirectory = data;
    selectedEntryIndex = -1;
    updateDirectoryView();
    await updatePathInfo(currentDirectory.path);
    elements.pathError.textContent = "";
    updatePathNavState();
  } catch (error) {
    elements.pathError.textContent = error.message;
  }
}

function updateDirectoryView() {
  if (!currentDirectory) {
    return;
  }
  const currentPath = currentDirectory.path;
  elements.pathManual.value = currentPath;
  renderBreadcrumb(currentPath);
  const previousPath = elements.pathEntries?.dataset?.currentPath || "";
  const preserveScroll = previousPath === currentPath;
  renderDirectoryEntries(currentDirectory.entries, preserveScroll);
  if (elements.pathEntries) {
    elements.pathEntries.dataset.currentPath = currentPath;
  }
  updatePathNavState();
}

async function applyCurrentPath() {
  if (!currentDirectory?.path) {
    elements.pathError.textContent = "Bitte Ordner auswählen.";
    return;
  }
  const userName = elements.libraryName.value.trim();
  const fallbackName =
    userName
    || state.selectedLibraryName
    || state.defaultLibraryName
    || formatPathLabel(currentDirectory.path)
    || "easyeda2kicad";
  try {
    const result = await sendMessage("setSelectedLibrary", {
      path: currentDirectory.path,
      name: fallbackName,
    });
    state.selectedLibraryPath = result?.path || currentDirectory.path;
    state.selectedLibraryName = result?.name || fallbackName;
    elements.libraryName.value = state.selectedLibraryName || "";
    if (elements.selectedPath) {
      elements.selectedPath.value = state.selectedLibraryPath;
    }
    elements.pathManual.value = state.selectedLibraryPath;
    lastPathInfoChecked = null;
    updatePathInfo(state.selectedLibraryPath);
    togglePathBrowser(false);
    elements.pathError.textContent = "";
  } catch (error) {
    elements.pathError.textContent = error.message;
  }
}

async function handleJobSubmit(event) {
  event.preventDefault?.();
  elements.jobError.textContent = "";
  elements.jobSuccess.textContent = "";
  const lcscId = elements.lcscId.value.trim();
  const libraryName = elements.libraryName.value.trim() || state.selectedLibraryName || state.defaultLibraryName || "easyeda2kicad";
  const libraryPath = state.selectedLibraryPath || state.defaultLibraryPath;

  if (!lcscId || !lcscId.toUpperCase().startsWith("C")) {
    elements.jobError.textContent = "Bitte eine gültige LCSC ID (z. B. C1234) eingeben.";
    return;
  }
  if (!libraryPath) {
    elements.jobError.textContent = "Bibliothekspfad auswählen oder in den Einstellungen hinterlegen.";
    return;
  }

  const outputs = {
    symbol: elements.generateSymbol.checked,
    footprint: elements.generateFootprint.checked,
    model: elements.generateModel.checked,
  };

  if (!outputs.symbol && !outputs.footprint && !outputs.model) {
    elements.jobError.textContent = "Mindestens eine Ausgabeoption auswählen.";
    return;
  }

  const payload = {
    lcscId,
    libraryName,
    libraryPath,
    symbol: outputs.symbol,
    footprint: outputs.footprint,
    model: outputs.model,
    overwrite: elements.overwriteExisting.checked,
    overwrite_model: elements.overwriteExisting.checked,
    kicadVersion: "v6",
    projectRelative: false,
  };

  const submitButton = $("#submit-job");
  const previousDisabled = submitButton ? submitButton.disabled : false;
  if (submitButton) {
    submitButton.disabled = true;
  }
  state.jobsLoading = true;
  renderHistory();
  trackEvent("cta_clicked", {
    id: "job_submit",
    lcscId: lcscId.toUpperCase(),
    outputs,
    overwrite: payload.overwrite,
    overwrite_model: payload.overwrite_model,
    kicadVersion: payload.kicadVersion,
  });
  try {
    await sendMessage("submitJob", { payload });
    elements.jobError.textContent = "";
    if (!state.selectedLibraryName) {
      state.selectedLibraryName = libraryName;
    }
    elements.jobSuccess.textContent = "Job gestartet.";
  } catch (error) {
    elements.jobError.textContent = error.message;
    state.jobsLoading = false;
  } finally {
    if (submitButton) {
      submitButton.disabled = previousDisabled;
    }
    if (!state.jobsLoading) {
      renderHistory();
    }
  }
}

async function handleClearHistory() {
  try {
    await sendMessage("clearHistory");
    state.jobHistory = [];
    renderHistory();
    trackEvent("cta_clicked", { id: "history_clear" });
  } catch (error) {
    console.error(error);
  }
}

function applyState(newState) {
  if (!newState) {
    return;
  }
  state.connected = Boolean(newState.connected);
  state.serverUrl = newState.serverUrl || state.serverUrl;
  state.defaultLibraryPath = newState.defaultLibraryPath || "";
  state.defaultLibraryName = newState.defaultLibraryName || "";
  state.selectedLibraryPath = newState.selectedLibraryPath || state.selectedLibraryPath || "";
  state.selectedLibraryName = newState.selectedLibraryName || state.selectedLibraryName || "";
  state.overwriteFootprints = Boolean(newState.overwriteFootprints);
  state.overwriteModels = Boolean(newState.overwriteModels);
  state.debugLogs = Boolean(newState.debugLogs);
  state.jobs = Array.isArray(newState.jobs) ? newState.jobs : [];
  state.jobHistory = Array.isArray(newState.jobHistory) ? newState.jobHistory : [];
  state.jobsLoading = false;
  state.historyLoading = false;
  render();
}

function render() {
  updateStatusIndicator();
  if (elements.settingServerUrl) {
    elements.settingServerUrl.value = state.serverUrl;
  }
  if (elements.settingDefaultPath) {
    elements.settingDefaultPath.value = state.defaultLibraryPath;
  }
  if (elements.settingDefaultName) {
    elements.settingDefaultName.value = state.defaultLibraryName;
  }
  if (elements.settingOverwriteFootprints) {
    elements.settingOverwriteFootprints.checked = state.overwriteFootprints;
  }
  if (elements.settingOverwriteModels) {
    elements.settingOverwriteModels.checked = state.overwriteModels;
  }
  if (elements.settingDebugLogs) {
    elements.settingDebugLogs.checked = state.debugLogs;
  }
  if (elements.selectedPath) {
    elements.selectedPath.value = state.selectedLibraryPath || "";
  }
  if (!elements.libraryName.value) {
    elements.libraryName.value = state.selectedLibraryName || state.defaultLibraryName || "";
  }
  if (elements.historySearch && document.activeElement !== elements.historySearch) {
    elements.historySearch.value = state.historySearchTerm;
  }
  if (elements.historyFilter) {
    elements.historyFilter.value = state.historyFilter || "all";
  }
  if (elements.historyClearSearch) {
    elements.historyClearSearch.disabled = !(state.historySearchTerm && state.historySearchTerm.trim());
  }
  if (elements.pathInfo) {
    if (state.selectedLibraryPath) {
      updatePathInfo(state.selectedLibraryPath);
    } else {
      elements.pathInfo.textContent = "";
      elements.pathInfo.classList.remove("invalid");
    }
  }
  updatePathNavState();
  renderHistory();
}

function updateStatusIndicator() {
  if (!elements.status) {
    return;
  }
  const label = state.connected ? "Verbunden" : "Offline";
  elements.status.dataset.state = state.connected ? "online" : "offline";
  elements.status.classList.toggle("status-online", state.connected);
  elements.status.classList.toggle("status-offline", !state.connected);
  if (elements.statusLabel) {
    elements.statusLabel.textContent = label;
  } else {
    elements.status.textContent = label;
  }
}

function renderHistory() {
  const container = elements.historyList;
  if (!container) {
    return;
  }
  resetCollection(container, ".history-card, .job-card");

  if (state.historyLoading || state.jobsLoading) {
    container.dataset.state = "loading";
    if (elements.historyLoadMore) {
      elements.historyLoadMore.hidden = true;
    }
    return;
  }

  const entries = getTimelineEntries();
  const emptyPlaceholder = container.querySelector('.collection-placeholder[data-state="empty"]');
  if (emptyPlaceholder) {
    if (state.jobs.length === 0 && state.jobHistory.length === 0) {
      emptyPlaceholder.textContent = "Noch keine Jobs oder Einträge.";
    } else if (state.historySearchTerm.trim()) {
      emptyPlaceholder.textContent = `Keine Treffer für „${state.historySearchTerm.trim()}“.`;
    } else {
      emptyPlaceholder.textContent = "Keine Einträge für den aktuellen Filter.";
    }
  }

  if (!entries.length) {
    container.dataset.state = "empty";
    if (elements.historyLoadMore) {
      elements.historyLoadMore.hidden = true;
    }
    return;
  }

  container.dataset.state = "ready";
  const visibleCount = Math.max(state.historyPageSize, state.historyVisibleCount);
  const visible = entries.slice(0, visibleCount);
  visible.forEach((entry) => {
    container.appendChild(buildTimelineCard(entry));
  });
  if (elements.historyLoadMore) {
    elements.historyLoadMore.hidden = visible.length >= entries.length;
  }
}

function buildJobCard(job) {
  const card = document.createElement("article");
  card.className = "job-card";

  const header = document.createElement("div");
  header.className = "job-card-header";

  const title = document.createElement("div");
  const titleStrong = document.createElement("strong");
  titleStrong.textContent = job.lcscId || job.id;
  title.appendChild(titleStrong);
  const titleSuffix = document.createElement("span");
  titleSuffix.textContent = ` · ${job.libraryName || "Bibliothek"}`;
  title.appendChild(titleSuffix);

  header.appendChild(title);
  header.appendChild(createStatusChip(job.status));
  card.appendChild(header);

  const meta = document.createElement("div");
  meta.className = "job-meta";
  appendMetaRow(meta, "Pfad", job.libraryPath || "–", { code: true });

  const queuePosition = Number.isFinite(job.queue_position) ? job.queue_position : "–";
  const progressValue = Number.isFinite(job.progress)
    ? `${Math.max(0, Math.min(100, job.progress))}%`
    : "0%";
  appendMetaRow(meta, "Warteschlange", `${queuePosition}`);
  appendMetaRow(meta, "Fortschritt", progressValue);
  appendMetaRow(meta, "Ausgabe", describeOutputs(job.outputs));
  appendMetaRow(meta, "Gestartet", formatDateTime(job.created_at));
  appendMetaRow(meta, "Nachricht", job.message || "–");

  if (Array.isArray(job.result?.messages) && job.result.messages.length) {
    appendMetaRow(meta, "Hinweise", job.result.messages.join(" · "));
  }

  card.appendChild(meta);

  const progress = document.createElement("div");
  progress.className = "job-progress";
  const progressInner = document.createElement("span");
  progressInner.style.width = progressValue;
  progress.appendChild(progressInner);
  card.appendChild(progress);

  return card;
}

function buildHistoryCard(entry) {
  const card = document.createElement("article");
  card.className = "history-card";

  const header = document.createElement("div");
  header.className = "history-card-header";
  const title = document.createElement("div");
  const titleStrong = document.createElement("strong");
  titleStrong.textContent = entry.lcscId || entry.id;
  title.appendChild(titleStrong);
  const titleSuffix = document.createElement("span");
  titleSuffix.textContent = ` · ${entry.libraryName || "Bibliothek"}`;
  title.appendChild(titleSuffix);
  header.appendChild(title);
  header.appendChild(createStatusChip(entry.status));
  card.appendChild(header);

  const meta = document.createElement("div");
  meta.className = "history-meta";
  appendMetaRow(meta, "Pfad", entry.libraryPath || "–", { code: true });
  appendMetaRow(meta, "Gestartet", formatDateTime(entry.created_at));
  appendMetaRow(meta, "Abgeschlossen", formatDateTime(entry.finished_at || entry.updated_at));
  appendMetaRow(meta, "Ausgabe", describeOutputs(entry.outputs || entry.result));
  appendMetaRow(meta, "Nachricht", entry.message || entry.result?.messages?.join(" · ") || "–");

  const outputs = entry.result?.model_paths || {};
  if (outputs && typeof outputs === "object" && Object.keys(outputs).length) {
    appendMetaRow(meta, "Modelle", Object.values(outputs).join(", "));
  }

  card.appendChild(meta);
  return card;
}

function getTimelineEntries() {
  const statusFilter = (state.historyFilter || "all").toLowerCase();
  const term = state.historySearchTerm.trim().toLowerCase();
  const activeJobs = Array.isArray(state.jobs) ? state.jobs : [];
  const historyEntries = Array.isArray(state.jobHistory) ? state.jobHistory : [];
  const seen = new Set();
  const entries = [];

  const matchesSearch = (raw) => {
    if (!term) {
      return true;
    }
    const haystack = [
      raw.lcscId,
      raw.lcsc_id,
      raw.libraryName,
      raw.libraryPath,
      raw.message,
      raw.id,
      ...(raw.result?.messages || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(term);
  };

  const pushEntry = (raw, source) => {
    if (!raw) {
      return;
    }
    const normalizedStatus = (raw.status || "").toLowerCase();
    if (statusFilter !== "all" && normalizedStatus !== statusFilter) {
      return;
    }
    if (!matchesSearch(raw)) {
      return;
    }
    const isActive = isActiveStatus(normalizedStatus);
    const createdTimestamp = dateToTimestamp(
      raw.created_at || raw.started_at || raw.updated_at || raw.finished_at,
    );
    const completedTimestamp = dateToTimestamp(
      raw.finished_at || raw.updated_at || raw.created_at || raw.started_at,
    );
    entries.push({
      source,
      raw,
      status: normalizedStatus,
      isActive,
      sortTimestamp: isActive ? createdTimestamp : completedTimestamp,
      secondaryTimestamp: completedTimestamp,
    });
  };

  activeJobs.forEach((job) => {
    const key = job?.id || job?.lcscId || job?.lcsc_id;
    if (key) {
      seen.add(key);
    }
    pushEntry(job, "active");
  });

  historyEntries.forEach((entry) => {
    const key = entry?.id || entry?.lcscId || entry?.lcsc_id;
    if (key && seen.has(key)) {
      return;
    }
    pushEntry(entry, "history");
  });

  entries.sort((a, b) => {
    if (a.isActive !== b.isActive) {
      return a.isActive ? -1 : 1;
    }
    if (b.sortTimestamp !== a.sortTimestamp) {
      return b.sortTimestamp - a.sortTimestamp;
    }
    return (b.secondaryTimestamp || 0) - (a.secondaryTimestamp || 0);
  });

  return entries;
}

function buildTimelineCard(entry) {
  return entry.source === "active" ? buildJobCard(entry.raw) : buildHistoryCard(entry.raw);
}

function isActiveStatus(status) {
  return status === "queued" || status === "running" || status === "pending";
}

function createStatusChip(status) {
  const chip = document.createElement("span");
  const normalized = (status || "queued").toLowerCase();
  chip.className = `status-chip status-${normalized}`;
  chip.textContent = normalized.toUpperCase();
  return chip;
}

function appendMetaRow(container, label, value, options = {}) {
  const row = document.createElement("div");
  row.className = "meta-row";
  const labelSpan = document.createElement("span");
  labelSpan.className = "meta-label";
  labelSpan.textContent = `${label}:`;
  row.appendChild(labelSpan);
  const resolvedValue =
    value === undefined || value === null || value === "" ? "–" : String(value);
  if (options.code) {
    const code = document.createElement("code");
    code.textContent = resolvedValue;
    row.appendChild(code);
  } else {
    const valueSpan = document.createElement("span");
    valueSpan.textContent = resolvedValue;
    row.appendChild(valueSpan);
  }
  container.appendChild(row);
}

function describeOutputs(outputs) {
  if (!outputs) {
    return "Symbol";
  }
  const flags = new Set();
  const sources = Array.isArray(outputs) ? outputs : [outputs];
  sources.forEach((source) => {
    if (!source || typeof source !== "object") {
      return;
    }
    if (source.symbol || source.generate_symbol || source.symbol_path) {
      flags.add("Symbol");
    }
    if (source.footprint || source.generate_footprint || source.footprint_path) {
      flags.add("Footprint");
    }
    const hasModel =
      source.model
      || source.generate_model
      || Boolean(source.model_paths && Object.keys(source.model_paths).length);
    if (hasModel) {
      flags.add("3D-Modell");
    }
  });
  return flags.size ? Array.from(flags).join(" · ") : "Keine Ausgaben";
}

function dateToTimestamp(value) {
  if (!value) {
    return 0;
  }
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function formatDateTime(value) {
  if (!value) {
    return "–";
  }
  try {
    return new Date(value).toLocaleString();
  } catch (error) {
    logDebug("Konnte Datum nicht formatieren", value, error);
    return value;
  }
}

async function bootstrap() {
  initElements();
  bindEvents();
  try {
    const initialState = await sendMessage("getState");
    applyState(initialState);
  } catch (error) {
    console.error("Konnte Zustand nicht laden", error);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "stateUpdate") {
    applyState(message.state);
  }
});

document.addEventListener("DOMContentLoaded", bootstrap);
