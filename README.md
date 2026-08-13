# Vehicle Expiry & Document Management Application

A modern, high-performance, mobile-first web application designed to track vehicle document expirations, upload & manage vehicle records, capture documents via live camera scanner, and receive automated notifications for expiring documents.

---

## 🌟 Key Features

1. **📱 Mobile-First UX & Interactive Dashboard**:
   - Modern responsive layout with touch-friendly navigation bar, dark/light theme toggle, search bar, and filter pills (All, Expired, Expiring Soon, Valid).
   - Real-time statistics overview: Total Vehicles, Expired Documents, Expiring Soon (< 30 days), and Valid.

2. **💾 Client-Side Backend (IndexedDB Engine)**:
   - Built-in **IndexedDB database** that supports storing hundreds of vehicle records and high-resolution document images/PDFs directly on device storage without hitting browser 5MB localStorage limits.
   - Complete **JSON Database Export & Import Backup** support for easy data transfer and offline security.

3. **📷 Live WebRTC Camera Scanner & Direct Upload**:
   - **Mobile Camera Launcher**: Directly triggers front/rear camera using native `<input type="file" capture="environment">`.
   - **In-App Camera Capture Scanner**: Embedded WebRTC camera view with flip camera, snapshot capture, and document category tag assignment (RC, Insurance, Fitness, Tax, Permit, PUCC).

4. **📂 Complete Document Editor (CRUD)**:
   - **Add / Remove / Update / Rename**: View attached vehicle documents, add new files, rename document categories, replace existing files, or delete single documents.
   - **Document Preview Lightbox**: Zoomable image lightbox and inline PDF previewer.

5. **🚨 Per-Document Expiry Notification System**:
   - Tracks expiry dates independently for **Insurance**, **Fitness**, **Tax**, **Permit**, **National Permit**, **PUCC**, and custom uploaded documents.
   - **Native System & Push Notifications**: Triggers OS/browser notifications when documents expire or approach expiry.
   - **In-App Notification Center**: Accessible from header bell icon with active badge count and quick edit actions.
   - **Background Sync Service Worker**: Periodic checks for updates.

6. **📦 Document Downloading & Data Export**:
   - **Single File Download**: Download any document individually with one click.
   - **Bulk ZIP Package Download**: Download all documents attached to a vehicle in a single compressed `.zip` archive using `JSZip`.
   - **CSV / Excel Export**: Export full vehicle data and document statuses to `.csv`.

---

## 🚀 Step-by-Step: Host on a Brand New GitHub Repository (`msuhailc-47`)

### Step 1: Create a New Repository on GitHub
1. Log into your GitHub account: **`msuhailc-47`**
2. Go to **[github.com/new](https://github.com/new)**
3. Enter Repository name: `vehicle-expiry-app` *(or any name you like)*
4. Keep visibility set to **Public**.
5. Leave "Add a README file", ".gitignore", and license **unchecked**.
6. Click **Create repository**.

### Step 2: Push Local Code to the New Repository
Open PowerShell / Terminal in `c:\Users\ITG\Desktop\MSC\Vehicle expiry` and run:

```powershell
# Add remote URL for your new repository
git remote add origin https://github.com/msuhailc-47/vehicle-expiry-app.git

# Push code to the main branch
git push -u origin main
```

### Step 3: Enable Free GitHub Pages Hosting
1. Open your new repository on GitHub: `https://github.com/msuhailc-47/vehicle-expiry-app`
2. Click **Settings** (top tab) -> **Pages** (left side menu).
3. Under **Build and deployment** > **Source**, choose **Deploy from a branch**.
4. Select Branch: **`main`** and folder: **`/ (root)`**, then click **Save**.
5. In 1–2 minutes, your new app will be live at:
   **`https://msuhailc-47.github.io/vehicle-expiry-app/`**
