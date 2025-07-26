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


    let allImages = []; // Lưu trữ tất cả kết quả tìm kiếm
    let displayedImagesCount = 0; // Số lượng ảnh đã hiển thị
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
        
        textToTextBtn.addEventListener('click', function() {
            switchSearchMode('text-to-text');
        });
        
        imageToImageBtn.addEventListener('click', function() {
            switchSearchMode('image-to-image');
        });
        
        tagFilterBtn.addEventListener('click', function() {
            // Tìm thanh tìm kiếm cuối cùng (thanh mới nhất)
            const lastSearchGroup = document.querySelector('.search-input-group:last-child');
            if (!lastSearchGroup) return; // Dừng lại nếu không có thanh tìm kiếm nào

            const tagContainer = lastSearchGroup.querySelector('.tag-filter-container');
            const tagInput = lastSearchGroup.querySelector('.tag-input');

            if (tagContainer && tagInput) {
                // Luôn bật nút tagFilterBtn khi nhấn
                isTagFilterEnabled = true;
                this.classList.add('active');

                // Hiển thị ô nhập tag của thanh tìm kiếm cuối cùng
                tagContainer.classList.add('visible');

                // Focus vào ô đó
                setTimeout(() => tagInput.focus(), 10);
            }
        });

        document.addEventListener('keydown', function(e) {

        // Logic chuyển đổi chế độ tìm kiếm bằng phím Tab
        if (e.key === 'Tab') {
            const activeElement = document.activeElement;
            
            // Nếu đang focus vào một ô input/textarea, thì không làm gì cả
            // để giữ lại hành vi Tab mặc định (di chuyển tiêu điểm, thụt đầu dòng,...)
            // if (activeElement && (activeElement.tagName === 'TEXTAREA' || activeElement.tagName === 'INPUT')) {
            //     // Bạn có thể để trống ở đây để Tab hoạt động bình thường,
            //     // hoặc giữ lại logic tạo search bar mới nếu muốn.
            //     // Hiện tại, chúng ta sẽ để nó hoạt động bình thường.
            //     return; 
            // }

            // Nếu không, chúng ta sẽ chuyển đổi chế độ
            e.preventDefault(); // Ngăn hành vi mặc định của Tab (di chuyển tiêu điểm)

            const searchModes = ['text-to-image', 'text-to-text', 'image-to-image'];
            
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

            if (e.key === 'F1') {
                e.preventDefault();
                if (translateBtn) translateBtn.click();
            } 
            else if (e.key === 'F2') {
                e.preventDefault();
                if (tagFilterBtn) tagFilterBtn.click();
            }
            else if (e.key === 'F3') {
                e.preventDefault();
                if (settingsBtn) settingsBtn.click(); // hoặc toggleSettingsMenu();
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

        // Tự động kích hoạt chế độ text-to-image khi trang tải xong
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

            // Chỉ xử lý phím tắt khi không focus vào element có thể edit
            // hoặc khi đã đang focus vào một nút trên header
            if (!isEditableElement || headerButtons.includes(activeElement)) {
                // Phím mũi tên trái
                if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    
                    // Tìm nút hiện tại đang được focus
                    let currentIndex = -1;
                    if (currentHeaderFocus) {
                        currentIndex = headerButtons.indexOf(currentHeaderFocus);
                    } else if (activeElement && headerButtons.includes(activeElement)) {
                        currentIndex = headerButtons.indexOf(activeElement);
                    }
                    
                    // Di chuyển sang nút bên trái (hoặc nút cuối cùng nếu đang ở nút đầu tiên)
                    let newIndex = currentIndex - 1;
                    if (newIndex < 0) newIndex = headerButtons.length - 1;
                    
                    // Focus vào nút mới
                    if (headerButtons[newIndex]) {
                        headerButtons[newIndex].focus();
                        currentHeaderFocus = headerButtons[newIndex];
                        
                        // Thêm visual indicator
                        headerButtons.forEach(btn => {
                            btn.classList.remove('keyboard-focus');
                        });
                        headerButtons[newIndex].classList.add('keyboard-focus');
                    }
                }
                
                // Phím mũi tên phải
                else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    
                    // Tìm nút hiện tại đang được focus
                    let currentIndex = -1;
                    if (currentHeaderFocus) {
                        currentIndex = headerButtons.indexOf(currentHeaderFocus);
                    } else if (activeElement && headerButtons.includes(activeElement)) {
                        currentIndex = headerButtons.indexOf(activeElement);
                    }
                    
                    // Di chuyển sang nút bên phải (hoặc nút đầu tiên nếu đang ở nút cuối cùng)
                    let newIndex = currentIndex + 1;
                    if (newIndex >= headerButtons.length) newIndex = 0;
                    
                    // Focus vào nút mới
                    if (headerButtons[newIndex]) {
                        headerButtons[newIndex].focus();
                        currentHeaderFocus = headerButtons[newIndex];
                        
                        // Thêm visual indicator
                        headerButtons.forEach(btn => {
                            btn.classList.remove('keyboard-focus');
                        });
                        headerButtons[newIndex].classList.add('keyboard-focus');
                    }
                }
                
                // Phím Enter khi đang focus vào nút header
                else if (e.key === 'Enter' && currentHeaderFocus) {
                    e.preventDefault();
                    // Kích hoạt click event trên nút đang được focus
                    currentHeaderFocus.click();
                    
                    // Xóa focus và visual indicator sau khi click
                    setTimeout(() => {
                        // Focus vào ô tìm kiếm sau khi chọn mode
                        const searchInput = document.querySelector('.search-input');
                        if (searchInput && searchInput.style.display !== 'none') {
                            searchInput.focus();
                        }
                        
                        // Xóa visual indicator
                        headerButtons.forEach(btn => {
                            btn.classList.remove('keyboard-focus');
                        });
                        currentHeaderFocus = null;
                    }, 100);
                }
                
                // Phím Escape để xóa focus khỏi header buttons
                else if (e.key === 'Escape' && currentHeaderFocus) {
                    currentHeaderFocus.blur();
                    headerButtons.forEach(btn => {
                        btn.classList.remove('keyboard-focus');
                    });
                    currentHeaderFocus = null;
                    
                    // Focus vào ô tìm kiếm
                    const searchInput = document.querySelector('.search-input');
                    if (searchInput && searchInput.style.display !== 'none') {
                        searchInput.focus();
                    }
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

    async function translateText(text, sourceLang = "vi", targetLang = "en") {
        if (!text) return ' ';
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sourceLang}&tl=${targetLang}&dt=t&q=${encodeURIComponent(text)}`;
        try {
            const response = await fetch(url);
            const data = await response.json();
            printf("Translation response:", data);
            return data[0].map(item => item[0]).join('');
        } catch (error) {
            console.error('Translation error:', error);
            return text; // Trả về văn bản gốc nếu có lỗi
        }
    }



    function switchSearchMode(mode) {
        // Cập nhật UI của các nút
        textToImageBtn.classList.toggle('active', mode === 'text-to-image');
        textToTextBtn.classList.toggle('active', mode === 'text-to-text');
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
        
        // Focus on new input
        const newInput = newSearchGroup.querySelector('.search-input');
        if (currentSearchMode === 'text-to-image' || currentSearchMode === 'text-to-text') {
            newInput.focus();
        }
        
        // Update mode display
        updateSearchMode();
        
        // Trả về input mới
        return newInput;
    }
    
    function setupSearchInput(searchGroup) {
        const textInput = searchGroup.querySelector('.search-input');
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
        // resetTagFiltering();
        if ((type === 'text' && !query.trim()) || (type === 'image' && !query)) {
            return;
        }

        showLoadingIndicator();

        const translationDisplay = searchGroup.querySelector('.translated-query-display');

        let finalQuery = query;
        if (isTranslationEnabled && type === 'text') {
            // --- BẮT ĐẦU PHẦN CẬP NHẬT ---
            const startTime = performance.now(); // Ghi lại thời điểm bắt đầu

            try {
                finalQuery = await translateText(query);
                
                const endTime = performance.now(); // Ghi lại thời điểm kết thúc
                const duration = ((endTime - startTime) / 1000).toFixed(2); // Tính toán và làm tròn đến 2 chữ số thập phân

                if (translationDisplay) {
                    // Hiển thị cả kết quả dịch và thời gian dịch
                    translationDisplay.innerHTML = `Searching for: "<strong>${finalQuery}</strong>" <em>(Translated in ${duration}s)</em>`;
                    translationDisplay.classList.add('visible');
                }

            } catch (error) {
                console.error("Translation failed, using original query.", error);
                if (translationDisplay) {
                    translationDisplay.textContent = `Translation failed. Searching for original text.`;
                    translationDisplay.classList.add('visible');
                }
                finalQuery = query;
            }
            // --- KẾT THÚC PHẦN CẬP NHẬT ---
        } else {
            if (translationDisplay) {
                translationDisplay.classList.remove('visible');
            }
        }
        if (type === 'text') {
            if (currentSearchMode === 'text-to-image') {
                handleTextToImageSearch(finalQuery, searchGroup);
            } else if (currentSearchMode === 'text-to-text') {
                callTextToTextAPI(finalQuery)
                    .then(results => {
                        handleSearchResults(results, false);
                        createAndFocusNewSearchInput();
                    })
                    .catch(handleSearchError);
            }
        } else if (type === 'image' && currentSearchMode === 'image-to-image') {
            // Tìm kiếm bằng ảnh không thay đổi
            callImageToImageAPI(query, currentSelectedModel)
                .then(results => handleSearchResults(results, false))
                .catch(handleSearchError);
        }
        resetTagFiltering();
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
                createAndFocusNewSearchInput();
            }).catch(handleSearchError);
        } else if (temporalChainId) {
            callTemporalSearchContinue(query, temporalChainId, searchGroup).then(response => {
                handleSearchResults(response.query_A_reranked, true);
                
                // Tạo thanh tìm kiếm mới ở đây
                createAndFocusNewSearchInput();
            }).catch(handleSearchError);
        } else {
            callTextToImageAPI(query, currentSelectedModel, searchGroup).then(results => {
                handleSearchResults(results, false);
                
                // Tạo thanh tìm kiếm mới ở đây
                createAndFocusNewSearchInput();
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

    async function performSearchFromSelectedFrame() {
        // 1. Kiểm tra lại để chắc chắn chỉ có 1 frame được chọn
        if (frameSelectionManager.getSelectionCount() !== 1) {
            return;
        }
        
        const searchStartTime = performance.now();
        const selectedFrame = frameSelectionManager.getAllSelectedFrames()[0];
        
        // 2. Chuyển UI sang chế độ Image-to-Image và hiển thị loading
        switchSearchMode('image-to-image');
        showLoadingIndicator();

        try {
            // 3. Cập nhật UI ở sidebar để hiển thị ảnh đang được dùng để tìm kiếm
            const uploadArea = document.querySelector('.image-upload-area');
            if (uploadArea) {
                const imgElement = uploadArea.querySelector('.uploaded-image img');
                const uploadedImageDiv = uploadArea.querySelector('.uploaded-image');
                imgElement.src = selectedFrame.path;
                uploadedImageDiv.style.display = 'block';
            }

            // 4. Lấy dữ liệu của ảnh từ URL của nó
            // Đây là bước quan trọng: chúng ta fetch ảnh như một file
            const response = await fetch(selectedFrame.path);
            if (!response.ok) {
                throw new Error(`Failed to fetch image: ${response.statusText}`);
            }
            const imageBlob = await response.blob();
            
            // Tạo một đối tượng File từ Blob để gửi đi
            const imageFile = new File([imageBlob], "selected_frame.jpg", { type: imageBlob.type });

            // 5. Gọi API tìm kiếm bằng ảnh
            const results = await callImageToImageAPI(imageFile);

            // 6. Xử lý kết quả (tương tự như tìm kiếm thông thường)
            const getTimingInfo = () => {
                const searchEndTime = performance.now();
                const totalSearchDuration = ((searchEndTime - searchStartTime) / 1000).toFixed(2);
                return { total: totalSearchDuration, translate: null }; // Không có thời gian dịch
            };
            handleSearchResults(results, false, getTimingInfo());

        } catch (error) {
            handleSearchError(error);
        }
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
            const frameId = `frame-${image.id}`;
            imageItem.setAttribute('data-frame-id', frameId);
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
                if (event.button === 2) {
                    event.preventDefault();
                    openVideoModal(image.videoName, image.timestamp);
                }
                // Chuột trái: Chọn frame
                else if (event.button === 0) {
                    event.preventDefault();
                    
                    // Nếu nhấn Ctrl, cho phép chọn nhiều frame
                    if (event.ctrlKey) {
                        frameSelectionManager.toggleSelection(frameId, {
                            id: image.id,
                            path: image.path,
                            element: imageItem,
                            data: image
                        });
                    }
                    // Không nhấn Ctrl, chỉ chọn một frame
                    else {
                        // Xóa tất cả chọn hiện tại
                        frameSelectionManager.clearAllSelections();
                        // Chọn frame mới
                        frameSelectionManager.selectFrame(frameId, {
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

    async function openImageModal(clickedFrameNumber, clickedPath, image) {
        const modal = document.getElementById('imageModal');
        const mainPreview = document.getElementById('mainPreviewImage');
        const thumbnailStrip = document.getElementById('thumbnailStrip');
        const modalFrameInfo = document.getElementById('modalFrameInfo');

        // 1. Lấy videoId từ path (logic này không đổi)
        const pathParts = clickedPath.split('/');
        const videoId = pathParts[2];

        // SỬA LỖI: Di chuyển việc lấy videoInfo từ cache xuống đây
        let videoInfo = videoInfoCache[videoId];
        let videoMetadata = null;

        try {
            // TỐI ƯU HÓA: Thực hiện cả 2 lệnh gọi API song song
            const [metadataResponse, videoInfoResponse] = await Promise.all([
                fetch(`/api/metadata/${videoId}`),
                videoInfo ? Promise.resolve(null) : fetch(`/api/video_info/${videoId}`) // Chỉ fetch video_info nếu chưa có trong cache
            ]);

            // Xử lý kết quả metadata
            if (metadataResponse.ok) {
                videoMetadata = await metadataResponse.json();
            } else {
                console.error(`Could not fetch metadata for video ${videoId}`);
            }

            // Xử lý kết quả video_info (nếu có)
            if (videoInfoResponse) { // Nếu videoInfoResponse không phải là null
                if (videoInfoResponse.ok) {
                    videoInfo = await videoInfoResponse.json();
                    videoInfoCache[videoId] = videoInfo; // Lưu vào cache
                } else {
                    throw new Error("Server response not ok for video_info");
                }
            }
            
        } catch (error) {
            console.error("Không thể tải thông tin video hoặc metadata:", error);
            alert("Lỗi: Không thể tải các frame lân cận.");
            return;
        }
        
        // Nếu sau tất cả các bước mà videoInfo vẫn không có, thì thoát
        if (!videoInfo) {
            alert("Lỗi nghiêm trọng: Không có thông tin video để hiển thị.");
            return;
        }

        // Phần còn lại của hàm gần như không đổi...
        const { frame_filenames, folder_url_path } = videoInfo;
        const folderUrlPath = folder_url_path || `/frames/${videoId}`;
        let currentFrameNumber = clickedFrameNumber;

        thumbnailStrip.innerHTML = '';
        
        function updateMainPreview(frameNum) {
            const frameName = frame_filenames.find(name => parseInt(name.split('_')[1].split('.')[0]) === frameNum);
            if (!frameName) return;

            mainPreview.src = `${folderUrlPath}/${frameName}`;
            currentFrameNumber = frameNum;
            
            // Logic cập nhật frameIdentifier của bạn đã ĐÚNG và RẤT TỐT
            let finalFrameIdentifier = image.frameIdentifier;
            if (videoMetadata) {
                framenum_name = frameNum.toString().padStart(3, '0');
                const frameKey = `frame_${framenum_name}`;
                const videoData = videoMetadata[videoId];
                
                // console.log("frameKey", frameKey);
                // console.log("videoData", videoData);
                // console.log("videoData ID", videoData[frameKey].id);


                if (videoData && videoData[frameKey]) {
                    const newId = videoData[frameKey].id;
                    finalFrameIdentifier = `${videoId}_${newId}`;
                } else {
                
                    finalFrameIdentifier = `${videoId}_${frameNum}_loicuroicona`;
                }
            }
            modalFrameInfo.textContent = finalFrameIdentifier;

            const oldCurrent = thumbnailStrip.querySelector('.current-frame');
            if (oldCurrent) oldCurrent.classList.remove('current-frame');

            const newCurrent = thumbnailStrip.querySelector(`[data-frame-number='${frameNum}']`);
            if (newCurrent) {
                newCurrent.classList.add('current-frame');
                newCurrent.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            }
        }
        
        // Tạo thumbnail và các event listener (giữ nguyên)
        const currentIndexInList = frame_filenames.findIndex(name => parseInt(name.split('_')[1].split('.')[0]) === clickedFrameNumber);
        if (currentIndexInList === -1) return;

        const start = Math.max(0, currentIndexInList - 30);
        const end = Math.min(frame_filenames.length, currentIndexInList + 31);
        
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
                // Ngăn các hành vi mặc định của trình duyệt (ví dụ: mở hộp thoại Save)
                // e.preventDefault();
                
                // Gọi hàm xử lý logic tìm kiếm
                performSearchFromSelectedFrame();
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
                                id: id,
                                path: path,
                                element: item,
                                data: {frameIdentifier: frameIdentifier} // Thông tin bổ sung có thể được lưu trữ ở đây
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

});
