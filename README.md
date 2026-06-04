# ToonRoom 🌈

A real-time cartoon watch party app for watching together in sync while chatting live.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js)
![Socket.IO](https://img.shields.io/badge/Socket.IO-Real--time-010101?style=for-the-badge&logo=socket.io)
![License](https://img.shields.io/badge/License-MIT-blue?style=for-the-badge)

## ✨ Features

- Real-time playback synchronization (play/pause/seek/media change)
- Live in-room chat
- 4-character room code + shareable room link
- Cartoon/anime/kids themed UI
- Shared server library plus imported local folders
- Responsive UI for mobile and desktop

## 🛠️ Tech Stack

- **Backend:** Node.js, Express, Socket.IO
- **Frontend:** HTML, CSS, Vanilla JavaScript
- **Video:** HTML5 video player

## 🚀 Run Locally

### Prerequisites

- Node.js 16+
- npm

### Setup

```bash
git clone https://github.com/ankitkhatrik6/LoveStream.git
cd LoveStream
npm install
npm start
```

Open:

- http://localhost:3000

## 📁 Adding Cartoons

- Put shared cartoon videos in `public/media/`
- Supported formats: `mp4`, `webm`, `ogg`, `mov`, `m4v`
- You can also import a local folder in the room UI; room sync uses the file path so everyone should import the same folder for full sync

## ⚙️ Environment Variables

- `PORT` (default: `3000`)
- `NODE_ENV` (use `production` in production)
- `CLIENT_URL` (frontend URL used for share link generation in backend)
- `SOCKET_URL` (frontend runtime socket server URL when deploying frontend separately)

## 🌐 Deployment (Vercel + Render)

### Backend (Render)

- Start command: `npm start`
- Set env vars:
  - `NODE_ENV=production`
  - `CLIENT_URL=https://your-vercel-app.vercel.app`

### Frontend (Vercel)

- Build command: `npm run build`
- Output directory: `dist`
- Set env var:
  - `SOCKET_URL=https://your-render-service.onrender.com`

After frontend is live, make sure Render `CLIENT_URL` matches the Vercel URL.

## 📁 Project Structure

```text
ToonRoom/
├── server.js
├── build.js
├── package.json
├── vercel.json
├── render.yaml
├── LICENSE
└── public/
    ├── index.html
    ├── config.js
    ├── css/style.css
    └── js/script.js
```

## 🤝 Contributing

Pull requests are welcome. For major changes, open an issue first.

## 📄 License

This project is licensed under the MIT License.
See [LICENSE](LICENSE).

## 👨‍💻 Author

**Ankit Khatri KC**

---

If this project helped you, give it a ⭐ on GitHub.
