# PDF Flipbook

A local web app that converts uploaded PDFs into a realistic page-flipping book.

## Project Structure

- `frontend/` Vite app (UI + PDF.js rendering + page flip engine)
- `backend/` Express API (`/upload`, `/pdf/:id`, `/sample`)
- `assets/pages/` bundled sample PDF (`example.pdf`)

## Features

- PDF upload with server-side validation
- Up to 1000 pages supported
- Lazy rendering of nearby pages only
- Page conversion to compressed WebP (PNG fallback)
- Double-page spread with realistic flip animation
- Click-to-flip, Previous/Next controls, and keyboard arrows
- Responsive layout for desktop/mobile
- Loading and error states for slow/corrupt inputs
- URL page parameter updates (`?page=NN`)
- Zoom in/out controls
- Page bookmarking (saved in local storage)
- Direct page jump input
- Lightweight page flip sound effect
- Server-side page image preprocessing pipeline for large PDFs
- Dual-quality page assets (`low` then `high`) for progressive display
- Windowed page loading (`current - 2` to `current + 2`) for 1000+ page scalability
- Async document processing status endpoint

## Run Locally

1. Install backend dependencies:

```bash
cd backend
npm install
```

2. Install frontend dependencies:

```bash
cd ../frontend
npm install
```

3. Start backend (Terminal 1):

```bash
cd ../backend
npm run dev
```

4. Start frontend (Terminal 2):

```bash
cd ../frontend
npm run dev
```

5. Open:

- `http://localhost:5173`

## Required: Enable Server-Side Page Caching

Install Poppler so `pdftoppm` is available in PATH.

- Backend converts uploaded PDFs into `low` and `high` JPEG page caches.
- Frontend streams page images from backend and progressively swaps low-to-high quality.
- If Poppler is unavailable, upload is rejected with a clear error.

## API Flow

- `POST /upload` -> returns `202` with document `id` and `status: processing`
- `GET /document/:id` -> returns processing status (`processing`, `ready`, `failed`)
- `GET /page/:id/:pageNumber?quality=low|high` -> serves pre-rendered page image

## Usage

- Click `Open PDF` to upload your own file.
- Or click `Try Sample` to load `assets/pages/example.pdf`.
- Flip pages by clicking page edges, using buttons, or keyboard arrows.
- Use `+ Zoom` / `- Zoom` for detail view.
- Click `Bookmark` to save current page, then `Open Bookmark` to return.
- Enter a page number and click `Go` to jump directly.

## Notes

- Max file size: 80MB
- Max pages: 1000
- Corrupted/unreadable PDFs are rejected with clear errors
