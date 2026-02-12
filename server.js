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
    }
});

const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ========== STOCKAGE DES TÉLÉPHONES ==========
let phones = {
    broken: null,     // Téléphone cassé (serveur)
    controller: null  // Téléphone contrôleur
};

// ========== DÉTECTION AUTOMATIQUE D'IP ==========
app.get('/api/my-ip', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    res.json({ 
        ip: ip.replace('::ffff:', ''),
        timestamp: Date.now()
    });
});

// ========== SOCKET.IO - COMMUNICATION DIRECTE ==========
io.on('connection', (socket) => {
    console.log(`📱 Nouvelle connexion: ${socket.id}`);
    const clientIp = socket.handshake.address.replace('::ffff:', '');
    console.log(`📍 IP: ${clientIp}`);
    
    // ===== ENREGISTREMENT DU TÉLÉPHONE CASSÉ =====
    socket.on('register-broken', (data) => {
        phones.broken = {
            id: socket.id,
            ip: clientIp,
            device: data.device || 'Téléphone cassé',
            lastSeen: Date.now()
        };
        
        console.log('✅ TÉLÉPHONE CASSÉ ENREGISTRÉ !');
        console.log(`   📱 IP: ${clientIp}`);
        
        // Notifier tous les contrôleurs
        io.emit('broken-phone-status', {
            connected: true,
            ip: clientIp,
            device: phones.broken.device,
            timestamp: Date.now()
        });
        
        socket.emit('registered', { 
            success: true, 
            role: 'broken',
            ip: clientIp
        });
    });
    
    // ===== ENREGISTREMENT DU TÉLÉPHONE CONTRÔLEUR =====
    socket.on('register-controller', (data) => {
        phones.controller = {
            id: socket.id,
            ip: clientIp,
            device: data.device || 'Contrôleur',
            lastSeen: Date.now()
        };
        
        console.log('✅ TÉLÉPHONE CONTRÔLEUR ENREGISTRÉ !');
        
        // Envoyer immédiatement l'IP du téléphone cassé si disponible
        if (phones.broken) {
            socket.emit('broken-phone-status', {
                connected: true,
                ip: phones.broken.ip,
                device: phones.broken.device,
                timestamp: Date.now()
            });
        }
        
        socket.emit('registered', { 
            success: true, 
            role: 'controller'
        });
    });
    
    // ===== COMMANDE DU CONTRÔLEUR VERS LE CASSÉ =====
    socket.on('command', (data) => {
        console.log(`📱 Commande reçue: ${data.cmd}`);
        
        // Transmettre au téléphone cassé
        if (phones.broken) {
            io.to(phones.broken.id).emit('execute-command', {
                cmd: data.cmd,
                timestamp: Date.now()
            });
            
            socket.emit('command-sent', {
                success: true,
                cmd: data.cmd
            });
        } else {
            socket.emit('command-sent', {
                success: false,
                error: 'Téléphone cassé non connecté'
            });
        }
    });
    
    // ===== RÉPONSE DU TÉLÉPHONE CASSÉ =====
    socket.on('command-result', (data) => {
        if (phones.controller) {
            io.to(phones.controller.id).emit('command-response', {
                cmd: data.cmd,
                result: data.result,
                timestamp: Date.now()
            });
        }
    });
    
    // ===== CAPTURE D'ÉCRAN =====
    socket.on('screenshot', (data) => {
        console.log('📸 Capture d\'écran reçue');
        if (phones.controller) {
            io.to(phones.controller.id).emit('screenshot-data', {
                image: data.image,
                timestamp: Date.now()
            });
        }
    });
    
    // ===== STATUT BATTERIE =====
    socket.on('battery-status', (data) => {
        if (phones.controller) {
            io.to(phones.controller.id).emit('battery-update', {
                level: data.level,
                charging: data.charging,
                timestamp: Date.now()
            });
        }
    });
    
    // ===== DÉCONNEXION =====
    socket.on('disconnect', () => {
        console.log(`❌ Déconnecté: ${socket.id}`);
        
        if (phones.broken && phones.broken.id === socket.id) {
            phones.broken = null;
            io.emit('broken-phone-status', { 
                connected: false,
                timestamp: Date.now()
            });
            console.log('📱 Téléphone cassé déconnecté');
        }
        
        if (phones.controller && phones.controller.id === socket.id) {
            phones.controller = null;
            console.log('🎮 Contrôleur déconnecté');
        }
    });
});

// ========== API POUR VÉRIFIER LE STATUT ==========
app.get('/api/status', (req, res) => {
    res.json({
        broken: phones.broken ? {
            connected: true,
            ip: phones.broken.ip,
            device: phones.broken.device,
            lastSeen: phones.broken.lastSeen
        } : { connected: false },
        controller: phones.controller ? {
            connected: true,
            device: phones.controller.device
        } : { connected: false },
        timestamp: Date.now()
    });
});

// ========== PAGE PRINCIPALE ==========
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== DÉMARRAGE ==========
server.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(70));
    console.log('📱📱📱 CONTRÔLE DIRECT - AUTO IP 📱📱📱');
    console.log('='.repeat(70));
    console.log(`\n🌍 URL: https://controle-direct.onrender.com`);
    console.log(`\n🎯 MODE D'EMPLOI:`);
    console.log(`   1️⃣ Ouvre cette URL sur le TÉLÉPHONE CASSÉ`);
    console.log(`   2️⃣ Clique "JE SUIS LE TÉLÉPHONE CASSÉ"`);
    console.log(`   3️⃣ Ouvre la MÊME URL sur le TÉLÉPHONE SAIN`);
    console.log(`   4️⃣ Clique "JE SUIS LE CONTRÔLEUR"`);
    console.log(`   5️⃣ 🎉 CONNEXION AUTOMATIQUE !`);
    console.log('\n' + '='.repeat(70) + '\n');
});