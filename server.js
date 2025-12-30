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
            fields: 'files(id, name, size, mimeType, createdTime, modifiedTime, webViewLink)',
            orderBy: 'createdTime desc',
            pageSize: 100,
        });

        const videos = response.data.files.map(file => ({
            id: file.id,
            title: file.name,
            size: file.size ? formatFileSize(file.size) : 'Unknown',
            type: file.mimeType,
            created: new Date(file.createdTime).toLocaleDateString(),
            link: file.webViewLink
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

// API: Get video stream URL
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
            fields: 'id, name, size, mimeType, webContentLink'
        });

        // Generate authenticated stream URL
        const streamUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
        const headers = await auth.getRequestHeaders();
        const authUrl = `${streamUrl}&access_token=${headers.Authorization.split(' ')[1]}`;

        res.json({
            success: true,
            title: file.data.name,
            streamUrl: authUrl,
            downloadUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
            directLink: `https://drive.google.com/file/d/${fileId}/view`
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
                        // Try to close window after 2 seconds
                        setTimeout(() => {
                            try {
                                window.close();
                            } catch (e) {
                                // If window can't be closed, show message
                                document.body.innerHTML += '<p>You may now close this tab manually.</p>';
                            }
                        }, 2000);
                        
                        // Send message to opener if exists
                        if (window.opener) {
                            window.opener.postMessage('auth_success', '*');
                        }
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
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
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
    
    ⚠️  Important Setup:
    1. Google Cloud Redirect URI: ${baseUrl}/auth/callback
    2. Store credentials in GOOGLE_CREDENTIALS environment variable
    
    📁 Token file: ${__dirname}/token.json
    `);
});