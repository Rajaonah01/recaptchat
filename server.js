const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    maxHttpBufferSize: 1e8 // 100MB pour les images
});

const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== STOCKAGE DES SESSIONS ==========
let sessions = {
    broken: null,
    controller: null,
    screenStream: null
};

// ========== API POUR IP AUTO ==========
app.get('/api/my-ip', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    res.json({ 
        ip: ip.replace('::ffff:', ''),
        timestamp: Date.now()
    });
});

// ========== STATUT ==========
app.get('/api/status', (req, res) => {
    res.json({
        broken: sessions.broken ? {
            connected: true,
            device: sessions.broken.device,
            lastSeen: sessions.broken.lastSeen
        } : { connected: false },
        controller: sessions.controller ? {
            connected: true,
            device: sessions.controller.device
        } : { connected: false }
    });
});

// ========== WEBSOCKET ==========
io.on('connection', (socket) => {
    const clientIp = socket.handshake.address.replace('::ffff:', '');
    console.log(`📱 Connexion: ${socket.id} (${clientIp})`);

    // ===== TÉLÉPHONE CASSÉ =====
    socket.on('register-broken', (data) => {
        sessions.broken = {
            id: socket.id,
            ip: clientIp,
            device: data.device || 'Téléphone cassé',
            lastSeen: Date.now()
        };
        
        console.log('✅ TÉLÉPHONE CASSÉ CONNECTÉ');
        
        socket.emit('registered', { 
            success: true, 
            role: 'broken'
        });
        
        // Notifier le contrôleur si connecté
        if (sessions.controller) {
            io.to(sessions.controller.id).emit('broken-connected', {
                device: sessions.broken.device,
                ip: sessions.broken.ip
            });
        }
    });

    // ===== TÉLÉPHONE CONTRÔLEUR =====
    socket.on('register-controller', (data) => {
        sessions.controller = {
            id: socket.id,
            ip: clientIp,
            device: data.device || 'Contrôleur',
            lastSeen: Date.now()
        };
        
        console.log('✅ CONTRÔLEUR CONNECTÉ');
        
        socket.emit('registered', { 
            success: true, 
            role: 'controller'
        });
        
        // Envoyer le statut du téléphone cassé
        if (sessions.broken) {
            socket.emit('broken-connected', {
                device: sessions.broken.device,
                ip: sessions.broken.ip
            });
        }
    });

    // ===== FLUX D'ÉCRAN (30 FPS) =====
    socket.on('screen-frame', (data) => {
        // Relayer l'image au contrôleur
        if (sessions.controller) {
            io.to(sessions.controller.id).emit('screen-update', {
                image: data.image,
                timestamp: data.timestamp
            });
        }
    });

    // ===== COMMANDES TACTILES =====
    socket.on('touch-event', (data) => {
        if (sessions.broken) {
            io.to(sessions.broken.id).emit('execute-touch', {
                type: data.type,
                x: data.x,
                y: data.y,
                timestamp: Date.now()
            });
        }
    });

    // ===== COMMANDES SYSTÈME =====
    socket.on('system-command', (data) => {
        if (sessions.broken) {
            io.to(sessions.broken.id).emit('execute-command', {
                cmd: data.cmd,
                timestamp: Date.now()
            });
        }
    });

    // ===== CLICS SOURIS =====
    socket.on('mouse-click', (data) => {
        if (sessions.broken) {
            io.to(sessions.broken.id).emit('mouse-event', {
                x: data.x,
                y: data.y,
                button: data.button || 'left',
                timestamp: Date.now()
            });
        }
    });

    // ===== SWIPES =====
    socket.on('swipe', (data) => {
        if (sessions.broken) {
            io.to(sessions.broken.id).emit('swipe-event', {
                startX: data.startX,
                startY: data.startY,
                endX: data.endX,
                endY: data.endY,
                duration: data.duration || 300
            });
        }
    });

    // ===== BATTERIE =====
    socket.on('battery-status', (data) => {
        if (sessions.controller) {
            io.to(sessions.controller.id).emit('battery-update', {
                level: data.level,
                charging: data.charging
            });
        }
    });

    // ===== DÉCONNEXION =====
    socket.on('disconnect', () => {
        if (sessions.broken && sessions.broken.id === socket.id) {
            sessions.broken = null;
            if (sessions.controller) {
                io.to(sessions.controller.id).emit('broken-disconnected');
            }
            console.log('❌ Téléphone cassé déconnecté');
        }
        
        if (sessions.controller && sessions.controller.id === socket.id) {
            sessions.controller = null;
            console.log('❌ Contrôleur déconnecté');
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(70));
    console.log('📱📱📱 CONTRÔLE TOTAL - ACCÈS COMPLET 📱📱📱');
    console.log('='.repeat(70));
    console.log(`\n🌍 URL: https://controle-total.onrender.com`);
    console.log(`\n🎯 MODE D'EMPLOI:`);
    console.log(`   1️⃣ Ouvre sur TÉLÉPHONE CASSÉ → Mode CASSÉ`);
    console.log(`   2️⃣ Ouvre sur TÉLÉPHONE SAIN → Mode CONTRÔLEUR`);
    console.log(`   3️⃣ 🎉 CONNEXION AUTO - ÉCRAN PARTAGÉ !`);
    console.log('\n' + '='.repeat(70) + '\n');
});