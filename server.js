const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { google } = require('googleapis');
const basicAuth = require('express-basic-auth');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// === SECURITY: Basic Authentication ===
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

// === IMPORTANT: CORS Headers for Video Streaming ===
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Range, Authorization');
    res.header('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    res.header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    next();
});

// Get Google credentials from environment
function getGoogleCredentials() {
    if (process.env.GOOGLE_CREDENTIALS) {
        try {
            return JSON.parse(process.env.GOOGLE_CREDENTIALS);
        } catch (err) {
            console.error('Error parsing GOOGLE_CREDENTIALS:', err.message);
            return null;
        }
    }
    
    // For local development with credentials.json file
    try {
        const credentials = require('./credentials.json');
        return credentials;
    } catch (err) {
        console.error('No credentials found. Please set GOOGLE_CREDENTIALS environment variable.');
        return null;
    }
}

const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// OAuth2 client setup
function getOAuth2Client(redirectUri = null) {
    const credentials = getGoogleCredentials();
    if (!credentials || !credentials.web) {
        throw new Error('Google credentials not configured');
    }
    
    const { client_id, client_secret } = credentials.web;
    
    // Use provided redirect URI or construct from environment
    if (!redirectUri) {
        const baseUrl = process.env.RENDER_EXTERNAL_URL || 
                       `http://localhost:${PORT}`;
        redirectUri = `${baseUrl}/auth/callback`;
    }
    
    return new google.auth.OAuth2(client_id, client_secret, redirectUri);
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/player', (req, res) => {
    res.sendFile(path.join(__dirname, 'player.html'));
});

// API: Get list of videos
app.get('/api/videos', async (req, res) => {
    try {
        const auth = getOAuth2Client();
        
        // Check for saved token
        try {
            const tokenContent = await fs.readFile('./token.json', 'utf8');
            const token = JSON.parse(tokenContent);
            auth.setCredentials(token);
        } catch (err) {
            return res.json({ 
                error: 'Not authenticated', 
                needAuth: true,
                authUrl: generateAuthUrl(auth)
            });
        }
        
        const drive = google.drive({ version: 'v3', auth });
        
        const response = await drive.files.list({
            q: "mimeType contains 'video/' and trashed = false",
            fields: 'files(id, name, size, mimeType, createdTime, modifiedTime, webViewLink, webContentLink, thumbnailLink)',
            orderBy: 'createdTime desc',
            pageSize: 100,
        });

        const videos = response.data.files.map(file => ({
            id: file.id,
            title: file.name,
            size: file.size ? formatFileSize(file.size) : 'Unknown',
            type: file.mimeType,
            created: new Date(file.createdTime).toLocaleDateString(),
            link: file.webViewLink,
            thumbnail: file.thumbnailLink,
            webContentLink: file.webContentLink
        }));

        res.json({ success: true, videos });
    } catch (error) {
        console.error('API Error:', error.message);
        
        if (error.message.includes('invalid_grant') || error.message.includes('token')) {
            // Token expired or invalid
            try {
                await fs.unlink('./token.json');
            } catch (err) {}
            
            res.json({ 
                error: 'Authentication expired. Please reconnect.', 
                needAuth: true,
                authUrl: generateAuthUrl(getOAuth2Client())
            });
        } else {
            res.json({ error: error.message, needAuth: false });
        }
    }
});

// Generate authentication URL
function generateAuthUrl(authClient) {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const redirectUri = `${baseUrl}/auth/callback`;
    
    const newAuth = getOAuth2Client(redirectUri);
    return newAuth.generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        prompt: 'consent'
    });
}

// API: Get video stream URL - FIXED FOR STREAMING
app.get('/api/video/:id', async (req, res) => {
    try {
        const auth = getOAuth2Client();
        
        // Load token
        try {
            const tokenContent = await fs.readFile('./token.json', 'utf8');
            const token = JSON.parse(tokenContent);
            auth.setCredentials(token);
        } catch (err) {
            return res.json({ error: 'Not authenticated. Please connect Google Drive first.' });
        }
        
        const fileId = req.params.id;
        const drive = google.drive({ version: 'v3', auth });
        
        // Get video details
        const file = await drive.files.get({
            fileId: fileId,
            fields: 'id, name, size, mimeType, webContentLink, webViewLink'
        });

        // === FIXED: Multiple streaming URL options ===
        const streamingUrls = {
            // Option 1: Direct Google Drive URL (most reliable)
            direct: `https://drive.google.com/uc?id=${fileId}&export=download`,
            
            // Option 2: Google Drive preview (for embedded playback)
            preview: `https://drive.google.com/file/d/${fileId}/preview`,
            
            // Option 3: Google Drive API with auth (for range requests)
            api: `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
            
            // Option 4: Google Drive viewer
            viewer: `https://drive.google.com/file/d/${fileId}/view`
        };

        // Get authenticated URL for API option
        const headers = await auth.getRequestHeaders();
        const apiUrlWithAuth = `${streamingUrls.api}&access_token=${headers.Authorization.split(' ')[1]}`;
        streamingUrls.apiWithAuth = apiUrlWithAuth;

        // Check if file is publicly accessible (for direct streaming)
        let isPublic = false;
        try {
            const permissions = await drive.permissions.list({
                fileId: fileId,
                fields: 'permissions(type, role)'
            });
            isPublic = permissions.data.permissions.some(p => 
                p.type === 'anyone' && p.role === 'reader'
            );
        } catch (err) {
            console.log('Could not check file permissions:', err.message);
        }

        res.json({
            success: true,
            title: file.data.name,
            size: file.data.size ? formatFileSize(file.data.size) : 'Unknown',
            mimeType: file.data.mimeType,
            isPublic: isPublic,
            
            // Primary streaming URL (using direct download URL)
            streamUrl: streamingUrls.direct,
            
            // Alternative URLs
            alternativeUrls: {
                preview: streamingUrls.preview,
                api: apiUrlWithAuth,
                viewer: streamingUrls.viewer
            },
            
            // For iframe embedding
            embedUrl: streamingUrls.preview,
            
            // For downloading
            downloadUrl: streamingUrls.direct,
            
            // Direct Google Drive link
            directLink: streamingUrls.viewer
        });
    } catch (error) {
        console.error('Video API Error:', error);
        res.json({ 
            success: false, 
            error: error.message,
            needAuth: error.message.includes('invalid_grant') || error.message.includes('token')
        });
    }
});

// === NEW: Video Proxy Endpoint (Solves CORS and Range requests) ===
app.get('/api/stream/:id', async (req, res) => {
    try {
        const auth = getOAuth2Client();
        
        // Load token
        try {
            const tokenContent = await fs.readFile('./token.json', 'utf8');
            const token = JSON.parse(tokenContent);
            auth.setCredentials(token);
        } catch (err) {
            return res.status(401).send('Not authenticated');
        }
        
        const fileId = req.params.id;
        const range = req.headers.range;
        
        const drive = google.drive({ version: 'v3', auth });
        
        // Get file metadata
        const file = await drive.files.get({
            fileId: fileId,
            fields: 'size, mimeType, name'
        });
        
        const fileSize = parseInt(file.data.size);
        const mimeType = file.data.mimeType || 'video/mp4';
        
        // Handle range requests (for video seeking)
        if (range) {
            const parts = range.replace(/bytes=/, "").split("-");
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
            const chunkSize = (end - start) + 1;
            
            const headers = {
                'Content-Range': `bytes ${start}-${end}/${fileSize}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': mimeType,
                'Cache-Control': 'public, max-age=31536000'
            };
            
            res.writeHead(206, headers);
            
            // Stream the file from Google Drive
            const driveStream = await drive.files.get(
                { fileId: fileId, alt: 'media' },
                { responseType: 'stream', headers: { Range: `bytes=${start}-${end}` } }
            );
            
            driveStream.data.pipe(res);
        } else {
            // Full file request
            const headers = {
                'Content-Length': fileSize,
                'Content-Type': mimeType,
                'Accept-Ranges': 'bytes',
                'Cache-Control': 'public, max-age=31536000'
            };
            
            res.writeHead(200, headers);
            
            const driveStream = await drive.files.get(
                { fileId: fileId, alt: 'media' },
                { responseType: 'stream' }
            );
            
            driveStream.data.pipe(res);
        }
    } catch (error) {
        console.error('Stream Error:', error);
        res.status(500).send('Streaming error: ' + error.message);
    }
});

// OAuth callback endpoint
app.get('/auth/callback', async (req, res) => {
    try {
        const code = req.query.code;
        if (!code) {
            return res.status(400).send('Authorization code missing');
        }
        
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const redirectUri = `${baseUrl}/auth/callback`;
        const auth = getOAuth2Client(redirectUri);
        
        const { tokens } = await auth.getToken(code);
        auth.setCredentials(tokens);
        
        // Save tokens to file
        await fs.writeFile('./token.json', JSON.stringify(tokens));
        
        console.log('✅ Token saved successfully');
        
        res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Authorization Successful</title>
                <style>
                    body {
                        font-family: Arial, sans-serif;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                        margin: 0;
                    }
                    .container {
                        background: white;
                        padding: 40px;
                        border-radius: 15px;
                        text-align: center;
                        box-shadow: 0 10px 30px rgba(0,0,0,0.3);
                    }
                    h2 {
                        color: #333;
                        margin-bottom: 20px;
                    }
                    p {
                        color: #666;
                        margin-bottom: 30px;
                    }
                    .success {
                        color: #10b981;
                        font-size: 48px;
                        margin-bottom: 20px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="success">✓</div>
                    <h2>✅ Authorization Successful!</h2>
                    <p>You can now close this window and return to your video library.</p>
                    <script>
                        // Send success message to opener
                        if (window.opener) {
                            window.opener.postMessage('auth_success', '*');
                        }
                        
                        // Close window after 2 seconds
                        setTimeout(() => {
                            try {
                                window.close();
                            } catch (e) {
                                // If window can't be closed, redirect to home
                                setTimeout(() => {
                                    window.location.href = '${baseUrl}';
                                }, 1000);
                            }
                        }, 2000);
                    </script>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('OAuth Callback Error:', error);
        res.status(500).send(`
            <html>
            <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h2 style="color: #e53e3e;">❌ Authorization Failed</h2>
                <p>Error: ${error.message}</p>
                <p><a href="/">Return to Home</a></p>
            </body>
            </html>
        `);
    }
});

// API: Get auth status
app.get('/api/auth-status', async (req, res) => {
    try {
        const tokenExists = await fs.access('./token.json').then(() => true).catch(() => false);
        
        if (tokenExists) {
            const tokenContent = await fs.readFile('./token.json', 'utf8');
            const token = JSON.parse(tokenContent);
            
            // Check if token is expired
            if (token.expiry_date && token.expiry_date < Date.now()) {
                await fs.unlink('./token.json');
                res.json({ authenticated: false, needAuth: true });
            } else {
                res.json({ authenticated: true });
            }
        } else {
            res.json({ authenticated: false, needAuth: true });
        }
    } catch (error) {
        res.json({ authenticated: false, needAuth: true, error: error.message });
    }
});

// API: Revoke authentication
app.get('/api/revoke-auth', async (req, res) => {
    try {
        // Delete token file
        await fs.unlink('./token.json').catch(() => {});
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Helper function to format file size
function formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Start server
app.listen(PORT, () => {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    console.log(`
    🚀 Sparrow Stream Server Started!
    📍 Local: http://localhost:${PORT}
    🌐 External: ${baseUrl}
    
    🔒 Authentication: Basic Auth Enabled
    👤 Username: ${Object.keys(users)[0]}
    
    📹 Streaming Endpoints:
    • /api/video/:id → Video info with multiple URLs
    • /api/stream/:id → Direct streaming proxy
    
    ⚠️  Important Setup:
    1. Google Cloud Redirect URI: ${baseUrl}/auth/callback
    2. Store credentials in GOOGLE_CREDENTIALS environment variable
    
    📁 Token file: ${__dirname}/token.json
    `);
});
