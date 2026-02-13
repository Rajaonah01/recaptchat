require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(cors({
    origin: process.env.NODE_ENV === 'production' 
        ? ['https://ton-domaine.com'] 
        : ['http://localhost:3000', 'http://127.0.0.1:3000'],
    credentials: true
}));

// ========== RATE LIMITING ==========
const limiter = rateLimit({
    windowMs: (process.env.RATE_LIMIT_WINDOW || 15) * 60 * 1000,
    max: process.env.RATE_LIMIT_MAX || 100,
    message: '⚠️ Trop de requêtes, veuillez réessayer plus tard.',
    standardHeaders: true,
    legacyHeaders: false,
});

app.use('/api/', limiter);

// ========== MIDDLEWARE ==========
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ========== CONFIGURATION IPINFO ==========
const IPINFO_TOKEN = process.env.IPINFO_TOKEN || '1bf43b15c3f17f';
const IPINFO_API = 'https://ipinfo.io';

// Cache en mémoire (pour éviter de surcharger l'API)
const cache = new Map();
const CACHE_DURATION = 3600000; // 1 heure

// ========== FONCTIONS UTILITAIRES ==========

/**
 * Valide une adresse IP (IPv4 et IPv6)
 */
function isValidIP(ip) {
    const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
    const ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
    return ipv4Regex.test(ip) || ipv6Regex.test(ip);
}

/**
 * Nettoie l'adresse IP (enlève le port, IPv6 mapped, etc.)
 */
function cleanIP(ip) {
    if (!ip) return null;
    
    // Enlever le port si présent
    ip = ip.split(':')[0];
    
    // Enlever le préfixe IPv6 mapped
    if (ip.startsWith('::ffff:')) {
        ip = ip.substring(7);
    }
    
    return ip;
}

/**
 * Récupère l'IP réelle du client
 */
function getClientIP(req) {
    // Priorité : Cloudflare, Proxy, X-Forwarded-For, Remote Address
    const cfIP = req.headers['cf-connecting-ip'];
    if (cfIP && isValidIP(cleanIP(cfIP))) return cleanIP(cfIP);
    
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
        const ips = xff.split(',').map(ip => cleanIP(ip.trim()));
        for (let ip of ips) {
            if (ip && isValidIP(ip)) return ip;
        }
    }
    
    const remoteIP = req.socket.remoteAddress;
    if (remoteIP) {
        const clean = cleanIP(remoteIP);
        if (clean && isValidIP(clean)) return clean;
    }
    
    return null;
}

/**
 * Récupère les informations de géolocalisation depuis IPinfo
 */
async function getIPInfo(ip = null) {
    try {
        // Vérifier le cache
        const cacheKey = ip || 'self';
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
            timeout: 5000,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'IP-Localisateur/1.0'
            }
        });

        if (!response.data) {
            throw new Error('Réponse vide de l\'API');
        }

        // Structurer les données
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
        
        throw new Error(`Erreur de géolocalisation: ${error.message}`);
    }
}

// ========== ROUTES API ==========

/**
 * GET /api/status
 * Vérification du statut du serveur
 */
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        timestamp: Date.now(),
        uptime: process.uptime(),
        env: process.env.NODE_ENV || 'development',
        cache: {
            size: cache.size,
            maxAge: `${CACHE_DURATION / 3600000}h`
        }
    });
});

/**
 * GET /api/myip
 * Récupère l'IP du client
 */
app.get('/api/myip', (req, res) => {
    const clientIP = getClientIP(req);
    res.json({
        ip: clientIP || req.socket.remoteAddress,
        clean: clientIP,
        headers: {
            'cf-connecting-ip': req.headers['cf-connecting-ip'] || null,
            'x-forwarded-for': req.headers['x-forwarded-for'] || null
        }
    });
});

/**
 * GET /api/locate
 * Localise l'IP fournie ou celle du client
 */
app.get('/api/locate', async (req, res) => {
    try {
        let ip = req.query.ip;
        
        // Si aucune IP fournie, prendre celle du client
        if (!ip) {
            ip = getClientIP(req);
        }

        // Valider l'IP si fournie
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

/**
 * POST /api/locate/batch
 * Localisation multiple d'IPs
 */
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

/**
 * GET /api/stats
 * Statistiques du serveur
 */
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
    console.log('\n' + '='.repeat(60));
    console.log('📍 SERVEUR DE LOCALISATION IP');
    console.log('='.repeat(60));
    console.log(`\n📡 URL: http://localhost:${PORT}`);
    console.log(`🔑 Token IPinfo: ${IPINFO_TOKEN.slice(0,8)}...`);
    console.log(`💾 Cache: ${CACHE_DURATION / 3600000}h`);
    console.log(`🛡️ Rate Limit: ${process.env.RATE_LIMIT_MAX || 100}/${process.env.RATE_LIMIT_WINDOW || 15}min`);
    console.log(`\n📋 Endpoints API:`);
    console.log(`   GET  /api/status   - Statut du serveur`);
    console.log(`   GET  /api/myip      - Votre adresse IP`);
    console.log(`   GET  /api/locate    - Localiser une IP`);
    console.log(`   POST /api/locate/batch - Localiser plusieurs IPs`);
    console.log(`   GET  /api/stats     - Statistiques serveur`);
    console.log('\n' + '='.repeat(60) + '\n');
});