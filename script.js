// ==================== MAIN APPLICATION ====================
document.addEventListener('DOMContentLoaded', function() {
    // DOM Elements
    const navbar = document.getElementById('navbar');
    const videosContainer = document.getElementById('videos-container');
    const loadingElement = document.getElementById('loading');
    const emptyState = document.getElementById('empty-state');
    const errorState = document.getElementById('error-state');
    const videoCountElement = document.getElementById('video-count');
    const searchInput = document.getElementById('search-input');
    const sortSelect = document.getElementById('sort-select');
    
    // Button Elements
    const connectBtn = document.getElementById('connect-btn');
    const refreshBtn = document.getElementById('refresh-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const emptyConnectBtn = document.getElementById('empty-connect-btn');
    const retryBtn = document.getElementById('retry-btn');
    
    // Modal Elements
    const authModal = document.getElementById('auth-modal');
    const startAuthBtn = document.getElementById('start-auth');
    const cancelAuthBtn = document.getElementById('cancel-auth');
    const closeModalBtn = document.querySelector('.modal-close');
    
    // Status Elements
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    
    // Toast Element
    const toast = document.getElementById('message-toast');
    
    // State
    let allVideos = [];
    let filteredVideos = [];
    let authUrl = '';
    
    // ==================== INITIALIZATION ====================
    function init() {
        setupEventListeners();
        checkAuthStatus();
        loadVideos();
    }
    
    // ==================== EVENT LISTENERS ====================
    function setupEventListeners() {
        // Navbar scroll effect
        window.addEventListener('scroll', handleScroll);
        
        // Button clicks
        if (connectBtn) connectBtn.addEventListener('click', showAuthModal);
        if (refreshBtn) refreshBtn.addEventListener('click', loadVideos);
        if (emptyConnectBtn) emptyConnectBtn.addEventListener('click', showAuthModal);
        if (retryBtn) retryBtn.addEventListener('click', loadVideos);
        
        // Modal buttons
        if (startAuthBtn) startAuthBtn.addEventListener('click', startAuthFlow);
        if (cancelAuthBtn) cancelAuthBtn.addEventListener('click', hideAuthModal);
        if (closeModalBtn) closeModalBtn.addEventListener('click', hideAuthModal);
        
        // Close modal when clicking outside
        if (authModal) {
            authModal.addEventListener('click', (e) => {
                if (e.target === authModal) {
                    hideAuthModal();
                }
            });
        }
        
        // Search and filter
        if (searchInput) searchInput.addEventListener('input', filterVideos);
        if (sortSelect) sortSelect.addEventListener('change', sortVideos);
        
        // Listen for messages from auth callback
        window.addEventListener('message', handleAuthMessage);
    }
    
    // ==================== NAVBAR SCROLL EFFECT ====================
    function handleScroll() {
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    }
    
    // ==================== AUTHENTICATION ====================
    async function checkAuthStatus() {
        try {
            const response = await fetch('/api/auth-status');
            const data = await response.json();
            
            if (data.authenticated) {
                updateAuthStatus(true);
            } else {
                updateAuthStatus(false);
                if (data.authUrl) {
                    authUrl = data.authUrl;
                }
            }
        } catch (error) {
            console.error('Auth check error:', error);
            updateAuthStatus(false);
        }
    }
    
    function updateAuthStatus(isConnected) {
        if (isConnected) {
            statusDot.classList.add('connected');
            statusText.textContent = 'Connected to Google Drive';
            if (connectBtn) connectBtn.innerHTML = '<i class="fab fa-google-drive"></i> Reconnect';
        } else {
            statusDot.classList.remove('connected');
            statusText.textContent = 'Not Connected';
            if (connectBtn) connectBtn.innerHTML = '<i class="fab fa-google-drive"></i> Connect Google Drive';
        }
    }
    
    function showAuthModal() {
        if (authModal) {
            authModal.style.display = 'flex';
        }
    }
    
    function hideAuthModal() {
        if (authModal) {
            authModal.style.display = 'none';
        }
    }
    
    async function startAuthFlow() {
        try {
            if (!authUrl) {
                const response = await fetch('/api/videos');
                const data = await response.json();
                
                if (data.authUrl) {
                    authUrl = data.authUrl;
                }
            }
            
            if (authUrl) {
                const authWindow = window.open(
                    authUrl,
                    'google_auth',
                    'width=600,height=700'
                );
                
                if (!authWindow) {
                    showMessage('⚠️ Please allow popups for this site.', 'warning');
                    window.location.href = authUrl;
                }
            } else {
                showMessage('❌ Could not get authentication URL', 'error');
            }
        } catch (error) {
            console.error('Auth flow error:', error);
            showMessage('❌ Authentication error', 'error');
        }
    }
    
    function handleAuthMessage(event) {
        if (event.data === 'auth_success') {
            showMessage('✅ Google Drive connected successfully!', 'success');
            hideAuthModal();
            loadVideos();
            checkAuthStatus();
        }
    }
    
    // ==================== VIDEO MANAGEMENT ====================
    async function loadVideos() {
        try {
            showLoading();
            hideStates();
            
            console.log('Loading videos from API...');
            const response = await fetch('/api/videos');
            const data = await response.json();
            
            console.log('API Response:', data);
            
            if (data.error) {
                if (data.needAuth) {
                    authUrl = data.authUrl || '';
                    showEmptyState('Please connect Google Drive to view your videos.');
                    return;
                }
                
                throw new Error(data.error || 'Failed to load videos');
            }
            
            if (!data.videos || data.videos.length === 0) {
                showEmptyState('No videos found in your Google Drive.');
                return;
            }
            
            console.log(`Received ${data.videos.length} videos`);
            
            // Debug: Log each video's ID
            data.videos.forEach((video, index) => {
                console.log(`Video ${index + 1}: ID="${video.id}", Title="${video.title}"`);
            });
            
            allVideos = data.videos;
            filteredVideos = [...allVideos];
            
            updateVideoCount();
            sortVideos();
            displayVideos(filteredVideos);
            
        } catch (error) {
            console.error('Error loading videos:', error);
            showErrorState('Failed to load videos: ' + error.message);
        } finally {
            hideLoading();
        }
    }
    
    function displayVideos(videos) {
        if (!videosContainer) return;
        
        videosContainer.innerHTML = '';
        
        if (videos.length === 0) {
            showEmptyState('No videos match your search.');
            return;
        }
        
        videos.forEach(video => {
            const videoCard = createVideoCard(video);
            videosContainer.appendChild(videoCard);
        });
    }
    
    function createVideoCard(video) {
        console.log(`Creating card for: "${video.title}" (ID: ${video.id})`);
        
        const card = document.createElement('div');
        card.className = 'video-card';
        card.dataset.id = video.id;
        
        const thumbnailColor = stringToColor(video.title);
        
        card.innerHTML = `
            <div class="video-thumbnail" style="background: linear-gradient(135deg, ${thumbnailColor} 0%, ${darkenColor(thumbnailColor, 20)} 100%);">
                <i class="fas fa-film"></i>
                <div class="play-btn">
                    <i class="fas fa-play"></i>
                </div>
            </div>
            <div class="video-overlay">
                <div class="video-title">${escapeHtml(truncateText(video.title, 40))}</div>
                <div class="video-meta">
                    <span>${video.created || 'Unknown date'}</span>
                    <span>${video.size}</span>
                </div>
            </div>
        `;
        
        // FIXED: Store video data on the element
        card.videoData = video;
        
        card.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            
            const videoId = this.videoData.id;
            const videoTitle = this.videoData.title;
            
            console.log('=== VIDEO CLICKED ===');
            console.log('Title:', videoTitle);
            console.log('ID:', videoId);
            console.log('Opening URL:', `/player.html?id=${videoId}`);
            
            // Add cache buster to prevent caching
            const cacheBuster = Date.now();
            window.location.href = `/player.html?id=${videoId}&_=${cacheBuster}`;
        });
        
        return card;
    }
    
    function filterVideos() {
        const searchTerm = searchInput.value.toLowerCase().trim();
        
        if (!searchTerm) {
            filteredVideos = [...allVideos];
        } else {
            filteredVideos = allVideos.filter(video => 
                video.title.toLowerCase().includes(searchTerm)
            );
        }
        
        updateVideoCount();
        sortVideos();
    }
    
    function sortVideos() {
        const sortBy = sortSelect.value;
        
        filteredVideos.sort((a, b) => {
            switch (sortBy) {
                case 'newest':
                    return new Date(b.modified || b.created) - new Date(a.modified || a.created);
                case 'oldest':
                    return new Date(a.modified || a.created) - new Date(b.modified || b.created);
                case 'name':
                    return a.title.localeCompare(b.title);
                case 'size':
                    const sizeA = extractSizeInMB(a.size);
                    const sizeB = extractSizeInMB(b.size);
                    return sizeB - sizeA;
                default:
                    return 0;
            }
        });
        
        displayVideos(filteredVideos);
    }
    
    function updateVideoCount() {
        if (!videoCountElement) return;
        
        const total = allVideos.length;
        const showing = filteredVideos.length;
        
        if (total === showing) {
            videoCountElement.textContent = `${total} video${total !== 1 ? 's' : ''}`;
        } else {
            videoCountElement.textContent = `${showing} of ${total} video${total !== 1 ? 's' : ''}`;
        }
    }
    
    // ==================== UI STATE MANAGEMENT ====================
    function showLoading() {
        if (loadingElement) loadingElement.style.display = 'block';
        if (videosContainer) videosContainer.style.display = 'none';
        hideStates();
    }
    
    function hideLoading() {
        if (loadingElement) loadingElement.style.display = 'none';
        if (videosContainer) videosContainer.style.display = 'flex';
    }
    
    function hideStates() {
        if (emptyState) emptyState.style.display = 'none';
        if (errorState) errorState.style.display = 'none';
    }
    
    function showEmptyState(message = '') {
        if (emptyState) {
            emptyState.style.display = 'block';
            if (videosContainer) videosContainer.style.display = 'none';
            if (loadingElement) loadingElement.style.display = 'none';
            if (errorState) errorState.style.display = 'none';
            
            if (message) {
                const messageElement = emptyState.querySelector('p');
                if (messageElement) {
                    messageElement.textContent = message;
                }
            }
        }
    }
    
    function showErrorState(message = '') {
        if (errorState) {
            errorState.style.display = 'block';
            if (videosContainer) videosContainer.style.display = 'none';
            if (loadingElement) loadingElement.style.display = 'none';
            if (emptyState) emptyState.style.display = 'none';
            
            if (message) {
                const messageElement = errorState.querySelector('#error-message');
                if (messageElement) {
                    messageElement.textContent = message;
                }
            }
        }
    }
    
    // ==================== HELPER FUNCTIONS ====================
    function stringToColor(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        const hue = hash % 360;
        return `hsl(${hue}, 70%, 45%)`;
    }
    
    function darkenColor(color, percent) {
        return color.replace(/hsl\((\d+), (\d+)%, (\d+)%\)/, (match, h, s, l) => {
            const newLightness = Math.max(0, parseInt(l) - percent);
            return `hsl(${h}, ${s}%, ${newLightness}%)`;
        });
    }
    
    function truncateText(text, maxLength) {
        return text.length <= maxLength ? text : text.substring(0, maxLength - 3) + '...';
    }
    
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    function extractSizeInMB(sizeString) {
        if (!sizeString || sizeString === 'Unknown') return 0;
        const match = sizeString.match(/([\d.]+)\s*(\w+)/i);
        if (!match) return 0;
        
        const value = parseFloat(match[1]);
        const unit = match[2].toLowerCase();
        
        switch (unit) {
            case 'gb': return value * 1024;
            case 'mb': return value;
            case 'kb': return value / 1024;
            default: return value;
        }
    }
    
    function showMessage(message, type = 'info') {
        if (!toast) return;
        
        const toastElement = document.getElementById('message-toast');
        if (!toastElement) return;
        
        toastElement.textContent = message;
        toastElement.className = 'toast-notification';
        
        switch (type) {
            case 'success':
                toastElement.style.background = '#27ae60';
                break;
            case 'warning':
                toastElement.style.background = '#f39c12';
                break;
            case 'error':
                toastElement.style.background = '#e50914';
                break;
            default:
                toastElement.style.background = '#2c3e50';
        }
        
        toastElement.classList.add('show');
        
        setTimeout(() => {
            toastElement.classList.remove('show');
        }, 5000);
    }
    
    // ==================== INITIALIZE APP ====================
    init();
});
