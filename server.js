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

// ==================== HELPER FUNCTIONS ====================
function formatFileSize(bytes) {
    if (bytes === 0 || !bytes) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ==================== ROUTES ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/player', (req, res) => {
    res.sendFile(path.join(__dirname, 'player.html'));
});

// ==================== API ENDPOINTS ====================
app.get('/api/videos', async (req, res) => {
    console.log('Fetching videos from Google Drive...');
    
    try {
        const auth = getOAuth2Client();
        
        try {
            const tokenContent = await fs.readFile('./token.json', 'utf8');
            const token = JSON.parse(tokenContent);
            auth.setCredentials(token);
        } catch (err) {
            const authUrl = generateAuthUrl(auth);
            return res.status(401).json({ 
                error: 'Not authenticated', 
                needAuth: true,
                authUrl: authUrl
            });
        }
        
        const drive = google.drive({ version: 'v3', auth });
        
        // DEBUG: Log the query being sent to Google Drive
        console.log('Querying Google Drive for video files...');
        
        const response = await drive.files.list({
            q: "mimeType contains 'video/' and trashed = false",
            fields: 'files(id, name, size, mimeType, createdTime, modifiedTime, webViewLink, fileExtension)',
            orderBy: 'createdTime desc',
            pageSize: 100,
        });

        console.log(`Found ${response.data.files.length} video files`);
        
        // DEBUG: Log each file's ID
        response.data.files.forEach((file, index) => {
            console.log(`File ${index + 1}: ID="${file.id}", Name="${file.name}"`);
        });

        const videos = response.data.files.map((file, index) => {
            return {
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
                link: file.webViewLink
            };
        });

        res.json({ 
            success: true, 
            videos: videos,
            count: videos.length
        });
        
    } catch (error) {
        console.error('Error fetching videos:', error.message);
        
        if (error.message.includes('invalid_grant') || error.message.includes('token')) {
            await fs.unlink('./token.json').catch(() => {});
            const authUrl = generateAuthUrl(getOAuth2Client());
            res.status(401).json({ 
                error: 'Authentication error', 
                needAuth: true,
                authUrl: authUrl
            });
        } else {
            res.status(500).json({ 
                error: 'Failed to load videos', 
                message: error.message
            });
        }
    }
});

app.get('/api/video/:id', async (req, res) => {
    const videoId = req.params.id;
    console.log(`Fetching video details for ID: ${videoId}`);
    
    try {
        const auth = getOAuth2Client();
        
        try {
            const tokenContent = await fs.readFile('./token.json', 'utf8');
            const token = JSON.parse(tokenContent);
            auth.setCredentials(token);
        } catch (err) {
            return res.status(401).json({ 
                error: 'Not authenticated', 
                needAuth: true
            });
        }
        
        const drive = google.drive({ version: 'v3', auth });
        
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
            webViewLink: file.data.webViewLink
        };

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
                needAuth: true
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

app.get('/api/auth-status', async (req, res) => {
    try {
        const tokenExists = await fs.access('./token.json').then(() => true).catch(() => false);
        
        if (tokenExists) {
            const tokenContent = await fs.readFile('./token.json', 'utf8');
            const token = JSON.parse(tokenContent);
            
            if (token.expiry_date && token.expiry_date < Date.now()) {
                await fs.unlink('./token.json').catch(() => {});
                res.json({ 
                    authenticated: false, 
                    needAuth: true,
                    authUrl: generateAuthUrl(getOAuth2Client())
                });
            } else {
                res.json({ 
                    authenticated: true
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
            error: error.message
        });
    }
});

app.get('/api/revoke-auth', async (req, res) => {
    try {
        await fs.unlink('./token.json').catch(() => {});
        res.json({ 
            success: true, 
            message: 'Logged out successfully'
        });
    } catch (error) {
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
            return res.status(400).send('No authorization code');
        }
        
        const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
        const redirectUri = `${baseUrl}/auth/callback`;
        
        const auth = getOAuth2Client(redirectUri);
        
        const { tokens } = await auth.getToken(code);
        auth.setCredentials(tokens);
        
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
                        background: #141414;
                        color: white;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        height: 100vh;
                        margin: 0;
                    }
                    .container {
                        background: #181818;
                        padding: 40px;
                        border-radius: 8px;
                        text-align: center;
                        max-width: 500px;
                    }
                    .success-icon {
                        color: #46d369;
                        font-size: 48px;
                        margin-bottom: 20px;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="success-icon">✓</div>
                    <h2>✅ Google Drive Connected!</h2>
                    <p>You can now close this window.</p>
                    <script>
                        if (window.opener) {
                            window.opener.postMessage('auth_success', '*');
                        }
                        setTimeout(() => window.close(), 2000);
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
                <h2 style="color: #e50914;">❌ Authorization Failed</h2>
                <p>Error: ${error.message}</p>
                <p><a href="/">Return to Home</a></p>
            </body>
            </html>
        `);
    }
});

// ==================== SERVER STARTUP ====================
app.listen(PORT, () => {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    console.log(`
    🚀 Sparrow Stream Server Started!
    =================================
    
    📍 Local: http://localhost:${PORT}
    🌐 External: ${baseUrl}
    
    ✅ Health Check: ${baseUrl}/health
    ✅ Video API: ${baseUrl}/api/videos
    
    📝 Server logs will appear below:
    =================================
    `);
});
