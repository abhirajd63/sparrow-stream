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
    users['admin'] = 'sparrow123'; // Default for local development
}

app.use(basicAuth({
    users: users,
    challenge: true,
    realm: 'Sparrow Stream - Enter admin/sparrow123',
    unauthorizedResponse: 'Access Denied. Please login with correct credentials.'
}));

// Middleware
app.use(express.static('.'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==================== GOOGLE DRIVE SETUP ====================
function getGoogleCredentials() {
    // Try to get from environment variable first (for Render.com)
    if (process.env.GOOGLE_CREDENTIALS) {
        try {
            console.log('Using credentials from environment variable');
            return JSON.parse(process.env.GOOGLE_CREDENTIALS);
        } catch (err) {
            console.error('Error parsing GOOGLE_CREDENTIALS:', err.message);
            return null;
        }
    }
    
    // Fallback to local credentials.json file
    try {
        console.log('Using credentials from credentials.json file');
        const credentials = require('./credentials.json');
        return credentials;
    } catch (err) {
        console.error('No credentials found:', err.message);
        console.error('Please set GOOGLE_CREDENTIALS environment variable or create credentials.json');
        return null;
    }
}

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// Get OAuth2 client with proper redirect URI
function getOAuth2Client(redirectUri = null) {
    const credentials = getGoogleCredentials();
    if (!credentials || !credentials.web) {
        throw new Error('Google credentials not configured properly');
    }
    
    const { client_id, client_secret } = credentials.web;
    
    // Use provided redirect URI or construct from environment
    if (!redirectUri) {
        const baseUrl = process.env.RENDER_EXTERNAL_URL || 
                       (process.env.NODE_ENV === 'production' 
                           ? `https://${process.env.HOST || 'localhost'}:${PORT}`
                           : `http://localhost:${PORT}`);
        redirectUri = `${baseUrl}/auth/callback`;
    }
    
    console.log('OAuth2 redirect URI:', redirectUri);
    return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

// ==================== HELPER FUNCTIONS ====================
function formatFileSize(bytes) {
    if (bytes === 0 || !bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Cache for video metadata (to reduce API calls)
const videoCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// ==================== ROUTES ====================

// Home page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Video player page
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
    console.log('GET /api/videos - Request received');
    
    try {
        const auth = getOAuth2Client();
        
        // Check for saved token
        try {
            const tokenContent = await fs.readFile('./token.json', 'utf8');
            const token = JSON.parse(tokenContent);
            auth.setCredentials(token);
            console.log('Using saved token');
        } catch (err) {
            console.log('No saved token found, need authentication');
            const authUrl = generateAuthUrl(auth);
            return res.status(401).json({ 
                error: 'Not authenticated', 
                needAuth: true,
                authUrl: authUrl,
                message: 'Please connect Google Drive first'
            });
        }
        
        // Check if token is expired
        try {
            await auth.getAccessToken();
        } catch (tokenError) {
            console.log('Token expired or invalid:', tokenError.message);
            await fs.unlink('./token.json').catch(() => {});
            const authUrl = generateAuthUrl(getOAuth2Client());
            return res.status(401).json({ 
                error: 'Authentication expired', 
                needAuth: true,
                authUrl: authUrl,
                message: 'Please reconnect Google Drive'
            });
        }
        
        const drive = google.drive({ version: 'v3', auth });
        
        console.log('Fetching videos from Google Drive...');
        
        // Get all video files (common video MIME types)
        const response = await drive.files.list({
            q: "mimeType contains 'video/' and trashed = false",
            fields: 'files(id, name, size, mimeType, createdTime, modifiedTime, webViewLink, fileExtension)',
            orderBy: 'createdTime desc',
            pageSize: 100,
        });

        console.log(`Found ${response.data.files.length} videos`);

        const videos = response.data.files.map(file => ({
            id: file.id,
            title: file.name,
            size: file.size ? formatFileSize(file.size) : 'Unknown',
            type: file.mimeType,
            created: new Date(file.createdTime).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric'
            }),
            modified: file.modifiedTime,
            extension: file.fileExtension || 'Unknown',
            link: file.webViewLink,
            // Cache the file info for faster streaming
            cacheKey: `video_${file.id}_${Date.now()}`
        }));

        // Update cache
        videos.forEach(video => {
            videoCache.set(video.id, {
                data: video,
                timestamp: Date.now()
            });
        });

        res.json({ 
            success: true, 
            videos: videos,
            count: videos.length,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('Error fetching videos:', error.message);
        
        if (error.message.includes('invalid_grant') || 
            error.message.includes('token') || 
            error.message.includes('credentials')) {
            
            console.log('Clearing invalid token...');
            await fs.unlink('./token.json').catch(() => {});
            
            const authUrl = generateAuthUrl(getOAuth2Client());
            res.status(401).json({ 
                error: 'Authentication error', 
                needAuth: true,
                authUrl: authUrl,
                message: 'Please reconnect Google Drive'
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
    console.log(`GET /api/video/${videoId} - Request received`);
    
    try {
        const auth = getOAuth2Client();
        
        // Check for saved token
        try {
            const tokenContent = await fs.readFile('./token.json', 'utf8');
            const token = JSON.parse(tokenContent);
            auth.setCredentials(token);
        } catch (err) {
            console.log('No token found for video request');
            return res.status(401).json({ 
                error: 'Not authenticated', 
                needAuth: true,
                message: 'Please connect Google Drive first'
            });
        }
        
        const drive = google.drive({ version: 'v3', auth });
        
        // Check cache first
        const cached = videoCache.get(videoId);
        if (cached && (Date.now() - cached.timestamp) < CACHE_DURATION) {
            console.log('Using cached video data');
        } else {
            console.log('Fetching fresh video data from Google Drive');
        }
        
        // Get video details
        const file = await drive.files.get({
            fileId: videoId,
            fields: 'id, name, size, mimeType, webContentLink, webViewLink, createdTime'
        });

        // Generate authenticated stream URL
        const streamUrl = `https://www.googleapis.com/drive/v3/files/${videoId}?alt=media`;
        const headers = await auth.getRequestHeaders();
        const accessToken = headers.Authorization.split(' ')[1];
        const authUrl = `${streamUrl}&access_token=${accessToken}`;

        const videoData = {
            id: file.data.id,
            title: file.data.name,
            size: file.data.size ? formatFileSize(file.data.size) : 'Unknown',
            type: file.data.mimeType,
            created: new Date(file.data.createdTime).toLocaleDateString(),
            streamUrl: authUrl,
            downloadUrl: `https://drive.google.com/uc?export=download&id=${videoId}`,
            directLink: `https://drive.google.com/file/d/${videoId}/view`,
            webViewLink: file.data.webViewLink,
            // Token will expire in 1 hour (Google tokens typically last 1 hour)
            tokenExpiry: Date.now() + (60 * 60 * 1000)
        };

        // Update cache
        videoCache.set(videoId, {
            data: videoData,
            timestamp: Date.now()
        });

        res.json({
            success: true,
            ...videoData
        });
        
    } catch (error) {
        console.error('Error fetching video:', error.message);
        
        if (error.message.includes('invalid_grant') || error.message.includes('token')) {
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
                message: 'The requested video could not be found in your Google Drive'
            });
        } else {
            res.status(500).json({ 
                success: false, 
                error: 'Failed to load video',
                message: error.message
            });
        }
    }
});

// Generate authentication URL
function generateAuthUrl(authClient) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || 
                   (process.env.NODE_ENV === 'production' 
                       ? `https://${process.env.HOST || 'localhost'}:${PORT}`
                       : `http://localhost:${PORT}`);
    
    const redirectUri = `${baseUrl}/auth/callback`;
    console.log('Generating auth URL with redirect:', redirectUri);
    
    const newAuth = getOAuth2Client(redirectUri);
    return newAuth.generateAuthUrl({
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
            const tokenContent = await fs.readFile('./token.json', 'utf8');
            const token = JSON.parse(tokenContent);
            
            // Check if token is expired
            if (token.expiry_date && token.expiry_date < Date.now()) {
                console.log('Token expired, deleting...');
                await fs.unlink('./token.json').catch(() => {});
                res.json({ 
                    authenticated: false, 
                    needAuth: true,
                    authUrl: generateAuthUrl(getOAuth2Client())
                });
            } else {
                res.json({ 
                    authenticated: true,
                    timestamp: new Date().toISOString()
                });
            }
        } else {
            res.json({ 
                authenticated: false, 
                needAuth: true,
                authUrl: generateAuthUrl(getOAuth2Client())
            });
        }
    } catch (error) {
        console.error('Error checking auth status:', error);
        res.json({ 
            authenticated: false, 
            needAuth: true,
            error: error.message,
            authUrl: generateAuthUrl(getOAuth2Client())
        });
    }
});

// API: Revoke authentication (logout)
app.get('/api/revoke-auth', async (req, res) => {
    try {
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
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                    <h2 style="color: #e50914;">❌ Authorization Failed</h2>
                    <p>No authorization code received from Google.</p>
                    <p><a href="/" style="color: #e50914;">Return to Home</a></p>
                </body>
                </html>
            `);
        }
        
        const baseUrl = process.env.RENDER_EXTERNAL_URL || 
                       (process.env.NODE_ENV === 'production' 
                           ? `https://${process.env.HOST || 'localhost'}:${PORT}`
                           : `http://localhost:${PORT}`);
        
        const redirectUri = `${baseUrl}/auth/callback`;
        console.log('Using redirect URI for token exchange:', redirectUri);
        
        const auth = getOAuth2Client(redirectUri);
        
        console.log('Exchanging code for tokens...');
        const { tokens } = await auth.getToken(code);
        auth.setCredentials(tokens);
        
        console.log('Tokens received, saving...');
        // Save tokens to file
        await fs.writeFile('./token.json', JSON.stringify(tokens));
        
        console.log('✅ Token saved successfully');
        
        // Send success page with auto-close script
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
                    .button {
                        display: inline-block;
                        background: #e50914;
                        color: white;
                        padding: 12px 24px;
                        border-radius: 4px;
                        text-decoration: none;
                        font-weight: 600;
                        transition: background 0.3s;
                    }
                    .button:hover {
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
                    
                    <script>
                        // Send message to opener
                        if (window.opener) {
                            window.opener.postMessage('auth_success', '*');
                        }
                        
                        // Try to close window after 3 seconds
                        setTimeout(() => {
                            try {
                                window.close();
                            } catch (e) {
                                console.log('Window could not be closed automatically');
                            }
                        }, 3000);
                        
                        // If still open after 5 seconds, show close button
                        setTimeout(() => {
                            if (!document.querySelector('.manual-close')) {
                                const button = document.createElement('a');
                                button.href = '#';
                                button.className = 'button manual-close';
                                button.textContent = 'Close Window';
                                button.onclick = () => window.close();
                                document.querySelector('.container').appendChild(button);
                            }
                        }, 5000);
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
    const baseUrl = process.env.RENDER_EXTERNAL_URL || 
                   (process.env.NODE_ENV === 'production' 
                       ? `https://${process.env.HOST || 'localhost'}:${PORT}`
                       : `http://localhost:${PORT}`);
    
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
    
    ⚠️  Important Setup Reminders:
    1. Google Cloud Redirect URI: ${baseUrl}/auth/callback
    2. Store credentials in GOOGLE_CREDENTIALS environment variable
    3. Update ADMIN_PASSWORD for production use
    
    ✅ Health Check: ${baseUrl}/health
    ✅ Video API: ${baseUrl}/api/videos
    ✅ Auth Status: ${baseUrl}/api/auth-status
    
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
