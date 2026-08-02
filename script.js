DRES_IP = 'http://192.168.28.151:5000/api';
// const APP_CONFIG = {
//     REMOTE_BASE_URL: 'https://aic.mealsretrieval.site',
//     WEBSOCKET_URL: 'wss://aic.mealsretrieval.site'
// };

const APP_CONFIG = {
    REMOTE_BASE_URL: 'http://localhost:16010',
    WEBSOCKET_URL: 'ws://localhost:16010'
};

// const APP_CONFIG = {
//     REMOTE_BASE_URL: '',
//     WEBSOCKET_URL: ''
// };


async function fetchDresJson(url) {
    const response = await fetch(url, {
        headers: { Accept: 'application/json' }
    });
    const contentType = response.headers.get('content-type') || '';
    const responseText = await response.text();

    if (!response.ok) {
        throw new Error(`DRES API Error ${response.status} at ${url}: ${responseText.slice(0, 300)}`);
    }

    if (!contentType.includes('application/json')) {
        throw new Error(`DRES returned non-JSON response at ${url}: ${responseText.slice(0, 300)}`);
    }

    return JSON.parse(responseText);
}


let zIndexCounter = 10000; // Bắt đầu từ một số lớn để tránh xung đột
const activeModalStack = [];

function registerModalOpen(modalElement, closeFunction) {
    zIndexCounter++;
    modalElement.style.zIndex = zIndexCounter;

    // Lưu lại thông tin modal và hàm đóng của nó
    activeModalStack.push({
        element: modalElement,
        close: closeFunction
    });
}

function registerModalClose(modalElement) {
    const index = activeModalStack.findIndex(modal => modal.element === modalElement);
    if (index > -1) {
        activeModalStack.splice(index, 1);
    }
}

function getTopActiveModal() {
    if (activeModalStack.length > 0) {
        return activeModalStack[activeModalStack.length - 1];
    }
    return null;
}

function isModalKeyboardActive() {
    if (getTopActiveModal()) {
        return true;
    }

    return Array.from(document.querySelectorAll('.image-modal, .video-modal, .vqa-modal, .mini-modal, .shortcuts-modal'))
        .some(modal => modal.style.display === 'flex');
}

function getNewTopZIndex() {
    zIndexCounter++;
    return zIndexCounter;
}

// Keeps the page usable if a stale HTML document loads a newer script.
function ensureClusterDeletionMarkup() {
    const headerButtons = document.querySelector('.header-buttons');
    const settingsButton = document.getElementById('settingsBtn');
    if (headerButtons && settingsButton && !document.getElementById('deletedClustersBtn')) {
        settingsButton.insertAdjacentHTML('beforebegin', `
            <button id="deletedClustersBtn" class="header-btn" title="Deleted clusters">
                <i class="fas fa-trash"></i>
            </button>
        `);
    }

    if (!document.getElementById('clusterDeletionConfirmModal')) {
        document.body.insertAdjacentHTML('beforeend', `
            <div id="clusterDeletionConfirmModal" class="mini-modal" style="display: none;">
                <div class="modal-overlay"></div>
                <div class="modal-content">
                    <button id="closeClusterDeletionConfirmBtn" class="close-btn">&times;</button>
                    <h3>Delete Cluster</h3>
                    <p id="clusterDeletionConfirmText"></p>
                    <div class="confirmation-buttons">
                        <button id="cancelClusterDeletionBtn" class="confirmation-btn cancel">No</button>
                        <button id="confirmClusterDeletionBtn" class="confirmation-btn confirm">Yes, delete cluster</button>
                    </div>
                </div>
            </div>
        `);
    }

    if (!document.getElementById('deletedClustersModal')) {
        document.body.insertAdjacentHTML('beforeend', `
            <div id="deletedClustersModal" class="image-modal" style="display: none;">
                <div class="modal-overlay"></div>
                <div class="modal-content cluster-deletion-modal">
                    <div class="modal-section-header">
                        <button id="deletedClustersBackBtn" class="queue-action-btn cancel-btn" style="display: none;">
                            <i class="fas fa-arrow-left"></i> Back
                        </button>
                        <h3 id="deletedClustersTitle">Deleted Clusters</h3>
                        <div class="modal-header-actions">
                            <button id="undoDeletedClusterBtn" class="queue-action-btn" style="display: none;">
                                <i class="fas fa-undo"></i> Undo
                            </button>
                            <button id="closeDeletedClustersBtn" class="queue-action-btn cancel-btn">
                                <i class="fas fa-times"></i> Close
                            </button>
                        </div>
                    </div>
                    <div id="deletedClustersContent" class="cluster-deletion-grid"></div>
                </div>
            </div>
        `);
    }
}

let allImages = [];

document.addEventListener('DOMContentLoaded', function () {
    ensureClusterDeletionMarkup();
    let searchIdCounter = 1;
    let currentUserId = null;
    let currentSearchMode = 'text-to-image';
    let currentHeaderFocus = null;
    let selectedQueueFrameIds = new Set();
    let isTranslationEnabled = localStorage.getItem('aic_translation_enabled') === 'true';
    let availableModels = [];
    let currentSelectedModel = 'all';
    let frameServeLocation = 'remote';
    let videoServeLocation = 'remote';
    let clusterModeEnabled = true;
    let pendingClusterDeletion = null;
    let activeDeletedClusterId = null;
    let highlightedModelIndex = -1; // -1 nghĩa là chưa có mục nào được highlight
    let submitQueueFrames = new Map();
    let lastClickedFrameId = null;
    let lastAddedFrameId = null;
    let currentlyHoveredPreviewFrameData = null;
    let isRestoringState = false;
    let currentLayout = 'grid';
    let isEventFilterEnabled = false;
    // Biến zcho layout Nhóm (Grouped)
    let allGroupedData = [];
    let displayedGroupsCount = 0;
    const GROUPS_PER_BATCH = 10;
    let hlsPlayerInstance = null;
    const mainContent = document.querySelector('.main-content');
    let isTrakeMode = false;
    let trakeQueueState = []; // Lưu trạng thái TRAKE queue từ server
    let currentVideoModalData = {}; // Lưu thông tin video đang mở
    const trakeFpsCache = new Map();
    const trakePendingMutations = new Map();
    const trakePendingClears = new Map();
    const trakeLocalThumbnailUrls = new Map();
    const trakeQueuedEvents = new Set();
    const trakeCapturePlaceholders = new Map();
    let trakeCaptureChain = Promise.resolve();
    const trakeController = {
        fps: null,
        ready: false,
        desiredFrameIndex: 0,
        renderedFrameIndex: 0,
        seekTimer: null,
        seekInFlight: false,
        seekGeneration: 0,
        waiters: []
    };
    let queuedFramesSet = new Set();
    let dresEvaluationId = null; // Biến để lưu evaluationId sau khi lấy được.
    let currentDresSessionId = null; // Biến để lưu session ID sẽ được sử dụng
    const DEFAULT_DRES_SESSION_ID = 'b-X-ZFRzfwNURvU_234NB6P2LvELU7LA';

    // let allImages = []; // Lưu trữ tất cả kết quả tìm kiếm
    let displayedImagesCount = 0; // Số lượng ảnh đã hiển thị

    let currentUser = null;
    let ws = null;
    let currentResultsAreReranked = false;
    let wsRetryDelayMs = 3000;
    let userColors = {}; // Lưu màu của tất cả user

    let metadataCache = new Map();
    let isGoogleSearchMode = false;
    let googleSearchRequestId = 0;
    let lastGoogleSearchQuery = '';
    const googleSearchCache = new Map();
    const googleImageSearchCache = new Map();
    const googleImageSearchInFlight = new Map();
    const googleSummaryCache = new Map();
    const googleSummaryInFlight = new Map();
    let googleAiSummaryEnabled = true;
    let hoveredGoogleImage = null;
    const GOOGLE_SEARCH_COUNTRY = 'vn';
    const GOOGLE_SEARCH_LANGUAGE = 'vi';
    const GOOGLE_IMAGE_RESULT_COUNT = 10;
    const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
    const GEMINI_SUMMARY_MODEL = 'gemini-3.1-flash-lite';
    const GOOGLE_SUMMARY_SOURCE_LIMIT = 8;

    const IMAGES_PER_BATCH = 60; // Số lượng ảnh hiển thị mỗi lần
    let isLoading = false; // Flag để kiểm tra đang tải thêm ảnh hay không
    let hasReachedEnd = false; // Flag để kiểm tra đã đến cuối danh sách chưa

    let formSubmitQueue = [];
    let formSubmitLockedVideoId = null;
    let isFormSubmitMode = false; // Mặc định là chế độ cộng tác
    let wrongSubmissionIds = new Set();
    let draggedItem = null; // Biến để theo dõi item đang được kéo
    let currentlyHoveredFormQueueFrameData = null;
    let currentlyTargetedTrakeFrameData = null;
    let resolveInitialStatePromise;
    const initialStateReady = new Promise(resolve => {
        resolveInitialStatePromise = resolve;
    });

    const MODAL_IMAGES_PER_BATCH = 60; // Số ảnh tải mỗi đợt trong modal
    let modalAllImages = [];
    let modalDisplayedImagesCount = 0;
    let isModalLoading = false;
    let modalHasReachedEnd = false;
    let modalObserver = null;
    let modalCurrentLayout = 'grid'; // 'grid' hoặc 'grouped'
    let modalAllGroupedData = [];
    let modalDisplayedGroupsCount = 0;
    const MODAL_GROUPS_PER_BATCH = 10;
    let modalQueryFrame = null;
    // Elements
    const textToImageBtn = document.getElementById('textToImageBtn');
    const imageToImageBtn = document.getElementById('imageToImageBtn');
    const translateBtn = document.getElementById('translateBtn');
    const searchInputsContainer = document.getElementById('searchInputsContainer');
    const contentArea = document.getElementById('contentArea');
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsMenu = document.getElementById('settingsMenu');
    const tagFilterBtn = document.getElementById('tagFilterBtn');
    const shortcutsBtn = document.getElementById('shortcutsBtn');
    const shortcutsModal = document.getElementById('shortcutsModal');
    const closeShortcutsModalBtn = shortcutsModal.querySelector('.close-btn');
    const shortcutsOverlay = shortcutsModal.querySelector('.modal-overlay');
    const toggleLayoutBtn = document.getElementById('toggleLayoutBtn');
    const submitQueueContainer = document.getElementById('submitQueue');
    const submitQueueFramesContainer = document.getElementById('submitQueueFrames');
    const clearQueueBtn = document.getElementById('clearQueueBtn');
    const queueCountSpan = document.getElementById('queueCount');
    const ocrFilterBtn = document.getElementById('ocrFilterBtn');
    const asrFilterBtn = document.getElementById('asrFilterBtn');
    const eventFilterBtn = document.getElementById('eventFilterBtn');

    const submitAsQaBtn = document.getElementById('submitAsQaBtn');
    const submitAsKisBtn = document.getElementById('submitAsKisBtn');

    const qaInputModal = document.getElementById('qaInputModal');
    const qaInputForm = document.getElementById('qaInputForm');
    const qaAnswerTextInput = document.getElementById('qaAnswerTextInput');
    const qaInputModalCloseBtn = qaInputModal.querySelector('.close-btn');
    const qaInputModalOverlay = qaInputModal.querySelector('.modal-overlay');

    const historyBtn = document.getElementById('historyBtn');
    const historyMenu = document.getElementById('historyMenu');
    const historyListContainer = document.getElementById('historyListContainer');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');

    const keyframePreviewBar = document.getElementById('keyframePreviewBar');
    const previewThumbnails = document.getElementById('previewThumbnails');
    const previewPlaceholder = document.getElementById('previewPlaceholder');
    const closePreviewBarBtn = document.getElementById('closePreviewBarBtn');
    const header = document.querySelector('.header');

    const formSubmitQueueContainer = document.getElementById('formSubmitQueue');
    const formSubmitQueueFramesContainer = document.getElementById('formSubmitQueueFrames');
    const formSubmitText = document.getElementById('formSubmitText');
    const formSubmitFilename = document.getElementById('formSubmitFilename');
    const formSubmitBtn = document.getElementById('formSubmitBtn');
    const clearFormSubmitQueueBtn = document.getElementById('clearFormSubmitQueueBtn');
    const toggleQueueModeBtn = document.getElementById('toggleQueueModeBtn');

    const videoModal = document.getElementById('videoModal'); // Lấy modal chính
    const trakeStatusBar = document.getElementById('trakeStatusBar');
    const trakeFrameStepInput = document.getElementById('trakeFrameStep');
    const trakeFrameIndex = document.getElementById('trakeFrameIndex');
    const trakeFrameTimestamp = document.getElementById('trakeFrameTimestamp');
    const trakeFpsStatus = document.getElementById('trakeFpsStatus');
    const trakeSubmitQueueContainer = document.getElementById('trakeSubmitQueue');
    const trakeSubmitQueueFramesContainer = document.getElementById('trakeSubmitQueueFrames');
    const submitTrakeBtn = document.getElementById('submitTrakeBtn');
    const dresSessionIdInput = document.getElementById('dresSessionIdInput');
    const frameServeLocationToggle = document.getElementById('frameServeLocationToggle');
    const frameServeLocationLabel = document.getElementById('frameServeLocationLabel');
    const videoServeLocationToggle = document.getElementById('videoServeLocationToggle');
    const videoServeLocationLabel = document.getElementById('videoServeLocationLabel');
    const clusterModeToggle = document.getElementById('clusterModeToggle');
    const clusterModeLabel = document.getElementById('clusterModeLabel');
    const deletedClustersBtn = document.getElementById('deletedClustersBtn');
    const clusterDeletionConfirmModal = document.getElementById('clusterDeletionConfirmModal');
    const clusterDeletionConfirmText = document.getElementById('clusterDeletionConfirmText');
    const closeClusterDeletionConfirmBtn = document.getElementById('closeClusterDeletionConfirmBtn');
    const cancelClusterDeletionBtn = document.getElementById('cancelClusterDeletionBtn');
    const confirmClusterDeletionBtn = document.getElementById('confirmClusterDeletionBtn');
    const deletedClustersModal = document.getElementById('deletedClustersModal');
    const deletedClustersContent = document.getElementById('deletedClustersContent');
    const deletedClustersTitle = document.getElementById('deletedClustersTitle');
    const deletedClustersBackBtn = document.getElementById('deletedClustersBackBtn');
    const undoDeletedClusterBtn = document.getElementById('undoDeletedClusterBtn');
    const closeDeletedClustersBtn = document.getElementById('closeDeletedClustersBtn');
    // ADD THESE TWO NEW FUNCTIONS INSIDE the DOMContentLoaded listener

    const applyDresSessionBtn = document.getElementById('applyDresSessionBtn');
    const evaluationModal = document.getElementById('evaluationSelectionModal');
    const evaluationListContainer = document.getElementById('evaluationListContainer');
    const closeEvaluationModalBtn = evaluationModal.querySelector('.close-btn');
    const evaluationModalOverlay = evaluationModal.querySelector('.modal-overlay');

    const semanticSearchModal = document.getElementById('semanticSearchModal');
    const closeSemanticSearchModalBtn = document.getElementById('closeSemanticSearchModalBtn');
    const semanticSearchResultsContainer = document.getElementById('semanticSearchResultsContainer');
    const normalSearchPanel = document.getElementById('normalSearchPanel');
    const googleSearchPanel = document.getElementById('googleSearchPanel');
    const googleSearchForm = document.getElementById('googleSearchForm');
    const googleSearchInput = document.getElementById('googleSearchInput');
    const googleSearchPanelState = document.getElementById('googleSearchPanelState');
    const googleSearchResults = document.getElementById('googleSearchResults');
    const serperApiKeyInput = document.getElementById('serperApiKeyInput');
    const saveSerperApiKeyBtn = document.getElementById('saveSerperApiKeyBtn');
    const geminiApiKeyInput = document.getElementById('geminiApiKeyInput');
    const saveGeminiApiKeyBtn = document.getElementById('saveGeminiApiKeyBtn');
    const googleAiSummaryToggle = document.getElementById('googleAiSummaryToggle');
    const googleAiSummaryLabel = document.getElementById('googleAiSummaryLabel');

    initializeEventListeners();
    function getOrCreateUserId() {
        let userId = localStorage.getItem('aic_lunch_user_id');
        if (!userId) {
            // Tạo một ID đơn giản nhưng đủ duy nhất cho mục đích session
            userId = 'user-' + Date.now() + '-' + Math.random().toString(36).substring(2, 9);
            localStorage.setItem('aic_lunch_user_id', userId);
        }
        return userId;
    }

    function getUserScopedStorageKey(key) {
        const userScope = currentUser || currentUserId || getOrCreateUserId();
        return `aic_lunch:${userScope}:${key}`;
    }

    function getUserScopedSetting(key, fallback = null, legacyKey = null) {
        const scopedValue = localStorage.getItem(getUserScopedStorageKey(key));
        if (scopedValue !== null) return scopedValue;

        // One-time compatibility for values saved before settings were user-scoped.
        if (legacyKey) {
            const legacyValue = localStorage.getItem(legacyKey);
            if (legacyValue !== null) return legacyValue;
        }

        return fallback;
    }

    function setUserScopedSetting(key, value) {
        localStorage.setItem(getUserScopedStorageKey(key), value);
    }

    function getFrameUrl(videoName, frameName) {
        const baseUrl = frameServeLocation === 'remote' ? APP_CONFIG.REMOTE_BASE_URL : '';
        return `${baseUrl}/frames/${encodeURIComponent(videoName)}/${encodeURIComponent(frameName)}`;
    }

    function getFrameMetadataUrl(videoName, cacheBuster = '') {
        return `${getFrameUrl(videoName, 'metadata.json')}${cacheBuster}`;
    }

    function resolveFrameUrl(path) {
        if (!path || path.startsWith('data:') || path.startsWith('blob:')) return path;

        try {
            const url = new URL(path, window.location.origin);
            if (!url.pathname.startsWith('/frames/')) return path;

            const baseUrl = frameServeLocation === 'remote' ? APP_CONFIG.REMOTE_BASE_URL : '';
            return `${baseUrl}${url.pathname}${url.search}`;
        } catch {
            return path;
        }
    }

    function setFrameImageSource(imageElement, path) {
        imageElement.dataset.frameSource = path;
        imageElement.src = resolveFrameUrl(path);
    }

    function updateFrameServeLocationUI() {
        const remoteServeEnabled = frameServeLocation === 'remote';
        frameServeLocationToggle.checked = remoteServeEnabled;
        frameServeLocationLabel.textContent = remoteServeEnabled ? 'Remote serve' : 'Local serve';
    }

    function updateVideoServeLocationUI() {
        const remoteServeEnabled = videoServeLocation === 'remote';
        videoServeLocationToggle.checked = remoteServeEnabled;
        videoServeLocationLabel.textContent = remoteServeEnabled ? 'Remote HLS' : 'Local MP4';
    }

    function updateClusterModeUI() {
        clusterModeToggle.checked = clusterModeEnabled;
        clusterModeLabel.textContent = clusterModeEnabled ? 'Enabled' : 'Disabled';
    }

    async function fetchClusterApi(path, options = {}) {
        const response = await fetch(`${APP_CONFIG.REMOTE_BASE_URL}${path}`, options);
        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.detail || `Cluster API failed with status ${response.status}`);
        }
        return response.json();
    }

    function openClusterModal(modal, closeFunction) {
        modal.style.zIndex = getNewTopZIndex();
        modal.style.display = 'flex';
        registerModalOpen(modal, closeFunction);
        setTimeout(() => modal.classList.add('visible'), 10);
    }

    function closeClusterDeletionConfirmation() {
        pendingClusterDeletion = null;
        clusterDeletionConfirmModal.classList.remove('visible');
        registerModalClose(clusterDeletionConfirmModal);
        setTimeout(() => (clusterDeletionConfirmModal.style.display = 'none'), 200);
    }

    function openClusterDeletionConfirmation(cluster) {
        pendingClusterDeletion = cluster;
        clusterDeletionConfirmText.textContent = `Delete cluster ${cluster.cluster_id}? This removes ${cluster.count} frame(s) from future searches for every user while cluster filtering is enabled.`;
        openClusterModal(clusterDeletionConfirmModal, closeClusterDeletionConfirmation);
    }

    async function requestClusterDeletion(frame) {
        if (!frame.frame_specify) {
            showToastNotification('Frame is missing the cluster lookup identifier.', 'error');
            return;
        }

        try {
            const result = await fetchClusterApi('/api/clusters/resolve-frame', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ frame_specify: frame.frame_specify })
            });

            if (!result.found) {
                showToastNotification('Frame không thuộc cluster nào.', 'info');
                return;
            }
            if (result.already_deleted) {
                showToastNotification(`Cluster ${result.cluster_id} is already deleted globally.`, 'info');
                return;
            }
            openClusterDeletionConfirmation(result);
        } catch (error) {
            console.error('Failed to resolve frame cluster:', error);
            showToastNotification('Không thể kiểm tra cluster của frame.', 'error');
        }
    }

    async function confirmClusterDeletion() {
        if (!pendingClusterDeletion) return;

        confirmClusterDeletionBtn.disabled = true;
        try {
            const result = await fetchClusterApi('/api/clusters/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cluster_id: pendingClusterDeletion.cluster_id })
            });
            closeClusterDeletionConfirmation();
            frameSelectionManager.clearAllSelections();
            showToastNotification(
                result.added
                    ? `Cluster ${result.cluster.cluster_id} deleted globally.`
                    : `Cluster ${result.cluster.cluster_id} was already deleted globally.`,
                'success'
            );
        } catch (error) {
            console.error('Failed to delete cluster:', error);
            showToastNotification('Không thể xóa cluster.', 'error');
        } finally {
            confirmClusterDeletionBtn.disabled = false;
        }
    }

    function closeDeletedClustersModal() {
        activeDeletedClusterId = null;
        deletedClustersModal.classList.remove('visible');
        registerModalClose(deletedClustersModal);
        setTimeout(() => (deletedClustersModal.style.display = 'none'), 200);
    }

    function createClusterImage(frame) {
        const image = document.createElement('img');
        image.src = resolveFrameUrl(frame.path);
        image.alt = frame.frame_specify;
        image.loading = 'lazy';
        return image;
    }

    async function renderDeletedClusterList() {
        activeDeletedClusterId = null;
        deletedClustersTitle.textContent = 'Deleted Clusters';
        deletedClustersBackBtn.style.display = 'none';
        undoDeletedClusterBtn.style.display = 'none';
        deletedClustersContent.replaceChildren();

        try {
            const result = await fetchClusterApi('/api/clusters/deleted');
            if (result.clusters.length === 0) {
                const emptyState = document.createElement('p');
                emptyState.className = 'cluster-empty-state';
                emptyState.textContent = 'No clusters have been deleted.';
                deletedClustersContent.appendChild(emptyState);
                return;
            }

            result.clusters.forEach(cluster => {
                const card = document.createElement('button');
                card.type = 'button';
                card.className = 'deleted-cluster-card';
                card.appendChild(createClusterImage(cluster.representative));

                const clusterId = document.createElement('strong');
                clusterId.textContent = `Cluster ${cluster.cluster_id}`;
                const count = document.createElement('span');
                count.textContent = `${cluster.count} frame(s)`;
                card.append(clusterId, count);
                card.addEventListener('click', () => renderDeletedClusterDetail(cluster.cluster_id));
                deletedClustersContent.appendChild(card);
            });
        } catch (error) {
            console.error('Failed to load deleted clusters:', error);
            const emptyState = document.createElement('p');
            emptyState.className = 'cluster-empty-state';
            emptyState.textContent = 'Unable to load deleted clusters.';
            deletedClustersContent.appendChild(emptyState);
        }
    }

    async function renderDeletedClusterDetail(clusterId) {
        deletedClustersContent.replaceChildren();
        const loading = document.createElement('p');
        loading.className = 'cluster-empty-state';
        loading.textContent = 'Loading cluster frames...';
        deletedClustersContent.appendChild(loading);

        try {
            const cluster = await fetchClusterApi(`/api/clusters/${encodeURIComponent(clusterId)}`);
            activeDeletedClusterId = cluster.cluster_id;
            deletedClustersTitle.textContent = `Cluster ${cluster.cluster_id} (${cluster.count} frames)`;
            deletedClustersBackBtn.style.display = 'inline-flex';
            undoDeletedClusterBtn.style.display = 'inline-flex';
            deletedClustersContent.replaceChildren();

            cluster.frames.forEach(frame => {
                const card = document.createElement('div');
                card.className = 'cluster-member-card';
                card.appendChild(createClusterImage(frame));
                const label = document.createElement('span');
                label.textContent = frame.frame_specify;
                card.appendChild(label);
                deletedClustersContent.appendChild(card);
            });
        } catch (error) {
            console.error('Failed to load deleted cluster detail:', error);
            showToastNotification('Không thể tải danh sách frame của cluster.', 'error');
            renderDeletedClusterList();
        }
    }

    async function openDeletedClustersModal() {
        if (deletedClustersModal.style.display !== 'flex') {
            openClusterModal(deletedClustersModal, closeDeletedClustersModal);
        }
        await renderDeletedClusterList();
    }

    async function undoActiveDeletedCluster() {
        if (!activeDeletedClusterId) return;

        try {
            const result = await fetchClusterApi('/api/clusters/undo', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cluster_id: activeDeletedClusterId })
            });
            showToastNotification(
                result.removed
                    ? `Cluster ${activeDeletedClusterId} restored.`
                    : `Cluster ${activeDeletedClusterId} was already restored.`,
                'success'
            );
            await renderDeletedClusterList();
        } catch (error) {
            console.error('Failed to undo cluster deletion:', error);
            showToastNotification('Không thể undo cluster.', 'error');
        }
    }

    function refreshVisibleFrameSources() {
        document.querySelectorAll('img[data-frame-source]').forEach(image => {
            image.src = resolveFrameUrl(image.dataset.frameSource);
        });
    }

    function setupUnloadHandler() {
        window.addEventListener('pagehide', function () {
            if (currentUserId) {
                const formData = new FormData();
                formData.append('user_id', currentUserId);
                // Dùng sendBeacon để đảm bảo request được gửi đi ngay cả khi trang đang đóng
                navigator.sendBeacon(`${APP_CONFIG.REMOTE_BASE_URL}/api/session/cleanup`, formData);
            }
        });
    }

    // Initialize
    function initializeEventListeners() {

        currentUserId = getOrCreateUserId(); // <<< THÊM VÀO
        currentUser = getUsername();
        const savedFrameServeLocation = getUserScopedSetting('frame_serve_location', 'remote');
        frameServeLocation = savedFrameServeLocation === 'local' ? 'local' : 'remote';
        updateFrameServeLocationUI();
        const savedVideoServeLocation = getUserScopedSetting('video_serve_location', 'remote');
        videoServeLocation = savedVideoServeLocation === 'local' ? 'local' : 'remote';
        updateVideoServeLocationUI();
        clusterModeEnabled = getUserScopedSetting('cluster_mode_enabled', 'true') !== 'false';
        updateClusterModeUI();
        setupUnloadHandler();

        frameServeLocationToggle.addEventListener('change', () => {
            frameServeLocation = frameServeLocationToggle.checked ? 'remote' : 'local';
            setUserScopedSetting('frame_serve_location', frameServeLocation);
            updateFrameServeLocationUI();
            refreshVisibleFrameSources();
            if (currentVideoModalData.videoName) {
                prepareTrakeTimeline(currentVideoModalData.videoName, document.getElementById('videoPlayer').currentTime);
            }
            showToastNotification(`Frame source: ${frameServeLocation === 'remote' ? 'Remote serve' : 'Local serve'}.`);
        });

        videoServeLocationToggle.addEventListener('change', () => {
            videoServeLocation = videoServeLocationToggle.checked ? 'remote' : 'local';
            setUserScopedSetting('video_serve_location', videoServeLocation);
            updateVideoServeLocationUI();
            showToastNotification(`Video source: ${videoServeLocation === 'remote' ? 'Remote HLS' : 'Local MP4'}.`);
        });

        clusterModeToggle.addEventListener('change', () => {
            clusterModeEnabled = clusterModeToggle.checked;
            setUserScopedSetting('cluster_mode_enabled', String(clusterModeEnabled));
            updateClusterModeUI();
            showToastNotification(`Cluster filtering ${clusterModeEnabled ? 'enabled' : 'disabled'} for new searches.`);
        });

        deletedClustersBtn.addEventListener('click', openDeletedClustersModal);
        closeClusterDeletionConfirmBtn.addEventListener('click', closeClusterDeletionConfirmation);
        cancelClusterDeletionBtn.addEventListener('click', closeClusterDeletionConfirmation);
        confirmClusterDeletionBtn.addEventListener('click', confirmClusterDeletion);
        clusterDeletionConfirmModal.querySelector('.modal-overlay').addEventListener('click', closeClusterDeletionConfirmation);
        closeDeletedClustersBtn.addEventListener('click', closeDeletedClustersModal);
        deletedClustersModal.querySelector('.modal-overlay').addEventListener('click', closeDeletedClustersModal);
        deletedClustersBackBtn.addEventListener('click', renderDeletedClusterList);
        undoDeletedClusterBtn.addEventListener('click', undoActiveDeletedCluster);

        currentDresSessionId = getUserScopedSetting('dres_session_id', DEFAULT_DRES_SESSION_ID, 'dres_session_id');
        dresEvaluationId = getUserScopedSetting('dres_evaluation_id', null, 'dres_evaluation_id'); // Tải evaluationId đã chọn
        if (serperApiKeyInput) {
            serperApiKeyInput.value = getUserScopedSetting('serper_api_key', '');
        }
        if (geminiApiKeyInput) {
            geminiApiKeyInput.value = getUserScopedSetting('gemini_api_key', '');
        }
        googleAiSummaryEnabled = getUserScopedSetting('google_ai_summary_enabled', 'true') !== 'false';
        updateGoogleAiSummaryUI();

        if (dresSessionIdInput) {
            dresSessionIdInput.value = currentDresSessionId;
        }

        // Thay đổi event listener từ 'input' sang 'click' trên nút Apply
        if (applyDresSessionBtn) {
            applyDresSessionBtn.addEventListener('click', handleApplyDresSession);
        }

        // Thêm event listener để đóng modal evaluation
        if (closeEvaluationModalBtn) {
            closeEvaluationModalBtn.addEventListener('click', closeEvaluationModal);
            evaluationModalOverlay.addEventListener('click', closeEvaluationModal);
            if (closeSemanticSearchModalBtn) {
                closeSemanticSearchModalBtn.addEventListener('click', closeSemanticSearchModal);
                semanticSearchModal.querySelector('.modal-overlay').addEventListener('click', closeSemanticSearchModal);
            }
        }

        googleSearchForm.addEventListener('submit', handleGoogleSearchSubmit);
        saveSerperApiKeyBtn.addEventListener('click', saveSerperApiKey);
        saveGeminiApiKeyBtn.addEventListener('click', saveGeminiApiKey);
        googleAiSummaryToggle.addEventListener('change', () => {
            googleAiSummaryEnabled = googleAiSummaryToggle.checked;
            setUserScopedSetting('google_ai_summary_enabled', String(googleAiSummaryEnabled));
            updateGoogleAiSummaryUI();
            refreshVisibleGoogleSearchResults();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Tab' || !e.shiftKey) return;
            if (isModalKeyboardActive() && !isGoogleSearchMode) return;

            e.preventDefault();
            e.stopImmediatePropagation();
            setGoogleSearchMode(!isGoogleSearchMode);
        }, true);

        document.addEventListener('keydown', (e) => {
            if (e.repeat || e.key.toLowerCase() !== 's' || !hoveredGoogleImage || isModalKeyboardActive()) return;

            e.preventDefault();
            e.stopImmediatePropagation();
            openGoogleImageSemanticSearch(hoveredGoogleImage);
        }, true);


        const savedModel = getUserScopedSetting('selected_model', null, 'user_selected_model');
        if (savedModel) {
            currentSelectedModel = savedModel;
        } else {
            currentSelectedModel = 'all'; // Giá trị mặc định nếu chưa có gì được lưu
        }

        setupKeyboardNavigation();
        connectWebSocket();

        // Prevent right-click context menu
        document.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            return false;
        });
        // Lấy danh sách model từ API khi trang tải
        fetchAvailableModels();

        settingsBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Ngăn sự kiện click lan ra document
            toggleSettingsMenu();
        });

        // Header search mode buttons
        textToImageBtn.addEventListener('click', function () {
            switchSearchMode('text-to-image');
        });

        if (toggleLayoutBtn) {
            toggleLayoutBtn.addEventListener('click', toggleLayout);
        }

        imageToImageBtn.addEventListener('click', function () {
            switchSearchMode('image-to-image');
        });

        window.addEventListener('popstate', (event) => {
            // Chỉ xử lý nếu có state hợp lệ do chúng ta tạo ra
            if (event.state && event.state.description === 'AIC_LUNCH_SEARCH') {
                // Đặt cờ để hàm restore không đẩy state mới vào history
                isRestoringState = true;

                restoreStateFromHistory(event.state).finally(() => {
                    // Sau khi khôi phục xong, reset cờ
                    isRestoringState = false;
                });
            } else {
                // Nếu người dùng back về trạng thái ban đầu (không có state),
                // có thể xóa kết quả để giao diện sạch sẽ.
                contentArea.innerHTML = '<div class="content-placeholder"><h2>RESULTS</h2></div>';
                searchInputsContainer.innerHTML = '';
                createNewSearchInput(); // Tạo lại một thanh tìm kiếm trống
            }
        });

        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                const topModal = getTopActiveModal();
                if (topModal) {
                    if (topModal.element === semanticSearchModal) {
                        return;
                    }

                    // Ngăn chặn các trình xử lý khác bắt được sự kiện này
                    e.preventDefault();
                    e.stopPropagation();

                    // Gọi hàm đóng của modal trên cùng
                    topModal.close();
                }
            }
        }, true);

        const modalToggleLayoutBtn = document.getElementById('modalToggleLayoutBtn');
        if (modalToggleLayoutBtn) {
            modalToggleLayoutBtn.addEventListener('click', toggleModalLayout);
        }

        ocrFilterBtn.addEventListener('click', function () {
            toggleFilter('ocr');
        });

        tagFilterBtn.addEventListener('click', function () {
            toggleFilter('tag');
        });

        asrFilterBtn.addEventListener('click', function () {
            toggleFilter('asr');
        });

        if (eventFilterBtn) { // <<< THÊM KHỐI LỆNH NÀY
            eventFilterBtn.addEventListener('click', function () {
                isEventFilterEnabled = !isEventFilterEnabled;
                this.classList.toggle('active', isEventFilterEnabled);
                const status = isEventFilterEnabled ? 'bật' : 'tắt';
                showToastNotification(`Bộ lọc sự kiện đã ${status}`, 'success');
            });
        }

        clearHistoryBtn.addEventListener('click', clearSearchHistory);
        historyBtn.addEventListener('click', toggleHistoryMenu);


        trakeFrameStepInput.addEventListener('change', () => {
            const frameStep = Math.max(1, Math.min(100, parseInt(trakeFrameStepInput.value, 10) || 1));
            trakeFrameStepInput.value = frameStep;
            setUserScopedSetting('trake_frame_step', String(frameStep));
        });

        document.addEventListener('click', function (e) {
            // Kiểm tra xem có frame nào đang được chọn trong queue không
            if (selectedQueueFrameIds.size > 0) {
                // Nếu click vào một nơi KHÔNG phải là queue, thì bỏ chọn
                // Chúng ta cũng không muốn bỏ chọn khi click vào một frame trong kết quả tìm kiếm
                if (!e.target.closest('#submitQueue') && !e.target.closest('.image-item')) {
                    clearQueueSelection();
                }
            }
        }, true);

        // Gắn sự kiện cho nút submit của TRAKE queue
        submitTrakeBtn.addEventListener('click', async () => {
            if (trakeQueueState) {
                const success = await submitTrakeToDres(trakeQueueState);

                if (success) {
                    sendWebSocketMessage('clear_trake_queue', {});
                    showToastNotification('TRAKE submission thành công!', 'success');
                }
            }
        });

        // Đóng các menu thả xuống khi click ra ngoài
        document.addEventListener('click', function (e) {
            if (historyMenu.classList.contains('visible') && !historyMenu.contains(e.target) && !historyBtn.contains(e.target)) {
                closeHistoryMenu();
            }
            // Bạn đã có sẵn logic này cho settingsMenu, đây là để đảm bảo nó vẫn hoạt động
            if (settingsMenu.classList.contains('visible') && !settingsMenu.contains(e.target) && !settingsBtn.contains(e.target)) {
                settingsMenu.classList.remove('visible');
            }
        });

        // Xử lý việc click vào một mục lịch sử
        historyListContainer.addEventListener('click', function (e) {
            const historyItem = e.target.closest('.history-item');
            if (historyItem) {
                const query = historyItem.dataset.query;

                copyQueryToClipboard(query)
                    .then(() => {
                        showToastNotification(`Đã sao chép: "${query}"`, 'success');
                        closeHistoryMenu();
                    })
                    .catch(err => {
                        console.error('Lỗi khi sao chép: ', err);
                        showToastNotification('Không thể sao chép!', 'error');
                    });
            }
        });

        submitQueueFramesContainer.addEventListener('contextmenu', e => {
            e.preventDefault(); // Luôn luôn ngăn menu mặc định
            const frameItem = e.target.closest('.queue-frame-item');
            if (!frameItem) return;

            const frameId = frameItem.dataset.frameId;
            const frameData = submitQueueFrames.get(frameId);

            check_timestamp = frameData.timestamp;
            if (check_timestamp === undefined) {
                const fps = getFpsForVideo(frameData.videoName, parseInt(frameData.frame_id_ori, 10));
                const totalSeconds = frameData.frame_id_ori / fps;
                const minutes = Math.floor(totalSeconds / 60);
                const seconds = (totalSeconds % 60).toFixed(3);

                // format minutes: 2 chữ số, seconds: ít nhất 6 ký tự với 3 số thập phân
                check_timestamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(6, '0')}`;
            }


            if (frameData && frameData.videoName && check_timestamp) {
                openVideoModal(frameData.videoName, check_timestamp);
                console.log("frame info", frameData);
            } else {
                console.warn("Missing videoName or timestamp for this queued frame.", frameData);
                showToastNotification("Không đủ thông tin để mở video.", "error");
            }
        });


        if (shortcutsBtn && shortcutsModal) {
            // Hàm để mở modal
            const openShortcutsModal = () => {
                shortcutsModal.style.zIndex = getNewTopZIndex();
                shortcutsModal.style.display = 'flex';
                setTimeout(() => shortcutsModal.classList.add('visible'), 10); // Thêm class để kích hoạt animation
            };

            // Hàm để đóng modal
            const closeShortcutsModal = () => {
                shortcutsModal.classList.remove('visible');
                // Đợi animation kết thúc rồi mới ẩn đi
                setTimeout(() => (shortcutsModal.style.display = 'none'), 300);
            };

            // Gán sự kiện khi click vào nút trên header
            shortcutsBtn.addEventListener('click', openShortcutsModal);

            // Gán sự kiện cho nút X
            closeShortcutsModalBtn.addEventListener('click', closeShortcutsModal);

            // Gán sự kiện khi click vào vùng nền mờ
            shortcutsOverlay.addEventListener('click', closeShortcutsModal);
        }

        const modalClearSelectionBtn = document.getElementById('modalClearSelectionBtn');
        if (modalClearSelectionBtn) {
            modalClearSelectionBtn.addEventListener('click', () => {
                modalFrameSelectionManager.clearAllSelections();
            });
        }

        document.addEventListener('keydown', function (e) {
            if (isModalKeyboardActive()) {
                return;
            }

            if (e.key === 'Tab') {
                // === THÊM KHỐI KIỂM TRA NÀY VÀO ĐẦU ===
                // Nếu modal semantic search đang mở, không làm gì cả và thoát ngay lập tức.
                if (semanticSearchModal && semanticSearchModal.style.display === 'flex') {
                    return;
                }
                // ===========================================

                const videoModal = document.getElementById('videoModal');
                if (videoModal && videoModal.style.display === 'flex') {
                    return;
                }

                const activeElement = document.activeElement;
                const isTyping = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';

                if (!isTyping) {
                    e.preventDefault();
                    toggleLayout();
                }
            }
            if (e.altKey && e.key.toLowerCase() === '1') {
                e.preventDefault();
                toggleTranslation(); // Call the same toggle function
            }
            if (e.key === 'F4') { // <<< THAY ĐỔI LOGIC F4
                e.preventDefault();
                if (eventFilterBtn) eventFilterBtn.click(); // Kích hoạt Event Filter
            }
            else if (e.key === 'F2') {
                e.preventDefault();
                toggleFilter('tag');
            }
            else if (e.key === 'F1') {
                e.preventDefault();
                toggleFilter('ocr');
            }
            else if (e.key === 'F3') {
                e.preventDefault();
                toggleFilter('asr');
            }
            else if (e.key === 'F9') {
                e.preventDefault();
                if (settingsBtn) settingsBtn.click(); // hoặc toggleSettingsMenu();
            }
            else if (e.key === 'F10') {
                e.preventDefault();
                // Nếu modal đang mở thì đóng lại, nếu không thì mở ra
                if (vqaModal.classList.contains('visible')) {
                    closeVqaModal();
                } else {
                    openVqaModal();
                }
            }
            else if (e.altKey && e.key.toLowerCase() === 's') {
                e.preventDefault();
                const searchInput = document.querySelector('.search-input');

                // 3. Kiểm tra xem ô tìm kiếm có tồn tại và không bị ẩn không
                // (Điều này quan trọng khi đang ở chế độ image-to-image)
                if (searchInput && searchInput.style.display !== 'none') {
                    // 4. Focus vào ô tìm kiếm
                    searchInput.focus();
                }
            }
        });

        document.addEventListener('click', () => {
            if (settingsMenu.classList.contains('visible')) {
                settingsMenu.classList.remove('visible');
            }
        });

        settingsMenu.addEventListener('click', (e) => {
            e.stopPropagation();
            if (e.target && e.target.tagName === 'LI') {
                const modelName = e.target.dataset.model;
                selectModel(modelName);
                settingsMenu.classList.remove('visible');
            }
        });

        translateBtn.classList.toggle('active', isTranslationEnabled);
        function toggleTranslation() {
            isTranslationEnabled = !isTranslationEnabled;
            translateBtn.classList.toggle('active', isTranslationEnabled);
            localStorage.setItem('aic_translation_enabled', isTranslationEnabled); // Save state

            const status = isTranslationEnabled ? 'bật' : 'tắt';
            showToastNotification(`Chế độ dịch gợi ý đã ${status}`, 'success');
        }
        translateBtn.addEventListener('click', toggleTranslation);
        // Initial search input setup
        setupSearchInput(document.querySelector('.search-input-group'));

        setupToolbarEvents();

        submitQueueFramesContainer.addEventListener('click', (e) => {
            const removeBtn = e.target.closest('.remove-queue-item-btn');
            if (removeBtn) {
                const frameId = removeBtn.dataset.frameId;
                // Lấy lại đầy đủ thông tin frame để gửi đi
                const frameData = submitQueueFrames.get(frameId);
                if (frameData) {
                    // GỬI YÊU CẦU XÓA ĐẾN SERVER
                    sendWebSocketMessage('remove_frame', frameData);
                }
            }
        })

        clearQueueBtn.addEventListener('click', () => {
            if (submitQueueFrames.size > 0) {
                // if (confirm('Are you sure you want to clear ALL frames for EVERYONE?')) {
                // GỬI YÊU CẦU XÓA TẤT CẢ ĐẾN SERVER
                sendWebSocketMessage('clear_all', {});
                // }
            }
        });




        // Thêm listener cho phím tắt khi tương tác với queue
        document.addEventListener('keydown', (e) => {
            if (isModalKeyboardActive()) {
                return;
            }

            const activeElement = document.activeElement;
            const isTyping = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';

            const selectedCountInQueue = selectedQueueFrameIds.size;
            if (selectedCountInQueue > 0 && !isTyping) {

                // Lấy thông tin của frame được chọn CUỐI CÙNG để xử lý cho các phím S và F
                // (Vì S và F chỉ có ý nghĩa với 1 frame duy nhất)
                const lastSelectedId = Array.from(selectedQueueFrameIds).pop();
                const frameData = submitQueueFrames.get(lastSelectedId);

                if (!frameData) return; // Dừng lại nếu không có dữ liệu

                const key = e.key.toLowerCase();
                if (key === 's') {
                    const imageModal = document.getElementById('imageModal');
                    if (imageModal && imageModal.style.display === 'flex') {
                        return;
                    }
                    e.preventDefault();
                    if (selectedCountInQueue === 1) {
                        if (!frameData.path) {
                            showToastNotification("Frame data is incomplete for this action.", "error");
                        } else {
                            const imagePath = frameData.path;
                            clearQueueSelection(); // Bỏ chọn trước khi bắt đầu
                            initiateImageTemporalSearch(imagePath); // Gọi hàm điều phối mới
                        }
                    } else {
                        showToastNotification("Please select only one frame for this action.", "error");
                    }
                } else {
                    e.preventDefault(); // Ngăn hành vi mặc định cho các phím tắt này

                    switch (key) {
                        case 'v': // Vote
                            // Vote cho TẤT CẢ các frame đang được chọn
                            selectedQueueFrameIds.forEach(id => {
                                sendWebSocketMessage('vote_frame', { frameIdentifier: id });
                            });
                            showToastNotification(`Voted for ${selectedCountInQueue} frame(s).`, 'success');
                            // Sau khi vote, ta nên bỏ chọn để tránh nhầm lẫn
                            clearQueueSelection();
                            break;

                        case 'e':
                            if (!submitAsKisBtn.disabled) {
                                submitAsKisBtn.click();
                            }
                            break;

                        case 'q':
                            if (!submitAsQaBtn.disabled) {
                                submitAsQaBtn.click();
                            }
                            break;

                        case 'f': // Xem keyframe lân cận
                            if (selectedCountInQueue === 1) {
                                if (frameData.isFromVideo) {
                                    showToastNotification('Cannot view neighboring frames for a captured image.', 'error');
                                    return;
                                }

                                if (frameData) { // frameData đã là đối tượng đầy đủ
                                    openImageModal(frameData); // Chỉ cần truyền nó vào
                                } else {
                                    showToastNotification("Frame data is incomplete for this action.", "error");
                                }
                            } else {
                                showToastNotification("Please select only one frame to view keyframes.", "error");
                            }
                            // clearQueueSelection();
                            break;
                        // Xử lý phím mũi tên để điều hướng lựa chọn trong queue
                        case 'arrowright':
                        case 'arrowleft':
                            const allFrames = Array.from(submitQueueFramesContainer.querySelectorAll('.queue-frame-item'));
                            const currentIndex = allFrames.findIndex(f => f.dataset.frameId === lastSelectedId);

                            let nextIndex;
                            if (key === 'arrowright') {
                                nextIndex = (currentIndex + 1) % allFrames.length;
                            } else {
                                nextIndex = (currentIndex - 1 + allFrames.length) % allFrames.length;
                            }

                            if (allFrames[nextIndex]) {
                                // Xóa lựa chọn cũ và chọn frame mới
                                clearQueueSelection();
                                const nextFrameId = allFrames[nextIndex].dataset.frameId;
                                selectedQueueFrameIds.add(nextFrameId);
                                allFrames[nextIndex].classList.add('selected');
                                updateSubmitButtonStates();

                                // Cuộn tới frame mới
                                allFrames[nextIndex].scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' });
                            }
                            break;
                    }
                }
            }
        });

        submitQueueFramesContainer.addEventListener('wheel', (e) => {
            // Ngăn trang cuộn dọc khi đang scroll trong queue
            if (e.deltaY !== 0) {
                e.preventDefault();
                submitQueueFramesContainer.scrollLeft += e.deltaY;
            }
        });
        const toggleQueueBtn = document.getElementById('toggleQueueBtn');
        const queueHeader = document.querySelector('.submit-queue-header');

        const toggleQueueDisplay = (e) => {
            // Ngăn sự kiện lan tỏa nếu click vào các nút khác trên header
            if (e.target.closest('.queue-actions')) {
                return;
            }

            submitQueueContainer.classList.toggle('minimized');

            // Cập nhật icon trên nút
            const icon = toggleQueueBtn.querySelector('i');
            if (submitQueueContainer.classList.contains('minimized')) {
                icon.classList.remove('fa-chevron-down');
                icon.classList.add('fa-chevron-up');
            } else {
                icon.classList.remove('fa-chevron-up');
                icon.classList.add('fa-chevron-down');
            }
        };

        // Gán sự kiện cho cả header.
        // Người dùng có thể click vào bất kỳ đâu trên header (trừ vùng actions) để thu nhỏ.
        queueHeader.addEventListener('click', toggleQueueDisplay);


        closePreviewBarBtn.addEventListener('click', () => {
            keyframePreviewBar.classList.remove('visible');
            header.classList.remove('header-expanded'); // << THÊM DÒNG NÀY
        });

        previewThumbnails.addEventListener('wheel', (event) => {
            // Nếu có thanh cuộn ngang
            if (previewThumbnails.scrollWidth > previewThumbnails.clientWidth) {
                event.preventDefault(); // Ngăn trang cuộn dọc
                previewThumbnails.scrollLeft += event.deltaY;
            }
        });

        toggleQueueModeBtn.addEventListener('click', toggleQueueMode);
        formSubmitBtn.addEventListener('click', handleFormSubmit);
        clearFormSubmitQueueBtn.addEventListener('click', clearFormSubmitQueue);

        if (formSubmitFilename) {
            formSubmitFilename.addEventListener('input', () => {
                // Chạy lại logic kiểm tra mỗi khi người dùng gõ
                formSubmitBtn.disabled = formSubmitQueue.length === 0 || formSubmitFilename.value.trim() === '';
            });
        }

        updateLayoutButton();
        setTimeout(function () {
            // Đã mặc định là text-to-image rồi, không cần kích hoạt nữa

            // Tự động focus vào ô tìm kiếm đầu tiên
            const firstSearchInput = document.querySelector('.search-input');
            if (firstSearchInput) {
                firstSearchInput.focus();

                // Tùy chọn: Đặt con trỏ ở cuối nội dung nếu có
                const length = firstSearchInput.value.length;
                if (length > 0) {
                    firstSearchInput.setSelectionRange(length, length);
                }
            }
        }, 100); // Đợi một chút để đảm bảo DOM đã sẵn sàng
    }

    function getQaAnswerFromModal() {
        console.log("Log #1: Hàm getQaAnswerFromModal ĐÃ ĐƯỢC GỌI."); // <-- THÊM DÒNG NÀY
        return new Promise((resolve, reject) => {
            const modal = document.getElementById('qaInputModal');
            const form = document.getElementById('qaInputForm');
            const answerInput = document.getElementById('qaAnswerTextInput');
            const submitBtn = modal.querySelector('.submit-form-btn');
            const closeBtn = modal.querySelector('.close-btn');
            const overlay = modal.querySelector('.modal-overlay');

            const handleClick = (e) => {
                e.preventDefault();
                console.log("Log #2: Nút 'Submit QA' trong modal ĐÃ ĐƯỢC CLICK."); // <-- THÊM DÒNG NÀY

                const answerText = answerInput.value.trim();
                if (answerText) {
                    console.log("Log #3: Có text, chuẩn bị RESOLVE promise."); // <-- THÊM DÒNG NÀY
                    cleanupAndClose();
                    resolve(answerText);
                } else {
                    showToastNotification("Vui lòng nhập câu trả lời!", "error");
                    answerInput.focus();
                }
            };

            const handleClose = () => {
                cleanupAndClose();
                reject('Modal closed by user.');
            };

            const cleanupAndClose = () => {
                submitBtn.removeEventListener('click', handleClick);
                form.removeEventListener('submit', handleClick);
                closeBtn.removeEventListener('click', handleClose);
                overlay.removeEventListener('click', handleClose);

                modal.classList.remove('visible');
                setTimeout(() => {
                    modal.style.display = 'none';
                    form.reset();
                }, 300);
            };

            submitBtn.addEventListener('click', handleClick);
            form.addEventListener('submit', handleClick);
            closeBtn.addEventListener('click', handleClose);
            overlay.addEventListener('click', handleClose);
            modal.style.zIndex = getNewTopZIndex();
            modal.style.display = 'flex';
            setTimeout(() => {
                modal.classList.add('visible');
                answerInput.focus();
            }, 10);
        });
    }

    async function handleApplyDresSession() {
        const newSessionId = dresSessionIdInput.value.trim();
        if (!newSessionId) {
            showToastNotification('Session ID không được để trống!', 'error');
            return;
        }

        // Lưu session ID mới
        currentDresSessionId = newSessionId;
        setUserScopedSetting('dres_session_id', newSessionId);
        showToastNotification('DRES Session ID đã được lưu.', 'success');

        // Đóng menu settings và mở modal chọn evaluation
        settingsMenu.classList.remove('visible');
        await fetchAndShowEvaluations(newSessionId);
    }

    /**
     * Lấy danh sách evaluation từ API và hiển thị trong modal
     * @param {string} sessionId - Session ID để truy vấn
     */
    async function fetchAndShowEvaluations(sessionId) {
        evaluationListContainer.innerHTML = '<div class="loading-indicator" style="padding: 20px;"><div class="loading-spinner" style="width: 30px; height: 30px;"></div></div>';
        openEvaluationModal();

        try {
            const allEvaluations = await fetchDresJson(`${DRES_IP}/v2/client/evaluation/list?session=${encodeURIComponent(sessionId)}`);
            const activeEvaluations = allEvaluations.filter(e => e.status === 'ACTIVE');

            renderEvaluationsInModal(activeEvaluations);

        } catch (error) {
            console.error("Lỗi khi lấy danh sách evaluation:", error);
            evaluationListContainer.innerHTML = `<div class="history-empty">Lỗi: Không thể tải danh sách. Vui lòng kiểm tra lại Session ID.</div>`;
        }
    }

    /**
     * Hiển thị danh sách evaluation trong modal
     * @param {Array} evaluations - Mảng các evaluation đang hoạt động
     */
    function renderEvaluationsInModal(evaluations) {
        evaluationListContainer.innerHTML = '';
        if (evaluations.length === 0) {
            evaluationListContainer.innerHTML = '<div class="history-empty">Không tìm thấy evaluation nào đang hoạt động.</div>';
            return;
        }

        const currentSelectedEvalId = getUserScopedSetting('dres_evaluation_id');

        evaluations.forEach(evaluation => {
            const item = document.createElement('div');
            item.className = 'evaluation-item';
            item.innerHTML = `
                <span class="evaluation-item-name">${evaluation.name}</span>
                <span class="evaluation-item-id">ID: ${evaluation.id}</span>
            `;

            if (evaluation.id === currentSelectedEvalId) {
                item.classList.add('selected');
            }

            item.addEventListener('click', () => {
                // Lưu evaluationId được chọn
                dresEvaluationId = evaluation.id;
                setUserScopedSetting('dres_evaluation_id', evaluation.id);

                showToastNotification(`Đã chọn evaluation: ${evaluation.name}`, 'success');

                // Cập nhật lại UI để highlight lựa chọn mới và đóng modal
                document.querySelectorAll('.evaluation-item.selected').forEach(el => el.classList.remove('selected'));
                item.classList.add('selected');
                closeEvaluationModal();
            });

            evaluationListContainer.appendChild(item);
        });
    }

    function openEvaluationModal() {
        evaluationModal.style.display = 'flex';
        setTimeout(() => evaluationModal.classList.add('visible'), 10);
    }

    function closeEvaluationModal() {
        evaluationModal.classList.remove('visible');
        setTimeout(() => (evaluationModal.style.display = 'none'), 300);
    }


    function updateSubmitButtonStates() {
        const selectionCount = selectedQueueFrameIds.size;

        // Luôn tắt nút KIS nếu không có lựa chọn
        submitAsKisBtn.disabled = selectionCount === 0;

        // Chỉ bật nút QA khi có đúng 1 lựa chọn
        submitAsQaBtn.disabled = selectionCount !== 1;
    }

    // Xử lý việc chọn/bỏ chọn frame trong queue
    submitQueueContainer.addEventListener('click', (e) => {
        const frameItem = e.target.closest('.queue-frame-item');
        if (!frameItem) return; // Bỏ qua nếu không click vào frame

        const frameId = frameItem.dataset.frameId;
        const removeBtn = e.target.closest('.remove-queue-item-btn');

        // Ưu tiên xử lý nút xóa
        if (removeBtn) {
            const frameData = submitQueueFrames.get(frameId);
            if (frameData) {
                sendWebSocketMessage('remove_frame', frameData);
                selectedQueueFrameIds.delete(frameId); // Xóa khỏi danh sách chọn nếu nó đang được chọn
            }
        }
        // Logic chọn frame
        else {
            const allFrames = Array.from(submitQueueFramesContainer.querySelectorAll('.queue-frame-item'));
            const clickedIndex = allFrames.findIndex(f => f.dataset.frameId === frameId);

            // --- Logic MỚI: Xử lý Shift + Click ---
            if (e.shiftKey && lastClickedFrameId) {
                const lastClickedIndex = allFrames.findIndex(f => f.dataset.frameId === lastClickedFrameId);

                const start = Math.min(clickedIndex, lastClickedIndex);
                const end = Math.max(clickedIndex, lastClickedIndex);

                // Bỏ chọn tất cả trước khi chọn khoảng mới
                document.querySelectorAll('.queue-frame-item.selected').forEach(el => el.classList.remove('selected'));
                selectedQueueFrameIds.clear();

                for (let i = start; i <= end; i++) {
                    const id = allFrames[i].dataset.frameId;
                    selectedQueueFrameIds.add(id);
                    allFrames[i].classList.add('selected');
                }
            }
            // --- Logic đã có: Xử lý Ctrl + Click ---
            else if (e.ctrlKey) {
                if (selectedQueueFrameIds.has(frameId)) {
                    selectedQueueFrameIds.delete(frameId);
                    frameItem.classList.remove('selected');
                } else {
                    selectedQueueFrameIds.add(frameId);
                    frameItem.classList.add('selected');
                }
            }
            // --- Logic đã có: Xử lý Click thường ---
            else {
                const isAlreadySelected = selectedQueueFrameIds.has(frameId);
                document.querySelectorAll('.queue-frame-item.selected').forEach(el => el.classList.remove('selected'));
                selectedQueueFrameIds.clear();
                if (!isAlreadySelected) {
                    selectedQueueFrameIds.add(frameId);
                    frameItem.classList.add('selected');
                }
                const frameData = submitQueueFrames.get(frameId);
                if (frameData) {
                    showKeyframePreview(frameData);
                }
            }

            // Cập nhật frame được click cuối cùng (nếu không phải là Ctrl+Click để bỏ chọn)
            if (!e.ctrlKey || selectedQueueFrameIds.has(frameId)) {
                lastClickedFrameId = frameId;
            } else if (lastClickedFrameId === frameId) {
                lastClickedFrameId = null; // Reset nếu bỏ chọn frame cuối cùng
            }
        }

        // Cập nhật trạng thái các nút submit sau mỗi lần thay đổi
        updateSubmitButtonStates();
    });

    // Gán sự kiện cho nút Submit as KIS
    submitAsKisBtn.addEventListener('click', async () => {
        const selectedFrames = Array.from(selectedQueueFrameIds).map(id => submitQueueFrames.get(id));
        const success = await submitToDres(selectedFrames, 'KIS');
        if (success) {
            // Nếu thành công, xóa các frame đã submit khỏi queue
            selectedFrames.forEach(frameData => {
                sendWebSocketMessage('remove_frame', frameData);
            });
            selectedQueueFrameIds.clear();
            updateSubmitButtonStates();
        }
    });

    // Gán sự kiện cho nút Submit as QA
    submitAsQaBtn.addEventListener('click', async () => {
        if (selectedQueueFrameIds.size !== 1) {
            showToastNotification("Vui lòng chọn chính xác một frame để gửi QA.", "error");
            return;
        }
        const frameIdToSubmit = Array.from(selectedQueueFrameIds)[0];
        const frameDataToSubmit = submitQueueFrames.get(frameIdToSubmit);
        if (!frameDataToSubmit) {
            console.error("Không thể tìm thấy dữ liệu cho frame đã chọn:", frameIdToSubmit);
            showToastNotification("Lỗi: Không lấy được dữ liệu frame.", "error");
            return;
        }
        try {
            const answerText = await getQaAnswerFromModal();
            const success = await submitToDres([frameDataToSubmit], 'QA', answerText);

            if (success) {
                sendWebSocketMessage('remove_frame', frameDataToSubmit);
                selectedQueueFrameIds.clear();
                updateSubmitButtonStates();
            }
        } catch (error) {
            console.log("QA submission was canceled:", error);
            showToastNotification("Đã hủy gửi QA.", "info");
        }
    });


    async function ensureDresPrerequisites() {
        // ===== BẮT ĐẦU PHẦN SỬA ĐỔI LOGIC =====

        // Ưu tiên 1: Nếu người dùng đã chọn evaluationId, sử dụng nó ngay lập tức.
        if (dresEvaluationId) {
            return true;
        }

        // Ưu tiên 2: Nếu chưa có evaluationId, thì mới chạy logic cũ để tự động tìm.
        // Đây là phương án dự phòng.
        showToastNotification("Chưa chọn Evaluation, đang tự động tìm...", "info", 1500);

        if (!currentDresSessionId || currentDresSessionId === 'YOUR_SESSION_ID_HERE') {
            showToastNotification("DRES Session ID chưa được thiết lập trong Cài đặt.", "error");
            return false;
        }

        try {
            const evalList = await fetchDresJson(`${DRES_IP}/v2/client/evaluation/list?session=${encodeURIComponent(currentDresSessionId)}`);

            const activeEvaluation = evalList.find(e => e.status === 'ACTIVE');
            if (!activeEvaluation) {
                throw new Error("No active evaluation found in DRES.");
            }

            dresEvaluationId = activeEvaluation.id; // Gán ID tự động tìm được
            // Không lưu vào localStorage vì đây là lựa chọn tự động, không phải của người dùng
            showToastNotification(`Tự động chọn evaluation: ${activeEvaluation.name}`, "success");
            return true;

        } catch (error) {
            console.error("DRES Prerequisites Error:", error);
            showToastNotification(error.message, "error", 3000);
            dresEvaluationId = null; // Reset lại
            return false;
        }
        // ===== KẾT THÚC PHẦN SỬA ĐỔI LOGIC =====
    }


    async function submitTrakeToDres(trakeFrames) {
        return submitToDres(trakeFrames, 'TRAKE');
    }

    async function submitToDres(framesToSubmit, submissionType, qaText = '') {
        console.log("thua", qaText)
        if (!framesToSubmit || framesToSubmit.length === 0) return false;

        const isReady = await ensureDresPrerequisites();
        if (!isReady) {
            showToastNotification("Submission failed. Could not prepare DRES session.", "error");
            return false;
        }
        console.log(qaText);
        let submissionBody = {};

        try {
            // --- KIS: single-frame only ---
            if (submissionType === 'KIS') {
                if (framesToSubmit.length !== 1) {
                    throw new Error("KIS submission only supports a single frame.");
                }
                const frame = framesToSubmit[0];
                const fps = await getFpsForVideo(frame.videoName);
                const timeMs = Math.round((parseInt(frame.frame_id_ori, 10) / fps) * 1000);
                submissionBody = {
                    answerSets: [{
                        answers: [{ mediaItemName: frame.videoName, start: timeMs, end: timeMs }]
                    }]
                };
            }
            // --- BẮT ĐẦU PHẦN LOGIC MỚI CỦA QA ---
            else if (submissionType === 'QA') {
                // 1. Xác thực chỉ có một frame được chọn
                if (framesToSubmit.length !== 1) {
                    throw new Error("QA submission only supports a single frame.");
                }

                // 2. Lấy thông tin của frame duy nhất đó
                const frame = framesToSubmit[0];
                const videoId = frame.videoName;
                const frameIdOri = parseInt(frame.frame_id_ori, 10);

                // 3. Tính toán thời gian (ms), logic giống hệt KIS
                const fps = await getFpsForVideo(videoId);
                const timeMs = Math.round((frameIdOri / fps) * 1000);

                // 4. Xây dựng chuỗi văn bản theo đúng định dạng yêu cầu
                const finalText = `QA-${qaText}-${videoId}-${timeMs}`;

                console.log("submit info: ", finalText);
                // 5. Tạo submissionBody theo cấu trúc của QA
                submissionBody = {
                    "answerSets": [{
                        "answers": [{
                            "text": finalText
                        }]
                    }]
                };
            }
            // --- KẾT THÚC PHẦN LOGIC MỚI CỦA QA ---
            else if (submissionType === 'TRAKE') {
                const videoId = framesToSubmit[0].videoName;
                const frameIds = framesToSubmit
                    .map(frame => parseInt(frame.frame_id_ori, 10))
                    .sort((a, b) => a - b);
                const frameIdsString = frameIds.join(',');
                const finalText = `TR-${videoId}-${frameIdsString}`;
                submissionBody = {
                    answerSets: [{
                        answers: [{ text: finalText }]
                    }]
                };
            } else {
                throw new Error("Invalid submission type.");
            }

            // Bắt đầu gọi API DRES (Phần này không thay đổi)
            const submitUrl = `${DRES_IP}/v2/submit/${dresEvaluationId}?session=${currentDresSessionId}`;
            showToastNotification(`Submitting as ${submissionType}...`, "success");

            const response = await fetch(submitUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(submissionBody)
            });
            const result = await response.json();

            // Xử lý kết quả trả về (Phần này không thay đổi)
            if (response.ok && result.submission) {
                if (result.submission === "WRONG") {
                    showToastNotification("Kết quả sai, hãy thử lại!", "error");
                }

                const submittedFrameIds = framesToSubmit.map(f => f.frameIdentifier);

                sendWebSocketMessage('report_dres_result', {
                    status: result.submission,
                    frameIdentifiers: submittedFrameIds
                });

                return true;
            } else {
                const errorText = await response.text();
                throw new Error(`Submission failed: ${response.status} - ${errorText}`);
            }
        } catch (error) {
            console.error("DRES Submission Error:", error);
            showToastNotification(error.message, "error", 4000);
            return false;
        }
    }


    // quan ly nguoi dung
    function getUsername() {
        let username = localStorage.getItem('aic_lunch_username');
        while (!username || username.trim() === '') {
            username = prompt("Please enter your name to join the session:", "");
        }
        localStorage.setItem('aic_lunch_username', username.trim());
        return username.trim();
    }

    function connectWebSocket() {
        currentUser = getUsername();

        const wsUrl = `${APP_CONFIG.WEBSOCKET_URL}/ws/queue/${currentUser}`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log("WebSocket connection established for user:", currentUser);
            wsRetryDelayMs = 3000; // reset backoff
            trakePendingMutations.forEach(mutation => {
                if (!mutation.acked) {
                    sendPendingTrakeMutation(mutation);
                }
            });
            trakePendingClears.forEach(clear => {
                ws.send(JSON.stringify({ action: 'clear_trake_event', payload: clear.payload }));
            });
        };

        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            handleWebSocketMessage(message);
        };

        ws.onclose = () => {
            console.log("WebSocket connection closed. Attempting to reconnect...");
            // Thử kết nối lại sau 3 giây
            setTimeout(connectWebSocket, wsRetryDelayMs);
            wsRetryDelayMs = Math.min(wsRetryDelayMs * 2, 60000);
        };

        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            ws.close();
        };
    }

    function handleWebSocketMessage(message) {
        const { action, payload } = message;

        // Xử lý các action cập nhật trạng thái "đúng/sai" trước
        // Những action này chỉ cập nhật dữ liệu (Set) và sau đó gọi hàm update UI
        if (action === 'dres_submission_wrong') {
            console.log("sai roi con di");
            payload.frameIdentifiers.forEach(id => wrongSubmissionIds.add(id));
            updateWrongSubmissionUI();
            showGlobalAlert(payload.submittedBy, 'cac');
            return; // Dừng lại, không xử lý tiếp
        }

        if (action === 'dres_submission_correct') {
            wrongSubmissionIds.clear();
            updateWrongSubmissionUI();
            showGlobalAlert(payload.submittedBy, 'correct');
            return;
        }

        // Xử lý các action cập nhật queue và trạng thái ban đầu
        // Những action này sẽ render lại một phần hoặc toàn bộ giao diện
        switch (action) {
            case 'init_state':
                if (window.isInitialStateReceived === undefined) {
                    wrongSubmissionIds = new Set(payload.wrongSubmissionIds || []);
                    window.isInitialStateReceived = true; // Đánh dấu đã nhận
                }

                userColors = payload.users;
                queuedFramesSet = new Set(payload.queue.map(frame => frame.frameIdentifier));
                renderFullQueue(payload.queue);
                updateSearchResultsQueueStatus();

                if (resolveInitialStatePromise) {
                    resolveInitialStatePromise();
                    resolveInitialStatePromise = null;
                }
                break;

            case 'user_update':
                userColors = payload.users;
                break;
            case 'trake_queue_update':
                console.log('[TRAKE] Received queue update from server:', payload);
                for (const pendingClear of trakePendingClears.values()) {
                    if (!payload.some(frame => frame.eventNumber === pendingClear.payload.eventNumber)) {
                        finishTrakeClear(pendingClear.payload.eventNumber, null, true);
                    }
                }
                renderTrakeQueue(payload);
                break;
            case 'trake_init': {
                const pendingFrames = Array.from(trakePendingMutations.values())
                    .filter(mutation => !mutation.acked)
                    .map(mutation => mutation.payload);
                const pendingEvents = new Set(pendingFrames.map(frame => frame.eventNumber));
                const serverFrames = payload.filter(frame => {
                    const pendingClear = trakePendingClears.get(frame.eventNumber);
                    if (!pendingClear) return !pendingEvents.has(frame.eventNumber);
                    if ((frame.revision || 0) > pendingClear.payload.expectedRevision) {
                        pendingClear.frame = frame;
                        pendingClear.payload.expectedRevision = frame.revision || 0;
                    }
                    return false;
                });
                renderTrakeQueue([...serverFrames.filter(frame => !pendingEvents.has(frame.eventNumber)), ...pendingFrames]);
                break;
            }
            case 'trake_ack':
                handleTrakeAck(payload);
                break;
            case 'trake_slot_updated':
                applyTrakeSlotUpdate(payload);
                break;
            case 'trake_slot_thumbnail_ready':
                applyTrakeThumbnailUpdate(payload);
                break;
            case 'trake_slot_cleared':
                {
                    const currentFrame = trakeQueueState.find(frame => frame.eventNumber === payload.eventNumber);
                    if (currentFrame?.revision && payload.revision && currentFrame.revision > payload.revision) break;
                }
                finishTrakeClear(payload.eventNumber, payload.requestId, true);
                if (![...trakePendingMutations.values()].some(mutation => !mutation.acked && mutation.payload.eventNumber === payload.eventNumber)) {
                    renderTrakeQueue(trakeQueueState.filter(frame => frame.eventNumber !== payload.eventNumber));
                }
                break;
            case 'trake_conflict':
                handleTrakeConflict(payload);
                break;
            case 'trake_retry':
                scheduleTrakeMutationRetry(payload);
                break;
            case 'special_submission_alert':
                if (payload && payload.username) {
                    showGlobalAlert(payload.username, 'special');
                }
                break;
        }
    }

    function applyFrameStatusClasses(frameElement, frameIdentifier) {
        frameElement.classList.toggle('is-in-queue', queuedFramesSet.has(frameIdentifier));
        frameElement.classList.toggle('is-wrong-submission', wrongSubmissionIds.has(frameIdentifier));
    }

    function updateSearchResultsQueueStatus() {
        // Both regular results and semantic-modal results reflect the shared queue state.
        document.querySelectorAll('.image-item[data-frame-identifier]').forEach(frameElement => {
            applyFrameStatusClasses(frameElement, frameElement.dataset.frameIdentifier);
        });
    }

    function sendWebSocketMessage(action, payload) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(JSON.stringify({ action, payload }));
                return true;
            } catch (error) {
                console.warn('WebSocket send failed; mutation will retry after reconnect.', error);
                return false;
            }
        } else {
            console.error("WebSocket is not connected.");
            return false;
        }
    }

    function createRequestId() {
        return typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function sendPendingTrakeMutation(mutation) {
        if (!mutation || mutation.acked) return;
        sendWebSocketMessage('trake_assign', mutation.payload);
        if (mutation.ackTimer) clearTimeout(mutation.ackTimer);
        const retryDelay = Math.min(8000, 1500 * (2 ** Math.min(mutation.sendAttempts || 0, 3)));
        mutation.sendAttempts = (mutation.sendAttempts || 0) + 1;
        mutation.ackTimer = setTimeout(() => {
            mutation.ackTimer = null;
            sendPendingTrakeMutation(mutation);
        }, retryDelay);
    }

    function scheduleTrakeMutationRetry(payload) {
        const mutation = trakePendingMutations.get(payload.requestId);
        if (!mutation || mutation.acked || mutation.retryTimer) return;
        mutation.retryTimer = setTimeout(() => {
            mutation.retryTimer = null;
            if (!mutation.acked) sendPendingTrakeMutation(mutation);
        }, Math.max(500, Math.min(5000, Number(payload.retryAfterMs) || 1500)));
    }

    function applyTrakeSlotUpdate(frame) {
        const pendingClear = trakePendingClears.get(frame.eventNumber);
        if (pendingClear) {
            if ((frame.revision || 0) > pendingClear.payload.expectedRevision) {
                pendingClear.frame = frame;
                pendingClear.payload = {
                    ...pendingClear.payload,
                    requestId: createRequestId(),
                    expectedRevision: frame.revision || 0,
                    force: true
                };
                sendWebSocketMessage('clear_trake_event', pendingClear.payload);
            }
            return;
        }
        const pending = trakePendingMutations.get(frame.requestId);
        const existing = trakeQueueState.find(item => item.eventNumber === frame.eventNumber);
        if (existing && existing.revision && frame.revision && existing.revision > frame.revision) return;
        const localThumbnailUrl = (pending && trakeLocalThumbnailUrls.get(frame.requestId))
            || (existing?.requestId && trakeLocalThumbnailUrls.get(existing.requestId));
        const syncedFrame = { ...frame, status: 'filled' };
        if (localThumbnailUrl && !syncedFrame.thumbnailPath) syncedFrame.thumbnailUrl = localThumbnailUrl;
        renderTrakeQueue([...trakeQueueState.filter(item => item.eventNumber !== frame.eventNumber), syncedFrame]);
    }

    async function handleTrakeAck(payload) {
        if (payload.cleared) {
            const pendingClear = trakePendingClears.get(payload.eventNumber)
                || Array.from(trakePendingClears.values())
                    .find(clear => clear.payload.requestId === payload.requestId);
            if (pendingClear) {
                finishTrakeClear(pendingClear.payload.eventNumber, payload.requestId, true);
                renderTrakeQueue(trakeQueueState);
            }
            return;
        }
        const mutation = trakePendingMutations.get(payload.requestId);
        if (!mutation) return;
        if (mutation.retryTimer) clearTimeout(mutation.retryTimer);
        if (mutation.ackTimer) clearTimeout(mutation.ackTimer);
        applyTrakeSlotUpdate(payload.frame);
        mutation.acked = true;
        mutation.ackFrame = payload.frame;
        maybeFinalizeTrakeMutation(payload.requestId);
    }

    function handleTrakeConflict(payload) {
        const pendingClear = trakePendingClears.get(payload.eventNumber);
        if (pendingClear) {
            pendingClear.payload = {
                ...pendingClear.payload,
                requestId: createRequestId(),
                expectedRevision: payload.frame?.revision || 0,
                force: true
            };
            if (payload.frame) pendingClear.frame = payload.frame;
            sendWebSocketMessage('clear_trake_event', pendingClear.payload);
            return;
        }
        const mutation = trakePendingMutations.get(payload.requestId);
        if (!mutation) return;
        if (mutation.retryTimer) clearTimeout(mutation.retryTimer);
        if (mutation.ackTimer) clearTimeout(mutation.ackTimer);
        const localUrl = trakeLocalThumbnailUrls.get(payload.requestId);
        if (localUrl) URL.revokeObjectURL(localUrl);
        trakeLocalThumbnailUrls.delete(payload.requestId);
        trakePendingMutations.delete(payload.requestId);
        const withoutOptimisticSlot = trakeQueueState.filter(frame => frame.eventNumber !== payload.eventNumber);
        renderTrakeQueue(payload.frame ? [...withoutOptimisticSlot, payload.frame] : withoutOptimisticSlot);
        const message = payload.reason === 'video_locked'
            ? `Hàng đợi TRAKE đang khóa cho video: ${payload.lockedVideoName || 'video khác'}.`
            : 'Không thể đồng bộ frame TRAKE. Vui lòng thử lại.';
        showToastNotification(message, 'error');
    }

    function finishTrakeClear(eventNumber, requestId, acceptOtherRequest = false) {
        const pendingClear = trakePendingClears.get(eventNumber);
        if (!pendingClear || (!acceptOtherRequest && requestId && pendingClear.payload.requestId !== requestId)) return;
        const localUrl = pendingClear.frame.requestId
            ? trakeLocalThumbnailUrls.get(pendingClear.frame.requestId)
            : null;
        if (localUrl) {
            URL.revokeObjectURL(localUrl);
            trakeLocalThumbnailUrls.delete(pendingClear.frame.requestId);
        }
        trakePendingClears.delete(eventNumber);
    }

    function clearTrakeFrameOptimistically(frameData) {
        if (trakePendingClears.has(frameData.eventNumber)) return;
        const payload = {
            requestId: createRequestId(),
            eventNumber: frameData.eventNumber,
            expectedRevision: frameData.revision || 0,
            force: true
        };
        trakePendingClears.set(frameData.eventNumber, { payload, frame: frameData });
        renderTrakeQueue(trakeQueueState.filter(frame => frame.eventNumber !== frameData.eventNumber));
        sendWebSocketMessage('clear_trake_event', payload);
    }

    function maybeFinalizeTrakeMutation(requestId) {
        const mutation = trakePendingMutations.get(requestId);
        if (!mutation || !mutation.acked || !mutation.thumbnailCaptureDone) return;
        if (!mutation.thumbnailBlob) {
            trakePendingMutations.delete(requestId);
            return;
        }
        if (mutation.thumbnailUploadStarted) return;
        mutation.thumbnailUploadStarted = true;
        uploadTrakeThumbnail(mutation.ackFrame, mutation.thumbnailBlob, requestId)
            .finally(() => trakePendingMutations.delete(requestId));
    }

    function applyTrakeThumbnailUpdate(payload) {
        const frame = trakeQueueState.find(item => item.eventNumber === payload.eventNumber);
        if (!frame || (payload.revision && frame.revision !== payload.revision)) return;
        const localUrl = frame.requestId && trakeLocalThumbnailUrls.get(frame.requestId);
        if (localUrl) {
            URL.revokeObjectURL(localUrl);
            trakeLocalThumbnailUrls.delete(frame.requestId);
        }
        renderTrakeQueue(trakeQueueState.map(item => item.eventNumber === payload.eventNumber
            ? { ...item, thumbnailUrl: null, thumbnailPath: payload.thumbnailPath }
            : item));
    }

    async function uploadTrakeThumbnail(frame, thumbnailBlob, requestId) {
        const formData = new FormData();
        formData.append('file', thumbnailBlob, `${frame.videoName}_${frame.frameIndex}.webp`);
        formData.append('event_number', String(frame.eventNumber));
        formData.append('video_name', frame.videoName);
        formData.append('frame_index', String(frame.frameIndex));
        formData.append('revision', String(frame.revision));
        formData.append('request_id', requestId);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);
        try {
            const response = await fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/trake-thumbnail`, {
                method: 'POST',
                body: formData,
                signal: controller.signal
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = await response.json();
            applyTrakeThumbnailUpdate(result);
        } catch (error) {
            console.warn('TRAKE thumbnail upload failed; metadata remains synced.', error);
        } finally {
            clearTimeout(timeoutId);
        }
    }

    // THAY THẾ TOÀN BỘ HÀM openTemporalChainModal BẰNG PHIÊN BẢN NÀY

    async function openTemporalChainModal(baseFrame, temporalChain) {
        const modal = document.getElementById('temporalChainModal');
        const mainPreview = document.getElementById('temporalMainPreviewImage');
        const thumbnailStrip = document.getElementById('temporalThumbnailStrip');
        const modalFrameInfo = document.getElementById('temporalModalFrameInfo');

        // Biến trạng thái, chỉ tồn tại bên trong hàm này
        let currentModalFrameData = null;

        // 1. Chuẩn bị và xử lý dữ liệu (logic gốc, không thay đổi)
        const sortedQueryIds = Object.keys(temporalChain).sort((a, b) => a - b);
        const chainFramesData = sortedQueryIds.map(queryId => temporalChain[queryId]);
        const allFramesRaw = [baseFrame, ...chainFramesData];
        const uniqueFramesMap = new Map();
        allFramesRaw.forEach((frame, index) => {
            let identifier;
            if (index === 0) {
                identifier = frame.frameIdentifier;
            } else {
                const metadata = frame.metadata;
                identifier = `${metadata.video_name}_${metadata.frame_id}`;
            }
            if (!uniqueFramesMap.has(identifier)) {
                uniqueFramesMap.set(identifier, frame);
            }
        });
        const uniqueFramesRaw = Array.from(uniqueFramesMap.values());

        // 'processedFrames' là biến CỦA RIÊNG MODAL NÀY
        const processedFrames = uniqueFramesRaw.map((frame, index) => {
            let path, frameIdentifier, videoName, timestamp, score, frame_id_ori;
            if (frame.frameIdentifier) {
                path = frame.path;
                frameIdentifier = frame.frameIdentifier;
                videoName = frame.videoName;
                timestamp = frame.timestamp;
                score = frame.temporal_score !== undefined ? frame.temporal_score : frame.score;
                frame_id_ori = frame.frame_id_ori;
            } else {
                const metadata = frame.metadata;
                if (!metadata || !metadata.frame_name || !metadata.video_name) return null;
                const fullFrameName = metadata.frame_name.endsWith('.webp') ? metadata.frame_name : `${metadata.frame_name}.webp`;
                videoName = metadata.video_name;
                path = getFrameUrl(videoName, fullFrameName);
                frame_id_ori = metadata.frame_id;
                frameIdentifier = `${videoName}_${frame_id_ori}`;
                timestamp = metadata.timestamp;
                score = frame.temporal_score;
            }
            const originalQueryIndex = sortedQueryIds.findIndex(qid => temporalChain[qid] && temporalChain[qid].metadata.frame_id === frame_id_ori);
            const queryLabel = (frameIdentifier === baseFrame.frameIdentifier) ? 'A (Start)' : `Chain ${String.fromCharCode(65 + originalQueryIndex + 1)}`;
            return { path, frameIdentifier, queryLabel, score, videoName, timestamp, frame_id_ori };
        }).filter(Boolean);


        // 2. Định nghĩa các hàm con (chỉ hoạt động trong phạm vi của modal này)

        // Hàm con updateMainPreview CỦA RIÊNG MODAL NÀY
        function updateMainPreview(frameData) {
            if (!frameData) return;
            currentModalFrameData = frameData; // Cập nhật biến trạng thái
            setFrameImageSource(mainPreview, frameData.path);
            modalFrameInfo.textContent = `${frameData.queryLabel}: ${frameData.frameIdentifier} | Score: ${frameData.score.toFixed(4)}`;

            const oldCurrent = thumbnailStrip.querySelector('.current-frame');
            if (oldCurrent) oldCurrent.classList.remove('current-frame');
            const newCurrent = thumbnailStrip.querySelector(`[data-frame-identifier="${frameData.frameIdentifier}"]`);
            if (newCurrent) {
                newCurrent.classList.add('current-frame');
                newCurrent.scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' });
            }
        }

        // Hàm con wheelHandler CỦA RIÊNG MODAL NÀY, sử dụng 'processedFrames'
        const wheelHandler = (e) => {
            e.preventDefault();
            const currentIndex = processedFrames.findIndex(f => f.path === currentModalFrameData.path);
            if (currentIndex === -1) return;
            let nextIndex = currentIndex + (e.deltaY > 0 ? 1 : -1);
            nextIndex = Math.max(0, Math.min(processedFrames.length - 1, nextIndex));
            if (nextIndex !== currentIndex) {
                updateMainPreview(processedFrames[nextIndex]);
            }
        };

        // Hàm con keydownHandler CỦA RIÊNG MODAL NÀY, sử dụng 'processedFrames'
        const keydownHandler = (e) => {
            if (getTopActiveModal()?.element !== modal) {
                return;
            }

            const key = e.key.toLowerCase();
            if (key === 'escape') { closeModal(); return; }

            // Dòng này sẽ không còn lỗi vì 'currentModalFrameData' được 'updateMainPreview' khởi tạo trước
            if (!currentModalFrameData) return;

            const currentIndex = processedFrames.findIndex(f => f.path === currentModalFrameData.path);
            if (currentIndex === -1) return;

            if (key === 'arrowright') {
                const nextIndex = Math.min(processedFrames.length - 1, currentIndex + 1);
                updateMainPreview(processedFrames[nextIndex]);
                return;
            } else if (key === 'arrowleft') {
                const nextIndex = Math.max(0, currentIndex - 1);
                updateMainPreview(processedFrames[nextIndex]);
                return;
            }

            e.preventDefault();

            if (key === 'd' || key === 'a') {
                const isSpecial = key === 'a';
                const frameDataToSend = { ...currentModalFrameData, isSpecial: isSpecial };
                addFramesToQueue([frameDataToSend]);
                closeModal();
            } else if (key === 's') {
                closeModal(() => initiateImageTemporalSearch(currentModalFrameData.path));
            }
        };

        // Hàm con clickThumbnailHandler CỦA RIÊNG MODAL NÀY
        const clickThumbnailHandler = (e) => {
            if (e.target.tagName === 'IMG' && e.target.frameData) {
                updateMainPreview(e.target.frameData);
            }
        };

        // Hàm con closeModal CỦA RIÊNG MODAL NÀY, gỡ đúng các sự kiện
        function closeModal(onClosedCallback = null) {
            modal.removeEventListener('wheel', wheelHandler);
            document.removeEventListener('keydown', keydownHandler);
            thumbnailStrip.removeEventListener('click', clickThumbnailHandler);
            modal.style.display = 'none';
            mainPreview.src = "";
            registerModalClose(modal);
            if (typeof onClosedCallback === 'function') {
                setTimeout(onClosedCallback, 50);
            }
        }

        // 3. Populate UI và gán sự kiện (logic gốc, không thay đổi)
        thumbnailStrip.innerHTML = '';
        processedFrames.forEach(frame => {
            const thumb = document.createElement('img');
            setFrameImageSource(thumb, frame.path);
            thumb.title = `${frame.queryLabel}: ${frame.frameIdentifier}\nScore: ${frame.score.toFixed(4)}`;
            thumb.frameData = frame;
            thumb.dataset.frameIdentifier = frame.frameIdentifier;
            thumbnailStrip.appendChild(thumb);
        });

        modal.addEventListener('wheel', wheelHandler, { passive: false });
        document.addEventListener('keydown', keydownHandler);
        thumbnailStrip.addEventListener('click', clickThumbnailHandler);
        modal.querySelector('.modal-overlay').onclick = () => closeModal();
        registerModalOpen(modal, closeModal);

        // 4. Hiển thị modal và gọi updateMainPreview để khởi tạo 'currentModalFrameData'
        modal.style.display = 'flex';
        updateMainPreview(processedFrames[0]);
    }

    function updateModelHighlight() {
        const menuItems = document.querySelectorAll('#settingsMenu li');
        menuItems.forEach((item, index) => {
            if (index === highlightedModelIndex) {
                item.classList.add('highlighted');
                // Đảm bảo mục được highlight luôn trong tầm nhìn
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('highlighted');
            }
        });
    }


    function setupKeyboardNavigation() {
        // Danh sách các nút trên header theo thứ tự từ trái sang phải
        const headerButtons = [
            document.getElementById('textToImageBtn'),
            document.getElementById('textToTextBtn'),
            document.getElementById('imageToImageBtn'),
            document.getElementById('translateBtn')
        ];

        // Thêm thuộc tính tabindex cho các nút để có thể focus
        headerButtons.forEach(btn => {
            if (btn) btn.setAttribute('tabindex', '0');
        });

        // Xử lý sự kiện keydown trên toàn trang
        document.addEventListener('keydown', function (e) {
            if (isModalKeyboardActive()) {
                return;
            }

            // Nếu đang focus vào một input, textarea hoặc bất kỳ element có thể edit
            // thì không xử lý phím tắt (để người dùng có thể nhập bình thường)
            const activeElement = document.activeElement;
            const isEditableElement = activeElement.tagName === 'INPUT' ||
                activeElement.tagName === 'TEXTAREA' ||
                activeElement.isContentEditable;

            if (e.key === 'Escape' && isEditableElement) {
                // Nếu đang trong ô tìm kiếm và nhấn Escape
                if (activeElement.classList.contains('search-input')) {
                    e.preventDefault();
                    activeElement.blur(); // Thoát khỏi ô tìm kiếm
                    return; // Không xử lý các logic khác
                }
            }

            if (settingsMenu.classList.contains('visible')) {
                const menuItems = document.querySelectorAll('#settingsMenu li');
                if (menuItems.length === 0) return;

                // Xử lý phím mũi tên xuống
                if (e.key === 'ArrowDown') {
                    e.preventDefault(); // Ngăn trang cuộn xuống
                    highlightedModelIndex++;
                    if (highlightedModelIndex >= menuItems.length) {
                        highlightedModelIndex = 0; // Quay lại đầu danh sách
                    }
                    updateModelHighlight();
                }
                // Xử lý phím mũi tên lên
                else if (e.key === 'ArrowUp') {
                    e.preventDefault(); // Ngăn trang cuộn lên
                    highlightedModelIndex--;
                    if (highlightedModelIndex < 0) {
                        highlightedModelIndex = menuItems.length - 1; // Đi đến cuối danh sách
                    }
                    updateModelHighlight();
                }
                // Xử lý phím Enter
                else if (e.key === 'Enter') {
                    e.preventDefault();
                    if (highlightedModelIndex > -1) {
                        menuItems[highlightedModelIndex].click(); // Giả lập một cú click chuột
                    }
                }
                // Xử lý phím Escape để đóng menu (UX bonus)
                else if (e.key === 'Escape') {
                    toggleSettingsMenu();
                }
            }


        });

        // Xử lý khi focus vào/ra các nút header
        headerButtons.forEach(btn => {
            if (!btn) return;

            btn.addEventListener('focus', function () {
                currentHeaderFocus = btn;
                headerButtons.forEach(b => b.classList.remove('keyboard-focus'));
                btn.classList.add('keyboard-focus');
            });

            btn.addEventListener('blur', function () {
                // Chỉ xóa highlight khi không chuyển focus sang nút header khác
                setTimeout(() => {
                    if (!headerButtons.includes(document.activeElement)) {
                        btn.classList.remove('keyboard-focus');
                        currentHeaderFocus = null;
                    }
                }, 10);
            });

            // Thêm sự kiện mouseenter/mouseleave để xử lý visual cues
            btn.addEventListener('mouseenter', function () {
                // Thêm class hover nếu cần
                btn.classList.add('header-btn-hover');
            });

            btn.addEventListener('mouseleave', function () {
                // Xóa class hover
                btn.classList.remove('header-btn-hover');
            });
        });
    }


    // HÀM MỚI: Lấy danh sách model từ API
    async function fetchAvailableModels() {
        try {
            const response = await fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/models`);
            if (!response.ok) throw new Error('Failed to fetch models');
            const data = await response.json();
            availableModels = data.models || [];
            populateSettingsMenu(); // Điền model vào menu sau khi lấy được
        } catch (error) {
            console.error('Error fetching models:', error);
            // Có thể hiển thị thông báo lỗi cho người dùng
        }
    }

    // HÀM MỚI: Điền các model vào menu HTML
    function populateSettingsMenu() {
        const menuList = document.querySelector('#settingsMenu ul');
        if (!menuList) return;

        menuList.innerHTML = ''; // Xóa các mục cũ

        // Thêm tùy chọn "All Models"
        const allItem = document.createElement('li');
        allItem.textContent = 'All Models (Default)';
        allItem.dataset.model = 'all';
        menuList.appendChild(allItem);

        // Thêm các model từ API
        availableModels.forEach(model => {
            const modelItem = document.createElement('li');
            // Lấy tên ngắn gọn của model
            const displayName = model.split('/').pop();
            modelItem.textContent = displayName;
            modelItem.dataset.model = model;
            menuList.appendChild(modelItem);
        });

        updateSelectedModelUI(); // Cập nhật UI cho lựa chọn hiện tại
    }

    // HÀM MỚI: Bật/tắt menu
    function toggleSettingsMenu() {
        const settingsMenu = document.getElementById('settingsMenu');
        settingsMenu.classList.toggle('visible');
        if (settingsMenu.classList.contains('visible')) {
            // Khi menu được MỞ
            const menuItems = Array.from(document.querySelectorAll('#settingsMenu li'));
            // Tìm index của model hiện tại đang được chọn
            const currentIndex = menuItems.findIndex(item => item.classList.contains('selected'));
            highlightedModelIndex = (currentIndex > -1) ? currentIndex : 0;
            updateModelHighlight();
        } else {
            // Khi menu được ĐÓNG, reset trạng thái
            highlightedModelIndex = -1;
        }
    }

    // HÀM MỚI: Xử lý khi người dùng chọn model
    function selectModel(modelName) {
        currentSelectedModel = modelName;
        console.log('Selected model:', currentSelectedModel, 'for user:', currentUserId);
        setUserScopedSetting('selected_model', modelName);
        updateSelectedModelUI();
    }

    // HÀM MỚI: Cập nhật UI để hiển thị model nào đang được chọn
    function updateSelectedModelUI() {
        const menuItems = document.querySelectorAll('#settingsMenu li');
        menuItems.forEach(item => {
            if (item.dataset.model === currentSelectedModel) {
                item.classList.add('selected');
            } else {
                item.classList.remove('selected');
            }
        });
    }
    function switchSearchMode(mode) {
        // Cập nhật UI của các nút
        textToImageBtn.classList.toggle('active', mode === 'text-to-image');
        imageToImageBtn.classList.toggle('active', mode === 'image-to-image');

        // Cập nhật mode hiện tại
        currentSearchMode = mode;


        // Cập nhật giao diện tìm kiếm
        updateSearchMode();

        // Xử lý khi chuyển từ image-to-image sang chế độ text
        if (mode !== 'image-to-image') {
            const firstSearchGroup = document.querySelector('.search-input-group');
            if (firstSearchGroup) {
                const textInput = firstSearchGroup.querySelector('.search-input');

                if (textInput && textInput.style.display === 'none') {
                    // Nếu textInput đang bị ẩn (đang ở chế độ image-to-image),
                    // tạo lại thanh tìm kiếm đầu tiên
                    searchInputsContainer.innerHTML = '';  // Xóa tất cả thanh tìm kiếm

                    // Tạo thanh tìm kiếm mới
                    const newSearchGroup = document.createElement('div');
                    newSearchGroup.className = 'search-input-group';
                    newSearchGroup.setAttribute('data-search-id', '1');

                    // Cập nhật placeholder tùy theo mode
                    let placeholder = "In Image";
                    if (mode === 'text-to-text') {
                        placeholder = "In Text";
                    }

                    newSearchGroup.innerHTML = `
                    <div class="search-box">
                    <textarea
                    class="search-input"
                    placeholder="${placeholder}"
                    rows="1"
                    data-mode="${mode}"
                    ></textarea>
                    <div class="translated-query-display"></div>
                    <div class="autocorrect-suggestion-display"></div>
                    <div class="image-upload-area" style="display: none;">
                    <input type="file" class="image-input" accept="image/*" style="display: none;">
                    <div class="upload-zone">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21,15 16,10 5,21"/>
                    </svg>
                    <p>Kéo thả ảnh vào đây hoặc click để chọn</p>
                    <div class="uploaded-image" style="display: none;">
                    <img src="" alt="Uploaded image">
                    <button class="remove-image">×</button>
                    </div>
                    </div>
                    </div>
                    </div>
                    `;

                    searchInputsContainer.appendChild(newSearchGroup);
                    setupSearchInput(newSearchGroup);

                    // Focus vào thanh tìm kiếm mới
                    const newInput = newSearchGroup.querySelector('.search-input');
                    if (newInput) {
                        newInput.focus();
                    }
                } else if (textInput && mode !== 'image-to-image') {
                    // THÊM VÀO: Nếu đã có textInput (không cần tạo mới),
                    // vẫn focus vào nó khi chuyển giữa các chế độ text
                    textInput.focus();
                }
            }
        }
    }

    function updateSearchMode() {
        const searchInputGroups = document.querySelectorAll('.search-input-group');
        searchInputGroups.forEach(group => {
            const textInput = group.querySelector('.search-input');
            const imageUploadArea = group.querySelector('.image-upload-area');

            if (currentSearchMode === 'text-to-image' || currentSearchMode === 'text-to-text') {
                // Hiện thanh tìm kiếm văn bản, ẩn khung tải ảnh
                textInput.style.display = 'block';
                imageUploadArea.style.display = 'none';
                textInput.setAttribute('data-mode', currentSearchMode);

                // Cập nhật placeholder tùy theo mode
                if (currentSearchMode === 'text-to-image') {
                    textInput.placeholder = "In Image";
                } else {
                    textInput.placeholder = "In Text";
                }

                // THÊM VÀO: Tự động focus vào ô tìm kiếm đầu tiên nếu có
                if (group === searchInputGroups[0]) {
                    setTimeout(() => textInput.focus(), 0);
                }
            } else if (currentSearchMode === 'image-to-image') {
                // Ẩn thanh tìm kiếm văn bản, hiện khung tải ảnh
                textInput.style.display = 'none';
                imageUploadArea.style.display = 'block';
                textInput.setAttribute('data-mode', 'image-to-image');
            }
        });
    }

    function handleModeButtonClick(e) {
        if (e.target.classList.contains('mode-btn')) {
            // Update active button
            searchModeButtons.querySelectorAll('.mode-btn').forEach(btn =>
                btn.classList.remove('active')
            );
            e.target.classList.add('active');

            // Update current mode
            currentSearchMode = e.target.dataset.mode;
            updateSearchMode();
        }
    }

    function createNewSearchInput() {
        searchIdCounter++;
        const newSearchGroup = document.createElement('div');
        newSearchGroup.className = 'search-input-group';
        newSearchGroup.setAttribute('data-search-id', searchIdCounter);

        // Cập nhật placeholder tùy theo mode hiện tại
        let placeholder = "Search";
        if (currentSearchMode === 'text-to-image') {
            placeholder = "In Image";
        } else if (currentSearchMode === 'text-to-text') {
            placeholder = "In Text";
        }

        newSearchGroup.innerHTML = `
        <div class="search-box">
        <textarea
        class="search-input"
        placeholder="${placeholder}"
        rows="1"
        data-mode="${currentSearchMode}"
        ></textarea>
        <div class="translated-query-display"></div>
        <div class="autocorrect-suggestion-display"></div>
        <div class="tag-filter-container">
        <input type="text" class="tag-input" placeholder="Enter tags">
        </div>
        <div class="ocr-filter-container">
        <input type="text" class="ocr-input" placeholder="Enter OCR">
        <div class="fuzzy-switch-wrapper">
        <div class="fuzzy-switch-item">
        <label class="fuzzy-switch-container">
        <input type="checkbox"> <!-- Không cần ID ở đây vì nó sẽ là duy nhất trong group -->
        <span class="slider round"></span>
        </label>
        <span class="fuzzy-label">Fuzzy Search</span>
        </div>
        <div class="ocr-mode-wrapper">
        <span class="ocr-mode-label">Mode:</span>
        <select class="ocr-mode-select" title="OCR Matching Mode">
            <option value="cascading" selected>Cascading</option>
            <option value="all">All</option>
        </select>
        </div>
        </div>
        </div>
        <div class="asr-filter-container">
        <input type="text" class="asr-input" placeholder="Enter ASR">
        <div class="fuzzy-switch-wrapper">
        <label class="fuzzy-switch-container">
        <input type="checkbox">
        <span class="slider round"></span>
        </label>
        <span>Fuzzy Search</span>
        </div>
        </div>
        <div class="image-upload-area" style="display: none;">
        <input type="file" class="image-input" accept="image/*" style="display: none;">
        <div class="upload-zone">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
        <circle cx="8.5" cy="8.5" r="1.5"/>
        <polyline points="21,15 16,10 5,21"/>
        </svg>
        <p>Kéo thả ảnh vào đây hoặc click để chọn</p>
        <div class="uploaded-image" style="display: none;">
        <img src="" alt="Uploaded image">
        <button class="remove-image">×</button>
        </div>
        </div>
        </div>
        </div>
        `;

        searchInputsContainer.appendChild(newSearchGroup);
        setupSearchInput(newSearchGroup);

        // Update mode display
        updateSearchMode();

        // Trả về element input mới được tạo
        const newInput = newSearchGroup.querySelector('.search-input');
        return newInput;
    }

    function setupSearchInput(searchGroup) {
        const textInput = searchGroup.querySelector('.search-input');
        const ocrInput = searchGroup.querySelector('.ocr-input');
        const imageInput = searchGroup.querySelector('.image-input');
        const uploadZone = searchGroup.querySelector('.upload-zone');
        const uploadedImageDiv = searchGroup.querySelector('.uploaded-image');
        const removeImageBtn = searchGroup.querySelector('.remove-image');
        const tagInput = searchGroup.querySelector('.tag-input');
        const asrInput = searchGroup.querySelector('.asr-input');

        // Auto-resize textarea + ẩn dòng dịch khi người dùng gõ
        textInput.addEventListener('input', function () {
            autoResizeTextarea(this);
            const translationDisplay = searchGroup.querySelector('.translated-query-display');
            if (translationDisplay) {
                translationDisplay.classList.remove('visible');
            }
        });

        if (ocrInput) {
            ocrInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault(); // Ngăn submit form
                    textInput.focus(); // Quay về thanh tìm kiếm chính
                }
            });
        }

        if (tagInput) {
            tagInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault(); // Ngăn hành vi mặc định của Enter

                    // Chuyển focus trở lại ô tìm kiếm chính
                    textInput.focus();
                }
            });
        }
        if (asrInput) {
            asrInput.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                    e.preventDefault(); // Ngăn hành vi mặc định
                    textInput.focus(); // Chuyển focus trở lại ô tìm kiếm chính
                }
            });
        }
        textInput.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.blur(); // Thoát khỏi ô tìm kiếm
            }
        });

        textInput.addEventListener('keyup', async function (e) {
            // Chỉ kích hoạt khi người dùng nhấn phím cách
            if (e.key === ' ') {
                const currentText = this.value;
                const suggestionDisplay = searchGroup.querySelector('.autocorrect-suggestion-display');

                const suggestion = await getAutocorrectSuggestion(currentText);

                // Chỉ hiển thị nếu có gợi ý VÀ gợi ý đó khác với văn bản gốc
                if (suggestion && suggestion.trim() !== currentText.trim()) {
                    suggestionDisplay.innerHTML = `Gợi ý: <strong>${suggestion}</strong> <span class="key-hint">Nhấn Tab</span>`;
                    suggestionDisplay.dataset.suggestion = suggestion; // Lưu lại gợi ý để dùng với phím Tab
                    suggestionDisplay.classList.add('visible');
                } else {
                    suggestionDisplay.classList.remove('visible');
                    suggestionDisplay.dataset.suggestion = '';
                }
            }
        });

        textInput.addEventListener('keydown', function (e) {
            if (e.key === 'Tab') {
                const suggestionDisplay = searchGroup.querySelector('.autocorrect-suggestion-display');

                if (suggestionDisplay.classList.contains('visible') && suggestionDisplay.dataset.suggestion) {
                    e.preventDefault();
                    const correctedText = suggestionDisplay.dataset.suggestion;
                    this.value = correctedText + ' ';
                    suggestionDisplay.classList.remove('visible');
                    suggestionDisplay.dataset.suggestion = '';
                    autoResizeTextarea(this);
                    this.selectionStart = this.selectionEnd = this.value.length;
                }
            }

            // Xử lý phím Escape trong ô tìm kiếm (giữ nguyên)
            if (e.key === 'Escape') {
                e.preventDefault();
                this.blur();
            }
        });

        // Thêm sự kiện click vào ô gợi ý để chấp nhận (UX bonus)
        const suggestionDisplay = searchGroup.querySelector('.autocorrect-suggestion-display');
        suggestionDisplay.addEventListener('click', function () {
            if (this.classList.contains('visible') && this.dataset.suggestion) {
                const correctedText = this.dataset.suggestion;
                textInput.value = correctedText + ' ';

                this.classList.remove('visible');
                this.dataset.suggestion = '';

                autoResizeTextarea(textInput);
                textInput.focus(); // Focus lại vào ô search
                textInput.selectionStart = textInput.selectionEnd = textInput.value.length;
            }
        });

        // Enter key search
        textInput.addEventListener('keypress', function (e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const searchQuery = this.value;

                // Thực hiện tìm kiếm
                performSearch(searchQuery, 'text', searchGroup);
            }
        });

        textInput.addEventListener('keydown', function (e) {
            // Chỉ xử lý khi người dùng nhấn mũi tên lên hoặc xuống
            if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {

                // 1. Lấy tất cả các ô tìm kiếm đang có trên trang theo đúng thứ tự
                const allInputs = Array.from(document.querySelectorAll('.search-inputs-container .search-input'));

                // 2. Tìm vị trí (index) của ô tìm kiếm hiện tại mà bạn đang focus
                const currentIndex = allInputs.indexOf(this);

                let nextInput = null;

                // 3. Xác định ô tìm kiếm tiếp theo dựa trên phím được nhấn
                if (e.key === 'ArrowUp') {
                    // Nếu không phải là ô đầu tiên, lấy ô ở trên nó
                    if (currentIndex > 0) {
                        nextInput = allInputs[currentIndex - 1];
                    }
                } else { // (e.key === 'ArrowDown')
                    // Nếu không phải là ô cuối cùng, lấy ô ở dưới nó
                    if (currentIndex < allInputs.length - 1) {
                        nextInput = allInputs[currentIndex + 1];
                    }
                }

                // 4. Nếu đã tìm thấy ô tiếp theo, di chuyển focus đến đó
                if (nextInput) {
                    // Ngăn hành vi mặc định của phím mũi tên (di chuyển con trỏ trong textarea)
                    e.preventDefault();

                    // Di chuyển focus
                    nextInput.focus();

                    // (Tùy chọn UX) Đặt con trỏ ở cuối văn bản trong ô mới
                    const len = nextInput.value.length;
                    nextInput.setSelectionRange(len, len);
                }
            }
        });

        // Image upload click
        uploadZone.addEventListener('click', function () {
            imageInput.click();
        });

        // Image file selection
        imageInput.addEventListener('change', function (e) {
            const file = e.target.files[0];
            if (file) {
                handleImageUpload(file, searchGroup);
            }
        });

        // Drag and drop
        uploadZone.addEventListener('dragover', function (e) {
            e.preventDefault();
            this.classList.add('drag-over');
        });

        uploadZone.addEventListener('dragleave', function (e) {
            e.preventDefault();
            this.classList.remove('drag-over');
        });

        uploadZone.addEventListener('drop', function (e) {
            e.preventDefault();
            this.classList.remove('drag-over');

            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('image/')) {
                handleImageUpload(file, searchGroup);
            }
        });




        // Remove image
        removeImageBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            uploadedImageDiv.style.display = 'none';
            imageInput.value = '';
        });

        // 1. Làm cho vùng upload có thể nhận focus
        uploadZone.setAttribute('tabindex', '0');
        // Thêm một chút style để loại bỏ đường viền focus mặc định khó coi
        uploadZone.style.outline = 'none';

        // 2. Gắn listener sự kiện 'paste' trực tiếp vào vùng upload
        uploadZone.addEventListener('paste', function (e) {
            if (currentSearchMode !== 'image-to-image') return;

            const clipboardItems = e.clipboardData.items;
            if (!clipboardItems) return;

            for (let i = 0; i < clipboardItems.length; i++) {
                if (clipboardItems[i].kind === 'file' && clipboardItems[i].type.startsWith('image/')) {
                    e.preventDefault();
                    const imageFile = clipboardItems[i].getAsFile();
                    if (imageFile) {
                        showToastNotification("Đã nhận ảnh từ clipboard, bắt đầu tìm kiếm...", "success");
                        handleImageUpload(imageFile, searchGroup);
                    }
                    break;
                }
            }
        });

        // 3. Focus vào vùng upload khi di chuột vào
        uploadZone.addEventListener('mouseenter', function () {
            uploadZone.classList.add('paste-active');
            uploadZone.focus(); // Chuyển sự chú ý của trình duyệt vào đây
        });

        // 4. Bỏ focus khi di chuột ra
        uploadZone.addEventListener('mouseleave', function () {
            uploadZone.classList.remove('paste-active');
            uploadZone.blur(); // Bỏ focus
        });

    }

    function handleImageUpload(file, searchGroup) {
        const uploadedImageDiv = searchGroup.querySelector('.uploaded-image');
        const img = uploadedImageDiv.querySelector('img');

        const reader = new FileReader();
        reader.onload = function (e) {
            img.src = e.target.result;
            uploadedImageDiv.style.display = 'block';

            // Automatically perform search when image is uploaded
            performSearch(file, 'image', searchGroup);
        };
        reader.readAsDataURL(file);
    }

    async function performSearch(query, type, searchGroup) {
        if (type === 'text') {
            // Lấy giá trị từ các ô lọc đang hoạt động
            saveQueryToHistory(query);
            const ocrInput = searchGroup.querySelector('.ocr-input');
            const tagInput = searchGroup.querySelector('.tag-input');
            const asrInput = searchGroup.querySelector('.asr-input');
            // Chỉ lấy giá trị nếu nút filter tương ứng đang active
            const ocrValue = ocrFilterBtn.classList.contains('active') && ocrInput ? ocrInput.value.trim() : '';
            const tagValue = tagFilterBtn.classList.contains('active') && tagInput ? tagInput.value.trim() : '';
            const asrValue = asrFilterBtn.classList.contains('active') && asrInput ? asrInput.value.trim() : '';
            // Chỉ dừng lại nếu TẤT CẢ các ô nhập liệu (cả search và filter) đều trống
            if (!query.trim() && !ocrValue && !tagValue && !asrValue) {
                showToastNotification("Please enter a search query or a filter value.", "error");
                return; // Dừng hàm tại đây
            }
        } else if (type === 'image' && !query) {
            // Giữ nguyên logic cũ cho tìm kiếm bằng hình ảnh
            return;
        }

        showLoadingIndicator();
        const filterOptions = {};
        if (isEventFilterEnabled) { // <<< THÊM DÒNG NÀY
            filterOptions.use_event_filter = true;
        }

        if (searchGroup) {
            if (ocrFilterBtn.classList.contains('active')) {
                const ocrInput = searchGroup.querySelector('.ocr-input');
                if (ocrInput && ocrInput.value.trim() !== '') {
                    filterOptions.ocr = ocrInput.value.trim();
                    const ocrFuzzySwitch = searchGroup.querySelector('.ocr-filter-container input[type="checkbox"]');
                    if (ocrFuzzySwitch && ocrFuzzySwitch.checked) {
                        filterOptions.ocr_fuzzy = true;
                    }
                    const ocrModeSelect = searchGroup.querySelector('.ocr-filter-container .ocr-mode-select');
                    if (ocrModeSelect) {
                        filterOptions.ocr_mode = ocrModeSelect.value;
                    }
                }
            }

            if (tagFilterBtn.classList.contains('active')) {
                const tagInput = searchGroup.querySelector('.tag-input');
                if (tagInput && tagInput.value.trim() !== '') {
                    const tags = tagInput.value.split(',').map(tag => tag.trim()).filter(tag => tag);
                    if (tags.length > 0) {
                        filterOptions.use_tag = true;
                        filterOptions.tags_filter = tags;
                    }
                }
            }

            if (asrFilterBtn.classList.contains('active')) {
                const asrInput = searchGroup.querySelector('.asr-input');
                if (asrInput && asrInput.value.trim() !== '') {
                    filterOptions.asr = asrInput.value.trim();
                    const asrFuzzySwitch = searchGroup.querySelector('.asr-filter-container input[type="checkbox"]');
                    if (asrFuzzySwitch && asrFuzzySwitch.checked) {
                        filterOptions.asr_fuzzy = true;
                    }
                }
            }
        }

        try {
            let finalQuery = query;

            let searchPromise;
            if (type === 'text') {
                if (currentSearchMode === 'text-to-image') {
                    // Tách riêng logic temporal search
                    const isFirstSearch = !searchGroup.previousElementSibling;
                    if (isFirstSearch) {
                        searchPromise = callTemporalSearchStart(finalQuery, currentSelectedModel, filterOptions, searchGroup)
                            .then(response => {
                                handleSearchResults(response.initial_results, false);
                                manageNextSearchInput();
                            });
                    } else {
                        searchPromise = callTemporalSearchContinue(finalQuery, currentUserId, filterOptions, searchGroup)
                            .then(response => {
                                handleSearchResults(response.query_A_reranked, true);
                                manageNextSearchInput();
                            });
                    }
                } else if (currentSearchMode === 'text-to-text') {
                    searchPromise = callTextToTextAPI(finalQuery, currentSelectedModel, filterOptions)
                        .then(results => {
                            handleSearchResults(results, false);
                            manageNextSearchInput();
                        });
                }
            } else if (type === 'image' && currentSearchMode === 'image-to-image') {
                // *** BẮT ĐẦU THAY ĐỔI ***
                let imageFilePromise;

                if (typeof query === 'string') {
                    // TRƯỜNG HỢP 1: Semantic search (query là một đường dẫn URL)
                    // Chúng ta cần chuyển URL thành một đối tượng File
                    imageFilePromise = fetch(query)
                        .then(response => response.blob())
                        .then(blob => new File([blob], "semantic_search_image.jpg", { type: blob.type }));
                } else {
                    // TRƯỜNG HỢP 2: Tải ảnh lên (query đã là một đối tượng File)
                    imageFilePromise = Promise.resolve(query);
                }

                // `searchPromise` sẽ đợi cho đến khi có File object
                searchPromise = imageFilePromise.then(imageFile => {
                    return callImageToImageAPI(imageFile, currentSelectedModel)
                        .then(results => handleSearchResults(results, false));
                });
                // *** KẾT THÚC THAY ĐỔI ***
            }

            await searchPromise;

            // *** ĐOẠN CODE QUAN TRỌNG NHẤT ĐƯỢC THÊM VÀO ĐÂY ***
            if (!isRestoringState) {
                const currentState = buildStateObject();
                const historyUrl = new URL(window.location.href);
                historyUrl.searchParams.set('search_timestamp', Date.now());
                window.history.pushState(currentState, '', `${historyUrl.pathname}${historyUrl.search}${historyUrl.hash}`);
            }

        } catch (error) {
            handleSearchError(error);
        } finally {
        }
    }


    function manageNextSearchInput() {
        // === Giai đoạn 1: Tìm kiếm một ô trống đã tồn tại ===
        const allInputs = document.querySelectorAll('.search-inputs-container .search-input');

        let firstEmptyInput = null;
        for (const input of allInputs) {
            // Một ô được coi là "trống" nếu nó không có text VÀ không có filter nào đang áp dụng cho nó
            const searchGroup = input.closest('.search-input-group');
            const ocrValue = searchGroup.querySelector('.ocr-input')?.value.trim();
            const tagValue = searchGroup.querySelector('.tag-input')?.value.trim();
            const asrValue = searchGroup.querySelector('.asr-input')?.value.trim();
            // Giả sử filter chỉ áp dụng cho ô tìm kiếm đầu tiên (theo logic toggleFilter của bạn)
            const isFilterActiveOnThisInput =
                (ocrFilterBtn.classList.contains('active') && ocrValue) ||
                (tagFilterBtn.classList.contains('active') && tagValue) ||
                (asrFilterBtn.classList.contains('active') && asrValue);
            if (input.value.trim() === '' && !isFilterActiveOnThisInput) {
                firstEmptyInput = input;
                break; // Dừng lại ngay khi tìm thấy ô trống đầu tiên
            }
        }

        // Nếu tìm thấy một ô trống, focus vào đó và kết thúc hàm
        if (firstEmptyInput) {
            console.log('Found an existing empty input. Focusing on it.');
            setTimeout(() => {
                firstEmptyInput.focus();
                firstEmptyInput.scrollIntoView({ behavior: 'auto', block: 'center' });
            }, 50);
            return; // << Rất quan trọng: Kết thúc hàm tại đây
        }

        // === Giai đoạn 2: Nếu không có ô trống nào, quyết định có nên tạo ô mới không ===
        // Logic này chỉ chạy khi tất cả các ô hiện có đều đã được điền hoặc có filter.
        // Đây là lúc logic gốc của bạn phát huy tác dụng.

        console.log('All existing inputs are in use. Creating a new one.');
        const newInput = createNewSearchInput();
        setTimeout(() => {
            newInput.focus();
            newInput.scrollIntoView({ behavior: 'auto', block: 'center' });
        }, 50);
    }
    function callTextToTextAPI(query, modelName, filterOptions = {}) {
        const body = { query, cluster_mode_enabled: clusterModeEnabled };
        if (modelName && modelName !== 'all') {
            body.model_name = modelName;
        }
        if (filterOptions.use_event_filter) {
            body.use_event_filter = true;
        }
        if (filterOptions.use_tag && filterOptions.tags_filter) {
            body.use_tag = true;
            body.tags_filter = filterOptions.tags_filter;
        }
        if (filterOptions.ocr) {
            body.ocr = filterOptions.ocr;
            if (filterOptions.ocr_mode) {
                body.ocr_mode = filterOptions.ocr_mode;
            }
        }
        if (filterOptions.asr) {
            body.asr = filterOptions.asr;
        }

        return fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/search/text-to-text`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })
            .then(res => res.ok ? res.json() : Promise.reject(res))
            .catch(err => {
                console.error("Text-to-text API call failed:", err);
                throw err;
            });
    }

    function callTemporalSearchStart(query, modelName, filterOptions, searchGroup) {
        const queryId = searchGroup.dataset.searchId;
        const body = {
            query: query,
            user_id: currentUserId,
            query_id: queryId,
            cluster_mode_enabled: clusterModeEnabled
        };
        if (filterOptions.use_event_filter) { // <<< THÊM KHỐI LỆNH NÀY
            body.use_event_filter = true;
        }

        if (modelName !== 'all') { // Chỉ gửi nếu không phải mặc định
            body.model_name = modelName;
        }

        if (filterOptions.use_tag && filterOptions.tags_filter) {
            body.use_tag = true;
            body.tags_filter = filterOptions.tags_filter;
        }
        if (filterOptions.ocr) {
            body.ocr = filterOptions.ocr;
            if (filterOptions.ocr_mode) {
                body.ocr_mode = filterOptions.ocr_mode;
            }
        }

        if (filterOptions.asr) {
            body.asr = filterOptions.asr;
        }

        if (filterOptions.ocr_fuzzy) {
            body.ocr_fuzzy = true;
        }
        if (filterOptions.asr_fuzzy) {
            body.asr_fuzzy = true;
        }

        return fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/search/temporal/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })
            .then(res => res.ok ? res.json() : Promise.reject(res));
    }

    // Hàm này được gọi khi tìm kiếm query B, C...
    function callTemporalSearchContinue(query, chainId, filterOptions, searchGroup) {
        const queryId = searchGroup.dataset.searchId;
        const body = {
            query: query,
            chain_id: chainId,
            query_id: queryId,
            cluster_mode_enabled: clusterModeEnabled
        };
        if (filterOptions.use_event_filter) {
            body.use_event_filter = true;
        }
        if (filterOptions.use_tag && filterOptions.tags_filter) {
            body.use_tag = true;
            body.tags_filter = filterOptions.tags_filter;
        }
        if (filterOptions.ocr) {
            body.ocr = filterOptions.ocr;
            if (filterOptions.ocr_mode) {
                body.ocr_mode = filterOptions.ocr_mode;
            }
        }
        if (filterOptions.asr) {
            body.asr = filterOptions.asr;
        }
        if (filterOptions.ocr_fuzzy) {
            body.ocr_fuzzy = true;
        }
        if (filterOptions.asr_fuzzy) {
            body.asr_fuzzy = true;
        }

        return fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/search/temporal/continue`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })
            .then(res => res.ok ? res.json() : Promise.reject(res));
    }

    function callTextToImageAPI(query, modelName, filterOptions = {}) {
        const body = { query, cluster_mode_enabled: clusterModeEnabled };
        if (modelName && modelName !== 'all') {
            body.model_name = modelName;
        }
        if (filterOptions.use_event_filter) {
            body.use_event_filter = true;
        }
        if (filterOptions.use_tag && filterOptions.tags_filter) {
            body.use_tag = true;
            body.tags_filter = filterOptions.tags_filter;
        }
        if (filterOptions.ocr) {
            body.ocr = filterOptions.ocr;
        }
        if (filterOptions.asr) {
            body.asr = filterOptions.asr;
        }

        return fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/search/text-to-image`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })
            .then(res => res.ok ? res.json() : Promise.reject(res))
            .catch(err => {
                console.error("Text-to-image API call failed:", err);
                throw err;
            });
    }

    function callImageToImageAPI(imageFile, modelName) { // Thêm modelName
        const formData = new FormData();
        formData.append("file", imageFile);
        formData.append("cluster_mode_enabled", String(clusterModeEnabled));
        if (modelName !== 'all') { // Chỉ gửi nếu không phải mặc định
            formData.append("model_name", modelName);
        }

        if (isEventFilterEnabled) {
            formData.append("use_event_filter", "true");
        }

        return fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/search/image`, {
            method: "POST",
            body: formData,
        })
            .then(res => res.ok ? res.json() : Promise.reject(res))
            .catch(err => {
                console.error("Image-to-image API call failed:", err);
                throw err;
            });
    }
    async function handleSearchResults(images, isReranked = false) {
        currentResultsAreReranked = isReranked;
        // 1. Dọn dẹp trạng thái cũ
        if (window.currentInfiniteScrollObserver) {
            window.currentInfiniteScrollObserver.disconnect();
        }
        if (!images || images.length === 0) {
            contentArea.innerHTML = `<div class="content-placeholder"><h2>Không tìm thấy kết quả</h2><p>Vui lòng thử lại.</p></div>`;
            return;
        }

        await initialStateReady;

        const getSortScore = image => {
            const primaryScore = isReranked ? image.temporal_score : image.score;
            const fallbackScore = isReranked ? image.score : image.temporal_score;
            return Number(primaryScore ?? fallbackScore ?? 0);
        };

        const markedImages = images.map(image => {
            return {
                ...image, // Giữ lại tất cả thông tin cũ của frame
                isInQueue: queuedFramesSet.has(image.frameIdentifier) // Thêm thuộc tính mới
            };
        }).sort((a, b) => getSortScore(b) - getSortScore(a));

        allImages = markedImages;
        frameSelectionManager.clearAllSelections();
        contentArea.innerHTML = '';
        isLoading = false;
        hasReachedEnd = false;
        const loadingMore = document.createElement('div');
        loadingMore.id = 'loadingMore';
        loadingMore.innerHTML = '<div class="loading-spinner"></div><p>Đang tải thêm...</p>';
        loadingMore.style.display = 'none';
        contentArea.appendChild(loadingMore); // Thêm vào cuối cùng của contentArea đang trống

        // 3. Phân nhánh logic dựa trên layout hiện tại
        if (currentLayout === 'grid') {
            displayedImagesCount = 0;
            renderGridLayout(isReranked); // Tạo cấu trúc cột rỗng, sẽ được chèn VÀO TRƯỚC "loadingMore"

            setupInfiniteScrollForGrid();
            loadMoreImages();

        } else {
            allGroupedData = groupResultsByVideo(allImages, isReranked);
            displayedGroupsCount = 0;

            setupInfiniteScrollForGroups();
            loadMoreGroups();
        }
        updateSearchResultsQueueStatus();
    }

    function resetOcrFiltering() {
        isOcrFilterEnabled = false;
        if (ocrFilterBtn) {
            ocrFilterBtn.classList.remove('active');
        }
        // document.querySelectorAll('.ocr-filter-container.visible').forEach(container => {
        //     container.classList.remove('visible');
        // });
    }

    function loadMoreImages() {
        if (isLoading || hasReachedEnd) return;

        isLoading = true;
        const loadingMore = document.getElementById('loadingMore');

        if (loadingMore) loadingMore.style.display = 'flex';

        // Tìm các cột masonry đã tồn tại
        const columns = document.querySelectorAll('.masonry-column');
        if (columns.length === 0) {
            isLoading = false;
            if (loadingMore) loadingMore.style.display = 'none';
            return;
        }

        const startIndex = displayedImagesCount;
        const endIndex = Math.min(startIndex + IMAGES_PER_BATCH, allImages.length);

        if (startIndex >= allImages.length) {
            hasReachedEnd = true;
            isLoading = false;
            if (loadingMore) loadingMore.style.display = 'none';
            return;
        }

        setTimeout(() => {
            for (let i = startIndex; i < endIndex; i++) {
                const image = allImages[i];
                const imageItem = createImageItemElement(image);
                const columnIndex = i % columns.length;
                columns[columnIndex].appendChild(imageItem);
            }

            displayedImagesCount = endIndex;

            if (displayedImagesCount >= allImages.length) {
                hasReachedEnd = true;
                if (loadingMore) loadingMore.style.display = 'none';
            }

            isLoading = false;
        }, 100);
    }

    // Thiết lập Intersection Observer để phát hiện khi cuộn đến cuối trang
    function setupInfiniteScroll() {
        // Tìm hoặc tạo phần tử "loadingMore"
        let loadingMore = document.getElementById('loadingMore');
        if (!loadingMore) {
            loadingMore = document.createElement('div');
            loadingMore.className = 'loading-more';
            loadingMore.id = 'loadingMore';
            loadingMore.innerHTML = '<div class="loading-spinner"></div><p>Đang tải thêm...</p>';
            loadingMore.style.display = 'none';
            contentArea.appendChild(loadingMore);
        }

        // Tạo Intersection Observer
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                // Nếu phần tử loadingMore hiển thị trong viewport
                if (entry.isIntersecting && !isLoading && !hasReachedEnd) {
                    loadMoreImages(); // Tải thêm ảnh
                }
            });
        }, {
            root: null, // viewport
            rootMargin: '0px 0px 200px 0px', // trigger trước khi đến cuối 200px
            threshold: 0.1 // kích hoạt khi ít nhất 10% phần tử hiển thị
        });

        // Theo dõi phần tử loadingMore
        observer.observe(loadingMore);

        // Lưu observer để có thể disconnect khi cần
        window.currentInfiniteScrollObserver = observer;
    }

    function showLoadingIndicator() {
        // Ngắt kết nối observer cũ nếu có
        if (window.currentInfiniteScrollObserver) {
            window.currentInfiniteScrollObserver.disconnect();
            window.currentInfiniteScrollObserver = null;
        }

        contentArea.innerHTML = `
        <div class="loading-indicator">
        <div class="loading-spinner"></div>
        <p>Đang tìm kiếm...</p>
        </div>
        `;
    }





    function handleSearchError(error) {
        console.error('Search error:', error);
        contentArea.innerHTML = `
        <div class="content-placeholder">
        <h2>Lỗi tìm kiếm</h2>
        <p>Đã xảy ra lỗi khi tìm kiếm. Vui lòng thử lại.</p>
        </div>
        `;
    }
    const videoInfoCache = {};

    function showToastNotification(message, type = 'success', duration = 2000) {
        const toast = document.createElement('div');
        toast.className = `toast-notification ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Kích hoạt animation
        setTimeout(() => {
            toast.classList.add('show');
        }, 10);

        // Tự động xóa sau một khoảng thời gian
        setTimeout(() => {
            toast.classList.remove('show');
            toast.addEventListener('transitionend', () => toast.remove());
        }, duration);
    }
    function showGlobalAlert(username, type = 'special') {
        // Ngăn tạo nhiều thông báo cùng lúc
        if (document.querySelector('.global-alert-notification')) {
            return;
        }

        let config = {
            text: '',
            cssClass: '',
            duration: 800 // Mặc định
        };

        // Cấu hình dựa trên loại thông báo
        if (type === 'correct') {
            config.text = `<span>${username.toUpperCase()}</span> NHÌN MÀ HỌC HỎI ĐI MẤY CON CHÓ!`;
            config.cssClass = 'is-correct'; // Class cho màu xanh
            config.duration = 4000; // Hiển thị lâu hơn để chúc mừng
        } else if (type === 'special') { // Mặc định là 'special'
            config.text = `<span>${username.toUpperCase()}</span> ĐÚNG MẸ NÓ RỒI NỘP ĐI!`;
            config.cssClass = 'is-special';
        } else {
            config.text = `<span>${username.toUpperCase()}</span> GET OUTTTTTT!`;
            config.cssClass = 'is-special';
        }

        const alertDiv = document.createElement('div');
        // Thêm cả class cơ sở và class loại thông báo
        alertDiv.className = `global-alert-notification ${config.cssClass}`;
        alertDiv.innerHTML = config.text;

        document.body.appendChild(alertDiv);

        // Kích hoạt animation
        setTimeout(() => {
            alertDiv.classList.add('show');
        }, 20);

        // Tự động ẩn đi sau một khoảng thời gian
        setTimeout(() => {
            alertDiv.classList.remove('show');
            alertDiv.addEventListener('transitionend', () => {
                alertDiv.remove();
            });
        }, config.duration);
    }
    // ====== BẮT ĐẦU PHIÊN BẢN MỚI CỦA HÀM OPENIMAGEMODAL ======

    async function openImageModal(clickedFrameData) {
        if (!clickedFrameData || !clickedFrameData.videoName || typeof clickedFrameData.frame_id_ori === 'undefined') {
            showToastNotification("Lỗi: Dữ liệu frame không đầy đủ để mở modal.", "error");
            console.error("Dữ liệu không hợp lệ được truyền cho openImageModal:", clickedFrameData);
            return;
        }

        const modal = document.getElementById('imageModal');
        const mainPreview = document.getElementById('mainPreviewImage');
        const thumbnailStrip = document.getElementById('thumbnailStrip');
        const modalFrameInfo = document.getElementById('modalFrameInfo');
        const mainPreviewOverlay = document.getElementById('mainPreviewOverlay');

        let currentModalFrameData = null;

        const videoId = clickedFrameData.videoName;
        const targetFrameIdOri = clickedFrameData.frame_id_ori;

        let neighborFrames = []; // Biến này sẽ chứa các frame lân cận sau khi xử lý

        try {
            // === BẮT ĐẦU PHẦN THAY THẾ LOGIC API ===

            // 1. Tải file metadata.json từ Nginx
            const metadataUrl = getFrameMetadataUrl(videoId);
            const response = await fetch(metadataUrl);

            if (!response.ok) {
                throw new Error(`Không tìm thấy tệp ${metadataUrl}. Status: ${response.statusText}`);
            }
            const metadataFileContent = await response.json();
            const videoMetadataObject = metadataFileContent[videoId];

            if (!videoMetadataObject) {
                throw new Error(`Không tìm thấy key '${videoId}' trong tệp metadata.json.`);
            }

            // 2. Chuyển đổi và "CHUẨN HÓA" đối tượng metadata thành một MẢNG
            const allKeyframes = Object.entries(videoMetadataObject).map(([frameKey, frameInfo]) => ({
                // Ánh xạ (map) các thuộc tính từ file JSON sang tên mà code đang dùng
                frame_id_ori: frameInfo.id,
                timestamp: frameInfo["time-stamp"],
                filename: `${frameKey}.webp`,
                ...frameInfo
            }));

            // 3. SẮP XẾP mảng theo frame_id_ori
            allKeyframes.sort((a, b) => a.frame_id_ori - b.frame_id_ori);

            // 4. Tìm vị trí (index) của frame được click
            const targetFrameId = parseInt(targetFrameIdOri, 10);
            const targetIndex = allKeyframes.findIndex(kf => kf.frame_id_ori === targetFrameId);

            if (targetIndex === -1) {
                throw new Error(`Frame ID ${targetFrameId} không tìm thấy trong metadata của video ${videoId}.`);
            }

            // 5. Cắt ra các frame lân cận (modal này lấy nhiều hơn: 50 trước, 50 sau)
            const lookBehind = 50;
            const lookAhead = 50;
            const startIndex = Math.max(0, targetIndex - lookBehind);
            const endIndex = Math.min(allKeyframes.length, targetIndex + lookAhead + 1);

            // Gán kết quả vào biến neighborFrames để phần code sau sử dụng
            neighborFrames = allKeyframes.slice(startIndex, endIndex);

            // === KẾT THÚC PHẦN THAY THẾ LOGIC API ===

            if (neighborFrames.length === 0) {
                showToastNotification("Không tìm thấy frame lân cận.", "info");
                return;
            }

        } catch (error) {
            console.error("Lỗi khi tải frame lân cận từ file tĩnh (trong openImageModal):", error);
            showToastNotification("Lỗi: Không thể tải dữ liệu frame lân cận.", "error");
            return;
        }

        // =========================================================================
        // PHẦN CÒN LẠI CỦA HÀM KHÔNG CẦN THAY ĐỔI GÌ CẢ
        // Nó sẽ tự động hoạt động với biến `neighborFrames` chúng ta vừa tạo ở trên
        // =========================================================================

        function updateMainPreview(frameDataToDisplay) {
            if (!frameDataToDisplay || (currentModalFrameData && currentModalFrameData.frame_id_ori === frameDataToDisplay.frame_id_ori)) {
                return;
            }

            const framePath = getFrameUrl(videoId, frameDataToDisplay.filename);
            setFrameImageSource(mainPreview, framePath);

            currentModalFrameData = {
                path: framePath,
                videoName: videoId,
                timestamp: frameDataToDisplay.timestamp,
                frameIdentifier: `${videoId}_${frameDataToDisplay.frame_id_ori}`,
                frame_id_ori: frameDataToDisplay.frame_id_ori,
                isFromVideo: false
            };

            modalFrameInfo.textContent = currentModalFrameData.frameIdentifier;

            const oldCurrent = thumbnailStrip.querySelector('.current-frame');
            if (oldCurrent) oldCurrent.classList.remove('current-frame');
            const newCurrent = thumbnailStrip.querySelector(`[data-frame-id-ori='${frameDataToDisplay.frame_id_ori}']`);
            if (newCurrent) {
                newCurrent.classList.add('current-frame');
                newCurrent.scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' });
            }

            mainPreviewOverlay.onclick = () => {
                if (currentModalFrameData && currentModalFrameData.videoName && currentModalFrameData.timestamp) {
                    openVideoModal(currentModalFrameData.videoName, currentModalFrameData.timestamp);
                } else {
                    console.error("Dữ liệu không hợp lệ để mở video:", currentModalFrameData);
                    showToastNotification("Lỗi: Không đủ thông tin để mở video.", "error");
                }
            };
            mainPreviewOverlay.oncontextmenu = (event) => {
                event.preventDefault();
                if (currentModalFrameData && currentModalFrameData.videoName && currentModalFrameData.timestamp) {
                    openVideoModal(currentModalFrameData.videoName, currentModalFrameData.timestamp);
                } else {
                    console.error("Dữ liệu không hợp lệ để mở video:", currentModalFrameData);
                    showToastNotification("Lỗi: Không đủ thông tin để mở video.", "error");
                }
            };
        }

        const wheelHandler = (e) => {
            e.preventDefault();
            if (!currentModalFrameData) return;

            const currentIndex = neighborFrames.findIndex(f => f.frame_id_ori === currentModalFrameData.frame_id_ori);
            if (currentIndex === -1) return;

            let nextIndex = currentIndex + (e.deltaY > 0 ? 1 : -1);
            nextIndex = Math.max(0, Math.min(neighborFrames.length - 1, nextIndex));

            if (nextIndex !== currentIndex) {
                updateMainPreview(neighborFrames[nextIndex]);
            }
        };

        const keydownHandler = (e) => {
            if (getTopActiveModal()?.element !== modal) {
                return;
            }

            const key = e.key.toLowerCase();

            if (key === 'escape') { closeModal(); return; }
            if (key === 'arrowright' || key === 'arrowleft') {
                wheelHandler({ preventDefault: () => { }, deltaY: key === 'arrowright' ? 1 : -1 });
                return;
            }

            if (!currentModalFrameData) return;
            e.preventDefault();

            if (key === 'd' || key === 'a') {
                const isSpecial = key === 'a';
                const frameDataToSend = { ...currentModalFrameData, isSpecial: isSpecial };
                addFramesToQueue([frameDataToSend]);
                closeModal();
            }
            else if (key === 'v') {
                e.preventDefault();
                addToFormSubmitQueue(currentModalFrameData);
            }
            else if (key === 's') {
                e.preventDefault();
                const frameDataForSearch = currentModalFrameData;
                closeModal();
                setTimeout(() => {
                    openSemanticSearchModal(frameDataForSearch);
                }, 100);
            }
        };

        function closeModal(onClosedCallback = null) {
            modal.removeEventListener('wheel', wheelHandler);
            document.removeEventListener('keydown', keydownHandler);
            mainPreviewOverlay.onclick = null;

            modal.style.display = 'none';
            mainPreview.src = "";

            registerModalClose(modal);

            if (typeof onClosedCallback === 'function') {
                setTimeout(onClosedCallback, 50);
            }
        }

        thumbnailStrip.innerHTML = '';

        neighborFrames.forEach(frameData => {
            const thumb = document.createElement('img');
            setFrameImageSource(thumb, getFrameUrl(videoId, frameData.filename));
            thumb.title = `${videoId}_${frameData.frame_id_ori}`;
            thumb.dataset.frameIdOri = frameData.frame_id_ori;

            thumb.addEventListener('click', () => {
                updateMainPreview(frameData);
            });

            if (frameData.frame_id_ori === parseInt(targetFrameIdOri, 10)) {
                thumb.classList.add('active-frame');
            }
            thumbnailStrip.appendChild(thumb);
        });

        modal.addEventListener('wheel', wheelHandler, { passive: false });
        document.addEventListener('keydown', keydownHandler);
        modal.querySelector('.modal-overlay').onclick = () => closeModal();

        const initialFrame = neighborFrames.find(f => f.frame_id_ori === parseInt(targetFrameIdOri, 10));
        if (initialFrame) {
            updateMainPreview(initialFrame);
        }

        registerModalOpen(modal, closeModal);
        modal.style.display = 'flex';

        setTimeout(() => {
            const activeThumb = thumbnailStrip.querySelector('.active-frame');
            if (activeThumb) activeThumb.scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' });
        }, 50);
    }

    function parseTimestamp(inputTimestamp) {
        if (inputTimestamp === null || inputTimestamp === undefined || inputTimestamp === '') {
            return 0;
        }

        if (typeof inputTimestamp === 'number') {
            return inputTimestamp; // Trả về trực tiếp
        }

        if (typeof inputTimestamp === 'string') {
            if (inputTimestamp.includes(':')) {
                const parts = inputTimestamp.split(':');
                if (parts.length === 2) {
                    const minutes = parseInt(parts[0], 10);
                    const seconds = parseFloat(parts[1]);
                    if (!isNaN(minutes) && !isNaN(seconds)) {
                        return (minutes * 60) + seconds;
                    }
                }
            }
            else {
                const numericValue = parseFloat(inputTimestamp);
                if (!isNaN(numericValue)) {
                    return numericValue;
                }
            }
        }

        console.warn(`Không thể phân tích định dạng timestamp: "${inputTimestamp}". Mặc định là 0 giây.`);
        return 0;
    }

    function getVideoPlaybackSource(videoName) {
        if (videoServeLocation === 'remote') {
            return {
                type: 'hls',
                url: `${APP_CONFIG.REMOTE_BASE_URL}/videos_hls/${encodeURIComponent(videoName)}/playlist.m3u8`
            };
        }

        const localVideoName = videoName.toLowerCase().endsWith('.mp4') ? videoName : `${videoName}.mp4`;
        return { type: 'mp4', url: `/videos/${encodeURIComponent(localVideoName)}` };
    }

    // Keep legacy form/video capture paths on the same source switch.
    function getHlsPlaylistUrl(videoName) {
        return getVideoPlaybackSource(videoName).url;
    }

    function openVideoModal(videoName, timestamp) {

        if (isTrakeMode) {
            toggleTrakeMode(false);
        }
        currentVideoModalData = { videoName, timestamp };

        const modal = document.getElementById('videoModal');
        const player = document.getElementById('videoPlayer');
        const closeBtn = document.getElementById('closeVideoModalBtn');
        const captureCanvas = document.getElementById('frameCaptureCanvas');

        const playPauseBtn = document.getElementById('playPauseBtn');
        const playIcon = playPauseBtn.querySelector('i');
        const seekBackwardBtn = document.getElementById('seekBackwardBtn');
        const seekForwardBtn = document.getElementById('seekForwardBtn');
        const seekSlider = document.getElementById('videoSeekSlider');
        const currentTimeDisplay = document.getElementById('currentTimeDisplay');
        const durationDisplay = document.getElementById('durationDisplay');

        const muteBtn = document.getElementById('muteBtn');
        const volumeIcon = muteBtn.querySelector('i');
        const volumeSlider = document.getElementById('volumeSlider');

        const SKIP_TIME = 1;
        const FAST_FORWARD_RATE = 2.5;

        let isSeeking = false;
        let rewindInterval = null;

        if (!videoName || !timestamp) {
            showToastNotification("Thiếu thông tin video hoặc timestamp.", "error");
            return;
        }

        prepareTrakeTimeline(videoName, parseTimestamp(timestamp));

        console.log("time:", timestamp);
        const formatTime = (timeInSeconds) => {
            const minutes = Math.floor(timeInSeconds / 60);
            const seconds = Math.floor(timeInSeconds % 60);
            return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        };

        const togglePlayPause = () => player.paused ? player.play() : player.pause();

        const updatePlayButton = () => {
            playIcon.classList.toggle('fa-play', player.paused);
            playIcon.classList.toggle('fa-pause', !player.paused);
        };

        const updateSlider = () => {
            if (!isSeeking && player.duration) {
                seekSlider.value = player.currentTime;
                currentTimeDisplay.textContent = formatTime(player.currentTime);
            }
        };

        const toggleMute = () => {
            player.muted = !player.muted;
        };

        const updateVolumeUI = () => {
            if (player.muted || player.volume === 0) {
                volumeIcon.className = 'fas fa-volume-xmark';
                volumeSlider.value = 0;
            } else {
                volumeIcon.className = 'fas fa-volume-up';
                volumeSlider.value = player.volume;
            }
        };

        const handleVolumeChange = () => {
            player.volume = volumeSlider.value;
            if (player.volume > 0) {
                player.muted = false;
            }
        };

        const handleSeekInput = () => {
            player.currentTime = seekSlider.value;
        };
        const handleSeekMouseDown = () => {
            isSeeking = true;
        };
        const handleSeekMouseUp = () => {
            isSeeking = false;
        };
        let nativeLoadedMetadataHandler = null;
        let playerErrorHandler = null;

        // <<< BẮT ĐẦU THAY ĐỔI >>>
        // Hàm onLoadedMetadata bây giờ chỉ tập trung vào việc cập nhật UI
        // Việc tua video sẽ được xử lý riêng cho HLS để đảm bảo độ chính xác
        const onLoadedMetadata = () => {
            if (player.duration) {
                seekSlider.max = player.duration;
                durationDisplay.textContent = formatTime(player.duration);
            }
            updateVolumeUI(); // Cập nhật UI âm thanh ban đầu
        };
        // <<< KẾT THÚC THAY ĐỔI >>>

        const handleKeyDown = (e) => {
            if (getTopActiveModal()?.element !== modal) {
                return;
            }

            if (document.activeElement === trakeFrameStepInput) {
                if (e.key === 'Enter' || e.key === 'Escape') {
                    trakeFrameStepInput.blur();
                }
                return; // Không xử lý các phím tắt khác khi đang gõ
            }
            if (e.key === 'Tab') {
                e.preventDefault(); // Ngăn hành vi mặc định của Tab
                toggleTrakeMode(!isTrakeMode); // Bật/tắt chế độ TRAKE
                return; // Dừng lại sau khi xử lý Tab
            }


            if (e.key === 'Escape') { closePreviewModal(); return; }
            if (isTrakeMode) {
                const eventNumber = parseInt(e.key);
                if (!isNaN(eventNumber) && eventNumber >= 1 && eventNumber <= 5) {
                    e.preventDefault();
                    captureAndSubmitTrakeFrame(eventNumber);
                    return;
                }

                const frameStep = getTrakeFrameStep() * (e.shiftKey ? 10 : 1);
                if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                    e.preventDefault();
                    queueTrakeFrameStep(e.key === 'ArrowRight' ? frameStep : -frameStep);
                    return;
                }
                if (e.key === ' ') {
                    e.preventDefault();
                    togglePlayPause();
                }
            } else {

                if (e.key === 'Enter') { e.preventDefault(); captureFrameAndAddToQueue(); return; }

                const activeElement = document.activeElement;
                if (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA') return;

                const key = e.key.toLowerCase();

                switch (key) {
                    case ' ': e.preventDefault(); togglePlayPause(); break;
                    case 'v':
                        e.preventDefault();
                        // Tạm dừng video để chụp frame
                        player.pause();
                        // Tạo một hàm async nhỏ để xử lý vì captureFrame cần là async
                        (async () => {
                            const currentTime = player.currentTime;
                            const fps = await getFpsForVideo(videoName);
                            const frameNumber = Math.round(currentTime * fps);

                            captureCanvas.width = player.videoWidth;
                            captureCanvas.height = player.videoHeight;
                            // ... (phần code vẽ canvas giống hệt trong captureFrameAndAddToQueue)
                            const context = captureCanvas.getContext('2d');
                            context.drawImage(player, 0, 0, captureCanvas.width, captureCanvas.height);
                            const imagePathDataUrl = captureCanvas.toDataURL('image/jpeg', 0.9);

                            const minutes = Math.floor(currentTime / 60);
                            const seconds = (currentTime % 60).toFixed(3);
                            const newTimestamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(6, '0')}`;

                            const newFrameData = {
                                videoName, path: imagePathDataUrl, frame_id_ori: frameNumber, id: frameNumber,
                                timestamp: newTimestamp, frameIdentifier: `${videoName}_${frameNumber}`,
                                score: 0, temporal_score: 0, videoPath: getHlsPlaylistUrl(videoName), fps, isFromVideo: true
                            };

                            addToFormSubmitQueue(newFrameData);
                        })();
                        break;
                    case 'm': e.preventDefault(); toggleMute(); break;
                    case 'arrowright':
                        e.preventDefault();
                        if (e.shiftKey) { // Nếu giữ Shift
                            player.playbackRate = 0.5; // Chuyển sang chế độ tua chậm
                        } else if (e.repeat) { // Nếu không giữ Shift (logic tua nhanh cũ)
                            player.playbackRate = FAST_FORWARD_RATE;
                        }
                        break;

                    case 'arrowleft':
                        e.preventDefault();
                        if (e.shiftKey) { // Nếu giữ Shift
                            player.playbackRate = 0.5; // Chuyển sang chế độ tua chậm
                        } else if (e.repeat && !rewindInterval) { // Logic tua lùi cũ
                            rewindInterval = setInterval(() => {
                                player.currentTime = Math.max(0, player.currentTime - 0.2);
                            }, 100);
                        }
                        break;
                }
            }
        };

        const handleKeyUp = (e) => {
            if (isTrakeMode) return;
            if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
                player.playbackRate = 1.0; // Luôn trả về tốc độ bình thường khi nhả phím
            }
            switch (e.key) {
                case 'ArrowRight':
                    e.preventDefault();
                    if (!e.repeat && !e.shiftKey) {
                        player.currentTime += SKIP_TIME;
                    }
                    break;

                case 'ArrowLeft':
                    e.preventDefault();
                    if (rewindInterval) { // Dừng tua lùi (khi giữ phím)
                        clearInterval(rewindInterval);
                        rewindInterval = null;
                    } else if (!e.shiftKey) { // Tua 1 đoạn ngắn khi nhấn-nhả (không giữ)
                        player.currentTime -= SKIP_TIME;
                    }
                    break;
            }
        };

        const captureFrameAndAddToQueue = async () => {
            player.pause();
            try {
                const currentTime = player.currentTime;
                const fps = await getFpsForVideo(videoName);
                const frameNumber = Math.round(currentTime * fps);

                // === BẮT ĐẦU PHẦN TỐI ƯU HÓA ===

                // 1. THÊM VÀO: Định nghĩa chiều rộng cho thumbnail (ví dụ: 320px là đủ)
                const THUMBNAIL_WIDTH = 320;

                // 2. THÊM VÀO: Tính toán chiều cao tương ứng để giữ đúng tỷ lệ khung hình
                const aspectRatio = player.videoHeight / player.videoWidth;
                const thumbnailHeight = Math.round(THUMBNAIL_WIDTH * aspectRatio);

                // 3. SỬA ĐỔI: Set kích thước canvas theo thumbnail, không phải video gốc
                captureCanvas.width = THUMBNAIL_WIDTH;
                captureCanvas.height = thumbnailHeight;

                const context = captureCanvas.getContext('2d');

                // 4. SỬA ĐỔI: Vẽ video gốc vào canvas nhỏ (nó sẽ tự động co lại)
                context.drawImage(player, 0, 0, THUMBNAIL_WIDTH, thumbnailHeight);

                // 5. SỬA ĐỔI: Tạo Data URL từ canvas nhỏ này, chất lượng có thể giảm một chút để tối ưu hơn
                const imagePathDataUrl = captureCanvas.toDataURL('image/jpeg', 0.8); // Giảm quality xuống 0.8

                // === KẾT THÚC PHẦN TỐI ƯU HÓA ===

                const minutes = Math.floor(currentTime / 60);
                const seconds = (currentTime % 60).toFixed(3);
                const newTimestamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(6, '0')}`;

                const newFrameData = {
                    videoName,
                    path: imagePathDataUrl, // Gửi đi Data URL của thumbnail
                    frame_id_ori: frameNumber,
                    id: frameNumber,
                    timestamp: newTimestamp,
                    frameIdentifier: `${videoName}_${frameNumber}`,
                    score: 0,
                    temporal_score: 0,
                    videoPath: getHlsPlaylistUrl(videoName),
                    fps,
                    isFromVideo: true
                };

                addFramesToQueue([newFrameData]);
                closePreviewModal();
            } catch (error) {
                console.error("Lỗi khi chụp frame:", error);
                showToastNotification("Không thể chụp frame.", "error");
                player.play();
            }
        };

        // <<< BẮT ĐẦU THAY ĐỔI >>>
        // Cập nhật hàm closeModal để hủy instance HLS, tránh rò rỉ bộ nhớ
        const closePreviewModal = () => {
            if (isTrakeMode) {
                toggleTrakeMode(false);
            }
            if (hlsPlayerInstance) {
                hlsPlayerInstance.destroy();
                hlsPlayerInstance = null;
            }

            player.pause();
            player.removeEventListener('loadedmetadata', onLoadedMetadata);
            player.removeEventListener('timeupdate', updateSlider);
            player.removeEventListener('play', updatePlayButton);
            player.removeEventListener('pause', updatePlayButton);
            player.removeEventListener('volumechange', updateVolumeUI);
            if (playerErrorHandler) {
                player.removeEventListener('error', playerErrorHandler);
            }
            if (nativeLoadedMetadataHandler) {
                player.removeEventListener('loadedmetadata', nativeLoadedMetadataHandler);
            }
            seekSlider.removeEventListener('input', handleSeekInput);
            seekSlider.removeEventListener('mousedown', handleSeekMouseDown);
            seekSlider.removeEventListener('mouseup', handleSeekMouseUp);
            volumeSlider.removeEventListener('input', handleVolumeChange);
            document.removeEventListener('keydown', handleKeyDown);
            document.removeEventListener('keyup', handleKeyUp);
            if (rewindInterval) clearInterval(rewindInterval);

            // Dọn dẹp player để sẵn sàng cho lần mở tiếp theo
            player.removeAttribute('src');
            player.load();

            modal.style.display = 'none';
            registerModalClose(modal);
        };
        // <<< KẾT THÚC THAY ĐỔI >>>

        // --- KHỞI TẠO VÀ GÁN SỰ KIỆN ---
        player.addEventListener('loadedmetadata', onLoadedMetadata);
        player.addEventListener('timeupdate', updateSlider);
        player.addEventListener('play', updatePlayButton);
        player.addEventListener('pause', updatePlayButton);
        player.addEventListener('volumechange', updateVolumeUI);

        playPauseBtn.onclick = togglePlayPause;
        seekBackwardBtn.onclick = () => player.currentTime -= SKIP_TIME;
        seekForwardBtn.onclick = () => player.currentTime += SKIP_TIME;

        seekSlider.addEventListener('input', handleSeekInput);
        seekSlider.addEventListener('mousedown', handleSeekMouseDown);
        seekSlider.addEventListener('mouseup', handleSeekMouseUp);

        muteBtn.onclick = toggleMute;
        volumeSlider.addEventListener('input', handleVolumeChange);
        const closeModal = closePreviewModal;
        modal.querySelector('.modal-overlay').onclick = closeModal;
        closeBtn.onclick = closeModal;
        document.addEventListener('keydown', handleKeyDown);
        document.addEventListener('keyup', handleKeyUp);

        const targetTimeInSeconds = parseTimestamp(timestamp);
        const videoSource = getVideoPlaybackSource(videoName);
        const videoSrc = videoSource.url;
        const seekAndPlay = () => {
            player.currentTime = targetTimeInSeconds;
            player.play().catch(e => console.error("Lỗi tự động phát video:", e));
        };

        if (hlsPlayerInstance) {
            hlsPlayerInstance.destroy();
            hlsPlayerInstance = null;
        }

        if (videoSource.type === 'hls' && window.Hls && Hls.isSupported()) {
            hlsPlayerInstance = new Hls({ enableWorker: true });
            hlsPlayerInstance.loadSource(videoSrc);
            hlsPlayerInstance.attachMedia(player);
            hlsPlayerInstance.on(Hls.Events.MANIFEST_PARSED, seekAndPlay);
            hlsPlayerInstance.on(Hls.Events.ERROR, (event, data) => {
                console.error("HLS playback error:", data);
                if (data.fatal) {
                    showToastNotification(`Lỗi: Không thể tải HLS tại ${videoSrc}`, "error");
                }
            });
        } else if (videoSource.type === 'hls' && player.canPlayType('application/vnd.apple.mpegurl')) {
            player.src = videoSrc;
            nativeLoadedMetadataHandler = seekAndPlay;
            player.addEventListener('loadedmetadata', nativeLoadedMetadataHandler, { once: true });
        } else if (videoSource.type === 'mp4') {
            player.src = videoSrc;
            nativeLoadedMetadataHandler = seekAndPlay;
            player.addEventListener('loadedmetadata', nativeLoadedMetadataHandler, { once: true });
        } else {
            showToastNotification("Trình duyệt không hỗ trợ HLS playback.", "error");
            console.error("HLS is not supported by this browser.");
        }

        playerErrorHandler = () => {
            showToastNotification(`Lỗi: Không thể tải video tại ${videoSrc}`, "error");
            console.error(`Không tìm thấy hoặc không thể phát video: ${videoSrc}`);
        };
        player.addEventListener('error', playerErrorHandler, { once: true });

        registerModalOpen(modal, closePreviewModal);
        modal.style.display = 'flex';
        // <<< KẾT THÚC THAY ĐỔI >>>
    }
    const frameSelectionManager = {
        selectedFrames: new Map(), // Map lưu tất cả frame đã chọn: key = frameId, value = frameData

        // Thêm frame vào danh sách đã chọn
        selectFrame(frameId, frameData) {
            this.selectedFrames.set(frameId, frameData);
            this.updateSelectionUI();
            this.triggerSelectionChanged();
        },

        // Bỏ chọn một frame
        deselectFrame(frameId) {
            this.selectedFrames.delete(frameId);
            this.updateSelectionUI();
            this.triggerSelectionChanged();
        },

        // Kiểm tra frame đã được chọn chưa
        isSelected(frameId) {
            return this.selectedFrames.has(frameId);
        },

        // Chọn/bỏ chọn (toggle)
        toggleSelection(frameId, frameData) {
            if (this.isSelected(frameId)) {
                this.deselectFrame(frameId);
                return false; // Trả về false nếu đã bỏ chọn
            } else {
                this.selectFrame(frameId, frameData);
                return true; // Trả về true nếu đã chọn
            }
        },

        // Xóa tất cả các chọn
        clearAllSelections() {
            this.selectedFrames.clear();
            this.updateSelectionUI();
            this.triggerSelectionChanged();
        },

        // Lấy tất cả frame đã chọn
        getAllSelectedFrames() {
            return Array.from(this.selectedFrames.values());
        },

        // Đếm số frame đã chọn
        getSelectionCount() {
            return this.selectedFrames.size;
        },

        // Cập nhật UI dựa trên trạng thái chọn
        updateSelectionUI() {
            // Xóa tất cả class selected
            document.querySelectorAll('.image-item.selected').forEach(el => {
                el.classList.remove('selected');
            });

            // Thêm class selected cho các frame đã chọn
            this.selectedFrames.forEach(frameData => {
                if (frameData.element) {
                    frameData.element.classList.add('selected');
                }
            });

            // Hiển thị/ẩn toolbar nếu có frame được chọn
            this.updateSelectionToolbar();
        },

        // Cập nhật toolbar dựa trên số lượng frame đã chọn
        updateSelectionToolbar() {
            const toolbar = document.getElementById('selectionToolbar');
            if (!toolbar) return;

            if (this.getSelectionCount() > 0) {
                toolbar.style.display = 'flex';
                // Cập nhật số lượng item đã chọn
                const countElement = toolbar.querySelector('.selection-count');
                if (countElement) {
                    countElement.textContent = this.getSelectionCount();
                }

                // Cập nhật trạng thái các nút dựa trên số lượng frame đã chọn
                this.updateToolbarButtonStates();
            } else {
                toolbar.style.display = 'none';
            }
        },

        // Cập nhật trạng thái các nút trên toolbar
        updateToolbarButtonStates() {
            const count = this.getSelectionCount();

            // Ví dụ: Nút "View Keyframes" chỉ kích hoạt khi chọn chính xác 1 frame
            const viewKeyframesBtn = document.getElementById('viewKeyframesBtn');
            if (viewKeyframesBtn) {
                viewKeyframesBtn.disabled = count !== 1;
            }

            // Có thể thêm logic cho các nút khác ở đây
        },

        // Kích hoạt sự kiện khi trạng thái chọn thay đổi (để các module khác có thể lắng nghe)
        triggerSelectionChanged() {
            const event = new CustomEvent('frameSelectionChanged', {
                detail: {
                    selectedCount: this.getSelectionCount(),
                    selectedFrames: this.getAllSelectedFrames()
                }
            });
            document.dispatchEvent(event);
        }
    };

    const modalFrameSelectionManager = {
        selectedFrames: new Map(),

        selectFrame(frameId, frameData) {
            this.selectedFrames.set(frameId, frameData);
            this.updateSelectionUI();
            this.triggerSelectionChanged();
        },

        deselectFrame(frameId) {
            this.selectedFrames.delete(frameId);
            this.updateSelectionUI();
            this.triggerSelectionChanged();
        },

        isSelected(frameId) {
            return this.selectedFrames.has(frameId);
        },

        toggleSelection(frameId, frameData) {
            if (this.isSelected(frameId)) {
                this.deselectFrame(frameId);
            } else {
                this.selectFrame(frameId, frameData);
            }
        },

        clearAllSelections() {
            this.selectedFrames.clear();
            this.updateSelectionUI();
            this.triggerSelectionChanged();
        },

        getAllSelectedFrames() {
            return Array.from(this.selectedFrames.values());
        },

        getSelectionCount() {
            return this.selectedFrames.size;
        },

        // --- CÁC HÀM SAU ĐÂY ĐƯỢC CHỈNH SỬA ĐỂ HOẠT ĐỘNG VỚI MODAL ---

        updateSelectionUI() {
            // Chỉ tìm các frame bên trong modal
            document.querySelectorAll('#semanticSearchResultsContainer .image-item.selected').forEach(el => {
                el.classList.remove('selected');
            });

            this.selectedFrames.forEach(frameData => {
                if (frameData.element) {
                    frameData.element.classList.add('selected');
                }
            });

            // Cập nhật toolbar của modal
            this.updateSelectionToolbar();
        },

        updateSelectionToolbar() {
            // Tìm toolbar bên trong modal
            const toolbar = document.getElementById('modalSelectionToolbar');
            if (!toolbar) return;

            const count = this.getSelectionCount();
            if (count > 0) {
                toolbar.style.display = 'flex';
                const countElement = toolbar.querySelector('.selection-count');
                if (countElement) {
                    countElement.textContent = count;
                }
            } else {
                toolbar.style.display = 'none';
            }
        },

        triggerSelectionChanged() {
            // Tạo một sự kiện riêng cho modal để tránh xung đột
            const event = new CustomEvent('modalFrameSelectionChanged', {
                detail: {
                    selectedCount: this.getSelectionCount(),
                    selectedFrames: this.getAllSelectedFrames()
                }
            });
            document.dispatchEvent(event);
        }
    };

    function setupToolbarEvents() {
        // Lắng nghe sự kiện click trên toolbar
        const toolbar = document.getElementById('selectionToolbar');

        if (toolbar) {
            toolbar.addEventListener('click', function (e) {
                // Tìm nút được nhấn
                const button = e.target.closest('.toolbar-btn');

                if (button) {
                    const action = button.getAttribute('data-action');

                    // Xử lý các hành động
                    switch (action) {
                        case 'view-keyframes':
                            // Mở modal keyframe cho frame được chọn
                            if (frameSelectionManager.getSelectionCount() === 1) {
                                const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
                                openImageModal(selectedFrame.id, selectedFrame.path, selectedFrame);
                            }
                            break;

                        case 'clear-selection':
                            // Bỏ chọn tất cả
                            frameSelectionManager.clearAllSelections();
                            break;

                        // Thêm các case khác khi cần
                        default:
                            console.log('Hành động không được hỗ trợ:', action);
                    }
                }
            });
        }

        // Thiết lập phím tắt
        document.addEventListener('keydown', function (e) {
            if (isModalKeyboardActive()) {
                return;
            }

            if (e.key === 'Backspace') {
                const activeElement = document.activeElement;
                const isTyping = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';
                if (isTyping || getTopActiveModal()) {
                    return;
                }

                if (frameSelectionManager.getSelectionCount() === 1) {
                    e.preventDefault();
                    const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
                    requestClusterDeletion(selectedFrame.data);
                }
                return;
            }

            // Phím F: Mở modal keyframe nếu chỉ có 1 frame được chọn
            if (e.key === 'f' || e.key === 'F') {
                // e.preventDefault();

                if (currentlyHoveredPreviewFrameData) {
                    openImageModal(currentlyHoveredPreviewFrameData);
                }
                // === BẮT ĐẦU THAY ĐỔI: THÊM LOGIC KIỂM TRA MỚI ===
                else if (currentlyHoveredFormQueueFrameData) {
                    // Kiểm tra ràng buộc: không cho mở với frame "live"
                    if (currentlyHoveredFormQueueFrameData.isFromVideo) {
                        showToastNotification('Không thể xem keyframe lân cận cho frame chụp từ video.', 'error');
                        return;
                    }
                    openImageModal(currentlyHoveredFormQueueFrameData);
                }
                // === KẾT THÚC THAY ĐỔI ===
                else if (frameSelectionManager.getSelectionCount() === 1) {
                    const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
                    openImageModal(selectedFrame.data);
                }
            }
            if (e.key === 't' || e.key === 'T') {
                const activeElement = document.activeElement;
                const isTyping = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';
                const anyModalOpen = document.getElementById('imageModal').style.display === 'flex' ||
                    document.getElementById('videoModal').style.display === 'flex';

                if (!isTyping && !anyModalOpen && frameSelectionManager.getSelectionCount() === 1) {
                    e.preventDefault();
                    const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
                    const baseFrameData = selectedFrame.data; // This is the data from the search result

                    // NEW LOGIC: Check the flag first
                    if (baseFrameData.has_temporal_chain) {
                        // Fetch the full chain data for THIS frame only
                        fetchFullTemporalChain(baseFrameData)
                            .then(temporalChain => {
                                openTemporalChainModal(baseFrameData, temporalChain);
                            })
                            .catch(err => {
                                console.error("Failed to fetch full temporal chain:", err);
                                showToastNotification("Could not load temporal chain data.", "error");
                            });
                    } else {
                        showToastNotification("No temporal chain available for this frame.", "info");
                    }
                }
            }

            if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
                if (getTopActiveModal()) {
                    return;
                }

                // Ngăn chặn hành vi khi đang gõ chữ hoặc khi có modal khác đang mở
                const activeElement = document.activeElement;
                const isTyping = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';
                const anyModalOpen = document.getElementById('imageModal').style.display === 'flex' ||
                    document.getElementById('videoModal').style.display === 'flex' ||
                    document.getElementById('temporalChainModal').style.display === 'flex';

                if (isTyping || anyModalOpen) {
                    return; // Không làm gì cả
                }

                e.preventDefault(); // Ngăn hành vi mặc định (ví dụ: mở ô tìm kiếm của trình duyệt)

                let frameToSearch = null;

                if (currentlyTargetedTrakeFrameData) {
                    const thumbnailUrl = getTrakeThumbnailUrl(currentlyTargetedTrakeFrameData)
                        || currentlyTargetedTrakeFrameData.path;
                    if (!thumbnailUrl) {
                        showToastNotification('Thumbnail TRAKE chưa sẵn sàng để semantic search.', 'info');
                        return;
                    }
                    frameToSearch = { ...currentlyTargetedTrakeFrameData, path: thumbnailUrl };
                }
                else if (currentlyHoveredPreviewFrameData) {
                    frameToSearch = currentlyHoveredPreviewFrameData;
                }
                else if (currentlyHoveredFormQueueFrameData) {
                    frameToSearch = currentlyHoveredFormQueueFrameData;
                }
                else if (frameSelectionManager.getSelectionCount() === 1) {
                    const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
                    frameToSearch = selectedFrame.data;
                }
                // LOGIC MỚI CHO HÀNG ĐỢI CỘNG TÁC
                else if (selectedQueueFrameIds.size === 1) {
                    const lastSelectedId = Array.from(selectedQueueFrameIds).pop();
                    frameToSearch = submitQueueFrames.get(lastSelectedId);
                }


                if (frameToSearch) {
                    // Gọi hàm quản lý modal mới của chúng ta!
                    openSemanticSearchModal(frameToSearch);

                    // Nếu đang mở thanh preview, hãy đóng nó đi cho gọn
                    if (keyframePreviewBar.classList.contains('visible')) {
                        keyframePreviewBar.classList.remove('visible');
                        header.classList.remove('header-expanded');
                    }
                } else {
                    showToastNotification("Vui lòng chọn hoặc di chuột qua một frame duy nhất.", "info");
                }
            }
            if (e.key.toLowerCase() === 'd' || e.key.toLowerCase() === 'a') {
                const isSpecialSubmission = e.key.toLowerCase() === 'a';

                if (currentlyHoveredPreviewFrameData) {
                    e.preventDefault();
                    // Create a new object to avoid modifying the original
                    const frameDataToSend = {
                        ...currentlyHoveredPreviewFrameData,
                        isSpecial: isSpecialSubmission
                    };
                    addFramesToQueue([frameDataToSend]);
                    return;
                }

                const imageModal = document.getElementById('imageModal');
                const temporalChainModal = document.getElementById('temporalChainModal');
                const videoModal = document.getElementById('videoModal');

                // Check if any of these modals are currently displayed
                const isAnyModalActive = imageModal.style.display === 'flex' ||
                    temporalChainModal.style.display === 'flex' ||
                    videoModal.style.display === 'flex';

                // If a modal is active, do NOT proceed with the global key press logic.
                // The modal's own keydown handler will take care of it.
                if (isAnyModalActive) {
                    return;
                }

                const selectedCount = frameSelectionManager.getSelectionCount();
                const activeElement = document.activeElement;
                const isTyping = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';

                if (selectedCount > 0 && !isTyping) {
                    e.preventDefault();
                    const selectedFramesData = frameSelectionManager.getAllSelectedFrames().map(f => ({
                        ...f.data,
                        isSpecial: isSpecialSubmission // Add the special flag here
                    }));

                    addFramesToQueue(selectedFramesData);
                }
            }
            if (e.key === 'v' || e.key === 'V') {
                const activeElement = document.activeElement;
                const isTyping = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';
                if (isTyping) return; // Bỏ qua nếu đang gõ chữ

                // e.preventDefault();

                // Ưu tiên 1: Frame đang được hover trên thanh preview
                if (currentlyHoveredPreviewFrameData) {
                    addToFormSubmitQueue(currentlyHoveredPreviewFrameData);
                    return;
                }

                // Ưu tiên 2: Frame duy nhất đang được chọn trong kết quả tìm kiếm
                if (frameSelectionManager.getSelectionCount() === 1) {
                    const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
                    addToFormSubmitQueue(selectedFrame.data);
                    return;
                }
            }

            // Phím Escape: Bỏ chọn tất cả
            if (e.key === 'Escape') {
                // Chỉ xử lý nếu không có modal nào đang mở
                const modals = [
                    document.getElementById('imageModal'),
                    document.getElementById('videoModal')
                ];

                const noModalOpen = modals.every(modal =>
                    !modal || modal.style.display !== 'flex'
                );

                if (noModalOpen) {
                    frameSelectionManager.clearAllSelections();
                }
            }

            // Phím Ctrl+A: Chọn tất cả các frame
            if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
                // e.preventDefault(); // Ngăn hành vi mặc định (chọn tất cả văn bản)

                // Chỉ áp dụng nếu đang focus vào khu vực kết quả
                if (document.activeElement === document.body ||
                    document.activeElement.closest('.main-content')) {
                    e.preventDefault();
                    // Chọn tất cả frame hiện có

                    document.querySelectorAll('.image-item').forEach(item => {
                        const frameId = item.getAttribute('data-frame-id');
                        const frameIdentifier = item.getAttribute('data-frame-identifier');
                        if (frameId && !frameSelectionManager.isSelected(frameId)) {
                            // Tìm dữ liệu frame từ các thuộc tính
                            const imgElement = item.querySelector('img');
                            const path = imgElement ? imgElement.src : '';
                            const id = frameId.replace('frame-', '');

                            frameSelectionManager.selectFrame(frameId, {
                                id: frameIdentifier.split('_').pop(),
                                path: path,
                                element: item,
                                data: { frameIdentifier: frameIdentifier, path: path } // Thông tin bổ sung có thể được lưu trữ ở đây
                            });
                        }
                    });
                }
            }

        });
        document.addEventListener('click', function (e) {
            // Kiểm tra xem click có nằm ngoài frame và toolbar không
            const isClickOutside = !e.target.closest('.image-item') &&
                !e.target.closest('.selection-toolbar');
            if (isClickOutside && !e.ctrlKey) {
                frameSelectionManager.clearAllSelections();
            }
        });
        window.addEventListener('resize', function () {
            // Cập nhật vị trí toolbar nếu cần
            adjustToolbarPosition();
        });
    }
    async function fetchFullTemporalChain(frameData) {
        // You will need the user_id here. Let's assume you have it in `currentUserId`
        if (!currentUserId) {
            throw new Error("User ID is not available.");
        }

        const response = await fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/temporal-chain/${currentUserId}/${frameData.frameIdentifier}`);

        if (!response.ok) {
            throw new Error(`API error: ${response.statusText}`);
        }

        return await response.json();
    }
    function blurActiveInput() {
        const activeElement = document.activeElement;
        if (activeElement && (activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'INPUT')) {
            activeElement.blur();
        }
    }
    function adjustToolbarPosition() {
        const toolbar = document.getElementById('selectionToolbar');
        if (toolbar && toolbar.style.display !== 'none') {
            // Đảm bảo toolbar luôn nằm trong viewport
            const rect = toolbar.getBoundingClientRect();
            const viewportWidth = window.innerWidth;

            // Nếu toolbar vượt quá cạnh bên phải
            if (rect.right > viewportWidth) {
                const newLeft = viewportWidth - rect.width - 20; // 20px margin
                toolbar.style.left = `${newLeft}px`;
                toolbar.style.transform = 'none'; // Hủy transform
            } else {
                // Khôi phục vị trí mặc định ở giữa
                toolbar.style.left = '50%';
                toolbar.style.transform = 'translateX(-50%)';
            }
        }
    }
    function renderFullQueue(queueItems) {
        // queueItems.reverse();
        // Cập nhật Map cục bộ để dễ truy xuất
        submitQueueFrames.clear();
        queueItems.forEach(item => submitQueueFrames.set(item.frameIdentifier, item));

        // Bước 1: Ẩn/hiện container chính
        if (submitQueueFrames.size > 0) {
            submitQueueContainer.classList.add('visible');
        } else {
            submitQueueContainer.classList.remove('visible');
            submitQueueContainer.classList.remove('split-view'); // Gỡ class chia đôi khi nó ẩn
        }

        // Bước 2: Cập nhật số lượng
        queueCountSpan.textContent = `${submitQueueFrames.size} frame${submitQueueFrames.size !== 1 ? 's' : ''}`;

        // Bước 3: Vẽ lại các frame
        const currentSelectedId = document.querySelector('.queue-frame-item.selected')?.dataset.frameId;
        submitQueueFramesContainer.innerHTML = ''; // Xóa các frame cũ

        submitQueueFrames.forEach((frameData) => {
            const userColor = frameData.user_color || '#888888';
            const hasVotesClass = frameData.vote_count > 0 ? 'has-votes' : '';
            const isSelectedClass = frameData.frameIdentifier === currentSelectedId ? 'selected' : '';
            const isFromVideoClass = frameData.isFromVideo ? 'from-video' : '';
            const isSpecialClass = frameData.isSpecial ? 'special-submission' : '';
            const isWrongClass = wrongSubmissionIds.has(frameData.frameIdentifier) ? 'is-wrong-submission' : '';

            const frameElement = document.createElement('div');
            frameElement.className = `queue-frame-item ${hasVotesClass} ${isSelectedClass} ${isFromVideoClass} ${isSpecialClass} ${isWrongClass}`; frameElement.dataset.frameId = frameData.frameIdentifier;
            frameElement.dataset.frameId = frameData.frameIdentifier;
            frameElement.style.borderColor = userColor;

            // Tạo cấu trúc HTML bên trong
            frameElement.innerHTML = `
            <div class="queue-frame-image-container">
            <img src="${resolveFrameUrl(frameData.path)}" data-frame-source="${frameData.path}" alt="Queued frame">
            <div class="queue-frame-user">${frameData.added_by}</div>
            ${frameData.vote_count > 0 ? `
                <div class="queue-frame-vote">
                <i class="fas fa-heart"></i> ${frameData.vote_count}
                </div>` : ''}
                <button class="remove-queue-item-btn" title="Remove from queue">×</button>
                </div>
                <div class="queue-frame-info-bar">
                ${frameData.frameIdentifier}
                </div>`;
            submitQueueFramesContainer.appendChild(frameElement);
        });

        if (lastAddedFrameId) {
            // Xóa lựa chọn cũ trước khi target cái mới
            clearQueueSelection();

            const newFrameElement = submitQueueFramesContainer.querySelector(`.queue-frame-item[data-frame-id="${lastAddedFrameId}"]`);

            if (newFrameElement) {
                // Thực hiện các hành động "target"
                newFrameElement.classList.add('selected');
                selectedQueueFrameIds.add(lastAddedFrameId);
                updateSubmitButtonStates();

                // Cuộn tới frame đó để người dùng thấy
                newFrameElement.scrollIntoView({
                    behavior: 'smooth',
                    block: 'nearest',
                    inline: 'center'
                });
            }

            // Reset biến tạm sau khi đã xử lý xong
            lastAddedFrameId = null;
        }

    }

    function renderUserLegend() {
        const actionsContainer = document.querySelector('.submit-queue-header .queue-actions');

        const oldLegend = document.getElementById('userLegend');
        if (oldLegend) oldLegend.remove();

        const legendContainer = document.createElement('div');
        legendContainer.id = 'userLegend';
        legendContainer.style.display = 'flex';
        legendContainer.style.alignItems = 'center';
        legendContainer.style.gap = '10px';

        for (const [name, color] of Object.entries(userColors)) {
            const userSpan = document.createElement('span');
            userSpan.style.display = 'flex';
            userSpan.style.alignItems = 'center';
            userSpan.style.fontSize = '12px';

            const colorBox = document.createElement('div');
            colorBox.style.width = '12px';
            colorBox.style.height = '12px';
            colorBox.style.backgroundColor = color;
            colorBox.style.borderRadius = '3px';
            colorBox.style.marginRight = '5px';

            userSpan.appendChild(colorBox);
            userSpan.append(name);
            legendContainer.appendChild(userSpan);
        }
        actionsContainer.prepend(legendContainer);
    }

    function buildStateObject() {
        const state = {
            description: 'AIC_LUNCH_SEARCH', // Dùng để nhận dạng
            searchMode: currentSearchMode,
            selectedModel: currentSelectedModel,
            // temporalChainId: temporalChainId,
            queries: [],
            filters: {
                ocr: { enabled: false, value: '' },
                tag: { enabled: false, value: '' }
            },
            imageDataUrl: null,
            finalResults: allImages
        };
        const searchInputGroups = document.querySelectorAll('.search-input-group');
        searchInputGroups.forEach((group, index) => {
            const searchInput = group.querySelector('.search-input');
            const ocrInput = group.querySelector('.ocr-input');
            const tagInput = group.querySelector('.tag-input');

            state.queries.push({
                id: group.dataset.searchId,
                value: searchInput.value
            });
            if (index === 0) {
                state.filters.ocr.enabled = ocrFilterBtn.classList.contains('active');
                state.filters.ocr.value = ocrInput ? ocrInput.value : '';

                state.filters.tag.enabled = tagFilterBtn.classList.contains('active');
                state.filters.tag.value = tagInput ? tagInput.value : '';
            }
        });
        if (currentSearchMode === 'image-to-image') {
            const uploadedImage = document.querySelector('.uploaded-image img');
            const uploadedImageContainer = document.querySelector('.uploaded-image');
            if (uploadedImage && uploadedImageContainer.style.display !== 'none') {
                state.imageDataUrl = uploadedImage.src;
            }
        }

        return state;
    }
    async function restoreStateFromHistory(state) {
        if (!state || state.description !== 'AIC_LUNCH_SEARCH') return;
        showLoadingIndicator();
        searchInputsContainer.innerHTML = '';
        switchSearchMode(state.searchMode);
        selectModel(state.selectedModel);
        temporalChainId = state.temporalChainId;

        if (state.isImageTemporalStart && state.imageTemporalStartPath) {
            const imageBlock = createImageTemporalSearchBlock(state.imageTemporalStartPath);
            searchInputsContainer.appendChild(imageBlock);
        }

        state.queries.forEach((queryInfo, index) => {
            if (state.isImageTemporalStart && index === 0) {
                return;
            }

            const newSearchInput = createNewSearchInput();
            newSearchInput.value = queryInfo.value;
            const group = newSearchInput.closest('.search-input-group');
            group.dataset.searchId = queryInfo.id;
        });

        const allRestoredInputs = document.querySelectorAll('.search-inputs-container .search-input');
        allRestoredInputs.forEach(input => {
            autoResizeTextarea(input);
        });

        const firstGroup = document.querySelector('.search-input-group');
        if (firstGroup) {
            if (state.filters.ocr.enabled) {
                ocrFilterBtn.classList.add('active');
                const ocrInput = firstGroup.querySelector('.ocr-input');
                const ocrContainer = firstGroup.querySelector('.ocr-filter-container');
                if (ocrInput) ocrInput.value = state.filters.ocr.value;
                if (ocrContainer) ocrContainer.classList.add('visible');
            }
            if (state.filters.tag.enabled) {
                tagFilterBtn.classList.add('active');
                const tagInput = firstGroup.querySelector('.tag-input');
                const tagContainer = firstGroup.querySelector('.tag-filter-container');
                if (tagInput) tagInput.value = state.filters.tag.value;
                if (tagContainer) tagContainer.classList.add('visible');
            }
        }

        if (state.searchMode === 'image-to-image' && state.imageDataUrl) {
            const firstSearchGroup = document.querySelector('.search-input-group');
            const uploadedImageDiv = firstSearchGroup.querySelector('.uploaded-image');
            const img = uploadedImageDiv.querySelector('img');
            img.src = state.imageDataUrl;
            uploadedImageDiv.style.display = 'block';
        }

        try {
            if (state.finalResults && Array.isArray(state.finalResults)) {

                console.log("Restoring results directly from history state.");
                const isRerankedResult = state.queries.length > 1;
                handleSearchResults(state.finalResults, isRerankedResult);

            }
            // ƯU TIÊN 2: Nếu không có kết quả lưu sẵn (dành cho state cũ), thì mới chạy lại API.
            else {
                console.log("No results in history state, re-fetching...");

                // --- Giữ lại logic cũ của bạn để chạy lại API từ đầu ---
                let results;
                if (state.isImageTemporalStart && state.imageTemporalStartPath) {
                    const response = await fetch(state.imageTemporalStartPath);
                    const blob = await response.blob();
                    const imageFile = new File([blob], "restored_temporal_image.jpg", { type: blob.type });

                    const formData = new FormData();
                    formData.append("file", imageFile);
                    formData.append("user_id", currentUserId);
                    formData.append("query_id", state.queries[0]?.id || 'img-start-restored');
                    formData.append("cluster_mode_enabled", String(clusterModeEnabled));
                    if (state.selectedModel && state.selectedModel !== 'all') {
                        formData.append("model_name", state.selectedModel);
                    }

                    const apiResponse = await fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/search/temporal/start_with_image`, {
                        method: "POST",
                        body: formData,
                    });

                    if (!apiResponse.ok) throw new Error("Failed to restore image-based temporal search.");

                    const resultData = await apiResponse.json();
                    temporalChainId = resultData.chain_id;
                    results = resultData.initial_results;

                } else if (state.searchMode === 'text-to-image') {
                    const firstQuery = state.queries.length > 0 ? state.queries[0].value : '';
                    const restoredFilters = buildFilterOptionsFromState(state);
                    results = await callTextToImageAPI(firstQuery, state.selectedModel, restoredFilters);

                } else if (state.searchMode === 'image-to-image' && state.imageDataUrl) {
                    const response = await fetch(state.imageDataUrl);
                    const blob = await response.blob();
                    const file = new File([blob], "restored_image.jpg", { type: blob.type });
                    results = await callImageToImageAPI(file, state.selectedModel);

                } else if (state.searchMode === 'text-to-text') {
                    const firstQuery = state.queries.length > 0 ? state.queries[0].value : '';
                    const restoredFilters = buildFilterOptionsFromState(state);
                    results = await callTextToTextAPI(firstQuery, state.selectedModel, restoredFilters);

                } else {
                    contentArea.innerHTML = '<div class="content-placeholder"><h2>RESULTS</h2></div>';
                    return;
                }

                // Chỉ hiển thị nếu có kết quả từ việc fetch lại
                if (results) {
                    handleSearchResults(results, false);
                }
            }
        } catch (error) {
            handleSearchError(error);
        }
    }


    function buildFilterOptionsFromState(state) {
        const filters = {};
        if (state.filters) {
            if (state.filters.ocr && state.filters.ocr.enabled && state.filters.ocr.value) {
                filters.ocr = state.filters.ocr.value;
            }
            if (state.filters.tag && state.filters.tag.enabled && state.filters.tag.value) {
                const tags = state.filters.tag.value.split(',').map(t => t.trim()).filter(t => t);
                if (tags.length > 0) {
                    filters.use_tag = true;
                    filters.tags_filter = tags;
                }
            }
            if (state.filters.event) {
                filters.use_event_filter = true;
            }
        }
        return filters;
    }


    function clearQueueSelection() {
        document.querySelectorAll('.queue-frame-item.selected').forEach(el => el.classList.remove('selected'));
        selectedQueueFrameIds.clear();
        updateSubmitButtonStates();
    }
    function toggleFilter(filterType) {
        const activeElement = document.activeElement;
        const searchGroup = activeElement.closest('.search-input-group');
        if (!searchGroup) {
            showToastNotification(`Vui lòng click vào một ô tìm kiếm để dùng bộ lọc ${filterType.toUpperCase()}!`, 'error');
            return;
        }
        const containerSelector = `.${filterType}-filter-container`;
        const inputSelector = `.${filterType}-input`;
        const buttonSelector = `#${filterType}FilterBtn`;

        const filterContainer = searchGroup.querySelector(containerSelector);
        const filterInput = searchGroup.querySelector(inputSelector);
        const mainSearchInput = searchGroup.querySelector('.search-input');
        const headerButton = document.querySelector(buttonSelector);

        if (filterContainer.classList.contains('visible')) {
            filterContainer.classList.remove('visible');
            headerButton.classList.remove('active');
            mainSearchInput.focus();
        } else {
            filterContainer.classList.add('visible');
            headerButton.classList.add('active');
            setTimeout(() => filterInput.focus(), 10);
        }
    }

    function createImageTemporalSearchBlock(imagePath) {
        const imageSearchBlock = document.createElement('div');
        imageSearchBlock.className = 'image-temporal-search-block'; // Dùng class riêng để style
        imageSearchBlock.innerHTML = `
        <p class="search-block-label">Searching from image:</p>
        <img src="${imagePath}" alt="Temporal Search Start Image">
        `;
        return imageSearchBlock;
    }

    async function initiateImageTemporalSearch(imagePath) {
        // BỎ ĐI: searchInputsContainer.innerHTML = '';
        // BỎ ĐI: showLoadingIndicator();

        try {
            let imageFile;
            if (imagePath.startsWith('data:')) {
                const response = await fetch(imagePath);
                const blob = await response.blob();
                imageFile = new File([blob], "captured_frame.jpg", { type: blob.type });
            } else {
                const response = await fetch(imagePath, {
                    mode: 'cors',
                    credentials: 'omit',
                    cache: 'force-cache'
                });
                if (!response.ok) throw new Error(`Thumbnail request failed: ${response.status}`);
                const blob = await response.blob();
                imageFile = new File([blob], "temporal_start_image.jpg", { type: blob.type });
            }

            // --- LOGIC GỌI API VẪN GIỮ NGUYÊN ---
            const queryId = 'img-start-' + Date.now();
            const formData = new FormData();
            formData.append("file", imageFile);
            formData.append("user_id", currentUserId);
            formData.append("query_id", queryId);
            formData.append("cluster_mode_enabled", String(clusterModeEnabled));

            if (isEventFilterEnabled) {
                formData.append("use_event_filter", "true");
            }

            if (currentSelectedModel && currentSelectedModel !== 'all') {
                formData.append("model_name", currentSelectedModel);
            }

            const apiResponse = await fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/search/temporal/start_with_image`, {
                method: "POST",
                body: formData,
            });

            if (!apiResponse.ok) {
                throw new Error('API call to start_with_image failed.');
            }

            const resultsData = await apiResponse.json();

            // TRẢ VỀ KẾT QUẢ ĐỂ HÀM MỚI SỬ DỤNG
            return resultsData.initial_results;

        } catch (error) {
            console.error('Lỗi trong lúc gọi API Semantic Search:', error);
            // NÉM LỖI RA NGOÀI ĐỂ HÀM MỚI BẮT ĐƯỢC
            throw error;
        }
    }

    function saveSerperApiKey() {
        const apiKey = serperApiKeyInput.value.trim();
        if (!apiKey) {
            localStorage.removeItem(getUserScopedStorageKey('serper_api_key'));
            showToastNotification('Serper API key đã được xóa.', 'info');
            return;
        }

        setUserScopedSetting('serper_api_key', apiKey);
        showToastNotification('Serper API key đã được lưu.', 'success');
    }

    function updateGoogleAiSummaryUI() {
        googleAiSummaryToggle.checked = googleAiSummaryEnabled;
        googleAiSummaryLabel.textContent = googleAiSummaryEnabled ? 'Enabled' : 'Disabled';
    }

    function saveGeminiApiKey() {
        const apiKey = geminiApiKeyInput.value.trim();
        if (!apiKey) {
            localStorage.removeItem(getUserScopedStorageKey('gemini_api_key'));
            showToastNotification('Gemini API key đã được xóa.', 'info');
            refreshVisibleGoogleSearchResults();
            return;
        }

        setUserScopedSetting('gemini_api_key', apiKey);
        for (const [cacheKey, summaryState] of googleSummaryCache) {
            if (summaryState.status === 'error') googleSummaryCache.delete(cacheKey);
        }
        showToastNotification('Gemini API key đã được lưu.', 'success');
        refreshVisibleGoogleSearchResults();
    }

    function refreshVisibleGoogleSearchResults() {
        if (!lastGoogleSearchQuery || !isGoogleSearchMode) return;
        const data = googleSearchCache.get(getGoogleSearchCacheKey(lastGoogleSearchQuery));
        if (data) renderGoogleSearchResults(lastGoogleSearchQuery, data);
    }

    function setGoogleSearchMode(enabled) {
        isGoogleSearchMode = enabled;
        document.querySelector('.sidebar').classList.toggle('google-search-mode', enabled);
        normalSearchPanel.hidden = enabled;
        googleSearchPanel.hidden = !enabled;

        if (!enabled) {
            hoveredGoogleImage = null;
            const normalSearchInput = normalSearchPanel.querySelector('.search-input');
            if (normalSearchInput) normalSearchInput.focus();
            return;
        }

        googleSearchInput.value = lastGoogleSearchQuery;
        setTimeout(() => googleSearchInput.focus(), 0);
    }

    function getGoogleSearchCacheKey(query) {
        return `${query}|${GOOGLE_SEARCH_COUNTRY}|${GOOGLE_SEARCH_LANGUAGE}`;
    }

    function startGoogleImageSearch(query, apiKey) {
        const cacheKey = getGoogleSearchCacheKey(query);
        if (googleImageSearchCache.has(cacheKey) || googleImageSearchInFlight.has(cacheKey)) return;

        const request = fetch('https://google.serper.dev/images', {
            method: 'POST',
            headers: {
                'X-API-KEY': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                q: query,
                gl: GOOGLE_SEARCH_COUNTRY,
                hl: GOOGLE_SEARCH_LANGUAGE,
                num: GOOGLE_IMAGE_RESULT_COUNT
            })
        })
            .then(async response => {
                if (!response.ok) {
                    throw new Error(`Serper image request failed with status ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                googleImageSearchCache.set(cacheKey, Array.isArray(data?.images) ? data.images : []);
            })
            .catch(error => {
                console.error('Google Image Search request failed:', error);
                googleImageSearchCache.set(cacheKey, []);
            })
            .finally(() => {
                googleImageSearchInFlight.delete(cacheKey);
                if (isGoogleSearchMode && lastGoogleSearchQuery === query) {
                    const cachedSearch = googleSearchCache.get(cacheKey);
                    if (cachedSearch) renderGoogleSearchResults(query, cachedSearch);
                }
            });

        googleImageSearchInFlight.set(cacheKey, request);
    }

    function openGoogleImageSemanticSearch(image) {
        const imagePath = image?.thumbnailUrl || image?.imageUrl;
        if (!imagePath) {
            showToastNotification('Google image does not include a usable thumbnail.', 'error');
            return;
        }

        openSemanticSearchModal({
            id: `google-image-${image.position || Date.now()}`,
            path: imagePath,
            frameIdentifier: image.title || 'Google image result'
        });
    }

    function getGoogleSearchSources(data) {
        const organic = Array.isArray(data?.organic) ? data.organic : [];
        return organic.slice(0, GOOGLE_SUMMARY_SOURCE_LIMIT).map((result, index) => ({
            number: index + 1,
            title: result.title || result.link || `Result ${index + 1}`,
            link: result.link || '',
            snippet: result.snippet || ''
        }));
    }

    function buildGeminiSummaryPrompt(query, data) {
        const answerBox = data?.answerBox;
        const answerBoxText = answerBox && typeof answerBox === 'object'
            ? [answerBox.title, answerBox.answer || answerBox.snippet].filter(Boolean).join(': ')
            : '';
        const sources = getGoogleSearchSources(data);
        const sourceText = sources.map(source => [
            `[${source.number}] ${source.title}`,
            `Snippet: ${source.snippet || 'Unavailable'}`
        ].join('\n')).join('\n\n');

        return `Answer the Google search query directly using only the supplied sources.\n\n`
            + `Rules:\n`
            + `- Start with the answer. Do not repeat or restate the query.\n`
            + `- Focus only on information needed to answer the query. Omit background details.\n`
            + `- Write in Vietnamese unless the query clearly requires another language.\n`
            + `- Keep the answer under 100 words in one short paragraph.\n`
            + `- Cite factual claims with source markers such as [1] or [2]. Use only listed source numbers.\n`
            + `- If the sources are insufficient or conflict, say so clearly.\n`
            + `- Return plain text only. Do not add a heading, markdown, or a source list.\n\n`
            + `QUERY: ${query}\n\n`
            + `ANSWER BOX: ${answerBoxText || 'Not available'}\n\n`
            + `SOURCES:\n${sourceText}`;
    }

    function getGeminiInteractionText(interaction) {
        if (typeof interaction?.output_text === 'string' && interaction.output_text.trim()) {
            return interaction.output_text.trim();
        }

        const outputText = (interaction?.steps || [])
            .filter(step => step?.type === 'model_output')
            .flatMap(step => step.content || [])
            .filter(content => content?.type === 'text' && typeof content.text === 'string')
            .map(content => content.text.trim())
            .filter(Boolean)
            .join('\n');
        if (!outputText) {
            throw new Error('Gemini returned an empty interaction output.');
        }
        return outputText;
    }

    function startGoogleAiSummary(query, data) {
        if (!googleAiSummaryEnabled) return;

        const cacheKey = getGoogleSearchCacheKey(query);
        const cachedSummary = googleSummaryCache.get(cacheKey);
        if (cachedSummary?.status === 'ready' || cachedSummary?.status === 'error') return;
        if (googleSummaryInFlight.has(cacheKey)) return;

        const apiKey = getUserScopedSetting('gemini_api_key', '').trim();
        if (!apiKey) return;

        googleSummaryCache.set(cacheKey, { status: 'loading' });
        const request = fetch(GEMINI_INTERACTIONS_URL, {
            method: 'POST',
            headers: {
                'x-goog-api-key': apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: GEMINI_SUMMARY_MODEL,
                input: buildGeminiSummaryPrompt(query, data)
            })
        })
            .then(async response => {
                const interaction = await response.json();
                if (!response.ok) {
                    throw new Error(`Gemini request failed with status ${response.status}`);
                }
                return getGeminiInteractionText(interaction);
            })
            .then(summary => {
                googleSummaryCache.set(cacheKey, { status: 'ready', summary });
            })
            .catch(error => {
                console.error('Google AI Summary request failed:', error);
                googleSummaryCache.set(cacheKey, { status: 'error' });
            })
            .finally(() => {
                googleSummaryInFlight.delete(cacheKey);
                if (isGoogleSearchMode && lastGoogleSearchQuery === query) {
                    const cachedSearch = googleSearchCache.get(cacheKey);
                    if (cachedSearch) renderGoogleSearchResults(query, cachedSearch);
                }
            });

        googleSummaryInFlight.set(cacheKey, request);
    }

    async function handleGoogleSearchSubmit(event) {
        event.preventDefault();
        const query = googleSearchInput.value.trim();
        if (!query) {
            googleSearchInput.focus();
            return;
        }

        lastGoogleSearchQuery = query;
        const cacheKey = getGoogleSearchCacheKey(query);
        const cachedResponse = googleSearchCache.get(cacheKey);
        if (cachedResponse) {
            const cachedApiKey = getUserScopedSetting('serper_api_key', '').trim();
            if (cachedApiKey) startGoogleImageSearch(query, cachedApiKey);
            renderGoogleSearchResults(query, cachedResponse);
            return;
        }

        const apiKey = getUserScopedSetting('serper_api_key', '').trim();
        if (!apiKey) {
            console.error('Google Search cannot run because the Serper API key is missing.');
            googleSearchPanelState.textContent = 'Add a Serper API key in Settings first.';
            return;
        }

        const requestId = ++googleSearchRequestId;
        renderGoogleSearchLoading();
        startGoogleImageSearch(query, apiKey);

        try {
            const response = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: {
                    'X-API-KEY': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    q: query,
                    gl: GOOGLE_SEARCH_COUNTRY,
                    hl: GOOGLE_SEARCH_LANGUAGE,
                    num: 15
                })
            });

            if (!response.ok) {
                throw new Error(`Serper request failed with status ${response.status}`);
            }

            const data = await response.json();
            googleSearchCache.set(cacheKey, data);
            if (requestId === googleSearchRequestId) {
                renderGoogleSearchResults(query, data);
            }
        } catch (error) {
            console.error('Google Search request failed:', error);
            if (requestId === googleSearchRequestId) {
                renderGoogleSearchError('Không thể tải kết quả Google Search.');
            }
        }
    }

    function renderGoogleSearchLoading() {
        const placeholder = document.createElement('div');
        placeholder.className = 'google-search-state';
        placeholder.textContent = 'Searching Google...';
        googleSearchResults.replaceChildren(placeholder);
        googleSearchPanelState.textContent = 'Searching Google...';
    }

    function renderGoogleSearchError(message) {
        const placeholder = document.createElement('div');
        placeholder.className = 'google-search-state';
        placeholder.textContent = message;
        googleSearchResults.replaceChildren(placeholder);
        googleSearchPanelState.textContent = message;
    }

    function appendGoogleSearchText(parent, text, className = '') {
        if (!text) return;
        const element = document.createElement('p');
        if (className) element.className = className;
        element.textContent = text;
        parent.appendChild(element);
    }

    function renderGoogleAnswerBox(answerBox) {
        if (!answerBox || typeof answerBox !== 'object') return null;

        const container = document.createElement('section');
        container.className = 'google-answer-box';
        const heading = document.createElement('h4');
        heading.textContent = 'Answer';
        container.appendChild(heading);

        appendGoogleSearchText(container, answerBox.answer, 'google-answer-text');
        appendGoogleSearchText(container, answerBox.snippet, 'google-result-snippet');

        if (answerBox.title && answerBox.link) {
            const link = document.createElement('a');
            link.href = answerBox.link;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = answerBox.title;
            container.appendChild(link);
        }

        return container;
    }

    function renderGoogleAiSummarySources(data) {
        const sources = getGoogleSearchSources(data);
        if (!sources.length) return null;

        const details = document.createElement('details');
        details.className = 'google-ai-summary-sources';
        const summary = document.createElement('summary');
        summary.textContent = `Sources (${sources.length})`;
        details.appendChild(summary);

        const list = document.createElement('ol');
        sources.forEach(source => {
            const item = document.createElement('li');
            if (source.link) {
                const link = document.createElement('a');
                link.href = source.link;
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                link.textContent = source.title;
                item.appendChild(link);
            } else {
                item.textContent = source.title;
            }
            list.appendChild(item);
        });
        details.appendChild(list);
        return details;
    }

    function renderGoogleAiSummary(query, data) {
        if (!googleAiSummaryEnabled) return null;

        const container = document.createElement('section');
        container.className = 'google-ai-summary';
        const header = document.createElement('div');
        header.className = 'google-ai-summary-header';
        const heading = document.createElement('h4');
        heading.textContent = 'AI Summary';
        const badge = document.createElement('span');
        badge.textContent = 'Gemini';
        header.append(heading, badge);
        container.appendChild(header);

        const cacheKey = getGoogleSearchCacheKey(query);
        const summaryState = googleSummaryCache.get(cacheKey);
        const apiKey = getUserScopedSetting('gemini_api_key', '').trim();

        if (!apiKey) {
            appendGoogleSearchText(container, 'Add a Gemini API key in Settings to generate a summary.', 'google-ai-summary-state');
            return container;
        }

        if (summaryState?.status === 'ready') {
            summaryState.summary.split(/\n+/).filter(Boolean).forEach(paragraph => {
                appendGoogleSearchText(container, paragraph, 'google-ai-summary-text');
            });
            const sources = renderGoogleAiSummarySources(data);
            if (sources) container.appendChild(sources);
            return container;
        }

        if (summaryState?.status === 'error') {
            appendGoogleSearchText(container, 'AI Summary is unavailable for this search.', 'google-ai-summary-state');
            return container;
        }

        appendGoogleSearchText(container, 'Generating AI summary...', 'google-ai-summary-state');
        return container;
    }

    function renderGoogleImageSearchResults(query) {
        const images = googleImageSearchCache.get(getGoogleSearchCacheKey(query));
        if (!Array.isArray(images) || !images.length) return null;

        const container = document.createElement('section');
        container.className = 'google-image-search-results';
        const header = document.createElement('div');
        header.className = 'google-image-search-header';
        const heading = document.createElement('h4');
        heading.textContent = 'Images';
        const shortcut = document.createElement('span');
        shortcut.textContent = 'Hover + S';
        header.append(heading, shortcut);
        container.appendChild(header);

        const strip = document.createElement('div');
        strip.className = 'google-image-strip';
        strip.setAttribute('aria-label', 'Google image search results');
        strip.addEventListener('wheel', event => {
            const scrollAmount = event.deltaY || event.deltaX;
            if (!scrollAmount) return;
            event.preventDefault();
            strip.scrollLeft += scrollAmount;
        }, { passive: false });

        images.slice(0, GOOGLE_IMAGE_RESULT_COUNT).forEach(image => {
            const thumbnailUrl = image.thumbnailUrl || image.imageUrl;
            if (!thumbnailUrl) return;

            const item = document.createElement('article');
            item.className = 'google-image-result-item';
            item.tabIndex = 0;
            item.title = `${image.title || 'Google image'}\nPress S to search semantically`;
            item.addEventListener('mouseenter', () => {
                hoveredGoogleImage = image;
            });
            item.addEventListener('mouseleave', () => {
                if (hoveredGoogleImage === image) hoveredGoogleImage = null;
            });

            const thumbnail = document.createElement('img');
            thumbnail.src = thumbnailUrl;
            thumbnail.alt = image.title || 'Google image result';
            thumbnail.loading = 'lazy';
            thumbnail.decoding = 'async';
            thumbnail.referrerPolicy = 'no-referrer';
            item.appendChild(thumbnail);

            const title = document.createElement('p');
            title.textContent = image.title || 'Untitled image';
            item.appendChild(title);
            strip.appendChild(item);
        });

        if (!strip.childElementCount) return null;
        container.appendChild(strip);
        return container;
    }

    function renderGoogleOrganicResult(result) {
        const item = document.createElement('article');
        item.className = 'google-result-item';

        const title = document.createElement('a');
        title.className = 'google-result-title';
        title.href = result.link || '#';
        title.target = '_blank';
        title.rel = 'noopener noreferrer';
        title.textContent = result.title || result.link || 'Untitled result';
        item.appendChild(title);

        if (result.link) {
            const url = document.createElement('div');
            url.className = 'google-result-url';
            url.textContent = result.link;
            item.appendChild(url);
        }

        appendGoogleSearchText(item, result.snippet, 'google-result-snippet');
        return item;
    }

    function renderGoogleSearchResults(query, data) {
        const organic = Array.isArray(data?.organic) ? data.organic : [];
        hoveredGoogleImage = null;
        googleSearchPanelState.textContent = organic.length
            ? `${organic.length} organic results cached for this page.`
            : 'No organic results returned.';
        googleSearchResults.replaceChildren();

        const aiSummary = renderGoogleAiSummary(query, data);
        if (aiSummary) googleSearchResults.appendChild(aiSummary);

        const imageSearchResults = renderGoogleImageSearchResults(query);
        if (imageSearchResults) googleSearchResults.appendChild(imageSearchResults);

        const answerBox = renderGoogleAnswerBox(data?.answerBox);
        if (answerBox) googleSearchResults.appendChild(answerBox);

        if (!organic.length) {
            console.error('Google Search response does not contain organic results.', data);
            const emptyState = document.createElement('div');
            emptyState.className = 'google-search-state';
            emptyState.textContent = 'No organic results were returned.';
            googleSearchResults.appendChild(emptyState);
            return;
        }

        const list = document.createElement('div');
        list.className = 'google-organic-list';
        organic.forEach(result => list.appendChild(renderGoogleOrganicResult(result)));
        googleSearchResults.appendChild(list);
        startGoogleAiSummary(query, data);
    }

    async function openSemanticSearchModal(queryFrameData) {
        if (!queryFrameData || !queryFrameData.path) {
            showToastNotification("Dữ liệu frame không hợp lệ.", "error");
            return;
        }
        modalQueryFrame = queryFrameData;
        modalCurrentLayout = 'grid'; // Luôn reset về layout grid
        updateModalLayoutButton(); // Cập nhật icon cho đúng
        registerModalOpen(semanticSearchModal, closeSemanticSearchModal);
        // 1. Hiển thị Modal với trạng thái loading
        semanticSearchModal.style.display = 'flex';
        semanticSearchResultsContainer.innerHTML = `
            <div class="loading-indicator">
                <div class="loading-spinner"></div>
                <p>Đang tìm kiếm ngữ nghĩa...</p>
            </div>`;

        try {
            // 2. Gọi hàm API đã được chỉnh sửa ở Bước 3.2
            const results = await initiateImageTemporalSearch(queryFrameData.path);
            // Render after the request completes; status classes are applied from shared live state.
            renderResultsInModal(queryFrameData, results);
            document.addEventListener('keydown', handleModalKeyDown);
        } catch (error) {
            // 4. Xử lý lỗi nếu API thất bại
            semanticSearchResultsContainer.innerHTML = `
                <div class="content-placeholder">
                    <h2>Lỗi tìm kiếm</h2>
                    <p>Không thể lấy kết quả. Vui lòng thử lại.</p>
                </div>`;
        }
    }

    /**
     * Đóng và dọn dẹp modal semantic search
     */
    function closeSemanticSearchModal() {
        semanticSearchModal.style.display = 'none';
        semanticSearchResultsContainer.innerHTML = ''; // Chỉ cần dòng này là đủ

        if (modalObserver) {
            modalObserver.disconnect();
            modalObserver = null;
        }
        registerModalClose(semanticSearchModal);
        document.removeEventListener('keydown', handleModalKeyDown); // Gỡ trình xử lý keydown
        modalFrameSelectionManager.clearAllSelections(); // Xóa các lựa chọn trong modal
    }

    function handleModalKeyDown(e) {
        // Chỉ hoạt động khi modal đang mở
        if (semanticSearchModal.style.display !== 'flex') {
            return;
        }

        if (getTopActiveModal()?.element !== semanticSearchModal) {
            return; // A child modal, such as cluster confirmation, owns the keyboard.
        }

        if (e.key === 'Tab') {
            e.preventDefault(); // Ngăn hành vi mặc định (chuyển focus)
            e.stopPropagation(); // << RẤT QUAN TRỌNG: Ngăn sự kiện lan ra các trình xử lý khác

            toggleModalLayout(); // Gọi hàm chuyển layout của modal
            return; // Dừng lại sau khi xử lý
        }

        const selectedFramesData = modalFrameSelectionManager.getAllSelectedFrames().map(f => f.data);
        const selectedCount = selectedFramesData.length;

        if (e.key === 'Backspace') {
            if (selectedCount === 1) {
                e.preventDefault();
                e.stopPropagation();
                requestClusterDeletion(selectedFramesData[0]);
            }
            return;
        }

        if (e.key.toLowerCase() === 'f') {
            if (selectedCount === 1) {
                e.preventDefault();
                const selectedFrame = selectedFramesData[0];
                if (selectedFrame.isFromVideo) {
                    showToastNotification('Không thể xem keyframe lân cận cho frame chụp từ video.', 'error');
                    return;
                }
                openImageModal(selectedFrame);
            }
            return;
        }

        // Phím D và A: Thêm vào queue chính
        if (e.key.toLowerCase() === 'd' || e.key.toLowerCase() === 'a') {
            if (selectedCount > 0) {
                e.preventDefault();
                const isSpecialSubmission = e.key.toLowerCase() === 'a';
                const framesToAdd = selectedFramesData.map(frame => ({
                    ...frame,
                    isSpecial: isSpecialSubmission
                }));
                addFramesToQueue(framesToAdd);
                showToastNotification(`Đã thêm ${selectedCount} frame vào queue.`, "success");
                closeSemanticSearchModal(); // Đóng modal sau khi thêm
            }
        }
        // Phím S: Tìm kiếm tiếp (nếu chỉ chọn 1)
        else if (e.key.toLowerCase() === 's') {
            if (selectedCount === 1) {
                e.preventDefault();
                const newQueryFrame = selectedFramesData[0];
                // Đóng modal cũ và mở một modal mới với frame vừa chọn
                closeSemanticSearchModal();
                setTimeout(() => openSemanticSearchModal(newQueryFrame), 100);
            }
        }
        // Phím Escape: Bỏ chọn hoặc đóng modal
        else if (e.key === 'Escape') {
            e.preventDefault();
            if (selectedCount > 0) {
                modalFrameSelectionManager.clearAllSelections();
            } else {
                closeSemanticSearchModal();
            }
        }
    }

    function renderResultsInModal(queryFrame, results) {
        // 1. Reset trạng thái
        if (results) {
            modalAllImages = results.filter(img => img.frameIdentifier !== queryFrame.frameIdentifier);
        }
        modalDisplayedImagesCount = 0;
        modalDisplayedGroupsCount = 0;
        isModalLoading = false;
        modalHasReachedEnd = false;
        if (modalObserver) modalObserver.disconnect();

        // 2. Dọn dẹp
        semanticSearchResultsContainer.innerHTML = '';
        const oldLoader = document.getElementById('modalLoadingMore');
        if (oldLoader) oldLoader.remove();

        // 3. Xử lý trường hợp không có kết quả
        if (modalAllImages.length === 0) {
            semanticSearchResultsContainer.className = ''; // Reset class
            const queryFrameElement = createImageItemElement(queryFrame, modalFrameSelectionManager);
            queryFrameElement.classList.add('query-frame');

            const emptyStateWrapper = document.createElement('div');
            emptyStateWrapper.className = 'video-group-row';
            emptyStateWrapper.innerHTML = `<h4 class="video-group-title">Frame Nguồn (Không tìm thấy kết quả nào khác)</h4>`;
            const frameStrip = document.createElement('div');
            frameStrip.className = 'frame-strip';
            frameStrip.appendChild(queryFrameElement);
            emptyStateWrapper.appendChild(frameStrip);
            semanticSearchResultsContainer.appendChild(emptyStateWrapper);
            return;
        }

        // 4. Tạo loader
        const loadingMore = document.createElement('div');
        loadingMore.id = 'modalLoadingMore';
        loadingMore.className = 'loading-indicator';
        loadingMore.innerHTML = '<div class="loading-spinner" style="width: 30px; height: 30px;"></div>';

        // --- PHÂN LUỒNG LOGIC DỰA TRÊN LAYOUT ---
        if (modalCurrentLayout === 'grid') {
            semanticSearchResultsContainer.className = '';

            const numberOfColumns = 6;
            for (let i = 0; i < numberOfColumns; i++) {
                const column = document.createElement('div');
                column.className = 'masonry-column';
                semanticSearchResultsContainer.appendChild(column);
            }

            const queryFrameElement = createImageItemElement(queryFrame, modalFrameSelectionManager);
            queryFrameElement.classList.add('query-frame');
            semanticSearchResultsContainer.querySelector('.masonry-column').appendChild(queryFrameElement);

            semanticSearchResultsContainer.appendChild(loadingMore);
            loadMoreModalImages();
        } else { // layout === 'grouped'
            semanticSearchResultsContainer.className = 'grouped-layout';
            modalAllGroupedData = groupResultsByVideo(modalAllImages);

            const queryFrameElement = createImageItemElement(queryFrame, modalFrameSelectionManager);
            queryFrameElement.classList.add('query-frame');
            const queryFrameWrapper = document.createElement('div');
            queryFrameWrapper.className = 'video-group-row';
            queryFrameWrapper.innerHTML = '<h4 class="video-group-title">Frame Nguồn</h4>';
            const frameStrip = document.createElement('div');
            frameStrip.className = 'frame-strip';
            frameStrip.appendChild(queryFrameElement);
            queryFrameWrapper.appendChild(frameStrip);
            semanticSearchResultsContainer.appendChild(queryFrameWrapper);

            semanticSearchResultsContainer.appendChild(loadingMore);
            loadMoreModalGroups();
        }

        setupModalInfiniteScroll();
    }

    function loadMoreModalImages() {
        if (isModalLoading || modalHasReachedEnd) return;

        isModalLoading = true;
        const loadingMore = document.getElementById('modalLoadingMore');

        const startIndex = modalDisplayedImagesCount;
        const endIndex = Math.min(startIndex + MODAL_IMAGES_PER_BATCH, modalAllImages.length);

        const columns = semanticSearchResultsContainer.querySelectorAll('.masonry-column');
        if (columns.length === 0) {
            isModalLoading = false;
            return;
        }

        setTimeout(() => {
            for (let i = startIndex; i < endIndex; i++) {
                const image = modalAllImages[i];
                const imageItem = createImageItemElement(image, modalFrameSelectionManager);

                const columnIndex = i % columns.length;
                columns[columnIndex].appendChild(imageItem);
            }

            modalDisplayedImagesCount = endIndex;

            if (modalDisplayedImagesCount >= modalAllImages.length) {
                modalHasReachedEnd = true;
                if (loadingMore) loadingMore.remove();
            }

            isModalLoading = false;

            const container = semanticSearchResultsContainer;
            const hasScrollbar = container.scrollHeight > container.clientHeight;
            if (!hasScrollbar && !modalHasReachedEnd) {
                loadMoreModalImages();
            }

        }, 100);
    }

    /**
     * Thiết lập IntersectionObserver để theo dõi việc cuộn chuột trong modal
     */
    function setupModalInfiniteScroll() {
        const loadingMore = document.getElementById('modalLoadingMore');
        if (!loadingMore) return;

        // Hàm callback sẽ được gọi mỗi khi loader thay đổi trạng thái "trong tầm nhìn"
        const observerCallback = (entries) => {
            // Lấy entry duy nhất cho loader
            const entry = entries[0];

            // Nếu loader đang trong tầm nhìn VÀ chúng ta chưa tải hết
            if (entry.isIntersecting && !modalHasReachedEnd) {
                // Gọi hàm tải thêm tương ứng với layout hiện tại
                if (modalCurrentLayout === 'grid') {
                    loadMoreModalImages();
                } else {
                    loadMoreModalGroups();
                }
            }
        };

        // Tạo observer
        const observer = new IntersectionObserver(observerCallback, {
            root: semanticSearchResultsContainer, // Vùng chứa có thanh cuộn
            rootMargin: '0px 0px 600px 0px', // Tăng rootMargin để trigger sớm hơn
            threshold: 0.01 // Trigger ngay khi 1% của loader hiện ra
        });

        // Bắt đầu theo dõi loader
        observer.observe(loadingMore);

        // Lưu lại observer để dọn dẹp
        modalObserver = observer;

        // === LOGIC TỰ ĐỘNG KIỂM TRA QUAN TRỌNG NHẤT ===
        // Sau khi thiết lập, ngay lập tức kiểm tra xem loader có đang trong tầm nhìn không.
        // Điều này sẽ xử lý trường hợp nội dung ban đầu quá thấp.
        setTimeout(() => {
            const isVisible = (loadingMore.getBoundingClientRect().top <= semanticSearchResultsContainer.getBoundingClientRect().bottom);
            if (isVisible && !modalHasReachedEnd) {
                if (modalCurrentLayout === 'grid') {
                    loadMoreModalImages();
                } else {
                    loadMoreModalGroups();
                }
            }
        }, 200); // Đợi 200ms để DOM ổn định sau khi render
    }

    function autoResizeTextarea(textareaElement) {
        if (!textareaElement) return;
        textareaElement.style.height = 'auto';
        const minHeight = 44;
        textareaElement.style.height = Math.max(minHeight, textareaElement.scrollHeight) + 'px';
    }
    function saveQueryToHistory(query) {
        if (!query || query.trim() === '') return;

        const trimmedQuery = query.trim();
        let history = JSON.parse(localStorage.getItem('searchHistory')) || [];
        history = history.filter(item => item !== trimmedQuery);

        history.unshift(trimmedQuery);
        if (history.length > 50) {
            history = history.slice(0, 50);
        }

        localStorage.setItem('searchHistory', JSON.stringify(history));
    }

    function renderSearchHistory() {
        const history = JSON.parse(localStorage.getItem('searchHistory')) || [];
        historyListContainer.innerHTML = ''; // Xóa nội dung cũ

        if (history.length === 0) {
            historyListContainer.innerHTML = '<div class="history-empty">Chưa có lịch sử tìm kiếm.</div>';
            clearHistoryBtn.style.display = 'none'; // Ẩn nút xóa khi không có gì
            return;
        }
        clearHistoryBtn.style.display = 'flex';

        history.forEach(query => {
            const historyItem = document.createElement('div');
            historyItem.className = 'history-item';
            historyItem.textContent = query;
            historyItem.dataset.query = query;
            historyListContainer.appendChild(historyItem);
        });
    }

    function copyQueryToClipboard(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        } else {
            return new Promise((resolve, reject) => {
                const textArea = document.createElement('textarea');
                textArea.value = text;
                textArea.style.position = 'fixed';
                textArea.style.left = '-9999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                try {
                    document.execCommand('copy');
                    document.body.removeChild(textArea);
                    resolve();
                } catch (err) {
                    document.body.removeChild(textArea);
                    reject(err);
                }
            });
        }
    }

    function closeHistoryMenu() {
        historyMenu.classList.remove('visible');
    }

    function toggleHistoryMenu(e) {
        e.stopPropagation(); // Ngăn sự kiện lan ra và đóng menu
        settingsMenu.classList.remove('visible'); // Đóng các menu khác

        if (historyMenu.classList.contains('visible')) {
            closeHistoryMenu();
            return;
        }
        renderSearchHistory();
        const btnRect = historyBtn.getBoundingClientRect();
        historyMenu.style.top = `${btnRect.bottom + 5}px`;
        historyMenu.style.right = '20px';
        historyMenu.style.left = '';
        historyMenu.classList.add('visible');
    }

    function clearSearchHistory(e) {
        e.stopPropagation();
        if (confirm('Bạn có chắc chắn muốn xóa toàn bộ lịch sử tìm kiếm không?')) {
            localStorage.removeItem('searchHistory'); // Xóa dữ liệu trong localStorage
            renderSearchHistory(); // Vẽ lại danh sách (lúc này sẽ trống)
            showToastNotification('Đã xóa lịch sử tìm kiếm!', 'success');
        }
    }
    async function getAutocorrectSuggestion(text) {
        if (!text || text.trim() === '') {
            return null;
        }
        const url = isTranslationEnabled
            ? 'http://192.168.20.164:9090/translate'
            : 'http://192.168.20.164:9090/correct';
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ text: text }),
            });

            if (!response.ok) {
                console.error('Autocorrect/Translate API error:', response.statusText);
                return null;
            }

            const result = await response.json();
            return result.corrected_text || result.translated_text || null;
        } catch (error) {
            console.error('Failed to fetch suggestion/translation:', error);
            return null;
        }
    }

    async function getFpsForVideo(videoName) {
        let videoMetadata;
        const cacheKey = `${frameServeLocation}:${videoName}`;

        if (trakeFpsCache.has(cacheKey)) {
            return trakeFpsCache.get(cacheKey);
        }

        if (metadataCache.has(cacheKey)) {
            videoMetadata = metadataCache.get(cacheKey);
        } else {
            try {
                const response = await fetch(getFrameMetadataUrl(videoName));
                if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                const fullMetadata = await response.json();

                videoMetadata = fullMetadata[videoName];

                if (!videoMetadata) {
                    throw new Error(`Không tìm thấy metadata cho key '${videoName}'.`);
                }

                metadataCache.set(cacheKey, videoMetadata);
            } catch (error) {
                console.error(`Lỗi khi fetch hoặc parse metadata cho ${videoName}:`, error);
                throw error;
            }
        }

        try {
            const firstFrameKey = Object.keys(videoMetadata)[0];
            const fps = Number(videoMetadata?.fps || videoMetadata?.[firstFrameKey]?.fps);
            if (!Number.isFinite(fps) || fps <= 0) {
                throw new Error(`Metadata của ${videoName} không có FPS hợp lệ.`);
            }
            trakeFpsCache.set(cacheKey, fps);
            return fps;
        } catch (error) {
            console.error(`Lỗi khi xử lý metadata cho ${videoName}:`, error);
            throw error;
        }
    }

    async function showKeyframePreview(frameData) {
        // Bước 1 & 2: Giữ nguyên
        if (!frameData || !frameData.videoName || typeof frameData.frame_id_ori === 'undefined') {
            console.error("Dữ liệu frame không đủ để hiển thị preview.", frameData);
            return;
        }

        header.classList.add('header-expanded');
        keyframePreviewBar.classList.add('visible');
        previewThumbnails.innerHTML = '';
        previewPlaceholder.textContent = 'Đang tải...';
        previewPlaceholder.style.display = 'block';

        try {
            // === BẮT ĐẦU PHẦN SỬA LỖI ===

            const metadataUrl = getFrameMetadataUrl(frameData.videoName);
            const response = await fetch(metadataUrl);

            if (!response.ok) {
                throw new Error(`Không tìm thấy tệp ${metadataUrl}. Status: ${response.statusText}`);
            }
            const metadataFileContent = await response.json();
            const videoMetadataObject = metadataFileContent[frameData.videoName];

            if (!videoMetadataObject) {
                throw new Error(`Không tìm thấy key '${frameData.videoName}' trong tệp metadata.json.`);
            }

            // 3. Chuyển đổi và "CHUẨN HÓA" đối tượng metadata thành một MẢNG
            const allKeyframes = Object.entries(videoMetadataObject).map(([frameKey, frameInfo]) => ({
                // Ánh xạ (map) các thuộc tính từ file JSON sang tên mà code đang dùng
                frame_id_ori: frameInfo.id,         // <-- SỬA Ở ĐÂY: Lấy giá trị từ 'id'
                timestamp: frameInfo["time-stamp"], // <-- SỬA Ở ĐÂY: Lấy giá trị từ 'time-stamp'

                // Thêm filename và giữ lại các thuộc tính gốc
                filename: `${frameKey}.webp`,
                ...frameInfo // Giữ lại các thuộc tính khác như tags, ocr, fps...
            }));

            // 4. Sắp xếp mảng theo frame_id_ori (đã được ánh xạ đúng)
            allKeyframes.sort((a, b) => a.frame_id_ori - b.frame_id_ori);

            // 5. Tìm vị trí (index) của frame được click
            const targetFrameId = parseInt(frameData.frame_id_ori, 10);
            const targetIndex = allKeyframes.findIndex(kf => kf.frame_id_ori === targetFrameId);

            if (targetIndex === -1) {
                // Lỗi vẫn có thể xảy ra ở đây nếu có sự không nhất quán dữ liệu,
                // nhưng nguyên nhân gốc đã được sửa.
                throw new Error(`Frame ID ${targetFrameId} không tìm thấy trong metadata của video ${frameData.videoName}.`);
            }

            // 6. Cắt ra các frame lân cận
            const lookBehind = 20;
            const lookAhead = 20;
            const startIndex = Math.max(0, targetIndex - lookBehind);
            const endIndex = Math.min(allKeyframes.length, targetIndex + lookAhead + 1);

            const neighbors = allKeyframes.slice(startIndex, endIndex);

            // === KẾT THÚC PHẦN SỬA LỖI ===

            // Phần còn lại của hàm không cần thay đổi
            if (neighbors.length === 0) {
                previewPlaceholder.textContent = 'Không tìm thấy frame lân cận.';
                return;
            }

            previewPlaceholder.style.display = 'none';
            const imageLoadPromises = [];

            neighbors.forEach(neighborData => {
                const thumb = document.createElement('img');
                const fullFrameData = {
                    ...neighborData,
                    videoName: frameData.videoName,
                    path: getFrameUrl(frameData.videoName, neighborData.filename),
                    frameIdentifier: `${frameData.videoName}_${neighborData.frame_id_ori}`
                    // timestamp đã được ánh xạ đúng ở trên
                };
                thumb.frameData = fullFrameData;
                thumb.addEventListener('mouseenter', () => { currentlyHoveredPreviewFrameData = thumb.frameData; });
                thumb.addEventListener('mouseleave', () => { currentlyHoveredPreviewFrameData = null; });
                thumb.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    const data = thumb.frameData;
                    if (data && data.videoName && data.timestamp) {
                        openVideoModal(data.videoName, data.timestamp);
                    } else {
                        showToastNotification("Lỗi: Không đủ dữ liệu để mở video.", "error");
                    }
                });
                thumb.addEventListener('click', () => {
                    const data = thumb.frameData;
                    if (data && data.videoName && data.timestamp) {
                        openVideoModal(data.videoName, data.timestamp);
                    }
                });
                const loadPromise = new Promise((resolve) => {
                    thumb.onload = resolve;
                    thumb.onerror = resolve;
                });
                imageLoadPromises.push(loadPromise);
                setFrameImageSource(thumb, thumb.frameData.path);
                thumb.title = thumb.frameData.frameIdentifier;
                if (neighborData.frame_id_ori === targetFrameId) {
                    thumb.classList.add('highlighted');
                }
                previewThumbnails.appendChild(thumb);
            });

            await Promise.all(imageLoadPromises);

            setTimeout(() => {
                const highlightedThumb = previewThumbnails.querySelector('.highlighted');
                if (highlightedThumb) {
                    const parent = previewThumbnails;
                    const offsetLeft = highlightedThumb.offsetLeft;
                    const thumbWidth = highlightedThumb.offsetWidth;
                    const parentWidth = parent.offsetWidth;
                    parent.scrollLeft = offsetLeft - (parentWidth / 2) + (thumbWidth * 1.5);
                }
            }, 50);

        } catch (error) {
            console.error('Lỗi khi tải keyframe lân cận từ file metadata.json:', error);
            previewPlaceholder.textContent = 'Lỗi khi tải dữ liệu.';
        }
    }

    function groupResultsByVideo(images, useTemporalScore = false) {
        if (!images || images.length === 0) {
            return [];
        }

        const getSortScore = image => {
            const primaryScore = useTemporalScore ? image.temporal_score : image.score;
            const fallbackScore = useTemporalScore ? image.score : image.temporal_score;
            return Number(primaryScore ?? fallbackScore ?? 0);
        };

        // Bước 1: Nhóm các frame vào một object theo videoName
        const groups = images.reduce((acc, image) => {
            const videoName = image.videoName;
            const score = getSortScore(image);

            if (!acc[videoName]) {
                acc[videoName] = {
                    videoName: videoName,
                    bestScore: -1,
                    frames: []
                };
            }

            acc[videoName].frames.push(image);
            if (score > acc[videoName].bestScore) {
                acc[videoName].bestScore = score;
            }

            return acc;
        }, {});

        // Bước 2: Chuyển object thành mảng và sắp xếp các nhóm dựa trên bestScore
        const sortedGroups = Object.values(groups).sort((a, b) => b.bestScore - a.bestScore);

        // Bước 3: Sắp xếp các frame bên trong mỗi nhóm theo điểm số
        sortedGroups.forEach(group => {
            group.frames.sort((a, b) => getSortScore(b) - getSortScore(a));
        });

        return sortedGroups;
    }

    function addFramesToQueue(framesData) {
        if (!framesData || framesData.length === 0) {
            return;
        }

        // 1. Set biến ID để target (luôn lấy frame đầu tiên trong danh sách được thêm)
        lastAddedFrameId = framesData[0].frameIdentifier;

        // 2. Gửi yêu cầu lên server
        sendWebSocketMessage('add_frames', { frames: framesData });

        // 3. Hiển thị thông báo (có thể tùy chỉnh)
        const frameCount = framesData.length;
        showToastNotification(`Đã thêm ${frameCount} frame vào queue.`, 'success');

        // Logic bổ sung nếu cần, ví dụ: xóa lựa chọn hiện tại
        if (frameSelectionManager.getSelectionCount() > 0) {
            frameSelectionManager.clearAllSelections();
        }
    }


    function createImageItemElement(image, selectionManager = frameSelectionManager) {
        const imageItem = document.createElement('div');

        imageItem.className = 'image-item';
        const uniqueFrameId = image.frameIdentifier;
        imageItem.setAttribute('data-frame-id', uniqueFrameId);
        imageItem.setAttribute('data-frame-identifier', image.frameIdentifier);
        applyFrameStatusClasses(imageItem, image.frameIdentifier);


        let scoreHtml = '';
        // if (image.temporal_score > 0) {
        //     scoreHtml = `<div class="score-overlay temporal">T-Score: ${image.temporal_score.toFixed(4)}</div>`;
        // }
        // else if (image.score > 0) {
        //     scoreHtml = `<div class="score-overlay">${image.score.toFixed(4)}</div>`;
        // }
        imageItem.innerHTML = `
        <img src="${resolveFrameUrl(image.path)}" data-frame-source="${image.path}" alt="${uniqueFrameId}" loading="lazy">
        ${scoreHtml}
        <div class="frame-info">${image.frameIdentifier}</div>
        `;

        imageItem.addEventListener('mousedown', function (event) {
            blurActiveInput();
            if (event.button === 2) {
                event.preventDefault();
                openVideoModal(image.videoName, image.timestamp);
            } else if (event.button === 0) {
                event.preventDefault();
                const isModalItem = selectionManager === modalFrameSelectionManager;
                if (!isModalItem) {
                    showKeyframePreview(image);
                }
                if (event.ctrlKey) {
                    selectionManager.toggleSelection(uniqueFrameId, { id: image.id, path: image.path, element: imageItem, data: image });
                } else {
                    if (!isModalItem) {
                        clearQueueSelection();
                    }
                    selectionManager.clearAllSelections();
                    selectionManager.selectFrame(uniqueFrameId, { id: image.id, path: image.path, element: imageItem, data: image });
                }
            } else if (event.button === 1) {
                event.preventDefault();
                openImageModal(image);
            }
        });

        imageItem.addEventListener('contextmenu', e => e.preventDefault());
        return imageItem;
    }

    function renderGridLayout(isReranked = false) {
        const loadingMore = document.getElementById('loadingMore');
        let headerHtml = isReranked ? `<h3 class="reranked-results-header">T Reranked</h3>` : '';

        // Tạo container và các cột
        const masonryContainer = document.createElement('div');
        masonryContainer.className = 'masonry-container';
        const numberOfColumns = 6;
        for (let i = 0; i < numberOfColumns; i++) {
            const column = document.createElement('div');
            column.className = 'masonry-column';
            masonryContainer.appendChild(column);
        }

        // Chèn header và container VÀO TRƯỚC phần tử "loading"
        if (loadingMore) {
            if (headerHtml) {
                // Tạm thời tạo một div để chứa chuỗi HTML
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = headerHtml;
                contentArea.insertBefore(tempDiv.firstChild, loadingMore);
            }
            contentArea.insertBefore(masonryContainer, loadingMore);
        } else {
            // Fallback nếu không tìm thấy loadingMore
            if (headerHtml) contentArea.innerHTML = headerHtml;
            contentArea.appendChild(masonryContainer);
        }
    }

    function loadMoreGroups() {
        if (isLoading || hasReachedEnd) return;

        isLoading = true;
        const loadingMore = document.getElementById('loadingMore');
        if (loadingMore) loadingMore.style.display = 'flex';

        const startIndex = displayedGroupsCount;
        const endIndex = Math.min(startIndex + GROUPS_PER_BATCH, allGroupedData.length);

        if (startIndex >= allGroupedData.length) {
            hasReachedEnd = true;
            isLoading = false;
            if (loadingMore) loadingMore.style.display = 'none';
            return;
        }

        setTimeout(() => {
            for (let i = startIndex; i < endIndex; i++) {
                const group = allGroupedData[i];

                // (Code tạo groupRow vẫn giữ nguyên...)
                const groupRow = document.createElement('div');
                groupRow.className = 'video-group-row';
                const title = document.createElement('h4');
                title.className = 'video-group-title';
                title.innerHTML = `<i class="fas fa-video"></i> ${group.videoName} <span>(${group.frames.length} frames)</span>`;
                groupRow.appendChild(title);
                const frameStrip = document.createElement('div');
                frameStrip.className = 'frame-strip';
                group.frames.forEach(image => {
                    frameStrip.appendChild(createImageItemElement(image));
                });
                groupRow.appendChild(frameStrip);

                // === THAY ĐỔI QUAN TRỌNG NHẤT LÀ ĐÂY ===
                // Chèn hàng video mới VÀO TRƯỚC phần tử "loading"
                if (loadingMore) {
                    contentArea.insertBefore(groupRow, loadingMore);
                } else {
                    contentArea.appendChild(groupRow); // Fallback
                }
            }

            displayedGroupsCount = endIndex;

            if (displayedGroupsCount >= allGroupedData.length) {
                hasReachedEnd = true;
                if (loadingMore) loadingMore.style.display = 'none';
            }

            isLoading = false;
        }, 100);
    }

    function updateLayoutButton() {
        if (!toggleLayoutBtn) return;

        if (currentLayout === 'grid') {
            // Nếu đang ở layout Lưới, nút sẽ hiển thị icon để chuyển sang layout Gom nhóm
            toggleLayoutBtn.innerHTML = '<i class="fas fa-list"></i>';
            toggleLayoutBtn.title = 'Chuyển sang layout Gom nhóm (Tab)';
        } else {
            // Nếu đang ở layout Gom nhóm, nút sẽ hiển thị icon để chuyển sang layout Lưới
            toggleLayoutBtn.innerHTML = '<i class="fas fa-th"></i>';
            toggleLayoutBtn.title = 'Chuyển sang layout Lưới (Tab)';
        }
    }


    function toggleLayout() {
        // Chuyển đổi trạng thái
        currentLayout = currentLayout === 'grid' ? 'grouped' : 'grid';

        // Cập nhật giao diện nút
        updateLayoutButton();

        // Hiển thị thông báo
        const layoutName = currentLayout === 'grid' ? 'Lưới (Grid)' : 'Gom theo Video (Grouped)';
        showToastNotification(`Đã chuyển sang layout: ${layoutName}`, 'success', 1500);

        // Render lại kết quả với layout mới, nếu có dữ liệu
        if (allImages && allImages.length > 0) {
            handleSearchResults(allImages, currentResultsAreReranked);
        }
    }

    function setupInfiniteScrollForGrid() {
        if (window.currentInfiniteScrollObserver) {
            window.currentInfiniteScrollObserver.disconnect();
        }

        let loadingMore = document.getElementById('loadingMore');
        if (!loadingMore) return;

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !isLoading && !hasReachedEnd) {
                    loadMoreImages(); // Gọi hàm tải ảnh
                }
            });
        }, {
            root: mainContent,
            rootMargin: '0px 0px 300px 0px',
            threshold: 0.1
        });

        observer.observe(loadingMore);
        window.currentInfiniteScrollObserver = observer;
    }

    function setupInfiniteScrollForGroups() {
        if (window.currentInfiniteScrollObserver) {
            window.currentInfiniteScrollObserver.disconnect();
        }

        let loadingMore = document.getElementById('loadingMore');
        if (!loadingMore) {
            console.error("Phần tử #loadingMore không tồn tại!");
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting && !isLoading && !hasReachedEnd) {
                    loadMoreGroups(); // Gọi hàm tải nhóm mới
                }
            });
        }, {
            root: mainContent, // Quan sát bên trong vùng main-content
            rootMargin: '0px 0px 300px 0px', // Trigger trước khi đến cuối 300px
            threshold: 0.1
        });

        observer.observe(loadingMore);
        window.currentInfiniteScrollObserver = observer;
    }

    function toggleQueueMode() {
        isFormSubmitMode = !isFormSubmitMode;

        if (isFormSubmitMode) {
            // Chuyển sang chế độ Form Submit cá nhân
            submitQueueContainer.style.display = 'none';
            formSubmitQueueContainer.style.display = 'flex';
            toggleQueueModeBtn.classList.add('active');
            toggleQueueModeBtn.title = "Chuyển sang Submit Queue cộng tác";
            toggleQueueModeBtn.innerHTML = '<i class="fas fa-users"></i>';
            showToastNotification("Đã chuyển sang chế độ Form Submit cá nhân", "success");
        } else {
            // Quay lại chế độ Submit Queue cộng tác
            formSubmitQueueContainer.style.display = 'none';
            submitQueueContainer.style.display = 'flex';
            toggleQueueModeBtn.classList.remove('active');
            toggleQueueModeBtn.title = "Chuyển sang Form Submit cá nhân";
            toggleQueueModeBtn.innerHTML = '<i class="fas fa-user"></i>';
            showToastNotification("Đã quay lại chế độ Submit Queue cộng tác", "success");
        }
    }

    /**
     * Thêm một frame vào Form Submit Queue
     * @param {object} frameData - Dữ liệu đầy đủ của frame
     */
    function addToFormSubmitQueue(frameData) {

        if (!isFormSubmitMode) {
            toggleQueueMode();
        }

        const videoId = frameData.videoName;
        const frameId = frameData.frame_id_ori;

        // 1. Kiểm tra ràng buộc video
        if (formSubmitLockedVideoId && formSubmitLockedVideoId !== videoId) {
            showToastNotification(`Queue chỉ chấp nhận frame từ video: ${formSubmitLockedVideoId}`, "error");
            return;
        }

        // 2. Kiểm tra trùng lặp
        if (formSubmitQueue.some(item => item.frame_id_ori === frameId)) {
            showToastNotification(`Frame ${frameData.frameIdentifier} đã có trong queue.`, "info");
            return;
        }

        // 3. Nếu queue rỗng, khóa videoId lại
        if (formSubmitQueue.length === 0) {
            formSubmitLockedVideoId = videoId;
        }

        // 4. Thêm frame vào mảng và render lại
        formSubmitQueue.push(frameData);
        renderFormSubmitQueue();
        showToastNotification(`Đã thêm ${frameData.frameIdentifier} vào Form Submit.`, "success", 1500);
    }

    /**
     * Vẽ lại toàn bộ giao diện của Form Submit Queue từ mảng `formSubmitQueue`
     */
    function renderFormSubmitQueue() {

        if (formSubmitQueue.length > 0) {
            if (isFormSubmitMode) {
                formSubmitQueueContainer.classList.add('visible');
            }
        } else {
            formSubmitQueueContainer.classList.remove('visible');
            if (isFormSubmitMode) {
                toggleQueueMode();
            }
        }

        formSubmitQueueFramesContainer.innerHTML = ''; // Xóa sạch

        formSubmitQueue.forEach((frameData, index) => {
            const isFromVideoClass = frameData.isFromVideo ? 'from-video' : '';
            const frameElement = document.createElement('div');
            frameElement.className = `queue-frame-item ${isFromVideoClass}`;
            frameElement.dataset.frameId = frameData.frameIdentifier;
            frameElement.dataset.index = index; // Lưu index để sắp xếp
            frameElement.draggable = true;

            frameElement.innerHTML = `
            <div class="queue-frame-image-container">
            <img src="${resolveFrameUrl(frameData.path)}" data-frame-source="${frameData.path}" alt="Queued frame">
            ${frameData.isFromVideo ? `<div class="queue-frame-user">LIVE</div>` : ''}
            <button class="remove-queue-item-btn" title="Xóa khỏi queue">×</button>
            </div>
            <div class="queue-frame-info-bar">${frameData.frameIdentifier}</div>
            `;

            frameElement.addEventListener('mouseenter', () => {
                currentlyHoveredFormQueueFrameData = frameData;
            });
            frameElement.addEventListener('mouseleave', () => {
                currentlyHoveredFormQueueFrameData = null;
            });

            // Gắn sự kiện xóa
            frameElement.querySelector('.remove-queue-item-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                formSubmitQueue.splice(index, 1);
                if (formSubmitQueue.length === 0) {
                    formSubmitLockedVideoId = null; // Mở khóa nếu queue rỗng
                }
                renderFormSubmitQueue();
            });

            // Gắn các sự kiện tương tác
            frameElement.addEventListener('contextmenu', e => {
                e.preventDefault();
                openVideoModal(frameData.videoName, frameData.timestamp);
            });

            formSubmitQueueFramesContainer.appendChild(frameElement);
        });

        // Logic kéo thả
        setupDragAndDrop();

        // Cập nhật trạng thái nút Submit
        formSubmitBtn.disabled = formSubmitQueue.length === 0 || formSubmitFilename.value.trim() === '';
    }


    /**
     * Thiết lập sự kiện kéo-thả cho các item trong queue
     */
    function setupDragAndDrop() {
        const items = formSubmitQueueFramesContainer.querySelectorAll('.queue-frame-item');

        items.forEach(item => {
            item.addEventListener('dragstart', () => {
                draggedItem = item;
                setTimeout(() => item.style.display = 'none', 0);
            });

            item.addEventListener('dragend', () => {
                setTimeout(() => {
                    draggedItem.style.display = '';
                    draggedItem = null;
                }, 0);
            });

            item.addEventListener('dragover', e => {
                e.preventDefault();
                const afterElement = getDragAfterElement(formSubmitQueueFramesContainer, e.clientX);
                if (afterElement == null) {
                    formSubmitQueueFramesContainer.appendChild(draggedItem);
                } else {
                    formSubmitQueueFramesContainer.insertBefore(draggedItem, afterElement);
                }
            });
        });

        formSubmitQueueFramesContainer.addEventListener('drop', () => {
            // Cập nhật lại mảng `formSubmitQueue` theo thứ tự DOM mới
            const newOrder = Array.from(formSubmitQueueFramesContainer.querySelectorAll('.queue-frame-item'))
                .map(el => formSubmitQueue[parseInt(el.dataset.index)]);
            formSubmitQueue = newOrder;
            // Render lại để cập nhật dataset.index cho đúng
            renderFormSubmitQueue();
        });
    }

    function getDragAfterElement(container, x) {
        const draggableElements = [...container.querySelectorAll('.queue-frame-item:not([style*="display: none"])')];

        return draggableElements.reduce((closest, child) => {
            const box = child.getBoundingClientRect();
            const offset = x - box.left - box.width / 2;
            if (offset < 0 && offset > closest.offset) {
                return { offset: offset, element: child };
            } else {
                return closest;
            }
        }, { offset: Number.NEGATIVE_INFINITY }).element;
    }

    async function handleFormSubmit() {
        if (formSubmitQueue.length === 0) return;

        const payload = {
            video_name: formSubmitLockedVideoId,
            frame_indices: formSubmitQueue.map(f => f.frame_id_ori),
            answer: formSubmitText.value.trim(),
            filename: formSubmitFilename.value.trim()
        };

        try {
            formSubmitBtn.disabled = true;
            formSubmitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Submitting...';

            const response = await fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/form-submit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                const result = await response.json();
                showToastNotification(`Thành công: ${result.message}`, "success");
                clearFormSubmitQueue(); // Tự động xóa sau khi submit thành công
            } else {
                const error = await response.json();
                throw new Error(error.detail || 'Lỗi không xác định từ server');
            }

        } catch (error) {
            showToastNotification(`Submit thất bại: ${error.message}`, "error");
        } finally {
            formSubmitBtn.disabled = false;
            formSubmitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Submit';
        }
    }

    function clearFormSubmitQueue() {
        formSubmitQueue = [];
        formSubmitLockedVideoId = null;
        formSubmitText.value = '';
        formSubmitFilename.value = '';
        renderFormSubmitQueue();
    }

    function getTrakeFrameStep() {
        return Math.max(1, Math.min(100, parseInt(trakeFrameStepInput.value, 10) || 1));
    }

    function formatTrakeTimestamp(frameIndex, fps) {
        const totalMs = Math.max(0, Math.round((frameIndex / fps) * 1000));
        const minutes = Math.floor(totalMs / 60000);
        const seconds = Math.floor((totalMs % 60000) / 1000);
        const milliseconds = totalMs % 1000;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
    }

    function updateTrakeFrameReadout() {
        if (!trakeController.ready) {
            trakeFrameIndex.textContent = 'Frame --';
            trakeFrameTimestamp.textContent = '--:--.---';
            return;
        }
        trakeFrameIndex.textContent = `Frame ${trakeController.desiredFrameIndex}`;
        trakeFrameTimestamp.textContent = formatTrakeTimestamp(trakeController.desiredFrameIndex, trakeController.fps);
    }

    async function prepareTrakeTimeline(videoName, initialTime = 0) {
        trakeController.ready = false;
        trakeController.fps = null;
        trakeController.seekGeneration++;
        trakeFpsStatus.classList.remove('error');
        trakeFpsStatus.textContent = 'Loading FPS...';
        updateTrakeFrameReadout();
        try {
            const fps = await getFpsForVideo(videoName);
            if (currentVideoModalData.videoName !== videoName) return;
            const initialFrame = Math.max(0, Math.round(initialTime * fps));
            trakeController.fps = fps;
            trakeController.desiredFrameIndex = initialFrame;
            trakeController.renderedFrameIndex = initialFrame;
            trakeController.ready = true;
            trakeFpsStatus.textContent = `${fps} FPS · ${frameServeLocation}`;
            updateTrakeFrameReadout();
        } catch (error) {
            trakeFpsStatus.classList.add('error');
            trakeFpsStatus.textContent = 'FPS metadata unavailable';
        }
    }

    function toggleTrakeMode(isActive) {
        isTrakeMode = isActive;
        videoModal.classList.toggle('trake-active', isActive);

        const player = document.getElementById('videoPlayer');
        if (isActive) {
            player.pause();
            player.addEventListener('wheel', handleVideoScrub, { passive: false });
            player.addEventListener('timeupdate', handleTrakePlaybackProgress);
            trakeFrameStepInput.value = getUserScopedSetting('trake_frame_step', '1');
            if (trakeController.ready) {
                const currentFrame = Math.max(0, Math.round(player.currentTime * trakeController.fps));
                trakeController.desiredFrameIndex = currentFrame;
                trakeController.renderedFrameIndex = currentFrame;
                updateTrakeFrameReadout();
            }
        } else {
            player.removeEventListener('wheel', handleVideoScrub);
            player.removeEventListener('timeupdate', handleTrakePlaybackProgress);
            clearTimeout(trakeController.seekTimer);
        }
    }

    function handleTrakePlaybackProgress(event) {
        if (!isTrakeMode || !trakeController.ready || event.currentTarget.paused) return;
        const frameIndex = Math.max(0, Math.round(event.currentTarget.currentTime * trakeController.fps));
        trakeController.desiredFrameIndex = frameIndex;
        trakeController.renderedFrameIndex = frameIndex;
        updateTrakeFrameReadout();
    }

    function handleVideoScrub(e) {
        e.preventDefault();
        const direction = e.deltaY > 0 ? 1 : -1;
        const multiplier = e.shiftKey ? 10 : 1;
        queueTrakeFrameStep(direction * getTrakeFrameStep() * multiplier);
    }

    function queueTrakeFrameStep(delta) {
        if (!trakeController.ready) {
            showToastNotification('FPS metadata is still loading.', 'info');
            return;
        }
        const player = document.getElementById('videoPlayer');
        player.pause();
        const maxFrame = Number.isFinite(player.duration)
            ? Math.max(0, Math.floor(player.duration * trakeController.fps) - 1)
            : Number.MAX_SAFE_INTEGER;
        trakeController.desiredFrameIndex = Math.max(0, Math.min(maxFrame, trakeController.desiredFrameIndex + delta));
        updateTrakeFrameReadout();
        clearTimeout(trakeController.seekTimer);
        trakeController.seekTimer = setTimeout(flushTrakeSeek, 45);
    }

    async function flushTrakeSeek() {
        if (!trakeController.ready || trakeController.seekInFlight) return;
        const player = document.getElementById('videoPlayer');
        const targetFrame = trakeController.desiredFrameIndex;
        const generation = ++trakeController.seekGeneration;
        trakeController.seekInFlight = true;

        try {
            const targetTime = targetFrame / trakeController.fps;
            await new Promise(resolve => {
                let settled = false;
                const finish = () => {
                    if (settled) return;
                    settled = true;
                    player.removeEventListener('seeked', finish);
                    resolve();
                };
                player.addEventListener('seeked', finish, { once: true });
                player.currentTime = Math.max(0, Math.min(player.duration || targetTime, targetTime));
                setTimeout(finish, 2500);
            });

            if (generation !== trakeController.seekGeneration) return;
            const mediaTime = await new Promise(resolve => {
                if (typeof player.requestVideoFrameCallback === 'function') {
                    const fallback = setTimeout(() => resolve(player.currentTime), 250);
                    player.requestVideoFrameCallback((_, metadata) => {
                        clearTimeout(fallback);
                        resolve(metadata.mediaTime);
                    });
                } else {
                    requestAnimationFrame(() => resolve(player.currentTime));
                }
            });
            const renderedFrame = Math.max(0, Math.round(mediaTime * trakeController.fps));
            trakeController.renderedFrameIndex = renderedFrame;
            const mustReachExactTarget = trakeController.waiters.some(waiter => waiter.targetFrame === targetFrame);
            if (trakeController.desiredFrameIndex === targetFrame && !mustReachExactTarget) {
                trakeController.desiredFrameIndex = renderedFrame;
                updateTrakeFrameReadout();
            }
        } finally {
            trakeController.seekInFlight = false;
            const pendingWaiters = [];
            trakeController.waiters.splice(0).forEach(waiter => {
                if (waiter.targetFrame === trakeController.renderedFrameIndex) {
                    waiter.resolve(trakeController.renderedFrameIndex);
                } else {
                    pendingWaiters.push(waiter);
                }
            });
            trakeController.waiters.push(...pendingWaiters);
            if (trakeController.desiredFrameIndex !== trakeController.renderedFrameIndex) {
                clearTimeout(trakeController.seekTimer);
                trakeController.seekTimer = setTimeout(flushTrakeSeek, 0);
            }
        }
    }

    async function waitForRenderedTrakeFrame(targetFrame = trakeController.desiredFrameIndex) {
        if (!trakeController.ready) throw new Error('FPS metadata is not ready.');
        const player = document.getElementById('videoPlayer');
        trakeController.desiredFrameIndex = Math.max(0, targetFrame);
        updateTrakeFrameReadout();
        if (player.readyState < 2) {
            await new Promise(resolve => {
                const finish = () => {
                    player.removeEventListener('canplay', finish);
                    resolve();
                };
                player.addEventListener('canplay', finish, { once: true });
                setTimeout(finish, 5000);
            });
        }
        if (!trakeController.seekInFlight && trakeController.desiredFrameIndex === trakeController.renderedFrameIndex) {
            if (typeof player.requestVideoFrameCallback === 'function') {
                await new Promise(resolve => {
                    const fallback = setTimeout(() => resolve(), 250);
                    player.requestVideoFrameCallback((_, metadata) => {
                        clearTimeout(fallback);
                        trakeController.renderedFrameIndex = Math.max(0, Math.round(metadata.mediaTime * trakeController.fps));
                        trakeController.desiredFrameIndex = trakeController.renderedFrameIndex;
                        updateTrakeFrameReadout();
                        resolve();
                    });
                });
            }
            return trakeController.renderedFrameIndex;
        }
        const renderedFrame = await new Promise((resolve, reject) => {
            const waiter = { targetFrame, resolve };
            trakeController.waiters.push(waiter);
            clearTimeout(trakeController.seekTimer);
            trakeController.seekTimer = setTimeout(flushTrakeSeek, 0);
            setTimeout(() => {
                const waiterIndex = trakeController.waiters.indexOf(waiter);
                if (waiterIndex === -1) return;
                trakeController.waiters.splice(waiterIndex, 1);
                trakeController.desiredFrameIndex = trakeController.renderedFrameIndex;
                clearTimeout(trakeController.seekTimer);
                updateTrakeFrameReadout();
                reject(new Error(`Không thể render chính xác frame ${targetFrame}.`));
            }, 6000);
        });
        return renderedFrame;
    }

    function captureTrakeThumbnail(player) {
        if (!player.videoWidth || !player.videoHeight) return Promise.resolve(null);
        const canvas = document.createElement('canvas');
        const width = 160;
        canvas.width = width;
        canvas.height = Math.max(1, Math.round(width * player.videoHeight / player.videoWidth));
        try {
            canvas.getContext('2d').drawImage(player, 0, 0, canvas.width, canvas.height);
            return new Promise(resolve => {
                let settled = false;
                const finish = blob => {
                    if (settled) return;
                    settled = true;
                    resolve(blob);
                };
                canvas.toBlob(finish, 'image/webp', 0.55);
                setTimeout(() => finish(null), 1000);
            });
        } catch (error) {
            console.warn('TRAKE local thumbnail capture skipped:', error);
            return Promise.resolve(null);
        }
    }

    async function captureThumbnailForMutation(requestId, player) {
        const mutation = trakePendingMutations.get(requestId);
        if (!mutation) return;
        try {
            mutation.thumbnailBlob = await captureTrakeThumbnail(player);
            if (mutation.thumbnailBlob) {
                const thumbnailUrl = URL.createObjectURL(mutation.thumbnailBlob);
                trakeLocalThumbnailUrls.set(requestId, thumbnailUrl);
                mutation.payload.thumbnailUrl = thumbnailUrl;
                renderTrakeQueue(trakeQueueState.map(frame => frame.requestId === requestId
                    ? { ...frame, thumbnailUrl }
                    : frame));
            }
        } finally {
            mutation.thumbnailCaptureDone = true;
            maybeFinalizeTrakeMutation(requestId);
        }
    }

    async function captureAndSubmitTrakeFrame(eventNumber) {
        const currentVideoName = currentVideoModalData.videoName;
        if (trakeQueuedEvents.has(eventNumber)) {
            showToastNotification(`Đang chuẩn bị frame cho sự kiện ${eventNumber}.`, 'info', 1200);
            return;
        }
        const lockedFrame = trakeQueueState.find(frame => frame.status !== 'failed');
        if (lockedFrame && currentVideoName !== lockedFrame.videoName) {
            showToastNotification(`Hàng đợi TRAKE đã bị khóa cho video: ${lockedFrame.videoName}`, 'error');
            return;
        }

        const existingFrame = trakeQueueState.find(frame => frame.eventNumber === eventNumber);
        const pendingAssignment = [...trakePendingMutations.values()]
            .find(mutation => !mutation.acked && mutation.payload.eventNumber === eventNumber);
        if (pendingAssignment) {
            showToastNotification(`Đang đồng bộ frame cho sự kiện ${eventNumber}.`, 'info', 1200);
            return;
        }
        if (existingFrame && existingFrame.submitted_by !== currentUser) {
            const confirmed = confirm(`Sự kiện ${eventNumber} đã có frame do "${existingFrame.submitted_by}" chọn.\nBạn có chắc muốn ghi đè không?`);
            if (!confirmed) return;
        }

        const targetFrame = trakeController.desiredFrameIndex;
        const placeholder = {
            requestId: `capture-${eventNumber}-${createRequestId()}`,
            eventNumber,
            videoName: currentVideoName,
            frameIdentifier: `Preparing frame ${targetFrame}...`,
            timestamp: 'Preparing frame...',
            submitted_by: currentUser,
            status: 'pending',
            isPlaceholder: true,
            isFromVideo: true
        };
        trakeCapturePlaceholders.set(eventNumber, { placeholder, previousFrame: existingFrame });
        trakeQueueState = [...trakeQueueState.filter(frame => frame.eventNumber !== eventNumber), placeholder]
            .sort((a, b) => a.eventNumber - b.eventNumber);
        renderTrakeQueue(trakeQueueState);
        trakeQueuedEvents.add(eventNumber);
        const assignment = trakeCaptureChain.then(() => processTrakeFrameAssignment(
            eventNumber,
            targetFrame,
            currentVideoName,
            existingFrame
        ));
        trakeCaptureChain = assignment.catch(() => {});
        assignment.then(
            () => finishTrakeCapturePlaceholder(eventNumber),
            () => finishTrakeCapturePlaceholder(eventNumber)
        );
        return assignment;
    }

    function finishTrakeCapturePlaceholder(eventNumber) {
        trakeQueuedEvents.delete(eventNumber);
        const capture = trakeCapturePlaceholders.get(eventNumber);
        if (!capture) return;
        const placeholderStillVisible = trakeQueueState.some(frame => frame.requestId === capture.placeholder.requestId);
        if (placeholderStillVisible) {
            const restored = capture.previousFrame
                ? [...trakeQueueState.filter(frame => frame.eventNumber !== eventNumber), capture.previousFrame]
                : trakeQueueState.filter(frame => frame.eventNumber !== eventNumber);
            renderTrakeQueue(restored);
        }
        trakeCapturePlaceholders.delete(eventNumber);
    }

    async function processTrakeFrameAssignment(eventNumber, targetFrame, currentVideoName, existingFrame) {
        if (currentVideoModalData.videoName !== currentVideoName) return;
        const player = document.getElementById('videoPlayer');
        player.pause();
        try {
            const frameNumber = await waitForRenderedTrakeFrame(targetFrame);
            const timestamp = formatTrakeTimestamp(frameNumber, trakeController.fps);
            const requestId = createRequestId();
            const frameData = {
                requestId,
                eventNumber,
                videoName: currentVideoName,
                frameIndex: frameNumber,
                frame_id_ori: frameNumber,
                timestampMs: Math.round(frameNumber / trakeController.fps * 1000),
                timestamp,
                fps: trakeController.fps,
                frameIdentifier: `${currentVideoName}_${frameNumber}`,
                expectedRevision: existingFrame?.revision
                    || trakePendingClears.get(eventNumber)?.payload.expectedRevision
                    || 0,
                submitted_by: currentUser,
                status: 'pending',
                thumbnailUrl: null,
                isFromVideo: true
            };

            trakePendingMutations.set(requestId, {
                payload: frameData,
                thumbnailBlob: null,
                thumbnailCaptureDone: false,
                acked: false,
                thumbnailUploadStarted: false,
                sendAttempts: 0,
                ackTimer: null,
                retryTimer: null
            });
            trakeQueueState = [...trakeQueueState.filter(frame => frame.eventNumber !== eventNumber), frameData]
                .sort((a, b) => a.eventNumber - b.eventNumber);
            renderTrakeQueue(trakeQueueState);
            sendPendingTrakeMutation(trakePendingMutations.get(requestId));
            void captureThumbnailForMutation(requestId, player);
        } catch (error) {
            console.error('Lỗi khi chọn frame TRAKE:', error);
            showToastNotification(error.message || 'Không thể chọn frame.', 'error');
            throw error;
        }
    }

    function getTrakeThumbnailUrl(frameData) {
        if (frameData.thumbnailUrl) return frameData.thumbnailUrl;
        if (!frameData.thumbnailPath) return null;
        return frameData.thumbnailPath.startsWith('http')
            ? frameData.thumbnailPath
            : `${APP_CONFIG.REMOTE_BASE_URL}${frameData.thumbnailPath}`;
    }

    function renderTrakeQueue(frames = []) {
        trakeQueueState = [...frames].sort((a, b) => a.eventNumber - b.eventNumber);
        currentlyTargetedTrakeFrameData = null;
        const mainContainer = document.querySelector('.main-container');
        mainContainer.classList.toggle('trake-active', frames.length > 0);

        trakeStatusBar.querySelectorAll('.status-dot').forEach(dot => {
            const eventNumber = parseInt(dot.dataset.event, 10);
            const frame = frames.find(item => item.eventNumber === eventNumber);
            dot.classList.remove('empty', 'filled', 'pending', 'failed');
            dot.classList.add(frame ? (frame.status || 'filled') : (trakePendingClears.has(eventNumber) ? 'pending' : 'empty'));
        });

        trakeSubmitQueueFramesContainer.replaceChildren();
        trakeQueueState.forEach(frameData => {
            const frameElement = document.createElement('div');
            frameElement.className = `queue-frame-item trake-item ${frameData.status || 'filled'}`;
            frameElement.dataset.frameId = frameData.frameIdentifier;
            frameElement.tabIndex = 0;
            frameElement.title = 'Di chuột hoặc focus và nhấn S để semantic search';
            frameElement.addEventListener('mouseenter', () => {
                if (!frameData.isPlaceholder) currentlyTargetedTrakeFrameData = frameData;
            });
            frameElement.addEventListener('mouseleave', () => {
                if (currentlyTargetedTrakeFrameData === frameData && document.activeElement !== frameElement) {
                    currentlyTargetedTrakeFrameData = null;
                }
            });
            frameElement.addEventListener('focus', () => {
                if (!frameData.isPlaceholder) currentlyTargetedTrakeFrameData = frameData;
            });
            frameElement.addEventListener('blur', () => {
                if (currentlyTargetedTrakeFrameData === frameData && !frameElement.matches(':hover')) {
                    currentlyTargetedTrakeFrameData = null;
                }
            });

            const imageContainer = document.createElement('div');
            imageContainer.className = 'queue-frame-image-container';
            imageContainer.dataset.eventNumber = frameData.eventNumber;
            const thumbnailUrl = getTrakeThumbnailUrl(frameData);
            if (thumbnailUrl) {
                const image = document.createElement('img');
                image.src = thumbnailUrl;
                image.alt = 'TRAKE frame';
                image.loading = 'lazy';
                imageContainer.appendChild(image);
            } else {
                const placeholder = document.createElement('div');
                placeholder.className = 'trake-thumbnail-placeholder';
                placeholder.textContent = frameData.status === 'failed' ? 'Sync failed' : 'Loading preview...';
                imageContainer.appendChild(placeholder);
            }

            const user = document.createElement('div');
            user.className = 'queue-frame-user';
            user.textContent = frameData.submitted_by || 'Pending';
            imageContainer.appendChild(user);
            const removeButton = document.createElement('button');
            removeButton.className = 'remove-queue-item-btn';
            removeButton.title = 'Xóa frame này';
            removeButton.textContent = '×';
            removeButton.addEventListener('click', () => {
                clearTrakeFrameOptimistically(frameData);
            });
            imageContainer.appendChild(removeButton);

            const details = document.createElement('div');
            details.className = 'trake-frame-details';
            const identifier = document.createElement('strong');
            identifier.textContent = frameData.frameIdentifier;
            const timestamp = document.createElement('span');
            timestamp.textContent = frameData.timestamp;
            details.append(identifier, timestamp);
            frameElement.append(imageContainer, details);
            frameElement.addEventListener('contextmenu', event => {
                event.preventDefault();
                openVideoModal(frameData.videoName, frameData.timestamp);
            });
            trakeSubmitQueueFramesContainer.appendChild(frameElement);
        });

        submitTrakeBtn.disabled = frames.length === 0 || frames.some(frame => frame.status === 'pending');
    }

    function updateWrongSubmissionUI() {
        console.log('[UI Update] Bắt đầu chạy updateWrongSubmissionUI...');
        console.log('[UI Update] Danh sách ID sai hiện tại đang được dùng để kiểm tra:', new Set(wrongSubmissionIds));
        const allFrameElements = document.querySelectorAll('.image-item, .queue-frame-item');

        allFrameElements.forEach(element => {
            const frameId = element.dataset.frameId || element.dataset.frameIdentifier;
            if (!frameId) return;

            const isWrong = wrongSubmissionIds.has(frameId);
            element.classList.toggle('is-wrong-submission', isWrong);
        });
    }

    function toggleModalLayout() {
        modalCurrentLayout = (modalCurrentLayout === 'grid') ? 'grouped' : 'grid';
        updateModalLayoutButton();

        // SỬ DỤNG BIẾN TRẠNG THÁI ĐÁNG TIN CẬY
        if (modalQueryFrame) {
            // Render lại toàn bộ kết quả với layout mới
            // `modalAllImages` vẫn được lưu từ lần tải đầu tiên
            renderResultsInModal(modalQueryFrame, modalAllImages);
        }
    }

    /**
     * Cập nhật icon cho nút chuyển layout của modal
     */
    function updateModalLayoutButton() {
        const btn = document.getElementById('modalToggleLayoutBtn');
        if (!btn) return;

        if (modalCurrentLayout === 'grid') {
            btn.innerHTML = '<i class="fas fa-list"></i>';
            btn.title = 'Chuyển sang layout Gom nhóm (Tab)';
        } else {
            btn.innerHTML = '<i class="fas fa-th"></i>';
            btn.title = 'Chuyển sang layout Lưới (Tab)';
        }
    }

    /**
     * Tải thêm một đợt NHÓM VIDEO mới vào modal
     */
    function loadMoreModalGroups() {
        if (isModalLoading || modalHasReachedEnd) return;
        isModalLoading = true;

        const loadingMore = document.getElementById('modalLoadingMore');
        const startIndex = modalDisplayedGroupsCount;
        const endIndex = Math.min(startIndex + MODAL_GROUPS_PER_BATCH, modalAllGroupedData.length);

        // Dùng setTimeout để tránh UI bị "khựng" khi render nhiều
        setTimeout(() => {
            for (let i = startIndex; i < endIndex; i++) {
                const group = modalAllGroupedData[i];
                const groupRow = document.createElement('div');
                groupRow.className = 'video-group-row';

                const title = document.createElement('h4');
                title.className = 'video-group-title';
                title.innerHTML = `<i class="fas fa-video"></i> ${group.videoName} <span>(${group.frames.length} frames)</span>`;
                groupRow.appendChild(title);

                const frameStrip = document.createElement('div');
                frameStrip.className = 'frame-strip';
                group.frames.forEach(image => {
                    const imageItem = createImageItemElement(image, modalFrameSelectionManager);
                    frameStrip.appendChild(imageItem);
                });
                groupRow.appendChild(frameStrip);
                // Luôn chèn vào trước loader
                semanticSearchResultsContainer.insertBefore(groupRow, loadingMore);
            }

            modalDisplayedGroupsCount = endIndex;
            if (modalDisplayedGroupsCount >= modalAllGroupedData.length) {
                modalHasReachedEnd = true;
                if (loadingMore) loadingMore.remove();
            }

            isModalLoading = false;

        }, 100);
    }

});
function showToastNotification(message, type = 'success', duration = 2000) {
    const toast = document.createElement('div');
    toast.className = `toast-notification ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Kích hoạt animation
    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    // Tự động xóa sau một khoảng thời gian
    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove());
    }, duration);
}
