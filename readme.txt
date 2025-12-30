{"web":{"client_id":"1034759814650-n8bdd879iu40p4mmu1qc4nohcpfsfd3k.apps.googleusercontent.com","project_id":"issue-432608","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","auth_provider_x509_cert_url":"https://www.googleapis.com/oauth2/v1/certs","client_secret":"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","redirect_uris":["http://localhost:3000/auth/callback","http://localhost:3000"],"javascript_origins":["http://localhost:3000","http://localhost"]}}
# Sparrow Stream - Google Drive Video Streaming

A personal video streaming website that streams videos directly from your Google Drive.

## 🚀 Quick Deployment on Render.com

### 1. Prepare Your Code
Upload all files to a GitHub repository.

### 2. Create Render Web Service
1. Sign up at [Render.com](https://render.com)
2. Click "New +" → "Web Service"
3. Connect your GitHub repository
4. Configure:
   - **Name:** sparrow-stream
   - **Environment:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free

### 3. Set Environment Variables
In Render dashboard → Environment section:

#### **GOOGLE_CREDENTIALS** (Required):
Paste your entire `credentials.json` content as JSON string:
```json
{
  "web": {
    "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "project_id": "sparrow-stream-123456",
    "auth