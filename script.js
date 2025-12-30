// Wait for page to load
document.addEventListener('DOMContentLoaded', function() {
    // DOM Elements
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
    const closeModalBtn = document.querySelector('.close-modal');
    
    // State
    let allVideos = [];
    let filteredVideos = [];
    let authUrl = '';
    
    // Initialize
    checkAuthStatus();
    loadVideos();
    setupEventListeners();
    
    // ==================== EVENT LISTENERS ====================
    function setupEventListeners() {
        // Button clicks
        connectBtn.addEventListener('click', showAuthModal);
        refreshBtn.addEventListener('click', loadVideos);
        logoutBtn.addEventListener('click', revokeAuth);
        emptyConnectBtn.addEventListener('click', showAuthModal);
        retryBtn.addEventListener('click', loadVideos);
        
        // Modal buttons
        startAuthBtn.addEventListener('click', startAuthFlow);
        cancelAuthBtn.addEventListener('click', hideAuthModal);
        closeModalBtn.addEventListener('click', hideAuthModal);
        
        // Close modal when clicking outside
        authModal.addEventListener('click', function(e) {
            if (e.target === authModal) {
                hideAuthModal();
            }
        });
        
        // Search and filter
        searchInput.addEventListener('input', filterVideos);
        sortSelect.addEventListener('change', sortVideos);
        
        // Listen for messages from auth callback
        window.addEventListener('message', function(event) {
            if (event.data === 'auth_success') {
                showMessage('✅ Google Drive connected successfully!', 'success');
                hideAuthModal();
                loadVideos();
                checkAuthStatus();
            }
        });
        
        // Listen for storage events (for auth updates)
        window.addEventListener('storage', function(e) {
            if (e.key === 'auth_update') {
                checkAuthStatus();
            }
        });
    }
    
    // ==================== AUTHENTICATION ====================
    async function checkAuthStatus() {
        try {
            const response = await fetch('/api/auth-status');
            const data = await response.json();
            
            const authStatusElement = document.getElementById('auth-status');
            
            if (data.authenticated) {
                authStatusElement.className = 'status-badge status-connected';
                authStatusElement.innerHTML = '<i class="fas fa-check-circle"></i> Connected to Google Drive';
                connectBtn.innerHTML = '<i class="fas fa-sync-alt"></i> Reconnect';
            } else {
                authStatusElement.className = 'status-badge status-disconnected';
                authStatusElement.innerHTML = '<i class="fas fa-times-circle"></i> Not Connected';
                connectBtn.innerHTML = '<i class="fab fa-google-drive"></i> Connect Google Drive';
                
                if (data.authUrl) {
                    authUrl = data.authUrl;
                }
            }
        } catch (error) {
            console.error('Auth check error:', error);
        }
    }
    
    function showAuthModal() {
        authModal.style.display = 'flex';
    }
    
    function hideAuthModal() {
        authModal.style.display = 'none';
    }
    
    async function startAuthFlow() {
        try {
            // First, get the auth URL if we don't have it
            if (!authUrl) {
                const response = await fetch('/api/videos');
                const data = await response.json();
                
                if (data.authUrl) {
                    authUrl = data.authUrl;
                } else if (data.needAuth) {
                    // Try to construct auth URL
                    const baseUrl = window.location.origin;
                    authUrl = `${baseUrl}/auth`;
                }
            }
            
            if (authUrl) {
                // Open auth in a new window
                const authWindow = window.open(
                    authUrl,
                    'google_auth',
                    'width=600,height=700,menubar=no,toolbar=no,location=yes,resizable=yes,scrollbars=yes,status=yes'
                );
                
                // Check if window was blocked
                if (!authWindow || authWindow.closed || typeof authWindow.closed === 'undefined') {
                    showMessage('⚠️ Popup blocked! Please allow popups for this site.', 'warning');
                    // Fallback: redirect in same window
                    window.location.href = authUrl;
                }
            } else {
                showMessage('❌ Could not get authentication URL', 'error');
            }
        } catch (error) {
            console.error('Auth flow error:', error);
            showMessage('❌ Authentication error: ' + error.message, 'error');
        }
    }
    
    async function revokeAuth() {
        if (confirm('Are you sure you want to logout? You will need to reconnect to view videos.')) {
            try {
                const response = await fetch('/api/revoke-auth');
                const data = await response.json();
                
                if (data.success) {
                    showMessage('✅ Logged out successfully', 'success');
                    allVideos = [];
                    filteredVideos = [];
                    displayVideos([]);
                    checkAuthStatus();
                } else {
                    showMessage('❌ Logout failed: ' + data.error, 'error');
                }
            } catch (error) {
                showMessage('❌ Logout error: ' + error.message, 'error');
            }
        }
    }
    
    // ==================== VIDEO MANAGEMENT ====================
    async function loadVideos() {
        try {
            showLoading();
            hideEmptyState();
            hideErrorState();
            
            const response = await fetch('/api/videos');
            const data = await response.json();
            
            if (data.error) {
                if (data.needAuth) {
                    authUrl = data.authUrl || '';
                    showEmptyState('Please connect Google Drive to view your videos.');
                    return;
                }
                
                throw new Error(data.error || 'Failed to load videos');
            }
            
            if (!data.videos || data.videos.length === 0) {
                showEmptyState('No videos found in your Google Drive. Upload some videos to get started!');
                return;
            }
            
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
        videosContainer.innerHTML = '';
        
        if (videos.length === 0) {
            showEmptyState('No videos match your search criteria.');
            return;
        }
        
        videos.forEach(video => {
            const videoCard = createVideoCard(video);
            videosContainer.appendChild(videoCard);
        });
    }
    
    function createVideoCard(video) {
        const card = document.createElement('div');
        card.className = 'video-card';
        card.dataset.id = video.id;
        
        const thumbnailColor = stringToColor(video.title);
        
        card.innerHTML = `
            <div class="video-thumbnail" style="background: linear-gradient(135deg, ${thumbnailColor} 0%, ${darkenColor(thumbnailColor, 20)} 100%);">
                <i class="fas fa-film"></i>
            </div>
            <div class="video-info">
                <div class="video-title" title="${escapeHtml(video.title)}">${escapeHtml(truncateText(video.title, 50))}</div>
                <div class="video-meta">
                    <span class="video-date">${video.created || 'Unknown date'}</span>
                    <span class="video-size">${video.size}</span>
                </div>
                <button class="watch-btn" data-id="${video.id}">
                    <i class="fas fa-play"></i> Watch Now
                </button>
            </div>
        `;
        
        // Add click event to watch button
        const watchBtn = card.querySelector('.watch-btn');
        watchBtn.addEventListener('click', function() {
            const videoId = this.getAttribute('data-id');
            window.location.href = `/player.html?id=${videoId}`;
        });
        
        // Make entire card clickable
        card.addEventListener('click', function(e) {
            if (!e.target.closest('.watch-btn')) {
                const videoId = this.dataset.id;
                window.location.href = `/player.html?id=${videoId}`;
            }
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
                    return new Date(b.created) - new Date(a.created);
                case 'oldest':
                    return new Date(a.created) - new Date(b.created);
                case 'name':
                    return a.title.localeCompare(b.title);
                case 'size':
                    // Extract numeric size for comparison
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
        loadingElement.style.display = 'flex';
        videosContainer.style.display = 'none';
    }
    
    function hideLoading() {
        loadingElement.style.display = 'none';
        videosContainer.style.display = 'grid';
    }
    
    function showEmptyState(message = '') {
        emptyState.style.display = 'flex';
        videosContainer.style.display = 'none';
        loadingElement.style.display = 'none';
        errorState.style.display = 'none';
        
        if (message) {
            const messageElement = emptyState.querySelector('p');
            if (messageElement) {
                messageElement.textContent = message;
            }
        }
    }
    
    function hideEmptyState() {
        emptyState.style.display = 'none';
    }
    
    function showErrorState(message = '') {
        errorState.style.display = 'flex';
        videosContainer.style.display = 'none';
        loadingElement.style.display = 'none';
        emptyState.style.display = 'none';
        
        if (message) {
            const messageElement = errorState.querySelector('#error-message');
            if (messageElement) {
                messageElement.textContent = message;
            }
        }
    }
    
    function hideErrorState() {
        errorState.style.display = 'none';
    }
    
    // ==================== HELPER FUNCTIONS ====================
    function stringToColor(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        
        // Generate pastel colors
        const hue = hash % 360;
        return `hsl(${hue}, 70%, 65%)`;
    }
    
    function darkenColor(color, percent) {
        // Simple color darkening for gradient
        return color.replace(/hsl\((\d+), (\d+)%, (\d+)%\)/, function(match, h, s, l) {
            const newLightness = Math.max(0, parseInt(l) - percent);
            return `hsl(${h}, ${s}%, ${newLightness}%)`;
        });
    }
    
    function truncateText(text, maxLength) {
        if (text.length <= maxLength) return text;
        return text.substring(0, maxLength - 3) + '...';
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
            case 'b': return value / (1024 * 1024);
            default: return value;
        }
    }
    
    function showMessage(message, type = 'info') {
        const toast = document.getElementById('message-toast');
        
        // Set message and style
        toast.textContent = message;
        toast.className = 'toast';
        
        // Add type-based styling
        switch (type) {
            case 'success':
                toast.style.background = '#27ae60';
                break;
            case 'warning':
                toast.style.background = '#f39c12';
                break;
            case 'error':
                toast.style.background = '#e74c3c';
                break;
            default:
                toast.style.background = '#2c3e50';
        }
        
        // Show toast
        toast.classList.add('show');
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
            toast.classList.remove('show');
        }, 5000);
    }
    
    // Initial setup
    window.addEventListener('offline', () => {
        showMessage('⚠️ You are offline. Some features may not work.', 'warning');
    });
    
    window.addEventListener('online', () => {
        showMessage('✅ Back online!', 'success');
    });
});
