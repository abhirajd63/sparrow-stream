const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { google } = require('googleapis');
const basicAuth = require('express-basic-auth');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CONFIGURATION ====================
// Security: Basic Authentication
const users = {};
if (process.env.ADMIN_USER && process.env.ADMIN_PASSWORD) {
    users[process.env.ADMIN_USER] = process.env.ADMIN_PASSWORD;
} else {
    users['admin'] = 'sparrow123';
}

app.use(basicAuth({
    users: users,
    challenge: true,
    realm: 'Sparrow Stream',
    unauthorizedResponse: 'Access Denied'
}));

// ==================== CORS HEADERS (CRITICAL FOR VIDEO PLAYBACK) ====================
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, Range');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Middleware
app.use(express.static('.'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== GOOGLE DRIVE SETUP ====================
function getGoogleCredentials() {
    if (process.env.GOOGLE_CREDENTIALS) {
        try {
            return JSON.parse(process.env.GOOGLE_CREDENTIALS);
        } catch (err) {
            console.error('Error parsing GOOGLE_CREDENTIALS:', err.message);
            return null;
        }
    }
    
    try {
        const credentials = require('./credentials.json');
        return credentials;
    } catch (err) {
        console.error('No credentials found');
        return null;
    }
}

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function getOAuth2Client(redirectUri = null) {
    const credentials = getGoogleCredentials();
    if (!credentials || !credentials.web) {
        throw new Error('Google credentials not configured');
    }
    
    const { client_id, client_secret } = credentials.web;
    
    if (!redirectUri) {
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        redirectUri = `${baseUrl}/auth/callback`;
    }
    
    return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

// Token management with auto-refresh
async function getAuthenticatedClient() {
    const auth = getOAuth2Client();
    
    try {
        const tokenContent = await fs.readFile('./token.json', 'utf8');
        const token = JSON.parse(tokenContent);
        auth.setCredentials(token);
        
        // Check if token needs refresh (expires in less than 5 minutes)
        if (token.expiry_date && token.expiry_date < Date.now() + 300000) {
            console.log('Token expiring soon, attempting refresh...');
            try {
                const refreshed = await auth.refreshAccessToken();
                auth.setCredentials(refreshed.credentials);
                await fs.writeFile('./token.json', JSON.stringify(refreshed.credentials));
                console.log('Token refreshed successfully');
            } catch (refreshError) {
                console.log('Token refresh failed, will use existing token:', refreshError.message);
            }
        }
        
        return auth;
    } catch (err) {
        console.log('No valid token found');
        throw new Error('Not authenticated');
    }
}

// ==================== HELPER FUNCTIONS ====================
function formatFileSize(bytes) {
    if (bytes === 0 || !bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Cache for video data (5 minutes)
const videoCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000;

// ==================== ROUTES ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/player', (req, res) => {
    res.sendFile(path.join(__dirname, 'player.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'Sparrow Stream'
    });
});

// ==================== API ENDPOINTS ====================

// API: Get list of videos from Google Drive
app.get('/api/videos', async (req, res) => {
    console.log('GET /api/videos');
    
    try {
        const auth = await getAuthenticatedClient();
        const drive = google.drive({ version: 'v3', auth });
        
        console.log('Querying Google Drive for video files...');
        
        const response = await drive.files.list({
            q: "mimeType contains 'video/' and trashed = false",
            fields: 'files(id, name, size, mimeType, createdTime, modifiedTime, webViewLink, fileExtension, videoMediaMetadata)',
            orderBy: 'createdTime desc',
            pageSize: 100,
        });

        console.log(`Found ${response.data.files.length} video files`);
        
        // Debug: Log each file
        response.data.files.forEach((file, index) => {
            console.log(`Video ${index + 1}: "${file.name}" (ID: ${file.id})`);
        });

        const videos = response.data.files.map((file, index) => {
            const duration = file.videoMediaMetadata?.durationMillis 
                ? Math.round(file.videoMediaMetadata.durationMillis / 1000) + 's'
                : 'Unknown';
                
            return {
                id: file.id,
                title: file.name,
                size: file.size ? formatFileSize(file.size) : 'Unknown',
                type: file.mimeType,
                duration: duration,
                created: new Date(file.createdTime).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric'
                }),
                modified: file.modifiedTime,
                extension: file.fileExtension || file.name.split('.').pop() || 'Unknown',
                link: file.webViewLink
            };
        });

        res.json({ 
            success: true, 
            videos: videos,
            count: videos.length,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error fetching videos:', error.message);
        
        if (error.message.includes('Not authenticated') || 
            error.message.includes('invalid_grant') || 
            error.message.includes('token')) {
            
            await fs.unlink('./token.json').catch(() => {});
            const authUrl = generateAuthUrl();
            
            res.status(401).json({ 
                error: 'Authentication required', 
                needAuth: true,
                authUrl: authUrl,
                message: 'Please connect Google Drive'
            });
        } else {
            res.status(500).json({ 
                error: 'Failed to load videos', 
                message: error.message,
                needAuth: false
            });
        }
    }
});

// API: Get specific video details and stream URL
app.get('/api/video/:id', async (req, res) => {
    const videoId = req.params.id;
    console.log(`GET /api/video/${videoId}`);
    
    try {
        // Check cache first
        const cached = videoCache.get(videoId);
        if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
            console.log('Returning cached video data');
            return res.json(cached.data);
        }
        
        const auth = await getAuthenticatedClient();
        const drive = google.drive({ version: 'v3', auth });
        
        console.log('Fetching video details from Google Drive...');
        
        const file = await drive.files.get({
            fileId: videoId,
            fields: 'id, name, size, mimeType, webContentLink, webViewLink, createdTime, videoMediaMetadata'
        });

        // Get access token for streaming
        const accessToken = auth.credentials.access_token;
        
        if (!accessToken) {
            throw new Error('No valid access token');
        }

        // Create streaming URL with proper headers
        const streamUrl = `https://www.googleapis.com/drive/v3/files/${videoId}?alt=media`;
        const authStreamUrl = `${streamUrl}&access_token=${accessToken}`;
        
        // Also create a proxied URL for better compatibility
        const proxyStreamUrl = `/api/stream/${videoId}`;

        const duration = file.data.videoMediaMetadata?.durationMillis 
            ? Math.round(file.data.videoMediaMetadata.durationMillis / 1000) + ' seconds'
            : 'Unknown';

        const videoData = {
            success: true,
            id: file.data.id,
            title: file.data.name,
            size: file.data.size ? formatFileSize(file.data.size) : 'Unknown',
            type: file.data.mimeType,
            duration: duration,
            created: new Date(file.data.createdTime).toLocaleDateString(),
            streamUrl: authStreamUrl,
            proxyStreamUrl: proxyStreamUrl,
            downloadUrl: `https://drive.google.com/uc?export=download&id=${videoId}`,
            directLink: `https://drive.google.com/file/d/${videoId}/view`,
            webViewLink: file.data.webViewLink,
            mimeType: file.data.mimeType,
            supportsStreaming: true,
            timestamp: new Date().toISOString()
        };

        // Cache the response
        videoCache.set(videoId, {
            data: videoData,
            timestamp: Date.now()
        });

        console.log('Video data prepared:', {
            title: videoData.title,
            size: videoData.size,
            streamUrlLength: videoData.streamUrl?.length
        });

        res.json(videoData);
        
    } catch (error) {
        console.error('Error fetching video:', error.message);
        
        if (error.message.includes('Not authenticated') || 
            error.message.includes('invalid_grant') || 
            error.message.includes('token')) {
            
            await fs.unlink('./token.json').catch(() => {});
            
            res.status(401).json({ 
                success: false, 
                error: 'Authentication expired',
                needAuth: true,
                message: 'Please reconnect Google Drive'
            });
        } else if (error.message.includes('file not found')) {
            res.status(404).json({ 
                success: false, 
                error: 'Video not found',
                message: 'The requested video could not be found'
            });
        } else {
            res.status(500).json({ 
                success: false, 
                error: 'Failed to load video',
                message: error.message,
                details: process.env.NODE_ENV === 'development' ? error.stack : undefined
            });
        }
    }
});

// PROXY ENDPOINT: Stream video through server (fixes CORS issues)
app.get('/api/stream/:id', async (req, res) => {
    const videoId = req.params.id;
    console.log(`GET /api/stream/${videoId} - Video streaming proxy`);
    
    try {
        const auth = await getAuthenticatedClient();
        const accessToken = auth.credentials.access_token;
        
        if (!accessToken) {
            return res.status(401).send('No valid access token');
        }
        
        const streamUrl = `https://www.googleapis.com/drive/v3/files/${videoId}?alt=media`;
        
        // Set headers for streaming
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        
        // Forward range requests for seeking
        const range = req.headers.range;
        if (range) {
            console.log('Range request:', range);
            // We'll let Google Drive handle range requests directly
            const proxyUrl = `${streamUrl}&access_token=${accessToken}`;
            
            // Proxy the range request to Google Drive
            const proxyRes = await fetch(proxyUrl, {
                headers: { 'Range': range }
            });
            
            res.setHeader('Content-Range', proxyRes.headers.get('content-range') || '');
            res.setHeader('Content-Length', proxyRes.headers.get('content-length') || '');
            res.status(206);
            
            proxyRes.body.pipe(res);
        } else {
            // Regular request - redirect to authenticated URL
            const authUrl = `${streamUrl}&access_token=${accessToken}`;
            console.log('Redirecting to authenticated stream URL');
            res.redirect(authUrl);
        }
        
    } catch (error) {
        console.error('Stream proxy error:', error.message);
        res.status(500).send('Streaming error: ' + error.message);
    }
});

// Generate authentication URL
function generateAuthUrl() {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const redirectUri = `${baseUrl}/auth/callback`;
    
    const auth = getOAuth2Client(redirectUri);
    return auth.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent',
        include_granted_scopes: true
    });
}

// API: Get authentication status
app.get('/api/auth-status', async (req, res) => {
    try {
        const tokenExists = await fs.access('./token.json').then(() => true).catch(() => false);
        
        if (tokenExists) {
            try {
                const tokenContent = await fs.readFile('./token.json', 'utf8');
                const token = JSON.parse(tokenContent);
                
                // Check if token is expired or will expire soon
                if (token.expiry_date && token.expiry_date < Date.now() + 60000) { // 1 minute buffer
                    console.log('Token expired or expiring soon');
                    await fs.unlink('./token.json').catch(() => {});
                    return res.json({ 
                        authenticated: false, 
                        needAuth: true,
                        authUrl: generateAuthUrl()
                    });
                }
                
                // Test token validity by making a simple API call
                const auth = getOAuth2Client();
                auth.setCredentials(token);
                await auth.getAccessToken(); // This will throw if token is invalid
                
                return res.json({ 
                    authenticated: true,
                    expiresIn: token.expiry_date ? Math.max(0, token.expiry_date - Date.now()) : null
                });
                
            } catch (tokenError) {
                console.log('Token validation failed:', tokenError.message);
                await fs.unlink('./token.json').catch(() => {});
                return res.json({ 
                    authenticated: false, 
                    needAuth: true,
                    authUrl: generateAuthUrl()
                });
            }
        } else {
            res.json({ 
                authenticated: false, 
                needAuth: true,
                authUrl: generateAuthUrl()
            });
        }
    } catch (error) {
        console.error('Error checking auth status:', error);
        res.json({ 
            authenticated: false, 
            needAuth: true,
            error: error.message,
            authUrl: generateAuthUrl()
        });
    }
});

// API: Revoke authentication (logout)
app.get('/api/revoke-auth', async (req, res) => {
    try {
        // Try to revoke token with Google
        try {
            const tokenContent = await fs.readFile('./token.json', 'utf8');
            const token = JSON.parse(tokenContent);
            const auth = getOAuth2Client();
            auth.setCredentials(token);
            await auth.revokeCredentials();
            console.log('Google token revoked');
        } catch (revokeError) {
            console.log('Could not revoke Google token:', revokeError.message);
        }
        
        // Delete token file
        await fs.unlink('./token.json').catch(() => {});
        
        // Clear cache
        videoCache.clear();
        
        res.json({ 
            success: true, 
            message: 'Logged out successfully',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('Error revoking auth:', error);
        res.json({ 
            success: false, 
            error: error.message
        });
    }
});

// ==================== OAUTH CALLBACK ====================
app.get('/auth/callback', async (req, res) => {
    console.log('OAuth callback received');
    
    try {
        const code = req.query.code;
        if (!code) {
            console.error('No authorization code provided');
            return res.status(400).send(`
                <html>
                <body style="font-family: Arial; padding: 40px; text-align: center; background: #141414; color: white;">
                    <div style="background: #181818; padding: 40px; border-radius: 8px; max-width: 500px; margin: 0 auto;">
                        <h2 style="color: #e50914;">❌ Authorization Failed</h2>
                        <p>No authorization code received from Google.</p>
                        <p><a href="/" style="color: #e50914; text-decoration: none;">← Return to Sparrow Stream</a></p>
                    </div>
                </body>
                </html>
            `);
        }
        
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const redirectUri = `${baseUrl}/auth/callback`;
        
        console.log('Exchanging code for tokens with redirect URI:', redirectUri);
        
        const auth = getOAuth2Client(redirectUri);
        
        const { tokens } = await auth.getToken(code);
        console.log('Tokens received, saving...');
        
        // Ensure we have refresh token
        if (!tokens.refresh_token) {
            console.log('No refresh token in response, checking existing token...');
            try {
                const existingToken = await fs.readFile('./token.json', 'utf8');
                const existing = JSON.parse(existingToken);
                if (existing.refresh_token) {
                    tokens.refresh_token = existing.refresh_token;
                    console.log('Using existing refresh token');
                }
            } catch (e) {
                console.log('No existing token found');
            }
        }
        
        await fs.writeFile('./token.json', JSON.stringify(tokens));
        
        console.log('✅ Token saved successfully');
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Authorization Successful</title>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                        background: #141414;
                        color: white;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                        padding: 20px;
                    }
                    .container {
                        background: #181818;
                        padding: 40px;
                        border-radius: 8px;
                        text-align: center;
                        max-width: 500px;
                        width: 100%;
                        border: 1px solid #333;
                        box-shadow: 0 10px 30px rgba(0,0,0,0.5);
                    }
                    .success-icon {
                        color: #46d369;
                        font-size: 48px;
                        margin-bottom: 20px;
                    }
                    h2 {
                        margin-bottom: 15px;
                        color: #fff;
                    }
                    p {
                        color: #b3b3b3;
                        margin-bottom: 25px;
                        line-height: 1.5;
                    }
                    .close-btn {
                        display: inline-block;
                        background: #e50914;
                        color: white;
                        padding: 12px 24px;
                        border-radius: 4px;
                        text-decoration: none;
                        font-weight: 600;
                        border: none;
                        cursor: pointer;
                        transition: background 0.3s;
                    }
                    .close-btn:hover {
                        background: #f40612;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="success-icon">✓</div>
                    <h2>✅ Google Drive Connected Successfully!</h2>
                    <p>You can now close this window and return to Sparrow Stream.</p>
                    <p>Your video library will be available in a moment.</p>
                    
                    <button class="close-btn" onclick="closeWindow()">Close Window</button>
                    
                    <script>
                        // Send message to opener
                        if (window.opener) {
                            window.opener.postMessage('auth_success', '*');
                            console.log('Auth success message sent to opener');
                        } else {
                            console.log('No window opener found');
                        }
                        
                        function closeWindow() {
                            try {
                                window.close();
                            } catch (e) {
                                console.log('Could not close window:', e.message);
                                // Redirect to main site
                                window.location.href = '/';
                            }
                        }
                        
                        // Auto-close after 3 seconds
                        setTimeout(closeWindow, 3000);
                    </script>
                </div>
            </body>
            </html>
        `);
        
    } catch (error) {
        console.error('OAuth Callback Error:', error);
        
        res.status(500).send(`
            <html>
            <head>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        background: #141414;
                        color: white;
                        padding: 40px;
                        text-align: center;
                    }
                    .error-container {
                        background: #181818;
                        padding: 30px;
                        border-radius: 8px;
                        max-width: 500px;
                        margin: 0 auto;
                        border: 1px solid #e50914;
                    }
                    h2 {
                        color: #e50914;
                        margin-bottom: 20px;
                    }
                    p {
                        color: #b3b3b3;
                        margin-bottom: 20px;
                        line-height: 1.5;
                    }
                    a {
                        color: #e50914;
                        text-decoration: none;
                        font-weight: bold;
                    }
                    a:hover {
                        text-decoration: underline;
                    }
                </style>
            </head>
            <body>
                <div class="error-container">
                    <h2>❌ Authorization Failed</h2>
                    <p>Error: ${error.message}</p>
                    <p>Please try again or contact support if the problem persists.</p>
                    <p><a href="/">← Return to Sparrow Stream</a></p>
                </div>
            </body>
            </html>
        `);
    }
});

// ==================== ERROR HANDLING ====================
// 404 handler
app.use((req, res, next) => {
    res.status(404).json({
        error: 'Not Found',
        message: `Cannot ${req.method} ${req.url}`,
        timestamp: new Date().toISOString()
    });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);
    res.status(500).json({
        error: 'Internal Server Error',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
        timestamp: new Date().toISOString()
    });
});

// ==================== SERVER STARTUP ====================
app.listen(PORT, () => {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    console.log(`
    🚀 Sparrow Stream Server Started!
    =================================
    
    📍 Local: http://localhost:${PORT}
    🌐 External: ${baseUrl}
    
    🔒 Authentication: Basic Auth Enabled
    👤 Default Credentials: admin / sparrow123
    
    ⚙️  Configuration:
    - Node Environment: ${process.env.NODE_ENV || 'development'}
    - Port: ${PORT}
    - Token File: ${__dirname}/token.json
    
    📡 Endpoints:
    ✅ Health Check: ${baseUrl}/health
    ✅ Video List: ${baseUrl}/api/videos
    ✅ Video Stream: ${baseUrl}/api/video/:id
    ✅ Auth Status: ${baseUrl}/api/auth-status
    ✅ Stream Proxy: ${baseUrl}/api/stream/:id
    
    ⚠️  Important:
    1. Google Cloud Redirect URI must include: ${baseUrl}/auth/callback
    2. Store GOOGLE_CREDENTIALS in environment variables
    
    📝 Logs will appear below:
    =================================
    `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('SIGINT received. Shutting down...');
    process.exit(0);
});
