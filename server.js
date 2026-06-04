const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

// Initialize Express app and HTTP server
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

const MEDIA_DIR = path.join(__dirname, 'public', 'media');
const MEDIA_EXTENSIONS = new Set(['.mp4', '.webm', '.ogg', '.mov', '.m4v', '.ogv', '.mkv', '.avi', '.wmv', '.flv', '.3gp', '.ts', '.m2ts', '.mxf', '.mpg', '.mpeg', '.mpe', '.asf', '.f4v', '.m4a', '.m4b', '.mka', '.mts', '.vob', '.divx', '.xvid']);
const INCOMING_UPLOAD_DIR = path.join(__dirname, 'uploads', 'incoming');

fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(INCOMING_UPLOAD_DIR, { recursive: true });

const upload = multer({
  dest: INCOMING_UPLOAD_DIR,
  limits: {
    fileSize: 4 * 1024 * 1024 * 1024
  }
});

function encodeMediaPath(relativePath) {
  return relativePath.split(path.sep).map(encodeURIComponent).join('/');
}

function generateHostToken() {
  return crypto.randomBytes(16).toString('hex');
}

function isSupportedMediaFile(fileName) {
  return MEDIA_EXTENSIONS.has(path.extname(fileName || '').toLowerCase());
}

function sanitizeFileName(fileName) {
  return String(fileName || 'video')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function saveUploadedFiles(roomCode, files) {
  const roomMediaDir = path.join(MEDIA_DIR, roomCode);
  fs.mkdirSync(roomMediaDir, { recursive: true });

  const savedItems = [];
  const timestamp = Date.now();

  files.forEach((file, index) => {
    const originalName = file.originalname || file.filename || `video-${index + 1}`;
    const safeOriginalName = sanitizeFileName(path.basename(originalName));
    if (!isSupportedMediaFile(safeOriginalName)) {
      try { fs.unlinkSync(file.path); } catch (e) {}
      return;
    }

    const finalName = `${timestamp}-${index + 1}-${safeOriginalName}`;
    const finalPath = path.join(roomMediaDir, finalName);
    fs.renameSync(file.path, finalPath);

    savedItems.push({
      id: `${roomCode}/${finalName}`,
      title: formatMediaTitle(safeOriginalName),
      filename: safeOriginalName,
      relativePath: `${roomCode}/${finalName}`,
      mediaUrl: `/media/${encodeMediaPath(`${roomCode}/${finalName}`)}`,
      sourceType: 'server'
    });
  });

  return savedItems;
}

function emitRoomHostState(room) {
  io.to(room.code).emit('host-changed', {
    hostId: room.host || null,
    hostUsername: room.hostUsername || null,
    hostToken: room.hostToken || null
  });
}

function formatMediaTitle(fileName) {
  return fileName
    .replace(/\.[^.]+$/, '')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function scanMediaLibrary() {
  const mediaItems = [];

  function walk(currentDir, relativeDir = '') {
    if (!fs.existsSync(currentDir)) return;

    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = path.join(relativeDir, entry.name);

      if (entry.isDirectory()) {
        walk(absolutePath, relativePath);
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(extension)) continue;

      mediaItems.push({
        id: relativePath,
        title: formatMediaTitle(entry.name),
        filename: entry.name,
        relativePath,
        mediaUrl: `/media/${encodeMediaPath(relativePath)}`,
        sourceType: 'server'
      });
    }
  }

  walk(MEDIA_DIR);
  return mediaItems.sort((first, second) => first.title.localeCompare(second.title));
}

app.get('/api/media-library', (req, res) => {
  const items = scanMediaLibrary();
  res.json({
    items,
    total: items.length
  });
});

app.post('/api/rooms/:roomCode/upload-media', upload.array('mediaFiles'), (req, res) => {
  const roomCode = String(req.params.roomCode || '').toUpperCase();
  const room = rooms.get(roomCode);

  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }

  const hostToken = String(req.headers['x-host-token'] || req.body.hostToken || '').trim();
  if (!hostToken || hostToken !== room.hostToken) {
    return res.status(403).json({ error: 'Host authentication failed' });
  }

  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) {
    return res.status(400).json({ error: 'No media files received' });
  }

  const savedItems = saveUploadedFiles(roomCode, files);
  return res.json({
    message: 'Upload complete',
    uploaded: savedItems.length,
    items: savedItems,
    total: scanMediaLibrary().length
  });
});

// Serve index.html on root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store active rooms and their users
const rooms = new Map();
// Pending removal timers for disconnected sockets to allow quick reconnects
const pendingRemovalTimers = new Map();

// Helper: construct a sync state for a room, adjusting currentTime if playing
function getSyncState(room) {
  if (!room || !room.mediaState) {
    return {
      videoId: null,
      mediaTitle: null,
      mediaUrl: null,
      mediaPath: null,
      sourceType: null,
      isPlaying: false,
      currentTime: 0
    };
  }

  const vs = room.mediaState;
  let adjustedTime = vs.currentTime || 0;
  if (vs.isPlaying && vs.lastUpdated) {
    const elapsed = (Date.now() - vs.lastUpdated) / 1000.0;
    adjustedTime = adjustedTime + elapsed;
  }
  return {
    videoId: vs.videoId || null,
    mediaTitle: vs.mediaTitle || null,
    mediaUrl: vs.mediaUrl || null,
    mediaPath: vs.mediaPath || null,
    sourceType: vs.sourceType || null,
    isPlaying: !!vs.isPlaying,
    currentTime: adjustedTime
  };
}
/**
 * Socket.IO connection handler
 * Manages user connections, room creation, joining, and real-time communication
 */
io.on('connection', (socket) => {
  console.log(`New user connected: ${socket.id}`);

  /**
   * Create or join a room
   * Generates a unique 4-character room code
   */
  socket.on('join-room', (data) => {
    const { username, roomCode } = data;
    // If socket was already in a different room, remove it first to avoid duplicates
    if (socket.roomCode && socket.roomCode !== roomCode) {
      const prevRoom = rooms.get(socket.roomCode);
      if (prevRoom) {
        prevRoom.users = prevRoom.users.filter(u => u.id !== socket.id);
        io.to(socket.roomCode).emit('user-count', prevRoom.users.length);
        if (prevRoom.users.length === 0) {
          rooms.delete(socket.roomCode);
          console.log(`Room ${socket.roomCode} deleted (cleanup)`);
        }
      }
      try { socket.leave(socket.roomCode); } catch (e) {}
      delete socket.roomCode;
    }

    // If no room code provided, create a new room
    if (!roomCode) {
      const newRoomCode = generateRoomCode();
      socket.join(newRoomCode);
      socket.username = username;
      socket.roomCode = newRoomCode;

      if (!rooms.has(newRoomCode)) {
        rooms.set(newRoomCode, {
          code: newRoomCode,
          users: [],
          host: socket.id,
          hostUsername: username,
          hostToken: generateHostToken(),
          mediaState: {
            videoId: null,
            mediaTitle: null,
            mediaUrl: null,
            mediaPath: null,
            sourceType: null,
            isPlaying: false,
            currentTime: 0,
            lastUpdated: Date.now()
          },
          messages: []
        });
      }

      const room = rooms.get(newRoomCode);
      // Avoid adding same socket twice
      if (!room.users.find(u => u.id === socket.id)) {
        room.users.push({
          id: socket.id,
          username: username,
          joinedAt: new Date()
        });
      }

      // Send room created confirmation to the creator (include host info)
      socket.emit('room-created', {
        roomCode: newRoomCode,
        roomLink: `${getBaseUrl(socket)}?room=${newRoomCode}`,
        hostId: socket.id,
        hostUsername: username,
        hostToken: rooms.get(newRoomCode).hostToken
      });

      // Notify about user count
      io.to(newRoomCode).emit('user-count', room.users.length);
      console.log(`Room created: ${newRoomCode}`);

    } else {
      // Join existing room
      const room = rooms.get(roomCode);

      if (!room) {
        socket.emit('error', 'Room not found');
        return;
      }

      // Handle quick reconnection: if a user with same username was marked disconnected,
      // treat this as a reconnection and restore their socket id without emitting left/join events.
      const maybeReconnect = room.users.find(u => u.username === username && u.disconnected);
      if (maybeReconnect) {
        const key = `${roomCode}:${username}`;
        const timer = pendingRemovalTimers.get(key);
        if (timer) {
          clearTimeout(timer);
          pendingRemovalTimers.delete(key);
        }

        // restore user
        maybeReconnect.id = socket.id;
        maybeReconnect.disconnected = false;
        maybeReconnect.joinedAt = new Date();

        socket.join(roomCode);
        socket.username = username;
        socket.roomCode = roomCode;

        // send join confirmation and state without broadcasting join event
        socket.emit('room-joined', {
          roomCode: roomCode,
          roomLink: `${getBaseUrl(socket)}?room=${roomCode}`,
          users: room.users.map(u => ({ id: u.id, username: u.username })),
          hostId: room.host || null,
          hostUsername: room.hostUsername || null,
          hostToken: room.hostToken || null
        });

        socket.emit('sync-video-state', getSyncState(room));
        socket.emit('chat-history', room.messages || []);
        socket.emit('user-count', room.users.length);

        console.log(`User ${username} reconnected to room: ${roomCode}`);
        return;
      }

      // If socket already recorded in room, just sync state back
      if (room.users.find(u => u.id === socket.id)) {
        socket.emit('sync-video-state', getSyncState(room));
        socket.emit('room-created', { roomCode: roomCode, roomLink: `${getBaseUrl(socket)}?room=${roomCode}`, hostId: room.host || null, hostUsername: room.hostUsername || null, hostToken: room.hostToken || null });
        socket.emit('chat-history', room.messages || []);
        return;
      }

      if (room.users.length >= 2) {
        socket.emit('error', 'Room is full (max 2 users)');
        return;
      }

      socket.join(roomCode);
      socket.username = username;
      socket.roomCode = roomCode;

      room.users.push({
        id: socket.id,
        username: username,
        joinedAt: new Date()
      });

      // Notify the joining socket that it has successfully joined
      socket.emit('room-joined', {
        roomCode: roomCode,
        roomLink: `${getBaseUrl(socket)}?room=${roomCode}`,
        users: room.users.map(u => ({ id: u.id, username: u.username })),
        messages: room.messages || [],
        hostId: room.host || null,
        hostUsername: room.hostUsername || null,
        hostToken: room.hostToken || null
      });

      // Notify all users in room that someone joined
      io.to(roomCode).emit('user-joined', {
        username: username,
        userCount: room.users.length
      });

      // Send current video state to new user (adjusted if playing)
      socket.emit('sync-video-state', getSyncState(room));

      // Send chat history to the joining user
      socket.emit('chat-history', room.messages || []);

      // Update user count
      io.to(roomCode).emit('user-count', room.users.length);
      console.log(`User ${username} joined room: ${roomCode}`);
    }
  });

  // Allow a client to explicitly request the current sync state for the room
  socket.on('request-sync', () => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    socket.emit('sync-video-state', getSyncState(room));
  });

  // Request peer state: ask other clients in room to report their current player state
  socket.on('request-peer-state', () => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;
    // broadcast to others in the room asking them to respond directly to requester
    socket.broadcast.to(roomCode).emit('peer-state-request', { requesterId: socket.id });
  });

  // Receive a peer state from a client and forward it to the target requester
  socket.on('peer-state', (data) => {
    // data: { target: socketId, state: { videoId, currentTime, isPlaying } }
    if (!data || !data.target || !data.state) return;
    try {
      io.to(data.target).emit('peer-state', data.state);
    } catch (e) {
      console.warn('Failed to forward peer-state', e);
    }
  });

  /**
   * Handle chat messages
   * Broadcast messages to all users in the room
   */
  socket.on('send-message', (message) => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;

    const messageData = {
      username: socket.username,
      text: message,
      timestamp: new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      })
    };

    // store message in room history
    const room = rooms.get(roomCode);
    if (room) {
      room.messages = room.messages || [];
      room.messages.push(messageData);
      // keep last 200 messages
      if (room.messages.length > 200) room.messages = room.messages.slice(-200);
    }

    io.to(roomCode).emit('receive-message', messageData);
  });

  // Allow client to explicitly leave a room (clears session on server)
  socket.on('leave-room', () => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (room) {
      // remove any pending removal timers for this user
      const key = `${roomCode}:${socket.username}`;
      const t = pendingRemovalTimers.get(key);
      if (t) {
        clearTimeout(t);
        pendingRemovalTimers.delete(key);
      }

      // handle host leaving: if host leaves explicitly, promote another user
      const wasHost = room.host === socket.id;

      room.users = room.users.filter(user => user.id !== socket.id);

      if (wasHost && room.users.length > 0) {
        // promote first user
        const newHost = room.users[0];
        room.host = newHost.id;
        room.hostUsername = newHost.username;
        room.hostToken = generateHostToken();
        emitRoomHostState(room);
      }

      // Notify remaining users
      io.to(roomCode).emit('user-left', {
        username: socket.username,
        userCount: room.users.length
      });

      io.to(roomCode).emit('user-count', room.users.length);

      if (room.users.length === 0) {
        rooms.delete(roomCode);
        console.log(`Room ${roomCode} deleted (empty)`);
      }
    }

    try { socket.leave(roomCode); } catch (e) {}
    delete socket.roomCode;
    delete socket.username;
  });

  /**
   * Handle video play event
   * Sync play state across users
   */
  socket.on('video-play', (data) => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (room) {
      room.mediaState.isPlaying = true;
      room.mediaState.currentTime = data.currentTime;
      room.mediaState.lastUpdated = Date.now();
    }

    // Broadcast to all others (NOT sender to avoid double-play)
    socket.broadcast.to(roomCode).emit('video-play', {
      currentTime: data.currentTime
    });
  });

  /**
   * Handle video pause event
   * Sync pause state across users
   */
  socket.on('video-pause', (data) => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (room) {
      room.mediaState.isPlaying = false;
      room.mediaState.currentTime = data.currentTime;
      room.mediaState.lastUpdated = Date.now();
    }

    // Broadcast to all others (NOT sender to avoid double-pause)
    socket.broadcast.to(roomCode).emit('video-pause', {
      currentTime: data.currentTime
    });
  });

  /**
   * Handle video seek event
   * Sync seek position across users
   */
  socket.on('video-seek', (data) => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (room) {
      room.mediaState.currentTime = data.currentTime;
    }

    io.to(roomCode).emit('video-seek', {
      currentTime: data.currentTime
    });
    if (room) room.mediaState.lastUpdated = Date.now();
  });

  /**
   * Handle video change event
   * When a new video is loaded, sync across users
   */
  socket.on('video-changed', (data) => {
    const roomCode = socket.roomCode;
    if (!roomCode) return;

    const room = rooms.get(roomCode);
    if (!room) return;

    room.mediaState.videoId = data.videoId || null;
    room.mediaState.mediaTitle = data.mediaTitle || null;
    room.mediaState.mediaUrl = data.mediaUrl || null;
    room.mediaState.mediaPath = data.mediaPath || null;
    room.mediaState.sourceType = data.sourceType || null;
    room.mediaState.isPlaying = false;
    room.mediaState.currentTime = 0;
    room.mediaState.lastUpdated = Date.now();

    // broadcast new video to all users in the room (including sender) with full state
    io.to(roomCode).emit('video-changed', {
      videoId: data.videoId,
      mediaTitle: data.mediaTitle || null,
      mediaUrl: data.mediaUrl || null,
      mediaPath: data.mediaPath || null,
      sourceType: data.sourceType || null,
      currentTime: 0,
      isPlaying: false
    });
    
    // Also emit sync-video-state to ensure all clients sync properly
    io.to(roomCode).emit('sync-video-state', getSyncState(room));
  });

  /**
   * Handle user disconnect
   * Clean up room and notify other users
   */
  socket.on('disconnect', () => {
    const roomCode = socket.roomCode;
    console.log(`User ${socket.username} disconnected from room ${roomCode}`);

    if (roomCode && rooms.has(roomCode)) {
      const room = rooms.get(roomCode);
      // mark user as disconnected and schedule removal after a grace period
      const user = room.users.find(u => u.id === socket.id);
      if (user) {
        user.disconnected = true;
        const key = `${roomCode}:${user.username}`;
        // schedule final removal after 8 seconds
        const timer = setTimeout(() => {
          // remove user permanently
          const removedId = user.id;
          room.users = room.users.filter(uu => uu.id !== removedId && uu.username !== user.username);
          pendingRemovalTimers.delete(key);

          if (room.users.length === 0) {
            rooms.delete(roomCode);
            console.log(`Room ${roomCode} deleted (empty)`);
          } else {
            // If removed user was host, promote new host
            if (room.host === removedId) {
              const newHost = room.users[0];
              if (newHost) {
                room.host = newHost.id;
                room.hostUsername = newHost.username;
                room.hostToken = generateHostToken();
                emitRoomHostState(room);
              }
            }

            io.to(roomCode).emit('user-left', {
              username: user.username,
              userCount: room.users.length
            });
            io.to(roomCode).emit('user-count', room.users.length);
          }
        }, 8000);

        pendingRemovalTimers.set(key, timer);
      }
    }
  });
});

/**
 * Generate a random 4-character room code
 * @returns {string} Room code in format XXXX where X is alphanumeric
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }

  // Ensure code doesn't already exist
  if (rooms.has(code)) {
    return generateRoomCode();
  }

  return code;
}

/**
 * Get base URL for generating room links
 * Works in both local and production environments
 * @returns {string} Base URL of the application
 */
/**
 * Get base URL for generating room links.
 * Prefer explicit CLIENT_URL (set in Render/Vercel), then the socket origin,
 * then fall back to local dev URL.
 * @param {Socket} [socket] optional Socket.IO socket to read origin header
 */
function getBaseUrl(socket) {
  const clientUrl = process.env.CLIENT_URL || process.env.PUBLIC_URL;
  if (clientUrl) return clientUrl.replace(/\/$/, '');

  // If we have a socket (client request), prefer the Origin header the browser sent
  try {
    if (socket && socket.handshake && socket.handshake.headers && socket.handshake.headers.origin) {
      return socket.handshake.headers.origin.replace(/\/$/, '');
    }
  } catch (e) {
    // ignore and fall back
  }

  const host = process.env.HOST || 'localhost';
  const port = process.env.PORT || 3000;
  const protocol = process.env.NODE_ENV === 'production' ? 'https' : 'http';
  return `${protocol}://${host}:${port}`;
}

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎬 Watch Party Server running on port ${PORT}`);
  console.log(`📱 Open http://localhost:${PORT} in your browser`);
});
