const APP_CONFIG = {
    // Địa chỉ của Backend API và Server Video trên server remote
    REMOTE_BASE_URL: 'http://192.168.20.170:8080',

    // Địa chỉ của WebSocket trên server remote
    WEBSOCKET_URL: 'ws://192.168.20.170:8080'
};


document.addEventListener('DOMContentLoaded', function() {
    let searchIdCounter = 1;
    let currentUserId = null;
    let currentSearchMode = 'text-to-image';
    let currentHeaderFocus = null;
    let isTranslationEnabled = false;
    let availableModels = [];
    let currentSelectedModel = 'all';
    let highlightedModelIndex = -1; // -1 nghĩa là chưa có mục nào được highlight
    let submitQueueFrames = new Map();
    let lastClickedFrameId = null;
    const DRES_FPS = 25; // Tốc độ khung hình/giây của video để tính toán.
    const DEFAULT_DRES_SESSION_ID = 'W3bboltdf9YxpnDh53znaS6Ml1doZvXq'; // !!! THAY THẾ BẰNG SESSION ID THẬT CỦA BẠN
    let currentlyHoveredPreviewFrameData = null;
    let isRestoringState = false;
    let currentLayout = 'grid';
    let isEventFilterEnabled = false;
    // Biến cho layout Nhóm (Grouped)
    let allGroupedData = [];
    let displayedGroupsCount = 0;
    const GROUPS_PER_BATCH = 5; 
    let hlsPlayerInstance = null;
    // Thêm một tham chiếu đến main-content để dùng cho IntersectionObserver
    const mainContent = document.querySelector('.main-content');


    let dresEvaluationId = null; // Biến để lưu evaluationId sau khi lấy được.
    let selectedQueueFrameIds = new Set(); // Dùng Set để quản lý các frame được chọn trong queue.

    let allImages = []; // Lưu trữ tất cả kết quả tìm kiếm
    let displayedImagesCount = 0; // Số lượng ảnh đã hiển thị

    let currentUser = null;
    let ws = null;
    let userColors = {}; // Lưu màu của tất cả user

    let metadataCache = new Map();

    const IMAGES_PER_BATCH = 60; // Số lượng ảnh hiển thị mỗi lần
    let isLoading = false; // Flag để kiểm tra đang tải thêm ảnh hay không
    let hasReachedEnd = false; // Flag để kiểm tra đã đến cuối danh sách chưa
    

    // Elements
    const textToImageBtn = document.getElementById('textToImageBtn');
    const textToTextBtn = document.getElementById('textToTextBtn');
    const imageToImageBtn = document.getElementById('imageToImageBtn');
    const translateBtn = document.getElementById('translateBtn');
    const searchInputsContainer = document.getElementById('searchInputsContainer');
    const contentArea = document.getElementById('contentArea');
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsMenu = document.getElementById('settingsMenu');
    const tagFilterBtn = document.getElementById('tagFilterBtn'); 
    const eventFilterBtn = document.getElementById('eventFilterBtn');
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
    const vqaSubmitBtn = document.getElementById('vqaSubmitBtn');
    const vqaModal = document.getElementById('vqaModal');
    const vqaForm = document.getElementById('vqaForm');
    const vqaIdInput = document.getElementById('vqaIdInput');
    const vqaAnswerInput = document.getElementById('vqaAnswerInput');
    const vqaCloseBtn = vqaModal.querySelector('.close-btn');
    const vqaOverlay = vqaModal.querySelector('.modal-overlay');

    const frameVqaModal = document.getElementById('frameVqaModal');
    const frameVqaForm = document.getElementById('frameVqaForm');
    const frameVqaIdInput = document.getElementById('frameVqaIdInput');
    const frameVqaAnswerDisplay = document.getElementById('frameVqaAnswerDisplay');
    const frameVqaCloseBtn = frameVqaModal.querySelector('.close-btn');
    const frameVqaOverlay = frameVqaModal.querySelector('.modal-overlay');

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

    let preparedAnswerData = null; // Biến tạm để lưu dữ liệu Answer
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

    function setupUnloadHandler() {
        window.addEventListener('unload', function() {
            if (currentUserId) {
                const formData = new FormData();
                formData.append('user_id', currentUserId);
                const cleanupUrl = `${APP_CONFIG.REMOTE_BASE_URL}/api/session/cleanup`;
                console.log("url_cleanup", cleanupUrl); 
                // Dùng sendBeacon để đảm bảo request được gửi đi ngay cả khi trang đang đóng
                navigator.sendBeacon(cleanupUrl, formData);
            }
        });
    }

    // Initialize
    function initializeEventListeners() {

        currentUserId = getOrCreateUserId(); // <<< THÊM VÀO
        setupUnloadHandler(); 

        const savedModel = localStorage.getItem('user_selected_model');
        if (savedModel) {
            currentSelectedModel = savedModel;
        } else {
            currentSelectedModel = 'all'; // Giá trị mặc định nếu chưa có gì được lưu
        }
        
        setupKeyboardNavigation();
        connectWebSocket();

        // Prevent right-click context menu
        document.addEventListener('contextmenu', function(e) {
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
        textToImageBtn.addEventListener('click', function() {
            switchSearchMode('text-to-image');
        });

        if (toggleLayoutBtn) {
            toggleLayoutBtn.addEventListener('click', toggleLayout);
        }

        imageToImageBtn.addEventListener('click', function() {
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

        ocrFilterBtn.addEventListener('click', function() {
            toggleFilter('ocr');
        });

        tagFilterBtn.addEventListener('click', function() {
            toggleFilter('tag');
        });

        asrFilterBtn.addEventListener('click', function() {
            toggleFilter('asr');
        });

        clearHistoryBtn.addEventListener('click', clearSearchHistory);
        historyBtn.addEventListener('click', toggleHistoryMenu);

        // Đóng các menu thả xuống khi click ra ngoài
        document.addEventListener('click', function(e) {
            if (historyMenu.classList.contains('visible') && !historyMenu.contains(e.target) && !historyBtn.contains(e.target)) {
                closeHistoryMenu();
            }
            // Bạn đã có sẵn logic này cho settingsMenu, đây là để đảm bảo nó vẫn hoạt động
            if (settingsMenu.classList.contains('visible') && !settingsMenu.contains(e.target) && !settingsBtn.contains(e.target)) {
                settingsMenu.classList.remove('visible');
            }
        });

        // Xử lý việc click vào một mục lịch sử
        historyListContainer.addEventListener('click', function(e) {
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

            check_timestamp =  frameData.timestamp;
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

        if (eventFilterBtn) { // <<< THÊM KHỐI LỆNH NÀY
            eventFilterBtn.addEventListener('click', function() {
                isEventFilterEnabled = !isEventFilterEnabled;
                this.classList.toggle('active', isEventFilterEnabled);
                const status = isEventFilterEnabled ? 'bật' : 'tắt';
                showToastNotification(`Bộ lọc sự kiện đã ${status}`, 'success');
            });
        }


        document.addEventListener('keydown', function(e) {

            if (e.key === 'Tab') {
                const activeElement = document.activeElement;
                const isTyping = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';

                if (!isTyping) {
                    e.preventDefault(); // Ngăn hành vi mặc định của Tab
                    toggleLayout();     // Gọi hàm chuyển layout chung
                }
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

        translateBtn.addEventListener('click', function() {
            isTranslationEnabled = !isTranslationEnabled; // Đảo ngược trạng thái
            this.classList.toggle('active', isTranslationEnabled); // Cập nhật UI
        });

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
                if (confirm('Are you sure you want to clear ALL frames for EVERYONE?')) {
                    // GỬI YÊU CẦU XÓA TẤT CẢ ĐẾN SERVER
                    sendWebSocketMessage('clear_all', {});
                }
            }
        });


        // Thêm listener cho phím tắt khi tương tác với queue
        document.addEventListener('keydown', (e) => {
            const activeElement = document.activeElement;
            const isTyping = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';




            //submit form






            // if (e.key === 'Enter' && !isTyping && frameSelectionManager.getSelectionCount() > 0) {
    
            //     // Ngăn chặn các hành vi mặc định khác của phím Enter
            //     e.preventDefault();

            //     // Lấy thông tin các frame đã chọn
            //     const selectedFrames = frameSelectionManager.getAllSelectedFrames();
                
            //     // *** THAY ĐỔI QUAN TRỌNG: Chỉ lấy 'frameIdentifier' từ mỗi frame ***
            //     const allFrameIdentifiers = selectedFrames.map(frame => frame.data.frameIdentifier);

            //     let answerData;
            //     answerData = allFrameIdentifiers;

            //     // Mở modal mới và truyền dữ liệu đã được đơn giản hóa vào
            //     openFrameVqaModal(answerData);

            //     // Bỏ chọn tất cả các frame sau khi mở modal
            //     frameSelectionManager.clearAllSelections();
            //     return; // Dừng lại để không chạy các logic khác của phím Enter
            // }








            













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
                                clearQueueSelection();
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

                                if(allFrames[nextIndex]) {
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
        updateLayoutButton();
        setTimeout(function() {
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
        return new Promise((resolve, reject) => {
            // Mở modal
            qaInputModal.style.display = 'flex';
            setTimeout(() => {
                qaInputModal.classList.add('visible');
                qaAnswerTextInput.focus(); // Tự động focus vào ô input
            }, 10);

            // Hàm để đóng modal và dọn dẹp
            const closeModal = (reason = 'closed') => {
                qaInputModal.classList.remove('visible');
                setTimeout(() => {
                    qaInputModal.style.display = 'none';
                    qaInputForm.reset(); // Xóa nội dung trong form
                    // Gỡ bỏ các event listener để tránh rò rỉ bộ nhớ
                    qaInputForm.onsubmit = null;
                    qaInputModalCloseBtn.onclick = null;
                    qaInputModalOverlay.onclick = null;
                    if (reason === 'closed') {
                        reject('Modal closed by user.'); // Từ chối promise nếu đóng
                    }
                }, 300);
            };

            // Gán sự kiện cho nút đóng và vùng nền
            qaInputModalCloseBtn.onclick = () => closeModal();
            qaInputModalOverlay.onclick = () => closeModal();

            // Xử lý khi form được submit
            qaInputForm.onsubmit = (e) => {
                e.preventDefault();
                const answerText = qaAnswerTextInput.value.trim();
                if (answerText) {
                    resolve(answerText); // Giải quyết promise với text
                    closeModal('submitted'); // Đóng modal sau khi submit
                }
            };
        });
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
        try {
            // Gọi hàm mở modal và đợi người dùng nhập câu trả lời
            const answerText = await getQaAnswerFromModal();
            
            // Nếu promise được giải quyết (người dùng đã submit), tiếp tục xử lý
            const selectedFrames = Array.from(selectedQueueFrameIds).map(id => submitQueueFrames.get(id));
            const success = await submitToDres(selectedFrames, 'QA', answerText);

            if (success){
                // Nếu thành công, xóa frame đã submit khỏi queue
                selectedFrames.forEach(frameData => {
                    sendWebSocketMessage('remove_frame', frameData);
                });
                selectedQueueFrameIds.clear();
                updateSubmitButtonStates();
            }
        } catch (error) {
            // Nếu promise bị từ chối (người dùng đóng modal), log ra console
            // Hoặc bạn có thể hiển thị một toast notification nhỏ
            console.log("QA submission canceled:", error);
            showToastNotification("QA submission canceled.", "error");
        }
    });


async function ensureDresPrerequisites() {
        // Nếu đã có evaluationId, không cần làm gì cả.
        if (dresEvaluationId) {
            return true;
        }

        // Kiểm tra xem session id mặc định đã được đặt chưa.
        if (!DEFAULT_DRES_SESSION_ID || DEFAULT_DRES_SESSION_ID === 'YOUR_SESSION_ID_HERE') {
            showToastNotification("Default DRES Session ID is not set in the code.", "error");
            return false;
        }

        try {
            showToastNotification("Fetching DRES evaluation list...", "success");
            const evalResponse = await fetch(`http://192.168.28.151:5000/api/v2/client/evaluation/list?session=${DEFAULT_DRES_SESSION_ID}`);

            if (!evalResponse.ok) {
                throw new Error(`Failed to get evaluation list: ${evalResponse.statusText}`);
            }
            const evalList = await evalResponse.json();
            
            // Tìm evaluation đang hoạt động
            const activeEvaluation = evalList.find(e => e.status === 'ACTIVE');
            if (!activeEvaluation) {
                throw new Error("No active evaluation found in DRES.");
            }

            dresEvaluationId = activeEvaluation.id;
            showToastNotification(`Active evaluation set: ${activeEvaluation.name}`, "success");
            return true;

        } catch (error) {
            console.error("DRES Prerequisites Error:", error);
            showToastNotification(error.message, "error", 3000);
            dresEvaluationId = null; // Reset lại để lần sau thử lại
            return false;
        }
    }

    /**
     * Hàm submit chính, có khả năng gửi cả KIS và QA.
     * @param {Array<Object>} framesToSubmit - Mảng các đối tượng frame được chọn.
     * @param {'KIS' | 'QA'} submissionType - Loại submit.
     * @param {string} [qaText=''] - Văn bản trả lời cho loại QA.
     */
    async function submitToDres(framesToSubmit, submissionType, qaText = '') {
        if (!framesToSubmit || framesToSubmit.length === 0) return false;

        // Đảm bảo đã có evaluationID.
        const isReady = await ensureDresPrerequisites();
        if (!isReady) {
            showToastNotification("Submission failed. Could not prepare DRES session.", "error");
            return false;
        }

        let submissionBody = {};

        try {
            if (submissionType === 'KIS') {
                let answers;
                if (framesToSubmit.length === 1) {
                    // Trường hợp 1 frame
                    const frame = framesToSubmit[0];
                    const fps = await getFpsForVideo(frame.videoName);
                    console.log("fps", fps);
                    const timeMs = Math.round((parseInt(frame.frame_id_ori, 10) / fps) * 1000);
                    console.log("frame id:", frame.frame_id_ori, "timeMs:", timeMs);
                    answers = [{ mediaItemName: frame.videoName, start: timeMs, end: timeMs }];
                } else {
                    // Trường hợp nhiều frame
                    const firstVideoName = framesToSubmit[0].videoName;
                    if (!framesToSubmit.every(f => f.videoName === firstVideoName)) {
                        throw new Error("Please select frames from the same video for KIS submission.");
                    }
                    const fps = await getFpsForVideo(framesToSubmit[0].videoName);
                    const frameIds = framesToSubmit.map(f => parseInt(f.frame_id_ori, 10));
                    const minTimeMs = Math.round((Math.min(...frameIds) / DRES_FPS) * 1000);
                    const maxTimeMs = Math.round((Math.max(...frameIds) / DRES_FPS) * 1000);
                    console.log("frame id:", frame.frame_id_ori, "timeMs:", minTimeMs, maxTimeMs);
                    answers = [{ mediaItemName: firstVideoName, start: minTimeMs, end: maxTimeMs }];
                }
                console.log("Final answers for KIS submission:", answers);
                submissionBody = { answerSets: [{ answers: answers }] };

            } else if (submissionType === 'QA') {
                if (framesToSubmit.length !== 1) throw new Error("QA submission only supports a single frame.");
                const frame = framesToSubmit[0];
                const fps = await getFpsForFrame(frame.videoName, parseInt(frame.frame_id_ori, 10));
                const timeMs = Math.round((parseInt(frame.frame_id_ori, 10) / fps) * 1000);
                console.log("frame id:", frame.frame_id_ori, "timeMs:", timeMs);
                const finalText = `${qaText}-${frame.videoName}-${timeMs}`;
                console.log("Final text for QA submission:", finalText);
                submissionBody = { answerSets: [{ answers: [{ text: finalText }] }] };

            } else {
                throw new Error("Invalid submission type.");
            }

            const submitUrl = `http://192.168.28.151:5000/api/v2/submit/${dresEvaluationId}?session=${DEFAULT_DRES_SESSION_ID}`;
            showToastNotification(`Submitting as ${submissionType}...`, "success");

            const response = await fetch(submitUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(submissionBody)
            });

            if (response.ok) {
                showToastNotification("Submission to DRES successful!", "success", 2000);
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
        
        // Xác định giao thức ws:// hoặc wss:// (cho https)
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${APP_CONFIG.WEBSOCKET_URL}/ws/queue/${currentUser}`;

        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log("WebSocket connection established for user:", currentUser);
        };

        ws.onmessage = (event) => {
            const message = JSON.parse(event.data);
            handleWebSocketMessage(message);
        };

        ws.onclose = () => {
            console.log("WebSocket connection closed. Attempting to reconnect...");
            // Thử kết nối lại sau 3 giây
            setTimeout(connectWebSocket, 3000);
        };

        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
            ws.close();
        };
    }

    function handleWebSocketMessage(message) {
        const { action, payload } = message;

        switch (action) {
            case 'init_state':
                userColors = payload.users;
                renderFullQueue(payload.queue);
                // renderUserLegend();
                break;
            case 'user_update':
                userColors = payload.users;
                // renderUserLegend();
                break;
            case 'frames_added':
                // Chỉ cần thêm các frame mới vào queue
                payload.forEach(frame => {
                    if (!submitQueueFrames.has(frame.frameIdentifier)) {
                        submitQueueFrames.set(frame.frameIdentifier, frame);
                    }
                });
                renderFullQueue(Array.from(submitQueueFrames.values()));
                break;
            case 'frame_removed':
                submitQueueFrames.delete(payload.frameIdentifier);
                renderFullQueue(Array.from(submitQueueFrames.values()));
                break;
            case 'queue_cleared':
                submitQueueFrames.clear();
                renderFullQueue([]);
                break;
        }
    }

    function sendWebSocketMessage(action, payload) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ action, payload }));
        } else {
            console.error("WebSocket is not connected.");
        }
    }






    function resetTagFiltering() {
        // 1. Tắt biến cờ toàn cục
        isTagFilterEnabled = false;
        // 2. Tắt trạng thái 'active' của nút
        const tagFilterBtn = document.getElementById('tagFilterBtn');
        if (tagFilterBtn) {
            tagFilterBtn.classList.remove('active');
        }

        // 3. Ẩn tất cả các ô nhập tag đang hiển thị
        // const allTagContainers = document.querySelectorAll('.tag-filter-container.visible');
        // allTagContainers.forEach(container => {
        //     container.classList.remove('visible');
        // });
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
        document.addEventListener('keydown', function(e) {
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
            
            btn.addEventListener('focus', function() {
                currentHeaderFocus = btn;
                headerButtons.forEach(b => b.classList.remove('keyboard-focus'));
                btn.classList.add('keyboard-focus');
            });
            
            btn.addEventListener('blur', function() {
                // Chỉ xóa highlight khi không chuyển focus sang nút header khác
                setTimeout(() => {
                    if (!headerButtons.includes(document.activeElement)) {
                        btn.classList.remove('keyboard-focus');
                        currentHeaderFocus = null;
                    }
                }, 10);
            });
            
            // Thêm sự kiện mouseenter/mouseleave để xử lý visual cues
            btn.addEventListener('mouseenter', function() {
                // Thêm class hover nếu cần
                btn.classList.add('header-btn-hover');
            });
            
            btn.addEventListener('mouseleave', function() {
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
        console.log('Selected model:', currentSelectedModel);
        localStorage.setItem('user_selected_model', modelName);
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
    async function translateText(text, sourceLang = 'vi', targetLang = 'en', apiKey = 'AIzaSyDvIhSOv06Tt8FTwOp40P1wjU9itsgDFvw') {
        if (!text || typeof text !== "string") return '';

        const url = `https://translation.googleapis.com/language/translate/v2?key=${apiKey}`;

        const body = {
            q: text,
            source: sourceLang,
            target: targetLang,
            format: 'text'
        };

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json();
            return data.data.translations[0].translatedText;
        } catch (error) {
            console.error('Official translation API error:', error);
            return text;
        }
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
                </div>
                <div class="asr-filter-container">
                    <input type="text" class="asr-input" placeholder="Enter ASR">
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

        // Auto-resize textarea
        textInput.addEventListener('input', function() {
            autoResizeTextarea(this); // Gọi hàm mới, code gọn hơn
            const translationDisplay = searchGroup.querySelector('.translated-query-display');
            if (translationDisplay) {
                translationDisplay.classList.remove('visible');
            }

            const suggestionDisplay = searchGroup.querySelector('.autocorrect-suggestion-display');
            if (suggestionDisplay) {
            suggestionDisplay.addEventListener('click', function() {
                if (this.classList.contains('visible') && this.dataset.suggestion) {
                    const correctedText = this.dataset.suggestion;
                    
                    // Cần lấy lại textInput ở đây vì nó nằm ngoài scope của event listener này
                    const textInput = searchGroup.querySelector('.search-input');
                    
                    textInput.value = correctedText + ' ';
                    
                    this.classList.remove('visible');
                    this.dataset.suggestion = '';
        
                    autoResizeTextarea(textInput);
                    textInput.focus(); // Focus lại vào ô search
                    textInput.selectionStart = textInput.selectionEnd = textInput.value.length;
                }
            });
        }

        });
        
        if (ocrInput) {
            ocrInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault(); // Ngăn submit form
                    textInput.focus(); // Quay về thanh tìm kiếm chính
                }
            });
        }

        if (tagInput) {
            tagInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault(); // Ngăn hành vi mặc định của Enter
                    
                    // Chuyển focus trở lại ô tìm kiếm chính
                    textInput.focus();
                }
            });
        }
        if (asrInput) {
            asrInput.addEventListener('keydown', function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault(); // Ngăn hành vi mặc định
                    textInput.focus(); // Chuyển focus trở lại ô tìm kiếm chính
                }
            });
        }
        textInput.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.blur(); // Thoát khỏi ô tìm kiếm
            }
        });

        textInput.addEventListener('keyup', async function(e) {
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

        textInput.addEventListener('keydown', function(e) {
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
        suggestionDisplay.addEventListener('click', function() {
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
        textInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const searchQuery = this.value;
                
                // Thực hiện tìm kiếm
                performSearch(searchQuery, 'text', searchGroup);
            }
        });
        
        textInput.addEventListener('keydown', function(e) {
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
        uploadZone.addEventListener('click', function() {
            imageInput.click();
        });
        
        // Image file selection
        imageInput.addEventListener('change', function(e) {
            const file = e.target.files[0];
            if (file) {
                handleImageUpload(file, searchGroup);
            }
        });
        
        // Drag and drop
        uploadZone.addEventListener('dragover', function(e) {
            e.preventDefault();
            this.classList.add('drag-over');
        });
        
        uploadZone.addEventListener('dragleave', function(e) {
            e.preventDefault();
            this.classList.remove('drag-over');
        });
        
        uploadZone.addEventListener('drop', function(e) {
            e.preventDefault();
            this.classList.remove('drag-over');
            
            const file = e.dataTransfer.files[0];
            if (file && file.type.startsWith('image/')) {
                handleImageUpload(file, searchGroup);
            }
        });
        
        // Remove image
        removeImageBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            uploadedImageDiv.style.display = 'none';
            imageInput.value = '';
        });
    }
    
    function handleImageUpload(file, searchGroup) {
        const uploadedImageDiv = searchGroup.querySelector('.uploaded-image');
        const img = uploadedImageDiv.querySelector('img');
        
        const reader = new FileReader();
        reader.onload = function(e) {
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


        // 2. Kiểm tra và lấy giá trị từ bộ lọc OCR
        const ocrFilterContainer = searchGroup.querySelector('.ocr-filter-container');
        if (ocrFilterContainer && ocrFilterContainer.classList.contains('visible')) {
            const ocrInput = searchGroup.querySelector('.ocr-input');
            if (ocrInput && ocrInput.value.trim() !== '') {
                filterOptions.ocr = ocrInput.value.trim();
            }
        }

        // 3. Kiểm tra và lấy giá trị từ bộ lọc Tag
        const tagFilterContainer = searchGroup.querySelector('.tag-filter-container');
        if (tagFilterContainer && tagFilterContainer.classList.contains('visible')) {
            const tagInput = searchGroup.querySelector('.tag-input');
            if (tagInput && tagInput.value.trim() !== '') {
                const tags = tagInput.value.split(',').map(tag => tag.trim()).filter(tag => tag);

                if (tags.length > 0) {
                    filterOptions.use_tag = true;
                    filterOptions.tags_filter = tags;
                }
            }
            const asrFilterContainer = searchGroup.querySelector('.asr-filter-container');
            if (asrFilterContainer && asrFilterContainer.classList.contains('visible')) {
                if (asrInput && asrInput.value.trim() !== '') {
                    filterOptions.asr = asrInput.value.trim(); // Thêm tham số asr
                }
            }
        }

        try {
            const translationDisplay = searchGroup.querySelector('.translated-query-display');
            let finalQuery = query;

            if (isTranslationEnabled && type === 'text') {
                finalQuery = await translateText(query);
                if (translationDisplay) {
                    translationDisplay.innerHTML = `Searching for: "<strong>${finalQuery}</strong>"`;
                    translationDisplay.classList.add('visible');
                }
            } else if (translationDisplay) {
                translationDisplay.classList.remove('visible');
            }

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
                    searchPromise = callTextToTextAPI(finalQuery)
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
                // URL này chỉ để tạo mục lịch sử mới, không cần đẹp
                const newUrl = `/?search_timestamp=${Date.now()}`; 
                window.history.pushState(currentState, '', newUrl);
            }

        } catch (error) {
            handleSearchError(error);
        } finally {
            resetTagFiltering();
            resetOcrFiltering();
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
                (tagFilterBtn.classList.contains('active') && tagValue)||
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
    // Thêm hàm gọi API text-to-text mới
    function callTextToTextAPI(query) {
        return fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/search/text`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query: query,
                // top_k: 1000,
                search_in: "text" // Khác với text-to-image ở đây
            })
        })
        .then(res => res.ok ? res.json() : Promise.reject(res))
        .catch(err => {
            console.error("Text-to-text API call failed:", err);
            throw err;
        });
    }

    /**
     * Tái cấu trúc: Hàm lõi để thực hiện tìm kiếm bằng ảnh từ một đường dẫn.
     * Có thể được gọi từ cả kết quả tìm kiếm và submit queue.
     * @param {string} imagePath - Đường dẫn đầy đủ đến ảnh dùng để tìm kiếm.
     */
    async function performImageSearchFromPath(imagePath) {
        if (!imagePath) {
            console.error("Image path is required for semantic search.");
            return;
        }

        const searchStartTime = performance.now();
        
        // 1. Chuyển UI sang chế độ Image-to-Image và hiển thị loading
        switchSearchMode('image-to-image');
        showLoadingIndicator();

        try {
            // 2. Cập nhật UI ở sidebar để hiển thị ảnh đang được dùng để tìm kiếm
            const uploadArea = document.querySelector('.image-upload-area');
            if (uploadArea) {
                const imgElement = uploadArea.querySelector('.uploaded-image img');
                const uploadedImageDiv = uploadArea.querySelector('.uploaded-image');
                imgElement.src = imagePath;
                uploadedImageDiv.style.display = 'block';
            }

            // 3. Lấy dữ liệu của ảnh từ URL của nó
            const response = await fetch(imagePath);
            if (!response.ok) {
                throw new Error(`Failed to fetch image: ${response.statusText}`);
            }
            const imageBlob = await response.blob();
            
            // Tạo một đối tượng File từ Blob để gửi đi
            const imageFile = new File([imageBlob], "selected_frame.jpg", { type: imageBlob.type });

            // 4. Gọi API tìm kiếm bằng ảnh
            const results = await callImageToImageAPI(imageFile, currentSelectedModel);

            // 5. Xử lý kết quả
            handleSearchResults(results, false);

        } catch (error) {
            handleSearchError(error);
        }
    }
    function callTemporalSearchStart(query, modelName, filterOptions, searchGroup) {
        const queryId = searchGroup.dataset.searchId;
        const body = { 
            query: query, 
            user_id: currentUserId, 
            query_id: queryId 
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
        }

        if (filterOptions.asr) {
            body.asr = filterOptions.asr;
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
            chain_id: chainId, // chainId ở đây chính là currentUserId
            query_id: queryId 
        };

        if (filterOptions.use_event_filter) { // <<< THÊM KHỐI LỆNH NÀY
            body.use_event_filter = true;
        }

        // >>> LOGIC MỚI <<<
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
        // >>> KẾT THÚC LOGIC MỚI <<<

        return fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/search/temporal/continue`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })
        .then(res => res.ok ? res.json() : Promise.reject(res));
    }

    function callTextToImageAPI(query, modelName, filterOptions) {
        const body = {
            query: query,
            search_in: "image"
        };
        if (modelName !== 'all') {
            body.model_name = modelName;
        }

        // >>> LOGIC MỚI <<<
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
        // >>> KẾT THÚC LOGIC MỚI <<<

        return fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/search/text`, {
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
        if (modelName !== 'all') { // Chỉ gửi nếu không phải mặc định
            formData.append("model_name", modelName);
        }

        if (isEventFilterEnabled) { // <<< THÊM KHỐI LỆNH NÀY
            formData.append("use_event_filter", "true");
        }

        let isTagFilterEnabled = false;
        if (isTagFilterEnabled) {
            // Bật cờ use_tag để backend biết là ta có thể lọc tag
            formData.append("use_tag", "true");
            formData.append("top_k_tags", "5");
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
function handleSearchResults(images, isReranked = false) {
    // 1. Dọn dẹp trạng thái cũ
    if (window.currentInfiniteScrollObserver) {
        window.currentInfiniteScrollObserver.disconnect();
    }
    
    if (!images || images.length === 0) {
        contentArea.innerHTML = `<div class="content-placeholder"><h2>Không tìm thấy kết quả</h2><p>Vui lòng thử lại.</p></div>`;
        return;
    }

    allImages = images;
    frameSelectionManager.clearAllSelections();
    contentArea.innerHTML = '';
    isLoading = false;
    hasReachedEnd = false;

    // 2. Tạo và thêm phần tử "loading". Nó sẽ được quản lý bởi các hàm con.
    const loadingMore = document.createElement('div');
    loadingMore.className = 'loading-more';
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
        allGroupedData = groupResultsByVideo(allImages);
        displayedGroupsCount = 0;
        
        setupInfiniteScrollForGroups();
        loadMoreGroups();
    }
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
        // Đợi animation kết thúc rồi mới xóa khỏi DOM
        toast.addEventListener('transitionend', () => toast.remove());
    }, duration);
}
// ====== BẮT ĐẦU PHIÊN BẢN MỚI CỦA HÀM OPENIMAGEMODAL ======

async function openImageModal(clickedFrameData) {
    // --- BƯỚC 1: KIỂM TRA DỮ LIỆU ĐẦU VÀO ---
    if (!clickedFrameData || !clickedFrameData.videoName || typeof clickedFrameData.frame_id_ori === 'undefined') {
        showToastNotification("Lỗi: Dữ liệu frame không đầy đủ để mở modal.", "error");
        console.error("Dữ liệu không hợp lệ được truyền cho openImageModal:", clickedFrameData);
        return;
    }

    const modal = document.getElementById('imageModal');
    const mainPreview = document.getElementById('mainPreviewImage');
    const thumbnailStrip = document.getElementById('thumbnailStrip');
    const modalFrameInfo = document.getElementById('modalFrameInfo');

    let currentModalFrameData = null;
    let currentFrameNumber = -1;

    const videoId = clickedFrameData.videoName;
    const targetFrameIdOri = clickedFrameData.frame_id_ori;

    // --- BƯỚC 2: TẢI DỮ LIỆU CẦN THIẾT (METADATA & VIDEO INFO) ---
    let videoInfo = videoInfoCache[videoId];
    let videoMetadata = null;

    try {
        const [metadataResponse, videoInfoResponse] = await Promise.all([
            fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/metadata/${videoId}?t=${Date.now()}`),
            videoInfo ? Promise.resolve(null) : fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/video_info/${videoId}`)
        ]);

        if (metadataResponse.ok) {
            videoMetadata = await metadataResponse.json();
        } else {
            throw new Error(`Could not fetch metadata for video ${videoId}`);
        }

        if (videoInfoResponse) {
            if (videoInfoResponse.ok) {
                videoInfo = await videoInfoResponse.json();
                videoInfoCache[videoId] = videoInfo;
            } else {
                throw new Error("Server response not ok for video_info");
            }
        }
    } catch (error) {
        console.error("Không thể tải thông tin video hoặc metadata:", error);
        showToastNotification("Lỗi: Không thể tải các frame lân cận.", "error");
        return;
    }

    if (!videoInfo || !videoMetadata) {
        showToastNotification("Lỗi: Dữ liệu không đầy đủ để hiển thị.", "error");
        return;
    }

    const { frame_filenames } = videoInfo;
    const folderUrlPath = `/frames/${videoId}`;

    // --- BƯỚC 3: CHUẨN BỊ VÀ SẮP XẾP DỮ LIỆU FRAME ---
    const metadataForVideo = videoMetadata[videoId] || videoMetadata;
    console.log("metadata_video:", metadataForVideo);

    // Tạo mảng từ metadataForVideo (object -> array)
    const sortedFrames = Object.entries(metadataForVideo)
        .map(([frameKey, metadata]) => {
            // frameKey ví dụ: "frame_001"
            const filename = `${frameKey}.webp`;  // hoặc giữ nguyên nếu tên file khác
            const frameNum = parseInt(frameKey.split('_')[1], 10);

            return {
                ...metadata,
                filename,
                frameNum,
                frame_id_ori: metadata.id,
                timestamp: metadata['time-stamp'] || metadata.timestamp
            };
        })
        .filter(Boolean) // loại bỏ null/undefined nếu có
        .sort((a, b) => a.frame_id_ori - b.frame_id_ori); // sort theo id gốc

    // --- BƯỚC 4: TÌM FRAME MỤC TIÊU BẰNG ID GỐC ---
    const currentIndexInList = sortedFrames.findIndex(frame => frame.frame_id_ori === targetFrameIdOri);
    
    console.log("index list", sortedFrames);
    if (currentIndexInList === -1) {
        console.error("Frame được click không tìm thấy trong danh sách đã xử lý.", { targetFrameIdOri, videoId });
        showToastNotification("Lỗi: Không tìm thấy frame trong metadata.", "error");
        return;
    }

    const clickedFrameNumber = sortedFrames[currentIndexInList].frameNum;

    // --- BƯỚC 5: CÁC HÀM NỘI BỘ VÀ EVENT HANDLERS ---
    function updateMainPreview(frameNum) {
        if (frameNum === currentFrameNumber) return;
        
        const frameData = sortedFrames.find(frame => frame.frameNum === frameNum);
        if (!frameData) return;

        mainPreview.src = `${folderUrlPath}/${frameData.filename}`;
        currentFrameNumber = frameNum;

        currentModalFrameData = {
            path: mainPreview.src,
            videoName: videoId,
            timestamp: frameData.timestamp,
            frameIdentifier: `${videoId}_${frameData.id}`,
            frame_id_ori: frameData.id,
            id: frameData.frameNum,
            isFromVideo: false, // Mặc định
            // Thêm các trường khác nếu cần
        };
        modalFrameInfo.textContent = currentModalFrameData.frameIdentifier;

        const oldCurrent = thumbnailStrip.querySelector('.current-frame');
        if (oldCurrent) oldCurrent.classList.remove('current-frame');

        const newCurrent = thumbnailStrip.querySelector(`[data-frame-number='${frameNum}']`);
        if (newCurrent) {
            newCurrent.classList.add('current-frame');
            newCurrent.scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' });
        }
    }

    const wheelHandler = (e) => {
        e.preventDefault();
        const currentIndex = sortedFrames.findIndex(f => f.frameNum === currentFrameNumber);
        if (currentIndex === -1) return;
        
        let nextIndex = currentIndex + (e.deltaY > 0 ? 1 : -1);
        nextIndex = Math.max(0, Math.min(sortedFrames.length - 1, nextIndex));

        if (nextIndex !== currentIndex) {
            updateMainPreview(sortedFrames[nextIndex].frameNum);
        }
    };

    const keydownHandler = (e) => {
        const key = e.key.toLowerCase();
        
        if (key === 'escape') { closeModal(); return; }
        if (key === 'arrowright' || key === 'arrowleft') {
            wheelHandler({ preventDefault: () => {}, deltaY: key === 'arrowright' ? 1 : -1 });
            return;
        }
        
        if (!currentModalFrameData) return;
        e.preventDefault();

        if (key === 'd') {
            sendWebSocketMessage('add_frames', { frames: [currentModalFrameData] });
            showToastNotification('Frame added to queue!', 'success');
            closeModal(); 
        } 
        else if (key === 's') {
            closeModal(() => initiateImageTemporalSearch(currentModalFrameData.path));
        }
    };
    
    const clickThumbnailHandler = (e) => {
        if (e.target.tagName === 'IMG') {
            updateMainPreview(parseInt(e.target.dataset.frameNumber));
        }
    };

    function closeModal(onClosedCallback = null) {
        modal.removeEventListener('wheel', wheelHandler);
        document.removeEventListener('keydown', keydownHandler);
        thumbnailStrip.removeEventListener('click', clickThumbnailHandler);
        modal.style.display = 'none';
        mainPreview.src = ""; // Xóa ảnh để giải phóng bộ nhớ
        if (typeof onClosedCallback === 'function') {
            setTimeout(onClosedCallback, 50); 
        }
    }
    
    // --- BƯỚC 6: KHỞI TẠO VÀ HIỂN THỊ MODAL ---
    thumbnailStrip.innerHTML = '';
    
    const start = Math.max(0, currentIndexInList - 50);
    const end = Math.min(sortedFrames.length, currentIndexInList + 51);
    
    for (let i = start; i < end; i++) {
        const frameData = sortedFrames[i];
        const thumb = document.createElement('img');
        thumb.src = `${folderUrlPath}/${frameData.filename}`;
        thumb.dataset.frameNumber = frameData.frameNum;
        if (frameData.frameNum === clickedFrameNumber) {
            thumb.classList.add('active-frame'); // Frame ban đầu được click
        }
        thumbnailStrip.appendChild(thumb);
    }

    modal.addEventListener('wheel', wheelHandler, { passive: false });
    document.addEventListener('keydown', keydownHandler);
    thumbnailStrip.addEventListener('click', clickThumbnailHandler);
    modal.querySelector('.modal-overlay').onclick = () => closeModal();

    updateMainPreview(clickedFrameNumber); // Tải ảnh chính đầu tiên
    modal.style.display = 'flex';
    
    setTimeout(() => {
        const activeThumb = thumbnailStrip.querySelector('.active-frame');
        if (activeThumb) activeThumb.scrollIntoView({ behavior: 'auto', inline: 'center', block: 'nearest' });
    }, 50);
}


    function parseTimestamp(ts) {
        if (!ts || typeof ts !== 'string') return 0; // Xử lý nếu timestamp không hợp lệ
        const parts = ts.split(':');
        const minutes = parseInt(parts[0], 10);
        const seconds = parseFloat(parts[1]);
        return (minutes * 60) + seconds;
    }

function openVideoModal(videoName, timestamp) {
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
        if (e.key === 'Escape') { closeModal(); return; }
        if (e.key === 'Enter') { e.preventDefault(); captureFrameAndAddToQueue(); return; }

        const activeElement = document.activeElement;
        if (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA') return;
        
        const key = e.key.toLowerCase();

        switch (key) {
            case ' ': e.preventDefault(); togglePlayPause(); break;
            case 'm': e.preventDefault(); toggleMute(); break;
            case 'arrowright':
                e.preventDefault();
                if (e.repeat) { player.playbackRate = FAST_FORWARD_RATE; }
                break;
            case 'arrowleft':
                e.preventDefault();
                if (e.repeat && !rewindInterval) {
                    rewindInterval = setInterval(() => {
                        player.currentTime = Math.max(0, player.currentTime - 0.2);
                    }, 100);
                }
                break;
        }
    };

    const handleKeyUp = (e) => {
        switch (e.key) {
            case 'ArrowRight':
                e.preventDefault();
                if (!e.repeat && player.playbackRate === 1.0) {
                    player.currentTime += SKIP_TIME;
                }
                player.playbackRate = 1.0;
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (rewindInterval) {
                    clearInterval(rewindInterval);
                    rewindInterval = null;
                } else {
                    player.currentTime -= SKIP_TIME;
                }
                break;
        }
    };

    const captureFrameAndAddToQueue = async () => { /* Giữ nguyên hàm này */
        player.pause();
        try {
            const currentTime = player.currentTime;
            const fps = await getFpsForVideo(videoName);
            const frameNumber = Math.round(currentTime * fps);
            
            captureCanvas.width = player.videoWidth;
            captureCanvas.height = player.videoHeight;
            const context = captureCanvas.getContext('2d');
            context.drawImage(player, 0, 0, captureCanvas.width, captureCanvas.height);
            const imagePathDataUrl = captureCanvas.toDataURL('image/jpeg', 0.9);

            const minutes = Math.floor(currentTime / 60);
            const seconds = (currentTime % 60).toFixed(3);
            const newTimestamp = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(6, '0')}`;
            
            const newFrameData = {
                videoName, path: imagePathDataUrl, frame_id_ori: frameNumber, id: frameNumber,
                timestamp: newTimestamp, frameIdentifier: `${videoName}_${frameNumber}`,
                score: 0, temporal_score: 0, videoPath: `/videos/${videoName}.mp4`, fps, isFromVideo: true
            };

            sendWebSocketMessage('add_frames', { frames: [newFrameData] });
            showToastNotification(`Đã chụp và thêm frame ${newFrameData.frameIdentifier} vào queue!`, 'success');
            closeModal();
        } catch (error) {
            console.error("Lỗi khi chụp frame:", error);
            showToastNotification("Không thể chụp frame.", "error");
            player.play();
        }
    };
    
    // <<< BẮT ĐẦU THAY ĐỔI >>>
    // Cập nhật hàm closeModal để hủy instance HLS, tránh rò rỉ bộ nhớ
    const closeModal = () => {
        // Hủy HLS player instance nếu nó tồn tại
        if (hlsPlayerInstance) {
            hlsPlayerInstance.destroy();
            hlsPlayerInstance = null;
        }

        player.pause();
        document.removeEventListener('keydown', handleKeyDown);
        document.removeEventListener('keyup', handleKeyUp);
        if (rewindInterval) clearInterval(rewindInterval);
        
        // Dọn dẹp player để sẵn sàng cho lần mở tiếp theo
        player.removeAttribute('src');
        player.load();
        
        modal.style.display = 'none';
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
    
    seekSlider.addEventListener('input', () => player.currentTime = seekSlider.value);
    seekSlider.addEventListener('mousedown', () => isSeeking = true);
    seekSlider.addEventListener('mouseup', () => isSeeking = false);
    
    muteBtn.onclick = toggleMute;
    volumeSlider.addEventListener('input', handleVolumeChange);
    
    modal.querySelector('.modal-overlay').onclick = closeModal;
    closeBtn.onclick = closeModal;
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('keyup', handleKeyUp);

    const hlsSrc = `${APP_CONFIG.REMOTE_BASE_URL}/videos_hls/${videoName}/playlist.m3u8`;
    const targetTimeInSeconds = parseTimestamp(timestamp);

    if (hlsPlayerInstance) {
        hlsPlayerInstance.destroy();
    }
    if (player.canPlayType('application/vnd.apple.mpegurl')) {
        player.src = hlsSrc;
        player.addEventListener('canplay', () => {
             player.currentTime = targetTimeInSeconds;
             player.play().catch(e => console.error("Lỗi tự động phát video:", e));
        }, { once: true });
    } 
    else if (Hls.isSupported()) {
        hlsPlayerInstance = new Hls();
        hlsPlayerInstance.loadSource(hlsSrc);
        hlsPlayerInstance.attachMedia(player);
        hlsPlayerInstance.on(Hls.Events.MANIFEST_PARSED, function() {
            player.currentTime = targetTimeInSeconds;
            player.play().catch(e => console.error("Lỗi tự động phát video:", e));
        });

        // Xử lý lỗi
        hlsPlayerInstance.on(Hls.Events.ERROR, function(event, data) {
            if (data.fatal) {
                console.error('Lỗi HLS nghiêm trọng:', data.type, data.details);
                showToastNotification(`Lỗi khi tải video: ${data.details}`, "error");
            }
        });
    } else {
        showToastNotification("Trình duyệt của bạn không hỗ trợ HLS streaming.", "error");
        return; // Dừng lại nếu không thể phát video
    }

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

    function setupToolbarEvents() {
        // Lắng nghe sự kiện click trên toolbar
        const toolbar = document.getElementById('selectionToolbar');
        
        if (toolbar) {
            toolbar.addEventListener('click', function(e) {
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
        document.addEventListener('keydown', function(e) {



            // Phím F: Mở modal keyframe nếu chỉ có 1 frame được chọn
            if (e.key === 'f' || e.key === 'F') {
                // e.preventDefault(); // Di chuyển preventDefault ra ngoài để áp dụng cho cả 2 trường hợp
                
                if (currentlyHoveredPreviewFrameData) {
                    openImageModal(currentlyHoveredPreviewFrameData); // Truyền cả đối tượng
                    return;
                }
                
                if (frameSelectionManager.getSelectionCount() === 1) {
                    const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
                    openImageModal(selectedFrame.data); // Lấy đối tượng 'data' đầy đủ
                }
            }
            
            if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
                if (currentlyHoveredPreviewFrameData) {
                    e.preventDefault();
                    initiateImageTemporalSearch(currentlyHoveredPreviewFrameData.path);
                    // Tự động đóng thanh preview để tránh rối
                    keyframePreviewBar.classList.remove('visible');
                    header.classList.remove('header-expanded');
                    return;
                }
                const imageModal = document.getElementById('imageModal');
                const activeElement = document.activeElement;
                const isTyping = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';

                // Chỉ chạy khi không ở trong modal và không đang gõ chữ
                if (!isTyping && (!imageModal || imageModal.style.display !== 'flex')) {
                    e.preventDefault(); // Ngăn các hành vi mặc định
                    console.log("count: ", frameSelectionManager.getSelectionCount());
                    if (frameSelectionManager.getSelectionCount() === 1) {
                        const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
                        // Lấy path từ data object, đây là nơi chứa thông tin đầy đủ nhất
                        const imagePath = selectedFrame.data.path; 
                        if (imagePath) {
                            // GỌI HÀM ĐIỀU PHỐI MỚI
                            initiateImageTemporalSearch(imagePath); 
                        } else {
                            showToastNotification('Cannot start search: image path is missing.', 'error');
                        }
                    } else {
                        // showToastNotification('Please select exactly one frame to start a new temporal search.', 'error');
                    }
                }
            }
            if (e.key === 'd' || e.key ==='D') {
                if (currentlyHoveredPreviewFrameData) {
                    e.preventDefault();
                    sendWebSocketMessage('add_frames', { frames: [currentlyHoveredPreviewFrameData] });
                    showToastNotification(`Đã thêm ${currentlyHoveredPreviewFrameData.frameIdentifier} vào queue!`, 'success');
                    return;
                }
                const imageModal = document.getElementById('imageModal');
                if (imageModal && imageModal.style.display === 'flex') {
                    return; 
                }
                const selectedCount = frameSelectionManager.getSelectionCount();
                const activeElement = document.activeElement;
                const isTyping = activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA';

                if (selectedCount > 0 && !isTyping) {
                    e.preventDefault(); 
                    const selectedFramesData = frameSelectionManager.getAllSelectedFrames().map(f => f.data);
                    
                    // GỬI TIN NHẮN ĐẾN SERVER
                    sendWebSocketMessage('add_frames', { frames: selectedFramesData });
                    
                    // Xóa lựa chọn ở client
                    frameSelectionManager.clearAllSelections();
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
            
            if (e.key === 'Delete') {
                // Thực hiện hành động xóa nếu cần
                // frameSelectionManager.deleteSelectedFrames();
            }
        });
        document.addEventListener('click', function(e) {
            // Kiểm tra xem click có nằm ngoài frame và toolbar không
            const isClickOutside = !e.target.closest('.image-item') && 
                                !e.target.closest('.selection-toolbar');
            if (isClickOutside && !e.ctrlKey) {
                frameSelectionManager.clearAllSelections();
            }
        });
        window.addEventListener('resize', function() {
            // Cập nhật vị trí toolbar nếu cần
            adjustToolbarPosition();
        });
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

            // Tạo thẻ cha
            const frameElement = document.createElement('div');
            frameElement.className = `queue-frame-item ${hasVotesClass} ${isSelectedClass} ${isFromVideoClass}`;
            frameElement.dataset.frameId = frameData.frameIdentifier;
            frameElement.style.borderColor = userColor;

            // Tạo cấu trúc HTML bên trong
            frameElement.innerHTML = `
                <div class="queue-frame-image-container">
                    <img src="${frameData.path}" alt="Queued frame">
                    <div class="queue-frame-user">${frameData.added_by}</div>
                    ${frameData.vote_count > 0 ? `
                        <div class="queue-frame-vote">
                            <i class="fas fa-heart"></i> ${frameData.vote_count}
                        </div>
                    ` : ''}
                    <button 
                        class="remove-queue-item-btn" 
                        title="Remove from queue"
                    >×</button>
                </div>
                <div class="queue-frame-info-bar">
                    ${frameData.frameIdentifier}
                </div>
            `;
            submitQueueFramesContainer.appendChild(frameElement);
        });
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
                    const firstSearchGroup = document.querySelector('.search-input-group');
                    results = await callTextToImageAPI(firstQuery, state.selectedModel, firstSearchGroup);

                } else if (state.searchMode === 'image-to-image' && state.imageDataUrl) {
                    const response = await fetch(state.imageDataUrl);
                    const blob = await response.blob();
                    const file = new File([blob], "restored_image.jpg", { type: blob.type });
                    results = await callImageToImageAPI(file, state.selectedModel);
                    
                } else if (state.searchMode === 'text-to-text') {
                    const firstQuery = state.queries.length > 0 ? state.queries[0].value : '';
                    results = await callTextToTextAPI(firstQuery);

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
        searchInputsContainer.innerHTML = '';
        showLoadingIndicator();

        try {
            const imageBlock = createImageTemporalSearchBlock(imagePath);
            searchInputsContainer.appendChild(imageBlock);

            // BƯỚC 1: Dùng fetch để lấy dữ liệu ảnh từ URL (bất kể là local hay remote)
            const response = await fetch(imagePath);
            if (!response.ok) {
                throw new Error(`Failed to fetch image for search: ${response.statusText}`);
            }
            const blob = await response.blob();
            
            // BƯỚC 2: Tạo một đối tượng File từ Blob
            const imageFile = new File([blob], "temporal_start_image.jpg", { type: blob.type });

            // BƯỚC 3: Gửi đối tượng File này lên server remote
            const queryId = 'img-start-' + Date.now();
            const formData = new FormData();
            formData.append("file", imageFile);
            formData.append("user_id", currentUserId);
            formData.append("query_id", queryId);

            if (isEventFilterEnabled) { // <<< THÊM KHỐI LỆNH NÀY
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
            handleSearchResults(resultsData.initial_results, false);
            const nextInput = createNewSearchInput();
            setTimeout(() => {
                nextInput.focus();
                nextInput.scrollIntoView({ behavior: 'auto', block: 'center' });
            }, 100);

            if (!isRestoringState) {
                const currentState = buildStateObject();
                currentState.isImageTemporalStart = true;
                currentState.imageTemporalStartPath = imagePath;
                const newUrl = `/?search_timestamp=${Date.now()}`;
                window.history.pushState(currentState, '', newUrl);
            }

        } catch (error) {
            handleSearchError(error);
        }
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

    try {
        const response = await fetch('http://192.168.20.170:9090/correct', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ text: text }),
        });

        if (!response.ok) {
            console.error('Autocorrect API error:', response.statusText);
            return null;
        }

        const result = await response.json();
        return result.corrected_text; 
    } catch (error) {
        console.error('Failed to fetch autocorrect suggestion:', error);
        return null;
    }
}

async function getFpsForVideo(videoName) {
    let videoMetadata;

    // 1. Kiểm tra cache (giữ nguyên logic này vì nó hiệu quả)
    if (metadataCache.has(videoName)) {
        videoMetadata = metadataCache.get(videoName);
    } else {
        // 2. Fetch metadata nếu chưa có trong cache
        try {
            const response = await fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/metadata/${videoName}`);
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const fullMetadata = await response.json();
            
            videoMetadata = fullMetadata[videoName];
            
            if (!videoMetadata) {
                console.error(`Không tìm thấy metadata cho key '${videoName}' trong file JSON.`);
                return 25; // Trả về giá trị mặc định nếu không có dữ liệu
            }
            
            metadataCache.set(videoName, videoMetadata); // Cache lại để dùng sau
        } catch (error)
        {
            console.error(`Lỗi khi fetch hoặc parse metadata cho ${videoName}:`, error);
            return 25; // Trả về giá trị mặc định khi có lỗi
        }
    }

    // 3. Lấy FPS trực tiếp từ frame đầu tiên
    try {
        // Lấy key của đối tượng đầu tiên trong metadata
        const firstFrameKey = Object.keys(videoMetadata)[0];
        
        if (firstFrameKey && videoMetadata[firstFrameKey] && videoMetadata[firstFrameKey].fps) {
            return videoMetadata[firstFrameKey].fps;
        } else {
            console.warn(`Không tìm thấy FPS trong frame đầu tiên của video ${videoName}. Sử dụng giá trị mặc định 25`);
            return 25; // Fallback nếu frame đầu tiên không có thông tin fps
        }
    } catch (error) {
        console.error(`Lỗi khi xử lý metadata cho ${videoName}:`, error);
        return 25; // Fallback cho các lỗi khác (ví dụ metadata trống)
    }
}

async function showKeyframePreview(frameData) {
    // Bước 1: Kiểm tra dữ liệu đầu vào
    if (!frameData || !frameData.videoName || typeof frameData.frame_id_ori === 'undefined') {
        console.error("Dữ liệu frame không đủ để hiển thị preview.", frameData);
        return;
    }

    // Bước 2: Hiển thị giao diện và trạng thái loading
    header.classList.add('header-expanded');
    keyframePreviewBar.classList.add('visible');
    previewThumbnails.innerHTML = '';
    previewPlaceholder.textContent = 'Đang tải...';
    previewPlaceholder.style.display = 'block';

    try {
        // Bước 3: Gọi API để lấy frame được click và 20 frame tiếp theo
        const response = await fetch(`${APP_CONFIG.REMOTE_BASE_URL}/api/keyframes/neighbors/${frameData.videoName}/${frameData.frame_id_ori}?look_behind=0&look_ahead=20`);
        
        if (!response.ok) {
            throw new Error(`Lỗi API: ${response.statusText}`);
        }
        const neighbors = await response.json();

        if (neighbors.length === 0) {
            previewPlaceholder.textContent = 'Không tìm thấy frame lân cận.';
            return;
        }
        
        previewPlaceholder.style.display = 'none';
        const folderUrlPath = `/frames/${frameData.videoName}`;
        const imageLoadPromises = [];

        // Bước 4: Tạo các thumbnail, gắn dữ liệu và sự kiện
        neighbors.forEach(neighborData => {
            const thumb = document.createElement('img');
            
            // Gắn một đối tượng dữ liệu hoàn chỉnh vào mỗi thumbnail
            const fullFrameData = {
                ...neighborData,
                videoName: frameData.videoName,
                path: `${folderUrlPath}/${neighborData.filename}`,
                frameIdentifier: `${frameData.videoName}_${neighborData.frame_id_ori}`,
                timestamp: neighborData.timestamp // Backend đã chuẩn hóa tên này
            };
            thumb.frameData = fullFrameData;
            
            // Sự kiện để theo dõi frame mục tiêu cho phím tắt
            thumb.addEventListener('mouseenter', () => { currentlyHoveredPreviewFrameData = thumb.frameData; });
            thumb.addEventListener('mouseleave', () => { currentlyHoveredPreviewFrameData = null; });

            // Sự kiện chuột phải để mở video
            thumb.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const data = thumb.frameData;
                if (data && data.videoName && data.timestamp) {
                    openVideoModal(data.videoName, data.timestamp);
                } else {
                    showToastNotification("Lỗi: Không đủ dữ liệu để mở video.", "error");
                }
            });

            // Sự kiện click chuột trái cũng mở video
            thumb.addEventListener('click', () => {
                const data = thumb.frameData;
                if (data && data.videoName && data.timestamp) {
                    openVideoModal(data.videoName, data.timestamp);
                }
            });
            
            // Tạo promise để đợi ảnh tải xong
            const loadPromise = new Promise((resolve) => {
                thumb.onload = resolve;
                thumb.onerror = resolve; // Vẫn resolve để Promise.all không bị lỗi
            });
            imageLoadPromises.push(loadPromise);

            thumb.src = thumb.frameData.path;
            thumb.title = thumb.frameData.frameIdentifier;

            // Làm nổi bật frame được click (luôn là frame đầu tiên)
            if (neighborData.frame_id_ori === frameData.frame_id_ori) {
                 thumb.classList.add('highlighted');
            }

            previewThumbnails.appendChild(thumb);
        });

        // Bước 5: Đợi tất cả ảnh tải xong để tránh hiệu ứng "pop-in"
        await Promise.all(imageLoadPromises);
        
        // Bước 6: Hoàn tất - không cần cuộn nữa vì thanh preview sẽ tự bắt đầu từ đầu

    } catch (error) {
        console.error('Lỗi khi tải keyframe lân cận:', error);
        previewPlaceholder.textContent = 'Lỗi khi tải dữ liệu.';
    }
}

function groupResultsByVideo(images) {
    if (!images || images.length === 0) {
        return [];
    }

    // Bước 1: Nhóm các frame vào một object theo videoName
    const groups = images.reduce((acc, image) => {
        const videoName = image.videoName;
        const score = image.temporal_score || image.score || 0;

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
        group.frames.sort((a, b) => (b.temporal_score || b.score || 0) - (a.temporal_score || a.score || 0));
    });

    return sortedGroups;
}

function createImageItemElement(image) {
    const imageItem = document.createElement('div');
    imageItem.className = 'image-item';
    const uniqueFrameId = image.frameIdentifier;
    imageItem.setAttribute('data-frame-id', uniqueFrameId);
    imageItem.setAttribute('data-frame-identifier', image.frameIdentifier);


    let scoreHtml = '';
    // if (image.temporal_score > 0) {
    //     scoreHtml = `<div class="score-overlay temporal">T-Score: ${image.temporal_score.toFixed(4)}</div>`;
    // } 
    // else if (image.score > 0) {
    //     scoreHtml = `<div class="score-overlay">${image.score.toFixed(4)}</div>`;
    // }
    imageItem.innerHTML = `
        <img src="${image.path}" alt="${uniqueFrameId}" loading="lazy">
        ${scoreHtml}
        <div class="frame-info">${image.frameIdentifier}</div>
    `;

    imageItem.addEventListener('mousedown', function(event) {
        blurActiveInput();
        if (event.button === 2) { // Chuột phải
            event.preventDefault();
            openVideoModal(image.videoName, image.timestamp);
        } else if (event.button === 0) { // Chuột trái
            event.preventDefault();
            showKeyframePreview(image);
            if (event.ctrlKey) {
                frameSelectionManager.toggleSelection(uniqueFrameId, { id: image.id, path: image.path, element: imageItem, data: image });
            } else {
                frameSelectionManager.clearAllSelections();
                frameSelectionManager.selectFrame(uniqueFrameId, { id: image.id, path: image.path, element: imageItem, data: image });
            }
        } else if (event.button === 1) { // Chuột giữa
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
        handleSearchResults(allImages, false); // isReranked là false vì chỉ render lại
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
    // Ngắt kết nối observer cũ nếu có để tránh lỗi
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
    window.currentInfiniteScrollObserver = observer; // Lưu lại để có thể ngắt kết nối
}

});
