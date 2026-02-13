require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CONFIGURATION PROXY (INDISPENSABLE POUR RENDER) ==========
// ✅ Cette ligne résout l'erreur ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
// Elle indique à Express de faire confiance au premier proxy (Render)
app.set('trust proxy', 1);

// ========== SÉCURITÉ ==========
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://unpkg.com"],
            imgSrc: ["'self'", "data:", "https://*.tile.openstreetmap.org", "https://*.basemaps.cartocdn.com"],
            connectSrc: ["'self'", "https://ipinfo.io"],
            fontSrc: ["'self'", "data:"],
        },
    },
}));

// Configuration CORS plus flexible pour Render
app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? [/\.onrender\.com$/, 'https://ton-app.render.com'] // Accepte tous les sous-domaines onrender.com
        : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
}));

// ========== RATE LIMITING - AVEC GESTION DES ERREURS ==========
const limiter = rateLimit({
    windowMs: (parseInt(process.env.RATE_LIMIT_WINDOW) || 15) * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
    message: { 
        success: false, 
        error: '⚠️ Trop de requêtes, veuillez réessayer plus tard.' 
    },
    standardHeaders: true,
    legacyHeaders: false,
    // ✅ Désactiver les validations qui causent des erreurs sur Render
    validate: {
        xForwardedForHeader: false,  // Désactive la validation de l'en-tête X-Forwarded-For
        trustProxy: false,           // Désactive la validation du trust proxy
        ip: false,                   // Désactive la validation IP
        default: true                 // Garde les autres validations actives
    }
});

app.use('/api/', limiter);

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== CONFIGURATION IPINFO ==========
const IPINFO_TOKEN = process.env.IPINFO_TOKEN || '1bf43b15c3f17f';
const IPINFO_API = 'https://ipinfo.io';
const CACHE_DURATION = parseInt(process.env.CACHE_DURATION) || 3600000; // 1 heure

// Cache en mémoire
const cache = new Map();

// Nettoyage périodique du cache (toutes les heures)
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of cache.entries()) {
        if (now - value.timestamp > CACHE_DURATION) {
            cache.delete(key);
        }
    }
    console.log(`🧹 Cache nettoyé: ${cache.size} entrées restantes`);
}, CACHE_DURATION);

// ========== FONCTIONS UTILITAIRES ==========

function isValidIP(ip) {
    if (!ip) return false;
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
    return ipv4Regex.test(ip) || ipv6Regex.test(ip);
}

function cleanIP(ip) {
    if (!ip) return null;
    // Enlever le port si présent
    ip = ip.split(':')[0];
    // Nettoyer IPv6 mappé
    if (ip.startsWith('::ffff:')) {
        ip = ip.substring(7);
    }
    return ip;
}

function getClientIP(req) {
    // Priorité 1: Cloudflare
    const cfIP = req.headers['cf-connecting-ip'];
    if (cfIP && isValidIP(cleanIP(cfIP))) return cleanIP(cfIP);
    
    // Priorité 2: X-Forwarded-For (grâce à trust proxy)
    // Express va automatiquement utiliser req.ip grâce à trust proxy
    if (req.ip && isValidIP(cleanIP(req.ip))) {
        return cleanIP(req.ip);
    }
    
    // Priorité 3: Traitement manuel du header X-Forwarded-For
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
        const ips = xff.split(',').map(ip => cleanIP(ip.trim()));
        for (let ip of ips) {
            if (ip && isValidIP(ip)) return ip;
        }
    }
    
    // Priorité 4: Remote address
    const remoteIP = req.socket.remoteAddress;
    if (remoteIP) {
        const clean = cleanIP(remoteIP);
        if (clean && isValidIP(clean)) return clean;
    }
    
    return null;
}

async function getIPInfo(ip = null) {
    try {
        const cacheKey = ip || 'self';
        
        // Vérifier le cache
        if (cache.has(cacheKey)) {
            const cached = cache.get(cacheKey);
            if (Date.now() - cached.timestamp < CACHE_DURATION) {
                console.log(`🎯 Cache hit pour ${cacheKey}`);
                return cached.data;
            }
            cache.delete(cacheKey);
        }

        let url = `${IPINFO_API}/json?token=${IPINFO_TOKEN}`;
        if (ip && isValidIP(ip)) {
            url = `${IPINFO_API}/${ip}/json?token=${IPINFO_TOKEN}`;
        }

        console.log(`🌍 Requête IPinfo pour: ${ip || 'self'}`);
        
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'IP-Localisateur/1.0'
            }
        });

        if (!response.data) {
            throw new Error('Réponse vide de l\'API');
        }

        const data = {
            ip: response.data.ip || ip || 'Inconnu',
            hostname: response.data.hostname || null,
            city: response.data.city || 'Inconnue',
            region: response.data.region || 'Inconnue',
            country: response.data.country || 'Inconnu',
            country_code: response.data.country || null,
            loc: response.data.loc || null,
            postal: response.data.postal || null,
            timezone: response.data.timezone || null,
            asn: response.data.asn ? response.data.asn.replace('AS', '') : null,
            as_name: response.data.as_name || response.data.org || null,
            as_domain: response.data.as_domain || null,
            org: response.data.org || null,
            type: response.data.ip && !response.data.ip.includes(':') ? 'IPv4' : 'IPv6'
        };

        // Sauvegarder dans le cache
        cache.set(cacheKey, {
            data,
            timestamp: Date.now()
        });

        return data;

    } catch (error) {
        console.error('❌ Erreur IPinfo:', error.message);
        
        if (error.code === 'ECONNABORTED') {
            throw new Error('Timeout de l\'API de géolocalisation');
        }
        if (error.response?.status === 404) {
            throw new Error('Adresse IP invalide ou introuvable');
        }
        if (error.response?.status === 429) {
            throw new Error('Trop de requêtes, veuillez réessayer plus tard');
        }
        if (error.response?.status === 403) {
            console.error('🔑 Token IPinfo invalide ou expiré');
            throw new Error('Token API invalide. Vérifie ton token IPinfo');
        }
        
        throw new Error(`Erreur de géolocalisation: ${error.message}`);
    }
}

// ========== ROUTES API ==========

app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        timestamp: Date.now(),
        uptime: process.uptime(),
        env: process.env.NODE_ENV || 'development',
        trustProxy: app.get('trust proxy'), // Affiche la configuration proxy
        cache: {
            size: cache.size,
            maxAge: `${CACHE_DURATION / 3600000}h`
        }
    });
});

app.get('/api/myip', (req, res) => {
    const clientIP = getClientIP(req);
    res.json({
        success: true,
        ip: clientIP || req.socket.remoteAddress,
        raw: {
            'req.ip': req.ip,
            'x-forwarded-for': req.headers['x-forwarded-for'] || null,
            'remoteAddress': req.socket.remoteAddress
        }
    });
});

app.get('/api/locate', async (req, res) => {
    try {
        let ip = req.query.ip;
        
        if (!ip) {
            ip = getClientIP(req);
        }

        if (ip && !isValidIP(ip)) {
            return res.status(400).json({
                success: false,
                error: 'Adresse IP invalide',
                message: 'Format d\'IP incorrect (IPv4 ou IPv6 requis)'
            });
        }

        const data = await getIPInfo(ip);
        
        res.json({
            success: true,
            source: ip ? 'query' : 'client',
            cached: cache.has(ip || 'self'),
            data
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            message: 'Impossible de localiser cette adresse IP'
        });
    }
});

app.post('/api/locate/batch', async (req, res) => {
    const { ips } = req.body;
    
    if (!Array.isArray(ips) || ips.length === 0) {
        return res.status(400).json({
            success: false,
            error: 'Liste d\'IPs invalide'
        });
    }

    if (ips.length > 10) {
        return res.status(400).json({
            success: false,
            error: 'Maximum 10 IPs par requête'
        });
    }

    const results = [];
    for (const ip of ips) {
        try {
            if (isValidIP(ip)) {
                const data = await getIPInfo(ip);
                results.push({ ip, success: true, data });
            } else {
                results.push({ ip, success: false, error: 'IP invalide' });
            }
        } catch (error) {
            results.push({ ip, success: false, error: error.message });
        }
        
        // Petit délai pour éviter de surcharger l'API
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    res.json({
        success: true,
        count: results.length,
        results
    });
});

app.get('/api/stats', (req, res) => {
    const memoryUsage = process.memoryUsage();
    res.json({
        uptime: process.uptime(),
        memory: {
            rss: `${Math.round(memoryUsage.rss / 1024 / 1024)} MB`,
            heapTotal: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)} MB`,
            heapUsed: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)} MB`
        },
        cache: {
            size: cache.size,
            keys: Array.from(cache.keys()).slice(0, 10)
        },
        env: process.env.NODE_ENV
    });
});

// ========== ROUTE PRINCIPALE ==========
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== GESTION DES ERREURS 404 ==========
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route non trouvée',
        message: 'Cette API endpoint n\'existe pas'
    });
});

// ========== GESTION DES ERREURS GLOBALES ==========
app.use((err, req, res, next) => {
    console.error('❌ Erreur serveur:', err);
    res.status(500).json({
        success: false,
        error: 'Erreur interne du serveur',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
});

// ========== DÉMARRAGE DU SERVEUR ==========
app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(70));
    console.log('📍 SERVEUR DE LOCALISATION IP - CORRIGÉ POUR RENDER');
    console.log('='.repeat(70));
    console.log(`\n📡 URL: http://localhost:${PORT}`);
    console.log(`🔑 Token IPinfo: ${IPINFO_TOKEN.slice(0,8)}...`);
    console.log(`🛡️ Rate Limit: ${process.env.RATE_LIMIT_MAX || 100}/${process.env.RATE_LIMIT_WINDOW || 15}min`);
    console.log(`🌍 Environnement: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✅ Trust Proxy: ${app.get('trust proxy')}`);
    console.log('\n' + '='.repeat(70) + '\n');
});