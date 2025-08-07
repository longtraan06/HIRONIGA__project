document.addEventListener('DOMContentLoaded', function() {
    let searchIdCounter = 1;
    let temporalChainId = null;
    let currentSearchMode = 'text-to-image';
    let currentHeaderFocus = null;
    let isTranslationEnabled = false;
    let availableModels = [];
    let currentSelectedModel = 'all';
    let highlightedModelIndex = -1; // -1 nghĩa là chưa có mục nào được highlight
    let isTagFilterEnabled = false;
    let submitQueueFrames = new Map();
    let isOcrFilterEnabled = false;
    let lastClickedFrameId = null;
    const DRES_FPS = 25; // Tốc độ khung hình/giây của video để tính toán.
    const DEFAULT_DRES_SESSION_ID = 'tfGPKdKa2Qf2mfrsNK_oMFWYorZkz-0r'; // !!! THAY THẾ BẰNG SESSION ID THẬT CỦA BẠN

    let isRestoringState = false;

    let dresEvaluationId = null; // Biến để lưu evaluationId sau khi lấy được.
    let selectedQueueFrameIds = new Set(); // Dùng Set để quản lý các frame được chọn trong queue.

    let allImages = []; // Lưu trữ tất cả kết quả tìm kiếm
    let displayedImagesCount = 0; // Số lượng ảnh đã hiển thị

    let currentUser = null;
    let ws = null;
    let userColors = {}; // Lưu màu của tất cả user


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
    const shortcutsBtn = document.getElementById('shortcutsBtn');
    const shortcutsModal = document.getElementById('shortcutsModal');
    const closeShortcutsModalBtn = shortcutsModal.querySelector('.close-btn');
    const shortcutsOverlay = shortcutsModal.querySelector('.modal-overlay');

    const submitQueueContainer = document.getElementById('submitQueue');
    const submitQueueFramesContainer = document.getElementById('submitQueueFrames');
    const clearQueueBtn = document.getElementById('clearQueueBtn');
    const queueCountSpan = document.getElementById('queueCount');
    const ocrFilterBtn = document.getElementById('ocrFilterBtn');

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

    let preparedAnswerData = null; // Biến tạm để lưu dữ liệu Answer
    initializeEventListeners();

    // Initialize
    function initializeEventListeners() {
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
            const activeElement = document.activeElement;
            if (activeElement && activeElement.classList.contains('search-input')) {
                const targetSearchGroup = activeElement.closest('.search-input-group');
                if (targetSearchGroup) {
                    const ocrContainer = targetSearchGroup.querySelector('.ocr-filter-container');
                    const ocrInput = targetSearchGroup.querySelector('.ocr-input');

                    if (ocrContainer && ocrInput) {
                        isOcrFilterEnabled = true; // Bật cờ
                        this.classList.add('active');
                        ocrContainer.classList.add('visible');
                        setTimeout(() => ocrInput.focus(), 10);
                    }
                }
            } else {
                showToastNotification('Vui lòng click vào một thanh tìm kiếm trước khi bật OCR filter!')
                // alert("Vui lòng click vào một thanh tìm kiếm trước khi bật OCR filter!");
            }
        });

        tagFilterBtn.addEventListener('click', function() {
            const activeElement = document.activeElement;
            if (activeElement && activeElement.classList.contains('search-input')) {
                
                const targetSearchGroup = activeElement.closest('.search-input-group');

                if (targetSearchGroup) {
                    const tagContainer = targetSearchGroup.querySelector('.tag-filter-container');
                    const tagInput = targetSearchGroup.querySelector('.tag-input');

                    if (tagContainer && tagInput) {
                        isTagFilterEnabled = true;
                        this.classList.add('active');

                        tagContainer.classList.add('visible');
                        setTimeout(() => tagInput.focus(), 10);
                    }
                }
            } else {
                showToastNotification('Vui lòng click vào một thanh tìm kiếm trước khi bật chế độ lọc tag!')
                // alert("Vui lòng click vào một thanh tìm kiếm trước khi bật chế độ lọc tag!");
                console.warn("Nút Tag Filter được nhấn nhưng không có thanh tìm kiếm nào đang được focus.");
            }
        });

        submitQueueFramesContainer.addEventListener('contextmenu', e => {
            e.preventDefault(); // Luôn luôn ngăn menu mặc định
            const frameItem = e.target.closest('.queue-frame-item');
            if (!frameItem) return;

            const frameId = frameItem.dataset.frameId;
            const frameData = submitQueueFrames.get(frameId);

            if (frameData && frameData.videoName && frameData.timestamp) {
                openVideoModal(frameData.videoName, frameData.timestamp);
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

        document.addEventListener('keydown', function(e) {

            // Logic chuyển đổi chế độ tìm kiếm bằng phím Tab
            if (e.key === 'Tab') {
                const activeElement = document.activeElement;

                // Nếu không, chúng ta sẽ chuyển đổi chế độ
                e.preventDefault(); // Ngăn hành vi mặc định của Tab (di chuyển tiêu điểm)

                const searchModes = ['text-to-image', 'image-to-image'];
                
                // Tìm vị trí của chế độ hiện tại
                const currentIndex = searchModes.indexOf(currentSearchMode);
                
                // Xác định vị trí của chế độ tiếp theo, quay vòng lại nếu cần
                const nextIndex = (currentIndex + 1) % searchModes.length;
                
                const nextMode = searchModes[nextIndex];
                
                // Gọi hàm switchSearchMode đã có sẵn
                switchSearchMode(nextMode);
                
                // UX Bonus: Sau khi chuyển mode, tự động focus vào ô tìm kiếm chính
                setTimeout(() => {
                    const firstSearchInput = document.querySelector('.search-input');
                    if (firstSearchInput && firstSearchInput.style.display !== 'none') {
                        firstSearchInput.focus();
                    }
                }, 50); // Đợi một chút để DOM cập nhật
            }

            if (e.key === 'F3') {
                e.preventDefault();
                if (translateBtn) translateBtn.click();
            } 
            else if (e.key === 'F2') {
                e.preventDefault();
                if (tagFilterBtn) tagFilterBtn.click();
            }
            else if (e.key === 'F1') {
                e.preventDefault();
                if (ocrFilterBtn) ocrFilterBtn.click();
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

            if (e.key === 'Enter' && !isTyping && frameSelectionManager.getSelectionCount() > 0) {
    
                // Ngăn chặn các hành vi mặc định khác của phím Enter
                e.preventDefault();

                // Lấy thông tin các frame đã chọn
                const selectedFrames = frameSelectionManager.getAllSelectedFrames();
                
                // *** THAY ĐỔI QUAN TRỌNG: Chỉ lấy 'frameIdentifier' từ mỗi frame ***
                const allFrameIdentifiers = selectedFrames.map(frame => frame.data.frameIdentifier);

                let answerData;
                answerData = allFrameIdentifiers;

                // Mở modal mới và truyền dữ liệu đã được đơn giản hóa vào
                openFrameVqaModal(answerData);

                // Bỏ chọn tất cả các frame sau khi mở modal
                frameSelectionManager.clearAllSelections();
                return; // Dừng lại để không chạy các logic khác của phím Enter
            }

                const selectedCountInQueue = selectedQueueFrameIds.size;
                if (selectedCountInQueue > 0 && !isTyping) {
                    
                    // Lấy thông tin của frame được chọn CUỐI CÙNG để xử lý cho các phím S và F
                    // (Vì S và F chỉ có ý nghĩa với 1 frame duy nhất)
                    const lastSelectedId = Array.from(selectedQueueFrameIds).pop();
                    const frameData = submitQueueFrames.get(lastSelectedId);
                    
                    if (!frameData) return; // Dừng lại nếu không có dữ liệu

                    const key = e.key.toLowerCase();
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
                        
                        case 'f': // Xem keyframe lân cận
                            if (selectedCountInQueue === 1) {
                                if (frameData.id && frameData.path) {
                                    openImageModal(frameData.id, frameData.path, frameData);
                                } else {
                                    showToastNotification("Frame data is incomplete for this action.", "error");
                                }
                            } else {
                                showToastNotification("Please select only one frame to view keyframes.", "error");
                            }
                            break;

                        case 's': // Semantic search
                        if (selectedCountInQueue === 1) {
                            // *** BẮT ĐẦU THAY ĐỔI ***

                            // 1. Lấy thông tin cần thiết
                            if (!frameData.path) {
                                showToastNotification("Frame data is incomplete for this action.", "error");
                                break; // Dừng lại nếu không có đường dẫn ảnh
                            }
                            const imagePath = frameData.path;

                            // 2. Chuẩn bị giao diện người dùng
                            switchSearchMode('image-to-image');

                            const uploadArea = document.querySelector('.image-upload-area');
                            if (uploadArea) {
                                const imgElement = uploadArea.querySelector('.uploaded-image img');
                                const uploadedImageDiv = uploadArea.querySelector('.uploaded-image');
                                imgElement.src = imagePath;
                                uploadedImageDiv.style.display = 'block';
                            }

                            // 3. Lấy thanh tìm kiếm đầu tiên để truyền vào hàm
                            const firstSearchGroup = document.querySelector('.search-input-group');

                            // 4. Gọi hàm performSearch TRUNG TÂM
                            performSearch(imagePath, 'image', firstSearchGroup);
                            
                            // 5. Bỏ chọn frame trong queue sau khi bắt đầu tìm kiếm
                            clearQueueSelection(); 

                            // *** KẾT THÚC THAY ĐỔI ***
                        } else {
                            showToastNotification("Please select only one frame for semantic search.", "error");
                        }
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
                                allFrames[nextIndex].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                            }
                            break;
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

        const openVqaModal = () => {
            vqaModal.style.display = 'flex';
            setTimeout(() => {
                vqaModal.classList.add('visible');
                vqaIdInput.focus(); // Tự động focus vào ô ID
            }, 10);
        };
        const closeVqaModal = () => {
            vqaModal.classList.remove('visible');
            setTimeout(() => {
                vqaModal.style.display = 'none';
                vqaForm.reset(); // Xóa nội dung trong form
            }, 300);
        };
        async function submit_form(id, answer) {
            console.log("Submitting VQA Data:", { id, answer });
            try {
                if(Array.isArray(answer)){
                    const response = await fetch('/api/submit/frame', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ id, answer }),
                    });
                    const result = await response.json();

                    if (response.ok && result.success) {
                        showToastNotification(`Submitted successfully! Saved to ${result.path}`, 'success', 2000);
                    } else {
                        throw new Error(result.detail || 'Failed to submit.');
                    }
                } else {
                    const response = await fetch('/api/submit/vqa', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ id, answer }),
                    });
                    const result = await response.json();

                    if (response.ok && result.success) {
                        showToastNotification(`Submitted successfully! Saved to ${result.path}`, 'success', 2000);
                    } else {
                        throw new Error(result.detail || 'Failed to submit.');
                    }
                }
                // const result = await response.json();

                // if (response.ok && result.success) {
                //     showToastNotification(`Submitted successfully! Saved to ${result.path}`, 'success', 2000);
                // } else {
                //     throw new Error(result.detail || 'Failed to submit.');
                // }

            } catch (error) {
                console.error('Submission Error:', error);
                showToastNotification(`Error: ${error.message}`, 'error', 2000);
            }
        }

        // Lắng nghe sự kiện click nút trên header
        vqaSubmitBtn.addEventListener('click', openVqaModal);

        // Lắng nghe sự kiện đóng modal
        vqaCloseBtn.addEventListener('click', closeVqaModal);
        vqaOverlay.addEventListener('click', closeVqaModal);
        
        // Lắng nghe sự kiện submit của form (khi nhấn Enter hoặc click nút Submit)
        vqaForm.addEventListener('submit', function(e) {
            e.preventDefault(); // Ngăn trình duyệt tải lại trang
            const id = vqaIdInput.value.trim();
            const answer = vqaAnswerInput.value.trim();

            if (id && answer) {
                submit_form(id, answer);
                closeVqaModal(); // Đóng modal sau khi submit
            } else {
                showToastNotification('Please fill out both ID and Answer.', 'error');
            }
        });

        vqaIdInput.addEventListener('keydown', function(e) {
            // Nếu phím được nhấn là 'Enter'
            if (e.key === 'Enter') {
                // Ngăn hành vi mặc định của Enter (là submit form)
                e.preventDefault(); 
                // Chuyển focus xuống ô nhập Answer
                vqaAnswerInput.focus();
            }
        });
        // 2. Xử lý sự kiện nhấn Enter trên ô Answer
        vqaAnswerInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault(); 
                vqaForm.querySelector('.submit-form-btn').click();
            }
        });

        const openFrameVqaModal = (answerData) => {
            // Lưu dữ liệu answer vào biến tạm
            preparedAnswerData = answerData;
            // Hiển thị dữ liệu JSON một cách đẹp mắt trong thẻ <pre>
            frameVqaAnswerDisplay.textContent = JSON.stringify(answerData, null, 2);

            // Mở modal
            frameVqaModal.style.display = 'flex';
            setTimeout(() => {
                frameVqaModal.classList.add('visible');
                frameVqaIdInput.focus(); // Tự động focus vào ô ID
            }, 10);
        };

        const closeFrameVqaModal = () => {
            frameVqaModal.classList.remove('visible');
            setTimeout(() => {
                frameVqaModal.style.display = 'none';
                frameVqaForm.reset(); // Xóa nội dung
                preparedAnswerData = null; // Reset biến tạm
            }, 300);
        };

        // Đóng modal khi click nút X hoặc overlay
        frameVqaCloseBtn.addEventListener('click', closeFrameVqaModal);
        frameVqaOverlay.addEventListener('click', closeFrameVqaModal);

        // Xử lý submit form
        frameVqaForm.addEventListener('submit', function(e) {
            e.preventDefault(); // Ngăn submit mặc định
            const id = frameVqaIdInput.value.trim();

            // Kiểm tra xem ID đã được nhập và dữ liệu Answer đã sẵn sàng chưa
            if (id && preparedAnswerData) {
                // Tận dụng hàm submit_form đã có!
                submit_form(id, preparedAnswerData);
                closeFrameVqaModal();
            } else {
                showToastNotification('Please enter an ID.', 'error');
            }
        });

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
                // Bỏ chọn tất cả
                document.querySelectorAll('.queue-frame-item.selected').forEach(el => el.classList.remove('selected'));
                selectedQueueFrameIds.clear();
                // Chọn frame mới
                selectedQueueFrameIds.add(frameId);
                frameItem.classList.add('selected');
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
                    const timeMs = Math.round((parseInt(frame.frame_id_ori, 10) / DRES_FPS) * 1000);
                    console.log("frame id:", frame.frame_id_ori, "timeMs:", timeMs);
                    answers = [{ mediaItemName: frame.videoName, start: timeMs, end: timeMs }];
                } else {
                    // Trường hợp nhiều frame
                    const firstVideoName = framesToSubmit[0].videoName;
                    if (!framesToSubmit.every(f => f.videoName === firstVideoName)) {
                        throw new Error("Please select frames from the same video for KIS submission.");
                    }
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
                const timeMs = Math.round((parseInt(frame.frame_id_ori, 10) / DRES_FPS) * 1000);
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
        const wsUrl = `${wsProtocol}//${window.location.host}/ws/queue/${currentUser}`;

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
                renderUserLegend();
                break;
            case 'user_update':
                userColors = payload.users;
                renderUserLegend();
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
            const response = await fetch('/api/models');
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
    async function translateText(text, sourceLang = 'vi', targetLang = 'en', apiKey = 'AIzaSyCYrbDzXcdf0ENylmW9JZ2ulMGhLSn0XOw') {
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
        
        // Reset temporal chain khi chuyển mode
        if (temporalChainId) {
            temporalChainId = null;
            // Xóa các thanh tìm kiếm phụ nếu có
            document.querySelectorAll('.search-input-group:not(:first-child)').forEach(group => group.remove());
        }
        
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
                 <div class="tag-filter-container">
                    <input type="text" class="tag-input" placeholder="Enter tags">
                </div>  
                <div class="ocr-filter-container">
                    <input type="text" class="ocr-input" placeholder="Enter OCR">
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


        // Auto-resize textarea
        textInput.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.max(44, this.scrollHeight) + 'px';
            const translationDisplay = searchGroup.querySelector('.translated-query-display');
            if (translationDisplay) {
                translationDisplay.classList.remove('visible');
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

        // THÊM VÀO: Xử lý phím Escape trong ô tìm kiếm
        textInput.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.blur(); // Thoát khỏi ô tìm kiếm
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
    if ((type === 'text' && !query.trim()) || (type === 'image' && !query)) {
        return;
    }

    showLoadingIndicator();

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
                     searchPromise = callTemporalSearchStart(finalQuery, currentSelectedModel, searchGroup)
                        .then(response => {
                            temporalChainId = response.chain_id; // Cập nhật chain_id
                            handleSearchResults(response.initial_results, false);
                            manageNextSearchInput();
                        });
                } else if (temporalChainId) {
                    searchPromise = callTemporalSearchContinue(finalQuery, temporalChainId, searchGroup)
                        .then(response => {
                             handleSearchResults(response.query_A_reranked, true);
                             manageNextSearchInput();
                        });
                } else {
                    searchPromise = callTextToImageAPI(finalQuery, currentSelectedModel, searchGroup)
                        .then(results => {
                            handleSearchResults(results, false);
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

    // Tách logic text-to-image để dễ quản lý
    function handleTextToImageSearch(query, searchGroup) {
        // Kiểm tra xem đây là thanh tìm kiếm đầu tiên hay không
        const isFirstSearch = !searchGroup.previousElementSibling;
        
        if (isFirstSearch) {
            callTemporalSearchStart(query, currentSelectedModel, searchGroup).then(response => {
                temporalChainId = response.chain_id;
                handleSearchResults(response.initial_results, false);
                
                // Tạo thanh tìm kiếm mới ở đây
               manageNextSearchInput();
            }).catch(handleSearchError);
        } else if (temporalChainId) {
            callTemporalSearchContinue(query, temporalChainId, searchGroup).then(response => {
                handleSearchResults(response.query_A_reranked, true);
                
                // Tạo thanh tìm kiếm mới ở đây
                manageNextSearchInput();
            }).catch(handleSearchError);
        } else {
            callTextToImageAPI(query, currentSelectedModel, searchGroup).then(results => {
                handleSearchResults(results, false);
                
                // Tạo thanh tìm kiếm mới ở đây
                manageNextSearchInput();
            }).catch(handleSearchError);
        }
    }
    
    function createAndFocusNewSearchInput() {
        setTimeout(() => {
            createNewSearchInput();
            
            setTimeout(() => {
                // Focus vào thanh tìm kiếm mới nhất
                const newInput = document.querySelector('.search-input-group:last-child .search-input');
                if (newInput) {
                    // Thử nhiều cách để focus
                    newInput.focus();
                    // Đảm bảo element nhận focus thực sự
                    newInput.focus({preventScroll: false});
                    // Di chuyển con trỏ đến cuối text nếu có
                    if (newInput.value) {
                        newInput.selectionStart = newInput.selectionEnd = newInput.value.length;
                    }
                    console.log('Focus applied to new input');
                }
            }, 50);
        }, 200);
    }

    /**
     * Quản lý thanh tìm kiếm tiếp theo.
     * Kiểm tra xem có thanh tìm kiếm nào trống không.
     * Nếu có, focus vào nó. Nếu không, tạo một thanh mới.
     */
    function manageNextSearchInput() {
        // Tìm tất cả các textarea trong khu vực search
        const allSearchInputs = document.querySelectorAll('.search-inputs-container .search-input');
        let emptyInput = null;

        // Lặp qua để tìm cái đầu tiên bị trống
        for (const input of allSearchInputs) {
            if (input.value.trim() === '') {
                emptyInput = input;
                break; // Đã tìm thấy, dừng vòng lặp
            }
        }

        if (emptyInput) {
            // Nếu đã tồn tại một ô trống, chỉ cần focus vào nó
            console.log('Phát hiện thanh tìm kiếm trống, sẽ focus vào nó.');
            setTimeout(() => {
                emptyInput.focus();
                // Cuộn tới ô đó để người dùng nhìn thấy
                emptyInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 50); 
        } else {
            // Nếu không có ô nào trống, tạo một ô mới
            console.log('Không có thanh tìm kiếm trống, tạo thanh mới.');
            const newInput = createNewSearchInput(); // Hàm này giờ sẽ trả về input mới
            setTimeout(() => {
                newInput.focus();
            }, 50);
        }
    }


    // Thêm hàm gọi API text-to-text mới
    function callTextToTextAPI(query) {
        return fetch("/api/search/text", {
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


    /**
     * Hàm gốc được giữ lại để tương thích với các frame từ kết quả tìm kiếm.
     * Hàm này giờ chỉ đơn giản là gọi hàm tái cấu trúc ở trên.
     */
    function performSearchFromSelectedFrame() {
        if (frameSelectionManager.getSelectionCount() !== 1) {
            return;
        }
        
        const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
        // Gọi hàm helper mới với đường dẫn của ảnh
        performImageSearchFromPath(selectedFrame.path);
    }



    function callTemporalSearchStart(query, modelName, searchGroup) {
        const body = { query: query };
        if (modelName !== 'all') { // Chỉ gửi nếu không phải mặc định
            body.model_name = modelName;
        }

        if (isTagFilterEnabled){
            body.use_tag = true;
        }
        const tagInputElement = searchGroup.querySelector('.tag-input');

        if (tagInputElement && tagInputElement.value.trim() !== '') {
            body.use_tag = true; // Bật cờ này nếu có tag được nhập

            const tags = tagInputElement.value
                .split(',')
                .map(tag => tag.trim())
                .filter(tag => tag);

            if (tags.length > 0) {
                body.tags_filter = tags;
            }
        }

        const ocrInputElement = searchGroup.querySelector('.ocr-input');
        if (isOcrFilterEnabled && ocrInputElement && ocrInputElement.value.trim() !== '') {
            body.ocr = ocrInputElement.value.trim();
        }

        return fetch("/api/search/temporal/start", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })
        .then(res => res.ok ? res.json() : Promise.reject(res));
    }

    // Hàm này được gọi khi tìm kiếm query B, C...
    function callTemporalSearchContinue(query, chainId, searchGroup) {

        const body = { 
            query: query, 
            chain_id: chainId 
        };

        if (isTagFilterEnabled) {
            body.use_tag = true; 
        }

        const tagInputElement = searchGroup.querySelector('.tag-input');

            if (tagInputElement && tagInputElement.value.trim() !== '') {
                body.use_tag = true; // Bật cờ này nếu có tag được nhập

                const tags = tagInputElement.value
                    .split(',')
                    .map(tag => tag.trim())
                    .filter(tag => tag);

                if (tags.length > 0) {
                    body.tags_filter = tags;
                }
            }

        const ocrInputElement = searchGroup.querySelector('.ocr-input');
        if (isOcrFilterEnabled && ocrInputElement && ocrInputElement.value.trim() !== '') {
            body.ocr = ocrInputElement.value.trim();
        }

        return fetch("/api/search/temporal/continue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })
        .then(res => res.ok ? res.json() : Promise.reject(res));
    }

    function callTextToImageAPI(query, modelName, searchGroup) {
        const body = {
            query: query,
            search_in: "image"
        };
        if (modelName !== 'all') {
            body.model_name = modelName;
        }

        if (isTagFilterEnabled) {
            body.use_tag = true; 
        }

         const ocrInputElement = searchGroup.querySelector('.ocr-input');
        if (isOcrFilterEnabled && ocrInputElement && ocrInputElement.value.trim() !== '') {
            body.ocr = ocrInputElement.value.trim();
        }

        const tagInputElement = searchGroup.querySelector('.tag-input');

        if (tagInputElement && tagInputElement.value.trim() !== '') {
            body.use_tag = true; // Bật cờ này nếu có tag được nhập

            const tags = tagInputElement.value
                .split(',')
                .map(tag => tag.trim())
                .filter(tag => tag);

            if (tags.length > 0) {
                body.tags_filter = tags;
            }
        }

        return fetch("/api/search/text", {
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

        if (isTagFilterEnabled) {
            // Bật cờ use_tag để backend biết là ta có thể lọc tag
            formData.append("use_tag", "true");
            formData.append("top_k_tags", "5");
        }

        return fetch("/api/search/image", {
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
    if (!images || images.length === 0) {
        contentArea.innerHTML = `<div class="content-placeholder"><h2>Không tìm thấy kết quả</h2><p>Vui lòng thử lại.</p></div>`;
        return;
    }

    // Lưu lại tất cả ảnh và reset các biến
    allImages = images;
    displayedImagesCount = 0;
    hasReachedEnd = false;

    // Tạo tiêu đề nếu đây là kết quả reranked
    let headerHtml = '';
    if (isReranked) {
        headerHtml = `<h3 class="reranked-results-header">T Reranked</h3>`;
    }
    contentArea.innerHTML = headerHtml;

    // --- BẮT ĐẦU PHẦN THAY ĐỔI QUAN TRỌNG ---

    // 1. Tạo container chính cho layout masonry
    const masonryContainer = document.createElement('div');
    masonryContainer.className = 'masonry-container';
    masonryContainer.id = 'masonryContainer'; // Đặt ID để dễ truy xuất

    // 2. Tạo ra các cột (ví dụ: 6 cột)
    const numberOfColumns = 6;
    for (let i = 0; i < numberOfColumns; i++) {
        const column = document.createElement('div');
        column.className = 'masonry-column';
        masonryContainer.appendChild(column);
    }
    contentArea.appendChild(masonryContainer);

    // --- KẾT THÚC PHẦN THAY ĐỔI QUAN TRỌNG ---


    // Thêm indicator loading ở cuối
    const loadingMore = document.createElement('div');
    loadingMore.className = 'loading-more';
    loadingMore.id = 'loadingMore';
    loadingMore.innerHTML = '<div class="loading-spinner"></div><p>Đang tải thêm...</p>';
    loadingMore.style.display = 'none';
    contentArea.appendChild(loadingMore);

    // Xóa tất cả các frame đã chọn khi hiển thị kết quả mới
    frameSelectionManager.clearAllSelections();

    // Tải batch ảnh đầu tiên
    loadMoreImages();

    // Thiết lập Intersection Observer để detect khi scroll đến cuối
    setupInfiniteScroll();
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

    // --- BẮT ĐẦU PHẦN THAY ĐỔI QUAN TRỌNG ---
    
    // Lấy tất cả các cột từ DOM
    const columns = document.querySelectorAll('.masonry-column');
    if (columns.length === 0) {
        // Dừng lại nếu chưa có cột nào được tạo
        isLoading = false;
        if (loadingMore) loadingMore.style.display = 'none';
        return;
    }
    const numberOfColumns = columns.length;

    // --- KẾT THÚC PHẦN THAY ĐỔI QUAN TRỌNG ---

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

            // Tạo phần tử ảnh (logic này giữ nguyên)
            const imageItem = document.createElement('div');
            imageItem.className = 'image-item';
            const uniqueFrameId = image.frameIdentifier; // Sử dụng định danh duy nhất
            imageItem.setAttribute('data-frame-id', uniqueFrameId); // Gán định danh duy nhất
            imageItem.setAttribute('data-frame-identifier', image.frameIdentifier);
            const scoreInfo = image.temporal_score
                ? `T-Score: ${image.temporal_score.toFixed(4)}`
                : `${image.score ? image.score.toFixed(4) : 'N/A'}`;
            imageItem.innerHTML = `
                <img src="${image.path}" alt="${scoreInfo}" loading="lazy">
                <div class="frame-info">${image.frameIdentifier}</div>
            `;
            
            // Xử lý sự kiện chuột - giữ nguyên code của bạn
            imageItem.addEventListener('mousedown', function(event) {
                // Chuột phải: Mở video
                blurActiveInput(); 

                if (event.button === 2) {
                    event.preventDefault();
                    openVideoModal(image.videoName, image.timestamp);
                }
                // Chuột trái: Chọn frame
                else if (event.button === 0) {
                    event.preventDefault();
                    
                    // Nếu nhấn Ctrl, cho phép chọn nhiều frame
                    if (event.ctrlKey) {
                            frameSelectionManager.toggleSelection(uniqueFrameId, { // Sử dụng định danh mới ở đây
                            id: image.id,
                            path: image.path,
                            element: imageItem,
                            data: image
                        });
                    }
                    // Không nhấn Ctrl, chỉ chọn một frame
                    else {
                        frameSelectionManager.clearAllSelections();
                        frameSelectionManager.selectFrame(uniqueFrameId, { // Và ở đây
                            id: image.id,
                            path: image.path,
                            element: imageItem,
                            data: image
                        });
                    }
                }
                // Chuột giữa: Mở modal keyframe lân cận
                else if (event.button === 1) {
                    event.preventDefault();
                    openImageModal(image.id, image.path, image);
                }
            });
            
            // Ngăn menu ngữ cảnh mặc định
            imageItem.addEventListener('contextmenu', e => e.preventDefault());
            
             // --- BẮT ĐẦU PHẦN THAY ĐỔI QUAN TRỌNG ---
            
            // Logic "chia bài": Xác định xem ảnh này sẽ vào cột nào
            const columnIndex = i % numberOfColumns;
            columns[columnIndex].appendChild(imageItem); // Thêm ảnh vào cột tương ứng
            
            // --- KẾT THÚC PHẦN THAY ĐỔI QUAN TRỌNG ---
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

// Thay thế toàn bộ hàm openImageModal bằng hàm mới này

/**
 * Hiển thị một thông báo toast ở góc trên bên phải.
 * @param {string} message - Nội dung thông báo.
 * @param {string} type - 'success' hoặc 'error'.
 * @param {number} duration - Thời gian hiển thị (ms).
 */
function showToastNotification(message, type = 'success', duration = 1000) {
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

async function openImageModal(clickedFrameNumber, clickedPath, image) {
    const modal = document.getElementById('imageModal');
    const mainPreview = document.getElementById('mainPreviewImage');
    const thumbnailStrip = document.getElementById('thumbnailStrip');
    const modalFrameInfo = document.getElementById('modalFrameInfo');

    // <<< THÊM MỚI: Biến để lưu dữ liệu frame đang hiển thị trên modal
    let currentModalFrameData = null;

    const pathParts = clickedPath.split('/');
    const videoId = pathParts[2];
    
    let videoInfo = videoInfoCache[videoId];
    let videoMetadata = null;

    try {
        const [metadataResponse, videoInfoResponse] = await Promise.all([
            fetch(`/api/metadata/${videoId}`),
            videoInfo ? Promise.resolve(null) : fetch(`/api/video_info/${videoId}`)
        ]);

        if (metadataResponse.ok) {
            videoMetadata = await metadataResponse.json();
        } else { console.error(`Could not fetch metadata for video ${videoId}`); }

        if (videoInfoResponse) {
            if (videoInfoResponse.ok) {
                videoInfo = await videoInfoResponse.json();
                videoInfoCache[videoId] = videoInfo;
            } else { throw new Error("Server response not ok for video_info"); }
        }
    } catch (error) {
        console.error("Không thể tải thông tin video hoặc metadata:", error);
        alert("Lỗi: Không thể tải các frame lân cận.");
        return;
    }

    if (!videoInfo) {
        alert("Lỗi nghiêm trọng: Không có thông tin video để hiển thị.");
        return;
    }

    const { frame_filenames, folder_url_path } = videoInfo;
    const folderUrlPath = folder_url_path || `/frames/${videoId}`;
    let currentFrameNumber = clickedFrameNumber;

    thumbnailStrip.innerHTML = '';
    
    function updateMainPreview(frameNum) {
        const frameName = frame_filenames.find(name => parseInt(name.split('_')[1].split('.')[0]) === frameNum);
        if (!frameName) return;

        mainPreview.src = `${folderUrlPath}/${frameName}`;
        currentFrameNumber = frameNum;
        
        // <<< THAY ĐỔI: Cập nhật biến currentModalFrameData mỗi khi đổi ảnh
        const frameIdFromFilename = frameName.split('.')[0]; // ví dụ: "L03_V015_7070"
        if (videoMetadata && videoMetadata[videoId] && videoMetadata[videoId][frameIdFromFilename]) {
            const metadataForFrame = videoMetadata[videoId][frameIdFromFilename];
            currentModalFrameData = {
                 path: mainPreview.src,
                 videoName: videoId,
                 timestamp: metadataForFrame.timestamp,
                 frameIdentifier: `${videoId}_${metadataForFrame.id}`
            };
            modalFrameInfo.textContent = currentModalFrameData.frameIdentifier;
        } else {
             currentModalFrameData = null; // Reset nếu không tìm thấy metadata
             modalFrameInfo.textContent = "Metadata not found";
        }
        // === Kết thúc thay đổi ===

        const oldCurrent = thumbnailStrip.querySelector('.current-frame');
        if (oldCurrent) oldCurrent.classList.remove('current-frame');

        const newCurrent = thumbnailStrip.querySelector(`[data-frame-number='${frameNum}']`);
        if (newCurrent) {
            newCurrent.classList.add('current-frame');
            newCurrent.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
    }
    
    const currentIndexInList = frame_filenames.findIndex(name => parseInt(name.split('_')[1].split('.')[0]) === clickedFrameNumber);
    if (currentIndexInList === -1) return;

    const start = Math.max(0, currentIndexInList - 50);
    const end = Math.min(frame_filenames.length, currentIndexInList + 51);
    
    for (let i = start; i < end; i++) {
        const frameName = frame_filenames[i];
        const frameNumber = parseInt(frameName.split('_')[1].split('.')[0]);
        const thumb = document.createElement('img');
        thumb.src = `${folderUrlPath}/${frameName}`;
        thumb.dataset.frameNumber = frameNumber;
        if (frameNumber === clickedFrameNumber) {
            thumb.classList.add('active-frame', 'current-frame');
        }
        thumb.onclick = () => updateMainPreview(frameNumber);
        thumbnailStrip.appendChild(thumb);
    }
    
    const allVisibleThumbs = thumbnailStrip.querySelectorAll('img');
    const minVisibleFrame = parseInt(allVisibleThumbs[0].dataset.frameNumber);
    const maxVisibleFrame = parseInt(allVisibleThumbs[allVisibleThumbs.length - 1].dataset.frameNumber);

    const wheelHandler = (e) => {
        e.preventDefault();
        let newFrame = currentFrameNumber;
        if (e.deltaY > 0 && currentFrameNumber < maxVisibleFrame) newFrame++;
        else if (e.deltaY < 0 && currentFrameNumber > minVisibleFrame) newFrame--;
        if (newFrame !== currentFrameNumber) updateMainPreview(newFrame);
    };

    const keydownHandler = (e) => {
        
        if (e.key === 'Escape') { closeModal(); return; }
        let newFrame = currentFrameNumber;
        if (e.key === 'ArrowRight' && currentFrameNumber < maxVisibleFrame) newFrame++;
        else if (e.key === 'ArrowLeft' && currentFrameNumber > minVisibleFrame) newFrame--;
        else if (e.key.toLowerCase() === 'a') {
            e.preventDefault();
            // <<< THAY ĐỔI: Sử dụng biến đã được cập nhật
            if (currentModalFrameData) {
                sendWebSocketMessage('add_frames', { frames: [currentModalFrameData] });
                // Thay thế alert bằng toast notification
                showToastNotification('Frame added to queue!', 'success');
            } else {
                showToastNotification('Cannot add frame: metadata not found.', 'error');
            }
        }
        
        if (newFrame !== currentFrameNumber) updateMainPreview(newFrame);
    };

    function closeModal() {
        modal.style.display = 'none';
        modal.removeEventListener('wheel', wheelHandler);
        document.removeEventListener('keydown', keydownHandler);
    }
    
    modal.addEventListener('wheel', wheelHandler, { passive: false });
    document.addEventListener('keydown', keydownHandler);
    modal.querySelector('.modal-overlay').onclick = closeModal;

    updateMainPreview(clickedFrameNumber);
    modal.style.display = 'flex';
    
    setTimeout(() => {
        const activeThumb = thumbnailStrip.querySelector('.active-frame');
        if (activeThumb) activeThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
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

        if (!videoName || !timestamp) {
            alert("Thiếu thông tin video hoặc timestamp.");
            return;
        }

        // Xây dựng đường dẫn đến video. Giả định video có đuôi .mp4
        const videoSrc = `/videos/${videoName}.mp4`; 
        const startTime = parseTimestamp(timestamp);

        // Gán nguồn cho player
        player.src = videoSrc;
        
        // Hàm này sẽ được gọi khi metadata của video đã sẵn sàng
        const setVideoTimeAndPlay = () => {
            // Kiểm tra để đảm bảo startTime hợp lệ và nằm trong thời lượng video
            if (isFinite(startTime) && startTime < player.duration) {
                player.currentTime = startTime;
            }
            player.play();
        };

        // Lắng nghe sự kiện 'loadedmetadata' một lần duy nhất
        player.addEventListener('loadedmetadata', setVideoTimeAndPlay, { once: true });
        
        // Hàm đóng modal và dọn dẹp
        const closeModal = () => {
            player.pause();
            player.removeAttribute('src'); // Hiệu quả hơn để dừng tải
            player.load(); // Reset player
            player.removeEventListener('loadedmetadata', setVideoTimeAndPlay);
            modal.style.display = 'none';
            document.removeEventListener('keydown', escHandler);
        };
        
        // Hàm xử lý phím Escape
        const escHandler = (e) => {
            if (e.key === 'Escape') closeModal();
        };

        // Gán sự kiện đóng modal
        modal.querySelector('.modal-overlay').onclick = closeModal;
        closeBtn.onclick = closeModal;
        document.addEventListener('keydown', escHandler);

        // Hiển thị modal
        modal.style.display = 'flex';
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
                if (frameSelectionManager.getSelectionCount() === 1) {
                    const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
                    openImageModal(selectedFrame.id, selectedFrame.path, selectedFrame.data);
                }
            }
            
            if (e.key === 's' || e.key === 'S') {
                // Ngăn các hành vi mặc định (ví dụ: mở hộp thoại Save)
                // e.preventDefault();

                // if (frameSelectionManager.getSelectionCount() !== 1) {
                //     showToastNotification('Please select exactly one frame for semantic search.', 'error');
                //     return;
                // }

                const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
                const imagePath = selectedFrame.path; // Lấy đường dẫn ảnh của frame đã chọn

                if (!imagePath) {
                    showToastNotification('Cannot perform search: image path is missing.', 'error');
                    return;
                }

                // 1. Chuyển sang chế độ tìm kiếm bằng ảnh
                switchSearchMode('image-to-image');

                // 2. Cập nhật giao diện sidebar để hiển thị ảnh đang được dùng để tìm kiếm
                const uploadArea = document.querySelector('.image-upload-area');
                if (uploadArea) {
                    const imgElement = uploadArea.querySelector('.uploaded-image img');
                    const uploadedImageDiv = uploadArea.querySelector('.uploaded-image');
                    imgElement.src = imagePath;
                    uploadedImageDiv.style.display = 'block';
                }

                // 3. Lấy thanh tìm kiếm đầu tiên để truyền vào performSearch
                const firstSearchGroup = document.querySelector('.search-input-group');

                // 4. Gọi hàm performSearch TRUNG TÂM
                // `imagePath` chính là `query`
                // `type` là `image`
                performSearch(imagePath, 'image', firstSearchGroup);
            }
            if (e.key === 'd' || e.key ==='D') {
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
            
            // Phím Delete: Có thể thêm hành động xóa frame đã chọn nếu cần
            if (e.key === 'Delete') {
                // Thực hiện hành động xóa nếu cần
                // frameSelectionManager.deleteSelectedFrames();
            }
        });
        
        // Lắng nghe sự kiện click bên ngoài để hỗ trợ bỏ chọn
        document.addEventListener('click', function(e) {
            // Kiểm tra xem click có nằm ngoài frame và toolbar không
            const isClickOutside = !e.target.closest('.image-item') && 
                                !e.target.closest('.selection-toolbar');
            
            // Nếu click ngoài và không nhấn Ctrl (để không ảnh hưởng đến chọn nhiều)
            if (isClickOutside && !e.ctrlKey) {
                frameSelectionManager.clearAllSelections();
            }
        });
        
        // Lắng nghe sự kiện thay đổi kích thước cửa sổ để điều chỉnh vị trí toolbar
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

    // Hàm điều chỉnh vị trí toolbar
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

    /**
     * Vẽ lại toàn bộ giao diện của submit queue dựa trên dữ liệu từ server. (V2)
     * @param {Array} queueItems - Mảng các frame trong queue, đã được sắp xếp.
     */
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

            // Tạo thẻ cha
            const frameElement = document.createElement('div');
            frameElement.className = `queue-frame-item ${hasVotesClass} ${isSelectedClass}`;
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

    /**
     * Vẽ lại chú thích người dùng và màu sắc trên header của queue.
     */
    function renderUserLegend() {
        // Tìm vị trí để thêm chú thích, ví dụ: trong .queue-actions
        const actionsContainer = document.querySelector('.submit-queue-header .queue-actions');
        
        // Xóa chú thích cũ
        const oldLegend = document.getElementById('userLegend');
        if (oldLegend) oldLegend.remove();
        
        // Tạo chú thích mới
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
        // Thêm vào đầu của .queue-actions
        actionsContainer.prepend(legendContainer);
    }

    function buildStateObject() {
        const state = {
            description: 'AIC_LUNCH_SEARCH', // Dùng để nhận dạng
            searchMode: currentSearchMode,
            selectedModel: currentSelectedModel,
            temporalChainId: temporalChainId,
            queries: [],
            filters: {
                ocr: { enabled: false, value: '' },
                tag: { enabled: false, value: '' }
            },
            imageDataUrl: null
        };

        // Lấy tất cả các truy vấn văn bản và bộ lọc tương ứng
        const searchInputGroups = document.querySelectorAll('.search-input-group');
        searchInputGroups.forEach((group, index) => {
            const searchInput = group.querySelector('.search-input');
            const ocrInput = group.querySelector('.ocr-input');
            const tagInput = group.querySelector('.tag-input');
            
            state.queries.push({
                id: group.dataset.searchId,
                value: searchInput.value
            });
            
            // Chỉ cần lấy filter từ search bar đầu tiên, vì logic hiện tại là vậy
            if (index === 0) {
                state.filters.ocr.enabled = ocrFilterBtn.classList.contains('active');
                state.filters.ocr.value = ocrInput ? ocrInput.value : '';

                state.filters.tag.enabled = tagFilterBtn.classList.contains('active');
                state.filters.tag.value = tagInput ? tagInput.value : '';
            }
        });

        // Lấy dữ liệu ảnh nếu đang ở chế độ tìm kiếm bằng ảnh
        if (currentSearchMode === 'image-to-image') {
            const uploadedImage = document.querySelector('.uploaded-image img');
            const uploadedImageContainer = document.querySelector('.uploaded-image');
            if (uploadedImage && uploadedImageContainer.style.display !== 'none') {
                state.imageDataUrl = uploadedImage.src;
            }
        }
        
        return state;
    }
/**
 * Khôi phục lại giao diện và thực hiện lại tìm kiếm từ một đối tượng state.
 * @param {object} state - Đối tượng state đã được lưu trong history.
 */
async function restoreStateFromHistory(state) {
    if (!state || state.description !== 'AIC_LUNCH_SEARCH') return;

    // ----- 1. KHÔI PHỤC GIAO DIỆN -----
    
    // Xóa các thanh tìm kiếm hiện tại
    searchInputsContainer.innerHTML = ''; 
    
    // Khôi phục các giá trị toàn cục
    switchSearchMode(state.searchMode);
    selectModel(state.selectedModel);
    temporalChainId = state.temporalChainId;

    // Tạo lại các thanh tìm kiếm
    state.queries.forEach(queryInfo => {
        const newSearchInput = createNewSearchInput();
        newSearchInput.value = queryInfo.value;
        const group = newSearchInput.closest('.search-input-group');
        group.dataset.searchId = queryInfo.id;
    });

    // Khôi phục bộ lọc (áp dụng cho thanh đầu tiên)
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
    
    // Khôi phục ảnh preview
    if (state.searchMode === 'image-to-image' && state.imageDataUrl) {
        const uploadedImageDiv = firstGroup.querySelector('.uploaded-image');
        const img = uploadedImageDiv.querySelector('img');
        img.src = state.imageDataUrl;
        uploadedImageDiv.style.display = 'block';
    }

    // ----- 2. THỰC HIỆN LẠI TÌM KIẾM -----
    showLoadingIndicator();
    try {
        // Lấy thông tin từ state để gọi API trực tiếp
        const firstQuery = state.queries.length > 0 ? state.queries[0].value : '';
        const firstSearchGroup = document.querySelector('.search-input-group');

        // Logic này tương tự như performSearch nhưng nguồn là `state`
        if (state.searchMode === 'text-to-image') {
            const results = await callTextToImageAPI(firstQuery, state.selectedModel, firstSearchGroup);
            handleSearchResults(results, false);
        } else if (state.searchMode === 'image-to-image' && state.imageDataUrl) {
            // Chuyển data URL thành File để tìm kiếm
            const response = await fetch(state.imageDataUrl);
            const blob = await response.blob();
            const file = new File([blob], "restored_image.jpg", { type: blob.type });
            const results = await callImageToImageAPI(file, state.selectedModel);
            handleSearchResults(results, false);
        } else if (state.searchMode === 'text-to-text') {
             const results = await callTextToTextAPI(firstQuery);
             handleSearchResults(results, false);
        } else {
             // Nếu không có gì để tìm kiếm (trạng thái trống), hiển thị placeholder
             contentArea.innerHTML = '<div class="content-placeholder"><h2>RESULTS</h2></div>';
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

});
